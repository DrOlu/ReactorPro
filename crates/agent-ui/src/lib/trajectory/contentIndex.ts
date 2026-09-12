/**
 * Build the body index from the loaded `UiMessage`s.
 *
 * The event stream only stores ordering and structure; the full body reuses the transcript
 * window the host has already loaded. The stable messageId is the primary join key for new
 * trajectories, while conversation-global messageIndex and window order serve only as
 * compatibility fallbacks.
 */

import type { UiMessage, UiRound } from "../chat/uiMessages";
import {
  getRoundText,
  getRoundThinkingText,
  getRoundToolTrace,
  safeStringify,
  toolCallArgsForDisplay,
  toolResultMessageToText,
} from "../chat/uiMessages";
import {
  stepKey,
  type TrajectoryAssistantContent,
  type TrajectoryContentEntry,
  type TrajectoryContentIndex,
  type TrajectoryIndexedAssistantContent,
  type TrajectoryIndexedToolContent,
  type TrajectoryToolContent,
} from "./layout";
import type { TrajectoryLedger, TrajectorySourceBlock } from "./types";

function roundSourceBlocks(round: UiRound): readonly TrajectorySourceBlock[] {
  return round.blocks.flatMap((block): TrajectorySourceBlock[] => {
    if (block.kind === "text" || block.kind === "thinking") {
      return block.text === "" ? [] : [{ type: block.kind, content: block.text }];
    }
    if (block.kind === "tool") {
      const call = block.item.toolCall;
      return [
        {
          type: "tool-call",
          content: safeStringify(toolCallArgsForDisplay(call)),
          callId: call.id,
          toolName: call.name,
        },
      ];
    }
    return [{ type: "hosted-search", content: safeStringify(block.item) }];
  });
}

function toolOutputBlocks(
  item: ReturnType<typeof getRoundToolTrace>[number],
): readonly TrajectorySourceBlock[] | undefined {
  const result = item.toolResult;
  if (result === undefined || !Array.isArray(result.content)) return undefined;
  const blocks = result.content.flatMap((raw, index): TrajectorySourceBlock[] => {
    const block = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (block.type === "text" && typeof block.text === "string") {
      return [{ type: "text", content: block.text }];
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      return [
        {
          type: "image",
          content: `[${block.mimeType} image]`,
          imageSrc: `data:${block.mimeType};base64,${block.data}`,
          imageAlt: `${item.toolCall.name} output ${index + 1}`,
        },
      ];
    }
    return [{ type: String(block.type ?? "unknown"), content: safeStringify(raw) }];
  });
  return blocks.length === 0 ? undefined : blocks;
}

function fileSource(path: string): "absolute" | "relative" | "file-url" {
  if (path.startsWith("file://")) return "file-url";
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return "absolute";
  return "relative";
}

function userSourceBlocks(message: UiMessage): readonly TrajectorySourceBlock[] | undefined {
  const blocks: TrajectorySourceBlock[] = [];
  if (message.text !== "") blocks.push({ type: "text", content: message.text });
  for (const file of message.attachments ?? []) {
    const path = typeof file.relativePath === "string" ? file.relativePath.trim() : "";
    blocks.push({
      type: `attachment:${file.kind}`,
      content: safeStringify({
        fileName: file.fileName,
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
      }),
      imageAlt: file.fileName,
      ...(path === "" ? {} : { filePath: path, fileSource: fileSource(path) }),
    });
  }
  return blocks.length === 0 ? undefined : blocks;
}

/** A turn's composition within the message sequence: one user message plus the assistant messages after it. */
export type TrajectoryTurnWalkEntry = {
  turn: number;
  user?: UiMessage;
  assistants: UiMessage[];
};

/** Stable user-message identities recorded in an authoritative ledger. */
export function trajectoryTurnByMessageId(
  ledger: TrajectoryLedger | undefined,
): ReadonlyMap<string, number> {
  const turns = new Map<string, number>();
  for (const turn of ledger?.turns ?? []) {
    for (const input of turn.inputs) {
      if (input.kind !== "user") continue;
      const messageId = input.messageId?.trim();
      if (messageId) turns.set(messageId, turn.turn);
    }
  }
  return turns;
}

