/**
 * Timeline projection: compress ledger records onto three swimlanes.
 *
 * Two domains: `sequence` lays each record out in order with equal width, answering "how many
 * steps, what shape"; `duration` sizes by real elapsed time and compresses idle gaps, answering
 * "where did the time go".
 *
 * A degraded ledger (derived from messages, no timing) must be locked to `sequence`: `duration`
 * would degenerate into an empty model because all records have startedAt null.
 */

import type {
  TrajectoryRecord,
  TrajectoryRecordKind,
  TrajectoryStatus,
  TrajectoryTurnModel,
} from "./types";

/** Horizontal projection mode. */
export type TrajectoryTimelineMode = "sequence" | "duration";

/** A closed-interval selection within the current projection domain. */
export type TrajectoryTimeRange = {
  start: number;
  end: number;
};

/** The position of one record within the current projection domain. */
export type TrajectoryTimelineSpan = TrajectoryTimeRange & {
  index: number;
  kind: TrajectoryRecordKind;
  isError: boolean;
  label: string;
  lane: number;
  /** Row offset within the lane: parallel records each occupy a row (starting at 0), making concurrency visible. */
  row: number;
  status: TrajectoryStatus;
};

/** The position of one turn segment within the current projection domain; the turn band draws the whole segment with it. */
export type TrajectoryTimelineTurnBoundary = {
  turn: number;
  time: number;
  /** Right edge of the turn segment (projection domain, with the same open-interval semantics as span.end). */
  end: number;
  /**
   * The turn's net active milliseconds: the coverage of the union of all records' original time
   * intervals within the turn (parallel tool overlaps count once, idle gaps within the turn do not
   * count). Independent of the projection mode -- in sequence, time/end are sequence numbers and
   * their difference cannot be taken as time, so the turn band's number is governed by this field.
   */
  activeMs: number | null;
};

/** Idle gaps compressed away in duration mode: projected position + original milliseconds. */
export type TrajectoryTimelineIdleGap = {
  at: number;
  ms: number;
};

export type TrajectoryTimelineModel = TrajectoryTimeRange & {
  spans: readonly TrajectoryTimelineSpan[];
  turnBoundaries: readonly TrajectoryTimelineTurnBoundary[];
  /** Rows occupied per lane (≥1); the tool lane has more rows the more parallelism there is. */
  laneRows: readonly [number, number, number];
  /** Compressed-away idle gaps; always empty in sequence mode. */
  idleGaps: readonly TrajectoryTimelineIdleGap[];
};

/** Three lanes: 0 Input, 1 Model, 2 Tools. */
export const TRAJECTORY_TIMELINE_LANES = 3;

/** Maximum row offsets in a single lane; beyond that, parallel records tolerate slight overlap to avoid inflating the timeline. */
const MAX_LANE_ROWS = 4;
/** Floating-point tolerance: abutting intervals do not count as overlapping. */
const OVERLAP_EPSILON = 1e-6;

export function trajectoryLaneFor(kind: TrajectoryRecordKind): number {
  if (kind === "tool" || kind === "subtool") return 2;
  if (kind === "message" || kind === "compacted") return 1;
  return 0;
}

function isFinite_(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function visibleRecords(turn: TrajectoryTurnModel): TrajectoryRecord[] {
  return turn.groups.flatMap((group) =>
    group.records.filter((record) => record.requestOnly !== true),
  );
}

function spanOf(record: TrajectoryRecord): TrajectoryTimeRange | null {
  if (!isFinite_(record.startedAt)) return null;
  const durationMs = isFinite_(record.timeSeconds) ? Math.max(0, record.timeSeconds * 1000) : 0;
  return { start: record.startedAt, end: record.startedAt + durationMs };
}

/** Coverage of the union of intervals: parallel overlaps count once; returns null when there is no positive duration at all. */
function unionCoverageMs(ranges: readonly TrajectoryTimeRange[]): number | null {
  const ordered = [...ranges].sort((left, right) => left.start - right.start);
  let total = 0;
  let coveredUntil: number | null = null;
  for (const range of ordered) {
    if (coveredUntil !== null && range.end <= coveredUntil) continue;
    // Only add the part beyond what is already covered: gaps detached from the covered intervals do not count.
    const addFrom = coveredUntil === null ? range.start : Math.max(range.start, coveredUntil);
    total += range.end - addFrom;
    coveredUntil = range.end;
  }
  return total > 0 ? total : null;
}

/** The turn's net active milliseconds: the union of visible records' original intervals within the turn. */
function turnActiveMs(records: readonly TrajectoryRecord[]): number | null {
  const ranges = records
    .map((record) => spanOf(record))
    .filter((range): range is TrajectoryTimeRange => range !== null);
  return unionCoverageMs(ranges);
}

function toSpan(record: TrajectoryRecord, range: TrajectoryTimeRange): TrajectoryTimelineSpan {
  return {
    ...range,
    index: record.index,
    kind: record.kind,
    isError: record.isError,
    label: record.text,
    lane: trajectoryLaneFor(record.kind),
    row: 0,
    status: record.status,
  };
}

/**
 * Row packing within a lane: scan once by start time, placing abutting-or-later records into
 * already-occupied rows and opening a new row for overlapping ones. The row cap is
 * {@link MAX_LANE_ROWS}; anything beyond goes into the earliest-ending row (tolerating slight
 * overlap). Writes span.row in place and returns the row count per lane.
 */
function packLaneRows(spans: TrajectoryTimelineSpan[]): [number, number, number] {
  const rowEnds: number[][] = [[], [], []];
  const ordered = [...spans].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  for (const span of ordered) {
    const ends = rowEnds[span.lane];
    let row = ends.findIndex((end) => span.start >= end - OVERLAP_EPSILON);
    if (row === -1 && ends.length < MAX_LANE_ROWS) {
      ends.push(span.end);
      row = ends.length - 1;
    } else if (row === -1) {
      row = ends.indexOf(Math.min(...ends));
      ends[row] = span.end;
    } else {
      ends[row] = Math.max(ends[row], span.end);
    }
    span.row = row;
  }
  return [
    Math.max(1, rowEnds[0].length),
    Math.max(1, rowEnds[1].length),
    Math.max(1, rowEnds[2].length),
  ];
}

function deriveSequenceTimeline(
  turns: readonly TrajectoryTurnModel[],
): TrajectoryTimelineModel | null {
  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];

  for (const turn of turns) {
    const records = visibleRecords(turn);
    if (records.length === 0) continue;
    const base = spans.length;
    if (turn.turn !== null)
      turnBoundaries.push({
        turn: turn.turn,
        time: base,
        end: base + records.length,
        activeMs: turnActiveMs(records),
      });
    spans.push(
      ...records.map((record, offset) =>
        toSpan(record, { start: base + offset, end: base + offset + 1 }),
      ),
    );
  }

  if (spans.length === 0) return null;
  // In sequence, each record occupies its own unit interval, so the same lane never overlaps naturally; packing is purely a formality.
  const laneRows = packLaneRows(spans);
  return { start: 0, end: spans.length, spans, turnBoundaries, laneRows, idleGaps: [] };
}

