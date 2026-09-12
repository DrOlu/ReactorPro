import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const ledgerModule = loader.loadModule("src/lib/chat/compaction/tokenLedger.ts");
const { BINARY_BLOCK_TOKENS } = loader.loadModule("@liveagent/ui/lib/chat/contextUsage.ts");
const { sanitizeMessageForModelContext } = loader.loadModule(
  "src/lib/chat/context/requestContextSanitizer.ts",
);

const {
  TokenLedger,
  estimateTextTokens,
  estimateTextTokenUnits,
  estimateMessageTokens,
  getMessageObservedTokens,
} = ledgerModule;

function usage(totalTokens, extra = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...extra,
  };
}

function user(content) {
  return { role: "user", content, timestamp: 1 };
}

function assistant(text, messageUsage, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 2,
    usage: messageUsage,
    ...extra,
  };
}

function toolResult(text) {
  return {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "Read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  };
}

test("estimateTextTokens is ceil(chars/4) of trimmed text for non-CJK content", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("   "), 0);
  assert.equal(estimateTextTokens("a".repeat(400)), 100);
  assert.equal(estimateTextTokens("a".repeat(401)), 101);
});

test("estimateTextTokens weighs CJK characters at 0.7 tokens each", () => {
  // 100 CJK characters would count as only 25 tokens by chars/4 while a real tokenizer gives ~60-70: must be significantly higher than 25.
  assert.equal(estimateTextTokens("あ".repeat(100)), Math.ceil(100 * 0.7));
  // Kana and hangul are likewise estimated at CJK density.
  assert.equal(estimateTextTokens("あ".repeat(50)), Math.ceil(50 * 0.7));
  assert.equal(estimateTextTokens("한".repeat(50)), Math.ceil(50 * 0.7));
  // Mixed CJK and English: each accumulates at its own density.
  assert.equal(
    estimateTextTokens(`${"あ".repeat(40)}${"a".repeat(40)}`),
    Math.ceil(40 * 0.7 + 40 / 4),
  );
  // Fullwidth punctuation counts at CJK density.
  assert.equal(estimateTextTokens("。".repeat(10)), Math.ceil(10 * 0.7));
});

test("estimateTextTokenUnits is additive across arbitrary splits", () => {
  const text = `CJK mixed ascii ${"あい".repeat(20)} tail`;
  const whole = estimateTextTokenUnits(text);
  const split =
    estimateTextTokenUnits(text.slice(0, 7)) +
    estimateTextTokenUnits(text.slice(7, 23)) +
    estimateTextTokenUnits(text.slice(23));
  assert.ok(Math.abs(whole - split) < 1e-9, `whole=${whole} split=${split}`);
});

test("estimateMessageTokens covers text, tool calls and model-visible tool result content", () => {
  assert.equal(estimateMessageTokens(user("a".repeat(400))), 100 + 8);

  const withToolCall = {
    role: "assistant",
    content: [
      { type: "text", text: "a".repeat(40) },
      { type: "toolCall", id: "t1", name: "Read", arguments: { path: "b".repeat(30) } },
    ],
    stopReason: "toolUse",
    timestamp: 2,
  };
  const argsChars = JSON.stringify({ path: "b".repeat(30) }).length;
  assert.equal(
    estimateMessageTokens(withToolCall),
    Math.ceil((40 + "Read".length + argsChars) / 4) + 8,
  );

  // details is a UI/accounting payload (full shell output and file metadata hang off it), while the
  // provider conversion sends only content---counting it would double-count and systematically inflate the ledger readings.
  const resultWithDetails = { ...toolResult("c".repeat(80)), details: { lines: 12 } };
  assert.equal(estimateMessageTokens(resultWithDetails), Math.ceil(80 / 4) + 8);
});

