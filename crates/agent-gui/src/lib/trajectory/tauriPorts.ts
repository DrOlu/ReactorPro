/**
 * The recorder's Tauri persist port and Gateway publish port.
 *
 * Persist failures are always swallowed: the trajectory is a diagnostic view, and a missing
 * record is preferable to affecting the conversation.
 */

import type { TrajectoryEvent, TrajectorySection } from "@liveagent/ui/lib/trajectory/types";
import { invoke } from "../../shims/tauriCore";
import type { TrajectoryRecorderPorts } from "./recorder";

export type TrajectoryPublish = (events: readonly TrajectoryEvent[]) => void;

/**
 * Constructs the desktop recorder ports.
 *
 * @param publish - real-time publish callback; may be omitted when no Gateway is connected.
 * @returns The persist and publish ports.
 */
export function createTauriTrajectoryPorts(publish?: TrajectoryPublish): TrajectoryRecorderPorts {
  return {
    persist: (conversationId, segmentIndex, eventsJson) =>
      invoke("trajectory_append_events", { conversationId, segmentIndex, eventsJson }),
    persistSections: (conversationId, sections: readonly TrajectorySection[]) =>
      invoke("trajectory_put_sections", { conversationId, sections }),
    ...(publish === undefined ? {} : { publish }),
  };
}
/** Resolve the next turn from persisted messages and the highest trajectory turn. */
export async function resolvePersistedTrajectoryTurnNumber(
  conversationId: string,
  currentUserPersisted: boolean,
): Promise<number> {
  const value = await invoke<number>("trajectory_resolve_turn_number", {
    conversationId,
    currentUserPersisted,
  });
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}
