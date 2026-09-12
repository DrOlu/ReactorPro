import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const turnInjection = loader.loadModule("src/lib/memory/prompts/turnInjection.ts");
const {
  MEMORY_TURN_UPDATE_BYTE_BUDGET_MIN,
  attachMemoryTurnUpdates,
  formatMemoryTurnUpdate,
  memoryTurnUpdateByteBudget,
  planMemoryTurnInjection,
} = turnInjection;
const { memoryTurnInjection } = loader.loadModule("src/lib/chat/memory/injectionController.ts");
const { formatMemoryOverview } = loader.loadModule("src/lib/memory/prompts/injection.ts");
const { capturePrefixShape, comparePrefixShape } = loader.loadModule(
  "src/lib/debug/prefixCacheShape.ts",
);
const { buildPreparedContext } = loader.loadModule(
  "src/pages/chat/runtime/conversationContextBuilders.ts",
);
const { normalizeConversationState } = loader.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
);
const { extractLatestUserText } = loader.loadModule("src/lib/memory/extraction/context.ts");

const BASE_SYSTEM_PROMPT = "base system prompt";
const TOOLS = [{ name: "MemoryManager", description: "memory", parameters: { type: "object" } }];

function entry(overrides = {}) {
  return {
    slug: "user-name",
    scope: "global",
    memoryType: "user",
    description: "The user's name is Alex",
    headline: "",
    dateLocal: null,
    // Fixed to "today", so the freshness bucket is always d0 and the overview bytes change only with content.
    updatedAt: Date.now(),
    unreviewed: false,
    confidence: "high",
    ...overrides,
  };
}

function overviewText(entries) {
  return formatMemoryOverview({
    user: entries,
    project: [],
    global: [],
    recentDays: [],
    root: "/tmp/memory",
    workdirHash: null,
  });
}

const OVERVIEW_A = overviewText([entry()]);
const OVERVIEW_B = overviewText([entry(), entry({ slug: "user-editor", description: "The user uses neovim" })]);

function baselineFrom(overview) {
  const plan = planMemoryTurnInjection({ baseline: null, overview });
  return plan.baseline;
}

// ---------------------------------------------------------------------------
// Pure planner: align the three hard constraints one by one

test("the first turn goes through the system prompt and produces no extra update block", () => {
  const plan = planMemoryTurnInjection({ baseline: null, overview: OVERVIEW_A });

  assert.equal(plan.systemText, OVERVIEW_A);
  assert.equal(plan.turnUpdate, "");
  assert.equal(plan.baseline.lastSeenText, OVERVIEW_A);
  assert.equal(plan.baseline.updateBytes, 0);
});

test("no extra messages are produced when the content is unchanged", () => {
  const baseline = baselineFrom(OVERVIEW_A);
  const plan = planMemoryTurnInjection({ baseline, overview: OVERVIEW_A });

  assert.equal(plan.turnUpdate, "");
  assert.equal(plan.systemText, baseline.systemText);
  assert.equal(plan.baseline.lastSeenText, baseline.lastSeenText);
  assert.equal(plan.baseline.updateBytes, 0);
});

test("produces an update when the content changes, without touching a single byte of the system section", () => {
  const baseline = baselineFrom(OVERVIEW_A);
  const plan = planMemoryTurnInjection({ baseline, overview: OVERVIEW_B });

  assert.equal(plan.systemText, baseline.systemText);
  assert.ok(plan.turnUpdate.startsWith("<memory-update>"));
  assert.ok(plan.turnUpdate.includes("[user-editor|u|d0]"));
  assert.ok(plan.turnUpdate.includes("supersedes"));
  assert.equal(plan.baseline.lastSeenText, OVERVIEW_B);
  assert.equal(plan.baseline.updateBytes, plan.turnUpdate.length);
});

test("the update reports only the id of the superseded entry, not restating the old value", () => {
  const removed = formatMemoryTurnUpdate(OVERVIEW_B, OVERVIEW_A);

  assert.ok(removed.includes("- [user-editor]"));
  assert.ok(!removed.includes("The user uses neovim"));
  // Unchanged entries are not relisted, avoiding re-flushing the whole index on every update.
  assert.ok(!removed.includes("[user-name|u|d0]"));
});