/** Absolute user-message indexes recorded in an authoritative ledger. */
export function trajectoryTurnByMessageIndex(
  ledger: TrajectoryLedger | undefined,
): ReadonlyMap<number, number> {
  const turns = new Map<number, number>();
  for (const turn of ledger?.turns ?? []) {
    for (const input of turn.inputs) {
      if (input.kind !== "user" || input.messageIndex === undefined) continue;
      turns.set(input.messageIndex, turn.turn);
    }
  }
  return turns;
}

/**
 * Split turns by user-message boundaries, and use recorded messageIds to map a local history
 * window onto absolute turns. One anchor suffices to backfill before and increment after; with no
 * anchor it keeps the traditional 1..N degraded numbering.
 */
export function walkTrajectoryTurns(
  messages: readonly UiMessage[],
  authoritativeTurns: ReadonlyMap<string, number> = new Map(),
  authoritativeTurnsByMessageIndex: ReadonlyMap<number, number> = new Map(),
  authoritativeTurnOrder: readonly number[] = [],
): readonly TrajectoryTurnWalkEntry[] {
  const entries: TrajectoryTurnWalkEntry[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      entries.push({ turn: entries.length + 1, user: message, assistants: [] });
      continue;
    }
    let current = entries.at(-1);
    if (current === undefined) {
      current = { turn: 1, assistants: [] };
      entries.push(current);
    }
    current.assistants.push(message);
  }
  if (entries.length === 0) return entries;

  const anchored = entries.map((entry) => {
    const messageId = entry.user?.messageId?.trim();
    const byId = messageId ? authoritativeTurns.get(messageId) : undefined;
    if (byId !== undefined) return byId;
    const messageIndex = entry.user?.messageIndex;
    return messageIndex === undefined
      ? undefined
      : authoritativeTurnsByMessageIndex.get(messageIndex);
  });
  const firstAnchor = anchored.findIndex((turn) => turn !== undefined);
  if (firstAnchor < 0) {
    // A legacy/tail window may lack stable IDs and may expose window-local message indexes.
    // Align it to the authoritative ledger tail instead of renumbering the latest turn as Turn 1.
    if (authoritativeTurnOrder.length === 0) return entries;
    const alignedStart = Math.max(0, authoritativeTurnOrder.length - entries.length);
    const aligned = authoritativeTurnOrder.slice(alignedStart);
    const missingPrefix = entries.length - aligned.length;
    const firstKnown = aligned[0] ?? 1;
    return entries.map((entry, index) => ({
      ...entry,
      turn:
        index < missingPrefix
          ? Math.max(1, firstKnown - (missingPrefix - index))
          : aligned[index - missingPrefix],
    }));
  }

  const assigned = new Array<number>(entries.length);
  assigned[firstAnchor] = anchored[firstAnchor] as number;
  for (let index = firstAnchor - 1; index >= 0; index -= 1) {
    assigned[index] = Math.max(1, assigned[index + 1] - 1);
  }
  for (let index = firstAnchor + 1; index < entries.length; index += 1) {
    assigned[index] = anchored[index] ?? assigned[index - 1] + 1;
  }
  return entries.map((entry, index) => ({ ...entry, turn: assigned[index] }));
}

function assistantContent(round: UiRound): TrajectoryAssistantContent {
  const text = getRoundText(round);
  const thinking = getRoundThinkingText(round);
  const blocks = roundSourceBlocks(round);
  return {
    ...(text === "" ? {} : { text }),
    ...(thinking === "" ? {} : { thinking }),
    ...(blocks.length === 0 ? {} : { blocks }),
  };
}

function toolContent(item: ReturnType<typeof getRoundToolTrace>[number]): TrajectoryToolContent {
  let args: string | undefined;
  try {
    args = JSON.stringify(toolCallArgsForDisplay(item.toolCall), null, 2);
  } catch {
    args = undefined;
  }
  const result =
    item.toolResult === undefined ? undefined : toolResultMessageToText(item.toolResult);
  const outputBlocks = toolOutputBlocks(item);
  return {
    ...(args === undefined ? {} : { args }),
    ...(result === undefined || result === "" ? {} : { result }),
    ...(args === undefined
      ? {}
      : {
          blocks: [
            {
              type: "tool-call",
              content: args,
              callId: item.toolCall.id,
              toolName: item.toolCall.name,
            },
          ],
        }),
    ...(outputBlocks === undefined ? {} : { outputBlocks }),
    ...(item.toolResult?.isError === true ? { isError: true } : {}),
  };
}

