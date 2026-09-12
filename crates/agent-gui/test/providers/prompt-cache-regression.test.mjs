import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import {
  commonPrefixLength,
  flattenAnthropicPayload,
  runCacheSimulation,
} from "../helpers/prompt-cache-sim.mjs";

const loader = createTsModuleLoader();
const providers = loader.loadModule("src/lib/providers/runtime/payloadPipeline.ts");

// ---------------------------------------------------------------------------
// Conversation construction: a stable prefix + history appended turn by turn. This is the standard shape for cache-friendly writing.

const SYSTEM_PROMPT = `You are ReactorPro, a local-first AI agent.
${"Follow the workspace conventions carefully. ".repeat(40)}`;

const TOOLS = [
  { name: "Bash", description: "Run a shell command", input_schema: { type: "object" } },
  { name: "Read", description: "Read a file from disk", input_schema: { type: "object" } },
  { name: "Write", description: "Write a file to disk", input_schema: { type: "object" } },
];

/** Message list for turn n: the history from the first n-1 turns is kept as-is, with appends only at the tail. */
function buildMessages(turnCount, { mutateHistory = false, perTurnRepeat = 30 } = {}) {
  const messages = [];
  for (let turn = 1; turn <= turnCount; turn += 1) {
    const suffix = mutateHistory ? ` (rendered at turn ${turnCount})` : "";
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `User request number ${turn}.${suffix} ${"detail ".repeat(perTurnRepeat)}` },
      ],
    });
    if (turn < turnCount) {
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: `Assistant reply number ${turn}. ${"answer ".repeat(perTurnRepeat)}` },
        ],
      });
    }
  }
  return messages;
}

/** Run one round of a request through the real payload middleware chain to get the request body that would actually go out. */
async function runPipeline(payload, { baseUrl, cacheRetention = "short" }) {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl,
    options: { cacheRetention },
  });
  const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-6" };
  return options.onPayload ? await options.onPayload(payload, model) : payload;
}

/**
 * Replicates the breakpoint placement of pi-ai's upstream buildParams as a control group.
 *
 * Evidence (from the locally installed 0.80.10 dist):
 *   anthropic-messages.js:715 system identity block / :722 systemPrompt block
 *   anthropic-messages.js:996 the last tool (index === tools.length - 1)
 *   anthropic-messages.js:962 the last block of the last user message
 * Only the **breakpoint positions** are replicated here, not the other request body details -
 * what this file compares is the breakpoint distribution.
 */
function applyUpstreamBreakpoints(payload) {
  const cacheControl = { type: "ephemeral" };
  const system = (payload.system ?? []).map((block, index, all) =>
    index === all.length - 1 || index === 0 ? { ...block, cache_control: cacheControl } : block,
  );
  const tools = (payload.tools ?? []).map((tool, index, all) =>
    index === all.length - 1 ? { ...tool, cache_control: cacheControl } : tool,
  );
  const messages = (payload.messages ?? []).map((message, index, all) => {
    if (index !== all.length - 1 || message.role !== "user") return message;
    const content = message.content.map((block, blockIndex, blocks) =>
      blockIndex === blocks.length - 1 ? { ...block, cache_control: cacheControl } : block,
    );
    return { ...message, content };
  });
  return { ...payload, system, tools, messages };
}

function buildBasePayload(turnCount, options = {}) {
  return {
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    tools: TOOLS,
    messages: buildMessages(turnCount, options),
  };
}

async function buildConversation({
  turns = 5,
  baseUrl,
  cacheRetention = "short",
  mutateHistory = false,
  transform,
}) {
  const payloads = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const base = buildBasePayload(turn, { mutateHistory });
    const shaped = transform ? transform(base) : await runPipeline(base, { baseUrl, cacheRetention });
    payloads.push(shaped);
  }
  return payloads;
}

async function simulateConversation(options) {
  return runCacheSimulation(await buildConversation(options), { model: "anthropic" });
}

