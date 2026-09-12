// Session-level skills explicit-mention injection controller: holds "which user message should carry which explicit-mention block".
//
// Why this state layer is needed: the explicit-mention block must be replayed verbatim in
// subsequent turns. If it were attached only in the turn where it occurs and removed the next
// turn, the bytes of that user message would change, and the whole history range from it onward
// would be invalidated --- exactly the problem that keeping content in the system prompt is meant
// to avoid; repeating it in another place would be pointless.
//
// Same shape as memory's injectionController (stored by session key, bound by message id,
// cleaned up on session deletion, LRU-capped), but stored separately on purpose: memory's
// baseline carries systemText semantics, and manual compaction reads it to reuse the frozen
// snapshot, so stuffing the skills blocks into that state would make them appear out of nowhere in the baseline.
//
// The blocks live only in memory, are never persisted or written into history: they are context
// sent to the model, not text the user actually typed. They are lost after a process restart /
// session restore, and subsequent turns no longer replay them --- at that point the prefix has to
// be rebuilt anyway, so nothing is lost.

/** Upper bound on the number of cached sessions, on the same order as the memory injection controller. */
const SKILL_MENTION_CONVERSATION_STATE_LIMIT = 32;

export type SkillMentionUpdateMap = ReadonlyMap<string, string>;

type ConversationSkillMentionState = {
  /** messageId -> explicit-mention block. Once written it is never modified and is replayed verbatim in subsequent turns. */
  updates: Map<string, string>;
  lastTouchedAt: number;
};

const states = new Map<string, ConversationSkillMentionState>();

function pruneStates() {
  if (states.size <= SKILL_MENTION_CONVERSATION_STATE_LIMIT) return;
  const sorted = [...states.entries()].sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
  for (const [key] of sorted.slice(0, states.size - SKILL_MENTION_CONVERSATION_STATE_LIMIT)) {
    states.delete(key);
  }
}

export const skillMentionInjection = {
  /**
   * Record this turn's explicit-mention block. An empty block string means there was no
   * `/skill-name` mention this turn --- in that case do nothing and do not even create state,
   * guaranteeing that "no mention produces no extra content".
   */
  record(params: { conversationId: string; messageId?: string; block: string }) {
    const block = params.block;
    if (!block) return;

    const key = params.conversationId.trim();
    const messageId = params.messageId?.trim() ?? "";
    // If there is no session key or no mountable message id, drop this mention: better to skip
    // attaching once than to attach it to a message it does not match.
    if (!key || !messageId) return;

    const existing = states.get(key);
    const state = existing ?? { updates: new Map<string, string>(), lastTouchedAt: 0 };
    state.updates.set(messageId, block);
    state.lastTouchedAt = Date.now();
    if (!existing) {
      states.set(key, state);
      pruneStates();
    }
  },

  /** Read when assembling the request context: messageId -> explicit-mention block. */
  getMessageUpdates(conversationId: string): SkillMentionUpdateMap | undefined {
    return states.get(conversationId.trim())?.updates;
  },

  /** Session deleted/trimmed: discard along with the recorded block. */
  dispose(conversationId: string) {
    states.delete(conversationId.trim());
  },

  /** App exit. */
  disposeAll() {
    states.clear();
  },
};
