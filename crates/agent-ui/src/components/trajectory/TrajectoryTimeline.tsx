/**
 * Three-swimlane timeline.
 *
 * It does only two things: draw the projection model, and translate gestures into "selection range" and "select a record". All
 * projection computation lives in `lib/trajectory/timeline.ts`; this file contains no time semantics.
 *
 * Top to bottom: turn number band -> three swimlanes (the tool lane staggers parallel rows) -> time ruler -> minimap
 * overview bar. In duration mode, compressed idle gaps are marked with diagonal stripes and no longer silently disappear.
 */

import { type CSSProperties, useMemo, useRef, useState } from "react";
import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import {
  formatTrajectoryClock,
  formatTrajectoryDuration,
  trajectoryAssistantSegments,
  trajectoryKindLabelKey,
} from "../../lib/trajectory/presentation";
import {
  deriveTrajectoryTimeline,
  type TrajectoryTimelineMode,
  type TrajectoryTimelineModel,
  type TrajectoryTimelineSpan,
  type TrajectoryTimeRange,
} from "../../lib/trajectory/timeline";
import type {
  TrajectoryRecord,
  TrajectoryRecordKind,
  TrajectoryTurnModel,
} from "../../lib/trajectory/types";
import { useMinimapGestures, useTimelineGestures } from "./useTimelineGestures";

const LANE_LABEL_KEYS = [
  "trajectory.timeline.laneInput",
  "trajectory.timeline.laneModel",
  "trajectory.timeline.laneTools",
] as const;

const SPAN_TONE: Record<TrajectoryRecordKind, string> = {
  system: "bg-slate-500/80",
  user: "bg-slate-700 dark:bg-slate-300",
  context: "bg-emerald-500/80",
  compacted: "bg-amber-500/80",
  message: "bg-violet-500/80",
  tool: "bg-orange-500/85",
  subtool: "bg-orange-400/70",
};

/** Interrupted entries get a diagonal-stripe overlay to be distinguishable at a glance from "finished but very short". */
const ABORTED_HATCH =
  "repeating-linear-gradient(45deg, transparent 0 2px, rgba(0,0,0,0.28) 2px 3px)";
/** Idle gaps compressed away in duration mode. */
const IDLE_HATCH =
  "repeating-linear-gradient(45deg, transparent 0 2px, rgba(100,116,139,0.35) 2px 4px)";

const TURN_BAND_HEIGHT = 14;
const LANE_ROW_PITCH = 14;
const SPAN_BAR_HEIGHT = 10;
const RULER_HEIGHT = 13;
const MINIMAP_HEIGHT = 20;
const IDLE_GAP_WIDTH_PX = 10;

const EMPTY_TIMELINE_MODEL: TrajectoryTimelineModel = {
  start: 0,
  end: 1,
  spans: [],
  turnBoundaries: [],
  laneRows: [1, 1, 1],
  idleGaps: [],
};

