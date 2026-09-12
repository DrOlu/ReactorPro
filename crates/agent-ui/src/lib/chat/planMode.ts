// Plan Mode shared pure logic: tool names, and the types and tolerant parsing for plan decisions.
// This shared module must remain zero-dependency pure data logic (mirroring askUserQuestion.ts).

export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

/** Maximum length of plan markdown; the excess is truncated (guarding persistence against abnormal model output). */
export const EXIT_PLAN_MODE_PLAN_MAX_LENGTH = 64_000;

/** Maximum length of user feedback when rejecting a plan; the excess is truncated. */
export const EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH = 4_000;

/**
 * The pending/approved marker the desktop attaches to the tool arguments reported over the
 * gateway (a synthetic argument with a `__` prefix, not displayed and not affecting execution);
 * the WebUI card uses it to render the approve button/settled state.
 */
export const EXIT_PLAN_MODE_PENDING_ARG = "__exitPlanModePending";
export const EXIT_PLAN_MODE_APPROVED_ARG = "__exitPlanModeApproved";

export function readPlanPendingMarker(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (args as Record<string, unknown>)[EXIT_PLAN_MODE_PENDING_ARG] === true;
}

export function readPlanApprovedMarker(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (args as Record<string, unknown>)[EXIT_PLAN_MODE_APPROVED_ARG] === true;
}

/** approve: approve the plan and start execution; reject: send the feedback back as a normal message, and the model revises and resubmits. */
export type PlanDecision = "approve" | "reject";

export type PlanDecisionAnswer = {
  decision: PlanDecision;
  /** Revision feedback when rejecting; sent to the model as a normal user message. */
  feedback?: string;
};

export type ExitPlanModeResultDetails = {
  kind: "exit_plan_mode";
  plan: string;
  decision?: PlanDecision;
  feedback?: string;
};

/** Extract and truncate plan markdown; returns an empty string for non-strings/blank (the caller treats it as an argument error). */
export function sanitizePlanMarkdown(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > EXIT_PLAN_MODE_PLAN_MAX_LENGTH
    ? trimmed.slice(0, EXIT_PLAN_MODE_PLAN_MAX_LENGTH)
    : trimmed;
}

/** Normalize one plan decision answer; returns null for invalid input (raw JSON from a remote channel is untrusted). */
export function resolvePlanDecisionAnswer(raw: unknown): PlanDecisionAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.decision !== "approve" && obj.decision !== "reject") return null;
  const feedbackRaw = typeof obj.feedback === "string" ? obj.feedback.trim() : "";
  const feedback =
    feedbackRaw.length > EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH
      ? feedbackRaw.slice(0, EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH)
      : feedbackRaw;
  return {
    decision: obj.decision,
    ...(feedback ? { feedback } : {}),
  };
}

/** Parse the details of an ExitPlanMode tool result; returns null when historical/degraded data is invalid. */
export function parseExitPlanModeResultDetails(value: unknown): ExitPlanModeResultDetails | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.kind !== "exit_plan_mode" || typeof obj.plan !== "string") return null;
  return {
    kind: "exit_plan_mode",
    plan: obj.plan,
    ...(obj.decision === "approve" || obj.decision === "reject" ? { decision: obj.decision } : {}),
    ...(typeof obj.feedback === "string" && obj.feedback ? { feedback: obj.feedback } : {}),
  };
}
