import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";

export type TransientSidebarRunningConversation = {
  conversationId: string;
  workdir?: string | null;
};

export function mergeTransientSidebarRunningActivity(
  runningConversationIds: ReadonlySet<string>,
  runningProjectPathKeys: ReadonlySet<string>,
  transients:
    | readonly (TransientSidebarRunningConversation | null | undefined)[]
    | TransientSidebarRunningConversation
    | null
    | undefined,
): {
  runningConversationIds: ReadonlySet<string>;
  runningProjectPathKeys: ReadonlySet<string>;
} {
  // Supports multiple transient sessions "spinning" at once (issue #359 defect #3): manual compaction pending is
  // now keyed by session id, so multiple background sessions can compact concurrently. It accepts an array and also
  // remains backward-compatible with a single-object argument.
  const list = Array.isArray(transients)
    ? transients
    : transients
      ? [transients as TransientSidebarRunningConversation]
      : [];
  let nextConversationIds = runningConversationIds;
  let nextProjectPathKeys = runningProjectPathKeys;
  for (const transient of list) {
    const conversationId = transient?.conversationId.trim() ?? "";
    const projectPathKey = workspaceProjectPathKey(transient?.workdir ?? "");
    if (conversationId && !nextConversationIds.has(conversationId)) {
      nextConversationIds = new Set(nextConversationIds).add(conversationId);
    }
    if (projectPathKey && !nextProjectPathKeys.has(projectPathKey)) {
      nextProjectPathKeys = new Set(nextProjectPathKeys).add(projectPathKey);
    }
  }
  return {
    runningConversationIds: nextConversationIds,
    runningProjectPathKeys: nextProjectPathKeys,
  };
}
