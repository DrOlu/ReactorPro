import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const anthropicModels = loader.loadModule("src/lib/providers/anthropicModels.ts");
const longContext = loader.loadModule("src/lib/providers/runtime/anthropicLongContext.ts");
const payloadPipeline = loader.loadModule("src/lib/providers/runtime/payloadPipeline.ts");
const modelFactory = loader.loadModule("src/lib/providers/runtime/modelFactory.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const INTERLEAVED_BETA = "interleaved-thinking-2025-05-14";
const FINE_GRAINED_BETA = "fine-grained-tool-streaming-2025-05-14";

function makeAnthropicModel(overrides = {}) {
  return {
    id: "claude-sonnet-4-6",
    name: "claude-sonnet-4-6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://relay.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    compat: { forceAdaptiveThinking: true },
    ...overrides,
  };
}

test("Long-context beta: for adaptive models with ctx>200K only context-1m is appended, preserving existing request headers", () => {
  const options = {
    apiKey: "sk-relay-key",
    headers: { Authorization: "Bearer sk-relay-key", "x-api-key": "sk-relay-key" },
  };
  const next = longContext.attachAnthropicLongContextBeta(options, {
    providerId: "claude_code",
    baseUrl: "https://relay.example.com/v1",
    model: makeAnthropicModel(),
  });
  assert.equal(next.headers["anthropic-beta"], CONTEXT_1M_BETA);
  assert.equal(next.headers.Authorization, "Bearer sk-relay-key");
  assert.equal(next.headers["x-api-key"], "sk-relay-key");
  // The original options are not mutated in place.
  assert.equal(options.headers["anthropic-beta"], undefined);
});

test("Long-context beta: non-adaptive models mirror pi-ai's interleaved beta and then append context-1m", () => {
  const next = longContext.attachAnthropicLongContextBeta(
    { apiKey: "sk-relay-key", headers: {} },
    {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel({ id: "claude-sonnet-4-5", compat: undefined }),
    },
  );
  assert.equal(next.headers["anthropic-beta"], `${INTERLEAVED_BETA},${CONTEXT_1M_BETA}`);
});

test("Long-context beta: with compat disabling eager streaming and tools present, mirror the fine-grained beta", () => {
  const next = longContext.attachAnthropicLongContextBeta(
    { apiKey: "sk-relay-key", headers: {} },
    {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel({
        compat: { forceAdaptiveThinking: true, supportsEagerToolInputStreaming: false },
      }),
      context: {
        messages: [],
        tools: [{ name: "read", description: "", parameters: { type: "object" } }],
      },
    },
  );
  assert.equal(next.headers["anthropic-beta"], `${FINE_GRAINED_BETA},${CONTEXT_1M_BETA}`);
});

test("Long-context beta: ignore existing values and use only pi-ai's dynamic beta and context-1m", () => {
  const next = longContext.attachAnthropicLongContextBeta(
    {
      apiKey: "sk-relay-key",
      headers: {
        "Anthropic-Beta": `prompt-caching-scope-2026-01-05, ${CONTEXT_1M_BETA}`,
        Authorization: "Bearer sk-relay-key",
      },
    },
    {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel({
        compat: undefined,
        headers: { "anthropic-beta": "model-custom-beta" },
      }),
    },
  );
  assert.equal(next.headers["anthropic-beta"], `${INTERLEAVED_BETA},${CONTEXT_1M_BETA}`);
  assert.equal(next.headers["Anthropic-Beta"], undefined);
  assert.equal(next.headers.Authorization, "Bearer sk-relay-key");
});

test("Long-context beta: Anthropic official and Vertex endpoints do not inject the HTTP 1M beta header", () => {
  for (const baseUrl of [
    "https://api.anthropic.com/v1",
    "https://us-central1-aiplatform.googleapis.com/v1",
  ]) {
    const options = { apiKey: "sk-relay-key", headers: {} };
    assert.equal(
      longContext.attachAnthropicLongContextBeta(options, {
        providerId: "claude_code",
        baseUrl,
        model: makeAnthropicModel(),
      }),
      options,
      baseUrl,
    );
  }
});

test("Long-context beta: standard window/OAuth/non-anthropic api are never rewritten", () => {
  const standardWindow = { apiKey: "sk-relay-key", headers: {} };
  assert.equal(
    longContext.attachAnthropicLongContextBeta(standardWindow, {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel({ contextWindow: 200_000 }),
    }),
    standardWindow,
  );

  // OAuth: pi-ai injects the claude-code/oauth beta combination, and overriding it would break
  // authentication; after official GA, OAuth does not need this header either.
  const oauth = { apiKey: "sk-ant-oat01-xxx", headers: {} };
  assert.equal(
    longContext.attachAnthropicLongContextBeta(oauth, {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel(),
    }),
    oauth,
  );

  const gemini = { apiKey: "sk-relay-key", headers: {} };
  assert.equal(
    longContext.attachAnthropicLongContextBeta(gemini, {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
      model: makeAnthropicModel({ api: "google-generative-ai", provider: "google" }),
    }),
    gemini,
  );

  const noModel = { apiKey: "sk-relay-key", headers: {} };
  assert.equal(
    longContext.attachAnthropicLongContextBeta(noModel, {
      providerId: "claude_code",
      baseUrl: "https://relay.example.com/v1",
    }),
    noModel,
  );
});

test("Payload pipeline: catalog models automatically carry the 1M beta header after createModelFromConfig", () => {
  const model = modelFactory.createModelFromConfig(
    "claude_code",
    "claude-sonnet-4-6",
    "https://relay.example.com/v1",
  );
  const finalized = payloadPipeline.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl: "https://relay.example.com/v1",
    options: { apiKey: "sk-relay-key", headers: { "x-api-key": "sk-relay-key" } },
    model,
  });
  assert.equal(finalized.headers["anthropic-beta"], CONTEXT_1M_BETA);
  assert.equal(finalized.headers["x-api-key"], "sk-relay-key");
});