test("estimateMessageTokens prices binary blocks at provider scale, not base64 length", () => {
  // A 400KB image's base64 would over-report ~130k tokens by character count, making the ring swing
  // wildly as the anchor alternates between estimate and real usage; with the pricing-scale constant
  // the reading is on the same order as the real cost.
  const imageResult = {
    role: "toolResult",
    toolCallId: "tc-img",
    toolName: "Read",
    content: [
      { type: "text", text: "a".repeat(40) },
      { type: "image", data: "A".repeat(1_000_000), mimeType: "image/png" },
    ],
    isError: false,
    timestamp: 3,
  };
  assert.equal(estimateMessageTokens(imageResult), Math.ceil(40 / 4) + BINARY_BLOCK_TOKENS + 8);

  const imageUser = {
    role: "user",
    content: [
      { type: "text", text: "Look at this image" },
      { type: "image", data: "B".repeat(500_000), mimeType: "image/jpeg" },
    ],
    timestamp: 1,
  };
  assert.equal(
    estimateMessageTokens(imageUser),
    Math.ceil(estimateTextTokenUnits("Look at this image") + BINARY_BLOCK_TOKENS) + 8,
  );
});

test("estimateMessageTokens memoizes by object identity", () => {
  const message = user("a".repeat(4000));
  const first = estimateMessageTokens(message);
  message.content = "";
  // The same object hits the cache (messages are used as immutable value objects); in-place mutation of content does not trigger recomputation.
  assert.equal(estimateMessageTokens(message), first);
});

test("usage anchors are pure arithmetic: prompt side plus visible output", () => {
  // totalTokens includes all of this turn's output (reasoning accounts for most of it). Chat Completions
  // and others strip reasoning after the turn ends: the anchor does only usage arithmetic (prompt side +
  // output - reasoning). OpenAI Responses replays thinkingSignature and keeps reasoning separately.
  const heavyReasoning = assistant(
    "hi",
    usage(47_500, { input: 4_000, cacheRead: 500, output: 43_000, reasoning: 40_000 }),
  );
  // stop termination: 4_500 (prompt side) + 43_000 - 40_000 (stripped reasoning) = 7_500.
  assert.equal(getMessageObservedTokens(heavyReasoning), 7_500);

  // toolUse continuation: this turn's reasoning still stays in subsequent requests of the same turn (all
  // providers require it to be sent back and billed), so output is fully counted; the thinking text is
  // never added again as an estimate (the old double count).
  const toolLoop = assistant(
    "hi",
    usage(47_500, { input: 4_000, cacheRead: 500, output: 43_000, reasoning: 40_000 }),
    { stopReason: "toolUse" },
  );
  assert.equal(getMessageObservedTokens(toolLoop), 47_500);

  // A relay reports only totalTokens (prompt side all zero): a documented degradation, but the reading must not go to zero.
  assert.equal(getMessageObservedTokens(assistant("hi", usage(1_234))), 1_234);
});

test("reasoning-less providers deduct estimated thinking text from stop anchors", () => {
  // For providers that do not report a reasoning breakdown: the full thinking text sits in the message
  // content, the server strips the chain of thought after the turn ends, and the anchor deducts a
  // text-based estimate---the only remaining error is this one estimate.
  const thinkingText = "a".repeat(1_000); // 250 token units
  const message = assistant("Answer", usage(0, { input: 2_000, output: 400 }));
  message.content.unshift({ type: "thinking", thinking: thinkingText });
  assert.equal(getMessageObservedTokens(message), 2_000 + (400 - 250));

  // The deduction floor is 0: a conservative estimate must not make visible output negative.
  const overEstimated = assistant("Short", usage(0, { input: 1_000, output: 100 }));
  overEstimated.content.unshift({ type: "thinking", thinking: "b".repeat(1_000) });
  assert.equal(getMessageObservedTokens(overEstimated), 1_000);

  // A toolUse continuation replays thinking: no deduction.
  const inLoop = assistant("Run tool", usage(0, { input: 2_000, output: 400 }), {
    stopReason: "toolUse",
  });
  inLoop.content.unshift({ type: "thinking", thinking: thinkingText });
  assert.equal(getMessageObservedTokens(inLoop), 2_400);
});