test("no hollow update block is attached when only non-entry changes such as a folded hint occur", () => {
  assert.equal(formatMemoryTurnUpdate(OVERVIEW_A, `${OVERVIEW_A}\n\ntrailing note`), "");

  const baseline = baselineFrom(OVERVIEW_A);
  const plan = planMemoryTurnInjection({
    baseline,
    overview: `${OVERVIEW_A}\n\ntrailing note`,
  });

  assert.equal(plan.turnUpdate, "");
  // The fingerprint still advances, otherwise the next turn would recompute the same diff.
  assert.equal(plan.baseline.lastSeenText, `${OVERVIEW_A}\n\ntrailing note`);
  assert.equal(plan.baseline.updateBytes, 0);
});

test("a read failure (overview=null) leaves the baseline untouched and does not advance the fingerprint", () => {
  const baseline = baselineFrom(OVERVIEW_A);
  const plan = planMemoryTurnInjection({ baseline, overview: null });

  assert.equal(plan.systemText, baseline.systemText);
  assert.equal(plan.turnUpdate, "");
  assert.equal(plan.baseline, baseline);
});

test("a read failure on the first turn establishes no baseline, leaving it for the next turn", () => {
  const plan = planMemoryTurnInjection({ baseline: null, overview: null });

  assert.equal(plan.systemText, "");
  assert.equal(plan.turnUpdate, "");
  assert.equal(plan.baseline, null);
});

test("refreezes once cumulative update bytes exceed the budget: the fresh snapshot goes into the system section and the budget resets", () => {
  let baseline = baselineFrom(OVERVIEW_A);
  const budget = memoryTurnUpdateByteBudget(baseline.systemText);
  // A small snapshot hits the floor budget: small updates can accumulate over many turns without rebuilding the prefix every two or three.
  assert.equal(budget, MEMORY_TURN_UPDATE_BYTE_BUDGET_MIN);

  // Apply small updates turn by turn until the budget is exhausted. The cap-turn
  // decision must count this turn's block bytes as well: the turn that triggers the
  // refreeze does not attach a block (turnUpdate is empty), and the change goes
  // straight into the fresh snapshot.
  let rounds = 0;
  let refrozenPlan = null;
  while (refrozenPlan === null && rounds < 500) {
    rounds += 1;
    const plan = planMemoryTurnInjection({
      baseline,
      overview: overviewText([entry({ description: `The user's name is Alex ${rounds}` })]),
    });
    if (plan.refrozen) {
      refrozenPlan = plan;
      break;
    }
    assert.notEqual(plan.turnUpdate, "");
    assert.ok(plan.baseline.updateBytes <= budget);
    baseline = plan.baseline;
  }

  // It really took multiple update rounds to cap, rather than refreezing immediately.
  assert.ok(refrozenPlan, "expected refreeze to trigger within 500 rounds");
  assert.ok(rounds > 2, `expected multiple update rounds before refreeze, got ${rounds}`);
  assert.equal(refrozenPlan.turnUpdate, "");
  // The change is not silently lost: the full fresh snapshot goes into the system section.
  const cappedOverview = overviewText([entry({ description: `The user's name is Alex ${rounds}` })]);
  assert.equal(refrozenPlan.systemText, cappedOverview);
  assert.equal(refrozenPlan.baseline.lastSeenText, cappedOverview);
  assert.equal(refrozenPlan.baseline.updateBytes, 0);

  // After the refreeze the budget is available again: the next change continues incrementally.
  const next = planMemoryTurnInjection({ baseline: refrozenPlan.baseline, overview: OVERVIEW_B });
  assert.equal(next.refrozen, false);
  assert.ok(next.turnUpdate.startsWith("<memory-update>"));
});

test("when a single block is very large and the budget is insufficient, refreeze that turn instead of attaching the block and then hitting the cap", () => {
  // Artificially lower the remaining budget: first accumulate to near the budget line.
  let baseline = baselineFrom(OVERVIEW_A);
  baseline = { ...baseline, updateBytes: memoryTurnUpdateByteBudget(baseline.systemText) - 1 };

  const plan = planMemoryTurnInjection({ baseline, overview: OVERVIEW_B });
  assert.equal(plan.refrozen, true);
  assert.equal(plan.turnUpdate, "");
  assert.equal(plan.systemText, OVERVIEW_B);
});

