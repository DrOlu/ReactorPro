/**
 * Data hook for cumulative conversation statistics.
 *
 * The first window gets a reading synchronously, and the remaining segments are
 * filled in by paging forward during idle time; live events and persisted events
 * are deduplicated using the ledger layer's convergence identity, so a
 * reconnect replay is never double-counted. Rebuilds are throttled to 1s,
 * matching the heartbeat of the running duration.
 *
 * The module-level cache lets multiple panes opening the same conversation share
 * one set of events and aggregate snapshot -- switching away and back does not
 * re-page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TrajectoryHost } from "../../contracts/trajectory";
import {
  buildTrajectoryLedger,
  mergeTrajectoryEventWindows,
  parseTrajectoryEvents,
  trajectoryLiveEventIdentities,
} from "./eventLog";
import { aggregateTrajectoryStats, type ConversationStats } from "./stats";
import type { TrajectoryEvent } from "./types";

/** Rebuild throttle window, in step with the status bar's running heartbeat. */
export const STATS_REBUILD_THROTTLE_MS = 1_000;

/** Fuse for extremely long conversations: stop paging forward once the cumulative event count exceeds this, keeping the reading approximate. */
export const STATS_EVENT_CEILING = 50_000;

const CACHE_LIMIT = 8;

type CacheEntry = {
  events: readonly TrajectoryEvent[];
  /** The earliest segment read so far; 0 means fully read, null means the first window has not been read yet. */
  oldestSegmentIndex: number | null;
  truncated: boolean;
  /** Whether forward paging has finished (including the case where the fuse was hit). */
  complete: boolean;
  revision: number;
  /** Version number of the event set, used to skip rebuilds with no changes. */
  version: number;
};

const cache = new Map<string, CacheEntry>();

function touch(conversationId: string, entry: CacheEntry): void {
  cache.delete(conversationId);
  cache.set(conversationId, entry);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done === true || oldest.value === conversationId) break;
    cache.delete(oldest.value);
  }
}

