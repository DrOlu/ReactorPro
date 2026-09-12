// crates/agent-ui/src/components/chat/clarify/ClarifyPanel.tsx
// Structured clarification panel: each round the model presents a batch of clickable questions
// (single/multi select + a free-form "Other" input), and the user submits the whole round after
// selecting; the user can also "generate the prompt directly" with the selected parts at any time.
// Submitted rounds collapse into read-only summaries, and the final round is previewed as streaming text.
import {
  Check,
  CheckCircle2,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  WandSparkles,
  X,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { isClarifyListFollowing, pinClarifyListIfFollowing } from "./clarifyPanelScroll";
import type { ClarifyAnswer, ClarifyQuestion, ClarifyRound } from "./clarifyTypes";
import type { ClarifySessionState } from "./useClarifySession";

type ClarifyPanelProps = {
  state: ClarifySessionState;
  busy: boolean;
  onSubmitAnswers: (answers: ClarifyAnswer[]) => void;
  /** Generate the final draft directly from the existing answers; carries the partial answers selected in the current round. */
  onGenerateNow: (answers: ClarifyAnswer[]) => void;
  onRetry: () => void;
  onClose: () => void;
};

/** Draft selection for a single question in the pending round. */
type DraftAnswer = {
  labels: string[];
  custom: boolean;
  customText: string;
};

const EMPTY_DRAFT: DraftAnswer = { labels: [], custom: false, customText: "" };

/** An open question (the model gave no options) has no selectable rows, so free-form input is the only way to answer. */
function draftFor(question: ClarifyQuestion, answers: Record<string, DraftAnswer>): DraftAnswer {
  const existing = answers[question.id];
  if (existing) return existing;
  return question.options.length === 0 ? { ...EMPTY_DRAFT, custom: true } : EMPTY_DRAFT;
}

function isDraftAnswered(draft: DraftAnswer): boolean {
  return draft.labels.length > 0 || (draft.custom && draft.customText.trim().length > 0);
}

function RecommendedTag({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gradient-to-r from-amber-400/25 to-amber-500/15 px-1.5 py-0.5 text-[calc(9px*var(--zone-font-scale,1))] font-semibold leading-none text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:from-amber-300/[0.18] dark:to-amber-400/[0.10] dark:text-amber-300 dark:ring-amber-300/20">
      <Sparkles className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}

/** Selection indicator: circular for single select, rounded square for multi select, aligned with the visual conventions of native controls. */
function SelectionIndicator({ selected, multiple }: { selected: boolean; multiple?: boolean }) {
  return (
    <span
      className={cn(
        "mt-[2px] flex h-3.5 w-3.5 shrink-0 items-center justify-center border transition-colors",
        multiple ? "rounded-sm" : "rounded-full",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/40 group-hover/option:border-muted-foreground/70",
      )}
    >
      {selected ? <Check className="h-2.5 w-2.5" /> : null}
    </span>
  );
}

/** Shared appearance of option rows: highlight when selected, outline on hover, amber background for recommended items, reduced opacity when read-only. */
function choiceRowClassName(selected: boolean, interactive: boolean, recommended = false): string {
  return cn(
    "group/option flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
    selected
      ? "border-primary/45 bg-primary/[0.06] dark:border-primary/40 dark:bg-primary/[0.1]"
      : recommended
        ? "border-amber-400/45 bg-gradient-to-r from-amber-400/[0.09] to-amber-300/[0.03] dark:border-amber-300/30 dark:from-amber-300/[0.08] dark:to-amber-200/[0.02]"
        : "border-border/40 dark:border-white/[0.07]",
    interactive && !selected
      ? recommended
        ? "hover:border-amber-400/70 hover:from-amber-400/[0.14] dark:hover:border-amber-300/50"
        : "hover:border-border/70 hover:bg-foreground/[0.03] dark:hover:border-white/[0.14]"
      : "",
    interactive ? "cursor-pointer" : "cursor-default opacity-70",
  );
}

type ChoiceRowProps = {
  multiple: boolean;
  selected: boolean;
  interactive: boolean;
  recommended?: boolean;
  onSelect: () => void;
  children: ReactNode;
};

/** An option row provided by the model. role/aria-checked are written as literal branches so a11y rules can be statically checked. */
function OptionChoiceButton({
  multiple,
  selected,
  interactive,
  recommended,
  onSelect,
  children,
}: ChoiceRowProps) {
  const shared = {
    type: "button" as const,
    disabled: !interactive,
    onClick: onSelect,
    className: choiceRowClassName(selected, interactive, recommended),
  };
  if (multiple) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: option rows contain a recommended badge/rich description, so keep a single focusable button per the ARIA checkbox pattern.
      <button role="checkbox" aria-checked={selected} {...shared}>
        {children}
      </button>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: option rows contain a recommended badge/rich description, so keep a single focusable button per the ARIA radio pattern.
    <button role="radio" aria-checked={selected} {...shared}>
      {children}
    </button>
  );
}

/** The "Other (enter your own)" row: it embeds an input, and a button cannot nest an input, so a div with a role is used. */
function CustomChoiceRow({ multiple, selected, interactive, onSelect, children }: ChoiceRowProps) {
  const tabIndex = interactive ? 0 : -1;
  const shared = {
    "aria-disabled": !interactive,
    onClick: () => {
      if (interactive) onSelect();
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (interactive) onSelect();
      }
    },
    className: choiceRowClassName(selected, interactive),
  };
  if (multiple) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: the row embeds a free-form input, and a native checkbox/button would create illegally nested interactive elements.
      <div role="checkbox" aria-checked={selected} tabIndex={tabIndex} {...shared}>
        {children}
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: the row embeds a free-form input, and a native radio/button would create illegally nested interactive elements.
    <div role="radio" aria-checked={selected} tabIndex={tabIndex} {...shared}>
      {children}
    </div>
  );
}