export function TrajectoryTimeline(props: {
  turns: readonly TrajectoryTurnModel[];
  mode: TrajectoryTimelineMode;
  range: TrajectoryTimeRange | null;
  selectedIndex: number | null;
  searchMatchIndexes: ReadonlySet<number> | null;
  onRangeChange: (range: TrajectoryTimeRange | null) => void;
  onRecordSelect: (index: number) => void;
}) {
  const { t, locale } = useLocale();
  const trackRef = useRef<HTMLButtonElement | null>(null);
  const minimapRef = useRef<HTMLButtonElement | null>(null);
  const [hovered, setHovered] = useState<{ index: number; leftPct: number } | null>(null);

  const model = useMemo(
    () => deriveTrajectoryTimeline(props.turns, props.mode),
    [props.turns, props.mode],
  );
  const recordsByIndex = useMemo(() => {
    const map = new Map<number, TrajectoryRecord>();
    for (const turn of props.turns) {
      for (const group of turn.groups) {
        for (const record of group.records) map.set(record.index, record);
      }
    }
    return map;
  }, [props.turns]);

  const activeModel = model ?? EMPTY_TIMELINE_MODEL;
  const gestures = useTimelineGestures({
    trackRef,
    model: activeModel,
    range: props.range,
    minimumSpan: props.mode === "sequence" ? 0.25 : 1,
    onRangeChange: props.onRangeChange,
    onRecordSelect: props.onRecordSelect,
  });
  const minimap = useMinimapGestures({
    minimapRef,
    model: activeModel,
    viewport: gestures.viewport,
    onRangeChange: props.onRangeChange,
  });
  if (model === null) return null;

  const viewport = gestures.viewport;
  const domainSpan = Math.max(Number.EPSILON, viewport.end - viewport.start);
  const pct = (value: number) => ((value - viewport.start) / domainSpan) * 100;

  const laneTops = [0, 1, 2].map((lane) => {
    let top = TURN_BAND_HEIGHT;
    for (let earlier = 0; earlier < lane; earlier += 1)
      top += model.laneRows[earlier] * LANE_ROW_PITCH;
    return top;
  });
  const trackHeight =
    TURN_BAND_HEIGHT + model.laneRows.reduce((sum, rows) => sum + rows * LANE_ROW_PITCH, 0);
  const visibleSpans = model.spans.filter(
    (span) => span.start <= viewport.end && span.end >= viewport.start,
  );
  const ticks = rulerTicks(model, viewport, props.mode);
  const turnStatuses = new Map(
    model.turnBoundaries.map((boundary) => [
      boundary.turn,
      turnStatusOf(model.spans, boundary.time, boundary.end),
    ]),
  );
  const hoveredRecord = hovered === null ? null : (recordsByIndex.get(hovered.index) ?? null);
  const nowAt = nowCursorAt(visibleSpans, viewport);

  return (
    <section
      aria-label={t("trajectory.timeline.aria")}
      className="flex shrink-0 gap-2 border-b border-border/60 px-3 pt-1.5 pb-2 @max-[520px]:gap-1 @max-[520px]:px-2"
    >
      <div
        className="flex w-11 shrink-0 flex-col @max-[520px]:w-8"
        style={{ paddingTop: TURN_BAND_HEIGHT }}
      >
        {LANE_LABEL_KEYS.map((key, lane) => (
          <div
            key={key}
            className="flex items-center text-[10px] leading-[14px] text-muted-foreground"
            style={{ height: model.laneRows[lane] * LANE_ROW_PITCH }}
          >
            <span className="truncate">{t(key)}</span>
          </div>
        ))}
      </div>

      <div className="relative flex min-w-0 flex-1 flex-col gap-1">
        <button
          ref={trackRef}
          type="button"
          // The track itself is the click target (clicking locates the nearest record), so use a real button rather than
          // a div with tabIndex: natively focusable, native semantics, and Esc clearing the selection is bound to its own
          // keyboard contract. Inside there are only decorative spans, so no interactive nesting is formed.
          aria-label={t("trajectory.timeline.hint")}
          className="relative block w-full cursor-crosshair touch-none select-none text-left"
          style={{ height: trackHeight }}
          title={t("trajectory.timeline.hint")}
          onPointerDown={gestures.onPointerDown}
          onPointerMove={gestures.onPointerMove}
          onPointerUp={gestures.onPointerUp}
          onPointerCancel={gestures.cancel}
          onWheel={gestures.onWheel}
          onDoubleClick={() => props.onRangeChange(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && props.range !== null) {
              event.preventDefault();
              props.onRangeChange(null);
            }
          }}
        >
          {/* Turn number band */}
          {model.turnBoundaries
            .filter((boundary) => boundary.end >= viewport.start && boundary.time <= viewport.end)
            .map((boundary) => {
              const left = Math.max(0, pct(boundary.time));
              const width = Math.max(
                14,
                Math.min(pct(boundary.end), 100) - Math.max(pct(boundary.time), 0),
              );
              // turnStatuses is built with turnBoundaries as the key source and theoretically cannot miss; this fallback prevents
              // the whole timeline from crashing if the key source changes in the future.
              const status = turnStatuses.get(boundary.turn) ?? "complete";
              return (
                <span
                  key={boundary.turn}
                  aria-hidden="true"
                  title={turnChipTitle({
                    turn: boundary.turn,
                    status,
                    activeMs: boundary.activeMs,
                    statusLabel: t(`trajectory.status.${status}`),
                  })}
                  className={cn(
                    "absolute top-0 flex h-[12px] items-center gap-1 overflow-hidden rounded-xs px-1 text-[9px] leading-none",
                    status === "running"
                      ? "bg-primary/15 text-primary"
                      : status === "error"
                        ? "bg-red-500/15 text-red-500"
                        : "bg-muted text-muted-foreground",
                  )}
                  style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                >
                  {`T${boundary.turn}`}
                  {status === "running" ? (
                    <span className="inline-block size-[4px] animate-pulse rounded-full bg-current" />
                  ) : status === "error" ? (
                    "✕"
                  ) : (
                    "✓"
                  )}
                  {boundary.activeMs !== null && formatCompactMs(boundary.activeMs)}
                </span>
              );
            })}

          {/* Swimlane body */}
          {visibleSpans.map((span) => {
            const record = recordsByIndex.get(span.index);
            const segments = record === undefined ? null : trajectoryAssistantSegments(record);
            const ttftShare =
              segments === null || segments.ttftMs + segments.decodingMs <= 0
                ? null
                : segments.ttftMs / (segments.ttftMs + segments.decodingMs);
            const dimmed =
              props.searchMatchIndexes !== null && !props.searchMatchIndexes.has(span.index);
            const spanStyle: CSSProperties = {
              left: `${Math.max(0, pct(Math.max(span.start, viewport.start)))}%`,
              width: `max(2px, ${
                Math.min(pct(Math.min(span.end, viewport.end)), 100) -
                Math.max(pct(Math.max(span.start, viewport.start)), 0)
              }%)`,
              top: `${laneTops[span.lane] + span.row * LANE_ROW_PITCH + (LANE_ROW_PITCH - SPAN_BAR_HEIGHT) / 2}px`,
              height: SPAN_BAR_HEIGHT,
            };
            if (span.status === "aborted") spanStyle.backgroundImage = ABORTED_HATCH;
            return (
              <span
                key={span.index}
                aria-hidden="true"
                className={cn(
                  "absolute overflow-hidden rounded-xs transition-opacity",
                  span.isError ? "bg-red-500/85" : SPAN_TONE[span.kind],
                  span.status === "running" && "animate-pulse",
                  dimmed && "opacity-25",
                  props.selectedIndex === span.index && "ring-1 ring-primary",
                )}
                style={spanStyle}
                onPointerEnter={() =>
                  setHovered({
                    index: span.index,
                    leftPct: Math.max(4, Math.min(pct((span.start + span.end) / 2), 96)),
                  })
                }
                onPointerLeave={() => setHovered(null)}
              >
                {ttftShare !== null && (
                  // TTFT and decoding are color-coded within the same block: waiting for the model and actually emitting tokens are two different things, and merging them
                  // would make the question "where is it slow" unanswerable.
                  <span
                    className="absolute inset-y-0 left-0 bg-black/25"
                    style={{ width: `${ttftShare * 100}%` }}
                  />
                )}
              </span>
            );
          })}

          {/* Compressed idle gaps: marked with diagonal stripes; the width is a fixed visual placeholder, not data. */}
          {props.mode === "duration" &&
            model.idleGaps
              .filter((gap) => gap.at >= viewport.start && gap.at <= viewport.end)
              .map((gap) => (
                <span
                  key={gap.at}
                  aria-hidden="true"
                  title={`${t("trajectory.timeline.idleGap")} · ${formatCompactMs(gap.ms)}`}
                  className="absolute"
                  style={{
                    left: `calc(${pct(gap.at)}% - ${IDLE_GAP_WIDTH_PX / 2}px)`,
                    top: TURN_BAND_HEIGHT,
                    bottom: 0,
                    width: IDLE_GAP_WIDTH_PX,
                    backgroundImage: IDLE_HATCH,
                  }}
                />
              ))}

          {/* Turn vertical line */}
          {model.turnBoundaries
            .filter((boundary) => boundary.time > viewport.start && boundary.time < viewport.end)
            .map((boundary) => (
              <span
                key={boundary.turn}
                aria-hidden="true"
                className="absolute top-0 bottom-0 w-px bg-border"
                style={{ left: `${pct(boundary.time)}%` }}
              />
            ))}

          {/* In-progress now cursor */}
          {nowAt !== null && (
            <span
              aria-hidden="true"
              title={t("trajectory.timeline.now")}
              className="absolute top-0 bottom-0 w-px animate-pulse bg-primary/70"
              style={{ left: `${pct(nowAt)}%` }}
            />
          )}

          {gestures.draft !== null && (
            <span
              aria-hidden="true"
              className="absolute top-0 bottom-0 border-x border-primary/60 bg-primary/10"
              style={{
                left: `${gestures.draft.start * 100}%`,
                width: `${Math.max(0, gestures.draft.end - gestures.draft.start) * 100}%`,
              }}
            />
          )}
        </button>

        {/* Hover card: replaces the native title, follows hover state, and does not appear during drag selection. */}
        {hoveredRecord !== null && gestures.draft === null && hovered !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 z-10 max-w-[320px] -translate-x-1/2 -translate-y-full whitespace-pre-wrap break-all rounded-md border bg-popover px-2 py-1 text-[11px] leading-snug text-popover-foreground shadow-md"
            style={{ left: `${hovered.leftPct}%`, top: trackHeight + 4 }}
          >
            {spanTooltip({
              kindLabel: t(trajectoryKindLabelKey(hoveredRecord.kind)),
              record: hoveredRecord,
              locale,
              statusLabel: t(`trajectory.status.${hoveredRecord.status}`),
              totalLabel: t("trajectory.metric.total"),
              ttftLabel: t("trajectory.metric.ttft"),
              decodingLabel: t("trajectory.metric.decoding"),
            })}
          </div>
        )}

        {/* Time ruler */}
        <div className="relative w-full border-t border-border/60" style={{ height: RULER_HEIGHT }}>
          {ticks.map((tick) => (
            <span
              key={tick.at}
              aria-hidden="true"
              className="absolute bottom-0 top-0 text-[9px] leading-[13px] text-muted-foreground"
              style={{ left: `${pct(tick.at)}%` }}
            >
              <span className="absolute bottom-0 left-0 h-[3px] w-px bg-border" />
              <span className="absolute left-1 whitespace-nowrap">{tick.label}</span>
            </span>
          ))}
        </div>

        {/* minimap overview bar: full model domain + current viewport window box. */}
        <button
          ref={minimapRef}
          type="button"
          aria-label={t("trajectory.timeline.minimapHint")}
          title={t("trajectory.timeline.minimapHint")}
          className="relative block w-full cursor-pointer touch-none select-none rounded-xs bg-muted/40"
          style={{ height: MINIMAP_HEIGHT }}
          onPointerDown={minimap.onPointerDown}
          onPointerMove={minimap.onPointerMove}
          onPointerUp={minimap.onPointerUp}
          onPointerCancel={minimap.cancel}
          onDoubleClick={() => props.onRangeChange(null)}
          onKeyDown={(event) => {
            const span = gestures.viewport.end - gestures.viewport.start;
            const center = (gestures.viewport.start + gestures.viewport.end) / 2;
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const direction = event.key === "ArrowLeft" ? -1 : 1;
              props.onRangeChange({
                start: center + direction * span * 0.2 - span / 2,
                end: center + direction * span * 0.2 + span / 2,
              });
            } else if (event.key === "Escape") {
              event.preventDefault();
              props.onRangeChange(null);
            }
          }}
        >
          {model.spans.map((span) => {
            const fullSpan = Math.max(Number.EPSILON, model.end - model.start);
            const left = ((span.start - model.start) / fullSpan) * 100;
            const width = Math.max(0.3, ((span.end - span.start) / fullSpan) * 100);
            return (
              <span
                key={span.index}
                aria-hidden="true"
                className={cn(
                  "absolute rounded-full",
                  span.isError ? "bg-red-500/80" : SPAN_TONE[span.kind],
                )}
                style={{
                  left: `${left}%`,
                  width: `max(2px, ${width}%)`,
                  top: 2 + span.lane * 6,
                  height: 4,
                  opacity: 0.75,
                }}
              />
            );
          })}
          {model.idleGaps.map((gap) => {
            const fullSpan = Math.max(Number.EPSILON, model.end - model.start);
            return (
              <span
                key={gap.at}
                aria-hidden="true"
                className="absolute w-[2px]"
                style={{
                  left: `${((gap.at - model.start) / fullSpan) * 100}%`,
                  top: 1,
                  bottom: 1,
                  backgroundImage: IDLE_HATCH,
                }}
              />
            );
          })}
          {(() => {
            const fullSpan = Math.max(Number.EPSILON, model.end - model.start);
            const left = ((viewport.start - model.start) / fullSpan) * 100;
            const width = Math.max(1.5, ((viewport.end - viewport.start) / fullSpan) * 100);
            return (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 rounded-xs border-x border-primary/80 bg-primary/10"
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            );
          })()}
        </button>
      </div>
    </section>
  );
}

