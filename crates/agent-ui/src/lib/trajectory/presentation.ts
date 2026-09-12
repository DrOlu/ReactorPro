/**
 * Pure mapping from records → display copy.
 *
 * The layout layer deliberately produces no user-facing copy: it is pure logic and
 * should not know about i18n. This module only maps records to i18n keys and formatted
 * values; the actual word lookup is left to the component.
 */

import { cachedDateTimeFormat, cachedNumberFormat } from "../shared/intlFormatters";
import type {
  TrajectoryHeaderChange,
  TrajectoryLedger,
  TrajectoryRecord,
  TrajectoryRecordKind,
  TrajectoryStatus,
  TrajectoryUsage,
} from "./types";

/**
 * True when some settled operations only have structural fallback data while other operations
 * carry real timestamps. Duration mode remains useful, but it necessarily omits the untimed rows.
 */
export function trajectoryLedgerHasPartialTiming(ledger: TrajectoryLedger): boolean {
  if (!ledger.hasTiming) return false;
  const settledMissingTiming = (
    status: TrajectoryStatus,
    startedAt: number | null,
    endedAt: number | null,
  ) => status !== "running" && (startedAt === null || endedAt === null);

  for (const turn of ledger.turns) {
    if (turn.status !== "running" && turn.inputs.some((input) => input.at === null)) return true;
    if (
      turn.steps.some((step) => settledMissingTiming(step.status, step.startedAt, step.endedAt))
    ) {
      return true;
    }
    if (
      turn.compactions.some((compaction) =>
        settledMissingTiming(compaction.status, compaction.startedAt, compaction.endedAt),
      )
    ) {
      return true;
    }
  }
  return ledger.standaloneCompactions.some((compaction) =>
    settledMissingTiming(compaction.status, compaction.startedAt, compaction.endedAt),
  );
}

export function trajectoryKindLabelKey(kind: TrajectoryRecordKind): string {
  return `trajectory.kind.${kind}`;
}

export function trajectoryStatusLabelKey(status: TrajectoryStatus): string {
  return `trajectory.status.${status}`;
}

/** A SYSTEM row has no body; its title is determined entirely by the change category. */
export function trajectorySystemLabelKey(change: TrajectoryHeaderChange | undefined): string {
  switch (change) {
    case "tools":
      return "trajectory.system.tools";
    case "system-and-tools":
      return "trajectory.system.systemAndTools";
    case "system":
      return "trajectory.system.system";
    default:
      return "trajectory.system.initial";
  }
}

/** Fallback title key for a row without a body; returns undefined when there is a body, letting the caller use text directly. */
export function trajectoryFallbackLabelKey(record: TrajectoryRecord): string | undefined {
  if (record.text !== "") return undefined;
  if (record.kind === "system") return trajectorySystemLabelKey(record.headerChange);
  if (record.kind === "compacted") return "trajectory.compaction.title";
  return undefined;
}

/** Millisecond duration label; `—` when unknown, converting to s at second scale or above to avoid seven-digit numbers. */
export function formatTrajectoryDuration(milliseconds: number | null, locale: string): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  const rounded = Math.max(0, milliseconds);
  if (rounded < 1000) {
    return `${cachedNumberFormat(locale, "integer-0", { maximumFractionDigits: 0 }).format(rounded)} ms`;
  }
  return `${cachedNumberFormat(locale, "decimal-2", { maximumFractionDigits: 2 }).format(rounded / 1000)} s`;
}

export function formatTrajectorySeconds(seconds: number | null, locale: string): string {
  return formatTrajectoryDuration(seconds === null ? null : seconds * 1000, locale);
}

export function formatTrajectoryCount(value: number | undefined, locale: string): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return cachedNumberFormat(locale, "integer-0", { maximumFractionDigits: 0 }).format(value);
}

export function formatTrajectoryClock(timestamp: number | null, locale: string): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "—";
  return cachedDateTimeFormat(locale, "clock-ms", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).format(new Date(timestamp));
}

/** Decode throughput; returns null rather than estimating when any timing fact is missing. */
export function trajectoryThroughputTokensPerSecond(record: TrajectoryRecord): number | null {
  const metrics = record.assistantMetrics;
  if (metrics === undefined || !metrics.timingRecorded) return null;
  const { firstTokenAt, completedAt, outputTokens } = metrics;
  if (firstTokenAt === null || completedAt === null || outputTokens === null) return null;
  const decodingMs = completedAt - firstTokenAt;
  if (decodingMs <= 0 || outputTokens <= 0) return null;
  return (outputTokens / decodingMs) * 1000;
}

/** The two durations, TTFT and decode, used for the Gantt block's internal color split and the Timing panel. */
export function trajectoryAssistantSegments(
  record: TrajectoryRecord,
): { ttftMs: number; decodingMs: number } | null {
  const metrics = record.assistantMetrics;
  if (metrics === undefined || !metrics.timingRecorded) return null;
  const { stepStartAt, firstTokenAt, completedAt } = metrics;
  if (stepStartAt === null || firstTokenAt === null || completedAt === null) return null;
  if (firstTokenAt < stepStartAt || completedAt < firstTokenAt) return null;
  return { ttftMs: firstTokenAt - stepStartAt, decodingMs: completedAt - firstTokenAt };
}

export const TRAJECTORY_USAGE_FIELDS = [
  "totalTokens",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
] as const satisfies readonly (keyof TrajectoryUsage)[];
