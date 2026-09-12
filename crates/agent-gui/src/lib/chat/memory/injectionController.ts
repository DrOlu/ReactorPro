// Conversation-level memory injection controller: holds both "the snapshot frozen
// into the system prompt on the first turn" and "the incremental blocks attached to
// user messages on later turns"; it is the sole state holder of memory injection positions.
//
// All decision logic lives in the pure function turnInjection; this only owns state:
// store/retrieve by conversation key, bind increments by message id, clean up on
// conversation deletion, and cap with LRU to prevent unbounded map growth.
//
// Increments live only in memory, never persisted or added to history: after a process
// restart / conversation restore the baseline is lost, and the next turn puts the full
// snapshot back into the system prompt -- that turn's prefix has to be rebuilt anyway,
// so nothing is lost.

import {
  type MemoryInjectionBaseline,
  type MemoryTurnUpdateMap,
  planMemoryTurnInjection,
} from "../../memory/prompts/turnInjection";

/** Upper bound on cached conversations; the same order of magnitude as the runtime cache is fine. */
const INJECTION_CONVERSATION_STATE_LIMIT = 32;

type ConversationInjectionState = {
  baseline: MemoryInjectionBaseline;
  /** messageId -> incremental block. Once written it never changes and is replayed verbatim on later turns. */
  updates: Map<string, string>;
  lastTouchedAt: number;
};

const states = new Map<string, ConversationInjectionState>();

function pruneStates() {
  if (states.size <= INJECTION_CONVERSATION_STATE_LIMIT) return;
  const sorted = [...states.entries()].sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
  for (const [key] of sorted.slice(0, states.size - INJECTION_CONVERSATION_STATE_LIMIT)) {
    states.delete(key);
  }
}

export type MemoryTurnInjectionResult = {
  /** Memory text placed into the system prompt this turn. */
  systemText: string;
  /** The incremental block newly attached this turn, for the caller to observe; empty means no change. */
  turnUpdate: string;
};

export const memoryTurnInjection = {
  /**
   * Called once at the request boundary: decides whether this turn's memory goes into
   * the system section or into a user-message increment. overview null means the read
   * failed, in which case the baseline is left untouched. When plan determines
   * refrozen, the already-attached increment blocks are cleared in step -- they
   * describe differences against the old snapshot and would contradict the re-frozen
   * system section.
   */
  planTurn(params: {
    conversationId: string;
    messageId?: string;
    overview: string | null;
    workdir?: string;
  }): MemoryTurnInjectionResult {
    const key = params.conversationId.trim();
    if (!key) {
      // Without a conversation key there is no way to maintain a baseline, so fall back
      // to the old behavior: put the whole block into the system prompt.
      return { systemText: params.overview ?? "", turnUpdate: "" };
    }

    const existing = states.get(key);
    const plan = planMemoryTurnInjection({
      baseline: existing?.baseline ?? null,
      overview: params.overview,
      workdir: params.workdir,
    });
    if (!plan.baseline) {
      return { systemText: plan.systemText, turnUpdate: "" };
    }

    const messageId = params.messageId?.trim() ?? "";
    if (plan.turnUpdate && !messageId) {
      // No message id to attach to: drop this increment without advancing the
      // fingerprint, leaving it to be added on the next turn.
      return { systemText: plan.systemText, turnUpdate: "" };
    }

    const state = existing ?? {
      baseline: plan.baseline,
      updates: new Map<string, string>(),
      lastTouchedAt: 0,
    };
    state.baseline = plan.baseline;
    state.lastTouchedAt = Date.now();
    if (plan.refrozen) {
      state.updates.clear();
    }
    if (plan.turnUpdate) {
      state.updates.set(messageId, plan.turnUpdate);
    }
    if (!existing) {
      states.set(key, state);
      pruneStates();
    }

    return { systemText: plan.systemText, turnUpdate: plan.turnUpdate };
  },

  /** Read when assembling request context: messageId -> incremental block. */
  getMessageUpdates(conversationId: string): MemoryTurnUpdateMap | undefined {
    return states.get(conversationId.trim())?.updates;
  },

  /**
   * Reads the frozen system-section snapshot. A bypass such as manual compaction reads
   * its own fresh overview; using that freshly read one directly would make the system
   * section flap back and forth between "the compaction turn and the next turn's send",
   * needlessly wasting an extra prefix. Returning undefined means this conversation has
   * no baseline yet and the caller should fall back on its own.
   */
  getSystemText(conversationId: string): string | undefined {
    return states.get(conversationId.trim())?.baseline.systemText;
  },

  /**
   * Called after compaction completes: compaction moves the user messages carrying
   * increment blocks out of the active segment, making those increments permanently
   * invisible to the model while the baseline fingerprint has already moved past them
   * -- continuing to increment would silently lose those changes. Discard the whole
   * conversation state so the next planTurn takes the first-turn branch and re-freezes
   * a fresh snapshot into the system section; compaction rebuilds the prefix anyway, so
   * this re-freeze is free.
   */
  invalidate(conversationId: string) {
    states.delete(conversationId.trim());
  },

  /** Conversation deleted/trimmed away: discard the baseline too. */
  dispose(conversationId: string) {
    states.delete(conversationId.trim());
  },

  /** Application exit. */
  disposeAll() {
    states.clear();
  },
};