test("ledger anchors on usage arithmetic and never mutates messages", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "s".repeat(400), messages: [user("question")] });
  const observed = assistant(
    "answer",
    usage(9_000, { input: 5_000, cacheRead: 1_000, output: 3_000, reasoning: 2_800 }),
  );
  ledger.addMessages([observed]);

  // 6_000 (prompt side) + 3_000 - 2_800 = 6_200; the anchor is computed on read and writes no stamp.
  assert.equal(ledger.total(), 6_200);
  assert.equal(observed.liveAgentContextUsage, undefined);
});

test("two-turn readings never fall back without compaction (regression: high first turn, dip on second)", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "sys", messages: [user("First question")] });

  // Turn 1: heavy reasoning (4.5k reasoning). Anchor = prompt side + visible output, excluding reasoning.
  const turn1 = assistant(
    "Answer one",
    usage(15_500, { input: 10_000, output: 5_000, reasoning: 4_500 }),
  );
  ledger.addMessages([turn1]);
  const afterTurn1 = ledger.total();
  assert.equal(afterTurn1, 10_500);

  // The user's second question enters the trailing estimate; idle readings only grow.
  const question2 = user("Second question: please continue");
  ledger.addMessages([question2]);
  const idleBeforeTurn2 = ledger.total();
  assert.ok(idleBeforeTurn2 >= afterTurn1);

  // Turn 2: the provider's measured prompt side = the previous turn's visible context + the actual tokens
  // of the user message. The old convention (anchor including reasoning/text estimates) would necessarily
  // fall back here; the new convention is monotonically non-decreasing.
  const turn2 = assistant("Answer two", usage(0, { input: 10_512, output: 300, reasoning: 250 }));
  ledger.addMessages([turn2]);
  const afterTurn2 = ledger.total();
  assert.equal(afterTurn2, 10_562);
  assert.ok(
    afterTurn2 >= afterTurn1,
    `Without compaction the reading must not fall back: ${afterTurn1} -> ${afterTurn2}`,
  );
});

test("hosted-search turns are never usage anchors and their blocks are never estimated", () => {
  // Measured data (a session where the usage ring fell 44%->16%): the search turn's usage reports
  // input 110k (an aggregate of multiple server-side internal calls; the full search results are counted
  // into input but never enter subsequent requests), while the next turn measures the entire persistent
  // context at only 52k. An aggregate must never anchor the ring reading.
  const searchTurn = assistant(
    "Search results summary...",
    usage(117_996, { input: 110_008, cacheRead: 5_184, output: 2_804, reasoning: 1_941 }),
  );
  searchTurn.content.push({
    type: "hostedSearch",
    id: "hs-1",
    provider: "openai",
    status: "completed",
    queries: ["Xi'an today's news"],
    sources: [{ url: "https://example.com/a", title: "x".repeat(2_000) }],
  });
  assert.equal(getMessageObservedTokens(searchTurn), undefined);

  // Stamps written by older versions from aggregate values are dead data: no consumer on the read side reads stamps.
  const legacyStamped = assistant("Old stamp", usage(117_996, { input: 110_008 }));
  legacyStamped.content.push({ type: "hostedSearch", id: "hs-2", sources: [] });
  legacyStamped.liveAgentContextUsage = { totalTokens: 117_996, fixedTokens: 100 };
  assert.equal(getMessageObservedTokens(legacyStamped), undefined);

  // hostedSearch blocks are stripped on the request side: estimation skips their queries/sources JSON.
  const plainEquivalent = assistant("Search results summary...", usage(0));
  assert.equal(estimateMessageTokens(searchTurn), estimateMessageTokens(plainEquivalent));

  // The next ordinary turn's real usage anchors normally: 52_719 (prompt side) + 9 (visible output).
  const nextTurn = assistant("Okay", usage(52_728, { input: 2_991, cacheRead: 49_728, output: 9 }));
  assert.equal(getMessageObservedTokens(nextTurn), 52_728);
});

