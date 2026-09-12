/**
 * Registry of per-conversation recorders and prompt segment holders.
 *
 * The recorder must survive across turns: header dedup relies on the "previous refs"
 * state, and creating a new one each turn would produce a fresh snapshot every turn,
 * instantly breaking segment dedup.
 *
 * Using a module-level registry instead of React state, isomorphic to the
 * `memoryExtraction` controller — runtime state should not be rebuilt on component re-render.
 */

import {
  createPreparedSystemPromptSlotHolder,
  type PreparedSystemPromptSlots,
} from "../../pages/chat/runtime/conversationContextBuilders";
import { appendDesktopLiveTrajectory, clearDesktopLiveTrajectory } from "./liveTrajectory";
import { createTrajectoryRecorder, type TrajectoryRecorder } from "./recorder";
import {
  createTauriTrajectoryPorts,
  resolvePersistedTrajectoryTurnNumber,
  type TrajectoryPublish,
} from "./tauriPorts";

type Entry = {
  recorder: TrajectoryRecorder;
  slots: ReturnType<typeof createPreparedSystemPromptSlotHolder>;
  /** Currently active segment; updated each turn, read by the recorder via closure. */
  segmentIndex: number;
  /** Real-time publish channel for the current turn; likewise updated each turn. */
  publish: TrajectoryPublish | undefined;
};

const entries = new Map<string, Entry>();

/**
 * Get (creating if necessary) a conversation's recorder and segment holder.
 *
 * segmentIndex and publish are mutable fields rather than constructor-time closures:
 * the recorder survives across turns, and a constructor-time closure would pin the
 * first turn's state and bridge, so later turns' events would be written to the wrong
 * segment or sent to an already-closed channel.
 *
 * @param conversationId - Conversation id.
 * @param segmentIndex - Index of this turn's active segment.
 * @param publish - This turn's real-time publish callback; may be omitted when not connected to a Gateway.
 * @returns The conversation's recorder and segment reader.
 */
export function acquireTrajectoryRecorder(
  conversationId: string,
  segmentIndex: number,
  publish?: TrajectoryPublish,
): { recorder: TrajectoryRecorder; readSlots: () => PreparedSystemPromptSlots } {
  const existing = entries.get(conversationId);
  if (existing !== undefined) {
    existing.segmentIndex = segmentIndex;
    existing.publish = publish;
    return { recorder: existing.recorder, readSlots: existing.slots.read };
  }
  const slots = createPreparedSystemPromptSlotHolder();
  const entry: Entry = {
    slots,
    segmentIndex,
    publish,
    recorder: createTrajectoryRecorder({
      conversationId,
      getSegmentIndex: () => entries.get(conversationId)?.segmentIndex ?? segmentIndex,
      ports: createTauriTrajectoryPorts((events) => {
        appendDesktopLiveTrajectory(conversationId, events);
        entries.get(conversationId)?.publish?.(events);
      }),
    }),
  };
  entries.set(conversationId, entry);
  return { recorder: entry.recorder, readSlots: slots.read };
}

/** Used by context builders to write segment source text. */
export function trajectorySlotCapture(
  conversationId: string,
): ((slots: PreparedSystemPromptSlots) => void) | undefined {
  return entries.get(conversationId)?.slots.capture;
}

/** Move subsequent events to the segment produced by a completed compaction. */
export function updateTrajectoryRecorderSegment(
  conversationId: string,
  segmentIndex: number,
): void {
  const entry = entries.get(conversationId);
  if (entry === undefined || !Number.isFinite(segmentIndex)) return;
  entry.segmentIndex = Math.max(0, Math.trunc(segmentIndex));
}

/** Released before conversation close or edit-resend; the recorder performs the final flush itself. */
export async function releaseTrajectoryRecorder(conversationId: string): Promise<void> {
  const key = conversationId.trim();
  const entry = entries.get(key);
  if (entry === undefined) return;
  entries.delete(key);
  await entry.recorder.dispose();
  // dispose has already flushed the buffer; this process no longer holds the
  // conversation's live tail. After clearing the live cache, the view layer converges
  // leftover entries still marked running in persistence to aborted instead of hanging
  // as running forever.
  clearDesktopLiveTrajectory(key);
}

/** Discard directly when the conversation is deleted or the cache is evicted, avoiding a final write to a deleted segment. */
export function discardTrajectoryRecorder(conversationId: string): void {
  const key = conversationId.trim();
  const entry = entries.get(key);
  if (entry !== undefined) {
    entries.delete(key);
    entry.recorder.discard();
  }
  clearDesktopLiveTrajectory(key);
}

/**
 * Resolve the absolute turn number from all persisted segments.
 *
 * A history window may contain only the tail, so counting visible transcript rows can reuse
 * an old turn number and merge unrelated events. The backend also advances past the highest
 * persisted trajectory turn, so a high fallback turn remains monotonic after IPC recovers.
 */
export async function resolveTrajectoryTurnNumber(params: {
  conversationId: string;
  currentUserPersisted: boolean;
  fallbackTurn: number;
}): Promise<number> {
  try {
    return await resolvePersistedTrajectoryTurnNumber(
      params.conversationId,
      params.currentUserPersisted,
    );
  } catch (error) {
    console.warn("[trajectory] failed to resolve persisted turn; using safe fallback", error);
    return Math.max(1, Math.trunc(params.fallbackTurn) || 1);
  }
}
