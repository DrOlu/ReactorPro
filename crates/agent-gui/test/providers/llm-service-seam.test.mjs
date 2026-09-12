import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// PR-1 seam skeleton unit tests: registry dispatch, error-message equivalence for unknown protocols,
// one-shot dispatch, dev freeze / no freeze in production, and wire payload equivalence between the compat shell
// and the unified llm.stream() entry.
//
// The overall behavioral-equivalence criterion is that both PR-0 golden suites pass unmodified (see
// wire-payload-golden.test.mjs / transport-golden.test.mjs); this file adds the new contracts of the
// seam itself.
// ============================================================================

const realAnthropic = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
    import.meta.url,
  ).href
);
const realCompletions = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js",
    import.meta.url,
  ).href
);
const realResponses = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js",
    import.meta.url,
  ).href
);
const realGoogle = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js",
    import.meta.url,
  ).href
);

const loader = createTsModuleLoader({
  mocks: {
    "@earendil-works/pi-ai/api/anthropic-messages": { stream: realAnthropic.stream },
    "@earendil-works/pi-ai/api/openai-completions": { stream: realCompletions.stream },
    "@earendil-works/pi-ai/api/openai-responses": { stream: realResponses.stream },
    "@earendil-works/pi-ai/api/google-generative-ai": { stream: realGoogle.stream },
  },
});

const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");
const { llm, llmStream, setLlmServiceDevModeForTest } = loader.loadModule(
  "src/lib/providers/service/llmService.ts",
);
const { registeredApis, resolveAdapter, registerAdapter } = loader.loadModule(
  "src/lib/providers/service/registry.ts",
);
const { piAiAdapter } = loader.loadModule("src/lib/providers/service/piAiAdapter.ts");
const { deepSeekAdapter } = loader.loadModule("src/lib/providers/service/deepSeekAdapter.ts");
const { DEEPSEEK_RESPONSES_API } = loader.loadModule("src/lib/providers/deepSeekNative.ts");