function contentEntryForUser(message: UiMessage): TrajectoryContentEntry | undefined {
  const blocks = userSourceBlocks(message);
  if (message.text === "" && blocks === undefined) return undefined;
  return {
    ...(message.text === "" ? {} : { text: message.text }),
    ...(blocks === undefined ? {} : { blocks }),
  };
}

/** Build all stable and compatibility indexes for the currently loaded message window. */
export function buildTrajectoryContentIndex(
  messages: readonly UiMessage[],
  authoritativeLedger?: TrajectoryLedger,
): TrajectoryContentIndex {
  const userByTurn = new Map<number, TrajectoryContentEntry>();
  const userByMessageId = new Map<string, TrajectoryContentEntry>();
  const userByMessageIndex = new Map<number, TrajectoryContentEntry>();
  const turnByMessageId = new Map<string, number>();
  const turnByMessageIndex = new Map<number, number>();
  const assistantByStep = new Map<string, TrajectoryAssistantContent>();
  const assistantEntries: TrajectoryIndexedAssistantContent[] = [];
  const toolByCallId = new Map<string, TrajectoryToolContent>();
  const toolEntries: TrajectoryIndexedToolContent[] = [];
  const walked = walkTrajectoryTurns(
    messages,
    trajectoryTurnByMessageId(authoritativeLedger),
    trajectoryTurnByMessageIndex(authoritativeLedger),
    authoritativeLedger?.turns.map((turn) => turn.turn) ?? [],
  );

  for (const entry of walked) {
    const anchorUserMessageIndex = entry.user?.messageIndex;
    const anchorUserMessageId = entry.user?.messageId?.trim() || undefined;
    if (entry.user !== undefined) {
      const userContent = contentEntryForUser(entry.user);
      if (anchorUserMessageId !== undefined) turnByMessageId.set(anchorUserMessageId, entry.turn);
      if (anchorUserMessageIndex !== undefined) {
        turnByMessageIndex.set(anchorUserMessageIndex, entry.turn);
      }
      if (userContent !== undefined) {
        userByTurn.set(entry.turn, userContent);
        if (anchorUserMessageId !== undefined)
          userByMessageId.set(anchorUserMessageId, userContent);
        if (anchorUserMessageIndex !== undefined) {
          userByMessageIndex.set(anchorUserMessageIndex, userContent);
        }
      }
    }
    for (const assistant of entry.assistants) {
      for (const round of assistant.rounds ?? []) {
        const content = assistantContent(round);
        if (
          content.text !== undefined ||
          content.thinking !== undefined ||
          content.blocks !== undefined
        ) {
          assistantByStep.set(stepKey(entry.turn, round.round), content);
          assistantEntries.push({
            turn: entry.turn,
            step: round.round,
            ...(assistant.messageIndex === undefined
              ? {}
              : { messageIndex: assistant.messageIndex }),
            ...(anchorUserMessageIndex === undefined ? {} : { anchorUserMessageIndex }),
            ...(anchorUserMessageId === undefined ? {} : { anchorUserMessageId }),
            content,
          });
        }
        for (const item of getRoundToolTrace(round)) {
          const content = toolContent(item);
          toolByCallId.set(item.toolCall.id, content);
          toolEntries.push({
            turn: entry.turn,
            step: round.round,
            callId: item.toolCall.id,
            ...(assistant.messageIndex === undefined
              ? {}
              : { messageIndex: assistant.messageIndex }),
            ...(anchorUserMessageIndex === undefined ? {} : { anchorUserMessageIndex }),
            ...(anchorUserMessageId === undefined ? {} : { anchorUserMessageId }),
            content,
          });
        }
      }
    }
  }

  return {
    userByTurn,
    userByMessageId,
    userByMessageIndex,
    turnByMessageId,
    turnByMessageIndex,
    turnOrder: walked.map((entry) => entry.turn),
    assistantByStep,
    assistantEntries,
    toolByCallId,
    toolEntries,
  };
}
