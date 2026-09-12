import { useLocale } from "@liveagent/ui/i18n/index";
import { useDocumentHidden } from "@liveagent/ui/lib/shared/documentVisibility";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useState } from "react";
import { canManualCompact, contextUsageRatio } from "../../lib/chat/contextUsage";
import {
  type ConversationStats,
  formatStatCount,
  formatStatDuration,
  formatStatLatency,
  formatStatPercent,
  formatStatThroughput,
  formatStatTokens,
  hasConversationStats,
  resolveStatDurations,
} from "../../lib/trajectory/stats";
import { ConfirmActionPopover } from "../ui/confirm-action-popover";
import { LabelTooltip } from "../ui/label-tooltip";

/** The heartbeat shares the same frequency as the hook's rebuild throttle (docs/design/composer-context-stats-bar.md §4.2). */
const HEARTBEAT_MS = 1_000;

type StatGroup = {
  key: string;
  /** Shrink tier: undefined is always visible; otherwise shown/hidden by container-width tier. */
  minWidth?: "28rem" | "40rem" | "52rem";
  items: readonly string[];
};

/** While running, re-render once per second to fold *RunningSinceAt into the displayed value; zero timers when idle. */
function useRunningHeartbeat(running: boolean): number {
  const hidden = useDocumentHidden();
  const [, setBeat] = useState(0);
  useEffect(() => {
    // No heartbeat while the window is hidden: the user cannot see those frames, yet the cost is a stats-bar
    // re-render every second (rebuilding its formatters and reflowing the visible-row neighborhood in long
    // sessions). When it becomes visible again, the hidden flip restarts the effect and the reading instantly
    // returns to the current value.
    if (!running || hidden) return;
    const timer = setInterval(() => setBeat((beat) => beat + 1), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [hidden, running]);
  return Date.now();
}

/**
 * The all-conversation cumulative stats single row directly below the input card (context usage | session size | time cost | token cost | response performance).
 *
 * Display only: data is aggregated by useConversationStats and injected by the host. The width-based tiered
 * shrinking relies on its own `@container`---it is the same width as the glass card, so the tier thresholds
 * match the card. The context-usage group and the "scale" group are both always-visible tiers: a mobile
 * container width cannot reach the first breakpoint (28rem), previously leaving only turns·steps, and the
 * usage ring hides itself at low usage (hideBelowWarn), so narrow screens could not see any context
 * information at all---therefore the usage percentage is also placed here as always-visible, sharing the same
 * source as the usage ring's instantaneous reading and not mutually exclusive (the original §4.5 semantic
 * split decision that "the status bar does not include context usage" was adjusted per this feedback).
 * Constant-height placeholder (see the empty-state branch below) so the composer's total height does not
 * change as the first stats arrive/disappear.
 */
export function ConversationStatsBar(props: {
  stats: ConversationStats | null;
  /**
   * When provided and the current context usage is ≥50% (canManualCompact) the whole row is clickable;
   * after a confirmation it triggers manual compaction, with the same threshold as ContextUsageRing; when
   * the condition is not met it is display only.
   */
  onManualCompactConfirm?: (() => void) | (() => Promise<unknown>);
  /** Temporarily disables the click entry in scenarios such as compaction in progress, even if usage meets the threshold. */
  manualCompactBlocked?: boolean;
  /** Current conversation context usage tokens (same source as the usage ring); shown only when provided together with contextWindow. */
  contextUsageTokens?: number;
  contextWindow?: number;
}) {
  const { stats, onManualCompactConfirm, manualCompactBlocked, contextUsageTokens, contextWindow } =
    props;
  const { t, locale } = useLocale();
  const running =
    stats !== null && (stats.llmRunningSinceAt !== null || stats.toolRunningSinceAt !== null);
  const now = useRunningHeartbeat(running);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ratio = contextUsageRatio(contextUsageTokens, contextWindow);
  const compactAvailable =
    canManualCompact(ratio) && !manualCompactBlocked && Boolean(onManualCompactConfirm);
  // The confirmation popover renders only on the compactable branch; the compactable state may flip back to
  // false while the popover is open (another client starts compacting, usage falls below the threshold), so
  // resetting during render avoids a leftover true causing the popover to auto-open with no action after state
  // recovery (same handling as ContextUsageRing; see the comments in that file).
  if (!compactAvailable && confirmOpen) {
    setConfirmOpen(false);
  }

  // Placeholder container: keep the same height even when there is nothing to display, instead of returning
  // null. Before the first message is sent, stats are always empty; without a placeholder here, the moment
  // the assistant reply lands and the stats appear the composer/transcript would shift once, which reads as
  // the layout "jumping"; a permanent placeholder buys zero jitter.
  if (!hasConversationStats(stats) || stats === null) {
    return (
      <div
        aria-hidden="true"
        className="@container flex h-5 w-full items-center justify-center overflow-hidden"
      />
    );
  }

  const durations = resolveStatDurations(stats, now);
  const fill = (key: string, token: string, value: string) => t(key).replace(token, value);

  // Token-type metrics count only steps with usage; when there are none, that group is hidden (§7).
  const tokenItems = [
    ...(stats.inputTokens > 0
      ? [fill("chat.stats.inputTokens", "{n}", formatStatTokens(stats.inputTokens, locale))]
      : []),
    ...(stats.outputTokens > 0
      ? [fill("chat.stats.outputTokens", "{n}", formatStatTokens(stats.outputTokens, locale))]
      : []),
  ];
  const perfItems = [
    ...(stats.ttftAvgMs !== null
      ? [fill("chat.stats.ttftAvg", "{t}", formatStatLatency(stats.ttftAvgMs))]
      : []),
    ...(stats.decodeTokPerSec !== null
      ? [fill("chat.stats.throughput", "{n}", formatStatThroughput(stats.decodeTokPerSec))]
      : []),
    ...(stats.cacheHitRatio !== null
      ? [fill("chat.stats.cacheHit", "{p}", formatStatPercent(stats.cacheHitRatio))]
      : []),
  ];
  // Uses the same contextWindow emptiness rule as the usage ring: when there is no model context-window
  // information (old sessions / text mode) the whole group is absent rather than showing a fake 0%.
  const contextUsageItems =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? [fill("chat.stats.contextUsage", "{p}", formatStatPercent(ratio))]
      : [];
  // The annotation goes on the literals: putting it on the .filter() result would widen minWidth to string first.
  const allGroups: StatGroup[] = [
    {
      key: "scale",
      items: [
        fill("chat.stats.turns", "{n}", String(stats.turns)),
        fill("chat.stats.steps", "{n}", String(stats.steps)),
      ],
    },
    // Always-visible tier, at the same level as scale: a mobile container width cannot reach the 28rem
    // breakpoint, so this is the only group besides turns·steps that can still show on narrow screens.
    { key: "context", items: contextUsageItems },
    {
      key: "time",
      minWidth: "28rem",
      items: [
        fill("chat.stats.llmTime", "{t}", formatStatDuration(durations.llmMs)),
        fill("chat.stats.toolTime", "{t}", formatStatDuration(durations.toolMs)),
      ],
    },
    { key: "tokens", minWidth: "40rem", items: tokenItems },
    { key: "perf", minWidth: "52rem", items: perfItems },
  ];
  const groups = allGroups.filter((group) => group.items.length > 0);

  const prefix = stats.approximate ? `${t("chat.stats.approximate")} ` : "";
  const fullText = prefix + groups.map((group) => group.items.join(" · ")).join(" ｜ ");

  // The tooltip gives the groups shrunk away by container queries, plus the compaction count and the ≈ explanation that appear only here.
  const tooltipLines = [
    ...groups.map((group) => ({ key: group.key, text: group.items.join(" · ") })),
    ...(stats.compactions > 0
      ? [
          {
            key: "compactions",
            text: fill("chat.stats.compactions", "{n}", formatStatCount(stats.compactions, locale)),
          },
        ]
      : []),
  ];
  const tooltip = (
    <span className="flex flex-col gap-0.5">
      {tooltipLines.map((line) => (
        <span key={line.key}>{line.text}</span>
      ))}
      {stats.approximate ? (
        <span className="text-muted-foreground">{t("chat.stats.approximateHint")}</span>
      ) : null}
      {compactAvailable ? (
        <span className="text-muted-foreground">{t("chat.manualCompactTitle")}</span>
      ) : null}
    </span>
  );

  // The reading is announced via the outer role="status" aria-label, so it is hidden from assistive technology
  // here to avoid reading the same set of numbers twice.
  const row = (
    <div
      aria-hidden="true"
      className="flex min-w-0 items-center overflow-hidden text-[calc(11px*var(--zone-font-scale,1))] leading-none whitespace-nowrap text-muted-foreground/70 tabular-nums"
    >
      {prefix === "" ? null : <span className="mr-1">{t("chat.stats.approximate")}</span>}
      {groups.map((group, index) => (
        <span
          key={group.key}
          data-stats-group={group.key}
          className={cn(
            "items-center",
            group.minWidth === undefined && "flex",
            group.minWidth === "28rem" && "hidden @min-[28rem]:flex",
            group.minWidth === "40rem" && "hidden @min-[40rem]:flex",
            group.minWidth === "52rem" && "hidden @min-[52rem]:flex",
          )}
        >
          {index > 0 ? <span className="px-1.5 text-muted-foreground/40">｜</span> : null}
          <span>{group.items.join(" · ")}</span>
        </span>
      ))}
    </div>
  );

  return (
    // role="status" provides semantics; number changes are not announced via aria-live (it would spam during streaming).
    <div role="status" aria-live="off" aria-label={fullText} className="relative h-5 w-full">
      {/* Frosted-glass skirt: the reading floats above scrollable body text; when the body scrolls under the
          input area it overlaps the text below until it is hard to read, and the arc-shaped gap outside the
          input card's rounded corner would also leak body text. The skirt is the same width as the card,
          reaches up 2rem (= the card's rounded-4xl radius) to hide behind the card, and covers the arc-shaped
          gap as well; -z-10 puts it below the card and above the body. The empty-state placeholder branch does
          not have this layer. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-8 bottom-0 -z-10 bg-background/70 backdrop-blur-md"
      />
      {/* overflow-hidden fallback: the tooltip trigger is shrink-0, so at extremely narrow widths it is better to clip than to break the layout. */}
      <div className="@container flex h-5 w-full items-center justify-center overflow-hidden">
        <LabelTooltip label={tooltip}>
          {compactAvailable ? (
            <ConfirmActionPopover
              title={t("chat.manualCompactTitle")}
              description={t("chat.manualCompactDescription")}
              confirmLabel={t("chat.manualCompactConfirm")}
              tone="default"
              side="top"
              align="center"
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              onConfirm={() => void onManualCompactConfirm?.()}
            >
              {(open) => (
                <button
                  type="button"
                  onClick={open}
                  aria-label={t("chat.manualCompactTitle")}
                  className="flex min-w-0 cursor-pointer items-center rounded-full px-1.5 outline-hidden transition-[background-color] hover:bg-muted/50 focus-visible:bg-muted/50"
                >
                  {row}
                </button>
              )}
            </ConfirmActionPopover>
          ) : (
            row
          )}
        </LabelTooltip>
      </div>
    </div>
  );
}
