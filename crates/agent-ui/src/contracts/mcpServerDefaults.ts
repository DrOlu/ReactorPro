import type { ToolPolicy } from "@liveagent/app/lib/settings";

/**
 * The single place that decides the fact "this MCP server's tool surface directly operates the
 * user's machine".
 *
 * Background: `resolveToolPolicy` falls back to `allow` for MCP tools - reasonable for the vast
 * majority of MCP servers (documentation lookups, data reads). But the 60 tools exposed by
 * `cua-driver` include `kill_app`, `clipboard_write`, and `type_text`, and implicit allowance is
 * equivalent to letting the model silently press keys, modify the clipboard, and kill processes.
 * Such servers must default to `ask` and be wrapped in the self-reference gate
 * (`lib/tools/cuaSelfGuard.ts`).
 *
 * **The determination is based on the binary it launches, not the server id.** The id is a
 * display identifier the user can change at will: just name an entry `my-tools` while the command
 * still points at cua-driver, and an implementation that judges by id would let the approval
 * default fall back to `allow` and never create the self-reference gate at all - 60 tools that can
 * click, type, and kill processes pass with zero approval. Security decisions must not be built on
 * a mutable identifier.
 *
 * It lives in contracts/ because both sides share it: `agent-gui`'s `lib/tools/` uses it to decide
 * the policy default and gate, and `agent-ui`'s MCP Hub and CUA settings page use it for display
 * defaults. Both sides read the same place, otherwise "the UI shows allow while execution uses ask"
 * would drift out of sync.
 */

/** The minimal server description needed for the determination. Passing a full `McpServerConfig` also works. */
export type ServerIdentity = {
  id?: string | null;
  command?: string | null;
};

/** The managed MCP server id for cua-driver (the one used when creating an entry in the settings page). */
export const CUA_DRIVER_SERVER_ID = "cua-driver";

/** The cua-driver executable file name (without extension). */
const CUA_DRIVER_BINARY = "cua-driver";

/**
 * Canonical form of a server id: trim + lowercase.
 *
 * Every determination of "is this server the managed entry" must go through it. Otherwise a
 * config written as `CUA-DRIVER` would be recognized by some code paths and not others, and the
 * security-side default would fail due to letter case.
 */
export function canonicalServerId(serverId: string): string {
  return serverId.trim().toLowerCase();
}

/**
 * Extract the executable file name from a command: strip the directory, the Windows `.exe`, and
 * quotes.
 *
 * The command in the config may be an absolute path (`/Users/x/.local/bin/cua-driver`), a bare
 * name, or a quoted path, so a direct string comparison will not work.
 */
function commandBasename(command: string): string {
  const trimmed = command.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return "";
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? "";
  return last.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * Whether this server is cua-driver - **either the id or the command matching counts**.
 *
 * Both conditions must be checked:
 * - id match: the managed entry created from the settings page, whose command is determined by
 *   the `manifest`;
 * - command match: entries the user added themselves in the MCP Hub or imported from elsewhere,
 *   whose id can be any name. Recognizing only the id would let this path completely bypass the
 *   approval default and the self-reference gate.
 */
export function isCuaDriverServer(server: ServerIdentity | undefined | null): boolean {
  if (!server) return false;
  if (canonicalServerId(server.id ?? "") === CUA_DRIVER_SERVER_ID) return true;
  return commandBasename(server.command ?? "") === CUA_DRIVER_BINARY;
}

/**
 * MCP stores per-server policies keyed by `server:<serverId>`. The granularity sits between "a
 * single tool" and "the whole MCP group": when no policy is explicitly set for a server, it falls
 * back to the group level (group:mcp) and then to the default.
 */
export const TOOL_SERVER_POLICY_PREFIX = "server:";

export function toolServerPolicyKey(serverId: string): string {
  return `${TOOL_SERVER_POLICY_PREFIX}${serverId}`;
}

/**
 * The policy keys a server may match, **in lookup order**: the raw key (trimmed) first, with the
 * canonical (lowercased) key as the fallback.
 *
 * Both are checked to eliminate case mismatch: the places that write policies (MCP Hub cards, the
 * CUA settings page) use whichever id they hold, while the runtime receives the id returned by the
 * MCP server, and the two may differ only in case. Checking only the raw key would silently
 * invalidate the explicit config and fall back to the `allow` default. The raw key takes priority
 * and the canonical key is only a fallback, so the parsing result of existing configs is unchanged.
 *
 * **Every place that reads policies must go through this list, in the same order** - if the
 * runtime (`resolveToolPolicy`) and the settings page (`readCuaPolicy`) each implemented their own,
 * display/execution mismatches like "the settings page shows ask while the runtime executes allow"
 * would return. The raw key is trimmed: policy table keys are normalized by `normalizeToolPolicies`,
 * so keys with whitespace never exist and an untrimmed raw candidate would never find anything.
 */
export function serverPolicyKeyCandidates(serverId: string): string[] {
  const raw = toolServerPolicyKey(serverId.trim());
  const normalized = toolServerPolicyKey(canonicalServerId(serverId));
  return raw === normalized ? [raw] : [raw, normalized];
}

/**
 * The server's hardcoded default policy; for anything not in the "directly operates the user's
 * machine" category it returns undefined and the caller falls back to the generic default.
 */
export function hardcodedServerPolicyDefault(
  server: ServerIdentity | undefined | null,
): ToolPolicy | undefined {
  return isCuaDriverServer(server) ? "ask" : undefined;
}

/** The server's effective policy when there is no explicit config (including the global `allow` fallback). */
export function effectiveServerPolicyDefault(
  server: ServerIdentity | undefined | null,
): ToolPolicy {
  return hardcodedServerPolicyDefault(server) ?? "allow";
}

/**
 * Whether this server is managed by the dedicated settings page (the MCP Hub should hide it).
 *
 * This deliberately looks **only** at the id, unlike the security determination above: it is a
 * question of ownership - "who is responsible for this config's UI". An entry the user added
 * themselves whose command happens to point at cua-driver should still stay in the Hub - otherwise
 * it is neither managed by the CUA settings page (that section only recognizes the managed id) nor
 * visible in the Hub, becoming a ghost config nobody can delete.
 */
export function isHubHiddenServerId(serverId: string): boolean {
  return canonicalServerId(serverId) === CUA_DRIVER_SERVER_ID;
}

/** Whether this server is the managed entry owned by the settings page (case- and whitespace-insensitive). */
export function isCuaDriverServerId(serverId: string | undefined | null): boolean {
  return canonicalServerId(serverId ?? "") === CUA_DRIVER_SERVER_ID;
}