test("OpenAI Responses stop anchors keep reasoning that will be replayed", () => {
  const signature = JSON.stringify({
    id: "rs_1",
    type: "reasoning",
    encrypted_content: "A".repeat(1_600),
  });
  const message = assistant(
    "Answer",
    usage(0, { input: 18_000, output: 2_366, reasoning: 1_543 }),
    { api: "openai-responses" },
  );
  message.content.unshift({
    type: "thinking",
    thinking: "short summary",
    thinkingSignature: signature,
  });
  // The old convention deducted 1_543 -> 18_823; Responses still sends the reasoning item in the next request.
  assert.equal(getMessageObservedTokens(message), 20_366);
});

test("hosted-search estimate includes Responses signatures so a thank-you does not jump 19k->30k", () => {
  const encLens = [1_612, 1_484, 1_356, 1_444, 1_912, 1_420, 1_444, 4_620, 1_848];
  const signatures = encLens.map((encLen) => ({
    type: "thinking",
    thinking: "plan",
    thinkingSignature: JSON.stringify({
      id: "rs",
      type: "reasoning",
      encrypted_content: "A".repeat(encLen),
    }),
  }));
  const searchTurn = assistant(
    "Here are the key points of today's Xi'an news...",
    usage(86_331, { input: 80_509, cacheRead: 3_456, output: 2_366, reasoning: 1_543 }),
    { api: "openai-responses" },
  );
  searchTurn.content = [
    ...signatures,
    {
      type: "hostedSearch",
      id: "hs-1",
      provider: "openai",
      status: "completed",
      queries: ["Xi'an news"],
      sources: [],
    },
    { type: "text", text: "Here are the key points of today's Xi'an news..." },
  ];
  assert.equal(getMessageObservedTokens(searchTurn), undefined);

  const context = {
    systemPrompt: "s".repeat(4_000),
    tools: [{ name: "Read", description: "d".repeat(200), parameters: { type: "object" } }],
    messages: [user("Please search the web for today's Xi'an news"), searchTurn],
  };
  const ledger = new TokenLedger();
  ledger.rebase(context);
  const withReplay = ledger.total();

  const plainSearch = assistant("Here are the key points of today's Xi'an news...", usage(0));
  plainSearch.content.push({
    type: "hostedSearch",
    id: "hs-plain",
    sources: [],
  });
  const oldLedger = new TokenLedger();
  oldLedger.rebase({
    ...context,
    messages: [user("Please search the web for today's Xi'an news"), plainSearch],
  });
  const withoutReplay = oldLedger.total();
  assert.ok(
    withReplay > withoutReplay + 3_000,
    `signatures must lift hosted-search estimate: ${withReplay} vs ${withoutReplay}`,
  );

  ledger.addMessages([user("Thank you")]);
  const idle = ledger.total();
  ledger.addMessages([
    assistant("You're welcome", usage(32_286, { input: 3_149, cacheRead: 29_056, output: 81 })),
  ]);
  const afterThanks = ledger.total();
  assert.equal(afterThanks, 32_286);
  assert.ok(
    afterThanks - idle < afterThanks - (withoutReplay + estimateMessageTokens(user("Thank you"))),
    `idle→real jump must shrink: idle=${idle} old=${withoutReplay} real=${afterThanks}`,
  );
});

