import type { McpServerConfig, ToolPolicy } from "@liveagent/app/lib/settings";
import {
  CUA_DRIVER_SERVER_ID,
  effectiveServerPolicyDefault,
  isCuaDriverServerId,
  serverPolicyKeyCandidates,
} from "@liveagent/ui/contracts/mcpServerDefaults";

/**
 * Pure logic for the CUA settings page: managed-entry lookup, policy key derivation, timeout
 * clamping, probe caching, and configuration drift detection.
 *
 * It is separated from the component because these decisions are all of the "the user only finds
 * out once something is wrong" kind -- a miscomputed policy key would make the approval tier shown
 * on the page differ from the one actually enforced, a missed timeout clamp would store "6" as
 * 6ms, and a missing drift check would show a path that is never actually executed. They deserve
 * unit tests, while the component itself (layout, icons, copy) does not. Same division of labor as
 * `backupSyncForm.ts` / `aboutDate.ts`.
 */

export type CuaProbe = {
  installed: boolean;
  path?: string | null;
  version?: string | null;
  mcpCommand?: string | null;
  mcpArgs?: string[];
  /** Whether this platform has a system authorization gate. True only on macOS. */
  permissionsRequired?: boolean;
  error?: string | null;
};

export type CuaPermissions = {
  supported: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  attributedTo?: string | null;
  error?: string | null;
};

export type CuaInstallPreview = {
  program: string;
  args: string[];
  display: string;
  sourceUrl: string;
};

export type CuaInstallProgress = { stream: string; line: string };

export const CUA_DEFAULT_TIMEOUT_MS = 60_000;

/** Upper bound on a single call's timeout. Any longer is pointless -- a GUI operation should not run for ten minutes. */
export const CUA_MAX_TIMEOUT_MS = 600_000;

/** Lower bound. Below this value every call is guaranteed to time out, effectively disabling the feature. */
export const CUA_MIN_TIMEOUT_MS = 1_000;

export const CUA_INSTALL_PROGRESS_EVENT = "cua_driver_install_progress";

export const CUA_MAX_LOG_LINES = 200;

export const CUA_UPSTREAM_REPO_URL = "https://github.com/trycua/cua";

/** Finds the managed cua-driver entry (case- and whitespace-insensitive). */
export function findCuaDriverServer(servers: readonly McpServerConfig[]) {
  return servers.find((server) => isCuaDriverServerId(server.id));
}

/** Same as above but returns the index -- writes back at the original position. Returns -1 when not found. */
export function findCuaDriverServerIndex(servers: readonly McpServerConfig[]) {
  return servers.findIndex((server) => isCuaDriverServerId(server.id));
}

/**
 * The policy keys this entry may match, in lookup order: the raw-text key first, with the
 * normalized key as a fallback.
 *
 * Shares the same implementation and order from contracts as the runtime (`resolveToolPolicy`). The
 * tier shown on this page must be exactly the one the runtime will enforce -- if the two looked up
 * their own keys, an old config with `id: "CUA-DRIVER"` + `"server:cua-driver": "allow"` would
 * show ask on the page while actually enforcing allow.
 */
export function cuaPolicyKeyCandidates(entry: McpServerConfig | undefined): string[] {
  return serverPolicyKeyCandidates(entry?.id.trim() || CUA_DRIVER_SERVER_ID);
}

/**
 * The policy key used when writing: follows the raw text of the id in the entry, not a constant.
 * Existing configs may spell the id `CUA-DRIVER`, and the runtime's candidate list prioritizes the
 * raw-text key, so writing elsewhere would be shadowed by it.
 */
export function cuaServerPolicyKey(entry: McpServerConfig | undefined): string {
  return cuaPolicyKeyCandidates(entry)[0];
}

/** The effective policy for this entry when there is no explicit config. The managed entry is always ask. */
export function cuaDefaultPolicy(entry: McpServerConfig | undefined): ToolPolicy {
  return effectiveServerPolicyDefault(entry ?? { id: CUA_DRIVER_SERVER_ID });
}

/** The currently effective approval policy: explicit config first (in the runtime's same candidate order), otherwise the default. */
export function readCuaPolicy(
  policies: Record<string, ToolPolicy> | undefined,
  entry: McpServerConfig | undefined,
): ToolPolicy {
  for (const key of cuaPolicyKeyCandidates(entry)) {
    const policy = policies?.[key];
    if (policy) return policy;
  }
  return cuaDefaultPolicy(entry);
}

/**
 * Writes back the approval policy and returns the new toolPolicies (an empty table returns
 * undefined, consistent with other settings).
 *
 * Two rules:
 * - Delete the key only when returning to the default. The managed entry's default is ask, so
 *   "always allow" must be persisted explicitly; deleting it would fall back to ask;
 * - Clear **all** candidate keys before writing. When the id is spelled `CUA-DRIVER`, the raw-text
 *   key and the normalized key both exist, and leaving that shadowing behind would make
 *   `resolveToolPolicy`'s fallback read the previous value.
 */
