// Plan Mode desktop authoritative implementation: the ExitPlanMode tool + pending plan registry.
//
// Interaction paradigm (conversational, aligned with Codex plan mode -- no suspend-and-wait):
//   1. The model calls ExitPlanMode(plan) -> the tool returns immediately and registers a "pending
//      plan", and the runner's termination predicate ends this turn's run in place -- no spinning
//      wait, no approval timeout.
//   2. The user replies with a message: a pure approval phrase ("agree/start/ok", etc., see
//      isPlanApprovalMessage) or clicks the card button -> the host approval handler (turn off the
//      plan switch + directly send the execution continuation turn); any other message = revision
//      feedback, sent as a normal user message, and the model revises the plan in plan mode and
//      submits again (a new submission overwrites the old registration).
//   3. Requests such as "save the plan to a file" likewise go through the conversation: the model
//      writes the save step into the plan, and the execution turn writes it to disk.
// Remote (WebUI) buttons are forwarded to the desktop via gateway chat_queue.plan_decision and
// then go through the same entry point answerPlanDecision (approve -> host approval handler;
// reject -> feedback sent as a message).

import type { Message, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { ASK_USER_QUESTION_TOOL_NAME } from "@liveagent/ui/lib/chat/askUserQuestion";
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  type ExitPlanModeResultDetails,
  resolvePlanDecisionAnswer,
  sanitizePlanMarkdown,
} from "@liveagent/ui/lib/chat/planMode";
import { Type } from "typebox";
import type { ToolChoice } from "../providers/runtime/types";
import { AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../subagents/types";
import {
  type BuiltinToolBundle,
  type BuiltinToolMetadata,
  createBuiltinMetadataMap,
} from "./builtinTypes";

type PendingPlan = {
  conversationId: string;
  toolCallId: string;
  plan: string;
};

// At most one pending plan per conversation (a new submission overwrites the old one -- the old plan becomes invalid).
const pendingPlanByConversation = new Map<string, PendingPlan>();
// Approved ExitPlanMode calls (used for the card's settled state; cleaned up when the conversation
// is destroyed). Approval clears the pending registration first, so cleanup cannot look up via
// pending -- a separate per-conversation record is kept and removed as a whole on destruction.
const approvedToolCallIds = new Set<string>();
const approvedToolCallIdsByConversation = new Map<string, Set<string>>();

// useSyncExternalStore subscription: notifies on register/approve/overwrite, driving a refresh of the plan card's button state.
const listeners = new Set<() => void>();
let version = 0;
function emitChange() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribePlanDecisions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPlanDecisionVersion(): number {
  return version;
}

/** Whether this ExitPlanMode call is currently pending (the card uses this to enable the approve button). */
export function isPlanDecisionPending(toolCallId: string): boolean {
  const trimmed = toolCallId.trim();
  for (const pending of pendingPlanByConversation.values()) {
    if (pending.toolCallId === trimmed) return true;
  }
  return false;
}

/** Whether this ExitPlanMode call has been approved (the card's settled state). */
export function isPlanApprovalToolCall(toolCallId: string): boolean {
  return approvedToolCallIds.has(toolCallId.trim());
}

/** The current pending plan for a conversation; null if none. */
export function getPendingPlanForConversation(
  conversationId: string,
): { toolCallId: string; plan: string } | null {
  const pending = pendingPlanByConversation.get(conversationId.trim());
  return pending ? { toolCallId: pending.toolCallId, plan: pending.plan } : null;
}

/**
 * Pure approval phrase detection: the entire input (after trimming whitespace/trailing punctuation)
 * must be a common "agree" expression to count as approval. Any additional content ("agree, but
 * change step two") does not count -- that is revision feedback and should be sent to the model.
 */
const PLAN_APPROVAL_PHRASES = new Set([
  "agree",
  "approve",
  "sure",
  "good",
  "alright",
  "fine",
  "start",
  "let's start",
  "start execution",
  "execute",
  "let's execute",
  "get going",
  "let's go",
  "go for it",
  "no problem",
  "ok",
  "okay",
  "yes",
  "yep",
  "y",
  "go",
  "go ahead",
  "do it",
  "proceed",
  "approve",
  "approved",
  "lgtm",
]);

export function isPlanApprovalMessage(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s。．.,，!！~～…]+$/u, "");
  return normalized.length > 0 && PLAN_APPROVAL_PHRASES.has(normalized);
}