type TurnStatus = "running" | "error" | "complete";

/** Turn status only looks at member records; duration uses boundary.activeMs (net active milliseconds, independent of projection mode). */
function turnStatusOf(
  spans: readonly TrajectoryTimelineSpan[],
  from: number,
  to: number,
): TurnStatus {
  let status: TurnStatus = "complete";
  for (const span of spans) {
    if (span.start < from || span.start > to) continue;
    if (span.status === "running") status = "running";
    else if (status !== "running" && (span.isError || span.status === "error")) status = "error";
  }
  return status;
}

/** Latest right edge of running entries: where the now cursor lands. */
function nowCursorAt(
  spans: readonly TrajectoryTimelineSpan[],
  viewport: TrajectoryTimeRange,
): number | null {
  let latest: number | null = null;
  for (const span of spans) {
    if (span.status !== "running") continue;
    if (latest === null || span.end > latest) latest = span.end;
  }
  if (latest === null || latest < viewport.start || latest > viewport.end) return null;
  return latest;
}

function rulerTicks(
  model: TrajectoryTimelineModel,
  viewport: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode,
): Array<{ at: number; label: string }> {
  const span = viewport.end - viewport.start;
  if (!(span > 0)) return [];
  const step = niceStep(span / 6, 1);
  const base = mode === "duration" ? model.start : 0;
  const first = Math.ceil((viewport.start - base) / step - 1e-9) * step + base;
  const ticks: Array<{ at: number; label: string }> = [];
  for (let value = first; value <= viewport.end + 1e-9; value += step) {
    if (value < viewport.start - 1e-9) continue;
    const label =
      mode === "sequence"
        ? `${Math.round(value)}`
        : formatCompactMs(Math.max(0, value - model.start));
    ticks.push({ at: value, label });
    if (ticks.length > 24) break;
  }
  return ticks;
}

