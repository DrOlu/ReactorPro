import {
  LIVEAGENT_UPSTREAM_ORIGIN_HEADER,
  LIVEAGENT_UPSTREAM_URL_HEADER,
  LIVEAGENT_USE_SYSTEM_PROXY_HEADER,
} from "@liveagent/ui/lib/providers/proxy";

/**
 * Transport assembly summary for one actual outbound attempt, used by the
 * trajectory ledger to audit per-candidate independence (the primary carries the
 * use-system-proxy header while the fallback does not, and they do not leak into
 * each other).
 *
 * Redaction invariant: only header *names* and routing markers are read, never
 * header values — auth headers (authorization/x-api-key/x-goog-api-key), proxy
 * tokens, and base64 override payload values never enter the snapshot. The
 * upstream origin is scheme+host (the same sensitivity level as the provider/
 * model already persisted by step_end), and in fullUrl mode the full URL may
 * contain query credentials, so only a boolean marker is recorded.
 */
export type TransportSnapshot = {
  upstreamOrigin?: string;
  useSystemProxy: boolean;
  fullUrl: boolean;
  /** All header names, lowercased and deduplicated in lexicographic order; values are never collected. */
  headerNames: readonly string[];
};

export function captureTransportSnapshot(
  headers: Record<string, string | null> | undefined,
): TransportSnapshot {
  const byLowerName = new Map<string, string>();
  for (const [name, value] of Object.entries(headers ?? {})) {
    // null is the "delete this header" marker (pi-ai ProviderHeaders semantics) and never appears in the outbound request.
    if (value === null) continue;
    byLowerName.set(name.toLowerCase(), value);
  }
  const upstreamOrigin = byLowerName.get(LIVEAGENT_UPSTREAM_ORIGIN_HEADER)?.trim();
  return {
    ...(upstreamOrigin === undefined || upstreamOrigin === "" ? {} : { upstreamOrigin }),
    useSystemProxy: byLowerName.get(LIVEAGENT_USE_SYSTEM_PROXY_HEADER) === "1",
    fullUrl: byLowerName.has(LIVEAGENT_UPSTREAM_URL_HEADER),
    headerNames: [...byLowerName.keys()].sort(),
  };
}