/** Host approve/reject actions (registered by ChatPage): approve = turn off the plan switch +
 *  directly send the execution continuation turn; reject = send the feedback as a normal user
 *  message. Module-level singleton, same pattern as the WebUI bridge. */
export type PlanDecisionHandlers = {
  onApprove: (input: { conversationId: string; plan: string }) => void;
  onReject: (input: { conversationId: string; feedback: string }) => void;
};

let decisionHandlers: PlanDecisionHandlers | null = null;

export function registerPlanDecisionHandlers(next: PlanDecisionHandlers | null) {
  decisionHandlers = next;
}

export type AnswerPlanDecisionOutcome = {
  ok: boolean;
  message?: string;
  /** Failure classification: not_pending (already decided/superseded by a new submission -- the
   * card should settle rather than error) / invalid (arguments or conversation mismatch) /
   * unavailable (host handler not ready). */
  code?: "not_pending" | "invalid" | "unavailable";
};

/**
 * Answer a call's pending plan (shared entry point for the card button/approval phrase/WebUI
 * plan_decision). approve -> host approval handler; reject -> feedback is sent as a message
 * through the host (rejected when feedback is missing). A remote channel must carry a
 * conversationId to prevent cross-conversation answers.
 */
export function answerPlanDecision(
  toolCallId: string,
  rawAnswer: unknown,
  options?: { conversationId?: string },
): AnswerPlanDecisionOutcome {
  const trimmed = toolCallId.trim();
  let pending: PendingPlan | null = null;
  for (const candidate of pendingPlanByConversation.values()) {
    if (candidate.toolCallId === trimmed) {
      pending = candidate;
      break;
    }
  }
  if (!pending) {
    return {
      ok: false,
      code: "not_pending",
      message: "Plan is not pending (already decided or superseded).",
    };
  }
  const expectedConversationId = options?.conversationId?.trim();
  if (expectedConversationId && expectedConversationId !== pending.conversationId) {
    return { ok: false, code: "invalid", message: "Plan belongs to a different conversation." };
  }
  const answer = resolvePlanDecisionAnswer(rawAnswer);
  if (!answer) {
    return { ok: false, code: "invalid", message: 'Decision must be "approve" or "reject".' };
  }
  if (!decisionHandlers) {
    return { ok: false, code: "unavailable", message: "Plan decision handlers are not ready." };
  }
  if (answer.decision === "approve") {
    pendingPlanByConversation.delete(pending.conversationId);
    approvedToolCallIds.add(pending.toolCallId);
    let conversationApproved = approvedToolCallIdsByConversation.get(pending.conversationId);
    if (!conversationApproved) {
      conversationApproved = new Set();
      approvedToolCallIdsByConversation.set(pending.conversationId, conversationApproved);
    }
    conversationApproved.add(pending.toolCallId);
    emitChange();
    try {
      decisionHandlers.onApprove({ conversationId: pending.conversationId, plan: pending.plan });
    } catch (error) {
      console.warn("plan approve handler failed", error);
    }
    return { ok: true };
  }
  const feedback = answer.feedback?.trim() ?? "";
  if (!feedback) {
    return {
      ok: false,
      message: "Rejection needs feedback — just type your changes as a message.",
    };
  }
  // Once feedback is sent the old plan is invalidated (the model will revise and resubmit, and the new submission is registered anew).
  pendingPlanByConversation.delete(pending.conversationId);
  emitChange();
  try {
    decisionHandlers.onReject({ conversationId: pending.conversationId, feedback });
  } catch (error) {
    console.warn("plan reject handler failed", error);
  }
  return { ok: true };
}

/** Fallback cleanup on conversation destruction/abandoning plan mode. Approved state is cleared
 *  as well: approval deletes pending first, so looking up only via pending would let
 *  approvedToolCallIds grow without bound over the process lifetime. */
export function cancelPendingPlanDecisionsForConversation(conversationId: string) {
  const target = conversationId.trim();
  const pending = pendingPlanByConversation.get(target);
  const approved = approvedToolCallIdsByConversation.get(target);
  if (!pending && !approved) return;
  if (pending) {
    pendingPlanByConversation.delete(target);
    approvedToolCallIds.delete(pending.toolCallId);
  }
  if (approved) {
    approvedToolCallIdsByConversation.delete(target);
    for (const toolCallId of approved) {
      approvedToolCallIds.delete(toolCallId);
    }
  }
  emitChange();
}

