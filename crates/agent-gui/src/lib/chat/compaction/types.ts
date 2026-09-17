export type { ProviderRuntimeConfig } from "../../providers/runtime/types";

export type CompactionTrigger = "pre-send" | "mid-stream" | "post-tool" | "manual";

// Mirrors the settings enum: "auto" keeps every trigger, "manualOnly" turns the automatic
// triggers off (manual compaction still works), "off" disables compaction entirely.
export type CompactionMode = "auto" | "manualOnly" | "off";

// optimization = unhurried compaction before sending (looser threshold), protection = protective compaction while running (tighter threshold).
export type CompactionIntent = "optimization" | "protection";

export type CompactionStatus =
  | { phase: "idle" }
  | {
      phase: "running";
      trigger: CompactionTrigger;
      startedAt: number;
      sourceSegmentIndex: number;
    }
  | {
      phase: "completed";
      trigger: CompactionTrigger;
      newSegmentIndex: number;
      completedAt: number;
    }
  | {
      phase: "failed";
      trigger: CompactionTrigger;
      failedAt: number;
      message: string;
    };

export type CompactionDecisionReason =
  | "disabled"
  | "disabled-by-settings"
  | "no-active-messages"
  | "in-flight"
  | "below-threshold"
  | "below-manual-threshold"
  | "cooldown"
  | "threshold-exceeded";

export type CompactionDecision = {
  shouldCompact: boolean;
  intent: CompactionIntent;
  reason: CompactionDecisionReason;
  totalTokens: number;
  threshold: number;
  contextWindow: number;
  maxOutputToken: number;
};