/** Option container for one question: multi select uses fieldset's implicit group semantics, and single select adds a radiogroup. */
function ChoiceGroup({
  multiple,
  label,
  children,
}: {
  multiple: boolean;
  label: string;
  children: ReactNode;
}) {
  const className = "flex min-w-0 flex-col gap-1 border-0 p-0";
  if (multiple) {
    return (
      <fieldset aria-label={label} className={className}>
        {children}
      </fieldset>
    );
  }
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA in HTML allows fieldset to serve as a radiogroup; child role="radio" items need a radiogroup context.
    <fieldset role="radiogroup" aria-label={label} className={className}>
      {children}
    </fieldset>
  );
}

/**
 * Read-only summary card for a submitted round: a round header (green check + round number) plus
 * per-question "Q badge + question", with answers shown as chips - selected options are primary-colored
 * pills, free-form input is a dashed sky pill (pencil icon), and unanswered items show an italic placeholder.
 */
function SettledRoundSummary({
  round,
  roundLabel,
  skippedLabel,
}: {
  round: ClarifyRound;
  roundLabel: string;
  skippedLabel: string;
}) {
  const answersById = new Map((round.answers ?? []).map((answer) => [answer.questionId, answer]));
  return (
    <div className="overflow-hidden rounded-xl border border-black/[0.05] bg-white/45 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex items-center gap-1.5 border-b border-black/[0.04] bg-muted/35 px-2.5 py-1 dark:border-white/[0.05] dark:bg-white/[0.03]">
        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
        <span className="text-[calc(10px*var(--zone-font-scale,1))] font-medium uppercase tracking-wide text-muted-foreground/75">
          {roundLabel}
        </span>
      </div>
      <div className="flex flex-col gap-2.5 px-2.5 py-2">
        {round.questions.map((question, index) => {
          const answer = answersById.get(question.id);
          const labels = (answer?.selectedLabels ?? []).filter((label) => label.trim().length > 0);
          const custom = answer?.customText?.trim();
          const answered = labels.length > 0 || Boolean(custom);
          return (
            <div key={question.id} className="flex flex-col gap-1">
              <div className="flex items-start gap-1.5">
                <span className="mt-[1px] inline-flex h-4 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] px-1 text-[calc(9px*var(--zone-font-scale,1))] font-semibold leading-none text-muted-foreground/80 dark:bg-white/[0.07]">
                  Q{index + 1}
                </span>
                <span className="min-w-0 text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-muted-foreground">
                  {question.prompt}
                </span>
              </div>
              <div className="ml-[22px] flex flex-wrap items-center gap-1">
                {labels.map((label) => (
                  <span
                    key={label}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/25 bg-primary/[0.08] px-1.5 py-0.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-[1.4] text-foreground/85 dark:border-primary/30 dark:bg-primary/[0.12]"
                  >
                    <Check className="h-2.5 w-2.5 shrink-0 text-primary" />
                    <span className="min-w-0 break-words">{label}</span>
                  </span>
                ))}
                {custom ? (
                  <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-dashed border-sky-500/35 bg-sky-500/[0.07] px-1.5 py-0.5 text-[calc(11px*var(--zone-font-scale,1))] leading-[1.4] text-foreground/80 dark:border-sky-300/30 dark:bg-sky-300/[0.08]">
                    <Pencil className="h-2.5 w-2.5 shrink-0 text-sky-600 dark:text-sky-300" />
                    <span className="min-w-0 break-words">{custom}</span>
                  </span>
                ) : null}
                {!answered ? (
                  <span className="text-[calc(11px*var(--zone-font-scale,1))] italic leading-[1.4] text-muted-foreground/55">
                    {skippedLabel}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The clarification panel floating directly above the input card: draft quote + round Q&A + bottom action bar. */
export function ClarifyPanel(props: ClarifyPanelProps) {
  const { state, busy, onSubmitAnswers, onGenerateNow, onRetry, onClose } = props;
  const { t } = useLocale();
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  const pendingIndex = state.rounds.length - 1;
  const lastRound = state.rounds.at(-1);
  const pendingRound =
    state.status === "awaitingInput" && lastRound && lastRound.answers === null ? lastRound : null;

  // The pending round's draft selections + the currently active tab are keyed by round index and
  // reset during render when the round advances (React's official "adjusting state during render"
  // derived-state pattern, avoiding a one-frame flash of a stale draft from useEffect).
  const [draftState, setDraftState] = useState<{
    round: number;
    answers: Record<string, DraftAnswer>;
    activeIndex: number;
  }>({ round: -1, answers: {}, activeIndex: 0 });
  // Question-switch direction (null on first render, so no animation plays); the keyed content area uses it to pick the slide-in direction.
  const [switchDirection, setSwitchDirection] = useState<"forward" | "backward" | null>(null);
  if (pendingRound && draftState.round !== pendingIndex) {
    setDraftState({ round: pendingIndex, answers: {}, activeIndex: 0 });
    setSwitchDirection(null);
  }
  const draftAnswers = draftState.answers;
  const questionCount = pendingRound?.questions.length ?? 0;
  const safeActiveIndex = Math.min(draftState.activeIndex, Math.max(0, questionCount - 1));
  const activeQuestion = pendingRound?.questions[safeActiveIndex] ?? null;

  // Directional question switch: the content area remounts by question.id and slides in that direction.
  const goToQuestion = (index: number) => {
    if (index === safeActiveIndex || index < 0 || index >= questionCount) return;
    setSwitchDirection(index > safeActiveIndex ? "forward" : "backward");
    setDraftState((current) => ({ ...current, activeIndex: index }));
  };

  const updateDraft = (
    question: ClarifyQuestion,
    updater: (current: DraftAnswer) => DraftAnswer,
  ) => {
    setDraftState((current) => ({
      ...current,
      answers: {
        ...current.answers,
        [question.id]: updater(draftFor(question, current.answers)),
      },
    }));
  };

  const selectOption = (question: ClarifyQuestion, label: string) => {
    if (question.allowMultiple) {
      updateDraft(question, (current) => {
        const selected = current.labels.includes(label);
        return {
          ...current,
          labels: selected
            ? current.labels.filter((item) => item !== label)
            : [...current.labels, label],
        };
      });
      return;
    }
    // Single select: after settling this question, automatically jump to the next unanswered one to reduce manual tab switching.
    const nextAnswers: Record<string, DraftAnswer> = {
      ...draftAnswers,
      [question.id]: {
        ...draftFor(question, draftAnswers),
        labels: [label],
        custom: false,
      },
    };
    const nextUnanswered =
      pendingRound?.questions.findIndex(
        (item, index) => index !== safeActiveIndex && !isDraftAnswered(draftFor(item, nextAnswers)),
      ) ?? -1;
    if (nextUnanswered >= 0) {
      setSwitchDirection(nextUnanswered > safeActiveIndex ? "forward" : "backward");
    }
    setDraftState((current) => ({
      ...current,
      answers: nextAnswers,
      activeIndex: nextUnanswered >= 0 ? nextUnanswered : current.activeIndex,
    }));
  };

  const selectCustom = (question: ClarifyQuestion) => {
    updateDraft(question, (current) => {
      if (question.allowMultiple) return { ...current, custom: !current.custom };
      return { labels: [], custom: true, customText: current.customText };
    });
  };

  const setCustomText = (question: ClarifyQuestion, text: string) => {
    updateDraft(question, (current) => ({ ...current, customText: text }));
  };

  const buildAnswers = (): ClarifyAnswer[] => {
    if (!pendingRound) return [];
    return pendingRound.questions.map((question) => {
      const draft = draftFor(question, draftAnswers);
      const custom = draft.custom ? draft.customText.trim() : "";
      return {
        questionId: question.id,
        prompt: question.prompt,
        selectedLabels: draft.labels.slice(),
        ...(custom ? { customText: custom } : {}),
      };
    });
  };

  const interactive = state.status === "awaitingInput" && Boolean(pendingRound);
  const answeredCount = pendingRound
    ? pendingRound.questions.filter((question) => isDraftAnswered(draftFor(question, draftAnswers)))
        .length
    : 0;
  const totalCount = pendingRound?.questions.length ?? 0;
  const allAnswered = totalCount > 0 && answeredCount === totalCount;

  const submit = () => {
    if (!interactive || !allAnswered) return;
    onSubmitAnswers(buildAnswers());
  };

  const generateNow = () => {
    if (busy || state.status === "done") return;
    onGenerateNow(buildAnswers());
  };

  // Streaming deltas must be pinned to the bottom before paint, otherwise the newest line flashes
  // one cropped frame. After the max-h clamp the scroll container stops growing, and a
  // ResizeObserver watches the inner content box (line wraps/footer encroachment).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rounds/streaming/status are the pin-to-bottom trigger signals, and the effect body only writes scrollTop.
  useLayoutEffect(() => {
    pinClarifyListIfFollowing(listRef.current, followRef.current);
  }, [state.rounds, state.streamingText, state.status, state.error, busy]);

  useLayoutEffect(() => {
    const viewport = listRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const content = viewport.firstElementChild;
    const observer = new ResizeObserver(() => {
      pinClarifyListIfFollowing(viewport, followRef.current);
    });
    observer.observe(viewport);
    if (content instanceof Element) observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const progressText = t("chat.clarify.progress")
    .replace("{answered}", String(answeredCount))
    .replace("{total}", String(totalCount));

  return (
    // Standalone floating layer: its width aligns with the queue panel (inset 0.75rem on each
    // side) and leaves a 1.5rem gap from the input card - the card's top edge uses rounded-3xl, so
    // the flush style (border-b-0 + mb-[-1px]) only suits a square-bottomed edge like the queue's.
    // shrink-0 covers the expanded state - the outer column is flex-col justify-end, the card
    // flex-1 absorbs the flexing, and the panel height is only clamped by max-h-[50vh], not compressed.
    <div
      data-clarify-panel=""
      className="relative z-30 mx-auto mb-1.5 flex max-h-[50vh] min-h-0 w-[calc(100%-1.5rem)] max-w-[720px] shrink-0 flex-col overflow-hidden rounded-2xl border border-black/[0.055] bg-white/80 shadow-[0_8px_24px_-18px_rgba(15,23,42,0.24),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-2xl backdrop-saturate-[165%] dark:border-white/[0.10] dark:bg-white/[0.06] dark:shadow-[0_8px_24px_-18px_rgba(0,0,0,0.72),inset_0_1px_0_rgba(255,255,255,0.08)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground">
          <WandSparkles className="h-3.5 w-3.5" />
          {t("chat.clarify.title")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("chat.clarify.close")}
          title={t("chat.clarify.close")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        ref={listRef}
        data-clarify-messages=""
        className="chat-queue-scroll min-h-0 overflow-y-auto px-3 pb-2 [overflow-anchor:none]"
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          followRef.current = isClarifyListFollowing(el);
        }}
      >
        <div className="flex flex-col gap-2">
          {state.draftText ? (
            <div className="rounded-xl bg-primary/10 px-2.5 py-1.5">
              <span className="mr-1.5 text-[calc(10px*var(--zone-font-scale,1))] font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("chat.clarify.draftLabel")}
              </span>
              <span className="line-clamp-2 whitespace-pre-wrap break-words text-[calc(11px*var(--zone-font-scale,1))] leading-relaxed text-foreground/80">
                {state.draftText}
              </span>
            </div>
          ) : null}

          {state.rounds.map((round, roundIndex) =>
            round.answers !== null ? (
              <SettledRoundSummary
                // biome-ignore lint/suspicious/noArrayIndexKey: the round list is append-only and never reordered, so the index key is stably unique.
                key={roundIndex}
                round={round}
                roundLabel={t("chat.clarify.roundLabel").replace("{round}", String(roundIndex + 1))}
                skippedLabel={t("chat.clarify.skipped")}
              />
            ) : null,
          )}

          {pendingRound && activeQuestion
            ? (() => {
                const draft = draftFor(activeQuestion, draftAnswers);
                const hasOptions = activeQuestion.options.length > 0;
                const customVisible = draft.custom;
                return (
                  <div className="flex flex-col gap-2 pt-0.5">
                    {/* Only one question is shown at a time: with multiple questions the top tabs switch, and answered ones carry a checkmark. */}
                    {questionCount > 1 ? (
                      <div className="flex items-center gap-1 overflow-x-auto border-b border-black/[0.05] pb-1.5 dark:border-white/[0.06]">
                        {pendingRound.questions.map((question, index) => {
                          const isActive = index === safeActiveIndex;
                          const isAnswered = isDraftAnswered(draftFor(question, draftAnswers));
                          return (
                            <button
                              key={question.id}
                              type="button"
                              onClick={() => goToQuestion(index)}
                              className={cn(
                                "flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-none transition-colors",
                                isActive
                                  ? "bg-foreground/[0.07] text-foreground dark:bg-white/[0.09]"
                                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/80",
                              )}
                            >
                              {isAnswered ? <Check className="h-3 w-3 text-emerald-500" /> : null}
                              {question.header || `${t("chat.clarify.tabFallback")} ${index + 1}`}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    {/* The key triggers a remount, playing a lightweight slide-in animation in the chosen direction on question switch. */}
                    <div
                      key={activeQuestion.id}
                      className={cn(
                        "flex flex-col gap-1.5",
                        switchDirection === "forward" ? "ask-question-enter-forward" : "",
                        switchDirection === "backward" ? "ask-question-enter-backward" : "",
                      )}
                    >
                      <div className="text-[calc(12.5px*var(--zone-font-scale,1))] font-medium leading-[1.55] text-foreground/90">
                        {activeQuestion.prompt}
                        {activeQuestion.allowMultiple ? (
                          <span className="ml-1.5 text-[calc(10px*var(--zone-font-scale,1))] font-normal text-muted-foreground/70">
                            {t("chat.clarify.multiHint")}
                          </span>
                        ) : null}
                      </div>

                      <ChoiceGroup
                        multiple={Boolean(activeQuestion.allowMultiple)}
                        label={activeQuestion.prompt}
                      >
                        {activeQuestion.options.map((option) => {
                          const isSelected = draft.labels.includes(option.label);
                          return (
                            <OptionChoiceButton
                              key={option.label}
                              multiple={Boolean(activeQuestion.allowMultiple)}
                              selected={isSelected}
                              interactive={interactive}
                              recommended={Boolean(option.recommended)}
                              onSelect={() => selectOption(activeQuestion, option.label)}
                            >
                              <SelectionIndicator
                                selected={isSelected}
                                multiple={activeQuestion.allowMultiple}
                              />
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-[calc(12px*var(--zone-font-scale,1))] font-medium leading-[1.5] text-foreground/85">
                                    {option.label}
                                  </span>
                                  {option.recommended ? (
                                    <RecommendedTag label={t("chat.clarify.recommended")} />
                                  ) : null}
                                </span>
                                {option.description ? (
                                  <span className="text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-muted-foreground/80">
                                    {option.description}
                                  </span>
                                ) : null}
                              </span>
                            </OptionChoiceButton>
                          );
                        })}

                        {/* The UI-synthesized "Other (enter your own)" row: pinned to the bottom of the
                            options and not part of the model's options; selecting it expands the input.
                            An open question (no options) renders the input directly without an extra
                            "Other" row. Option rows are buttons and an input cannot be nested inside,
                            so this row uses a div with a role. */}
                        {hasOptions ? (
                          <CustomChoiceRow
                            multiple={Boolean(activeQuestion.allowMultiple)}
                            selected={draft.custom}
                            interactive={interactive}
                            onSelect={() => selectCustom(activeQuestion)}
                          >
                            <SelectionIndicator
                              selected={draft.custom}
                              multiple={activeQuestion.allowMultiple}
                            />
                            <span className="flex min-w-0 flex-1 flex-col gap-1">
                              <span className="text-[calc(12px*var(--zone-font-scale,1))] font-medium leading-[1.5] text-foreground/85">
                                {t("chat.clarify.customOption")}
                              </span>
                              {customVisible ? (
                                <input
                                  autoFocus
                                  value={draft.customText}
                                  disabled={!interactive}
                                  placeholder={t("chat.clarify.customPlaceholder")}
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.key === "Enter" && allAnswered) {
                                      event.preventDefault();
                                      submit();
                                    }
                                  }}
                                  onChange={(event) =>
                                    setCustomText(activeQuestion, event.currentTarget.value)
                                  }
                                  className="ask-custom-input-enter h-7 w-full rounded-lg border border-black/[0.08] bg-white/65 px-2 text-[calc(12px*var(--zone-font-scale,1))] text-foreground outline-none transition-[border-color,background-color] placeholder:text-muted-foreground/45 focus:border-primary/45 focus:bg-white/80 dark:border-white/[0.1] dark:bg-white/[0.05] dark:focus:border-primary/40 dark:focus:bg-white/[0.08]"
                                />
                              ) : null}
                            </span>
                          </CustomChoiceRow>
                        ) : (
                          <input
                            value={draft.customText}
                            disabled={!interactive}
                            placeholder={t("chat.clarify.customPlaceholder")}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && allAnswered) {
                                event.preventDefault();
                                submit();
                              }
                            }}
                            onChange={(event) =>
                              setCustomText(activeQuestion, event.currentTarget.value)
                            }
                            className="h-8 w-full rounded-lg border border-black/[0.08] bg-white/65 px-2.5 text-[calc(12px*var(--zone-font-scale,1))] text-foreground outline-none transition-[border-color,background-color] placeholder:text-muted-foreground/45 focus:border-primary/45 focus:bg-white/80 dark:border-white/[0.1] dark:bg-white/[0.05] dark:focus:border-primary/40 dark:focus:bg-white/[0.08]"
                          />
                        )}
                      </ChoiceGroup>
                    </div>
                  </div>
                );
              })()
            : null}

          {busy && state.streamingText ? (
            <div className="max-w-[92%] self-start whitespace-pre-wrap rounded-xl bg-muted/60 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] leading-relaxed text-foreground/90">
              {state.streamingText}
            </div>
          ) : null}
          {state.status === "asking" && !state.streamingText ? (
            <div className="flex items-center gap-1.5 self-start rounded-xl bg-muted/60 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("chat.clarify.thinking")}
            </div>
          ) : null}
          {state.status === "error" && state.error ? (
            <div className="flex items-center gap-2 self-start rounded-xl bg-destructive/10 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-destructive">
              <span className="min-w-0 flex-1">
                {t("chat.clarify.errorPrefix")}: {state.error}
              </span>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors hover:bg-destructive/15"
              >
                <RefreshCw className="h-3 w-3" />
                {t("chat.clarify.retry")}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {interactive ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-black/[0.05] px-2.5 py-1.5 dark:border-white/[0.08]">
          <span className="min-w-0 truncate text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground/70">
            {progressText}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={generateNow}
              title={t("chat.clarify.generate")}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-black/[0.06] px-2.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground dark:border-white/[0.12]"
            >
              <WandSparkles className="h-3 w-3" />
              <span className="whitespace-nowrap">{t("chat.clarify.generate")}</span>
            </button>
            <button
              type="button"
              disabled={!allAnswered}
              onClick={submit}
              className="inline-flex h-7 items-center rounded-full bg-primary px-3 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
            >
              {t("chat.clarify.submit")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
