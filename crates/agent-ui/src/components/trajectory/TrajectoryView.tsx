/**
 * Trajectory view shell.
 *
 * Three data sources converge here:
 * - Persisted events (pulled by the host)
 * - Live events (pushed by the host while the current turn is in progress)
 * - Body text and subagent runs (from loaded messages and host prefetch)
 *
 * With no events it falls back to a degraded ledger derived from messages — structurally complete,
 * with empty timing, and the Gantt chart locked to sequence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrajectoryHost } from "../../contracts/trajectory";
import { useLocale } from "../../i18n/index";
import type { UiMessage } from "../../lib/chat/uiMessages";
import { buildTrajectoryContentIndex } from "../../lib/trajectory/contentIndex";
import { DEFAULT_TRAJECTORY_DETAILS_WIDTH } from "../../lib/trajectory/detailsResize";
import {
  collapsibleTrajectoryAssistants,
  collapsibleTrajectoryTurns,
} from "../../lib/trajectory/displayItems";
import {
  buildTrajectoryLedger,
  mergeTrajectoryEventWindows,
  parseTrajectoryEvents,
  trajectoryLiveEventIdentities,
} from "../../lib/trajectory/eventLog";
import {
  deriveLedgerFromMessages,
  mergeTrajectoryLedgerWithMessages,
} from "../../lib/trajectory/fromMessages";
import { deriveTrajectoryLayout } from "../../lib/trajectory/layout";
import { trajectoryLedgerHasPartialTiming } from "../../lib/trajectory/presentation";
import {
  TrajectorySearchIndex,
  trajectorySearchMatchIndexes,
} from "../../lib/trajectory/searchIndex";
import {
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
  trajectoryTimelineFocusIndexes,
} from "../../lib/trajectory/timeline";
import type {
  TrajectoryEvent,
  TrajectoryRecord,
  TrajectorySubagentRun,
} from "../../lib/trajectory/types";
import { TrajectoryDetailsPanel } from "./TrajectoryDetailsPanel";
import { TrajectoryTable } from "./TrajectoryTable";
import { TrajectoryTimeline } from "./TrajectoryTimeline";
import { TrajectoryToolbar } from "./TrajectoryToolbar";

const EMPTY_TURNS: ReadonlySet<number> = new Set();
const EMPTY_IDS: ReadonlySet<string> = new Set();
const EMPTY_EVENTS: readonly TrajectoryEvent[] = [];
const EMPTY_RUNS: readonly TrajectorySubagentRun[] = [];
/** Maximum automatic retries after a subagent batch load failure (1.5s backoff per failure). */
const SUBAGENT_LOAD_MAX_ATTEMPTS = 3;
const SUBAGENT_LOAD_RETRY_DELAY_MS = 1500;

