import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * Unit tests for PR-3 payload interceptor registration (feat-llm-interceptors):
 *
 * 1. Default registration order snapshot --- assert the 10 named interceptors one by one; the order is
 *    part of protocol correctness, and any reordering must explicitly change this;
 * 2. Custom interceptor semantics --- params visible, options transformable, execution position after
 *    the default interceptors and before the tail of the payload-debug-logging chain;
 * 3. dispose removes and is idempotent, duplicate registration under the same name throws;
 * 4. Behavioral equivalence --- with an empty registration state, finalizeProviderStreamOptions output is
 *    field-for-field identical to composing directly with the old array order (together with the two
 *    golden suites passing unmodified, this constitutes the equivalence evidence for PR-3).
 */

const loader = createTsModuleLoader();
// First load payloadPipeline (which installs the default interceptors), then obtain the registry API.
const {
  finalizeProviderStreamOptions,
  composePayloadMiddlewares,
  attachPayloadDebugLogging,
} = loader.loadModule("src/lib/providers/runtime/payloadPipeline.ts");
const { listPayloadInterceptorNames, usePayloadInterceptor } = loader.loadModule(
  "src/lib/providers/service/interceptors.ts",
);
const { llm } = loader.loadModule("src/lib/providers/service/llmService.ts");

const EXPECTED_DEFAULT_ORDER = [
  "anthropic-automatic-caching",
  "anthropic-long-context-beta",
  "codex-responses-storage",
  "codex-prompt-cache-hint",
  "provider-native-web-search",
  "xai-responses-payload-compat",
  "deepseek-responses-payload-compat",
  "native-attachments",
  "gemini-thought-signature-guard",
  "payload-debug-logging",
];

function baseParams(overrides = {}) {
  return {
    providerId: "claude_code",
    baseUrl: "https://relay.example/v1",
    options: {},
    ...overrides,
  };
}

test("default registration order snapshot: all 10 named interceptors match one by one", () => {
  assert.deepEqual(listPayloadInterceptorNames(), EXPECTED_DEFAULT_ORDER);
});

test("llm.use exposes the registration entry and is same-source as usePayloadInterceptor", () => {
  assert.equal(llm.use, usePayloadInterceptor);
});

test("custom interceptor: params visible, options transformable, restored after dispose", () => {
  const seen = [];
  const dispose = usePayloadInterceptor({
    name: "test-marker",
    intercept: (options, params) => {
      seen.push(params.providerId);
      return { ...options, headers: { ...(options.headers ?? {}), "x-test-marker": "1" } };
    },
  });
  try {
    const withMarker = finalizeProviderStreamOptions(baseParams());
    assert.equal(withMarker.headers["x-test-marker"], "1");
    assert.deepEqual(seen, ["claude_code"]);
  } finally {
    dispose();
  }
  const withoutMarker = finalizeProviderStreamOptions(baseParams());
  assert.equal(withoutMarker.headers?.["x-test-marker"], undefined);
});

test("custom interceptor inserted after defaults and before the tail of the payload-debug-logging chain", () => {
  const dispose = usePayloadInterceptor({
    name: "test-order",
    intercept: (options) => options,
  });
  try {
    const names = listPayloadInterceptorNames();
    assert.equal(names[names.length - 1], "payload-debug-logging");
    assert.equal(names[names.length - 2], "test-order");
    assert.deepEqual(
      names.slice(0, EXPECTED_DEFAULT_ORDER.length - 1),
      EXPECTED_DEFAULT_ORDER.slice(0, -1),
    );
  } finally {
    dispose();
  }
  assert.deepEqual(listPayloadInterceptorNames(), EXPECTED_DEFAULT_ORDER);
});

test("chain-tail observation invariant: an onPayload transform appended by a custom interceptor is still seen by debug logging", async () => {
  const dispose = usePayloadInterceptor({
    name: "test-payload-mutator",
    intercept: (options) => ({
      ...options,
      onPayload: async (payload) => ({ ...payload, injected: true }),
    }),
  });
  const logged = [];
  try {
    const options = finalizeProviderStreamOptions(
      baseParams({
        debugLogger: { logRequest: (entry) => logged.push(entry) },
      }),
    );
    const result = await options.onPayload({ base: true }, { api: "anthropic-messages", provider: "anthropic" });
    assert.deepEqual(result, { base: true, injected: true });
    assert.equal(logged.length, 1);
    assert.deepEqual(logged[0].payload, { base: true, injected: true });
  } finally {
    dispose();
  }
});

test("dispose is idempotent: repeated calls do not affect other registrations", () => {
  const disposeA = usePayloadInterceptor({ name: "test-a", intercept: (o) => o });
  const disposeB = usePayloadInterceptor({ name: "test-b", intercept: (o) => o });
  disposeA();
  disposeA();
  const names = listPayloadInterceptorNames();
  assert.ok(!names.includes("test-a"));
  assert.ok(names.includes("test-b"));
  disposeB();
  assert.deepEqual(listPayloadInterceptorNames(), EXPECTED_DEFAULT_ORDER);
});

test("duplicate registration under the same name throws (including a name matching a default interceptor)", () => {
  const dispose = usePayloadInterceptor({ name: "test-dup", intercept: (o) => o });
  try {
    assert.throws(
      () => usePayloadInterceptor({ name: "test-dup", intercept: (o) => o }),
      /already registered: test-dup/,
    );
  } finally {
    dispose();
  }
  assert.throws(
    () => usePayloadInterceptor({ name: "anthropic-automatic-caching", intercept: (o) => o }),
    /already registered: anthropic-automatic-caching/,
  );
  assert.throws(() => usePayloadInterceptor({ name: "", intercept: (o) => o }), /non-empty name/);
  assert.throws(
    () => usePayloadInterceptor({ name: "test-no-fn" }),
    /requires an intercept function/,
  );
});