/** Take a tidy step >= target from the 1/2/5 sequence. */
function niceStep(target: number, minimum: number): number {
  if (!(target > 0)) return minimum;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const mantissa of [1, 2, 5, 10]) {
    const candidate = mantissa * magnitude;
    if (candidate >= target) return Math.max(candidate, minimum);
  }
  return 10 * magnitude;
}

/** Compact duration: the short labels used by the ruler and turn band. */
function formatCompactMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function turnChipTitle(params: {
  turn: number;
  status: TurnStatus;
  activeMs: number | null;
  statusLabel: string;
}): string {
  const parts = [`T${params.turn}`, params.statusLabel];
  if (params.activeMs !== null) parts.push(formatCompactMs(params.activeMs));
  return parts.join(" · ");
}

/** Hover card body limit: long replies are truncated for display; the full text is in the event list below. */
const TOOLTIP_TEXT_MAX_CHARS = 200;

function spanTooltip(params: {
  kindLabel: string;
  record: TrajectoryRecord | undefined;
  locale: string;
  statusLabel: string;
  totalLabel: string;
  ttftLabel: string;
  decodingLabel: string;
}): string {
  const { record, locale } = params;
  if (record === undefined) return params.kindLabel;
  const lines: string[] = [params.kindLabel];
  if (record.text !== "") {
    // Truncate long original text (same compression + cap pattern as layout.ts previewLine), otherwise an overlong assistant
    // text would burst the hover card into a white box.
    const collapsed = record.text.replace(/\s+/g, " ").trim();
    lines.push(
      collapsed.length > TOOLTIP_TEXT_MAX_CHARS
        ? `${collapsed.slice(0, TOOLTIP_TEXT_MAX_CHARS)}…`
        : collapsed,
    );
  }
  lines.push(params.statusLabel);
  if (record.startedAt !== null) {
    lines.push(formatTrajectoryClock(record.startedAt, locale));
  }
  if (record.timeSeconds !== null) {
    lines.push(
      `${params.totalLabel} ${formatTrajectoryDuration(record.timeSeconds * 1000, locale)}`,
    );
  }
  const segments = trajectoryAssistantSegments(record);
  if (segments !== null) {
    lines.push(
      `${params.ttftLabel} ${formatTrajectoryDuration(segments.ttftMs, locale)} · ${
        params.decodingLabel
      } ${formatTrajectoryDuration(segments.decodingMs, locale)}`,
    );
  }
  return lines.join("\n");
}