function deriveDurationTimeline(
  turns: readonly TrajectoryTurnModel[],
): TrajectoryTimelineModel | null {
  const timedTurns = turns.flatMap((turn) => {
    const rawSpans = visibleRecords(turn).flatMap((record) => {
      const range = spanOf(record);
      return range === null ? [] : [toSpan(record, range)];
    });
    return rawSpans.length === 0 ? [] : [{ turn: turn.turn, rawSpans }];
  });
  const rawSpans = timedTurns.flatMap((entry) => entry.rawSpans);
  if (rawSpans.length === 0) return null;

  // Idle compression: scan all intervals by start time, accumulating the durations "covered by no
  // operation", and shift subsequent intervals left by that amount. Gaps where a person waits for
  // the model or for themselves thus no longer fill the whole chart. Each removed gap records its
  // projected position and original milliseconds, and the view layer marks it with hatching, so the
  // compression is no longer silent.
  const idleGaps: TrajectoryTimelineIdleGap[] = [];
  const removedIdleBySpan = new Map<TrajectoryTimelineSpan, number>();
  let removedIdle = 0;
  let coveredUntil: number | null = null;
  for (const span of [...rawSpans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    if (coveredUntil !== null && span.start > coveredUntil) {
      const ms = span.start - coveredUntil;
      idleGaps.push({ at: coveredUntil - removedIdle, ms });
      removedIdle += ms;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
  for (const entry of timedTurns) {
    const projected = entry.rawSpans.map((span): TrajectoryTimelineSpan => {
      const offset = removedIdleBySpan.get(span) ?? 0;
      return { ...span, start: span.start - offset, end: span.end - offset };
    });
    spans.push(...projected);
    if (entry.turn !== null) {
      turnBoundaries.push({
        turn: entry.turn,
        time: Math.min(...projected.map((span) => span.start)),
        end: Math.max(...projected.map((span) => span.end)),
        activeMs: unionCoverageMs(entry.rawSpans),
      });
    }
  }

  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
    spans,
    turnBoundaries,
    laneRows: packLaneRows(spans),
    idleGaps,
  };
}

/**
 * Project visible records onto the three-lane timeline.
 *
 * @param turns - Unfiltered layout result.
 * @param mode - Projection mode.
 * @returns The timeline model; null when there are no visible records.
 */
export function deriveTrajectoryTimeline(
  turns: readonly TrajectoryTurnModel[],
  mode: TrajectoryTimelineMode = "sequence",
): TrajectoryTimelineModel | null {
  return mode === "duration" ? deriveDurationTimeline(turns) : deriveSequenceTimeline(turns);
}

/**
 * Find the record indexes intersecting the selection.
 *
 * @param turns - Unfiltered layout result.
 * @param range - Closed interval within the current projection domain.
 * @param mode - Projection mode; must match the mode that produced range.
 * @returns The set of matched record indexes.
 */
export function trajectoryTimelineFocusIndexes(
  turns: readonly TrajectoryTurnModel[],
  range: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode = "sequence",
): ReadonlySet<number> {
  const model = deriveTrajectoryTimeline(turns, mode);
  return new Set(
    model?.spans
      .filter((span) => span.start <= range.end && span.end >= range.start)
      .map((span) => span.index),
  );
}

/** Millisecond duration label, with thousands separators. */
export function formatTrajectoryDurationMs(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  return `${Math.round(milliseconds).toLocaleString("en-US")} ms`;
}

/** Seconds duration label, presented internally in milliseconds. */
export function formatTrajectoryElapsedSeconds(seconds: number | null): string {
  return formatTrajectoryDurationMs(seconds === null ? null : seconds * 1000);
}
