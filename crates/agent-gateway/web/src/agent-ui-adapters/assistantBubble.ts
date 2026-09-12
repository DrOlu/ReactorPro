import type { AskUserQuestionAnswer } from "@liveagent/ui/lib/chat/askUserQuestion";
import { readAskUserQuestionDeadlineAt } from "@liveagent/ui/lib/chat/askUserQuestion";
import type { PlanDecisionAnswer } from "@liveagent/ui/lib/chat/planMode";
import { readPlanApprovedMarker, readPlanPendingMarker } from "@liveagent/ui/lib/chat/planMode";
import { readToolApprovalPending } from "@liveagent/ui/lib/chat/toolApprovalArgs";
import { useSyncExternalStore } from "react";
import { submitAskUserQuestionAnswer } from "../lib/chat/askUserQuestionBridge";
import {
  getPlanDecisionOverlayVersion,
  readPlanDecisionOverlay,
  submitPlanDecision as submitPlanDecisionViaGateway,
  subscribePlanDecisionOverlay,
} from "../lib/chat/planModeBridge";

export const deferLargeToolImages = true;
export const retainRunningToolContent = false;

export function usePendingToolApproval(
  _toolCallId: string,
  toolArguments: Record<string, unknown>,
) {
  return readToolApprovalPending(toolArguments);
}

export function readAskUserQuestionDeadline(
  _toolCallId: string,
  toolArguments: Record<string, unknown>,
) {
  return readAskUserQuestionDeadlineAt(toolArguments) ?? undefined;
}

export function submitAskUserQuestionAnswers(toolCallId: string, answers: AskUserQuestionAnswer[]) {
  return submitAskUserQuestionAnswer(toolCallId, answers);
}

export function usePlanDecisionState(toolCallId: string, toolArguments: Record<string, unknown>) {
  // The argument marker is only updated by events/snapshots re-sent from the desktop, and approval
  // happens after the planning run terminates -- there is no subsequent event to flip the marker.
  // The local overlay records the settled facts it knows (approved/rejected/expired) and merges them
  // with the marker: once the overlay settles, pending switches off immediately and the card no
  // longer keeps the illusion of being clickable.
  useSyncExternalStore(
    subscribePlanDecisionOverlay,
    getPlanDecisionOverlayVersion,
    getPlanDecisionOverlayVersion,
  );
  const overlay = readPlanDecisionOverlay(toolCallId);
  return {
    pending: overlay === undefined && readPlanPendingMarker(toolArguments),
    approved: overlay === "approved" || readPlanApprovedMarker(toolArguments),
  };
}

export function submitPlanDecision(toolCallId: string, answer: PlanDecisionAnswer) {
  return submitPlanDecisionViaGateway(toolCallId, answer);
}
