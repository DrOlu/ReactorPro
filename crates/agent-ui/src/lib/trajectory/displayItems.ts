/**
 * Layout → final display sequence.
 *
 * Collapsing and search filtering are settled here; components only render the
 * result. It lives in a pure logic layer so collapse semantics can be tested
 * directly — a rule like "which rows remain after collapsing a turn" cannot be
 * verified if buried inside a component.
 */

import type { TrajectoryRecord, TrajectoryTurnModel } from "./types";

export type TrajectoryDisplayItem =
  | {
      kind: "turnHeader";
      key: string;
      turn: number | null;
      collapsible: boolean;
      collapsed: boolean;
      hiddenCount: number;
    }
  | { kind: "record"; key: string; record: TrajectoryRecord };

export const TRAJECTORY_DISPLAY_HEIGHTS = {
  turnHeader: 30,
  record: 30,
} as const;

export function trajectoryDisplayItemHeight(item: TrajectoryDisplayItem): number {
  return item.kind === "turnHeader"
    ? TRAJECTORY_DISPLAY_HEIGHTS.turnHeader
    : TRAJECTORY_DISPLAY_HEIGHTS.record;
}

/** Collapsing is only worth offering when a turn has content beyond its first row. */
function visibleRecordsOf(turn: TrajectoryTurnModel): TrajectoryRecord[] {
  return turn.groups.flatMap((group) =>
    group.records.filter((record) => record.requestOnly !== true),
  );
}

/**
 * Determines whether a record should be hidden because its upstream assistant
 * is collapsed.
 *
 * Collapsing Calls means "collapse this step's tool calls", so the hidden range
 * is every tool/subtool immediately after the collapsed assistant up to the next
 * assistant.
 */
function collapsedCallIndexes(
  records: readonly TrajectoryRecord[],
  collapsedAssistants: ReadonlySet<string>,
): Set<number> {
  const hidden = new Set<number>();
  let activeCollapsedAssistant: string | null = null;
  for (const record of records) {
    if (record.kind === "message") {
      activeCollapsedAssistant = collapsedAssistants.has(record.recordId) ? record.recordId : null;
      continue;
    }
    if (activeCollapsedAssistant === null) continue;
    if (record.kind === "tool" || record.kind === "subtool") hidden.add(record.index);
  }
  return hidden;
}

/**
 * Computes the final display sequence.
 *
 * @param turns - the layout result.
 * @param options - collapse state and the search-match set.
 * @returns flat display items; an empty array when the search has no matches.
 */
export function buildTrajectoryDisplayItems(
  turns: readonly TrajectoryTurnModel[],
  options: {
    collapsedTurns: ReadonlySet<number>;
    collapsedAssistants: ReadonlySet<string>;
    searchMatchIndexes: ReadonlySet<number> | null;
  },
): readonly TrajectoryDisplayItem[] {
  const items: TrajectoryDisplayItem[] = [];

  for (const [turnOrder, turn] of turns.entries()) {
    const records = visibleRecordsOf(turn);
    if (records.length === 0) continue;

    // Collapsing always yields to search: matching rows must be visible, or the user finds a match but cannot see it.
    const searching = options.searchMatchIndexes !== null;
    const matching = searching
      ? records.filter((record) => options.searchMatchIndexes?.has(record.index) === true)
      : records;
    if (matching.length === 0) continue;

    const hiddenByCalls = searching
      ? new Set<number>()
      : collapsedCallIndexes(records, options.collapsedAssistants);
    const turnCollapsed = !searching && turn.turn !== null && options.collapsedTurns.has(turn.turn);

    const kept = matching.filter((record) => !hiddenByCalls.has(record.index));
    const shown = turnCollapsed ? kept.slice(0, 1) : kept;
    const hiddenCount = records.length - shown.length;

    if (turn.turn !== null) {
      items.push({
        kind: "turnHeader",
        key: `turn-${turn.turn}-${turnOrder}`,
        turn: turn.turn,
        collapsible: kept.length > 1,
        collapsed: turnCollapsed,
        hiddenCount: Math.max(0, hiddenCount),
      });
    }

    for (const record of shown) {
      items.push({ kind: "record", key: record.recordId, record });
    }
  }

  return items;
}

/** The set of collapsible turn numbers, used by the "Collapse all" button to determine its state. */
export function collapsibleTrajectoryTurns(
  turns: readonly TrajectoryTurnModel[],
): readonly number[] {
  return turns.flatMap((turn) =>
    turn.turn !== null && visibleRecordsOf(turn).length > 1 ? [turn.turn] : [],
  );
}

/** Identities of assistant records that have tool calls under them and are therefore collapsible. */
export function collapsibleTrajectoryAssistants(
  turns: readonly TrajectoryTurnModel[],
): readonly string[] {
  const ids: string[] = [];
  for (const turn of turns) {
    const records = visibleRecordsOf(turn);
    for (const [index, record] of records.entries()) {
      if (record.kind !== "message") continue;
      const next = records[index + 1];
      if (next?.kind === "tool" || next?.kind === "subtool") ids.push(record.recordId);
    }
  }
  return ids;
}
