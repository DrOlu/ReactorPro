import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Regression net: custom request headers were once dropped entirely on all four
// chains (Agent chat / text chat / auto title / Compaction) because the runtime object
// was copied field by field. Here every real provider request entry point is exercised,
// asserting that customHeaders and promptCacheRetention reach both the upstream header
// set and the override package.

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const powerActivityModulePath = path.join(rootDir, "src/lib/system/powerActivity.ts");

const PROXY_SERVER_INFO = { baseUrl: "http://127.0.0.1:18080", token: "proxy-token" };

const CUSTOM_HEADERS = [
  { key: "X-Trace-Id", value: "liveagent-e2e" },
  // Overrides a built-in default header, with different casing from the built-in key -- must replace, not coexist.
  { key: "user-agent", value: "my-agent/9.9" },
  // A browser-forbidden header name: it can only reach upstream via the override package.
  { key: "Cookie", value: "session=abc" },
  // Reserved header: always dropped.
  { key: "Authorization", value: "Bearer hijacked" },
  { key: "anthropic-beta", value: "hijacked" },
  { key: "x-liveagent-proxy-token", value: "hijacked" },
];

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistantStream() {
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: createUsage(),
    stopReason: "stop",
    timestamp: 1,
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "text_delta", contentIndex: 0, delta: "ok" };
    },
    async result() {
      return assistant;
    },
  };
}

/**
 * Goes through the real prepareProviderRequest + prepareProxyRequest (mocking only the
 * two platform boundaries: tauri invoke and power activity), so the assertions cover
 * the entire assembly chain.
 */
function loadProvidersWithCapturedStream() {
  const captured = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          if (command === "proxy_get_server_info") return PROXY_SERVER_INFO;
          throw new Error(`unexpected tauri invoke: ${command}`);
        },
      },
      "@earendil-works/pi-ai/api/anthropic-messages": {
        stream(model, context, options) {
          captured.push({ model, context, options });
          return createAssistantStream();
        },
      },
      [powerActivityModulePath]: {
        async withPowerActivity(_scope, _reason, run) {
          return run();
        },
      },
    },
  });
  return { providers: loader.loadModule("src/lib/providers/llm.ts"), captured };
}

function buildRuntime() {
  return {
    baseUrl: "https://relay.example/v1",
    apiKey: "test-key",
    customHeaders: CUSTOM_HEADERS,
    promptCachingEnabled: true,
    promptCacheRetention: "long",
  };
}

function readHeader(headers, name) {
  const matches = Object.keys(headers).filter((key) => key.toLowerCase() === name.toLowerCase());
  assert.ok(matches.length <= 1, `${name} must not appear twice (found ${matches.join(", ")})`);
  return matches.length === 1 ? headers[matches[0]] : undefined;
}