test("reversed load order: when a custom interceptor registers first and collides with a default name, installing the default chain throws and leaves no partial state", () => {
  // A standalone loader simulates the order "a plugin/test imports the service layer and registers a
  // custom interceptor first, and only then is payloadPipeline loaded" (llmService does not transitively
  // evaluate payloadPipeline; this order is reachable on the real module graph).
  const isolated = createTsModuleLoader();
  const api = isolated.loadModule("src/lib/providers/service/interceptors.ts");
  api.usePayloadInterceptor({
    name: "anthropic-automatic-caching",
    intercept: (o) => o,
  });
  assert.throws(
    () => isolated.loadModule("src/lib/providers/runtime/payloadPipeline.ts"),
    /already taken by a custom interceptor: anthropic-automatic-caching/,
  );
  // A failed install must leave no partial registration state: the chain has only the custom interceptor registered first.
  assert.deepEqual(api.listPayloadInterceptorNames(), ["anthropic-automatic-caching"]);
});

test("behavioral equivalence: with empty registrations, finalize output matches the old array composition field-for-field", async () => {
  // Rebuild the old composition chain as-is from the pre-registration finalizePayloadMiddlewares array
  // (same attach* implementations, same order), and compare output field-for-field on non-trivial parameters.
  const { attachAnthropicAutomaticCaching } = loader.loadModule(
    "src/lib/providers/runtime/anthropicCache.ts",
  );
  const { attachAnthropicLongContextBeta } = loader.loadModule(
    "src/lib/providers/runtime/anthropicLongContext.ts",
  );
  const { attachCodexResponsesStorage } = loader.loadModule(
    "src/lib/providers/runtime/codexStorage.ts",
  );
  const { attachCodexPromptCacheHint } = loader.loadModule(
    "src/lib/providers/runtime/codexPromptCache.ts",
  );
  const { attachProviderNativeWebSearch } = loader.loadModule(
    "src/lib/providers/runtime/nativeSearchPayload.ts",
  );
  const { attachXaiResponsesPayloadCompat } = loader.loadModule(
    "src/lib/providers/runtime/xaiResponsesPayload.ts",
  );
  const { attachDeepSeekResponsesPayloadCompat } = loader.loadModule(
    "src/lib/providers/runtime/deepSeekResponsesPayload.ts",
  );
  const attachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");
  const { attachGeminiThoughtSignatureGuard } = loader.loadModule(
    "src/lib/providers/runtime/geminiToolPayload.ts",
  );

  const legacyChain = composePayloadMiddlewares([
    (options, params) =>
      attachAnthropicAutomaticCaching(params.providerId, params.baseUrl, options),
    (options, params) =>
      attachAnthropicLongContextBeta(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
        model: params.model,
        context: params.context,
      }),
    (options, params) => attachCodexResponsesStorage(params.providerId, options),
    (options, params) =>
      attachCodexPromptCacheHint(
        params.providerId,
        params.baseUrl,
        params.promptCacheHintMode,
        params.model,
        options,
      ),
    (options, params) =>
      attachProviderNativeWebSearch(params.providerId, options, params.nativeWebSearch, {
        baseUrl: params.baseUrl,
      }),
    (options, params) =>
      attachXaiResponsesPayloadCompat(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
      }),
    (options, params) =>
      attachDeepSeekResponsesPayloadCompat(options, {
        providerId: params.providerId,
        model: params.model,
        context: params.context,
      }),
    (options, params) => {
      if (!params.context || !params.model) return options;
      let nextOptions = attachments.attachOpenAIResponsesNativeAttachments(options, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
      nextOptions = attachments.attachOpenAICompletionsNativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
      nextOptions = attachments.attachAnthropicMessagesNativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
      return attachments.attachGeminiGenerativeAINativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
    },
    (options, params) =>
      attachGeminiThoughtSignatureGuard(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
      }),
    (options, params) => attachPayloadDebugLogging(options, params.debugLogger, params.extra),
  ]);

  // Cover multiple parameter shapes: the anthropic cache path, the codex cache hint path, and the debug chain tail.
  const paramMatrix = [
    baseParams(),
    baseParams({ providerId: "claude_code", options: { headers: { "x-a": "1" } } }),
    baseParams({
      providerId: "codex",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      promptCacheHintMode: "auto",
    }),
    baseParams({ providerId: "gemini", baseUrl: "https://generativelanguage.googleapis.com" }),
  ];
  for (const params of paramMatrix) {
    const viaRegistry = finalizeProviderStreamOptions(params);
    const viaLegacy = legacyChain(params.options, params);
    // onPayload is a closure and cannot be deepEqual'd; first assert existence parity, then strip it and compare the remaining fields.
    assert.equal(
      typeof viaRegistry.onPayload,
      typeof viaLegacy.onPayload,
      `onPayload presence must match for ${params.providerId}`,
    );
    const { onPayload: _a, ...restRegistry } = viaRegistry;
    const { onPayload: _b, ...restLegacy } = viaLegacy;
    assert.deepEqual(restRegistry, restLegacy, `options must match for ${params.providerId}`);
  }
});
