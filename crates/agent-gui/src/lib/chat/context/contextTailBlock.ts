import type { Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/**
 * display-image tool results cannot be anchors: requestContextSanitizer replaces
 * the content of these messages wholesale with a single text block (see its
 * isDisplayImageToolResult branch), so incremental blocks appended to the tail are
 * silently destroyed on the next sanitization pass.
 */
function isDisplayImageToolResult(message: ToolResultMessage) {
  if (message.isError) return false;
  if (message.toolName === "Image") return true;
  return isRecord(message.details) && message.details.kind === "display_image";
}

/**
 * subagent card tool results cannot be anchors: the whole message is filtered out during
 * sanitization, and anything attached to it disappears with it.
 */
function isSubagentCardToolResult(message: ToolResultMessage) {
  return isRecord(message.details) && message.details.kind === "subagent_card";
}

/**
 * Tool results immediately following an aborted assistant cannot be anchors:
 * stripAbortedMessagesForModelContext discards them together with it.
 */
function followsAbortedAssistant(messages: Message[], index: number) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message.role === "toolResult") continue;
    return message.role === "assistant" && message.stopReason === "aborted";
  }
  return false;
}

/**
 * Finds the tool result message that can carry the tail blocks and returns its toolCallId.
 *
 * Anchors are only searched for after the last user message: a cache breakpoint can at most extend to the
 * last user message, and the tool-loop messages after it are re-read every round anyway, so appending loses
 * no extra cache hits; crossing the user message would rewrite the already-cached prefix, which is worse than
 * not appending at all.
 *
 * A message with an empty toolCallId cannot be an anchor: an anchor that cannot be pinned is no anchor, and
 * later rounds would degrade into re-searching, exactly the drift this module exists to eliminate. Returning
 * null means there is no safe anchor this round, and the caller treats it as "cannot attach", advancing no
 * cursor and retrying next round.
 */
export function resolveTailBlockAnchorId(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role !== "toolResult") continue;
    if (!Array.isArray(message.content)) continue;
    if (typeof message.toolCallId !== "string" || !message.toolCallId) continue;
    if (isDisplayImageToolResult(message)) continue;
    if (isSubagentCardToolResult(message)) continue;
    if (followsAbortedAssistant(messages, index)) continue;
    return message.toolCallId;
  }
  return null;
}

/** A tail content segment already delivered, together with the toolCallId of the message it was first attached to. */
export type PinnedTailBlock = {
  /** The anchor resolved when first attached; later rounds reattach it unchanged to the same message. */
  anchorToolCallId: string;
  text: string;
};

/**
 * Reattaches pinned tail blocks to their respective anchor messages.
 *
 * **Anchors must be pinned down, never re-searched each round**: as the tool loop advances, the
 * "last tool result" changes, and re-searching would move a block from the previous round's message to a
 * new one -- the old message's bytes then revert, invalidating the entire prefix from that point on. That is
 * exactly the problem that moving content out of systemPrompt set out to avoid, and committing it again in a
 * different place is pointless (observed: in a 3-round tool loop, from round 2 onward every round diverges at
 * the old message).
 *
 * Multiple blocks on the same anchor are concatenated in delivery order into separate text blocks; a fixed
 * order means fixed bytes. When an anchor is no longer in the message list (compaction truncation, etc.), that
 * block is not attached this round -- the caller already clears accumulated state and re-freezes at the
 * compaction boundary, so there is no need to fall back to relocating here.
 *
 * No in-place mutation -- message objects share references with runtime state and session state.
 * If no block was attached, the input array is returned unchanged (reference-equal).
 */
export function attachPinnedTailBlocks(
  messages: Message[],
  blocks: readonly PinnedTailBlock[],
): Message[] {
  if (blocks.length === 0) return messages;

  const byAnchor = new Map<string, string[]>();
  for (const block of blocks) {
    if (!block.text) continue;
    const existing = byAnchor.get(block.anchorToolCallId);
    if (existing) existing.push(block.text);
    else byAnchor.set(block.anchorToolCallId, [block.text]);
  }
  if (byAnchor.size === 0) return messages;

  let next: Message[] | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "toolResult") continue;
    if (!Array.isArray(message.content)) continue;
    const texts = byAnchor.get(message.toolCallId);
    if (!texts) continue;

    const appended: TextContent[] = texts.map((text) => ({ type: "text", text }));
    if (!next) next = messages.slice();
    next[index] = { ...message, content: [...message.content, ...appended] };
  }

  return next ?? messages;
}
