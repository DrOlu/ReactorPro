// Gateway sync contract for tool approval: the desktop stamps the tool arguments synced to the WebUI with
// "pending approval + deadline" markers (see gatewayToolPreview), and the WebUI renders an approval card
// and shows a countdown from them. These are __-prefixed synthetic arguments that do not participate in
// display (filtered by toolCallArgsForDisplay) and do not affect local tool execution (execution uses the
// real arguments, not the gateway preview copy). This file is the shared source of truth for the parameter protocol on both ends.

/** The tool call is awaiting user approval (when true the WebUI renders an approval card). */
export const TOOL_APPROVAL_PENDING_ARG = "__toolApprovalPending";
/** Authoritative approval deadline timestamp (ms); the WebUI countdown shares its source with the desktop timer. */
export const TOOL_APPROVAL_DEADLINE_ARG = "__toolApprovalDeadlineAt";
/** Command/argument summary of the pending tool (computed once on the desktop and synced to the WebUI for the approval bar to display uniformly). */
export const TOOL_APPROVAL_SUMMARY_ARG = "__toolApprovalSummary";

/** Approval decision: allow=allow this time; deny=reject this time; approve_session=this tool is exempt from approval for the rest of this conversation. */
export type ToolApprovalDecision = "approve" | "deny" | "approve_session";

export function readToolApprovalPending(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (args as Record<string, unknown>)[TOOL_APPROVAL_PENDING_ARG] === true;
}

export function readToolApprovalDeadlineAt(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[TOOL_APPROVAL_DEADLINE_ARG];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readToolApprovalSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[TOOL_APPROVAL_SUMMARY_ARG];
  return typeof value === "string" ? value : "";
}