/**
 * Plan mode tool allowlist predicate: read-only tools pass, plus plan submission and read-only
 * subagent collaboration. Under plan mode the Agent tool is forced readonly by parseSubagentBatch
 * (validate.ts), and SendMessage only writes to the in-conversation message bus without touching
 * the workspace. Everything else (Bash/Write/MCP/manager write operations...) is kept out of the
 * model's tool table entirely -- this saves more tokens than "deny then block" and leaves no
 * leakage surface at all.
 */
export function isPlanModeAllowedTool(
  toolName: string,
  metadata: BuiltinToolMetadata | undefined,
): boolean {
  if (metadata?.isReadOnly) return true;
  return (
    toolName === EXIT_PLAN_MODE_TOOL_NAME ||
    toolName === AGENT_TOOL_NAME ||
    toolName === SEND_MESSAGE_TOOL_NAME
  );
}

/** Plan mode's system prompt section; constant text within a run, injected frozen to protect the
 *  prefix cache. The single authoritative statement of plan mode rules -- toolsSuffix and tool
 *  descriptions only provide guidance and do not restate them, avoiding drift in three places and
 *  wasted tokens. The wording deliberately avoids "MUST before this turn ends" style pressure:
 *  that would raise the submission bar and induce the model to research endlessly in pursuit of
 *  "completeness". */
export function buildPlanModeSystemPromptSection(): string {
  return [
    "<plan-mode>",
    "Plan mode is ACTIVE. This is a read-only planning phase:",
    "- Research with the available read-only tools (and readonly subagents). Stop researching once you can produce the deliverable — do not re-read files you have already read; a re-read returns an unchanged stub, never new information.",
    // AskUserQuestion is always available in plan mode (isReadOnly allowlist) and has
    // suspend-within-run semantics -- after answers arrive the turn continues, without affecting
    // submission termination or bounded escalation.
    `- When a planning detail is genuinely the user's call — scope boundaries, mutually exclusive approaches, trade-offs, target behavior — proactively ask with ${ASK_USER_QUESTION_TOOL_NAME} during research instead of guessing or leaving open questions in the plan. Execution pauses for the answers and continues this turn. Resolve what the code itself can answer; batch the remaining decisions into one focused call.`,
    "- Mutation is impossible this turn: write-capable tools are not in your tool list. Do not promise edits you cannot make here.",
    `- Submit every complete answer through ${EXIT_PLAN_MODE_TOOL_NAME} — implementation plans, architecture summaries, research findings, Q&A, and recommendations alike — instead of plain assistant text. If no code changes are needed, the plan states that and carries the findings.`,
    "- Submitting ends this turn immediately; the user replies with approval or feedback as a normal message. On feedback, revise the plan and submit again.",
    "- If the user asks to save the plan to a file, make that write the first step of the plan itself — the execution turn (full tools) will do it.",
    "- On approval, execution starts automatically in the next turn with full tools — begin that turn by turning the plan into a task list (TaskCreate), then implement. If the plan needs no file changes, confirm that briefly and stop.",
    "- Keep implementation plans concrete: files to touch, ordered steps, risks, and how to verify.",
    "</plan-mode>",
  ].join("\n");
}

// Describes only the tool's own call contract; plan mode's behavioral rules are carried uniformly by the <plan-mode> system section.
const EXIT_PLAN_MODE_TOOL_DESCRIPTION = `Present the complete user-facing deliverable for this turn (every finished answer, not only implementation plans). Only available in plan mode; call it once your research is complete.

Submitting ends this turn immediately. The user replies as a normal message: approval starts execution automatically in the next turn (full tools); anything else is feedback — revise the plan and submit again.

Rules:
- \`plan\` must be the complete, self-contained markdown deliverable. Do not reference earlier messages ("as discussed above").
- Implementation work: goals, files to change, ordered steps, risks, verification. Analysis/Q&A: the full findings, plus whether any follow-up code changes are needed.
- If the user asked to save the plan to a file, include that write as the first step of the plan.`;