test("refreezes when changed entries exceed the single-block cap, no longer emitting a truncated block", () => {
  const wide = (suffix) =>
    overviewText(
      Array.from({ length: 13 }, (_, index) =>
        entry({ slug: `user-${index}`, description: `Fact ${index}${suffix}` }),
      ),
    );
  const baseline = baselineFrom(wide(""));
  const plan = planMemoryTurnInjection({ baseline, overview: wide(" changed") });

  assert.equal(plan.refrozen, true);
  assert.equal(plan.turnUpdate, "");
  assert.equal(plan.systemText, wide(" changed"));
  assert.equal(plan.baseline.updateBytes, 0);
});

test("still updates incrementally when changed entries are exactly within the cap, without triggering a refreeze", () => {
  const wide = (suffix) =>
    overviewText(
      Array.from({ length: 12 }, (_, index) =>
        entry({ slug: `user-${index}`, description: `Fact ${index}${suffix}` }),
      ),
    );
  const baseline = baselineFrom(wide(""));
  const plan = planMemoryTurnInjection({ baseline, overview: wide(" changed") });

  assert.equal(plan.refrozen, false);
  assert.ok(plan.turnUpdate.startsWith("<memory-update>"));
  assert.ok(!plan.turnUpdate.includes("omitted"));
  assert.equal(plan.systemText, baseline.systemText);
});

test("a workdir switch triggers a refreeze; a missing workdir on either side does not trigger one out of thin air", () => {
  const first = planMemoryTurnInjection({ baseline: null, overview: OVERVIEW_A, workdir: "/proj/a" });
  assert.equal(first.baseline.workdir, "/proj/a");

  const switched = planMemoryTurnInjection({
    baseline: first.baseline,
    overview: OVERVIEW_B,
    workdir: "/proj/b",
  });
  assert.equal(switched.refrozen, true);
  assert.equal(switched.systemText, OVERVIEW_B);
  assert.equal(switched.baseline.workdir, "/proj/b");

  // The old baseline did not record workdir: it updates incrementally as usual, and does not refreeze just because this turn starts carrying a workdir.
  const legacy = planMemoryTurnInjection({
    baseline: baselineFrom(OVERVIEW_A),
    overview: OVERVIEW_B,
    workdir: "/proj/a",
  });
  assert.equal(legacy.refrozen, false);
  assert.notEqual(legacy.turnUpdate, "");
});

test("first memory after an empty-index freeze: the whole snapshot refreezes into the system section", () => {
  const empty = planMemoryTurnInjection({ baseline: null, overview: "" });
  assert.equal(empty.baseline.systemText, "");

  const appeared = planMemoryTurnInjection({ baseline: empty.baseline, overview: OVERVIEW_A });
  assert.equal(appeared.refrozen, true);
  assert.equal(appeared.systemText, OVERVIEW_A);
  assert.equal(appeared.turnUpdate, "");
  // The reverse (non-empty → empty) can just update normally; the index rule text is already in the system section.
  const cleared = planMemoryTurnInjection({ baseline: appeared.baseline, overview: "" });
  assert.equal(cleared.refrozen, false);
});

test("suppresses the retired list when the index is display-truncated and notes the truncation", () => {
  const wide = Array.from({ length: 31 }, (_, index) =>
    entry({ slug: `user-${index}`, description: `Fact ${index}` }),
  );
  const truncated = overviewText(wide);
  assert.ok(truncated.includes("more entries hidden"));

  // After removing user-0 the bucket is no longer truncated: the previously hidden user-30 appears, and user-0 looks retired.
  const narrowed = overviewText(wide.slice(1));
  const update = formatMemoryTurnUpdate(truncated, narrowed);

  assert.ok(update.includes("[user-30|u|d0]"));
  // user-0's "disappearance" may be only from truncation and must not be reported as retired.
  assert.ok(!update.includes("No longer in the index"));
  assert.ok(!update.includes("- [user-0]"));
  assert.ok(update.includes("display-truncated"));
});