export function applyCuaPolicy(
  policies: Record<string, ToolPolicy> | undefined,
  entry: McpServerConfig | undefined,
  next: ToolPolicy,
): Record<string, ToolPolicy> | undefined {
  const current = { ...(policies ?? {}) };
  for (const key of cuaPolicyKeyCandidates(entry)) delete current[key];
  if (next !== cuaDefaultPolicy(entry)) current[cuaServerPolicyKey(entry)] = next;
  return Object.keys(current).length > 0 ? current : undefined;
}

/** Builds the managed entry from a probe result. */
export function buildCuaServerConfig(probe: CuaProbe): McpServerConfig {
  return {
    id: CUA_DRIVER_SERVER_ID,
    description: "trycua/cua — CUA driver (cross-platform)",
    docsUrl: CUA_UPSTREAM_REPO_URL,
    enabled: true,
    transport: "stdio",
    // An absolute path rather than a bare command: the MCP subprocess inherits the GUI process's
    // narrow PATH, which usually does not include ~/.local/bin -- the official installer's default location.
    command: probe.mcpCommand || probe.path || "cua-driver",
    // Deliberately without `--direct`: that would make the MCP process inherit ReactorPro's TCC
    // attribution, effectively requiring ReactorPro to obtain accessibility and screen recording
    // authorization itself. The default mode proxies through the CuaDriver.app daemon, which owns
    // the authorization.
    args: probe.mcpArgs?.length ? probe.mcpArgs : ["mcp"],
    url: "",
    timeoutMs: CUA_DEFAULT_TIMEOUT_MS,
  };
}

/** Clamps the draft in the input box to the valid range; invalid values fall back to `fallback`. */
export function clampCuaTimeoutMs(draft: string, fallback: number): number {
  const parsed = Number.parseInt(draft.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, CUA_MIN_TIMEOUT_MS), CUA_MAX_TIMEOUT_MS);
}

/**
 * Whether the command stored in the entry has diverged from the path just probed.
 *
 * Reason for existing: the UI must show **what will be executed**, not **what happens to exist**.
 * The entry's command was fixed at the moment the entry was created, so once the user reinstalls
 * cua-driver elsewhere, or imports a same-named entry whose command points somewhere else, the two
 * are no longer the same thing -- showing the probed path then would make the user think all is
 * well while a different binary is actually launched.
 */
export function cuaCommandDrift(
  entry: McpServerConfig | undefined,
  probe: CuaProbe | null,
): { configured: string; probed: string } | null {
  const configured = entry?.command?.trim();
  const probed = (probe?.mcpCommand || probe?.path || "").trim();
  if (!configured || !probed || configured === probed) return null;
  return { configured, probed };
}

/** The command to show in the UI: the entry's own if there is an entry, otherwise the probed one. */
export function cuaDisplayCommand(
  entry: McpServerConfig | undefined,
  probe: CuaProbe | null,
): string | null {
  return entry?.command?.trim() || probe?.path?.trim() || null;
}

/** Aligns the entry's command / args with the latest probe result, keeping the other fields (timeout, etc.). */
export function realignCuaServerConfig(entry: McpServerConfig, probe: CuaProbe): McpServerConfig {
  const fresh = buildCuaServerConfig(probe);
  return { ...entry, command: fresh.command, args: fresh.args };
}

/**
 * In-process cache for probe results.
 *
 * Re-probing on every mount would mean spawning a subprocess every time the user switches to the
 * CUA page -- a flashing console window on Windows, or possibly waking the CuaDriver.app daemon on
 * macOS. These facts do not change within a minute, so there is no reason to re-check when switching
 * pages. "Re-detect", install completion, and authorization completion all explicitly bypass the cache.
 */
export const CUA_PROBE_CACHE_TTL_MS = 60_000;

type CuaProbeCache = { at: number; probe: CuaProbe; permissions: CuaPermissions | null };

let probeCache: CuaProbeCache | null = null;

export function readCuaProbeCache(now = Date.now()): CuaProbeCache | null {
  if (!probeCache) return null;
  return now - probeCache.at <= CUA_PROBE_CACHE_TTL_MS ? probeCache : null;
}

export function writeCuaProbeCache(
  probe: CuaProbe,
  permissions: CuaPermissions | null,
  now = Date.now(),
) {
  probeCache = { at: now, probe, permissions };
}

/** When the authorization state just changed, update only that half without invalidating the probe too. */
export function patchCuaProbeCachePermissions(permissions: CuaPermissions) {
  if (probeCache) probeCache = { ...probeCache, permissions };
}

/** For tests to reset. */
export function resetCuaProbeCache() {
  probeCache = null;
}
