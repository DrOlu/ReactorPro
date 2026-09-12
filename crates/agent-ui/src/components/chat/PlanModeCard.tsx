// Chat card for ExitPlanMode: displays the implementation plan submitted by the model (markdown).
// Conversational paradigm: submission ends the turn -- the user typing "agree/start" directly
// approves it, and any other input is revision feedback (a normal message); the card keeps only one
// "Approve and start executing" shortcut button.
// A pure presentational component; the button action and pending state are injected by the caller;
// shared by both ends, with end-specific differences kept in ToolCallItem.

import { Check, CheckCircle2, ListChecks, Loader2 } from "@liveagent/ui/components/IconSet";
import { Markdown } from "@liveagent/ui/components/Markdown";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useState } from "react";
import type { PlanDecisionAnswer } from "../../lib/chat/planMode";
import { cn } from "../../lib/shared/utils";

export type PlanDecisionSubmitOutcome = { ok: boolean; message?: string };

export function PlanModeCard({
  plan,
  approved = false,
  pending = false,
  readOnly = false,
  onSubmit,
}: {
  /** The full plan submitted by the model (markdown). */
  plan: string;
  /** Already approved (historical/settled state). */
  approved?: boolean;
  /** This plan is still the conversation's pending plan (approvable); false after being superseded by
   * a new submission. */
  pending?: boolean;
  readOnly?: boolean;
  onSubmit?: (answer: PlanDecisionAnswer) => Promise<PlanDecisionSubmitOutcome>;
}) {
  const { t } = useLocale();
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState("");

  const canApprove = pending && !approved && !readOnly && Boolean(onSubmit);

  // The card has three appearances, not two ("approved/other"):
  //   approved -- settled as approved;
  //   pending  -- still the conversation's pending plan (also pending in a read-only view, just not
  //               operable on this end);
  //   inactive -- neither approved nor pending. The cause may be replacement by a new plan,
  //               cancellation of this turn, or a lost marker in historical/degraded data; this end
  //               cannot tell which, so it states only the certain fact "no longer pending" and does
  //               not guess at the cause.
  const tone: "approved" | "pending" | "inactive" = approved
    ? "approved"
    : pending
      ? "pending"
      : "inactive";

  const approve = async () => {
    if (!onSubmit || !canApprove || submitting) return;
    setSubmitting(true);
    setErrorText("");
    try {
      const outcome = await onSubmit({ decision: "approve" });
      if (!outcome.ok) {
        setErrorText(outcome.message || t("chat.planMode.submitFailed"));
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : t("chat.planMode.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={cn(
        // The border stays consistent with sibling tool cards, and the status color is carried in one
        // place only, by the left spine, avoiding multiple emphasis points diluting each other.
        "tool-expand relative overflow-hidden rounded-xl border border-border/45 bg-background/70 dark:border-white/[0.08] dark:bg-white/[0.03]",
        // Only a plan that can still be decided deserves to stand out from the transcript; anything
        // settled falls back to a quiet historical document.
        tone === "pending"
          ? "shadow-[0_1px_2px_-1px_rgba(15,23,42,0.07),0_14px_32px_-26px_rgba(2,132,199,0.55)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_32px_-24px_rgba(0,0,0,0.7)]"
          : "dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
      )}
    >
      {/* Status spine: this is the only card in the whole transcript waiting for the user to decide.
          The left color bar is the card's sole emphasis, both distinguishing it from ordinary tool
          rows and carrying the three states via color. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-[3px]",
          tone === "approved"
            ? "bg-gradient-to-b from-emerald-400 to-emerald-500"
            : tone === "pending"
              ? "bg-gradient-to-b from-sky-400 via-sky-500 to-indigo-500 shadow-[2px_0_12px_-2px_rgba(2,132,199,0.5)]"
              : "bg-border dark:bg-white/[0.12]",
        )}
      />

      <div className="flex items-center gap-2 border-b border-border/35 px-3.5 py-2 dark:border-white/[0.05]">
        <ListChecks
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            tone === "approved"
              ? "text-emerald-600 dark:text-emerald-400"
              : tone === "pending"
                ? "text-sky-600 dark:text-sky-400"
                : "text-muted-foreground/60",
          )}
        />
        <span className="text-[calc(12px*var(--zone-font-scale,1))] font-medium tracking-[0.01em] text-foreground/90">
          {t("chat.planMode.cardTitle")}
        </span>

        {/* When the plan is long the button falls outside the viewport; the header status lets the
            user know the plan's situation without scrolling to the bottom. */}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] leading-none text-muted-foreground">
          {tone === "approved" ? (
            <>
              <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              {t("chat.planMode.approved")}
            </>
          ) : tone === "pending" ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400" />
              {t("chat.planMode.awaiting")}
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full border border-muted-foreground/45" />
              {t("chat.planMode.inactive")}
            </>
          )}
        </span>
      </div>

      <div className="px-4 py-3.5">
        <Markdown content={plan} className="plan-markdown font-chat" readOnly={readOnly} />
      </div>

      {canApprove ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-border/35 bg-foreground/[0.015] px-3.5 py-2.5 dark:border-white/[0.05] dark:bg-white/[0.015]">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void approve()}
            className="group/approve inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[calc(12px*var(--zone-font-scale,1))] font-medium text-primary-foreground shadow-[0_1px_2px_-1px_rgba(15,23,42,0.25)] transition-[background-color,transform,box-shadow] duration-150 ease-out hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {submitting ? t("chat.planMode.approving") : t("chat.planMode.approve")}
          </button>
          {errorText ? (
            <span className="min-w-0 flex-1 text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-[hsl(var(--chat-error))]">
              {errorText}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
