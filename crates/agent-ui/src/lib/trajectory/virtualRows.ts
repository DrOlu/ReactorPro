/**
 * Records -> measurable virtual rows.
 *
 * Separator-type records (`requestOnly`) are zero-height themselves. Letting the virtualizer hold
 * zero-height entries would make scroll positioning inaccurate, so they are merged into the next
 * content row; a separator at the end of the sequence becomes its own row and keeps the CSS-defined
 * bottom margin.
 */

import type { TrajectoryRecord } from "./types";

const CONTENT_ROW_HEIGHT = 30;
const COLLAPSED_SUMMARY_HEIGHT = 20;
const TERMINAL_BOUNDARY_HEIGHT = 9;

/** Minimal record shape required for virtual row projection. */
export type VirtualizableTrajectoryRecord = {
  record: TrajectoryRecord;
  /** Category of a collapsed summary row; undefined for a normal content row. */
  collapsedSummaryKind?: "turn" | "assistant";
};

export type TrajectoryVirtualRowEntry<T extends VirtualizableTrajectoryRecord> = {
  logicalIndex: number;
  item: T;
};

export type TrajectoryVirtualRow<T extends VirtualizableTrajectoryRecord> = {
  entries: readonly TrajectoryVirtualRowEntry<T>[];
  height: number;
  key: string;
};

/**
 * Row identity shared by the React key, the virtualizer, and the scroll anchor.
 *
 * @param item - The display item to derive an identity for.
 * @returns A stable DOM-safe identity.
 */
export function trajectoryVirtualRowKey(item: VirtualizableTrajectoryRecord): string {
  const identity = encodeURIComponent(item.record.recordId);
  return item.collapsedSummaryKind === undefined
    ? identity
    : `${identity}--summary--${item.collapsedSummaryKind}`;
}

/**
 * Fold the display item sequence into measurable virtual rows.
 *
 * @param items - The final display sequence after search and collapse filtering.
 * @returns Virtual rows; each row retains the original logical indices of its members.
 */
export function groupTrajectoryVirtualRows<T extends VirtualizableTrajectoryRecord>(
  items: readonly T[],
): readonly TrajectoryVirtualRow<T>[] {
  const rows: TrajectoryVirtualRow<T>[] = [];
  let pending: TrajectoryVirtualRowEntry<T>[] = [];

  for (const [logicalIndex, item] of items.entries()) {
    const entry = { logicalIndex, item };
    if (item.record.requestOnly === true) {
      pending.push(entry);
      continue;
    }
    const entries = [...pending, entry];
    pending = [];
    rows.push({
      entries,
      height:
        item.collapsedSummaryKind === undefined ? CONTENT_ROW_HEIGHT : COLLAPSED_SUMMARY_HEIGHT,
      key: trajectoryVirtualRowKey(item),
    });
  }

  if (pending.length > 0) {
    rows.push({
      entries: pending,
      height: TERMINAL_BOUNDARY_HEIGHT,
      key: pending.map((entry) => trajectoryVirtualRowKey(entry.item)).join("|"),
    });
  }

  return rows;
}

export const TRAJECTORY_ROW_HEIGHTS = {
  content: CONTENT_ROW_HEIGHT,
  collapsedSummary: COLLAPSED_SUMMARY_HEIGHT,
  terminalBoundary: TERMINAL_BOUNDARY_HEIGHT,
} as const;
