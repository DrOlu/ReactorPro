import { prepareUpstreamProxyRequest } from "./providers/proxy";
import { isGatewayWebuiRuntime } from "./runtimeEnv";

// Network egress adapter layer for Hub (Skills / MCP store) browsing requests:
// - Desktop: always routed through the local reverse proxy and declares use-system-proxy; when the
//   app proxy is enabled it goes out through the proxy, when disabled the Rust side connects
//   directly, and a config error fails fast with 502 (download/install and SkillsManager's ClawHub
//   calls go through services/system_proxy on the Rust side, with the same semantics as here).
// - Gateway WebUI: runs in the browser, where the gateway has no /proxy route and the desktop app
//   proxy is unreachable, so it keeps a direct browser connection.
// The signature is intentionally narrower than typeof fetch: the desktop branch must rewrite the
// request address and cannot faithfully forward the method/headers/body carried by a Request
// object, so narrowing to string | URL lets the compiler reject that usage outright.
export async function hubFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (isGatewayWebuiRuntime()) {
    return fetch(input, init);
  }
  const prepared = await prepareUpstreamProxyRequest(
    typeof input === "string" ? input : input.toString(),
  );
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(prepared.headers)) {
    headers.set(name, value);
  }
  return fetch(prepared.url, { ...init, headers });
}