test("the planner is pure: repeated calls give identical results and inputs are not mutated", async () => {
  const baseline = baselineFrom(OVERVIEW_A);
  const snapshot = { ...baseline };
  const first = planMemoryTurnInjection({ baseline, overview: OVERVIEW_B });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = planMemoryTurnInjection({ baseline, overview: OVERVIEW_B });

  assert.deepEqual(first, second);
  assert.deepEqual(baseline, snapshot);
});

// ---------------------------------------------------------------------------
// Mounting: the update must land at the tail of the last user message (reusing pi-ai's 4th breakpoint)

test("the update for string content is appended to the message tail without mutating the input", () => {
  const messages = [
    { role: "user", id: "u1", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ];
  const next = attachMemoryTurnUpdates(messages, new Map([["u1", "<memory-update>x</memory-update>"]]));

  assert.equal(next[0].content, "hello\n\n<memory-update>x</memory-update>");
  assert.equal(messages[0].content, "hello");
  assert.equal(next[1], messages[1]);
});

test("the update for array content is appended as a trailing text block", () => {
  const messages = [
    {
      role: "user",
      id: "u1",
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "..." },
      ],
    },
  ];
  const next = attachMemoryTurnUpdates(messages, new Map([["u1", "UPDATE"]]));

  assert.equal(next[0].content.length, 3);
  assert.deepEqual(next[0].content.at(-1), { type: "text", text: "UPDATE" });
  assert.equal(messages[0].content.length, 2);
});

test("returns the same array unchanged when there is no matching id / a non-user message / an empty update list", () => {
  const messages = [
    { role: "user", id: "u1", content: "hello" },
    { role: "assistant", id: "a1", content: [{ type: "text", text: "hi" }] },
  ];

  assert.equal(attachMemoryTurnUpdates(messages, undefined), messages);
  assert.equal(attachMemoryTurnUpdates(messages, new Map()), messages);
  assert.equal(attachMemoryTurnUpdates(messages, new Map([["missing", "U"]])), messages);
  // Assistant messages are not mounted even if the id collides: the breakpoint only recognizes the last user message.
  assert.equal(attachMemoryTurnUpdates(messages, new Map([["a1", "U"]])), messages);
});

// ---------------------------------------------------------------------------
// End to end: verify system-section freezing by reconciling the phase ① prefix hash

function stateOf(messages) {
  return normalizeConversationState({
    meta: {
      systemPrompt: BASE_SYSTEM_PROMPT,
      tools: TOOLS,
      totalSegmentCount: 1,
      totalMessageCount: messages.length,
    },
    segments: [
      {
        segmentIndex: 0,
        segmentId: "s0",
        messages,
        messageCount: messages.length,
        createdAt: 1,
        updatedAt: messages.length + 1,
      },
    ],
  });
}

function contextFor(conversationId, messages, systemText) {
  return buildPreparedContext({
    state: stateOf(messages),
    tools: TOOLS,
    activeAgentPrompt: "",
    skillsPrompt: "",
    memoryPrompt: systemText,
    memoryTurnUpdates: memoryTurnInjection.getMessageUpdates(conversationId),
  });
}

function userTurn(index) {
  return { role: "user", id: `u${index}`, content: `turn ${index}`, timestamp: index * 10 };
}

function assistantTurn(index) {
  return {
    role: "assistant",
    content: [{ type: "text", text: `reply ${index}` }],
    stopReason: "stop",
    timestamp: index * 10 + 1,
  };
}

