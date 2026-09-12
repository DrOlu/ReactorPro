import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Hub (Skills/MCP store) network-egress adapter contract: the desktop side
// rewrites the full upstream URL into a local proxy request and always carries
// the use-system-proxy header so Rust egresses according to the app proxy config.
const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      async invoke(command) {
        if (command === "proxy_get_server_info") {
          return { baseUrl: "http://127.0.0.1:43110/", token: "test-proxy-token" };
        }
        throw new Error(`unexpected invoke: ${command}`);
      },
    },
  },
});

const proxy = loader.loadModule("@liveagent/ui/lib/providers/proxy.ts");
const hubFetchModule = loader.loadModule("@liveagent/ui/lib/hubFetch.ts");

test("prepareUpstreamProxyRequest preserves path and query string and carries the three proxy headers", async () => {
  const prepared = await proxy.prepareUpstreamProxyRequest(
    "https://clawhub.ai/api/v1/skills?limit=24&sort=downloads",
  );

  assert.equal(prepared.url, "http://127.0.0.1:43110/proxy/hub/api/v1/skills?limit=24&sort=downloads");
  assert.equal(prepared.headers["x-liveagent-upstream-origin"], "https://clawhub.ai");
  assert.equal(prepared.headers["x-liveagent-proxy-token"], "test-proxy-token");
  assert.equal(prepared.headers["x-liveagent-use-system-proxy"], "1");
});

test("prepareUpstreamProxyRequest rejects relative addresses, non-http(s), and embedded credentials", async () => {
  await assert.rejects(() => proxy.prepareUpstreamProxyRequest("/api/v1/skills"), /absolute URL/);
  await assert.rejects(
    () => proxy.prepareUpstreamProxyRequest("ftp://clawhub.ai/api"),
    /http:\/\/ or https:\/\//,
  );
  await assert.rejects(
    () => proxy.prepareUpstreamProxyRequest("https://user:pass@clawhub.ai/api"),
    /username or password/,
  );
});

test("prepareUpstreamProxyRequest rejects paths beginning with // (guards against Url::join rewriting the upstream host)", async () => {
  await assert.rejects(
    () => proxy.prepareUpstreamProxyRequest("https://api.smithery.ai//servers/foo"),
    /must not begin with \/\//,
  );
});

test("prepareUpstreamProxyRequest maps the root path to a no-trailing-slash form", async () => {
  const bare = await proxy.prepareUpstreamProxyRequest("https://clawhub.ai");
  assert.equal(bare.url, "http://127.0.0.1:43110/proxy/hub");

  const withQuery = await proxy.prepareUpstreamProxyRequest("https://clawhub.ai/?probe=1");
  assert.equal(withQuery.url, "http://127.0.0.1:43110/proxy/hub?probe=1");
});

test("hubFetch on desktop rewrites the request URL and merges caller headers", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200 };
  };
  try {
    await hubFetchModule.hubFetch("https://registry.modelcontextprotocol.io/v0.1/servers?limit=18", {
      headers: { Accept: "application/json" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:43110/proxy/hub/v0.1/servers?limit=18",
  );
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(
    headers.get("x-liveagent-upstream-origin"),
    "https://registry.modelcontextprotocol.io",
  );
  assert.equal(headers.get("x-liveagent-proxy-token"), "test-proxy-token");
  assert.equal(headers.get("x-liveagent-use-system-proxy"), "1");
});

test("hubFetch on desktop passes through init's method/body/signal", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200 };
  };
  try {
    await hubFetchModule.hubFetch("https://clawhub.ai/api/v1/search", {
      method: "POST",
      body: '{"q":"git"}',
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, '{"q":"git"}');
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(new Headers(calls[0].init.headers).get("content-type"), "application/json");
});

test("hubFetch connects directly when running in the Gateway WebUI, without rewriting the URL or adding proxy headers", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200 };
  };
  // Simulate the runtime marker that web main.tsx writes before rendering.
  globalThis.document = { documentElement: { dataset: { liveagentWebui: "gateway" } } };
  try {
    await hubFetchModule.hubFetch("https://clawhub.ai/api/v1/skills?limit=24", {
      headers: { Accept: "application/json" },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://clawhub.ai/api/v1/skills?limit=24");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("x-liveagent-upstream-origin"), null);
  assert.equal(headers.get("x-liveagent-use-system-proxy"), null);
});
