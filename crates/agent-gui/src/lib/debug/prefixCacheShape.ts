/**
 * Prefix hash reconciliation: take a stable hash of each request component that
 * affects the provider prompt cache prefix (system prompt and tools), compare
 * snapshots of adjacent requests turn by turn, and turn "why did this turn miss"
 * from staring at cacheRead=0 and guessing into a directly readable attribution
 * string.
 *
 * This module is observation only; it never changes any request content. It must
 * itself be a pure function: no time, randomness, or environment dependence, so
 * the same input always yields the same output -- if the observation mechanism
 * jitters on its own, attribution loses all meaning.
 */

// FNV-1a is chosen over SHA-256: crypto.subtle only exposes an async interface,
// while snapshots must be computed in one pass on the synchronous request
// assembly path. Attribution only needs to tell whether something changed, not
// cryptographic strength.
const FNV_PRIME = 0x01000193;
const FNV_OFFSET_BASIS = 0x811c9dc5;
// The second hash stream uses a different seed and is concatenated with the
// first into a 64-bit output, making collision probability negligible.
const FNV_SECOND_SEED = 0x7ee3a1cf;

export type PrefixShapeTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  /**
   * Constrained sampling configuration. Like parameters, it ships in the
   * request body: change the config and the prefix bytes really do change, so
   * not accounting for it would report unchanged when something genuinely
   * happened. The current toolchain may not carry this field; absent is
   * equivalent to empty and does not affect the existing hash's stability
   * semantics.
   */
  constrainedSampling?: unknown;
};

/**
 * Cache parameters that affect breakpoint placement and TTL. The text bytes may
 * be identical, but if the TTL goes from 5m to 1h, or the provider path switches
 * from "top-level automatic breakpoints" to "explicit breakpoints", the cache is
 * equally invalidated -- such changes are invisible to the system and tools
 * hashes and must be accounted for separately, or attribution will report
 * unchanged when something genuinely happened.
 */
export type PrefixShapeCacheControl = {
  cacheRetention?: string;
  ttl?: string;
  breakpointStrategy?: string;
  /**
   * codex's cache shard routing key (prompt_cache_key / x-session-id). Change
   * sessionId and the server switches shards, so even a byte-stable prefix hits
   * zero -- it must be accounted for separately. An empty string means "was
   * supposed to be injected but wasn't": injection failure is silent, and
   * cacheKey going from a value to an empty string is the only place it becomes
   * visible in attribution.
   */
  cacheKey?: string;
};

export type PrefixShape = {
  systemHash: string;
  toolsHash: string;
  cacheControlHash: string;
  prefixHash: string;
  toolCount: number;
};

export type PrefixChangeReason = "system" | "tools" | "cacheControl";

/** Attribution values plus a first-turn baseline: the first turn has no prior snapshot to compare against, so it must not count as "changed". */
export type PrefixChangeSummary =
  | "initial"
  | "unchanged"
  | "system"
  | "tools"
  | "cacheControl"
  | "multiple";

export type PrefixCacheDiagnostics = {
  prefixHash: string;
  systemHash: string;
  toolsHash: string;
  cacheControlHash: string;
  toolCount: number;
  prefixChanged: boolean;
  prefixChangeReasons: PrefixChangeReason[];
  prefixChangeSummary: PrefixChangeSummary;
};

