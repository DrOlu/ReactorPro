import { ChevronDown } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { isDocumentHidden } from "@liveagent/ui/lib/shared/documentVisibility";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { LazyCollapse } from "./LazyCollapse";
import { useAttentionDisclosure } from "./useAttentionDisclosure";

const PIXEL_KEYS = [
  "top-start",
  "top",
  "top-end",
  "start",
  "center",
  "end",
  "bottom-start",
  "bottom",
  "bottom-end",
] as const;

const PIXEL_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

type LoadingPixelStyle = CSSProperties & {
  "--chat-work-delay": `${number}ms`;
};

function WorkPixelGrid({ active }: { active: boolean }) {
  return (
    // 3x4px + 2x1.5px = 15px, wider than the 12px icon column of the activity rows below:
    // centering it so it overflows into a box the width of the icon column is what makes the
    // header's pixel grid share the same vertical axis as the thinking/tool icons.
    <span
      aria-hidden="true"
      className="flex w-3 shrink-0 items-center justify-center"
      data-chat-work-grid=""
    >
      <span className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {PIXEL_DELAYS.map((delay, index) => (
          <span
            key={PIXEL_KEYS[index]}
            className="chat-work-pixel size-1 bg-foreground"
            data-paused={active ? undefined : ""}
            style={{ "--chat-work-delay": `${delay}ms` } as LoadingPixelStyle}
          />
        ))}
      </span>
    </span>
  );
}

export function formatElapsedTime(elapsedMs: number) {
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  if (totalSeconds < 1) return "";
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours > 0 ? `${hours}h` : "", minutes > 0 ? `${minutes}m` : "", `${seconds}s`]
    .filter(Boolean)
    .join("");
}

export function AssistantWorkTrace({
  children,
  collapsedTail,
  className,
  durationMs,
  hasDetails,
  attentionRequired = false,
  awaitingDecision = false,
  running,
  collapseAfterAnswer = false,
}: {
  children: ReactNode;
  /**
   * The currently ongoing activity block (a running tool group / thinking / streaming
   * progress text). It renders below the collapse header only when "the turn is running and the
   * user manually collapsed this block", so that collapsing does not leave nothing visible
   * outside; when expanded the content is already visible, so it is not repeated.
   */
  collapsedTail?: ReactNode;
  className?: string;
  durationMs?: number;
  hasDetails: boolean;
  attentionRequired?: boolean;
  /**
   * The turn is stopped on a user decision (a question / plan approval / tool approval): the
   * progress is still there, but nothing is running. In this case the pixel grid and title freeze
   * static, to avoid blinking misreporting "waiting for you" as "busy".
   */
  awaitingDecision?: boolean;
  running: boolean;
  /** When the reply has summary text (answer): auto-collapse once after the turn ends (the stream stops). */
  collapseAfterAnswer?: boolean;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useAttentionDisclosure(attentionRequired, running);

  // When there is summary text, auto-collapse the "processing" block once after the turn
  // completes (running becomes false); after that, disclosure ownership returns to the user, so
  // manual expand/collapse is no longer forcibly reversed and does not fight with the forced
  // expansion of attentionRequired (cards awaiting user interaction).
  useEffect(() => {
    if (!running && !attentionRequired && collapseAfterAnswer) setExpanded(false);
  }, [running, attentionRequired, collapseAfterAnswer, setExpanded]);
  const [elapsedMs, setElapsedMs] = useState(durationMs ?? 0);
  const startedAtRef = useRef<number | null>(running ? Date.now() : null);

  useEffect(() => {
    if (!running) {
      if (durationMs !== undefined) {
        setElapsedMs(Math.max(0, durationMs));
      } else if (startedAtRef.current !== null) {
        setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
      }
      return;
    }

    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const updateElapsed = () => {
      const startedAt = startedAtRef.current;
      if (startedAt !== null) setElapsedMs(Math.max(0, Date.now() - startedAt));
    };
    updateElapsed();
    // Stop the clock while hidden: the work trace stopwatch only serves the feel of "watching it
    // run", and re-rendering every second in a hidden window just burns CPU for nothing; when it
    // becomes visible again the effect re-runs and the reading catches up immediately.
    const timer = window.setInterval(() => {
      if (isDocumentHidden()) return;
      updateElapsed();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [durationMs, running]);

  const elapsedLabel = formatElapsedTime(elapsedMs);
  const label = `${running ? t("chat.work.running") : t("chat.work.activity")}${
    elapsedLabel ? ` ${elapsedLabel}` : ""
  }`;
  const header = (
    <>
      {running ? <WorkPixelGrid active={!awaitingDecision} /> : null}
      <span className={cn(running && !awaitingDecision ? "shimmer" : "text-foreground/65")}>
        {label}
      </span>
      {hasDetails ? (
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 text-foreground/40 opacity-0 transition-[opacity,transform] duration-150 group-hover/work-trace:opacity-100 group-focus-visible/work-trace:opacity-100 motion-reduce:transition-none",
            !expanded && "-rotate-90",
          )}
        />
      ) : null}
      <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-foreground/10" />
    </>
  );

  return (
    <section
      className={cn("my-0 text-foreground/60", className)}
      aria-label={t("chat.work.activity")}
      aria-busy={running && !awaitingDecision}
      data-chat-work-trace=""
    >
      {hasDetails ? (
        <button
          type="button"
          className="group/work-trace flex w-full items-center gap-2 rounded-lg py-1 text-[calc(13px*var(--zone-font-scale,1))] font-[450] transition-colors hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2 py-1 text-[calc(13px*var(--zone-font-scale,1))] font-[450]">
          {header}
        </div>
      )}

      {hasDetails ? (
        <LazyCollapse className="[contain:layout_paint]" open={expanded}>
          {() => (
            // Row spacing is handled uniformly by this container: the row components no longer
            // carry their own pb/my, otherwise different row types would produce different gaps.
            <div className="mt-1 space-y-2 [scrollbar-gutter:stable]">{children}</div>
          )}
        </LazyCollapse>
      ) : null}
      {running && hasDetails && !expanded && collapsedTail ? (
        <div className="mt-1" data-chat-work-collapsed-tail="">
          {collapsedTail}
        </div>
      ) : null}
    </section>
  );
}
