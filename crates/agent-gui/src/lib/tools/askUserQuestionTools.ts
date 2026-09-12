import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  ASK_USER_QUESTION_MAX_OPTIONS,
  ASK_USER_QUESTION_MAX_QUESTIONS,
  ASK_USER_QUESTION_MIN_OPTIONS,
  ASK_USER_QUESTION_TIMEOUT_MS,
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionResultDetails,
  buildAskUserQuestionResultText,
  buildDefaultAskUserQuestionAnswers,
  parseAskUserQuestionItems,
  resolveAskUserQuestionAnswers,
} from "@liveagent/ui/lib/chat/askUserQuestion";
import { Type } from "typebox";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

type AskUserQuestionSettlement =
  | { kind: "answered"; answers: AskUserQuestionAnswer[] }
  | { kind: "timeout"; answers: AskUserQuestionAnswer[] }
  | { kind: "cancelled" };

type PendingAskUserQuestion = {
  conversationId: string;
  questions: AskUserQuestionItem[];
  /** Authoritative answer deadline timestamp (milliseconds); the card countdown and the timeout fallback share the same source. */
  deadlineAt: number;
  settle: (settlement: AskUserQuestionSettlement) => void;
};

// Global pending table (toolCallId is globally unique): local cards answer directly,
// while WebUI answers are forwarded to the desktop via gateway chat_queue.tool_answer
// and enter through the same entry point.
const pendingByToolCallId = new Map<string, PendingAskUserQuestion>();

// Gateway tool-argument reporting precedes the execute suspension: the deadline is
// preset on the first report and execute reuses the same value, keeping the WebUI card
// countdown aligned with the desktop's authoritative timing. Expired entries are
// lazily swept on demand (calls whose execution never started, such as a truncated
// call rejected by a guard, do not go through settle cleanup).
const presetDeadlineByToolCallId = new Map<string, number>();

// Per-conversation subscription: the sidebar uses it to mark "waiting for your answer"
// on the conversation row, isomorphic to toolApproval.ts's
// listenersByConversation/emitChange. No global listener is needed here — the question
// card is itself in the transcript, and whether it has settled is determined by the
// presence of a toolResult; only the sidebar needs a per-conversation query.
const listenersByConversation = new Map<string, Set<() => void>>();
const pendingSnapshotsByConversation = new Map<string, PendingAskUserQuestionSummary[]>();
const EMPTY_PENDING_QUESTIONS: PendingAskUserQuestionSummary[] = [];
Object.freeze(EMPTY_PENDING_QUESTIONS);

function emitChange(conversationId: string) {
  const key = conversationId.trim();
  if (!key) return;
  pendingSnapshotsByConversation.delete(key);
  const conversationListeners = listenersByConversation.get(key);
  if (!conversationListeners) return;
  for (const listener of Array.from(conversationListeners)) listener();
}

export function subscribeAskUserQuestionsForConversation(
  conversationId: string,
  listener: () => void,
): () => void {
  const key = conversationId.trim();
  if (!key) return () => undefined;
  const conversationListeners = listenersByConversation.get(key) ?? new Set();
  conversationListeners.add(listener);
  listenersByConversation.set(key, conversationListeners);
  return () => {
    conversationListeners.delete(listener);
    if (conversationListeners.size === 0) {
      listenersByConversation.delete(key);
    }
  };
}

/** All currently pending questions for a conversation. Refreshes reactively as the
 *  pending table changes, via a subscribeAskUserQuestionsForConversation subscription. */
export type PendingAskUserQuestionSummary = {
  toolCallId: string;
  deadlineAt: number;
};

export function listPendingAskUserQuestionsForConversation(
  conversationId: string,
): PendingAskUserQuestionSummary[] {
  const target = conversationId.trim();
  const out: PendingAskUserQuestionSummary[] = [];
  for (const [toolCallId, pending] of pendingByToolCallId) {
    if (pending.conversationId === target) {
      out.push({ toolCallId, deadlineAt: pending.deadlineAt });
    }
  }
  return out;
}

/** Identity-stable snapshot: useSyncExternalStore requires the same state to return the same reference, otherwise it tears. */
export function getPendingAskUserQuestionsSnapshot(
  conversationId: string,
): PendingAskUserQuestionSummary[] {
  const key = conversationId.trim();
  if (!key) return EMPTY_PENDING_QUESTIONS;
  const cached = pendingSnapshotsByConversation.get(key);
  if (cached) return cached;
  const pending = listPendingAskUserQuestionsForConversation(key);
  if (pending.length === 0) return EMPTY_PENDING_QUESTIONS;
  pendingSnapshotsByConversation.set(key, pending);
  return pending;
}

