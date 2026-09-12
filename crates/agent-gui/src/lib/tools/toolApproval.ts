// Tool approval service (desktop is authoritative): tools whose policy is ask suspend at beforeToolCall and wait
// for the user to decide via the approval card in chat. It shares the suspend/settle/timeout/abort model of
// AskUserQuestion (see askUserQuestionTools.ts), with two differences:
//   1. What is approved is an ordinary tool call (Bash/plugin tool...), and the suspension happens before its
//      execution rather than in the tool itself; so the card must reactively observe the appearance/disappearance
//      of pending entries (useSyncExternalStore).
//   2. Timeout defaults to "deny" (permission should not be granted by default), more conservative than
//      AskUserQuestion's "auto-select the recommendation".
// A remote (WebUI) answer forwarded to the desktop via gateway chat_queue.tool_approval goes through the same
// answerToolApproval entry point (wired up in step 3).

import { ASK_USER_QUESTION_TIMEOUT_MS } from "@liveagent/ui/lib/chat/askUserQuestion";

/** Approval window in milliseconds: reuses AskUserQuestion's duration constant for consistent behavior. */
export const TOOL_APPROVAL_TIMEOUT_MS = ASK_USER_QUESTION_TIMEOUT_MS;

/** approve: allow this time; deny: reject this time; approve_session: skip approval for this tool for the rest of the session. */
export type ToolApprovalDecision = "approve" | "deny" | "approve_session";

export type ToolApprovalSettlement =
  | { kind: "decided"; decision: ToolApprovalDecision }
  | { kind: "timeout" }
  | { kind: "cancelled" };

type PendingToolApproval = {
  conversationId: string;
  toolName: string;
  /** Command/argument summary (for uniform display in the approval bar; e.g. Bash shows the command). */
  summary: string;
  /** Authoritative answer deadline timestamp (ms); the card countdown and the timeout fallback share this source. */
  deadlineAt: number;
  settle: (settlement: ToolApprovalSettlement) => void;
};

const pendingByToolCallId = new Map<string, PendingToolApproval>();

// Set of tool names "remembered (approve_session)" for this session, partitioned by conversationId.
// In-memory only and lives with the session lifetime; persisted policies go through settings.system.toolPolicies.
const sessionAllowByConversation = new Map<string, Set<string>>();

// useSyncExternalStore subscription: bump the version and notify when the pending table changes, driving the
// approval card to re-render when a suspension appears/settles (the approved tool call itself is already in the transcript).
const listeners = new Set<() => void>();
const listenersByConversation = new Map<string, Set<() => void>>();
const pendingSnapshotsByConversation = new Map<string, PendingToolApprovalSummary[]>();
const EMPTY_PENDING_APPROVALS: PendingToolApprovalSummary[] = [];
Object.freeze(EMPTY_PENDING_APPROVALS);
let version = 0;

function emitChange(conversationId: string) {
  const key = conversationId.trim();
  version += 1;
  for (const listener of listeners) listener();
  if (!key) return;
  pendingSnapshotsByConversation.delete(key);
  const conversationListeners = listenersByConversation.get(key);
  if (!conversationListeners) return;
  for (const listener of Array.from(conversationListeners)) listener();
}

export function subscribeToolApprovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToolApprovalVersion(): number {
  return version;
}

