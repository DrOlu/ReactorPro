/**
 * Public export surface of the trajectory domain.
 *
 * Hosts and the UI import only from here, not into specific modules, easing later
 * internal restructuring.
 */

export type { TrajectoryTurnWalkEntry } from "./contentIndex";
export { buildTrajectoryContentIndex, walkTrajectoryTurns } from "./contentIndex";
export { buildTrajectoryLedger, parseTrajectoryEvents } from "./eventLog";
export { deriveLedgerFromMessages } from "./fromMessages";
export type { TrajectoryInvoke } from "./host";
export { createInvokeTrajectoryHost } from "./host";
export type {
  TrajectoryAssistantContent,
  TrajectoryContentEntry,
  TrajectoryContentIndex,
  TrajectoryLayoutInput,
  TrajectoryToolContent,
} from "./layout";
export {
  deriveTrajectoryLayout,
  EMPTY_TRAJECTORY_CONTENT_INDEX,
  flattenTrajectoryRecords,
  lastRecordIndex,
  stepKey,
} from "./layout";
export {
  TrajectorySearchIndex,
  trajectorySearchMatchIndexes,
} from "./searchIndex";
export type { TrajectoryHeaderBuild, TrajectorySectionInput } from "./sections";
export {
  buildTrajectoryHeader,
  hashTrajectoryContent,
  serializeToolCatalog,
  trajectorySectionSlotAt,
} from "./sections";
export {
  buildTrajectorySubagentRun,
  concatSubagentSegmentMessages,
  extractSubagentSteps,
  normalizeSubagentStatus,
} from "./subagentRuns";
export type {
  TrajectoryTimelineMode,
  TrajectoryTimelineModel,
  TrajectoryTimelineSpan,
  TrajectoryTimelineTurnBoundary,
  TrajectoryTimeRange,
} from "./timeline";
export {
  deriveTrajectoryTimeline,
  formatTrajectoryDurationMs,
  formatTrajectoryElapsedSeconds,
  TRAJECTORY_TIMELINE_LANES,
  trajectoryLaneFor,
  trajectoryTimelineFocusIndexes,
} from "./timeline";
export type { TrajectoryTranscriptItem } from "./transcriptMessages";
export { toTrajectoryMessages } from "./transcriptMessages";
export * from "./types";
export type {
  TrajectoryVirtualRow,
  TrajectoryVirtualRowEntry,
  VirtualizableTrajectoryRecord,
} from "./virtualRows";
export {
  groupTrajectoryVirtualRows,
  TRAJECTORY_ROW_HEIGHTS,
  trajectoryVirtualRowKey,
} from "./virtualRows";
