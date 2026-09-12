// WebUI-side AskUserQuestion answer bridge: the card sits deep inside the transcript, and the
// submit action is registered by GatewayApp (delivered to the desktop tool suspension table via
// gateway chat_queue.tool_answer).
// A module-level singleton avoids prop drilling through 5 component layers, following the same
// pattern as the uploadedImagePreview cache.
import type { AskUserQuestionAnswer } from "@liveagent/ui/lib/chat/askUserQuestion";

export type AskUserQuestionSubmitOutcome = { ok: boolean; message?: string };

type AskUserQuestionAnswerHandler = (
  toolCallId: string,
  answers: AskUserQuestionAnswer[],
) => Promise<AskUserQuestionSubmitOutcome>;

let handler: AskUserQuestionAnswerHandler | null = null;

export function registerAskUserQuestionAnswerHandler(next: AskUserQuestionAnswerHandler | null) {
  handler = next;
}

export function submitAskUserQuestionAnswer(
  toolCallId: string,
  answers: AskUserQuestionAnswer[],
): Promise<AskUserQuestionSubmitOutcome> {
  if (!handler) {
    return Promise.resolve({ ok: false, message: "Gateway connection is not ready." });
  }
  return handler(toolCallId, answers);
}
