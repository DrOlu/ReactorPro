import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Uses the real pi-ai anthropic stream(), captures the request body via onPayload
// and then aborts; the assertions are about the final wire format
// (thinking/output_config), not the intermediate structure.
const realAnthropic = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
    import.meta.url,
  ).href
);

const loader = createTsModuleLoader({
  mocks: {
    "@earendil-works/pi-ai/api/anthropic-messages": { stream: realAnthropic.stream },
  },
});

const { createModelFromConfig } = loader.loadModule("src/lib/providers/runtime/modelFactory.ts");
const { resolveModelThinking } = loader.loadModule("@liveagent/ui/lib/models/modelThinking.ts");
const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");

const RELAY_BASE_URL = "https://relay.example.com/v1";

function levelsFor(modelId) {
  return resolveModelThinking("claude_code", modelId).levels;
}

async function captureWirePayload(modelId, reasoning, baseUrl = RELAY_BASE_URL) {
  const model = createModelFromConfig("claude_code", modelId, baseUrl, undefined, undefined, baseUrl);
  let captured;
  const stream = streamSimpleByApi(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    {
      apiKey: "sk-test",
      reasoning,
      onPayload: (payload) => {
        captured = payload;
        throw new Error("__capture_stop__");
      },
    },
  );
  try {
    await stream.result();
  } catch {
    // Throwing in onPayload to abort the request is expected.
  }
  assert.ok(captured, `expected payload capture for ${modelId}`);
  return captured;
}

test("anthropic: decorated catalog model ids (date suffix/casing/@version) inherit catalog adaptive metadata", () => {
  for (const [modelId, baseId] of [
    ["claude-opus-4-8-20260213", "claude-opus-4-8"],
    ["Claude-Fable-5", "claude-fable-5"],
    ["claude-sonnet-4-6-20251114", "claude-sonnet-4-6"],
    ["claude-opus-4-5@20251101", "claude-opus-4-5"],
    ["claude-sonnet-4-6[1m]", "claude-sonnet-4-6"],
  ]) {
    const model = createModelFromConfig("claude_code", modelId, RELAY_BASE_URL);
    const base = createModelFromConfig("claude_code", baseId, "https://api.anthropic.com");
    // The compatibility relay keeps the user-configured raw id so it can recognize the date/@version/[1m] decorations.
    assert.equal(model.id, modelId);
    assert.equal(model.baseUrl, RELAY_BASE_URL);
    assert.equal(
      model.compat?.forceAdaptiveThinking,
      base.compat?.forceAdaptiveThinking,
      `${modelId} should inherit adaptive flag from ${baseId}`,
    );
    assert.deepEqual(model.thinkingLevelMap, base.thinkingLevelMap);
  }
});

test("anthropic: a decorated id's optional levels match the catalog base model (xhigh/max not lost)", () => {
  // Levels come from the generated catalog (models.dev): the adaptive generation has no minimal level.
  assert.deepEqual(levelsFor("claude-opus-4-8-20260213"), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(levelsFor("claude-sonnet-4-6-20251114"), ["low", "medium", "high", "max"]);
});

test("anthropic: third-party renamed ids with no catalog hit are heuristically detected as the adaptive family", () => {
  // Opus 4.7+/Claude 5 family: xhigh passes through; the adaptive generation has no minimal level (same shape as the catalog).
  for (const modelId of ["claude-4.7-opus", "claude-5-sonnet", "custom-fable-5-relay"]) {
    const model = createModelFromConfig("claude_code", modelId, RELAY_BASE_URL);
    assert.equal(model.compat?.forceAdaptiveThinking, true, `${modelId} should be adaptive`);
    assert.equal(model.contextWindow, 1_000_000, `${modelId} should expose the 1M window`);
    assert.deepEqual(model.thinkingLevelMap, { minimal: null, xhigh: "xhigh", max: "max" });
  }
  // Opus 4.6/Sonnet 4.6/Mythos Preview: only up to max.
  for (const modelId of ["claude-4.6-sonnet", "claude-mythos-preview"]) {
    const model = createModelFromConfig("claude_code", modelId, RELAY_BASE_URL);
    assert.equal(model.compat?.forceAdaptiveThinking, true, `${modelId} should be adaptive`);
    assert.equal(model.contextWindow, 1_000_000, `${modelId} should expose the 1M window`);
    assert.deepEqual(model.thinkingLevelMap, { minimal: null, max: "max" });
  }
});

test("anthropic: legacy/ambiguous ids are not misdetected as adaptive and keep budget semantics", () => {
  for (const modelId of [
    "claude-3-5-sonnet-20241022",
    "claude-3-7-sonnet-20250219",
    "claude-4-5-sonnet",
    "claude-sonnet-4-5-x",
    "claude-3-haiku-20240307",
  ]) {
    const model = createModelFromConfig("claude_code", modelId, RELAY_BASE_URL);
    assert.notEqual(
      model.compat?.forceAdaptiveThinking,
      true,
      `${modelId} must stay budget-mode`,
    );
  }
});

test("anthropic wire: a decorated id sends adaptive + output_config.effort, and the level follows the selection", async () => {
  const high = await captureWirePayload("claude-opus-4-8-20260213", "high");
  assert.equal(high.thinking?.type, "adaptive");
  assert.equal(high.output_config?.effort, "high");
  assert.equal(high.model, "claude-opus-4-8-20260213");

  const max = await captureWirePayload("claude-opus-4-8-20260213", "max");
  assert.equal(max.output_config?.effort, "max");

  const low = await captureWirePayload("claude-4.7-opus", "low");
  assert.equal(low.thinking?.type, "adaptive");
  assert.equal(low.output_config?.effort, "low");
});

test("anthropic wire: a legacy-generation id still sends budget_tokens and no output_config", async () => {
  const payload = await captureWirePayload("claude-3-7-sonnet-20250219", "high");
  assert.equal(payload.thinking?.type, "enabled");
  assert.equal(payload.thinking?.budget_tokens, 16_384);
  assert.equal(payload.output_config, undefined);
});

test("anthropic wire: the [1m] suffix produces a real request model id per endpoint policy", async () => {
  const relayPayload = await captureWirePayload("claude-sonnet-4-5[1m]", undefined);
  assert.equal(relayPayload.model, "claude-sonnet-4-5[1m]");

  const officialPayload = await captureWirePayload(
    "claude-sonnet-4-6[1m]",
    undefined,
    "https://api.anthropic.com/v1",
  );
  assert.equal(officialPayload.model, "claude-sonnet-4-6");
});
