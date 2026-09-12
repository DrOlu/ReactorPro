import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// LLM seam rework (golden baseline #2): whole-transport-assembly snapshot.
//
// custom-headers-propagation.test.mjs asserts that "custom headers arrive"; this
// file locks down prepareProviderRequest's full output field by field (proxy URL
// + full header set + decoded base64 override payload) and locks down per-
// candidate transport-config independence under failover — provider-level
// useSystemProxy is the vehicle for the axiom that "network reachability belongs
// to each target", and the seam rework must never leak the primary's transport
// facts to the fallback.
// ============================================================================

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

const piAiEventStream = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
    import.meta.url,
  ).href
);

const PROXY_SERVER_INFO = { baseUrl: "http://127.0.0.1:18080", token: "proxy-token" };
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function decodeOverrides(headers) {
  const encoded = headers["x-liveagent-upstream-headers"];
  if (encoded === undefined) return undefined;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

/** The override payload is asserted by decoding it separately; other headers are asserted field by field. */
function splitPrepared(prepared) {
  const { "x-liveagent-upstream-headers": _encoded, ...headers } = prepared.headers;
  return { baseUrl: prepared.baseUrl, headers, overrides: decodeOverrides(prepared.headers) };
}

// ---------------------------------------------------------------------------
// Part one: prepareProviderRequest full output snapshot (real implementation, only tauri invoke mocked)
// ---------------------------------------------------------------------------

const transportLoader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      async invoke(command) {
        if (command === "proxy_get_server_info") return PROXY_SERVER_INFO;
        throw new Error(`unexpected tauri invoke: ${command}`);
      },
    },
  },
});
const { prepareProviderRequest } = transportLoader.loadModule(
  "src/lib/providers/runtime/requestOptions.ts",
);
const { ANTHROPIC_DEFAULT_REQUEST_HEADERS } = transportLoader.loadModule(
  "@liveagent/ui/lib/providers/customHeaders.ts",
);

test("golden/transport: anthropic full header set (built-in default headers + custom headers + override payload + use-system-proxy)", async () => {
  const prepared = await prepareProviderRequest(
    "claude_code",
    {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test",
      customHeaders: [
        { key: "X-Relay-Channel", value: "vip" },
        // Browser-forbidden header name: it is dropped by the WebView on the
        // regular channel and can only arrive via the override payload.
        { key: "Cookie", value: "session=abc" },
      ],
      useSystemProxy: true,
    },
    { sessionId: SESSION_ID },
  );
  const { baseUrl, headers, overrides } = splitPrepared(prepared);

  assert.equal(baseUrl, "http://127.0.0.1:18080/proxy/claude_code/v1");
  assert.deepEqual(headers, {
    "x-api-key": "sk-ant-test",
    ...ANTHROPIC_DEFAULT_REQUEST_HEADERS,
    "X-Claude-Code-Session-Id": SESSION_ID,
    "X-Relay-Channel": "vip",
    Cookie: "session=abc",
    "x-liveagent-upstream-origin": "https://api.anthropic.com",
    "x-liveagent-proxy-token": "proxy-token",
    "x-liveagent-use-system-proxy": "1",
  });
  // Override payload = built-in default headers + custom headers; the auth header
  // (x-api-key) is in the exclusion set and never enters the payload.
  assert.deepEqual(overrides, {
    ...ANTHROPIC_DEFAULT_REQUEST_HEADERS,
    "X-Claude-Code-Session-Id": SESSION_ID,
    "X-Relay-Channel": "vip",
    Cookie: "session=abc",
  });
});

test("golden/transport: codex Responses chain carries session/conversation headers; no use-system-proxy on direct connections", async () => {
  const prepared = await prepareProviderRequest(
    "codex",
    { baseUrl: "https://chatgpt.com/backend-api/codex", apiKey: "sk-codex-test" },
    { sessionId: SESSION_ID },
  );
  const { baseUrl, headers, overrides } = splitPrepared(prepared);

  assert.equal(baseUrl, "http://127.0.0.1:18080/proxy/codex/backend-api/codex");
  assert.deepEqual(headers, {
    Authorization: "Bearer sk-codex-test",
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    "session-id": SESSION_ID,
    "thread-id": SESSION_ID,
    "x-client-request-id": SESSION_ID,
    "x-liveagent-upstream-origin": "https://chatgpt.com",
    "x-liveagent-proxy-token": "proxy-token",
  });
  assert.deepEqual(overrides, {
    session_id: SESSION_ID,
    conversation_id: SESSION_ID,
    "session-id": SESSION_ID,
    "thread-id": SESSION_ID,
    "x-client-request-id": SESSION_ID,
  });
});

