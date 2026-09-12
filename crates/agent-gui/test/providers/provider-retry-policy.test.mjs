import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * PR-2 provider-level retry policy (feat-llm-retry-policy) unit tests:
 *
 * 1. normalizeProviderRetryPolicy normalization matrix -- illegal/default inputs all fall to
 *    default (no field written), custom's maxRetries (excluding the first request) is clamped to
 *    1..10, and legacy config migrates with zero changes;
 * 2. createProviderRuntimeConfig, the sole construction point, passes retryPolicy through;
 * 3. resolveStreamRetryConfig's consumer-side merge semantics for the three modes -- default
 *    carries no maxAttempts/disabled (equivalent to the global default behavior before the
 *    change), while custom converts the user-facing retry count into withStreamRetry's total
 *    attempt count (+1);
 * 4. failover's per-candidate policy is independent: each candidate resolves a different
 *    streamRetry config from its own runtime;
 * 5. The UI display mirror constant matches the runtime source of truth in streamRetry.ts
 *    (retry count = total attempts - 1).
 */

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const { normalizeProviderRetryPolicy, normalizeCustomProvider } = settings;
const { createProviderRuntimeConfig } = loader.loadModule(
  "src/lib/providers/runtime/providerRuntimeConfig.ts",
);
const { resolveStreamRetryConfig } = loader.loadModule("src/lib/providers/runtime/retryPolicy.ts");
const { DEFAULT_STREAM_RETRY_MAX_ATTEMPTS } = loader.loadModule(
  "src/lib/providers/runtime/streamRetry.ts",
);

// ---------------------------------------------------------------------------
// 1. Normalization matrix
// ---------------------------------------------------------------------------

test("normalizeProviderRetryPolicy: default/illegal inputs always return undefined (no field written)", () => {
  for (const input of [
    undefined,
    null,
    {},
    "off",
    42,
    { mode: "default" },
    { mode: "always" },
    { mode: "custom" },
    { mode: "custom", maxRetries: "3" },
    { mode: "custom", maxRetries: Number.NaN },
    { mode: "custom", maxRetries: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(
      normalizeProviderRetryPolicy(input),
      undefined,
      `input ${JSON.stringify(input)} must normalize to undefined`,
    );
  }
});

test("normalizeProviderRetryPolicy: valid shapes of off and custom", () => {
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "off" }), { mode: "off" });
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "off", maxRetries: 5 }), { mode: "off" });
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "custom", maxRetries: 3 }), {
    mode: "custom",
    maxRetries: 3,
  });
});

test("normalizeProviderRetryPolicy: custom maxRetries is clamped to 1..10 and rounded", () => {
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "custom", maxRetries: 0 }), {
    mode: "custom",
    maxRetries: 1,
  });
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "custom", maxRetries: -5 }), {
    mode: "custom",
    maxRetries: 1,
  });
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "custom", maxRetries: 99 }), {
    mode: "custom",
    maxRetries: 10,
  });
  assert.deepEqual(normalizeProviderRetryPolicy({ mode: "custom", maxRetries: 2.6 }), {
    mode: "custom",
    maxRetries: 3,
  });
});

test("normalizeCustomProvider: legacy config (no retryPolicy) migrates with zero changes -- the normalized result has no such field", () => {
  const provider = normalizeCustomProvider({
    id: "legacy-1",
    name: "Legacy",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
    apiKey: "k",
    models: [],
    activeModels: [],
  });
  assert.ok(!("retryPolicy" in provider), "legacy provider must not gain a retryPolicy field");
});

test("normalizeCustomProvider: retryPolicy is preserved as-is when configured", () => {
  const provider = normalizeCustomProvider({
    id: "p-1",
    name: "P",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
    apiKey: "k",
    models: [],
    activeModels: [],
    retryPolicy: { mode: "custom", maxRetries: 2 },
  });
  assert.deepEqual(provider.retryPolicy, { mode: "custom", maxRetries: 2 });

  const offProvider = normalizeCustomProvider({
    id: "p-2",
    name: "P2",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
    apiKey: "k",
    models: [],
    activeModels: [],
    retryPolicy: { mode: "off" },
  });
  assert.deepEqual(offProvider.retryPolicy, { mode: "off" });
});

