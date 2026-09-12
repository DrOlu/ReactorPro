/**
 * Prefix snapshot store keyed by sessionId. Attribution requires "previous turn" and "current turn" to belong to the same session:
 * runner-local variables can neither persist across runner calls (the next turn of the same session can only report
 * initial), nor prevent cross-session interleaving (main session/subagent/memory extraction coexisting) from using another session's
 * snapshot as the baseline. The store is module-level, isolated by sessionId, with an LRU cap matching
 * injectionController's conversation-count budget (32).
 *
 * Same directory as prefixCacheShape but deliberately a separate file: the former promises pure functions (no time quantities or state),
 * whereas this one is state itself and must not be mixed in to dilute that promise.
 */
import type { PrefixShape } from "./prefixCacheShape";

/** Maximum number of cached sessions, matching injectionController's INJECTION_CONVERSATION_STATE_LIMIT. */
const PREFIX_SHAPE_SESSION_LIMIT = 32;

type PrefixShapeEntry = {
  shape: PrefixShape;
  lastTouchedAt: number;
};

const shapesBySession = new Map<string, PrefixShapeEntry>();

// The eviction order only needs relative precedence. Use a monotonic counter instead of Date.now(): multiple touches within the same millisecond
// still keep a stable order, and it does not introduce a time quantity into the reconciliation chain.
let touchCounter = 0;

// When sessionId is missing it degrades to a single slot: equivalent to the old runner-local-variable semantics (anonymous requests may
// still cross-contaminate), but without a key there is no better way to attribute, and at least continuity across calls is preserved.
let fallbackShape: PrefixShape | null = null;

function pruneShapes() {
  if (shapesBySession.size <= PREFIX_SHAPE_SESSION_LIMIT) return;
  const sorted = [...shapesBySession.entries()].sort(
    (a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt,
  );
  for (const [key] of sorted.slice(0, shapesBySession.size - PREFIX_SHAPE_SESSION_LIMIT)) {
    shapesBySession.delete(key);
  }
}

function normalizeKey(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed ? trimmed : undefined;
}

/** Read the previous turn's prefix snapshot for this session; reading counts as a touch so active sessions are not evicted by the LRU. */
export function readPreviousPrefixShape(sessionId: string | undefined): PrefixShape | null {
  const key = normalizeKey(sessionId);
  if (!key) return fallbackShape;
  const entry = shapesBySession.get(key);
  if (!entry) return null;
  entry.lastTouchedAt = ++touchCounter;
  return entry.shape;
}

/** Written back after each turn's capture, as the baseline for that session's next-turn comparison. */
export function recordPrefixShape(sessionId: string | undefined, shape: PrefixShape): void {
  const key = normalizeKey(sessionId);
  if (!key) {
    fallbackShape = shape;
    return;
  }
  const existing = shapesBySession.get(key);
  if (existing) {
    existing.shape = shape;
    existing.lastTouchedAt = ++touchCounter;
    return;
  }
  shapesBySession.set(key, { shape, lastTouchedAt: ++touchCounter });
  pruneShapes();
}