test("multi-turn reconciliation: unchanged content adds no message; changed content touches only the user message and the system section is judged unchanged", (t) => {
  const conversationId = "conv-multi-turn";
  t.after(() => memoryTurnInjection.dispose(conversationId));

  const messages = [];
  const shapes = [];
  const contexts = [];
  const overviews = [OVERVIEW_A, OVERVIEW_A, OVERVIEW_B, OVERVIEW_B];

  overviews.forEach((overview, index) => {
    const turn = index + 1;
    messages.push(userTurn(turn));
    const { systemText } = memoryTurnInjection.planTurn({
      conversationId,
      messageId: `u${turn}`,
      overview,
    });
    const context = contextFor(conversationId, messages, systemText);
    contexts.push(context);
    shapes.push(capturePrefixShape({ systemPrompt: context.systemPrompt, tools: context.tools }));
    messages.push(assistantTurn(turn));
  });

  // The message count each turn is the real message count: no turn fabricates an extra message.
  assert.deepEqual(
    contexts.map((context) => context.messages.length),
    [1, 3, 5, 7],
  );

  // The system section has been frozen since the first turn; all four turns are unchanged.
  const summaries = shapes.map((shape, index) =>
    comparePrefixShape(index === 0 ? null : shapes[index - 1], shape).prefixChangeSummary,
  );
  assert.deepEqual(summaries, ["initial", "unchanged", "unchanged", "unchanged"]);

  // Turn 2 memory did not change: no update block should appear in the context.
  assert.ok(!JSON.stringify(contexts[1].messages).includes("<memory-update>"));

  // Turn 3 memory changed: the update is attached to turn 3's user message, and history messages stay untouched.
  const thirdTurnUser = contexts[2].messages.find((message) => message.id === "u3");
  assert.ok(thirdTurnUser.content.includes("<memory-update>"));
  assert.ok(thirdTurnUser.content.includes("[user-editor|u|d0]"));
  assert.equal(contexts[2].messages[0].content, "turn 1");

  // Turn 4 replays the same bytes: the history interval stays cacheable.
  assert.equal(
    JSON.stringify(contexts[3].messages.slice(0, 5)),
    JSON.stringify(contexts[2].messages),
  );
});

test("control group: if the same change kept going through the system prompt, the prefix would be judged a system change", () => {
  const before = capturePrefixShape({
    systemPrompt: `${BASE_SYSTEM_PROMPT}\n\n${OVERVIEW_A}`,
    tools: TOOLS,
  });
  const after = capturePrefixShape({
    systemPrompt: `${BASE_SYSTEM_PROMPT}\n\n${OVERVIEW_B}`,
    tools: TOOLS,
  });

  assert.equal(comparePrefixShape(before, after).prefixChangeSummary, "system");
});

test("baseline lost after conversation restore: the full snapshot enters the system prompt once, with no duplicate injection", (t) => {
  const conversationId = "conv-restore";
  t.after(() => memoryTurnInjection.dispose(conversationId));

  memoryTurnInjection.planTurn({ conversationId, messageId: "u1", overview: OVERVIEW_A });
  memoryTurnInjection.planTurn({ conversationId, messageId: "u2", overview: OVERVIEW_B });
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 1);

  // Restart/restore: the in-memory baseline is gone along with the process.
  memoryTurnInjection.dispose(conversationId);

  const restored = memoryTurnInjection.planTurn({
    conversationId,
    messageId: "u3",
    overview: OVERVIEW_B,
  });
  assert.equal(restored.systemText, OVERVIEW_B);
  assert.equal(restored.turnUpdate, "");
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 0);

  const context = contextFor(
    conversationId,
    [userTurn(1), assistantTurn(1), userTurn(3)],
    restored.systemText,
  );
  assert.ok(!JSON.stringify(context.messages).includes("<memory-update>"));
  // The same content is not both put into the system section and sent again as an update.
  assert.equal(context.systemPrompt.split("# Memory Index").length - 1, 1);
});

test("discards this update when there is no message id to mount it on, without advancing the fingerprint", (t) => {
  const conversationId = "conv-no-message-id";
  t.after(() => memoryTurnInjection.dispose(conversationId));

  memoryTurnInjection.planTurn({ conversationId, messageId: "u1", overview: OVERVIEW_A });
  const skipped = memoryTurnInjection.planTurn({ conversationId, overview: OVERVIEW_B });
  assert.equal(skipped.turnUpdate, "");
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 0);

  // The fingerprint did not advance; when a message id appears next turn the same diff is filled in.
  const recovered = memoryTurnInjection.planTurn({
    conversationId,
    messageId: "u2",
    overview: OVERVIEW_B,
  });
  assert.ok(recovered.turnUpdate.includes("[user-editor|u|d0]"));
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).get("u2"), recovered.turnUpdate);
});