function buildModel(api, overrides = {}) {
  return {
    id: "test-model",
    provider: "openai",
    api,
    baseUrl: "https://example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  };
}

function buildContext() {
  return {
    systemPrompt: "You are a precise assistant.",
    messages: [{ role: "user", content: "hello world", timestamp: 1 }],
  };
}

/** Interrupts the request after capturing the wire payload in onPayload (the same capture channel as golden). */
async function captureViaEntry(entry, model, context, options = {}) {
  let captured;
  const stream = entry(model, context, {
    apiKey: "sk-test",
    ...options,
    onPayload: async (payload) => {
      captured = payload;
      throw new Error("__capture_stop__");
    },
  });
  try {
    await stream.result();
  } catch {
    // Throwing in onPayload to interrupt the request is expected.
  }
  assert.ok(captured, "expected wire payload capture");
  return JSON.parse(JSON.stringify(captured));
}

test.afterEach(() => {
  setLlmServiceDevModeForTest(undefined);
});

// ---------------------------------------------------------------------------
// Registry dispatch
// ---------------------------------------------------------------------------

test("seam/registry: five protocols each map to their place (4x pi-ai + native deepseek)", () => {
  // Triggers the default assembly (loading the llmService module registers them; the registry contents are asserted explicitly here).
  assert.deepEqual(registeredApis().sort(), [
    "anthropic-messages",
    DEEPSEEK_RESPONSES_API,
    "google-generative-ai",
    "openai-completions",
    "openai-responses",
  ].sort());

  for (const api of [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "google-generative-ai",
  ]) {
    assert.equal(resolveAdapter(api), piAiAdapter, `${api} should route to piAiAdapter`);
  }
  assert.equal(resolveAdapter(DEEPSEEK_RESPONSES_API), deepSeekAdapter);
});

test("seam/registry: unregistered-protocol error message matches the pre-refactor text word for word", () => {
  assert.throws(() => resolveAdapter("mock-api"), /^Error: Unsupported model API: mock-api$/);
  // Goes through the compat shell along the same path with the same message.
  assert.throws(
    () => streamSimpleByApi(buildModel("mock-api"), buildContext(), { apiKey: "k" }),
    /^Error: Unsupported model API: mock-api$/,
  );
});

test("seam/registry: registering a different adapter for the same protocol throws immediately", () => {
  const rogue = { apis: ["anthropic-messages"], stream: () => {} };
  assert.throws(
    () => registerAdapter(rogue),
    /Duplicate LLM adapter registration for API: anthropic-messages/,
  );
  // Re-registering the same adapter is idempotent (the default assembly's ensure semantics depend on it).
  registerAdapter(piAiAdapter);
});

// ---------------------------------------------------------------------------
// llm.stream() envelope semantics
// ---------------------------------------------------------------------------

test("seam/llm.stream: dispatching the same request envelope twice throws (one-shot dispatch)", async () => {
  const request = {
    model: buildModel("openai-completions"),
    context: buildContext(),
    options: {
      apiKey: "sk-test",
      onPayload: async () => {
        throw new Error("__capture_stop__");
      },
    },
  };
  const first = llm.stream(request);
  try {
    await first.result();
  } catch {
    // Interruption is expected.
  }
  assert.throws(() => llm.stream(request), /already dispatched/);
});

test("seam/llm.stream: dev builds freeze the request envelope, production builds do not", async () => {
  setLlmServiceDevModeForTest(true);
  const devRequest = {
    model: buildModel("openai-completions"),
    context: buildContext(),
    options: {
      apiKey: "sk-test",
      onPayload: async () => {
        throw new Error("__capture_stop__");
      },
    },
  };
  const devStream = llm.stream(devRequest);
  try {
    await devStream.result();
  } catch {
    // Interruption is expected.
  }
  assert.ok(Object.isFrozen(devRequest), "dev build must freeze the request envelope");

  setLlmServiceDevModeForTest(false);
  const prodRequest = {
    model: buildModel("openai-completions"),
    context: buildContext(),
    options: {
      apiKey: "sk-test",
      onPayload: async () => {
        throw new Error("__capture_stop__");
      },
    },
  };
  const prodStream = llm.stream(prodRequest);
  try {
    await prodStream.result();
  } catch {
    // Interruption is expected.
  }
  assert.equal(Object.isFrozen(prodRequest), false, "prod build must not freeze");
});

test("seam/llm.stream: automatic detection in the test loader environment lands on no-freeze (empty import.meta shell)", async () => {
  // No override is set: under esbuild CJS transpilation import.meta.env does not exist, so detectDevBuild ...
  const request = {
    model: buildModel("openai-completions"),
    context: buildContext(),
    options: {
      apiKey: "sk-test",
      onPayload: async () => {
        throw new Error("__capture_stop__");
      },
    },
  };
  const stream = llmStream(request);
  try {
    await stream.result();
  } catch {
    // Interruption is expected.
  }
  assert.equal(Object.isFrozen(request), false);
});

// ---------------------------------------------------------------------------
// Compat shell and unified entry equivalence
// ---------------------------------------------------------------------------

test("seam/equivalence: the compat shell and llm.stream() produce the same wire payload", async () => {
  const context = buildContext();
  const viaShim = await captureViaEntry(
    streamSimpleByApi,
    buildModel("openai-completions"),
    context,
  );
  const viaService = await captureViaEntry(
    (model, ctx, options) => llm.stream({ model, context: ctx, options }),
    buildModel("openai-completions"),
    context,
  );
  assert.deepEqual(viaService, viaShim);
});

test("seam/equivalence: the native deepseek protocol is equally equivalent through both entries", async () => {
  const context = buildContext();
  const model = buildModel(DEEPSEEK_RESPONSES_API, { provider: "deepseek" });
  const viaShim = await captureViaEntry(streamSimpleByApi, model, context);
  const viaService = await captureViaEntry(
    (m, ctx, options) => llm.stream({ model: m, context: ctx, options }),
    model,
    context,
  );
  assert.deepEqual(viaService, viaShim);
});