export function subscribeToolApprovalsForConversation(
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

export function getPendingToolApproval(toolCallId: string): PendingToolApproval | null {
  return pendingByToolCallId.get(toolCallId.trim()) ?? null;
}

export function hasPendingToolApproval(toolCallId: string): boolean {
  return pendingByToolCallId.has(toolCallId.trim());
}

export function getToolApprovalDeadlineAt(toolCallId: string): number | null {
  return pendingByToolCallId.get(toolCallId.trim())?.deadlineAt ?? null;
}

/** All current pending approvals for a conversation (iterated by the centralized approval bar above the input box).
 *  Refreshes reactively with pending-table changes via the subscribeToolApprovals/getToolApprovalVersion subscription. */
export type PendingToolApprovalSummary = {
  toolCallId: string;
  toolName: string;
  summary: string;
  deadlineAt: number;
};

export function listPendingToolApprovalsForConversation(
  conversationId: string,
): PendingToolApprovalSummary[] {
  const target = conversationId.trim();
  const out: PendingToolApprovalSummary[] = [];
  for (const [toolCallId, pending] of pendingByToolCallId) {
    if (pending.conversationId === target) {
      out.push({
        toolCallId,
        toolName: pending.toolName,
        summary: pending.summary,
        deadlineAt: pending.deadlineAt,
      });
    }
  }
  return out;
}

export function getPendingToolApprovalsSnapshot(
  conversationId: string,
): PendingToolApprovalSummary[] {
  const key = conversationId.trim();
  if (!key) return EMPTY_PENDING_APPROVALS;
  const cached = pendingSnapshotsByConversation.get(key);
  if (cached) return cached;
  const pending = listPendingToolApprovalsForConversation(key);
  if (pending.length === 0) return EMPTY_PENDING_APPROVALS;
  pendingSnapshotsByConversation.set(key, pending);
  return pending;
}

export function isSessionApproved(conversationId: string, toolName: string): boolean {
  return sessionAllowByConversation.get(conversationId)?.has(toolName) ?? false;
}

function rememberSessionApproval(conversationId: string, toolName: string) {
  let set = sessionAllowByConversation.get(conversationId);
  if (!set) {
    set = new Set();
    sessionAllowByConversation.set(conversationId, set);
  }
  set.add(toolName);
}

export type AnswerToolApprovalOutcome = { ok: boolean; message?: string };

/** Answer a pending approval; the remote channel must carry conversationId to prevent cross-session answers. */
export function answerToolApproval(
  toolCallId: string,
  decision: ToolApprovalDecision,
  options?: { conversationId?: string },
): AnswerToolApprovalOutcome {
  const pending = pendingByToolCallId.get(toolCallId.trim());
  if (!pending) {
    return { ok: false, message: "No pending approval (already decided or cancelled)." };
  }
  const expectedConversationId = options?.conversationId?.trim();
  if (expectedConversationId && expectedConversationId !== pending.conversationId) {
    return { ok: false, message: "Approval belongs to a different conversation." };
  }
  pending.settle({ kind: "decided", decision });
  return { ok: true };
}

/** Fallback on conversation destruction: pending approvals settle as "cancelled (not approved)". Normal aborts are handled by AbortSignal. */
export function cancelPendingToolApprovalsForConversation(conversationId: string) {
  const targetConversationId = conversationId.trim();
  for (const [toolCallId, pending] of pendingByToolCallId) {
    if (pending.conversationId === targetConversationId) {
      pendingByToolCallId.delete(toolCallId);
      pending.settle({ kind: "cancelled" });
    }
  }
  sessionAllowByConversation.delete(targetConversationId);
}

/**
 * Suspend and wait for the user to make an approval decision on a tool call. Called by beforeToolCall's approval gate.
 * - AbortSignal (turn stopped) -> settles as cancelled.
 * - Window exceeded -> settles as timeout (the gate treats it as deny).
 * - approve_session -> recorded in this session's approval-exempt set.
 */
export function requestToolApproval(params: {
  toolCallId: string;
  toolName: string;
  summary?: string;
  conversationId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ToolApprovalSettlement> {
  const toolCallId = params.toolCallId.trim();
  const conversationId = params.conversationId.trim();
  const timeoutMs = params.timeoutMs ?? TOOL_APPROVAL_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;

  if (params.signal?.aborted) {
    return Promise.resolve({ kind: "cancelled" });
  }

  return new Promise<ToolApprovalSettlement>((resolve) => {
    const settle = (settlement: ToolApprovalSettlement) => {
      // Idempotent: the first settlement to arrive (user decision/timeout/abort) clears the remaining listeners and broadcasts.
      if (pendingByToolCallId.get(toolCallId) === pending) {
        pendingByToolCallId.delete(toolCallId);
      }
      params.signal?.removeEventListener("abort", onAbort);
      clearTimeout(timeoutId);
      if (settlement.kind === "decided" && settlement.decision === "approve_session") {
        rememberSessionApproval(conversationId, params.toolName);
      }
      emitChange(conversationId);
      resolve(settlement);
    };
    const onAbort = () => settle({ kind: "cancelled" });
    const timeoutId = setTimeout(() => settle({ kind: "timeout" }), Math.max(0, timeoutMs));
    const pending: PendingToolApproval = {
      conversationId,
      toolName: params.toolName,
      summary: params.summary ?? "",
      deadlineAt,
      settle,
    };
    pendingByToolCallId.set(toolCallId, pending);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    emitChange(conversationId);
  });
}