const exitPlanModeParameters = Type.Object({
  plan: Type.String({
    description:
      "The complete user-facing deliverable in markdown. Implementation work: goals, files to change, ordered steps, risks, verification. Analysis/Q&A: the full findings, plus whether any follow-up code changes are needed.",
  }),
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

export function createExitPlanModeTools(params: { conversationId: string }): BuiltinToolBundle {
  const toolExitPlanMode: Tool = {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description: EXIT_PLAN_MODE_TOOL_DESCRIPTION,
    parameters: exitPlanModeParameters,
  };

  async function executeToolCall(toolCall: ToolCall): Promise<ToolResultMessage> {
    if (toolCall.name !== EXIT_PLAN_MODE_TOOL_NAME) {
      return buildErrorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
    const plan = sanitizePlanMarkdown(toolCall.arguments?.plan);
    if (!plan) {
      return buildErrorResult(
        toolCall,
        "plan is required: pass the complete markdown deliverable.",
      );
    }

    // Register the pending plan and return immediately -- the runner's termination predicate
    // then ends this turn's run. A new submission overwrites the old registration for the same
    // conversation (the revised plan replaces the previous version).
    pendingPlanByConversation.set(params.conversationId, {
      conversationId: params.conversationId,
      toolCallId: toolCall.id,
      plan,
    });
    emitChange();

    const details: ExitPlanModeResultDetails = {
      kind: "exit_plan_mode",
      plan,
    };
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [
        {
          type: "text",
          text: "Plan submitted; this turn ends here. The user will reply with approval or feedback.",
        },
      ],
      details,
      isError: false,
      timestamp: Date.now(),
    };
  }

  return {
    groupId: "system",
    tools: [toolExitPlanMode],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        EXIT_PLAN_MODE_TOOL_NAME,
        {
          groupId: "system",
          kind: "exit_plan_mode",
          // Read-only: merely registers the pending plan without touching any external state; the plan card is the approval surface, so no tool approval is layered on.
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}

// ---------------------------------------------------------------------------
// Plan mode run policy: bounded escalation state machine.
//
// Principle: never force without bound. Normally toolChoice=auto, so the model can freely wrap up
// with text; termination is guaranteed by four **bounded** lines of defense:
//   1. Termination predicate -- submitting ExitPlanMode ends this turn's run
//      (runner resolveToolTermination);
//   2. Round limit -- maxRounds circuit breaker during research to prevent runaway loops
//      (runner maxRounds);
//   3. Supplementary submission round -- when the run wraps up with text and has not submitted,
//      append a wire-only reminder message and force ExitPlanMode in a targeted way, retrying only
//      once (the nudging phase);
//   4. Text fallback -- when the supplementary submission still produces nothing, register the
//      last assistant text as the pending plan (a synthesized ExitPlanMode call pair), reusing the
//      plan card/approval/persistence with zero changes.
// Any model behavior converges to the plan card within a finite number of steps.
// ---------------------------------------------------------------------------

/** Model round circuit-breaker value for the research phase (inclusive); once reached, the current batch finishes and terminates gracefully, entering supplementary submission. */
export const PLAN_MODE_MAX_RESEARCH_ROUNDS = 32;
/** Round limit for the supplementary submission: under targeted forcing one round suffices to submit, with headroom left for providers that degrade to auto. */
export const PLAN_MODE_MAX_NUDGE_ROUNDS = 4;
/** Number of times a repeated call with the same (tool name, arguments) is allowed; beyond this it is blocked, nudging toward plan submission. */
export const PLAN_MODE_REPEAT_CALL_LIMIT = 2;

/** Wire-only reminder injected in the supplementary submission round (goes only into outbound requests; not persisted, not shown in the UI). */
export const PLAN_MODE_NUDGE_REMINDER = [
  "[plan-mode reminder] Your previous turn ended without submitting the deliverable.",
  `Call ${EXIT_PLAN_MODE_TOOL_NAME} now with the complete user-facing deliverable in markdown,`,
  "based on the research you already completed. Do not run more research tools first.",
].join(" ");

export type PlanModeRunDecision =
  | { kind: "submitted" }
  | { kind: "nudge"; reminderText: string }
  | { kind: "fallback" };

export type PlanModeFallbackPlan = {
  toolCall: ToolCall;
  toolResult: ToolResultMessage;
};

export type PlanModeRunPolicy = {
  /** Submitting ExitPlanMode terminates this turn's run (handed to runner resolveToolTermination). */
  resolveToolTermination: (toolCall: ToolCall) => boolean;
  /** tool_choice for the current run: normally undefined (defaults to auto); in the supplementary submission round it is forced in a targeted way. */
  resolveToolChoice: () => ToolChoice | undefined;
  /** Round circuit-breaker value for the current run (handed to runner maxRounds). */
  maxRounds: () => number;
  /** Anti-spin guard: blocks repeated research calls with the same arguments beyond the allowed count (wired into resolveToolGate). */
  guardRepeatedToolCall: (toolCall: ToolCall) => { allow: true } | { allow: false; reason: string };
  /** Escalation decision after the run ends: submitted -> done; first non-submission -> nudge; again -> fallback. */
  decideAfterRun: (input: { emittedMessages: readonly Message[] }) => PlanModeRunDecision;
  /** Text fallback: registers the assistant text as the pending plan and returns the synthesized
   *  ExitPlanMode call pair; returns null when the text is empty after sanitize (in that case
   *  there is no plan this turn and the turn ends normally). */
  registerFallbackPlan: (input: { planText: string }) => PlanModeFallbackPlan | null;
};

/** Stable serialization with recursive key sorting: repeated-call detection is unaffected by object key order. Model arguments come from JSON and are acyclic. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hasSuccessfulPlanSubmission(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === EXIT_PLAN_MODE_TOOL_NAME &&
      !message.isError,
  );
}

export function createPlanModeRunPolicy(params: { conversationId: string }): PlanModeRunPolicy {
  let phase: "researching" | "nudging" = "researching";
  const repeatCounts = new Map<string, number>();

  return {
    resolveToolTermination: (toolCall) => toolCall.name === EXIT_PLAN_MODE_TOOL_NAME,

    resolveToolChoice: () =>
      // Targeted forcing appears only in the bounded supplementary submission round; when a
      // provider does not support it (such as Anthropic thinking, Google), the provider layer
      // degrades it to auto, and the reminder message still takes effect.
      phase === "nudging" ? { type: "tool" as const, name: EXIT_PLAN_MODE_TOOL_NAME } : undefined,

    maxRounds: () =>
      phase === "nudging" ? PLAN_MODE_MAX_NUDGE_ROUNDS : PLAN_MODE_MAX_RESEARCH_ROUNDS,

    guardRepeatedToolCall: (toolCall) => {
      if (toolCall.name === EXIT_PLAN_MODE_TOOL_NAME) return { allow: true };
      const key = `${toolCall.name}\u0000${stableStringify(toolCall.arguments ?? {})}`;
      const count = (repeatCounts.get(key) ?? 0) + 1;
      repeatCounts.set(key, count);
      if (count <= PLAN_MODE_REPEAT_CALL_LIMIT) return { allow: true };
      return {
        allow: false,
        reason:
          `You already made this exact ${toolCall.name} call in this planning turn and its result has not changed. ` +
          `Use the content you already gathered, or submit the deliverable via ${EXIT_PLAN_MODE_TOOL_NAME}.`,
      };
    },

    decideAfterRun: ({ emittedMessages }) => {
      if (hasSuccessfulPlanSubmission(emittedMessages)) {
        return { kind: "submitted" };
      }
      if (phase === "researching") {
        phase = "nudging";
        return { kind: "nudge", reminderText: PLAN_MODE_NUDGE_REMINDER };
      }
      return { kind: "fallback" };
    },

    registerFallbackPlan: ({ planText }) => {
      const plan = sanitizePlanMarkdown(planText);
      if (!plan) return null;
      const toolCallId = `call_plan_fallback_${crypto.randomUUID().replaceAll("-", "")}`;
      const toolCall: ToolCall = {
        type: "toolCall",
        id: toolCallId,
        name: EXIT_PLAN_MODE_TOOL_NAME,
        arguments: { plan },
      };
      // Fully isomorphic to a real ExitPlanMode execution: register the pending plan (overwriting
      // the old registration) and notify subscribers, reusing the plan card button state, WebUI
      // preview, and approval entry with zero changes.
      pendingPlanByConversation.set(params.conversationId, {
        conversationId: params.conversationId,
        toolCallId,
        plan,
      });
      emitChange();
      const details: ExitPlanModeResultDetails = { kind: "exit_plan_mode", plan };
      return {
        toolCall,
        toolResult: {
          role: "toolResult",
          toolCallId,
          toolName: EXIT_PLAN_MODE_TOOL_NAME,
          content: [
            {
              type: "text",
              text: "Plan captured from the assistant's final text; the user will reply with approval or feedback.",
            },
          ],
          details,
          isError: false,
          timestamp: Date.now(),
        },
      };
    },
  };
}
