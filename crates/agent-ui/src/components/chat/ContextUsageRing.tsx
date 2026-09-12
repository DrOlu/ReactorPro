import { useLocale } from "@liveagent/ui/i18n/index";
import { formatTokenCount } from "@liveagent/ui/lib/chat/formatTokenCount";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState, useSyncExternalStore } from "react";
import {
  CONTEXT_USAGE_WARN_RATIO,
  canManualCompact,
  contextUsageLevel,
  contextUsageRatio,
} from "../../lib/chat/contextUsage";
import { ConfirmActionPopover } from "../ui/confirm-action-popover";
import { LabelTooltip } from "../ui/label-tooltip";
import { Meter } from "../ui/meter";

const RING_STROKE_BY_LEVEL = {
  ok: "stroke-emerald-500 dark:stroke-emerald-400",
  warn: "stroke-amber-500 dark:stroke-amber-400",
  danger: "stroke-red-500 dark:stroke-red-400",
} as const;

const COARSE_POINTER_QUERY = "(hover: none), (pointer: coarse)";

// Touch form factor can hot-swap (plugging a keyboard/mouse into an iPad, flipping a convertible), so subscribe to
// matchMedia change rather than evaluating once at mount; the interaction mode (two-stage tap vs hover) switches in
// real time with the device form factor.
function subscribeCoarsePointer(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(COARSE_POINTER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isCoarsePointerNow(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(COARSE_POINTER_QUERY).matches
  );
}

/**
 * Context usage ring: shows the current session's context usage percentage inside the composer; from 50% (yellow
 * tier) upward it becomes clickable and triggers manual compaction after a confirmation. Thresholds and the WebUI
 * recomputation semantics are in lib/chat/contextUsage.ts. The semantics use Meter (static measurement) rather than
 * Progress (task progress).
 *
 * Touch (no hover) environments have no hover, so the tooltip and compaction confirmation switch to staged taps:
 * the first tap only shows the usage tooltip, and at >=50% a second tap dismisses the tooltip and shows the
 * compaction confirmation -- the two popups are anchored on the same side and must be mutually exclusive. The
 * desktop side keeps the original behavior of hover for tooltip and click for confirmation.
 */
export function ContextUsageRing(props: {
  totalTokens?: number;
  contextWindow?: number;
  disabled?: boolean;
  onConfirm?: (() => void) | (() => Promise<unknown>);
  className?: string;
  /**
   * When usage is below the warning line (50%, i.e. manual compaction is not yet available) the whole ring is not
   * rendered. After the display style changed to three tiers the composer still does not pass this -- rings in
   * "ring" / "both" mode must always show from 0% (docs/design/composer-context-stats-bar.md §4.7). It is kept as a
   * general display option for the shared ring, for future mount points where low usage should yield the space.
   */
  hideBelowWarn?: boolean;
}) {
  const { totalTokens, contextWindow, disabled, onConfirm, className, hideBelowWarn } = props;
  const { t, locale } = useLocale();
  const isCoarsePointer = useSyncExternalStore(
    subscribeCoarsePointer,
    isCoarsePointerNow,
    () => false,
  );
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ratio = contextUsageRatio(totalTokens, contextWindow);
  const compactAvailable = canManualCompact(ratio) && !disabled && Boolean(onConfirm);
  // The confirmation popover renders only in the compactable branch, but the compactable state can flip back to
  // false while the popover is open (another side starting compaction/sending a message sets disabled, or that side
  // completing compaction drops usage back below the threshold). At that point the popover unmounts outright as the
  // branch switches; if confirmOpen is left true, once compactable returns the popover would pop open with no
  // action, and while it lingers the tooltip mutual-exclusion guard would keep swallowing tooltip open requests.
  // Re-syncing during render (adjust-state-during-render) completes before paint, so there is no flash.
  if (!compactAvailable && confirmOpen) {
    setConfirmOpen(false);
  }
  // Low-usage hiding: the whole ring is not rendered, but the component still has tooltipOpen mounted. A lingering
  // true would make the tooltip pop open without hover once usage rises back above the warning line -- the same
  // class of problem as confirmOpen above, likewise re-synced during render.
  const hiddenByLowUsage = hideBelowWarn === true && ratio < CONTEXT_USAGE_WARN_RATIO;
  if (hiddenByLowUsage && tooltipOpen) {
    setTooltipOpen(false);
  }
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  if (hiddenByLowUsage) return null;

  // Keep only two measures: the displayed value (rounded, capped at 999) and the ring/measurement value (clamped to
  // 0-100; sharing the latter avoids drift between the a11y measurement and the arc). contextUsageRatio never returns a negative number.
  const displayedPercentage = Math.min(999, Math.round(ratio * 100));
  const clampedPercentage = Math.min(100, ratio * 100);
  const usageLine = `${displayedPercentage}% · ${t("chat.usageTotal")} ${formatTokenCount(
    totalTokens ?? 0,
    locale,
  )}`;
  const windowLine = `${t("chat.contextWindow")} ${formatTokenCount(contextWindow, locale)}`;
  // The a11y measurement/accessible label is still a single-line string; the tooltip visually splits into two lines
  // (percentage + total / context window), so narrow screens no longer cram it into one long wrapping strip.
  const usageLabel = `${usageLine} · ${windowLine}`;
  const usageTooltip = (
    <span className="flex flex-col gap-0.5">
      <span>{usageLine}</span>
      <span className="text-muted-foreground">{windowLine}</span>
    </span>
  );

  const handleTooltipOpenChange = (nextOpen: boolean) => {
    // While the confirmation popover is shown, suppress tooltip open requests (hover/tap) to guarantee no overlap.
    if (nextOpen && confirmOpen) return;
    setTooltipOpen(nextOpen);
  };

  const handleConfirmOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setConfirmOpen(false);
      return;
    }
    // On touch, the first tap only shows the usage tooltip; a second tap while the tooltip is already visible enters confirmation.
    if (isCoarsePointer && !tooltipOpen) {
      setTooltipOpen(true);
      return;
    }
    setTooltipOpen(false);
    setConfirmOpen(true);
  };

  const ring = (
    <Meter
      value={clampedPercentage}
      aria-valuetext={usageLabel}
      className="relative flex h-8 w-8 items-center justify-center text-[8px] font-semibold leading-none tabular-nums text-foreground/75"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="absolute inset-0 h-8 w-8 -rotate-90">
        <circle
          cx="12"
          cy="12"
          r="9.5"
          fill="none"
          strokeWidth="2.25"
          className="stroke-foreground/10 dark:stroke-white/10"
        />
        <circle
          cx="12"
          cy="12"
          r="9.5"
          fill="none"
          pathLength="100"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeDasharray="100"
          strokeDashoffset={100 - clampedPercentage}
          className={cn(
            "transition-[stroke-dashoffset,stroke] duration-300",
            RING_STROKE_BY_LEVEL[contextUsageLevel(ratio)],
          )}
        />
      </svg>
      <span className="relative">{displayedPercentage}%</span>
    </Meter>
  );

  // On touch, always disable closeOnClick: the trigger's press-to-close happens on pointerdown, before the
  // click-stage open/close decision -- keeping it would make the second tap close the tooltip first, so the decision
  // misreads it as a "first tap" and never enters the confirmation popover (the span branch likewise would close and
  // reopen on the same tap).
  if (!compactAvailable) {
    return (
      <LabelTooltip
        label={usageTooltip}
        open={tooltipOpen}
        onOpenChange={handleTooltipOpenChange}
        closeOnClick={!isCoarsePointer}
      >
        {isCoarsePointer ? (
          <button
            type="button"
            aria-label={usageLabel}
            onClick={() => handleTooltipOpenChange(!tooltipOpen)}
            className={cn("inline-flex h-8 w-8 shrink-0 opacity-90 outline-hidden", className)}
          >
            {ring}
          </button>
        ) : (
          <span className={cn("inline-flex h-8 w-8 shrink-0 cursor-default opacity-90", className)}>
            {ring}
          </span>
        )}
      </LabelTooltip>
    );
  }

  return (
    <LabelTooltip
      label={usageTooltip}
      open={tooltipOpen}
      onOpenChange={handleTooltipOpenChange}
      closeOnClick={!isCoarsePointer}
    >
      <ConfirmActionPopover
        title={t("chat.manualCompactTitle")}
        description={t("chat.manualCompactDescription")}
        confirmLabel={t("chat.manualCompactConfirm")}
        tone="default"
        side="top"
        open={confirmOpen}
        onOpenChange={handleConfirmOpenChange}
        onConfirm={() => void onConfirm?.()}
      >
        {(open) => (
          <button
            type="button"
            onClick={open}
            aria-label={t("chat.manualCompactTitle")}
            className={cn(
              // The hover background is painted on an inset-0.5 pseudo-element (28px), the same size as the ring's
              // outer diameter and the visible circles of the other composer right-column buttons; shrinking with
              // padding instead is not an option -- the inner 32px ring would be pushed off-center.
              "relative inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full outline-hidden before:absolute before:inset-0.5 before:rounded-full before:transition-colors hover:before:bg-muted/60 focus-visible:before:bg-muted/60",
              className,
            )}
          >
            {ring}
          </button>
        )}
      </ConfirmActionPopover>
    </LabelTooltip>
  );
}