export function TrajectoryView(props: {
  conversationId: string;
  host: TrajectoryHost;
  messages: readonly UiMessage[];
  workdir?: string;
  hasMoreMessages?: boolean;
  loadEarlierMessages?: () => void | Promise<void>;
  /** Live events for the current turn; merged with persisted events and deduped by the ledger layer. */
  liveEvents?: readonly TrajectoryEvent[];
  /**
   * Interruption-convergence semantics when live events are empty.
   * - `authoritative` (desktop): an empty set is equally authoritative evidence — after this
   *   process restarts it holds no live tail, so any entry still running in persistence converges
   *   to aborted.
   * - `observed` (WebUI, default): only when live events have been observed do uncovered running
   *   entries converge, so a turn still running is not misjudged right after the page reloads
   *   before the live stream arrives.
   */
  liveOwnership?: "authoritative" | "observed";
  /** Incrementing version after local authoritative changes such as edit-resend; on change the read tail window is replaced. */
  authoritativeRevision?: number;
}) {
  const { t } = useLocale();
  const [persisted, setPersisted] = useState<readonly TrajectoryEvent[]>(EMPTY_EVENTS);
  const [truncated, setTruncated] = useState(false);
  const [oldestSegmentIndex, setOldestSegmentIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [subagentRuns, setSubagentRuns] = useState<readonly TrajectorySubagentRun[]>(EMPTY_RUNS);
  const [subagentReloadToken, setSubagentReloadToken] = useState(0);
  // Bounded automatic retry after a subagent batch load failure: at most 3 times per runId, with 1.5s backoff.
  const [subagentRetryTick, setSubagentRetryTick] = useState(0);

  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(EMPTY_TURNS);
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [searchQuery, setSearchQuery] = useState("");
  const [actualDuration, setActualDuration] = useState(false);
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null);
  // Numeric row indexes shift when older pages are prepended; selection must follow the
  // business-stable recordId instead.
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [detailsWidth, setDetailsWidth] = useState(DEFAULT_TRAJECTORY_DETAILS_WIDTH);

  const { host, conversationId } = props;
  const loadGeneration = useRef(0);
  const authoritativeRevisionRef = useRef<{ conversationId: string; revision: number } | null>(
    null,
  );
  const subagentLoadEpoch = useRef(0);
  const requestedSubagentRunIds = useRef(new Set<string>());
  const subagentRetryCounts = useRef(new Map<string, number>());
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadingMore(false);
    setPersisted(EMPTY_EVENTS);
    setTruncated(false);
    setOldestSegmentIndex(null);
    subagentLoadEpoch.current += 1;
    requestedSubagentRunIds.current.clear();
    subagentRetryCounts.current.clear();
    setSubagentRuns(EMPTY_RUNS);
    setSubagentReloadToken(0);
    setCollapsedTurns(EMPTY_TURNS);
    setCollapsedAssistants(EMPTY_IDS);
    setSearchQuery("");
    setActualDuration(false);
    setRange(null);
    setSelectedRecordId(null);

    host
      .loadWindow(conversationId)
      .then((payload) => {
        if (generation !== loadGeneration.current) return;
        setPersisted(parseTrajectoryEvents(payload.eventsJson));
        setTruncated(payload.truncated);
        setOldestSegmentIndex(payload.oldestSegmentIndex);
      })
      .catch((error) => {
        if (generation !== loadGeneration.current) return;
        console.warn("[trajectory] failed to load event window", error);
        setPersisted(EMPTY_EVENTS);
        setTruncated(true);
      })
      .finally(() => {
        if (generation === loadGeneration.current) setLoading(false);
      });
    return () => {
      if (generation === loadGeneration.current) loadGeneration.current += 1;
    };
  }, [host, conversationId]);

  const reconcileAuthoritativeWindow = useCallback(() => {
    const generation = ++loadGeneration.current;
    // Keep the last known-good view painted while the authoritative tail is refreshed.
    // Whole replacement (not merge): an edit-resend / rebase during disconnection may have
    // deleted old turns, and merging would resurrect already-pruned events.
    void host
      .loadWindow(conversationId)
      .then((payload) => {
        if (generation !== loadGeneration.current) return;
        setPersisted(parseTrajectoryEvents(payload.eventsJson));
        setTruncated(payload.truncated);
        setOldestSegmentIndex(payload.oldestSegmentIndex);
        setRange(null);
      })
      .catch((error) => {
        if (generation !== loadGeneration.current) return;
        console.warn("[trajectory] failed to reconcile authoritative window", error);
        setTruncated(true);
      })
      .finally(() => {
        if (generation === loadGeneration.current) setLoading(false);
      });

    subagentLoadEpoch.current += 1;
    requestedSubagentRunIds.current.clear();
    setSubagentReloadToken((token) => token + 1);
  }, [host, conversationId]);

  useEffect(() => {
    const revision = props.authoritativeRevision;
    if (revision === undefined) return;
    const previous = authoritativeRevisionRef.current;
    authoritativeRevisionRef.current = { conversationId, revision };
    if (previous === null || previous.conversationId !== conversationId) return;
    if (previous.revision === revision) return;
    reconcileAuthoritativeWindow();
  }, [conversationId, props.authoritativeRevision, reconcileAuthoritativeWindow]);

  useEffect(() => {
    if (host.subscribeRefresh === undefined) return;
    const unsubscribe = host.subscribeRefresh(reconcileAuthoritativeWindow);
    return unsubscribe;
  }, [host, reconcileAuthoritativeWindow]);

  const liveEvents = props.liveEvents ?? EMPTY_EVENTS;
  // Equivalent to the backend's `has_more_before = returned > 0 && oldest > 0`: there are segments
  // before the oldest read boundary. Derived from oldestSegmentIndex rather than a separate state,
  // so "paging backward + tail merging" do not tell different stories.
  const hasMoreBefore = oldestSegmentIndex !== null && oldestSegmentIndex > 0;
  const latestTerminalEventKey = useMemo(() => {
    for (let index = liveEvents.length - 1; index >= 0; index -= 1) {
      const event = liveEvents[index];
      if (event.k === "turn_end" || event.k === "compaction_end") {
        return `${event.k}:${event.t ?? "-"}:${event.at}:${event.st}`;
      }
    }
    return null;
  }, [liveEvents]);

  // Reconcile the desktop-local live tail after recorder flush, and give WebUI the same
  // authoritative convergence point after a completed run. Keep the current view visible;
  // this is a quiet refresh, not a navigation load.
  useEffect(() => {
    if (latestTerminalEventKey === null) return;
    const generation = loadGeneration.current;
    const timer = setTimeout(() => {
      void host
        .loadWindow(conversationId)
        .then((payload) => {
          if (generation !== loadGeneration.current) return;
          // In-process terminal reconciliation merges by event identity: the tail window only adds
          // new events and does not replace everything — an earlier event window the user already
          // paged back to must not be silently reset by one turn ending.
          const fresh = parseTrajectoryEvents(payload.eventsJson);
          setPersisted((current) =>
            fresh.length === 0 ? current : mergeTrajectoryEventWindows(current, fresh),
          );
          setTruncated((current) => current || payload.truncated);
          // After merging, the oldest boundary takes the smaller value, so "load earlier" resumes
          // from the true oldest read segment.
          setOldestSegmentIndex((current) =>
            current === null
              ? payload.oldestSegmentIndex
              : Math.min(current, payload.oldestSegmentIndex),
          );
        })
        .catch((error) => {
          console.warn(
            "[trajectory] terminal reconciliation failed; live tail remains active",
            error,
          );
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [conversationId, host, latestTerminalEventKey]);

  const ledger = useMemo(() => {
    const events = liveEvents.length === 0 ? persisted : [...persisted, ...liveEvents];
    if (events.length > 0) {
      // Interruption convergence: running entries left over after a crash/force-quit converge to
      // aborted. In authoritative mode an empty set also participates in the decision (this
      // process restarting proves it holds no live tail); observed mode keeps the old behavior.
      const liveIdentities =
        props.liveOwnership === "authoritative" || liveEvents.length > 0
          ? trajectoryLiveEventIdentities(liveEvents)
          : undefined;
      return mergeTrajectoryLedgerWithMessages(
        buildTrajectoryLedger(events, { liveIdentities }),
        props.messages,
      );
    }
    // Conversations from before the trajectory feature shipped have no events; the degraded path
    // provides structure but never fabricates timing.
    return deriveLedgerFromMessages(props.messages);
  }, [persisted, liveEvents, props.liveOwnership, props.messages]);

  const referencedSubagentRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const turn of ledger.turns) {
      for (const step of turn.steps) {
        for (const tool of step.tools) {
          for (const runId of tool.subagentRunIds) {
            const normalized = runId.trim();
            if (normalized !== "") ids.add(normalized);
          }
        }
      }
    }
    return [...ids].sort();
  }, [ledger]);

  useEffect(() => {
    void subagentReloadToken;
    const referenced = new Set(referencedSubagentRunIds);
    setSubagentRuns((current) => {
      const retained = current.filter((run) => referenced.has(run.runId));
      return retained.length === current.length ? current : retained;
    });
    if (host.loadSubagentRuns === undefined || referencedSubagentRunIds.length === 0) return;
    const missing = referencedSubagentRunIds.filter(
      (runId) => !requestedSubagentRunIds.current.has(runId),
    );
    if (missing.length === 0) return;
    for (const runId of missing) requestedSubagentRunIds.current.add(runId);
    const epoch = subagentLoadEpoch.current;
    void subagentRetryTick;
    void host
      .loadSubagentRuns(conversationId, missing)
      .then((runs) => {
        if (epoch !== subagentLoadEpoch.current) return;
        for (const runId of missing) subagentRetryCounts.current.delete(runId);
        setSubagentRuns((current) => {
          const byId = new Map(
            current.filter((run) => referenced.has(run.runId)).map((run) => [run.runId, run]),
          );
          for (const run of runs) {
            if (referenced.has(run.runId)) byId.set(run.runId, run);
          }
          return referencedSubagentRunIds.flatMap((runId) => {
            const run = byId.get(runId);
            return run === undefined ? [] : [run];
          });
        });
      })
      .catch((error) => {
        if (epoch !== subagentLoadEpoch.current) return;
        // After a failure, remove from the "requested" set and do a bounded automatic retry: a ref
        // change does not re-run the effect, so explicitly bump a tick here; runIds that exhausted
        // their retries wait for the next ledger change to retry naturally.
        for (const runId of missing) {
          requestedSubagentRunIds.current.delete(runId);
        }
        const retriable = missing.filter((runId) => {
          const attempts = (subagentRetryCounts.current.get(runId) ?? 0) + 1;
          subagentRetryCounts.current.set(runId, attempts);
          return attempts <= SUBAGENT_LOAD_MAX_ATTEMPTS;
        });
        console.warn("[trajectory] failed to load referenced subagent runs", error);
        if (retriable.length > 0) {
          setTimeout(() => setSubagentRetryTick((tick) => tick + 1), SUBAGENT_LOAD_RETRY_DELAY_MS);
        }
      });
  }, [conversationId, host, referencedSubagentRunIds, subagentReloadToken, subagentRetryTick]);

  const content = useMemo(
    () => buildTrajectoryContentIndex(props.messages, ledger),
    [props.messages, ledger],
  );
  const turns = useMemo(
    () => deriveTrajectoryLayout({ ledger, content, subagentRuns }),
    [ledger, content, subagentRuns],
  );

  const searchIndex = useMemo(() => new TrajectorySearchIndex(), []);
  const layouts = useMemo(() => [turns] as const, [turns]);
  const searchMatchIndexes = useMemo(() => {
    if (searchQuery.trim() === "") return null;
    searchIndex.update(layouts);
    return trajectorySearchMatchIndexes(layouts, searchIndex.search(searchQuery));
  }, [searchIndex, layouts, searchQuery]);

  const hasTiming = ledger.hasTiming;
  const hasPartialTiming = trajectoryLedgerHasPartialTiming(ledger);
  const notice = truncated
    ? t("trajectory.truncated")
    : !hasTiming
      ? t("trajectory.degraded")
      : hasPartialTiming
        ? t("trajectory.partialTiming")
        : null;
  const mode: TrajectoryTimelineMode = hasTiming && actualDuration ? "duration" : "sequence";
  const timelineFocusIndexes = useMemo(
    () => (range === null ? null : trajectoryTimelineFocusIndexes(turns, range, mode)),
    [range, turns, mode],
  );

  const { recordsByIndex, recordsById } = useMemo(() => {
    const byIndex = new Map<number, TrajectoryRecord>();
    const byId = new Map<string, TrajectoryRecord>();
    for (const turn of turns) {
      for (const group of turn.groups) {
        for (const record of group.records) {
          byIndex.set(record.index, record);
          byId.set(record.recordId, record);
        }
      }
    }
    return { recordsByIndex: byIndex, recordsById: byId };
  }, [turns]);
  const selectedRecord =
    selectedRecordId === null ? null : (recordsById.get(selectedRecordId) ?? null);
  const selectedIndex = selectedRecord?.index ?? null;
  const selectRecordAtIndex = useCallback(
    (index: number) => setSelectedRecordId(recordsByIndex.get(index)?.recordId ?? null),
    [recordsByIndex],
  );

  const collapsibleTurns = useMemo(() => collapsibleTrajectoryTurns(turns), [turns]);
  const collapsibleAssistants = useMemo(() => collapsibleTrajectoryAssistants(turns), [turns]);
  const allTurnsCollapsed =
    collapsibleTurns.length > 0 && collapsibleTurns.every((turn) => collapsedTurns.has(turn));
  const allCallsCollapsed =
    collapsibleAssistants.length > 0 &&
    collapsibleAssistants.every((id) => collapsedAssistants.has(id));

  const loadEarlier = useCallback(async () => {
    const canLoadEvents = hasMoreBefore && oldestSegmentIndex !== null;
    const canLoadMessages =
      props.hasMoreMessages === true && props.loadEarlierMessages !== undefined;
    if (loadingMore || (!canLoadEvents && !canLoadMessages)) return;
    const generation = loadGeneration.current;
    setLoadingMore(true);
    try {
      const [payload] = await Promise.all([
        canLoadEvents
          ? host.loadWindow(conversationId, oldestSegmentIndex ?? undefined)
          : Promise.resolve(null),
        canLoadMessages ? Promise.resolve(props.loadEarlierMessages?.()) : Promise.resolve(),
      ]);
      if (generation !== loadGeneration.current) return;
      // Message-only pagination also prepends visual records and shifts numeric projection indexes.
      setRange(null);
      if (payload === null) return;
      const older = parseTrajectoryEvents(payload.eventsJson);
      setPersisted((current) =>
        older.length === 0 ? current : mergeTrajectoryEventWindows(older, current),
      );
      setTruncated((current) => current || payload.truncated);
      setOldestSegmentIndex(payload.oldestSegmentIndex);
    } catch (error) {
      if (generation === loadGeneration.current) {
        console.warn("[trajectory] failed to load earlier data", error);
        setTruncated(true);
      }
    } finally {
      if (generation === loadGeneration.current) setLoadingMore(false);
    }
  }, [
    conversationId,
    hasMoreBefore,
    host,
    loadingMore,
    oldestSegmentIndex,
    props.hasMoreMessages,
    props.loadEarlierMessages,
  ]);

  const loadSections = useCallback(
    (sectionIds: readonly string[]) => host.loadSections(conversationId, sectionIds),
    [host, conversationId],
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        {t("trajectory.loading")}
      </div>
    );
  }

  return (
    <div className="@container flex h-full min-h-0 flex-1 flex-col">
      <TrajectoryToolbar
        actualDuration={actualDuration}
        hasTiming={hasTiming}
        onActualDurationChange={(next) => {
          setActualDuration(next);
          setRange(null);
        }}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={() =>
          setCollapsedTurns(allTurnsCollapsed ? EMPTY_TURNS : new Set(collapsibleTurns))
        }
        allCallsCollapsed={allCallsCollapsed}
        onToggleAllCalls={() =>
          setCollapsedAssistants(allCallsCollapsed ? EMPTY_IDS : new Set(collapsibleAssistants))
        }
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
      />

      {(hasMoreBefore || props.hasMoreMessages === true) && (
        <div className="shrink-0 border-b border-border/60 px-3 py-1.5 text-center">
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-60"
            disabled={loadingMore}
            onClick={() => void loadEarlier()}
          >
            {loadingMore ? t("trajectory.loadingEarlier") : t("trajectory.loadEarlier")}
          </button>
        </div>
      )}

      {notice !== null && (
        <p className="shrink-0 border-b border-border/60 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
          {notice}
        </p>
      )}

      <TrajectoryTimeline
        turns={turns}
        mode={mode}
        range={range}
        selectedIndex={selectedIndex}
        searchMatchIndexes={searchMatchIndexes}
        onRangeChange={setRange}
        onRecordSelect={selectRecordAtIndex}
      />

      {/* In narrow containers (small windows/mobile) the left/right split squeezes each other, so switch to a top/bottom layout. */}
      <div
        ref={contentRef}
        className="relative flex min-h-0 flex-1 overflow-hidden @max-[640px]:flex-col"
      >
        <TrajectoryTable
          turns={turns}
          collapsedTurns={collapsedTurns}
          collapsedAssistants={collapsedAssistants}
          searchMatchIndexes={searchMatchIndexes}
          timelineFocusIndexes={timelineFocusIndexes}
          selectedIndex={selectedIndex}
          onSelect={selectRecordAtIndex}
          onToggleTurn={(turn) =>
            setCollapsedTurns((current) => {
              const next = new Set(current);
              if (next.has(turn)) next.delete(turn);
              else next.add(turn);
              return next;
            })
          }
        />
        <TrajectoryDetailsPanel
          record={selectedRecord}
          header={
            selectedRecord?.headerId === undefined
              ? undefined
              : ledger.headers.get(selectedRecord.headerId)
          }
          previousHeader={
            selectedRecord?.previousHeaderId === undefined
              ? undefined
              : ledger.headers.get(selectedRecord.previousHeaderId)
          }
          loadSections={loadSections}
          workdir={props.workdir}
          onOpenFileLink={host.openFileLink}
          onClose={() => setSelectedRecordId(null)}
          containerRef={contentRef}
          width={detailsWidth}
          onWidthChange={setDetailsWidth}
        />
      </div>
    </div>
  );
}