/** For tests and conversation deletion: drop the cache for a conversation (omitting the argument clears everything). */
export function clearConversationStatsCache(conversationId?: string): void {
  if (conversationId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(conversationId.trim());
}

function scheduleIdle(callback: () => void): () => void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (typeof idle === "function") {
    const handle = idle(callback);
    const cancel = (globalThis as { cancelIdleCallback?: (handle: number) => void })
      .cancelIdleCallback;
    return () => cancel?.(handle);
  }
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

export type UseConversationStatsOptions = {
  conversationId: string;
  host: Pick<TrajectoryHost, "loadWindow">;
  /** The `useSyncExternalStore` product, passed in by the host. */
  liveEvents: readonly TrajectoryEvent[];
  /**
   * Interruption convergence semantics when live events are empty, following
   * the trajectory view:
   * - `authoritative` (desktop): an empty set is also authoritative evidence,
   *   so entries still running in persistence converge to aborted;
   * - `observed` (WebUI, default): converge only once a live event has been
   *   observed, avoiding a misjudgment right after a page reload.
   */
  liveOwnership?: "authoritative" | "observed";
  /** Full reload after edit-resend / rebase. */
  authoritativeRevision?: number;
  /** Do not load when the bar is empty or hidden. */
  enabled: boolean;
};

export type UseConversationStatsResult = {
  stats: ConversationStats | null;
  loading: boolean;
};

export function useConversationStats(
  options: UseConversationStatsOptions,
): UseConversationStatsResult {
  const { host, liveEvents, liveOwnership, authoritativeRevision = 0, enabled } = options;
  const conversationId = options.conversationId.trim();

  const [loading, setLoading] = useState(false);
  // Version number of the event set; both persistence-layer paging and live
  // events trigger rebuilds through it.
  const [eventVersion, setEventVersion] = useState(0);

  const hostRef = useRef(host);
  hostRef.current = host;

  const entryFor = useCallback((): CacheEntry => {
    const existing = cache.get(conversationId);
    if (existing !== undefined && existing.revision === authoritativeRevision) {
      touch(conversationId, existing);
      return existing;
    }
    const fresh: CacheEntry = {
      events: [],
      oldestSegmentIndex: null,
      truncated: false,
      complete: false,
      revision: authoritativeRevision,
      version: 0,
    };
    touch(conversationId, fresh);
    return fresh;
  }, [conversationId, authoritativeRevision]);

  // First window + background forward paging. The whole chain is one effect:
  // it restarts whenever conversationId or the authoritative revision changes.
  useEffect(() => {
    if (!enabled || conversationId === "") {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let cancelIdle: (() => void) | null = null;
    const entry = entryFor();

    const advance = () => {
      if (cancelled) return;
      const current = cache.get(conversationId);
      if (current === undefined || current.revision !== authoritativeRevision) return;
      if (current.complete) {
        setLoading(false);
        return;
      }
      if (current.events.length >= STATS_EVENT_CEILING) {
        // Fuse hit: stop paging and keep the reading approximate.
        cache.set(conversationId, { ...current, complete: true });
        setLoading(false);
        setEventVersion((value) => value + 1);
        return;
      }

      const cursor = current.oldestSegmentIndex === null ? undefined : current.oldestSegmentIndex;
      setLoading(true);
      hostRef.current
        .loadWindow(conversationId, cursor)
        .then((payload) => {
          if (cancelled) return;
          const latest = cache.get(conversationId);
          if (latest === undefined || latest.revision !== authoritativeRevision) return;
          const parsed = parseTrajectoryEvents(payload.eventsJson);
          const merged = mergeTrajectoryEventWindows(latest.events, parsed);
          const oldest =
            latest.oldestSegmentIndex === null
              ? payload.oldestSegmentIndex
              : Math.min(latest.oldestSegmentIndex, payload.oldestSegmentIndex);
          const next: CacheEntry = {
            events: merged,
            oldestSegmentIndex: oldest,
            truncated: latest.truncated || payload.truncated,
            complete: !payload.hasMoreBefore,
            revision: authoritativeRevision,
            version: latest.version + 1,
          };
          touch(conversationId, next);
          setEventVersion((value) => value + 1);
          if (payload.hasMoreBefore) {
            cancelIdle = scheduleIdle(advance);
          } else {
            setLoading(false);
          }
        })
        .catch((error) => {
          if (cancelled) return;
          console.warn("[trajectory] conversation stats window failed", error);
          // Do not retry on failure: the reading is diagnostic information, so it is
          // better to stop at the existing window than to disturb the main
          // conversation path.
          const latest = cache.get(conversationId);
          if (latest !== undefined && latest.revision === authoritativeRevision) {
            cache.set(conversationId, { ...latest, complete: true });
          }
          setLoading(false);
          setEventVersion((value) => value + 1);
        });
    };

    if (entry.complete) {
      // The cache is already complete: use it directly without calling the backend
      // again.
      setEventVersion((value) => value + 1);
      setLoading(false);
    } else {
      advance();
    }

    return () => {
      cancelled = true;
      cancelIdle?.();
    };
  }, [conversationId, authoritativeRevision, enabled, entryFor]);

  // When a live event arrives, throttle 1s before rebuilding: events are dense
  // during streaming and rebuilding the ledger per event is pointless.
  const [liveVersion, setLiveVersion] = useState(0);
  const liveEventsRef = useRef(liveEvents);
  liveEventsRef.current = liveEvents;
  const pendingLiveRef = useRef(false);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: liveEvents is the intentional trigger; the latest payload is read through liveEventsRef after throttling.
  useEffect(() => {
    if (!enabled || conversationId === "") return;
    if (liveTimerRef.current !== null) {
      // Subsequent notifications within the throttle window merge into this pending
      // pass without scheduling another timer.
      pendingLiveRef.current = true;
      return;
    }
    setLiveVersion((value) => value + 1);
    liveTimerRef.current = setTimeout(() => {
      liveTimerRef.current = null;
      if (pendingLiveRef.current) {
        pendingLiveRef.current = false;
        setLiveVersion((value) => value + 1);
      }
    }, STATS_REBUILD_THROTTLE_MS);
  }, [liveEvents, enabled, conversationId]);

  useEffect(
    () => () => {
      if (liveTimerRef.current !== null) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
      pendingLiveRef.current = false;
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: eventVersion and liveVersion intentionally invalidate the memo after paged or throttled ledger updates.
  const stats = useMemo(() => {
    if (!enabled || conversationId === "") return null;
    const entry = cache.get(conversationId);
    const persisted = entry?.revision === authoritativeRevision ? entry.events : [];
    const live = liveEventsRef.current;
    if (persisted.length === 0 && live.length === 0) return null;

    const events = mergeTrajectoryEventWindows(persisted, live);
    // Interruption convergence follows the trajectory view: under
    // authoritative, an empty set also participates in the decision (authoritative
    // evidence of a process restart); under observed, converge only after a live
    // event has been seen, avoiding marking a running turn as interrupted right
    // after a reload.
    const liveIdentities =
      liveOwnership === "authoritative" || live.length > 0
        ? trajectoryLiveEventIdentities(live)
        : undefined;
    const ledger = buildTrajectoryLedger(events, { liveIdentities });
    const approximate =
      entry === undefined ||
      entry.truncated ||
      !entry.complete ||
      events.length >= STATS_EVENT_CEILING;
    return aggregateTrajectoryStats(ledger, { approximate });
    // eventVersion / liveVersion are rebuild triggers: the former follows paging,
    // the latter is throttled to 1s.
  }, [conversationId, authoritativeRevision, enabled, liveOwnership, eventVersion, liveVersion]);

  return { stats, loading };
}