function decodeOverrides(headers) {
  const encoded = readHeader(headers, "x-liveagent-upstream-headers");
  assert.ok(encoded, "the upstream override package must be present");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

function assertCustomHeadersReachedUpstream(options) {
  const headers = options.headers ?? {};

  // 1) An ordinary custom header reaches the request header set.
  assert.equal(readHeader(headers, "x-trace-id"), "liveagent-e2e");
  // 2) A custom UA arrives verbatim as an ordinary custom header, never duplicated and never overridden by another header.
  assert.equal(readHeader(headers, "user-agent"), "my-agent/9.9");
  // 3) A browser-forbidden header name also enters the header set, with the override package responsible for actual delivery.
  assert.equal(readHeader(headers, "cookie"), "session=abc");
  // 4) Reserved headers cannot be hijacked by custom headers.
  assert.equal(readHeader(headers, "authorization"), undefined);
  assert.equal(readHeader(headers, "x-api-key"), "test-key");
  // anthropic-beta is owned exclusively by the long-context middleware: the hijack
  // attempt is stopped by the reserved-header policy, and the beta string computed by
  // the middleware must remain intact (the override package is built before it, does
  // not contain this header, and therefore will not clobber it afterwards).
  assert.equal(readHeader(headers, "anthropic-beta"), "context-1m-2025-08-07");
  assert.equal(readHeader(headers, "x-liveagent-proxy-token"), PROXY_SERVER_INFO.token);

  // 5) The override package carries all non-auth headers, overwritten as the last step by the Rust reverse proxy before forwarding.
  const overrides = decodeOverrides(headers);
  assert.equal(overrides["X-Trace-Id"], "liveagent-e2e");
  assert.equal(overrides["user-agent"], "my-agent/9.9");
  assert.equal(overrides.Cookie, "session=abc");
  for (const excluded of ["authorization", "x-api-key", "x-goog-api-key"]) {
    assert.ok(
      !Object.keys(overrides).some((key) => key.toLowerCase() === excluded),
      `${excluded} must not be duplicated into the override package`,
    );
  }
  assert.ok(
    !Object.keys(overrides).some((key) => key.toLowerCase().startsWith("x-liveagent-")),
    "the proxy's own control headers must never be echoed into the override package",
  );
  assert.ok(
    !Object.keys(overrides).some((key) => key.toLowerCase() === "anthropic-beta"),
    "anthropic-beta must stay owned by attachAnthropicLongContextBeta",
  );

  // 6) promptCacheRetention failed together with customHeaders across all four chains, so both are locked down.
  assert.equal(options.cacheRetention, "long");
}

test("streamAssistantMessage sends provider custom headers and cache retention", async () => {
  const { providers, captured } = loadProvidersWithCapturedStream();

  await providers.streamAssistantMessage({
    providerId: "claude_code",
    model: "claude-sonnet-4-6",
    runtime: buildRuntime(),
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    onTextDelta() {},
  });

  assert.equal(captured.length, 1);
  assertCustomHeadersReachedUpstream(captured[0].options);
});

test("completeAssistantMessage sends provider custom headers (compaction summarizer path)", async () => {
  const { providers, captured } = loadProvidersWithCapturedStream();

  await providers.completeAssistantMessage({
    providerId: "claude_code",
    model: "claude-sonnet-4-6",
    runtime: buildRuntime(),
    context: { messages: [{ role: "user", content: "summarize", timestamp: 1 }] },
  });

  assert.equal(captured.length, 1);
  const { options } = captured[0];
  const headers = options.headers ?? {};
  assert.equal(readHeader(headers, "x-trace-id"), "liveagent-e2e");
  assert.equal(readHeader(headers, "user-agent"), "my-agent/9.9");
  assert.equal(decodeOverrides(headers).Cookie, "session=abc");
});

test("compaction summarizer forwards the whole runtime config untouched", async () => {
  // The summarizer only changes the reasoning level (derived expansion); all other
  // fields must pass through verbatim -- the old field-by-field copy was exactly what
  // wiped out customHeaders at this layer.
  const loader = createTsModuleLoader();
  const { summarizeConversation } = loader.loadModule("src/lib/chat/compaction/summarizer.ts");
  const runtime = buildRuntime();
  const seen = [];

  await summarizeConversation({
    providerId: "codex",
    model: "gpt-5",
    runtime,
    payload: {
      active_segment_messages: [{ role: "user", content: "hello" }],
      compaction_reason: { omitted_message_count: 0 },
    },
    async complete(params) {
      seen.push(params.runtime);
      return {
        role: "assistant",
        content: [{ type: "text", text: SUMMARY_TEXT }],
        api: "liveagent-compaction",
        provider: "codex",
        model: "gpt-5",
        usage: createUsage(),
        stopReason: "stop",
        timestamp: 1,
      };
    },
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].customHeaders, CUSTOM_HEADERS);
  assert.equal(seen[0].promptCacheRetention, "long");
  // The Codex summary always uses the medium level; the other fields come from the original runtime.
  assert.equal(seen[0].reasoning, "medium");
});

const SUMMARY_TEXT = `<summary>
<task>Verify that custom request headers survive the compaction path</task>
<state>Runtime config is forwarded whole to the summarizer request ${"x".repeat(300)}</state>
<artifacts>
- [file] src/lib/chat/compaction/summarizer.ts | reviewed | forwards runtime untouched
</artifacts>
<next_steps>
1. keep the runtime object intact across every provider entry point
</next_steps>
</summary>`;
