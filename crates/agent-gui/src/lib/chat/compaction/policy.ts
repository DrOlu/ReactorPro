import type { ProviderModelConfig } from "../../settings";
import type { CompactionDecision, CompactionIntent } from "./types";

export const OPTIMIZATION_THRESHOLD_FACTOR = 1.5;
export const PROTECTION_THRESHOLD_FACTOR = 1.2;
export const MIN_COMPACTION_INTERVAL_MS = 60_000;
export const MIN_COMPACTION_USER_MESSAGES = 3;
export const RECENT_COMPACTION_WINDOW_MS = 5 * 60_000;
// Still being above 90% of the threshold after compaction counts as an "ineffective compaction" and drives pressure escalation.
export const INEFFECTIVE_COMPACTION_RATIO = 0.9;
export const MAX_PRESSURE_LEVEL = 2;

export const PRUNE_MINIMUM_TOKENS = 20_000;
const PRUNE_PROTECT_TOKENS_BY_LEVEL = [40_000, 20_000, 10_000] as const;
const PRUNE_PROTECT_USER_TURNS_BY_LEVEL = [2, 2, 1] as const;

export type PressureLevel = 0 | 1 | 2;

/**
 * Pressure escalation ladder: replaces the old MAX_SESSION_COMPACTIONS hard cap.
 * Consecutive ineffective compactions push the level up (more aggressive pruning,
 * tighter protection thresholds, advisory hints) but never hard-reject.
 * Pure data + pure transition function, held and advanced by the controller.
 */
export type CompactionPressure = {
  level: PressureLevel;
  consecutiveIneffective: number;
  compactionsApplied: number;
  lastCompactionAt: number;
};

export function createCompactionPressure(): CompactionPressure {
  return {
    level: 0,
    consecutiveIneffective: 0,
    compactionsApplied: 0,
    lastCompactionAt: 0,
  };
}

export function normalizeCompactionPressure(
  pressure: CompactionPressure,
  now: number,
): CompactionPressure {
  if (
    pressure.lastCompactionAt > 0 &&
    now - pressure.lastCompactionAt > RECENT_COMPACTION_WINDOW_MS &&
    (pressure.level > 0 || pressure.consecutiveIneffective > 0)
  ) {
    return { ...pressure, level: 0, consecutiveIneffective: 0 };
  }
  return pressure;
}

export function notePressureAfterCompaction(
  pressure: CompactionPressure,
  params: { totalTokensAfter: number; threshold: number; now: number },
): CompactionPressure {
  const ineffective =
    params.threshold > 0 &&
    params.totalTokensAfter > params.threshold * INEFFECTIVE_COMPACTION_RATIO;
  const consecutiveIneffective = ineffective ? pressure.consecutiveIneffective + 1 : 0;
  return {
    level: Math.min(MAX_PRESSURE_LEVEL, consecutiveIneffective) as PressureLevel,
    consecutiveIneffective,
    compactionsApplied: pressure.compactionsApplied + 1,
    lastCompactionAt: params.now,
  };
}

export function shouldPruneBeforeCompaction(pressure: CompactionPressure, now: number): boolean {
  if (pressure.level >= 1) return true;
  return (
    pressure.lastCompactionAt > 0 && now - pressure.lastCompactionAt <= RECENT_COMPACTION_WINDOW_MS
  );
}

export function isNearModelLimit(pressure: CompactionPressure): boolean {
  return pressure.level >= MAX_PRESSURE_LEVEL;
}

export type PruneOptions = {
  minimumReleasedTokens: number;
  protectedToolTokens: number;
  protectedRecentUserTurns: number;
};

export function resolvePruneOptions(pressure: CompactionPressure): PruneOptions {
  return {
    minimumReleasedTokens: PRUNE_MINIMUM_TOKENS,
    protectedToolTokens: PRUNE_PROTECT_TOKENS_BY_LEVEL[pressure.level],
    protectedRecentUserTurns: PRUNE_PROTECT_USER_TURNS_BY_LEVEL[pressure.level],
  };
}

// contextWindow uses the total-window-including-output semantics (consistent across
// the catalog/fallback; the Codex source's input-side budget is already converted at
// catalog generation time), so "window - output reserve" holds uniformly for all
// providers. For OpenAI-family models "input cap = total window - output cap"
// (GPT-5: 400K = 272K + 128K), and factor >= 1 ensures the threshold never exceeds
// the real input cap.
export function resolveCompactionThreshold(params: {
  intent: CompactionIntent;
  contextWindow: number;
  maxOutputToken: number;
  pressureLevel: PressureLevel;
}): number {
  const factor =
    params.intent === "optimization" ? OPTIMIZATION_THRESHOLD_FACTOR : PROTECTION_THRESHOLD_FACTOR;
  const effectiveFactor =
    params.intent === "protection" && params.pressureLevel >= MAX_PRESSURE_LEVEL ? 1.0 : factor;
  return Math.max(1024, Math.floor(params.contextWindow - params.maxOutputToken * effectiveFactor));
}

export function decideCompaction(params: {
  intent: CompactionIntent;
  totalTokens: number;
  modelConfig?: ProviderModelConfig;
  activeMessageCount: number;
  userMessageCount: number;
  // Time of the last checkpoint (0 if none); the controller passes max(segment summary time, pressure lastCompactionAt).
  lastCompactionAt: number;
  pressure: CompactionPressure;
  inFlight: boolean;
  now: number;
  // Manual trigger: the user explicitly wants compaction, so the threshold and
  // cooldown short-circuits are skipped; the disabled / no-active-messages /
  // in-flight hard guards still apply.
  bypassThresholdAndCooldown?: boolean;
}): CompactionDecision {
  const contextWindow = Math.max(0, Math.floor(params.modelConfig?.contextWindow ?? 0));
  const maxOutputToken = Math.max(0, Math.floor(params.modelConfig?.maxOutputToken ?? 0));

  const base = {
    intent: params.intent,
    totalTokens: Math.max(0, Math.floor(params.totalTokens)),
    contextWindow,
    maxOutputToken,
  };

  if (contextWindow <= 0 || maxOutputToken <= 0) {
    return {
      ...base,
      shouldCompact: false,
      reason: "disabled",
      threshold: 0,
    };
  }

  const threshold = resolveCompactionThreshold({
    intent: params.intent,
    contextWindow,
    maxOutputToken,
    pressureLevel: params.pressure.level,
  });

  if (params.activeMessageCount <= 0) {
    return {
      ...base,
      shouldCompact: false,
      reason: "no-active-messages",
      threshold,
    };
  }

  if (params.inFlight) {
    return { ...base, shouldCompact: false, reason: "in-flight", threshold };
  }

  if (!params.bypassThresholdAndCooldown && base.totalTokens < threshold) {
    return { ...base, shouldCompact: false, reason: "below-threshold", threshold };
  }

  // The cooldown window only blocks an oversized single turn that crosses the
  // threshold again right after compacting; normal self-triggering is already blocked by the ledger reset.
  if (
    !params.bypassThresholdAndCooldown &&
    params.lastCompactionAt > 0 &&
    params.now - params.lastCompactionAt < MIN_COMPACTION_INTERVAL_MS &&
    params.userMessageCount < MIN_COMPACTION_USER_MESSAGES
  ) {
    return { ...base, shouldCompact: false, reason: "cooldown", threshold };
  }

  return { ...base, shouldCompact: true, reason: "threshold-exceeded", threshold };
}
