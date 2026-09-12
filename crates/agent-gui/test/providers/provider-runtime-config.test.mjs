import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createProviderRuntimeConfig } = loader.loadModule(
  "src/lib/providers/runtime/providerRuntimeConfig.ts",
);
const settings = loader.loadModule("src/lib/settings/index.ts");

function createProvider(overrides = {}) {
  return {
    id: "provider-1",
    name: "Relay",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
    isFullUrl: true,
    apiKey: "test-key",
    customHeaders: [{ key: "X-Trace-Id", value: "abc" }],
    models: [],
    activeModels: [],
    promptCachingEnabled: true,
    promptCacheRetention: "long",
    useSystemProxy: true,
    ...overrides,
  };
}

// The factory is the only construction point for ProviderRuntimeConfig, so "the
// factory itself dropping a field" is the only remaining path that could reproduce the
// old bug. Here every field that must land on the runtime is locked down one by one.
test("createProviderRuntimeConfig carries every provider transport field", () => {
  const runtime = createProviderRuntimeConfig(
    createProvider(),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );

  assert.equal(runtime.baseUrl, "https://relay.example/v1");
  assert.equal(runtime.isFullUrl, true);
  assert.equal(runtime.apiKey, "test-key");
  // User custom headers pass through verbatim; the factory no longer injects any built-in identity headers.
  assert.deepEqual(runtime.customHeaders, [{ key: "X-Trace-Id", value: "abc" }]);
  assert.equal(runtime.promptCachingEnabled, true);
  assert.equal(runtime.promptCacheRetention, "long");
  assert.equal(runtime.useSystemProxy, true);
  assert.equal(runtime.nativeWebSearchEnabled, true);

  for (const field of [
    "baseUrl",
    "isFullUrl",
    "apiKey",
    "customHeaders",
    "requestFormat",
    "reasoning",
    "promptCachingEnabled",
    "promptCacheRetention",
    "nativeWebSearchEnabled",
    "useSystemProxy",
    "modelConfig",
  ]) {
    assert.ok(field in runtime, `${field} must be present on the runtime config`);
  }
});

test("createProviderRuntimeConfig gates reasoning on model support", () => {
  const thinkingOff = createProviderRuntimeConfig(
    createProvider(),
    "claude-sonnet-4-6",
    {
      ...settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
      thinkingEnabled: false,
    },
  );
  assert.equal(thinkingOff.reasoning, "off");

  // Models that do not support thinking always get undefined, never an invalid level
  // sent downstream (Cron / memory maintenance used to bypass the factory and hand-roll
  // the runtime, and that is exactly where this was hit).
  const unsupported = createProviderRuntimeConfig(
    createProvider({ type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }),
    "gemini-embedding-001",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  assert.equal(unsupported.reasoning, undefined);
});
