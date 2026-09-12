/**
 * Aggregation layer for cumulative conversation stats.
 *
 * Consumes the converged output of `buildTrajectoryLedger` -- the dirty work of deduplication,
 * out-of-order handling, and repeated replay is all done in the ledger layer, so only pure arithmetic
 * happens here. Running steps/tools do not fold `now` into completed durations, but return
 * `*RunningSinceAt` for the presentation layer to fill in with its heartbeat, keeping the aggregate
 * result a pure, cacheable function.
 */

import { cachedNumberFormat } from "../shared/intlFormatters";
import type { TrajectoryLedger } from "./types";

export type ConversationStats = {
  turns: number;
  steps: number;
  /** Cumulative duration of completed steps, excluding the running portion. */
  llmMs: number;
  /** Start of the running step; the presentation layer fills in with `now - this value`. */
  llmRunningSinceAt: number | null;
  toolMs: number;
  toolRunningSinceAt: number | null;
  ttftAvgMs: number | null;
  ttftSamples: number;
  decodeTokPerSec: number | null;
  cacheHitRatio: number | null;
  /** Total prompt volume: input + cacheRead + cacheWrite, consistent with billing semantics. */
  inputTokens: number;
  outputTokens: number;
  compactions: number;
  /** True when events were truncated or not fully loaded; the presentation layer adds an "≈" prefix. */
  approximate: boolean;
};

export const EMPTY_CONVERSATION_STATS: ConversationStats = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  llmRunningSinceAt: null,
  toolMs: 0,
  toolRunningSinceAt: null,
  ttftAvgMs: null,
  ttftSamples: 0,
  decodeTokPerSec: null,
  cacheHitRatio: null,
  inputTokens: 0,
  outputTokens: 0,
  compactions: 0,
  approximate: false,
};

function positiveSpan(from: number | null, to: number | null): number {
  if (from === null || to === null) return 0;
  const span = to - from;
  return span > 0 ? span : 0;
}

/** Takes the earliest start across multiple running segments: what is shown is "how long it has run", not how long the last segment ran. */
function earlier(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return candidate < current ? candidate : current;
}

function tokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function aggregateTrajectoryStats(
  ledger: TrajectoryLedger,
  options: { approximate?: boolean } = {},
): ConversationStats {
  let steps = 0;
  let llmMs = 0;
  let llmRunningSinceAt: number | null = null;
  let toolMs = 0;
  let toolRunningSinceAt: number | null = null;
  let ttftTotalMs = 0;
  let ttftSamples = 0;
  let decodeTokens = 0;
  let decodeMs = 0;
  let promptTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let compactions = ledger.standaloneCompactions.length;

  for (const turn of ledger.turns) {
    compactions += turn.compactions.length;
    for (const step of turn.steps) {
      steps += 1;

      // Only status may start a heartbeat: the ledger converges crash-leftover steps into aborted
      // without filling in endedAt, so deciding by endedAt would leave a dead conversation's stopwatch
      // running forever.
      if (step.status === "running") {
        llmRunningSinceAt = earlier(llmRunningSinceAt, step.startedAt);
      } else {
        llmMs += positiveSpan(step.startedAt, step.endedAt);
      }

      if (step.firstTokenAt !== null && step.startedAt !== null) {
        const ttft = positiveSpan(step.startedAt, step.firstTokenAt);
        ttftTotalMs += ttft;
        ttftSamples += 1;
      }

      for (const tool of step.tools) {
        if (tool.status === "running") {
          toolRunningSinceAt = earlier(toolRunningSinceAt, tool.startedAt);
        } else {
          toolMs += positiveSpan(tool.startedAt, tool.endedAt);
        }
      }

      const usage = step.usage;
      if (usage === undefined) continue;

      const input = tokenCount(usage.input);
      const cacheRead = tokenCount(usage.cacheRead);
      const cacheWrite = tokenCount(usage.cacheWrite);
      const output = tokenCount(usage.output);

      promptTokens += input + cacheRead + cacheWrite;
      cacheReadTokens += cacheRead;
      outputTokens += output;

      // Decode window: from after the first token to the end. Falls back to the whole segment when
      // firstTokenAt is missing; non-positive values are not counted.
      if (output > 0 && step.endedAt !== null) {
        const window =
          step.firstTokenAt !== null
            ? positiveSpan(step.firstTokenAt, step.endedAt)
            : positiveSpan(step.startedAt, step.endedAt);
        if (window > 0) {
          decodeTokens += output;
          decodeMs += window;
        }
      }
    }
  }

  return {
    turns: ledger.turns.length,
    steps,
    llmMs,
    llmRunningSinceAt,
    toolMs,
    toolRunningSinceAt,
    ttftAvgMs: ttftSamples > 0 ? ttftTotalMs / ttftSamples : null,
    ttftSamples,
    decodeTokPerSec: decodeMs > 0 ? (decodeTokens * 1000) / decodeMs : null,
    cacheHitRatio: promptTokens > 0 ? cacheReadTokens / promptTokens : null,
    inputTokens: promptTokens,
    outputTokens,
    compactions,
    approximate: options.approximate === true,
  };
}

/** Whether the status bar has anything to show -- when all zero (old conversations, text mode) the whole bar is hidden. */
export function hasConversationStats(stats: ConversationStats | null): boolean {
  if (stats === null) return false;
  return stats.turns > 0 || stats.steps > 0;
}

/** Converts running segments into display durations relative to `now`. */
export function resolveStatDurations(
  stats: ConversationStats,
  now: number,
): { llmMs: number; toolMs: number } {
  return {
    llmMs: stats.llmMs + positiveSpan(stats.llmRunningSinceAt, now),
    toolMs: stats.toolMs + positiveSpan(stats.toolRunningSinceAt, now),
  };
}

/** `< 60s -> 42s`, `< 60min -> 12m34s`, `≥ 60min -> 5h06m`. */
export function formatStatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** TTFT keeps one decimal: `20.9s`; under 1s it uses milliseconds to avoid displaying `0.0s`. */
export function formatStatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatStatTokens(value: number, locale: string): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  // The two tiers each get their own key: <1000 keeps no decimals (892 -> "892", not compact's
  // "0.9K"). The formatter is cached by (variant, locale) -- this family of functions is called one
  // by one inside the status bar render body, and the status bar re-renders every second while
  // running (see the ConversationStatsBar heartbeat).
  const formatter = cachedNumberFormat(locale, value < 1000 ? "compact-whole" : "compact-1", {
    notation: "compact",
    maximumFractionDigits: value < 1000 ? 0 : 1,
  });
  return formatter.format(Math.round(value));
}

export function formatStatCount(value: number, locale: string): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return cachedNumberFormat(locale, "count").format(Math.round(value));
}

export function formatStatThroughput(tokPerSec: number): string {
  if (!Number.isFinite(tokPerSec) || tokPerSec <= 0) return "0";
  return String(Math.round(tokPerSec));
}

export function formatStatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "0";
  return String(Math.round(ratio * 100));
}
