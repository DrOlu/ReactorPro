/**
 * Transcript row -> shared `UiMessage`.
 *
 * Both the desktop's `RenderTimelineItem` and the WebUI transcript row contain
 * user/assistant structure; here only the minimal fields needed for trajectory merging
 * are read, avoiding a shared layer that depends on either host's full types.
 */

import type { UiMessage, UiRound } from "../chat/uiMessages";

/** The common readable shape of a transcript row on both sides; all other fields are ignored. */
export type TrajectoryTranscriptItem = {
  kind: string;
  key?: unknown;
  text?: unknown;
  rounds?: unknown;
  attachments?: unknown;
  messageIndex?: unknown;
  message_index?: unknown;
  messageId?: unknown;
  message_id?: unknown;
  messageRef?: unknown;
  message_ref?: unknown;
};

function keyOf(item: TrajectoryTranscriptItem, fallback: number): string {
  return typeof item.key === "string" && item.key !== "" ? item.key : `row-${fallback}`;
}

function finiteMessageIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function messageReferenceOf(item: TrajectoryTranscriptItem): Record<string, unknown> | undefined {
  const reference = item.messageRef ?? item.message_ref;
  return reference !== null && typeof reference === "object"
    ? (reference as Record<string, unknown>)
    : undefined;
}

/** Read an available history position without depending on either host's concrete row type. */
function messageIndexOf(item: TrajectoryTranscriptItem): number | undefined {
  const direct = finiteMessageIndex(item.messageIndex ?? item.message_index);
  if (direct !== undefined) return direct;
  const reference = messageReferenceOf(item);
  return finiteMessageIndex(reference?.messageIndex ?? reference?.message_index);
}

/** Stable persisted identity is the primary key for joining a tail window to absolute turns. */
function messageIdOf(item: TrajectoryTranscriptItem): string | undefined {
  const direct = nonEmptyString(item.messageId ?? item.message_id);
  if (direct !== undefined) return direct;
  const reference = messageReferenceOf(item);
  return nonEmptyString(reference?.messageId ?? reference?.message_id);
}

/**
 * Convert currently loaded transcript rows. Summary/checkpoint rows are intentionally skipped:
 * compaction is represented by its own trajectory event with a real lifecycle and timing.
 */
export function toTrajectoryMessages(items: readonly TrajectoryTranscriptItem[]): UiMessage[] {
  const messages: UiMessage[] = [];
  for (const [index, item] of items.entries()) {
    const messageIndex = messageIndexOf(item);
    const messageId = messageIdOf(item);
    if (item.kind === "user") {
      messages.push({
        key: keyOf(item, index),
        role: "user",
        text: typeof item.text === "string" ? item.text : "",
        ...(messageIndex === undefined ? {} : { messageIndex }),
        ...(messageId === undefined ? {} : { messageId }),
        ...(Array.isArray(item.attachments) && item.attachments.length > 0
          ? { attachments: item.attachments as UiMessage["attachments"] }
          : {}),
      });
      continue;
    }
    if (item.kind === "assistant" && Array.isArray(item.rounds)) {
      messages.push({
        key: keyOf(item, index),
        role: "assistant",
        text: "",
        rounds: item.rounds as UiRound[],
        ...(messageIndex === undefined ? {} : { messageIndex }),
        ...(messageId === undefined ? {} : { messageId }),
      });
    }
  }
  return messages;
}

function liveRoundsFromSnapshot(snapshot: unknown): readonly UiRound[] {
  if (Array.isArray(snapshot)) return snapshot as UiRound[];
  if (snapshot === null || typeof snapshot !== "object") return [];
  const record = snapshot as { rounds?: unknown; liveRounds?: unknown };
  if (Array.isArray(record.rounds)) return record.rounds as UiRound[];
  return Array.isArray(record.liveRounds) ? (record.liveRounds as UiRound[]) : [];
}

/** Build the synthetic assistant message that supplies current streaming content to the view. */
export function toTrajectoryLiveAssistantMessage(
  snapshot: unknown,
  key = "trajectory-live-assistant",
): UiMessage | undefined {
  const rounds = liveRoundsFromSnapshot(snapshot);
  return rounds.length === 0
    ? undefined
    : {
        key,
        role: "assistant",
        text: "",
        rounds: [...rounds],
      };
}
