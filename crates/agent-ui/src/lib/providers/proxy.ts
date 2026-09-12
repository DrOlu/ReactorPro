import type { ProviderId } from "@liveagent/app/lib/settings";
import { invoke } from "@liveagent/app/shims/tauriCore";

export const LIVEAGENT_PROXY_TOKEN_HEADER = "x-liveagent-proxy-token";
export const LIVEAGENT_UPSTREAM_ORIGIN_HEADER = "x-liveagent-upstream-origin";
// In full-URL mode, carries the final upstream address. The local reverse proxy
// ignores the path the SDK appends automatically, but still preserves the query
// parameters the SDK request needs (e.g. Gemini's alt=sse).
export const LIVEAGENT_UPSTREAM_URL_HEADER = "x-liveagent-upstream-url";
// Upstream header override package: base64(utf8(JSON)). The WebView's fetch
// silently drops forbidden header names such as User-Agent / Cookie / Referer, and
// the SDK may inject headers with the same names, so the final header set is sent
// through this one channel and the local reverse proxy applies it to the upstream
// request as the last step before forwarding -- that is the single decision point
// for "custom headers override built-in defaults".
export const LIVEAGENT_UPSTREAM_HEADERS_HEADER = "x-liveagent-upstream-headers";
// Boolean flag header: declares that this request egresses through the system
// proxy. The proxy address/credentials live only on the desktop Rust side, and the
// local reverse proxy picks the proxied client based on this header (x-liveagent-*
// headers are not forwarded upstream).
export const LIVEAGENT_USE_SYSTEM_PROXY_HEADER = "x-liveagent-use-system-proxy";

// Auth headers do not go into the override package: they are not browser-forbidden
// names (so the normal channel always delivers them) and are reserved headers the
// user cannot change, so there is no override need -- no reason to copy the secret
// into a side channel again.
const UPSTREAM_HEADER_OVERRIDE_EXCLUDED_KEYS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);
const UPSTREAM_HEADER_OVERRIDE_MAX_BYTES = 8 * 1024;

type ProxyServerInfo = {
  baseUrl: string;
  token: string;
};

export type PreparedProxyRequest = {
  baseUrl: string;
  headers: Record<string, string>;
};

export function encodeUpstreamHeaderOverrides(headers: Record<string, string>): string | undefined {
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (UPSTREAM_HEADER_OVERRIDE_EXCLUDED_KEYS.has(key.toLowerCase())) continue;
    if (key.toLowerCase().startsWith("x-liveagent-")) continue;
    overrides[key] = value;
  }
  if (Object.keys(overrides).length === 0) return undefined;

  // base64 rather than raw JSON: it both prevents CR/LF in values from causing
  // header injection and removes the parsing ambiguity of quotes and commas in a
  // header value.
  const encoded = new TextEncoder().encode(JSON.stringify(overrides));
  if (encoded.byteLength > UPSTREAM_HEADER_OVERRIDE_MAX_BYTES) {
    throw new Error(
      `Custom request headers are too large (${encoded.byteLength} bytes, limit ${UPSTREAM_HEADER_OVERRIDE_MAX_BYTES}). Trim the provider's custom request headers.`,
    );
  }
  let binary = "";
  for (const byte of encoded) binary += String.fromCharCode(byte);
  return btoa(binary);
}

let proxyServerInfoPromise: Promise<ProxyServerInfo> | null = null;

