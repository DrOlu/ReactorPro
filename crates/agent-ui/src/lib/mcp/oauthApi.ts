/**
 * MCP OAuth bridge (docs/design/mcp-oauth.md §5).
 *
 * The authorization flow can only be initiated on the desktop (the system browser opens
 * on the desktop): the WebUI's tauriCore shim does not implement these commands, so
 * callers must hide the entry point first using `isGatewayWebuiRuntime()`. The token
 * itself never crosses the frontend boundary -- only state and metadata are passed here.
 */
import { invoke } from "@liveagent/app/shims/tauriCore";
import type { McpServerConfig } from "../settings/types";

export type McpOauthState = "none" | "authorized" | "expired";

export type McpOauthStatus = {
  state: McpOauthState;
  refreshable: boolean;
  /** "keychain" | "file" | "unknown" (file = degraded storage on Linux without secret-service). */
  storage: string;
  expiresAtMs?: number;
  issuer?: string;
  scope?: string;
};

export function isOauthServer(server: McpServerConfig): boolean {
  return (
    (server.transport === "http" || server.transport === "sse") && server.auth?.type === "oauth"
  );
}

/** Interactive authorization: opens the system browser and blocks until the callback/timeout (5 minutes). Called only from a user gesture. */
export function mcpOauthAuthorize(server: McpServerConfig): Promise<McpOauthStatus> {
  return invoke<McpOauthStatus>("mcp_oauth_authorize", { server });
}

export function mcpOauthStatus(server: McpServerConfig): Promise<McpOauthStatus> {
  return invoke<McpOauthStatus>("mcp_oauth_status", { server });
}

/** Clears the keychain entry when disconnecting authorization/deleting a server. */
export function mcpOauthClear(serverId: string): Promise<void> {
  return invoke<void>("mcp_oauth_clear", { server_id: serverId });
}