test("sanitized hosted-search turns cannot re-anchor rebase on aggregated usage", () => {
  // Regression: after the search turn ends the idle ring uses estimates (~7%), and the next turn's
  // beginRequest rebases on the sanitized context. If sanitizing strips the hostedSearch blocks but
  // leaves the aggregate usage (measured input 101k), the ledger treats it as a real anchor: the ring
  // jumps to ~40% during streaming, then lands on the next turn's real usage (~11%) when the reply completes.
  const searchTurn = assistant(
    "Here are the key points of today's Xi'an news...",
    usage(107_014, { input: 101_156, cacheRead: 3_456, output: 2_402, reasoning: 1_799 }),
  );
  searchTurn.content.push({
    type: "hostedSearch",
    id: "hs-sanitize",
    provider: "openai",
    status: "completed",
    queries: ["Xi'an news"],
    sources: [],
  });
  const originalUsage = { ...searchTurn.usage };
  const sanitized = sanitizeMessageForModelContext(searchTurn);
  const nextUser = { role: "user", content: "Okay", timestamp: 3 };

  assert.equal(
    sanitized.content.some((block) => block.type === "hostedSearch"),
    false,
  );
  assert.equal(getMessageObservedTokens(sanitized), undefined);
  assert.equal(searchTurn.usage.totalTokens, originalUsage.totalTokens);

  const ledger = new TokenLedger();
  ledger.rebase({
    systemPrompt: "s".repeat(400),
    messages: [user("Please search the web for today's Xi'an news"), sanitized, nextUser],
  });
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.hasObservedUsage, false);
  assert.ok(
    snapshot.totalTokens < 10_000,
    `sanitized rebase must stay on estimate path, got ${snapshot.totalTokens}`,
  );

  const realNext = assistant("Got it", usage(30_986, { input: 1_883, cacheRead: 29_056, output: 47 }));
  ledger.addMessages([realNext]);
  assert.equal(ledger.total(), 30_986);
});

test("warm hosted-search turns anchor on cacheRead+output, not aggregated input", () => {
  const searchTurn = assistant(
    "Xi'an today's news at a glance",
    usage(86_335, { input: 53_290, cacheRead: 30_080, output: 2_965, reasoning: 2_057 }),
    { api: "openai-responses" },
  );
  searchTurn.content.push({
    type: "hostedSearch",
    id: "hs-warm",
    provider: "openai",
    status: "completed",
    queries: ["Xi'an news"],
    sources: [],
  });
  assert.equal(getMessageObservedTokens(searchTurn), 33_045);
  assert.notEqual(getMessageObservedTokens(searchTurn), 86_335);

  const sanitized = sanitizeMessageForModelContext(searchTurn);
  assert.equal(
    sanitized.content.some((block) => block.type === "hostedSearch"),
    false,
  );
  assert.equal(sanitized.usage.input, 0);
  assert.equal(sanitized.usage.totalTokens, 0);
  assert.equal(sanitized.usage.cacheRead, 30_080);
  assert.equal(sanitized.usage.output, 2_965);
  assert.equal(getMessageObservedTokens(sanitized), 33_045);

  const nextUser = { role: "user", content: "Okay", timestamp: 3 };
  const ledger = new TokenLedger();
  ledger.rebase({
    systemPrompt: "s".repeat(400),
    messages: [user("Please search the web for today's Xi'an news"), sanitized, nextUser],
  });
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.hasObservedUsage, true);
  assert.equal(snapshot.observedTokens, 33_045);
  assert.equal(snapshot.totalTokens, 33_045 + estimateMessageTokens(nextUser));

  const realNext = assistant("You're welcome", usage(32_703, { input: 3_588, cacheRead: 29_056, output: 59 }));
  ledger.addMessages([realNext]);
  assert.equal(ledger.total(), 32_703);
  assert.ok(
    Math.abs(32_703 - snapshot.totalTokens) < 500,
    `beginRequest→real jump must stay in hundreds: rebase=${snapshot.totalTokens} real=32703`,
  );
});

test("suppressUsageAnchors still accepts warm hosted-search follow-up tokens", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "s".repeat(400), messages: [user("question")] });
  const warm = assistant(
    "Search summary",
    usage(86_335, { input: 53_290, cacheRead: 30_080, output: 2_965 }),
  );
  ledger.addMessages([warm], { suppressUsageAnchors: true });
  assert.equal(ledger.snapshot().hasObservedUsage, true);
  assert.equal(ledger.total(), 33_045);
});