/**
 * Prefix stability assertion - borrowing the approach from grok-build (the `xai-chat-state`
 * actor test): instead of guessing what the hit rate should be, it only asserts that "the byte
 * sequence that went out on turn n is a prefix of turn n+1", and when it is not, it reports the
 * **first diverging byte position** and prints the surrounding context.
 *
 * This is stronger than a threshold assertion in two ways: first, there is no threshold to tune,
 * so there is no room to make the numbers look good; second, on failure it directly gives the
 * attribution position rather than only telling you "the hit rate dropped". An append-only
 * conversation should satisfy this property, and any violation means we stuffed non-deterministic
 * content (timestamps, random ids, reordered tool lists) into the request body - which is exactly
 * what really destroys the cache.
 */
function assertPrefixStable(payloads) {
  const flattened = payloads.map(flattenAnthropicPayload);
  for (let index = 1; index < flattened.length; index += 1) {
    const previous = flattened[index - 1].text;
    const current = flattened[index].text;
    const shared = commonPrefixLength(previous, current);
    if (shared === previous.length) continue;

    assert.fail(
      `Turn ${index} and turn ${index + 1} diverge at byte ${shared} (previous turn total length ${previous.length})\n` +
        `  Previous turn: ${JSON.stringify(previous.slice(shared, shared + 60))}\n` +
        `  Current turn: ${JSON.stringify(current.slice(shared, shared + 60))}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The simulator's own self-check. If the ruler is not calibrated first, every later number is untrustworthy.

test("Simulator: two identical rounds hit the entire prefix", () => {
  const payload = applyUpstreamBreakpoints(buildBasePayload(3));
  const result = runCacheSimulation([payload, payload], { model: "anthropic" });

  assert.equal(result.rounds[0].hit, 0, "the first round has nothing to compare against, so it must be all miss");
  assert.equal(result.rounds[1].hit, result.rounds[1].total, "the second round should hit everything");
  assert.equal(result.steadyStateHitRate, 1);
});

test("Simulator: a change in the first byte zeroes the hits", () => {
  const first = applyUpstreamBreakpoints(buildBasePayload(3));
  const second = applyUpstreamBreakpoints({
    ...buildBasePayload(3),
    system: [{ type: "text", text: `X${SYSTEM_PROMPT}` }],
  });
  const result = runCacheSimulation([first, second], { model: "anthropic" });

  assert.equal(result.rounds[1].hit, 0, "the first byte of system changed, so everything after is void");
});

test("Simulator: with no breakpoints the hit count is always 0", () => {
  const payload = buildBasePayload(3); // no cache_control applied
  const result = runCacheSimulation([payload, payload], { model: "anthropic" });

  assert.equal(result.rounds[1].breakpointCount, 0);
  assert.equal(result.rounds[1].hit, 0, "Anthropic does not cache requests without breakpoints");
});

// ---------------------------------------------------------------------------
// Real regressions on the production path. These run finalizeProviderStreamOptions, not a replica.
//
// Regarding the "99% hit rate" goal, let us be clear up front, otherwise the thresholds below will be misread:
//
// A purely append-only conversation has a purely mathematical ceiling on its steady-state hit
// rate - turn n can at most hit the full turn n-1, since the content added this turn did not exist
// in the previous turn. Expanded:
//     steady_max = Σ(n=2..N) T_{n-1} / Σ(n=2..N) T_n
// Plugging in real numbers: to make it >= 99%, you need base/delta ~ 74x (50 turns) to 98x (3
// turns). A realistic coding agent shape (system+tools 40K chars, 2K added per turn) only reaches
// 95.7%~96.8%; even if the tool table grows to 80K, it only reaches 98.0%.
//
// In other words: **the absolute hit rate is mainly determined by the conversation shape, not by
// our implementation**. With the same code, enlarging the system prompt can push the number to 99%
// - that tests the fixture, not the code. So this asserts two things independent of shape:
//   1. efficiency (actual hits / theoretical ceiling) == 100%, i.e. no byte that could have been hit was missed;
//   2. byte-level prefix stability, i.e. we did not stuff non-deterministic content into the request body.
// The real percentage figures are measured with the benchmark (see PR #489), not pinned by unit tests.

test("Official domain: append-only conversations reach the theoretical ceiling with not a single hittable byte missed", async () => {
  const payloads = await buildConversation({
    turns: 5,
    baseUrl: "https://api.anthropic.com/v1",
    cacheRetention: "long",
  });
  assertPrefixStable(payloads);

  const result = runCacheSimulation(payloads, { model: "anthropic" });
  assert.equal(
    result.efficiency,
    1,
    `efficiency ${(result.efficiency * 100).toFixed(2)}% - a hittable prefix was not covered by a breakpoint`,
  );
});

test("Third-party proxy: the explicit breakpoint path also reaches the theoretical ceiling", async () => {
  const payloads = await buildConversation({
    turns: 5,
    baseUrl: "https://proxy.example.com/anthropic",
    cacheRetention: "short",
  });
  assertPrefixStable(payloads);

  const result = runCacheSimulation(payloads, { model: "anthropic" });
  assert.equal(
    result.efficiency,
    1,
    `efficiency ${(result.efficiency * 100).toFixed(2)}% - the proxy path missed a hittable prefix`,
  );
});

test("A high base/low delta conversation shape can indeed reach 99% - proving the ceiling formula matches the simulator", async () => {
  // Enlarge the system prompt and shrink the per-turn delta, i.e. raise the base/delta ratio. This
  // is the real source of "99%": conversation shape, not breakpoint strategy. It is here so the
  // explanation above can be verified, rather than leaving an assertion that cannot be re-checked.
  const payloads = [];
  const bigSystem = `You are ReactorPro.\n${"Follow the workspace conventions carefully. ".repeat(600)}`;
  for (let turn = 1; turn <= 10; turn += 1) {
    const base = {
      system: [{ type: "text", text: bigSystem }],
      tools: TOOLS,
      messages: buildMessages(turn, { perTurnRepeat: 10 }),
    };
    payloads.push(await runPipeline(base, { baseUrl: "https://api.anthropic.com/v1" }));
  }

  const result = runCacheSimulation(payloads, { model: "anthropic" });
  assert.equal(result.efficiency, 1, "it must likewise reach the ceiling");
  assert.ok(
    result.steadyStateHitRate >= 0.99,
    `steady-state hit rate ${(result.steadyStateHitRate * 100).toFixed(2)}%, below 99%`,
  );
});

test("Rewriting history messages punches through the hit rate - this is a regression guardrail, not a defect", async () => {
  const clean = await simulateConversation({
    turns: 5,
    baseUrl: "https://api.anthropic.com/v1",
  });
  const mutatedPayloads = await buildConversation({
    turns: 5,
    baseUrl: "https://api.anthropic.com/v1",
    mutateHistory: true,
  });
  const mutated = runCacheSimulation(mutatedPayloads, { model: "anthropic" });

  // The rendering marker in the history is rewritten every turn -> the common prefix stops before the first message.
  assert.ok(
    mutated.steadyStateHitRate < clean.steadyStateHitRate,
    "rewriting history must manifest as a hit-rate drop, otherwise the simulator is not really comparing bytes",
  );
  assert.ok(
    mutated.steadyStateHitRate < 0.5,
    `rewriting history should significantly degrade the hit rate; actual ${(mutated.steadyStateHitRate * 100).toFixed(2)}%`,
  );

  // Conversely, verify the prefix stability checker itself works: it must fail here. If the checker
  // always passed, the two assertPrefixStable calls above would be decoration.
  assert.throws(
    () => assertPrefixStable(mutatedPayloads),
    /diverge/,
    "the prefix stability checker must catch history rewriting, otherwise it is not doing anything",
  );
});

// ---------------------------------------------------------------------------
// The breakpoint-count debate: 1 vs 4, measured directly on the same ruler.

test("Append-only conversation: single breakpoint and upstream multiple breakpoints have exactly the same hit rate", async () => {
  const single = await simulateConversation({
    turns: 5,
    baseUrl: "https://proxy.example.com/anthropic",
  });
  const upstream = await simulateConversation({
    turns: 5,
    transform: applyUpstreamBreakpoints,
  });

  // In pure appends, the last breakpoint of the previous turn always falls within this turn's
  // common prefix, so the ladder has nothing to do - the content covered by the earlier breakpoints
  // is already fully covered by the last one. Hence this is **strict equality**, not "comparable".
  // Writing it as an inequality would obscure an informative fact: in this scenario, collapsing 4
  // breakpoints into 1 costs nothing. The real cost is in the next test.
  assert.equal(single.efficiency, 1);
  assert.equal(upstream.efficiency, 1);
  assert.equal(
    single.steadyStateHitRate,
    upstream.steadyStateHitRate,
    "in an append-only conversation the number of breakpoints does not affect the hit rate; the two should be strictly equal",
  );
});

test("Prefix tail mutation: multiple breakpoints keep the ladder, a single breakpoint zeroes out entirely", async () => {
  // Construct a round where "the tail of the history is rewritten, but system and tools are
  // untouched". This is exactly the shape of compaction, retry rewrites, tool-result backfills, etc.
  const buildPair = async (transform) => {
    const first = buildBasePayload(4);
    const second = {
      ...buildBasePayload(4),
      messages: buildMessages(4).map((message, index, all) =>
        index === all.length - 1
          ? { ...message, content: [{ type: "text", text: "COMPLETELY DIFFERENT TAIL" }] }
          : message,
      ),
    };
    return [
      transform
        ? transform(first)
        : await runPipeline(first, { baseUrl: "https://proxy.example.com/anthropic" }),
      transform
        ? transform(second)
        : await runPipeline(second, { baseUrl: "https://proxy.example.com/anthropic" }),
    ];
  };

  const singleResult = runCacheSimulation(await buildPair(null), { model: "anthropic" });
  const upstreamResult = runCacheSimulation(await buildPair(applyUpstreamBreakpoints), {
    model: "anthropic",
  });

  assert.equal(
    singleResult.rounds[1].hit,
    0,
    "single breakpoint at the end: once the tail changes, the only breakpoint falls outside the common prefix and the hit count goes to zero",
  );
  assert.ok(
    upstreamResult.rounds[1].hit > 0,
    "multiple breakpoints: the breakpoints on system / tools are still within the common prefix, so the ladder works",
  );
  assert.ok(
    upstreamResult.rounds[1].hitRate > singleResult.rounds[1].hitRate,
    "this is the cost of collapsing 4 breakpoints into 1",
  );
});

// ---------------------------------------------------------------------------
// DeepSeek implicit caching: 128-token block quantization, explaining why measurements stop at 98.9% instead of 100%

test("DeepSeek implicit caching: the hit count is always a multiple of 128, and the loss never exceeds one block", async () => {
  const payloads = [];
  for (let turn = 1; turn <= 5; turn += 1) payloads.push(buildBasePayload(turn));
  const result = runCacheSimulation(payloads, { model: "deepseek" });

  for (const round of result.rounds) {
    assert.equal(round.hit % 128, 0, `turn ${round.round} hit ${round.hit} is not a multiple of 128`);

    // The gap from the ceiling must come **only** from block quantization, i.e. be strictly less
    // than one block. This is far more meaningful than "hit rate > 0.9": 0.9 is arbitrary and drifts
    // with the fixture shape, whereas "loss < 128 tokens" is a direct corollary of the
    // block-quantization mechanism and holds for any fixture. The measured 98.9% ceiling comes from
    // exactly this - not an implementation defect, just that block boundaries cannot be filled completely.
    const lost = round.ceiling - round.hit;
    assert.ok(
      lost >= 0 && lost < 128,
      `turn ${round.round} lost ${lost} tokens, beyond what block quantization can explain`,
    );
  }

  assert.ok(
    result.efficiency < 1,
    "block quantization means the ceiling can never be fully reached - this is a ceiling, not a defect",
  );
});
