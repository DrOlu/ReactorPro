// WebUI-side tool approval bridge: the approval card sits deep in the transcript, and
// the submit action is registered by GatewayApp (delivered to the desktop approval
// pending table via gateway chat_queue.tool_approval). A module-level singleton avoids
// prop drilling through many component layers, same pattern as askUserQuestionBridge.
import type { ToolApprovalDecision } from "@liveagent/ui/lib/chat/toolApprovalArgs";

export type ToolApprovalSubmitOutcome = { ok: boolean; message?: string };

type ToolApprovalDecisionHandler = (
  toolCallId: string,
  decision: ToolApprovalDecision,
  conversationId?: string,
) => Promise<ToolApprovalSubmitOutcome>;

let handler: ToolApprovalDecisionHandler | null = null;

export function registerToolApprovalDecisionHandler(next: ToolApprovalDecisionHandler | null) {
  handler = next;
}

/**
 * When conversationId is omitted, routing goes to the "currently displayed
 * conversation" (the main view); background panes in a multi-pane layout must pass
 * their own conversation id explicitly so the approval is not wrongly submitted to
 * the focused conversation.
 */
export function submitToolApprovalDecision(
  toolCallId: string,
  decision: ToolApprovalDecision,
  conversationId?: string,
): Promise<ToolApprovalSubmitOutcome> {
  if (!handler) {
    return Promise.resolve({ ok: false, message: "Gateway connection is not ready." });
  }
  return handler(toolCallId, decision, conversationId);
}
