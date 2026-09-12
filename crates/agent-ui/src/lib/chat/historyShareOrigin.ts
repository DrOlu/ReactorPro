// The single assembly point for the public access address of share links: the GUI's and the
// WebUI's two share dialogs both build the final origin from here. Port semantics match the
// desktop side's WS connection (src-tauri services/gateway/ws_transport.rs build_ws_url): a
// non-zero gateway_port in settings overrides the port carried by the base address; http:80 /
// https:443 are naturally omitted by URL rules.

function getBrowserOrigin() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.location.origin;
}

function isValidGatewayPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535;
}

export function resolveShareOrigin(explicitOrigin?: string, gatewayPort?: number) {
  const hasExplicitOrigin = explicitOrigin !== undefined;
  const rawOrigin = hasExplicitOrigin ? explicitOrigin : getBrowserOrigin();
  const trimmed = rawOrigin.trim();
  if (!trimmed) {
    return "";
  }

  const schemeMatch = /^(https?|wss?):(.*)$/i.exec(trimmed);
  const withScheme = schemeMatch
    ? [
        schemeMatch[1].toLowerCase(),
        ":",
        schemeMatch[2].startsWith("//")
          ? schemeMatch[2]
          : `//${schemeMatch[2].replace(/^\/+/, "")}`,
      ].join("")
    : `https://${trimmed}`;
  const httpUrl = withScheme.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");

  try {
    const url = new URL(httpUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.hostname === "http" ||
      url.hostname === "https"
    ) {
      return "";
    }
    // The browser origin already includes the port; only an explicitly passed gateway base address needs one added.
    if (hasExplicitOrigin && isValidGatewayPort(gatewayPort)) {
      url.port = String(gatewayPort);
    }
    return url.origin.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function buildShareUrl(token: string, origin: string) {
  const normalizedToken = token.trim();
  if (!normalizedToken || !origin) {
    return "";
  }
  return `${origin}/share/${encodeURIComponent(normalizedToken)}`;
}
