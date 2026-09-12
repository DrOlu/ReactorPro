import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateContentTokenUnits } from "@liveagent/ui/lib/chat/contextUsage";
import { sanitizeMessageForModelContext } from "../context/requestContextSanitizer";
import {
  type ConversationViewState,
  getActiveSegment,
  replaceActiveSegmentMessages,
} from "../conversation/conversationState";
import type { PruneOptions } from "./policy";

const PRUNED_TOOL_OUTPUT_TEXT = "[output pruned to preserve context budget]";

export type PruneConversationResult = {
  applied: boolean;
  state: ConversationViewState;
  prunedMessageCount: number;
  releasedTokens: number;
};

/**
 * Non-LLM fallback: trims tool output bodies from oldest to newest (keeping the most recent N user
 * turns and a protected allowance) until minimumReleasedTokens is released. The trim aggressiveness
 * is given by the policy's pressure ladder.
 */
export function pruneConversationState(
  state: ConversationViewState,
  options: PruneOptions,
): PruneConversationResult {
  const activeSegment = getActiveSegment(state);
  if (!activeSegment || activeSegment.messages.length === 0) {
    return { applied: false, state, prunedMessageCount: 0, releasedTokens: 0 };
  }

  const minimumReleasedTokens = Math.max(0, Math.floor(options.minimumReleasedTokens));
  const protectedToolTokens = Math.max(0, Math.floor(options.protectedToolTokens));
  const protectedRecentUserTurns = Math.max(1, Math.floor(options.protectedRecentUserTurns));

  const nextMessages = activeSegment.messages.slice();
  let userTurnsSeen = 0;
  let traversedToolTokens = 0;
  let releasedTokens = 0;
  let prunedMessageCount = 0;

  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (message.role === "user") {
      userTurnsSeen += 1;
      continue;
    }
    if (message.role !== "toolResult") continue;
    if (userTurnsSeen < protectedRecentUserTurns) continue;

    const modelMessage = sanitizeMessageForModelContext(message) as ToolResultMessage;
    // Released bytes use the same measure as the ledger: count only the model-visible content
    // (details are not sent to the model). Including details would overstate the released amount and
    // stop early while the actual context has not dropped enough.
    const estimated = Math.ceil(estimateContentTokenUnits(modelMessage.content));
    if (estimated <= 0) continue;
    traversedToolTokens += estimated;
    if (traversedToolTokens <= protectedToolTokens) continue;

    nextMessages[index] = {
      ...message,
      content: [{ type: "text", text: PRUNED_TOOL_OUTPUT_TEXT }],
      details: {
        pruned: true,
        originalToolName: message.toolName,
        estimatedReleasedTokens: estimated,
      },
    };
    releasedTokens += estimated;
    prunedMessageCount += 1;
    if (releasedTokens >= minimumReleasedTokens) {
      break;
    }
  }

  if (prunedMessageCount === 0) {
    return { applied: false, state, prunedMessageCount: 0, releasedTokens: 0 };
  }

  return {
    applied: true,
    state: replaceActiveSegmentMessages(state, nextMessages),
    prunedMessageCount,
    releasedTokens,
  };
}