test("Id normalization: strip the [1m] suffix and combine it with date/@version/case rules", () => {
  const candidates = anthropicModels.normalizeAnthropicModelIdCandidates(
    "Claude-Sonnet-4-6-20260101[1m]",
  );
  assert.ok(candidates.includes("claude-sonnet-4-6"));
  assert.ok(candidates.includes("claude-sonnet-4-6-20260101"));
  // The original id is always the preferred candidate, and after a catalog hit the request body still uses the original id.
  assert.equal(candidates[0], "Claude-Sonnet-4-6-20260101[1m]");
});

test("Wire model id: official endpoints strip [1m], while compatibility relays keep the suffix required by the endpoint", () => {
  const official = modelFactory.createModelFromConfig(
    "claude_code",
    "claude-sonnet-4-6[1m]",
    "https://api.anthropic.com/v1",
    undefined,
    undefined,
    "https://api.anthropic.com/v1",
  );
  assert.equal(official.id, "claude-sonnet-4-6");
  assert.equal(official.contextWindow, 1_000_000);

  const relay = modelFactory.createModelFromConfig(
    "claude_code",
    "claude-sonnet-4-5[1m]",
    "https://relay.example.com/v1",
    undefined,
    undefined,
    "https://relay.example.com/v1",
  );
  assert.equal(relay.id, "claude-sonnet-4-5[1m]");
  assert.equal(relay.contextWindow, 1_000_000);
});

test("Effective limit: adaptive generations keep 1M, older generations clamp back to 200K by default, and an explicit [1m] goes through as relay 1M", () => {
  assert.deepEqual(anthropicModels.resolveAnthropicKnownModelLimits("claude-sonnet-4-6"), {
    contextWindow: 1_000_000,
    maxOutputToken: 128_000,
  });
  assert.deepEqual(anthropicModels.resolveAnthropicKnownModelLimits("claude-sonnet-4-6[1m]"), {
    contextWindow: 1_000_000,
    maxOutputToken: 128_000,
  });
  // Anthropic retired the context-1m beta for sonnet-4/4.5 as of 2026-04-30; the catalog's 1M is a historical value.
  assert.deepEqual(anthropicModels.resolveAnthropicKnownModelLimits("claude-sonnet-4-5"), {
    contextWindow: 200_000,
    maxOutputToken: 64_000,
  });
  assert.deepEqual(
    anthropicModels.resolveAnthropicKnownModelLimits("claude-sonnet-4-5[1m]", "https://relay.example.com/v1"),
    {
      contextWindow: 1_000_000,
      maxOutputToken: 64_000,
    },
  );
  assert.equal(anthropicModels.resolveAnthropicKnownModelLimits("unknown-model"), undefined);
});

test("Settings defaults: decorated ids inherit the normalized catalog limit, and unknown ids fall back to the 200K default", () => {
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "claude-sonnet-4-6-20260101").contextWindow,
    1_000_000,
  );
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "claude-sonnet-4-5").contextWindow,
    200_000,
  );
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "some-custom-model").contextWindow,
    200_000,
  );
  assert.equal(
    settings.getProviderModelDefaults("claude_code", "some-custom-model[1m]").contextWindow,
    1_000_000,
  );
  assert.equal(
    settings.findProviderModelConfig(
      { models: [], type: "claude_code", baseUrl: "https://relay.example.com/v1" },
      "claude-sonnet-4-5[1m]",
    ).contextWindow,
    1_000_000,
  );
  assert.equal(
    settings.findProviderModelConfig(
      { models: [], type: "claude_code", baseUrl: "https://api.anthropic.com/v1" },
      "claude-sonnet-4-5[1m]",
    ).contextWindow,
    200_000,
  );
  assert.equal(
    settings.findProviderModelConfig(
      { models: [], type: "claude_code", baseUrl: "https://relay.example.com/v1" },
      "custom-fable-5-relay",
    ).contextWindow,
    1_000_000,
  );
});