function fnv1a32(input: string, seed: number) {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    // Feed bytes low-first so the same string yields the same result on any engine.
    hash = Math.imul(hash ^ (code & 0xff), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function toHex8(value: number) {
  return value.toString(16).padStart(8, "0");
}

function stableHash(input: string) {
  // Salt with the length, which also rules out edge-case collisions where the
  // content bit pattern is similar but the lengths differ.
  const salted = `${input.length}:${input}`;
  return `${toHex8(fnv1a32(salted, FNV_OFFSET_BASIS))}${toHex8(fnv1a32(salted, FNV_SECOND_SEED))}`;
}

function stringifyParameters(parameters: unknown) {
  if (parameters === undefined) return "";
  try {
    return JSON.stringify(parameters) ?? "";
  } catch {
    // Schemas are in theory pure JSON; if a circular reference does appear,
    // degrade to a stable marker. Better to coarsen that tool's hash granularity
    // than to let the reconciliation pipeline throw.
    return "[unserializable]";
  }
}

/**
 * Serialize the tool list in upload order -- deliberately **without sorting**.
 *
 * The tools array is ordered in the request body (filterRequestTools only
 * filters, never reorders), so if the registry iteration order changes, the
 * provider-side prefix really is invalidated. This used to sort, on the
 * reasoning that it would "avoid false positives from registry order changes",
 * but that premise was itself wrong: an order change is not a false positive,
 * it is a real invalidation. Sorting would only make diagnostics report
 * unchanged when an MCP server reconnect scrambles the order -- the observer
 * lying in exactly the scenario it was meant to catch. Better to report a tools
 * change that needs human interpretation than to miss it.
 */
function normalizeTools(tools: readonly PrefixShapeTool[]) {
  return tools.map((tool) => [
    tool.name,
    tool.description ?? "",
    stringifyParameters(tool.parameters),
    stringifyParameters(tool.constrainedSampling),
  ]);
}

/**
 * Cache parameter normalization: field order is fixed and absent values all
 * become empty strings, so that undefined and a missing field cannot produce
 * two different hashes after JSON serialization.
 */
function normalizeCacheControl(cacheControl: PrefixShapeCacheControl | undefined) {
  return [
    cacheControl?.cacheRetention ?? "",
    cacheControl?.ttl ?? "",
    cacheControl?.breakpointStrategy ?? "",
    cacheControl?.cacheKey ?? "",
  ];
}

/** Take a snapshot of the current request prefix. Called once at the request boundary. */
export function capturePrefixShape(params: {
  systemPrompt?: string;
  tools?: readonly PrefixShapeTool[];
  cacheControl?: PrefixShapeCacheControl;
}): PrefixShape {
  const tools = params.tools ?? [];
  const systemHash = stableHash(params.systemPrompt ?? "");
  const toolsHash = stableHash(JSON.stringify(normalizeTools(tools)));
  const cacheControlHash = stableHash(JSON.stringify(normalizeCacheControl(params.cacheControl)));
  return {
    systemHash,
    toolsHash,
    cacheControlHash,
    prefixHash: stableHash(`${systemHash}:${toolsHash}:${cacheControlHash}`),
    toolCount: tools.length,
  };
}

/**
 * Compare two adjacent snapshots and produce readable attribution. An empty
 * previous means the first turn, with nothing to compare against, so it neither
 * reports changed nor fabricates a reason.
 */
export function comparePrefixShape(
  previous: PrefixShape | null | undefined,
  current: PrefixShape,
): PrefixCacheDiagnostics {
  const reasons: PrefixChangeReason[] = [];
  if (previous) {
    if (previous.systemHash !== current.systemHash) reasons.push("system");
    if (previous.toolsHash !== current.toolsHash) reasons.push("tools");
    if (previous.cacheControlHash !== current.cacheControlHash) reasons.push("cacheControl");
  }

  let summary: PrefixChangeSummary;
  if (!previous) {
    summary = "initial";
  } else if (reasons.length === 0) {
    summary = "unchanged";
  } else if (reasons.length > 1) {
    summary = "multiple";
  } else {
    summary = reasons[0];
  }

  return {
    prefixHash: current.prefixHash,
    systemHash: current.systemHash,
    toolsHash: current.toolsHash,
    cacheControlHash: current.cacheControlHash,
    toolCount: current.toolCount,
    prefixChanged: reasons.length > 0,
    prefixChangeReasons: reasons,
    prefixChangeSummary: summary,
  };
}