test("addMessages with suppressUsageAnchors keeps usage turns on the estimate path", () => {
  // The search wrap-up asynchronously replaces the assistant message object, so content blocks may not be
  // attached at submit time; the caller tracks by turn and explicitly suppresses: no anchoring, only
  // accumulate the trailing estimate.
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "s".repeat(400), messages: [user("question")] });
  const totalBefore = ledger.total();
  const aggregated = assistant("Search summary", usage(117_996, { input: 110_008, cacheRead: 5_184 }));
  ledger.addMessages([aggregated], { suppressUsageAnchors: true });

  assert.equal(ledger.snapshot().hasObservedUsage, false);
  assert.equal(ledger.total(), totalBefore + estimateMessageTokens(aggregated));
});

test("rebase skips hosted-search anchors and lands on the previous trusted usage", () => {
  const ledger = new TokenLedger();
  const trusted = assistant("earlier answer", usage(30_000, { input: 30_000 }));
  const searchTurn = assistant("Search summary", usage(117_996, { input: 110_008 }), { timestamp: 4 });
  searchTurn.content.push({ type: "hostedSearch", id: "hs-3", sources: [] });
  ledger.rebase({
    systemPrompt: "sys",
    messages: [user("q1"), trusted, user("q2", 3), searchTurn],
  });

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.hasObservedUsage, true);
  // The anchor lands on the earlier trusted turn (30_000 prompt side + 0 visible output), and the search
  // turn and the messages after it are trailing estimates.
  assert.equal(snapshot.observedTokens, 30_000);
  assert.equal(
    snapshot.trailingTokens,
    estimateMessageTokens({ role: "user", content: "q2", timestamp: 3 }) +
      estimateMessageTokens(searchTurn),
  );
});

test("compaction checkpoint messages are never observed-usage anchors", () => {
  const checkpoint = assistant("summary body", usage(99_999), { api: "liveagent-compaction" });
  assert.equal(getMessageObservedTokens(checkpoint), undefined);

  const legacyCheckpoint = assistant("summary body", usage(99_999), {
    provider: "liveagent",
    model: "summary",
  });
  assert.equal(getMessageObservedTokens(legacyCheckpoint), undefined);

  assert.equal(getMessageObservedTokens(assistant("hi", usage(1234))), 1234);
});

test("rebase anchors on the latest real usage and estimates the trailing messages", () => {
  const ledger = new TokenLedger();
  const trailing = toolResult("d".repeat(4000));
  ledger.rebase({
    systemPrompt: "s".repeat(4000),
    messages: [user("hello"), assistant("world", usage(5000)), trailing],
  });

  const expectedTrailing = estimateMessageTokens(trailing);
  assert.equal(ledger.total(), 5000 + expectedTrailing);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.hasObservedUsage, true);
  assert.equal(snapshot.observedTokens, 5000);
  assert.equal(snapshot.trailingTokens, expectedTrailing);
  // Observed usage already includes the system prompt, so fixed is not added again.
  assert.equal(snapshot.totalTokens, snapshot.observedTokens + snapshot.trailingTokens);
});

test("legacy liveAgentContextUsage stamps are dead data: anchors recompute from usage", () => {
  // Stamps persisted before the fix were written under the old convention (text estimates, even
  // aggregates) and the read side once preferred them unconditionally---so old sessions kept sawtoothing.
  // Now anchors are always computed from usage, and stamps have no readers.
  const ledger = new TokenLedger();
  const stamped = assistant("Legacy session turn", usage(0, { input: 5_000, output: 200 }));
  stamped.liveAgentContextUsage = { totalTokens: 117_996, fixedTokens: 100 };
  ledger.rebase({ systemPrompt: "sys", messages: [user("q"), stamped] });

  assert.equal(getMessageObservedTokens(stamped), 5_200);
  assert.equal(ledger.total(), 5_200);
});