test("golden/transport: codex Completions format never leaks session/conversation headers", async () => {
  const prepared = await prepareProviderRequest(
    "codex",
    {
      baseUrl: "https://relay.example.com/v1",
      apiKey: "sk-relay-test",
      requestFormat: "openai-completions",
    },
    { sessionId: SESSION_ID },
  );
  const { baseUrl, headers, overrides } = splitPrepared(prepared);

  assert.equal(baseUrl, "http://127.0.0.1:18080/proxy/codex/v1");
  // The stateless protocol uses Bearer only; the header set contains no entry requiring the override payload.
  assert.deepEqual(headers, {
    Authorization: "Bearer sk-relay-test",
    "x-liveagent-upstream-origin": "https://relay.example.com",
    "x-liveagent-proxy-token": "proxy-token",
  });
  assert.equal(overrides, undefined);
});

test("golden/transport: gemini authenticates with the single x-goog-api-key header", async () => {
  const prepared = await prepareProviderRequest(
    "gemini",
    { baseUrl: "https://generativelanguage.googleapis.com", apiKey: "g-test-key" },
    { sessionId: SESSION_ID },
  );
  const { baseUrl, headers, overrides } = splitPrepared(prepared);

  assert.equal(baseUrl, "http://127.0.0.1:18080/proxy/gemini");
  assert.deepEqual(headers, {
    "x-goog-api-key": "g-test-key",
    "x-liveagent-upstream-origin": "https://generativelanguage.googleapis.com",
    "x-liveagent-proxy-token": "proxy-token",
  });
  assert.equal(overrides, undefined);
});

test("golden/transport: deepseek full URL mode preserves the complete upstream URL (including query parameters)", async () => {
  const prepared = await prepareProviderRequest(
    "deepseek",
    {
      baseUrl: "https://relay.example.com/openai/v1/responses?alt=x",
      apiKey: "sk-ds-test",
      isFullUrl: true,
    },
    { sessionId: SESSION_ID },
  );
  const { baseUrl, headers, overrides } = splitPrepared(prepared);

  assert.equal(baseUrl, "http://127.0.0.1:18080/proxy/deepseek");
  assert.deepEqual(headers, {
    Authorization: "Bearer sk-ds-test",
    "x-liveagent-upstream-origin": "https://relay.example.com",
    "x-liveagent-upstream-url": "https://relay.example.com/openai/v1/responses?alt=x",
    "x-liveagent-proxy-token": "proxy-token",
  });
  assert.equal(overrides, undefined);
});

// ---------------------------------------------------------------------------
// Part two: per-candidate transport-config independence under failover.
// The scenario comes from the network-topology user story: the primary is an
// overseas provider going through the app proxy, and the fallback is a domestic
// relay connected directly. Assert that the two targets assemble independently
// (their use-system-proxy headers do not leak into each other) and that after
// the primary fails uncommitted, the fallback takes over with its own transport
// config.
// ---------------------------------------------------------------------------

/** Captures every call issued through streamSimpleByApi (model + options.headers). */
const streamCalls = [];
let streamImpl = () => {
  throw new Error("streamImpl was not configured");
};

const failoverLoader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      async invoke(command) {
        if (command === "proxy_get_server_info") return PROXY_SERVER_INFO;
        throw new Error(`unexpected tauri invoke: ${command}`);
      },
    },
    [abs("src/lib/providers/runtime/streamByApi.ts")]: {
      streamSimpleByApi: (model, context, options) => {
        streamCalls.push({ model, options });
        return streamImpl(model, context, options);
      },
    },
    [abs("src/lib/system/powerActivity.ts")]: {
      withPowerActivity: (_scope, _reason, run) => run(),
    },
    [abs("src/lib/debug/agentDebug.ts")]: {
      buildStreamRequestDebugPayload: () => ({}),
    },
    [abs("src/lib/providers/hostedSearchEvents.ts")]: {
      createHostedSearchProbeId: () => undefined,
      withHostedSearchProbeHeader: (headers) => headers ?? {},
      startHostedSearchFetchProbe: () => ({ finish: async () => {} }),
      createHostedSearchEventAggregator: () => ({
        accept: () => {},
        complete: () => [],
        fail: () => {},
        dispose: () => {},
        getBlocks: () => [],
      }),
    },
  },
});

const { streamAssistantMessage } = failoverLoader.loadModule(
  "src/lib/providers/runtime/textOnlyRuntime.ts",
);
const { resetFailoverBreakers } = failoverLoader.loadModule(
  "src/lib/providers/runtime/providerFailover.ts",
);

function makeAssistantMessage(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "claude_code",
    model: "claude-x",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function makeSourceStream(events) {
  const stream = piAiEventStream.createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  return stream;
}

function successStream(text) {
  const message = { ...makeAssistantMessage(), content: [{ type: "text", text }] };
  return makeSourceStream([
    { type: "start", partial: message },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "done", reason: "stop", message },
  ]);
}