test("falls back to the old behavior when the conversation id is missing: the whole block goes into the system prompt", () => {
  const plan = memoryTurnInjection.planTurn({ conversationId: "  ", overview: OVERVIEW_A });

  assert.equal(plan.systemText, OVERVIEW_A);
  assert.equal(plan.turnUpdate, "");
});

test("state is cleared after the conversation is deleted", () => {
  const conversationId = "conv-dispose";
  memoryTurnInjection.planTurn({ conversationId, messageId: "u1", overview: OVERVIEW_A });
  memoryTurnInjection.planTurn({ conversationId, messageId: "u2", overview: OVERVIEW_B });
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 1);

  memoryTurnInjection.dispose(conversationId);
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId), undefined);
});

test("invalidate after compaction: the next turn refreezes the fresh snapshot into the system section and clears the old update", (t) => {
  const conversationId = "conv-compaction-invalidate";
  t.after(() => memoryTurnInjection.dispose(conversationId));

  memoryTurnInjection.planTurn({ conversationId, messageId: "u1", overview: OVERVIEW_A });
  memoryTurnInjection.planTurn({ conversationId, messageId: "u2", overview: OVERVIEW_B });
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 1);

  // Compaction complete: u2, which carried the update block, has been removed from the active segment.
  memoryTurnInjection.invalidate(conversationId);
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId), undefined);

  const next = memoryTurnInjection.planTurn({
    conversationId,
    messageId: "u3",
    overview: OVERVIEW_B,
  });
  assert.equal(next.systemText, OVERVIEW_B);
  assert.equal(next.turnUpdate, "");
});

test("the controller clears already-mounted update blocks on refreeze", (t) => {
  const conversationId = "conv-refreeze-clears";
  t.after(() => memoryTurnInjection.dispose(conversationId));

  memoryTurnInjection.planTurn({
    conversationId,
    messageId: "u1",
    overview: OVERVIEW_A,
    workdir: "/proj/a",
  });
  memoryTurnInjection.planTurn({
    conversationId,
    messageId: "u2",
    overview: OVERVIEW_B,
    workdir: "/proj/a",
  });
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 1);

  // A workdir switch triggers a refreeze: the old update describes the old snapshot's diff and must be cleared along with it.
  const refrozen = memoryTurnInjection.planTurn({
    conversationId,
    messageId: "u3",
    overview: OVERVIEW_A,
    workdir: "/proj/b",
  });
  assert.equal(refrozen.systemText, OVERVIEW_A);
  assert.equal(refrozen.turnUpdate, "");
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 0);
  assert.equal(memoryTurnInjection.getSystemText(conversationId), OVERVIEW_A);
});

// ---------------------------------------------------------------------------
// Bypass: the submodel path reusing the same messages must explicitly disable updates

test("with memoryTurnUpdates=null the extraction submodel still sees the user's original words", (t) => {
  const conversationId = "conv-extraction-bypass";
  t.after(() => memoryTurnInjection.dispose(conversationId));

  memoryTurnInjection.planTurn({ conversationId, messageId: "u1", overview: OVERVIEW_A });
  memoryTurnInjection.planTurn({ conversationId, messageId: "u2", overview: OVERVIEW_B });

  const messages = [userTurn(1), assistantTurn(1), userTurn(2)];
  const forModel = contextFor(conversationId, messages, OVERVIEW_A);
  const forExtraction = buildPreparedContext({
    state: stateOf(messages),
    tools: TOOLS,
    activeAgentPrompt: "",
    skillsPrompt: "",
    memoryPrompt: OVERVIEW_A,
    memoryTurnUpdates: null,
  });

  // The main model's copy carries the update: this is exactly why extraction cannot
  // reuse it directly — index lines would be treated as user speech, both breaking the
  // "skip if message too short" gate and inducing duplicate writes.
  assert.ok(extractLatestUserText(forModel.messages).includes("<memory-update>"));
  assert.equal(extractLatestUserText(forExtraction.messages), "turn 2");
});
