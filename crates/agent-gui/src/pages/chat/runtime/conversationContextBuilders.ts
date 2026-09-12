import type { Context, UserMessage } from "@earendil-works/pi-ai";

import {
  buildRequestContext,
  type ConversationViewState,
} from "../../../lib/chat/conversation/conversationState";
import type { SkillMentionUpdateMap } from "../../../lib/chat/skills/mentionInjection";
import {
  attachMemoryTurnUpdates,
  type MemoryTurnUpdateMap,
} from "../../../lib/memory/prompts/turnInjection";
import { appendSystemPrompt } from "./chatPageRuntime";

export type ConversationContextBuildOptions = {
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
};

/**
 * The raw text of each segment composing the system prompt.
 *
 * The trajectory hashes these boundaries per segment for dedup: whole-text
 * hashing necessarily fails here because the memory segment is re-rendered every
 * turn, producing a fresh full-text snapshot each turn.
 */
export type PreparedSystemPromptSlots = {
  base?: string;
  agent?: string;
  skills?: string;
  memory?: string;
  /** Dynamic run-only additions: roster, message bus, and authoritative task state. */
  runtime?: string;
};

/**
 * Collects the segment raw text from the most recent context build.
 *
 * A holder is used instead of a return value so as not to change
 * `buildPreparedContext`'s return type — it is consumed directly as `Context` in
 * several places.
 *
 * @returns capture for the builder callback, read for instrumentation to read the latest result.
 */
export function createPreparedSystemPromptSlotHolder(): {
  capture: (slots: PreparedSystemPromptSlots) => void;
  read: () => PreparedSystemPromptSlots;
} {
  let latest: PreparedSystemPromptSlots = {};
  return {
    capture: (slots) => {
      latest = slots;
    },
    read: () => latest,
  };
}

export function buildCompactionContext(
  state: ConversationViewState,
  tools?: Context["tools"],
  options?: ConversationContextBuildOptions,
): Context {
  const baseContext = buildRequestContext(state, options);
  return Array.isArray(tools) && tools.length > 0
    ? {
        ...baseContext,
        tools,
      }
    : baseContext;
}

export function buildPreparedContext(params: {
  state: ConversationViewState;
  tools?: Context["tools"];
  activeAgentPrompt: string;
  skillsPrompt: string;
  memoryPrompt?: string;
  memoryTurnUpdates?: MemoryTurnUpdateMap | null;
  skillMentionUpdates?: SkillMentionUpdateMap | null;
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
  /** Segment callback for trajectory instrumentation; zero overhead when not passed. */
  captureSlots?: (slots: PreparedSystemPromptSlots) => void;
}): Context {
  // The AGENTS / Skills / memory segments are concatenated into systemPrompt,
  // and beginRequest's fixedTokens is estimated from this full text — they are
  // not "excluded from usage". They merely should not be stacked separately into
  // the compaction input.
  const withTools = buildCompactionContext(params.state, params.tools, {
    includeAbortedMessages: params.includeAbortedMessages,
    includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
  });

  params.captureSlots?.({
    ...(typeof withTools.systemPrompt === "string" ? { base: withTools.systemPrompt } : {}),
    ...(params.activeAgentPrompt ? { agent: params.activeAgentPrompt } : {}),
    ...(params.skillsPrompt ? { skills: params.skillsPrompt } : {}),
    ...(params.memoryPrompt ? { memory: params.memoryPrompt } : {}),
  });

  let systemPrompt = withTools.systemPrompt;
  if (params.activeAgentPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, params.activeAgentPrompt);
  }
  if (params.skillsPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, params.skillsPrompt);
  }
  if (params.memoryPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, params.memoryPrompt);
  }

  // The dynamic part of memory is attached to the tail of the corresponding user
  // message rather than being stuffed into the system segment: once the system
  // segment changes, the entire cache prefix is invalidated along with all
  // history. The same applies to skills' "explicit mentions": they are only
  // valid for the current turn, and leaving them in the system segment would
  // invalidate two prefixes with one input. Both use the same attachment
  // convention with a fixed order (memory first, skills after), and
  // already-attached blocks are replayed verbatim in later turns, so the bytes
  // of the history range stay stable.
  const withMemory = attachMemoryTurnUpdates(withTools.messages, params.memoryTurnUpdates);
  const messages = attachMemoryTurnUpdates(withMemory, params.skillMentionUpdates);
  const withMessages = messages === withTools.messages ? withTools : { ...withTools, messages };

  return typeof systemPrompt === "string"
    ? {
        ...withMessages,
        systemPrompt,
      }
    : withMessages;
}

export function buildResumeContext(params: {
  state: ConversationViewState;
  resumeMessage?: UserMessage;
  tools?: Context["tools"];
  activeAgentPrompt: string;
  skillsPrompt: string;
  memoryPrompt?: string;
  memoryTurnUpdates?: MemoryTurnUpdateMap | null;
  skillMentionUpdates?: SkillMentionUpdateMap | null;
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
  captureSlots?: (slots: PreparedSystemPromptSlots) => void;
}): Context {
  const baseContext = buildPreparedContext({
    ...params,
    includeAbortedMessages: params.includeAbortedMessages,
  });
  if (!params.resumeMessage) {
    return baseContext;
  }
  return {
    ...baseContext,
    messages: [...baseContext.messages, params.resumeMessage],
  };
}