function normalizeProxyServerInfo(info: ProxyServerInfo): ProxyServerInfo {
  const baseUrl = String(info.baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  const token = String(info.token ?? "").trim();

  if (!baseUrl) {
    throw new Error("Local proxy base URL is empty");
  }
  if (!token) {
    throw new Error("Local proxy token is empty");
  }

  return {
    baseUrl,
    token,
  };
}

async function getProxyServerInfo(): Promise<ProxyServerInfo> {
  if (!proxyServerInfoPromise) {
    proxyServerInfoPromise = invoke<ProxyServerInfo>("proxy_get_server_info")
      .then(normalizeProxyServerInfo)
      .catch((error) => {
        proxyServerInfoPromise = null;
        throw new Error(
          `Failed to get local proxy info: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  return proxyServerInfoPromise;
}

/** URL safety validation shared by all proxy entry points: absolute address + http(s) + no embedded credentials. */
function parseAbsoluteHttpUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error(
      `${label} must be an absolute URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must start with http:// or https://`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} cannot include embedded username or password`);
  }
  return parsed;
}

export function buildProxyBaseUrl(
  providerId: ProviderId,
  upstreamBaseUrl: string,
  proxyServerBaseUrl: string,
  options?: { isFullUrl?: boolean },
): { baseUrl: string; upstreamOrigin: string; upstreamUrl?: string } {
  const normalizedUpstream = upstreamBaseUrl.trim();
  if (!normalizedUpstream) {
    throw new Error("Base URL cannot be empty");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUpstream);
  } catch (error) {
    throw new Error(
      `Base URL must be an absolute URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error("Base URL cannot include embedded username or password");
  }
  if (parsed.hash) {
    throw new Error("Base URL cannot include a fragment");
  }
  if (!options?.isFullUrl && parsed.search) {
    throw new Error("Base URL cannot include query parameters or fragments");
  }

  const normalizedProxyServerBaseUrl = proxyServerBaseUrl.trim().replace(/\/+$/, "");
  if (options?.isFullUrl) {
    return {
      baseUrl: `${normalizedProxyServerBaseUrl}/proxy/${providerId}`,
      upstreamOrigin: parsed.origin,
      upstreamUrl: parsed.toString(),
    };
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");

  return {
    baseUrl: `${normalizedProxyServerBaseUrl}/proxy/${providerId}${pathname}`,
    upstreamOrigin: parsed.origin,
  };
}

export function buildImageProxyUrl(imageUrl: string, proxyServerBaseUrl: string): string {
  const normalizedImageUrl = imageUrl.trim();
  if (!normalizedImageUrl) {
    throw new Error("Image URL cannot be empty");
  }

  const parsed = parseAbsoluteHttpUrl(normalizedImageUrl, "Image URL");

  const normalizedProxyServerBaseUrl = proxyServerBaseUrl.trim().replace(/\/+$/, "");
  if (!normalizedProxyServerBaseUrl) {
    throw new Error("Local proxy base URL is empty");
  }
  return `${normalizedProxyServerBaseUrl}/image-proxy?url=${encodeURIComponent(parsed.toString())}`;
}

export async function prepareImageProxyUrl(imageUrl: string): Promise<string> {
  const proxyServerInfo = await getProxyServerInfo();
  return buildImageProxyUrl(imageUrl, proxyServerInfo.baseUrl);
}

export type PreparedUpstreamProxyRequest = {
  url: string;
  headers: Record<string, string>;
};

/** The local reverse proxy's path segment only distinguishes the link (the Rust side does not validate the value); hub = store-type egress. */
const HUB_PROXY_ROUTE = "hub";

/**
 * Rewrite any complete upstream URL into a request through the local reverse
 * proxy: path and query are preserved as-is, and origin moves into the
 * upstream-origin header. use-system-proxy is always set -- the reverse proxy
 * egresses per the app proxy config (disabled = direct, config error = 502 fail
 * fast, never a silent fallback to direct).
 */
export async function prepareUpstreamProxyRequest(
  targetUrl: string,
): Promise<PreparedUpstreamProxyRequest> {
  const parsed = parseAbsoluteHttpUrl(targetUrl, "Upstream URL");
  // A pathname starting with "//" would be treated by the Rust side's Url::join as
  // a scheme-relative reference rewriting the upstream host, so it must be rejected
  // (Rust build_target_url has the same backstop).
  if (parsed.pathname.startsWith("//")) {
    throw new Error("Upstream URL path must not begin with //");
  }

  const proxyServerInfo = await getProxyServerInfo();
  // The root path maps to an empty string: /proxy/hub/ matches no reverse-proxy
  // route ({*rest} requires non-empty), while /proxy/hub is restored by
  // build_target_url to the upstream "/".
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  return {
    url: `${proxyServerInfo.baseUrl}/proxy/${HUB_PROXY_ROUTE}${pathname}${parsed.search}`,
    headers: {
      [LIVEAGENT_UPSTREAM_ORIGIN_HEADER]: parsed.origin,
      [LIVEAGENT_PROXY_TOKEN_HEADER]: proxyServerInfo.token,
      [LIVEAGENT_USE_SYSTEM_PROXY_HEADER]: "1",
    },
  };
}

export async function prepareProxyRequest(
  providerId: ProviderId,
  upstreamBaseUrl: string,
  headers: Record<string, string>,
  options?: { useSystemProxy?: boolean; isFullUrl?: boolean },
): Promise<PreparedProxyRequest> {
  const proxyServerInfo = await getProxyServerInfo();
  const { baseUrl, upstreamOrigin, upstreamUrl } = buildProxyBaseUrl(
    providerId,
    upstreamBaseUrl,
    proxyServerInfo.baseUrl,
    { isFullUrl: options?.isFullUrl },
  );
  const upstreamHeaderOverrides = encodeUpstreamHeaderOverrides(headers);

  return {
    baseUrl,
    headers: {
      ...headers,
      ...(upstreamHeaderOverrides
        ? { [LIVEAGENT_UPSTREAM_HEADERS_HEADER]: upstreamHeaderOverrides }
        : {}),
      [LIVEAGENT_UPSTREAM_ORIGIN_HEADER]: upstreamOrigin,
      ...(upstreamUrl ? { [LIVEAGENT_UPSTREAM_URL_HEADER]: upstreamUrl } : {}),
      [LIVEAGENT_PROXY_TOKEN_HEADER]: proxyServerInfo.token,
      ...(options?.useSystemProxy ? { [LIVEAGENT_USE_SYSTEM_PROXY_HEADER]: "1" } : {}),
    },
  };
}
