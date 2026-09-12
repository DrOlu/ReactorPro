/**
 * Single source of truth for Gateway WebUI runtime detection: on the web side,
 * main.tsx writes GATEWAY_WEBUI_MARKER into <html data-liveagent-webui> before
 * rendering; the desktop never writes it. Mirrored code that needs to distinguish the
 * two runtimes must reference this, and must not copy the literal again.
 */
export const GATEWAY_WEBUI_MARKER = "gateway";

export function isGatewayWebuiRuntime() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.liveagentWebui === GATEWAY_WEBUI_MARKER
  );
}
