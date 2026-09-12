// WebUI-side plan-approval bridge: the plan card lives deep inside the transcript, and
// the submit action is registered by GatewayApp (delivered to the desktop plan-suspension
// table via gateway chat_queue.plan_decision). A module-level singleton avoids threading
// props through many component layers, same pattern as askUserQuestionBridge / toolApprovalBridge.
import type { PlanDecisionAnswer } from "@liveagent/ui/lib/chat/planMode";

export type PlanDecisionSubmitOutcome = {
  ok: boolean;
  message?: string;
  /** Desktop structured error code passed through (not_found = plan already decided/superseded). */
  errorCode?: string;
};

type PlanDecisionHandler = (
  toolCallId: string,
  answer: PlanDecisionAnswer,
) => Promise<PlanDecisionSubmitOutcome>;

let handler: PlanDecisionHandler | null = null;

export function registerPlanDecisionHandler(next: PlanDecisionHandler | null) {
  handler = next;
}

// Local decided-state overlay: the argument markers (__exitPlanModePending/Approved) only
// update with events/snapshots later sent by the desktop, and submitting a plan terminates
// the run — approval happens after the run ends, so there are no subsequent events to flip
// the markers and the card in the persisted projection stays clickable forever. The overlay
// records "the local side's known settled facts" (approval succeeded/rejection succeeded/
// desktop reported stale), merged with the markers to drive the card to settled.
// Not persisted: after a refresh the overlay is cleared, and clicking a stale button again
// yields not_found and re-settles.
const decidedOverlay = new Map<string, "approved" | "settled">();
const listeners = new Set<() => void>();
let overlayVersion = 0;

function markDecided(toolCallId: string, state: "approved" | "settled") {
  const key = toolCallId.trim();
  if (!key || decidedOverlay.get(key) === state) return;
  decidedOverlay.set(key, state);
  overlayVersion += 1;
  for (const listener of listeners) listener();
}

export function subscribePlanDecisionOverlay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPlanDecisionOverlayVersion(): number {
  return overlayVersion;
}

export function readPlanDecisionOverlay(toolCallId: string): "approved" | "settled" | undefined {
  return decidedOverlay.get(toolCallId.trim());
}

export async function submitPlanDecision(
  toolCallId: string,
  answer: PlanDecisionAnswer,
): Promise<PlanDecisionSubmitOutcome> {
  if (!handler) {
    return { ok: false, message: "Gateway connection is not ready." };
  }
  const outcome = await handler(toolCallId, answer);
  if (outcome.ok) {
    markDecided(toolCallId, answer.decision === "approve" ? "approved" : "settled");
  } else if (outcome.errorCode === "not_found") {
    // The plan was decided elsewhere or superseded by a new submission: the card should
    // settle rather than keep a button that always errors.
    markDecided(toolCallId, "settled");
  }
  return outcome;
}