// ---------------------------------------------------------------------------
// 2. Passthrough at the sole construction point
// ---------------------------------------------------------------------------

function createProvider(overrides = {}) {
  return {
    id: "provider-1",
    name: "Relay",
    type: "claude_code",
    baseUrl: "https://relay.example/v1",
    isFullUrl: true,
    apiKey: "test-key",
    models: [],
    activeModels: [],
    promptCachingEnabled: true,
    useSystemProxy: false,
    ...overrides,
  };
}

test("createProviderRuntimeConfig: retryPolicy passes through the sole construction point", () => {
  const runtime = createProviderRuntimeConfig(
    createProvider({ retryPolicy: { mode: "custom", maxRetries: 2 } }),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  assert.deepEqual(runtime.retryPolicy, { mode: "custom", maxRetries: 2 });
});

test("createProviderRuntimeConfig: runtime has no such field when retryPolicy is unset", () => {
  const runtime = createProviderRuntimeConfig(
    createProvider(),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  assert.ok(!("retryPolicy" in runtime), "unset policy must not appear on the runtime config");
});

// ---------------------------------------------------------------------------
// 3. Consumer-side merge semantics
// ---------------------------------------------------------------------------

test("resolveStreamRetryConfig: default returns an empty object -- withStreamRetry falls to the global default", () => {
  assert.deepEqual(resolveStreamRetryConfig(undefined), {});
});

test("resolveStreamRetryConfig: off returns disabled:true", () => {
  assert.deepEqual(resolveStreamRetryConfig({ mode: "off" }), { disabled: true });
});

test("resolveStreamRetryConfig: custom converts the retry count into total attempts (maxRetries+1)", () => {
  assert.deepEqual(resolveStreamRetryConfig({ mode: "custom", maxRetries: 2 }), {
    maxAttempts: 3,
  });
  assert.deepEqual(resolveStreamRetryConfig({ mode: "custom", maxRetries: 1 }), {
    maxAttempts: 2,
  });
});

test("resolveStreamRetryConfig: spread-merged with consumer callbacks, neither overwrites the other", () => {
  const onRetry = () => {};
  const onRetryRecovered = () => {};
  const merged = {
    ...resolveStreamRetryConfig({ mode: "custom", maxRetries: 4 }),
    onRetry,
    onRetryRecovered,
  };
  assert.equal(merged.maxAttempts, 5);
  assert.equal(merged.onRetry, onRetry);
  assert.equal(merged.onRetryRecovered, onRetryRecovered);
  assert.ok(!("disabled" in merged));

  const mergedDefault = { ...resolveStreamRetryConfig(undefined), onRetry, onRetryRecovered };
  assert.deepEqual(Object.keys(mergedDefault).sort(), ["onRetry", "onRetryRecovered"]);
});

// ---------------------------------------------------------------------------
// 4. failover's per-candidate policy is independent
// ---------------------------------------------------------------------------

test("failover candidates resolve independent retry configs from their own runtimes", () => {
  const primary = createProviderRuntimeConfig(
    createProvider({ id: "primary", retryPolicy: { mode: "custom", maxRetries: 2 } }),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  const fallbackOff = createProviderRuntimeConfig(
    createProvider({ id: "fallback-off", retryPolicy: { mode: "off" } }),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );
  const fallbackDefault = createProviderRuntimeConfig(
    createProvider({ id: "fallback-default" }),
    "claude-sonnet-4-6",
    settings.DEFAULT_CHAT_RUNTIME_CONTROLS,
  );

  assert.deepEqual(resolveStreamRetryConfig(primary.retryPolicy), { maxAttempts: 3 });
  assert.deepEqual(resolveStreamRetryConfig(fallbackOff.retryPolicy), { disabled: true });
  assert.deepEqual(resolveStreamRetryConfig(fallbackDefault.retryPolicy), {});
});

// ---------------------------------------------------------------------------
// 5. The UI display mirror constant matches the runtime source of truth
// ---------------------------------------------------------------------------

test("PROVIDER_RETRY_DEFAULT_MAX_RETRIES matches DEFAULT_STREAM_RETRY_MAX_ATTEMPTS-1", () => {
  assert.equal(settings.PROVIDER_RETRY_DEFAULT_MAX_RETRIES, DEFAULT_STREAM_RETRY_MAX_ATTEMPTS - 1);
});
