/**
 * Ledger list.
 *
 * Virtualize only above the threshold: short sessions render directly, saving the
 * complexity of measurement and scroll compensation; long sessions (thousands of
 * tool-call rows) must be virtualized, or a single layout pass drops frames.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import {
  buildTrajectoryDisplayItems,
  TRAJECTORY_DISPLAY_HEIGHTS,
  type TrajectoryDisplayItem,
  trajectoryDisplayItemHeight,
} from "../../lib/trajectory/displayItems";
import type { TrajectoryTurnModel } from "../../lib/trajectory/types";
import { ChevronDown, ChevronRight } from "../IconSet";
import { TrajectoryRow } from "./TrajectoryRow";

const VIRTUALIZATION_THRESHOLD = 120;
const OVERSCAN_ROWS = 12;

export function TrajectoryTable(props: {
  turns: readonly TrajectoryTurnModel[];
  collapsedTurns: ReadonlySet<number>;
  collapsedAssistants: ReadonlySet<string>;
  searchMatchIndexes: ReadonlySet<number> | null;
  timelineFocusIndexes: ReadonlySet<number> | null;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onToggleTurn: (turn: number) => void;
}) {
  const { t } = useLocale();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo(
    () =>
      buildTrajectoryDisplayItems(props.turns, {
        collapsedTurns: props.collapsedTurns,
        collapsedAssistants: props.collapsedAssistants,
        searchMatchIndexes: props.searchMatchIndexes,
      }),
    [props.turns, props.collapsedTurns, props.collapsedAssistants, props.searchMatchIndexes],
  );

  const virtualized = items.length >= VIRTUALIZATION_THRESHOLD;
  // The scroll side effect depends only on the selected value; the list and the
  // virtualization switch are read for their latest values through refs, keeping
  // them from becoming trigger conditions.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const virtualizedRef = useRef(virtualized);
  virtualizedRef.current = virtualized;
  const getDisplayItemKey = useCallback((index: number) => items[index]?.key ?? index, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = items[index];
      return item === undefined
        ? TRAJECTORY_DISPLAY_HEIGHTS.record
        : trajectoryDisplayItemHeight(item);
    },
    getItemKey: getDisplayItemKey,
    overscan: OVERSCAN_ROWS,
    enabled: virtualized,
  });

  const measuredProjectionRef = useRef<{
    collapsedTurns: ReadonlySet<number>;
    collapsedAssistants: ReadonlySet<string>;
    searchMatchIndexes: ReadonlySet<number> | null;
  } | null>(null);
  useLayoutEffect(() => {
    if (!virtualized) {
      measuredProjectionRef.current = null;
      return;
    }
    const measured = measuredProjectionRef.current;
    if (
      measured?.collapsedTurns === props.collapsedTurns &&
      measured.collapsedAssistants === props.collapsedAssistants &&
      measured.searchMatchIndexes === props.searchMatchIndexes
    ) {
      return;
    }
    measuredProjectionRef.current = {
      collapsedTurns: props.collapsedTurns,
      collapsedAssistants: props.collapsedAssistants,
      searchMatchIndexes: props.searchMatchIndexes,
    };
    virtualizer.measure();
  }, [
    props.collapsedTurns,
    props.collapsedAssistants,
    props.searchMatchIndexes,
    virtualized,
    virtualizer,
  ]);

  // External selection (timeline click, cross-view jump) should bring the
  // corresponding row into the viewport -- but only when **the selection changes**.
  // If it also fired on items changes, every event arriving during a live turn
  // would drag the viewport back to the selected row, leaving the user unable to
  // look elsewhere.
  const selectedIndex = props.selectedIndex;
  const scrolledToRef = useRef<number | null>(null);
  useEffect(() => {
    if (selectedIndex === null) {
      scrolledToRef.current = null;
      return;
    }
    if (scrolledToRef.current === selectedIndex) return;
    const position = itemsRef.current.findIndex(
      (item) => item.kind === "record" && item.record.index === selectedIndex,
    );
    if (position < 0) return;
    scrolledToRef.current = selectedIndex;
    if (virtualizedRef.current) {
      virtualizer.scrollToIndex(position, { align: "auto" });
      return;
    }
    scrollRef.current
      ?.querySelector(`[data-trajectory-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, virtualizer]);

  if (items.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6 text-[13px] text-muted-foreground">
        {props.searchMatchIndexes === null
          ? t("trajectory.empty.title")
          : t("trajectory.empty.noMatch")}
      </div>
    );
  }

  const renderItem = (item: TrajectoryDisplayItem) => {
    if (item.kind === "turnHeader") {
      return (
        <TurnHeader
          turn={item.turn}
          collapsible={item.collapsible}
          collapsed={item.collapsed}
          hiddenCount={item.hiddenCount}
          onToggle={() => {
            if (item.turn !== null && item.collapsible) props.onToggleTurn(item.turn);
          }}
        />
      );
    }
    return (
      <TrajectoryRow
        record={item.record}
        selected={props.selectedIndex === item.record.index}
        focused={props.timelineFocusIndexes?.has(item.record.index) === true}
        dimmed={
          props.timelineFocusIndexes !== null && !props.timelineFocusIndexes.has(item.record.index)
        }
        onSelect={props.onSelect}
      />
    );
  };

  return (
    <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      {virtualized ? (
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (item === undefined) return null;
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderItem(item)}
              </div>
            );
          })}
        </div>
      ) : (
        items.map((item) => <div key={item.key}>{renderItem(item)}</div>)
      )}
    </div>
  );
}

function TurnHeader(props: {
  turn: number | null;
  collapsible: boolean;
  collapsed: boolean;
  hiddenCount: number;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  const label =
    props.turn === null
      ? t("trajectory.betweenTurns")
      : t("trajectory.turn").replace("{turn}", String(props.turn));

  return (
    <button
      type="button"
      disabled={!props.collapsible}
      onClick={props.onToggle}
      aria-expanded={props.collapsible ? !props.collapsed : undefined}
      className={cn(
        "flex h-[30px] w-full items-center gap-1 bg-muted/30 px-3 text-[11px] text-muted-foreground",
        props.collapsible && "hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {props.collapsible ? (
        props.collapsed ? (
          <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        )
      ) : (
        <span className="size-3 shrink-0" />
      )}
      <span className="font-medium">{label}</span>
      {props.collapsed && props.hiddenCount > 0 && (
        <span className="ml-1 tabular-nums opacity-70">+{props.hiddenCount}</span>
      )}
    </button>
  );
}
