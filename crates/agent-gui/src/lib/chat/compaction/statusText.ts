import { type CompactionPressure, isNearModelLimit } from "./policy";
import type { CompactionDecision } from "./types";

export const PRUNE_FALLBACK_NOTICE = "Compaction failed, fell back to prune degradation";

export function buildCompactionRunningStatus(
  decision: CompactionDecision,
  pressure: CompactionPressure,
) {
  const detail = ` (at ${decision.totalTokens}/${decision.contextWindow} tokens)`;
  const base =
    decision.intent === "optimization"
      ? `Context approaching the limit${detail}, compacting history...`
      : `Context approaching the protective threshold${detail}, compacting and recovering...`;
  // At the top of the escalation ladder, give an advisory notice (replacing the
  // old hard cap's forced "start a new conversation"), but never block.
  return isNearModelLimit(pressure)
    ? `${base} Context is nearing the model limit; consider starting a new conversation soon.`
    : base;
}

export function buildPruneFallbackStatus(prunedMessageCount: number) {
  return `Context compaction failed; continuing after pruning ${prunedMessageCount} old tool outputs...`;
}