function uncommittedErrorStream(errorMessage) {
  const message = { ...makeAssistantMessage(), stopReason: "error", errorMessage };
  return makeSourceStream([
    { type: "start", partial: message },
    { type: "error", reason: "error", error: message },
  ]);
}

test.beforeEach(() => {
  resetFailoverBreakers();
  streamCalls.length = 0;
});

test("golden/transport-failover: primary proxied + fallback direct, per-candidate transport configs do not leak", async () => {
  // Primary: overseas provider, with the app proxy enabled.
  const primaryRuntime = {
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-primary",
    promptCachingEnabled: false,
    useSystemProxy: true,
  };
  // Fallback: domestic relay, direct (no useSystemProxy).
  const fallbackRuntime = {
    baseUrl: "https://relay.cn.example/v1",
    apiKey: "sk-fallback",
    promptCachingEnabled: false,
  };

  streamImpl = (_model, _context, options) =>
    options.headers["x-liveagent-use-system-proxy"] === "1"
      ? uncommittedErrorStream("502 upstream proxy unavailable")
      : successStream("fallback-answer");

  const final = await streamAssistantMessage({
    providerId: "claude_code",
    model: "claude-x",
    runtime: primaryRuntime,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    sessionId: SESSION_ID,
    onTextDelta: () => {},
    failover: {
      config: { maxSwitches: 3, failureThreshold: 3, cooldownSeconds: 60 },
      primary: {
        selectedModel: { customProviderId: "p-abroad", model: "claude-x" },
        label: "Overseas official · claude-x",
      },
      fallbacks: [
        {
          selectedModel: { customProviderId: "p-cn-relay", model: "claude-x" },
          providerId: "claude_code",
          model: "claude-x",
          label: "Domestic relay · claude-x",
          runtime: fallbackRuntime,
        },
      ],
    },
  });

  assert.equal(final.content[0].text, "fallback-answer");
  assert.equal(streamCalls.length, 2);

  // Candidate 1 (primary): real prepareProviderRequest output, with use-system-proxy.
  const primaryCall = streamCalls[0];
  assert.equal(primaryCall.model.baseUrl, "http://127.0.0.1:18080/proxy/claude_code/v1");
  assert.equal(primaryCall.options.headers["x-liveagent-use-system-proxy"], "1");
  assert.equal(primaryCall.options.headers["x-api-key"], "sk-primary");
  assert.equal(
    primaryCall.options.headers["x-liveagent-upstream-origin"],
    "https://api.anthropic.com",
  );

  // Candidate 2 (fallback): assembled independently, never inheriting the primary's use-system-proxy or credentials.
  const fallbackCall = streamCalls[1];
  assert.equal(fallbackCall.model.baseUrl, "http://127.0.0.1:18080/proxy/claude_code/v1");
  assert.equal(fallbackCall.options.headers["x-liveagent-use-system-proxy"], undefined);
  assert.equal(fallbackCall.options.headers["x-api-key"], "sk-fallback");
  assert.equal(
    fallbackCall.options.headers["x-liveagent-upstream-origin"],
    "https://relay.cn.example",
  );
});

test("golden/transport-failover: reverse topology (primary direct + fallback proxied) is likewise per-candidate independent", async () => {
  const primaryRuntime = {
    baseUrl: "https://relay.cn.example/v1",
    apiKey: "sk-primary-direct",
    promptCachingEnabled: false,
  };
  const fallbackRuntime = {
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-fallback-proxied",
    promptCachingEnabled: false,
    useSystemProxy: true,
  };

  streamImpl = (_model, _context, options) =>
    options.headers["x-liveagent-use-system-proxy"] === "1"
      ? successStream("proxied-answer")
      : uncommittedErrorStream("503 relay unavailable");

  const final = await streamAssistantMessage({
    providerId: "claude_code",
    model: "claude-x",
    runtime: primaryRuntime,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    sessionId: SESSION_ID,
    onTextDelta: () => {},
    failover: {
      config: { maxSwitches: 3, failureThreshold: 3, cooldownSeconds: 60 },
      primary: {
        selectedModel: { customProviderId: "p-cn-relay", model: "claude-x" },
        label: "Domestic relay · claude-x",
      },
      fallbacks: [
        {
          selectedModel: { customProviderId: "p-abroad", model: "claude-x" },
          providerId: "claude_code",
          model: "claude-x",
          label: "Overseas official · claude-x",
          runtime: fallbackRuntime,
        },
      ],
    },
  });

  assert.equal(final.content[0].text, "proxied-answer");
  assert.equal(streamCalls.length, 2);
  assert.equal(streamCalls[0].options.headers["x-liveagent-use-system-proxy"], undefined);
  assert.equal(streamCalls[0].options.headers["x-api-key"], "sk-primary-direct");
  assert.equal(streamCalls[1].options.headers["x-liveagent-use-system-proxy"], "1");
  assert.equal(streamCalls[1].options.headers["x-api-key"], "sk-fallback-proxied");
});
