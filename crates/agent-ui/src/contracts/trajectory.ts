/**
 * The capabilities the trajectory view requires from its host.
 *
 * The shared UI recognizes only this contract: the GUI implements it with Tauri invoke, and the
 * WebUI with Gateway requests. Deliberately kept narrow -- the trajectory is a read-only diagnostic
 * view and needs no write capability.
 */

import type { ChatFileLink } from "../lib/chat/chatFileLinks";
import type { TrajectorySection, TrajectorySubagentRun } from "../lib/trajectory/types";

export type TrajectoryEventsPayload = {
  /** Flat JSON array text of the events. */
  eventsJson: string;
  /** Whether some segments are missing due to corruption or hitting the cap; the UI uses this to flag the trajectory as incomplete. */
  truncated: boolean;
};

export type TrajectoryEventsWindowPayload = TrajectoryEventsPayload & {
  /** The earliest segment in this window; used as the cursor for paging further back. */
  oldestSegmentIndex: number;
  returnedSegmentCount: number;
  totalSegmentCount: number;
  hasMoreBefore: boolean;
};

export type TrajectoryHost = {
  /**
   * Read one page of persisted events by segment from the tail; passing a cursor continues paging backward.
   *
   * After a reconnect, the WebUI reconciles with the desktop side using the latest window, while
   * live events are still merged idempotently by the ledger layer.
   */
  loadWindow: (
    conversationId: string,
    beforeSegmentIndex?: number,
  ) => Promise<TrajectoryEventsWindowPayload>;
  /**
   * Fetch the full text of prompt segments on demand.
   *
   * A segment can be tens of KB, so it does not enter the live event stream; it is only pulled
   * when the user expands a SYSTEM row's details.
   */
  loadSections: (
    conversationId: string,
    sectionIds: readonly string[],
  ) => Promise<readonly TrajectorySection[]>;
  /** Batch-fetch subagent runs by the runId referenced in events; omitted when unsupported. */
  loadSubagentRuns?: (
    conversationId: string,
    runIds: readonly string[],
  ) => Promise<readonly TrajectorySubagentRun[]>;
  /** Notify the view to reconcile when the host's authoritative read path recovers or fails. */
  subscribeRefresh?: (listener: () => void) => () => void;
  /** Open a workspace file in the host; omitted when unsupported. */
  openFileLink?: (link: ChatFileLink) => void;
};