test("usage anchors always beat estimates regardless of fixed-cost size", () => {
  const ledger = new TokenLedger();
  const observed = assistant("answer", usage(1_000));
  // The estimation convention deliberately over-estimates (serialized characters / CJK density) and must
  // never override a real reading---otherwise the ring would exceed 100% and trigger an automatic
  // compaction loop. The usage anchor already includes the real system/tools occupancy, so the fixed
  // estimate is not added no matter how large it is.
  ledger.rebase({
    systemPrompt: "s".repeat(400_000),
    tools: [{ name: "LargeTool", description: "d".repeat(400_000), parameters: {} }],
    messages: [observed],
  });

  assert.equal(ledger.total(), 1_000);
  assert.equal(ledger.snapshot().hasObservedUsage, true);
});

test("real usage anchors are never overridden by the full-history estimate", () => {
  const ledger = new TokenLedger();
  // A 1,000,000-character tool output estimates to ~250k tokens while real usage is only 5000: the reading always trusts usage.
  ledger.rebase({
    systemPrompt: "sys",
    messages: [toolResult("x".repeat(1_000_000)), assistant("done", usage(5_000))],
  });

  assert.equal(ledger.total(), 5_000);
});

test("assistant messages without provider usage stay on the estimate path", () => {
  const ledger = new TokenLedger();
  const noUsage = assistant("answer", usage(0));
  ledger.rebase({ systemPrompt: "s".repeat(400), messages: [user("question")] });
  const totalBefore = ledger.total();
  ledger.addMessages([noUsage]);

  // Messages without usage go only through the trailing estimate and never produce an anchor.
  assert.equal(getMessageObservedTokens(noUsage), undefined);
  assert.equal(ledger.total(), totalBefore + estimateMessageTokens(noUsage));
});

test("rebase without any usage falls back to fixed + estimates", () => {
  const ledger = new TokenLedger();
  const message = user("a".repeat(400));
  ledger.rebase({ systemPrompt: "s".repeat(4000), messages: [message] });

  assert.equal(ledger.snapshot().hasObservedUsage, false);
  assert.equal(ledger.total(), 1000 + estimateMessageTokens(message));
});

test("addMessages accumulates estimates and a fresh usage resets the trailing sum", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "", messages: [assistant("w", usage(5000))] });

  const extra = toolResult("e".repeat(800));
  ledger.addMessages([extra]);
  assert.equal(ledger.total(), 5000 + estimateMessageTokens(extra));

  ledger.addMessages([assistant("next", usage(6100))]);
  assert.equal(ledger.total(), 6100);
  assert.equal(ledger.snapshot().trailingTokens, 0);
});

test("post-checkpoint rebase shrinks the total to the fresh segment size", () => {
  const ledger = new TokenLedger();
  ledger.rebase({
    systemPrompt: "base",
    messages: [assistant("big history", usage(150_000)), toolResult("f".repeat(20_000))],
  });
  assert.ok(ledger.total() > 150_000);

  const resume = user("Continue.");
  ledger.rebase({ systemPrompt: `base\n## Previous Conversation Summary\n${"g".repeat(2000)}`, messages: [resume] });
  assert.equal(ledger.snapshot().hasObservedUsage, false);
  assert.ok(ledger.total() < 1000);
});

test("totalWithPendingTokens adds the streamed token-unit estimate in O(1)", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "", messages: [assistant("w", usage(4000))] });
  assert.equal(ledger.totalWithPendingTokens(0), 4000);
  assert.equal(ledger.totalWithPendingTokens(estimateTextTokenUnits("a".repeat(401))), 4000 + 101);
  // CJK streams accumulate at CJK density: 400 characters is far higher than 400/4=100.
  assert.equal(
    ledger.totalWithPendingTokens(estimateTextTokenUnits("あ".repeat(400))),
    4000 + Math.ceil(400 * 0.7),
  );
});

test("estimateMessageTokens weighs CJK message content by CJK density", () => {
  const cjkMessage = user("あいうえおかきくけこさしすせそ".repeat(20));
  const asciiEquivalent = user("a".repeat(15 * 20));
  assert.ok(
    estimateMessageTokens(cjkMessage) > estimateMessageTokens(asciiEquivalent) * 2,
    "CJK content must estimate significantly more tokens than same-length ASCII",
  );
});