function sweepStalePresetDeadlines(now: number) {
  for (const [toolCallId, deadlineAt] of presetDeadlineByToolCallId) {
    if (deadlineAt + 60_000 < now) {
      presetDeadlineByToolCallId.delete(toolCallId);
    }
  }
}

/** Get (presetting if necessary) the answer deadline when the gateway reports tool arguments; once suspended it shares the same source as the in-tool timing. */
export function ensureAskUserQuestionDeadlineAt(toolCallId: string): number {
  const trimmed = toolCallId.trim();
  const pending = pendingByToolCallId.get(trimmed);
  if (pending) return pending.deadlineAt;
  const now = Date.now();
  sweepStalePresetDeadlines(now);
  const preset = presetDeadlineByToolCallId.get(trimmed);
  if (preset !== undefined) return preset;
  const deadlineAt = now + ASK_USER_QUESTION_TIMEOUT_MS;
  presetDeadlineByToolCallId.set(trimmed, deadlineAt);
  return deadlineAt;
}

/** The GUI card reads the authoritative deadline; returns null when there is no pending entry and no preset (settled/historical data). */
export function getAskUserQuestionDeadlineAt(toolCallId: string): number | null {
  const trimmed = toolCallId.trim();
  return (
    pendingByToolCallId.get(trimmed)?.deadlineAt ?? presetDeadlineByToolCallId.get(trimmed) ?? null
  );
}

export type AnswerAskUserQuestionOutcome = { ok: boolean; message?: string };

/** Answer a pending question; answers is the raw input of {questionId, selectedLabel}[]. */
export function answerAskUserQuestion(
  toolCallId: string,
  rawAnswers: unknown,
  options?: {
    /** The remote answer channel must carry this: reject when it does not match the pending question's conversation, to prevent cross-conversation answers. */
    conversationId?: string;
  },
): AnswerAskUserQuestionOutcome {
  const pending = pendingByToolCallId.get(toolCallId.trim());
  if (!pending) {
    return { ok: false, message: "Question is not pending (already answered or cancelled)." };
  }
  const expectedConversationId = options?.conversationId?.trim();
  if (expectedConversationId && expectedConversationId !== pending.conversationId) {
    return { ok: false, message: "Question belongs to a different conversation." };
  }
  const answers = resolveAskUserQuestionAnswers(pending.questions, rawAnswers);
  if (!answers) {
    return {
      ok: false,
      message: "Every question needs a listed option selected or a non-empty custom answer.",
    };
  }
  pending.settle({ kind: "answered", answers });
  return { ok: true };
}

export function hasPendingAskUserQuestion(toolCallId: string) {
  return pendingByToolCallId.has(toolCallId.trim());
}

/** Conversation-destruction fallback: pending questions settle as "unanswered" (the normal path is cancelled by AbortSignal). */
export function cancelPendingAskUserQuestionsForConversation(conversationId: string) {
  for (const [toolCallId, pending] of pendingByToolCallId) {
    if (pending.conversationId === conversationId) {
      pendingByToolCallId.delete(toolCallId);
      pending.settle({ kind: "cancelled" });
    }
  }
  emitChange(conversationId);
}

const ASK_USER_QUESTION_TIMEOUT_MINUTES = Math.round(ASK_USER_QUESTION_TIMEOUT_MS / 60_000);

const ASK_USER_QUESTION_TOOL_DESCRIPTION = `Ask the user up to ${ASK_USER_QUESTION_MAX_QUESTIONS} multiple-choice questions and wait for their selections. Use this whenever you need a decision only the user can make: ambiguous requirements, mutually exclusive approaches, or trade-offs you cannot resolve from the conversation and the workspace.

The questions render as an interactive card; execution pauses until the user answers every question, then the selections come back as the tool result. If the user does not answer within ${ASK_USER_QUESTION_TIMEOUT_MINUTES} minutes, the recommended (or first) option of every question is auto-selected and execution continues — the result text tells you which happened.

Rules:
- Ask 1-${ASK_USER_QUESTION_MAX_QUESTIONS} focused questions per call; each question needs ${ASK_USER_QUESTION_MIN_OPTIONS}-${ASK_USER_QUESTION_MAX_OPTIONS} options (3-4 is ideal); different questions may have different option counts.
- Options must be short, concrete, and mutually exclusive. Set recommended=true on your suggested choice (at most one per question) — it is shown first and becomes the timeout fallback.
- The UI automatically appends an "Other" free-text option to every question, so the user can always type their own answer. Do NOT add your own catch-all option (e.g. "Other", "Custom", or similar catch-all labels). When the user types an answer, the result marks it as user-typed and returns their exact words instead of a listed label — treat it as authoritative.
- Give each question a short header (2-6 chars works best) — it becomes the tab label when several questions show at once.
- Do not use this for questions answerable from the code or the conversation, and never ask for confirmation of work you can safely do.`;

const askUserQuestionParameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: Type.Optional(
        Type.String({ description: "Stable question id (defaults to q1..qN by position)." }),
      ),
      header: Type.Optional(
        Type.String({ description: "Short tab label shown when multiple questions render." }),
      ),
      prompt: Type.String({ description: "The question shown to the user." }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Concise option label the user picks." }),
          description: Type.Optional(
            Type.String({ description: "One-line explanation of the trade-off." }),
          ),
          recommended: Type.Optional(
            Type.Boolean({
              description:
                "Mark exactly one option per question as your recommendation; it is shown first and auto-selected on timeout.",
            }),
          ),
        }),
        {
          description: `${ASK_USER_QUESTION_MIN_OPTIONS}-${ASK_USER_QUESTION_MAX_OPTIONS} mutually exclusive options (3-4 is ideal).`,
        },
      ),
    }),
    { description: `1-${ASK_USER_QUESTION_MAX_QUESTIONS} questions to ask in this card.` },
  ),
});

function buildErrorResult(toolCall: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

export function createAskUserQuestionTools(params: {
  conversationId: string;
  /** Answer-window milliseconds; injected by tests only, production always uses the default. */
  timeoutMs?: number;
}): BuiltinToolBundle {
  const timeoutMs = params.timeoutMs ?? ASK_USER_QUESTION_TIMEOUT_MS;
  const toolAskUserQuestion: Tool = {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: ASK_USER_QUESTION_TOOL_DESCRIPTION,
    parameters: askUserQuestionParameters,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    if (toolCall.name !== ASK_USER_QUESTION_TOOL_NAME) {
      return buildErrorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
    if (signal?.aborted) {
      return buildErrorResult(toolCall, "Cancelled");
    }

    let questions: AskUserQuestionItem[];
    try {
      const args = (toolCall.arguments || {}) as Record<string, unknown>;
      questions = parseAskUserQuestionItems(args.questions);
    } catch (error) {
      return buildErrorResult(
        toolCall,
        error instanceof Error ? error.message : "AskUserQuestion failed.",
      );
    }

    // Suspend and wait for the user to answer in the chat card; the stop button
    // (AbortSignal) settles it as "unanswered", and once the answer window passes it
    // auto-settles to the recommended option (or the first) and continues execution.
    // deadline preferentially reuses the preset from gateway argument reporting (the
    // WebUI countdown shares the same source); when a test injects timeoutMs the preset
    // is ignored and the injected value always wins.
    const presetDeadlineAt = presetDeadlineByToolCallId.get(toolCall.id);
    presetDeadlineByToolCallId.delete(toolCall.id);
    const deadlineAt =
      params.timeoutMs !== undefined || presetDeadlineAt === undefined
        ? Date.now() + timeoutMs
        : presetDeadlineAt;
    const settlement = await new Promise<AskUserQuestionSettlement>((resolve) => {
      const settle = (value: AskUserQuestionSettlement) => {
        pendingByToolCallId.delete(toolCall.id);
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timeoutId);
        // The settled conversation comes from the closure rather than the pending
        // struct: settle is defined inside executeToolCall, where the pending entry has
        // already been removed from the table.
        emitChange(params.conversationId);
        resolve(value);
      };
      const onAbort = () => settle({ kind: "cancelled" });
      const timeoutId = setTimeout(
        () => settle({ kind: "timeout", answers: buildDefaultAskUserQuestionAnswers(questions) }),
        Math.max(0, deadlineAt - Date.now()),
      );
      pendingByToolCallId.set(toolCall.id, {
        conversationId: params.conversationId,
        questions,
        deadlineAt,
        settle,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      emitChange(params.conversationId);
    });

    if (settlement.kind === "cancelled") {
      const details: AskUserQuestionResultDetails = {
        kind: "ask_user_question",
        questions,
        answers: [],
        cancelled: true,
      };
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: "The user stopped the turn without answering. Do not assume any selection.",
          },
        ],
        details,
        isError: true,
        timestamp: Date.now(),
      };
    }

    const timedOut = settlement.kind === "timeout";
    const details: AskUserQuestionResultDetails = {
      kind: "ask_user_question",
      questions,
      answers: settlement.answers,
      ...(timedOut ? { timedOut: true } : {}),
    };
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [
        { type: "text", text: buildAskUserQuestionResultText(settlement.answers, { timedOut }) },
      ],
      details,
      isError: false,
      timestamp: Date.now(),
    };
  }

  return {
    groupId: "system",
    tools: [toolAskUserQuestion],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        ASK_USER_QUESTION_TOOL_NAME,
        {
          groupId: "system",
          kind: "ask_user_question",
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
