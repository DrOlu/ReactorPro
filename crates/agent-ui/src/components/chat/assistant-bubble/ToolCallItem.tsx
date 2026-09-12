import {
  readAskUserQuestionDeadline,
  retainRunningToolContent,
  submitAskUserQuestionAnswers,
  submitPlanDecision,
  usePendingToolApproval,
  usePlanDecisionState,
} from "@liveagent/adapters/assistantBubble";
import { AskUserQuestionCard } from "@liveagent/ui/components/chat/AskUserQuestionCard";
import { AssistantStatus } from "@liveagent/ui/components/chat/AssistantStatus";
import { FileChangeBadge } from "@liveagent/ui/components/chat/FileChangeBadge";
import { LazyCollapse } from "@liveagent/ui/components/chat/LazyCollapse";
import { PlanModeCard } from "@liveagent/ui/components/chat/PlanModeCard";
import { ToolScrollablePre, ToolSection } from "@liveagent/ui/components/chat/ToolSurfaces";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionAnswer,
  parseAskUserQuestionResultDetails,
  sanitizeAskUserQuestionItems,
} from "@liveagent/ui/lib/chat/askUserQuestion";
import {
  deriveFileChangeStats,
  FILE_TOOL_TEXT_FIELDS,
  previewText,
  summarizeToolCall,
  type ToolResultMessage,
  type ToolTraceItem,
  toolResultMessageToText,
} from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  type PlanDecisionAnswer,
  parseExitPlanModeResultDetails,
  sanitizePlanMarkdown,
} from "@liveagent/ui/lib/chat/planMode";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "../../IconSet";
import {
  areStableValuesEqual,
  type FileOperationDisplay,
  getBuiltinResultKind,
  getFileOperationDisplay,
  getShellSessionDisplayDetails,
  getSubagentInlineSummary,
  getToolActivityCategory,
  getToolDisplayName,
  getToolDisplayTitle,
  getToolMeta,
  isBuiltinShareToolName,
  isSubagentCardToolCall,
} from "./assistantBubbleUtils";
import { ShellToolDisplay, ToolArgsDisplay, ToolResultDisplay } from "./ToolResultDisplay";

// Display cap for inline commands in the collapsed summary: far more characters
// than any real window can fit on one line, since visual ellipsis is still left
// to CSS truncate; it only guards against an extremely long single-line command
// (e.g. an inline script) blowing up the resident DOM and the native title. The
// full command is viewable in the expanded area.
const INLINE_COMMAND_PREVIEW_MAX_CHARS = 600;

function capInlineCommandPreview(text: string) {
  return text.length > INLINE_COMMAND_PREVIEW_MAX_CHARS
    ? `${text.slice(0, INLINE_COMMAND_PREVIEW_MAX_CHARS)}…`
    : text;
}

function FileOperationTarget({
  operation,
  actionLabel,
  onOpenFileLink,
}: {
  operation: FileOperationDisplay;
  actionLabel: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const fileLink = operation.kind === "delete" ? null : operation.link;
  if (!fileLink || !onOpenFileLink) {
    return (
      <span className="min-w-0 flex-1 truncate" title={operation.path}>
        {operation.fileName}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-chat-file-link=""
      className="min-w-0 flex-1 cursor-pointer truncate text-left underline decoration-foreground/20 underline-offset-[3px] transition-colors hover:text-foreground hover:decoration-foreground/45"
      title={operation.path}
      aria-label={`${actionLabel} ${operation.path}`}
      onClick={() => onOpenFileLink(fileLink)}
    >
      {operation.fileName}
    </button>
  );
}

function ToolCallItem({
  item,
  isRunning,
  readOnly = false,
  redactToolContent = false,
  compactChip = false,
  onOpenFileLink,
}: {
  item: ToolTraceItem;
  isRunning?: boolean;
  readOnly?: boolean;
  redactToolContent?: boolean;
  compactChip?: boolean;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const { t } = useLocale();
  const result = item.toolResult;
  const builtinResultKind = getBuiltinResultKind(result);
  const isBash = item.toolCall.name === "Bash";
  const isShellSessionControl =
    item.toolCall.name === "ProcessWait" || item.toolCall.name === "ProcessStop";
  const isShellSessionTool = isBash || isShellSessionControl;
  const shellSessionDetails = isShellSessionTool ? getShellSessionDisplayDetails(result) : null;
  const shellSessionStatus = shellSessionDetails?.status;
  const shellSessionFailed = shellSessionStatus === "failed" || shellSessionStatus === "timed_out";
  const displayIsRunning = Boolean(isRunning);
  const isRedactedToolContent = redactToolContent && isBuiltinShareToolName(item.toolCall.name);
  const isAskUser = !isRedactedToolContent && item.toolCall.name === ASK_USER_QUESTION_TOOL_NAME;
  const askDetails = isAskUser ? parseAskUserQuestionResultDetails(result?.details) : null;
  // Render the card only once the arguments are fully generated (the desktop side
  // emits the tool_call event only after onToolCall); for history/degraded data,
  // fall back to isRunning/result so a half-formed question is never shown.
  const askSettled = isAskUser && (Boolean(isRunning) || Boolean(result));
  const askQuestions =
    isAskUser && askSettled
      ? askDetails && askDetails.questions.length > 0
        ? askDetails.questions
        : sanitizeAskUserQuestionItems(item.toolCall.arguments?.questions)
      : [];
  // The question card is forced open while running to await an answer; it collapses automatically once the answer settles.
  const shouldKeepAskOpen = !readOnly && isAskUser && (Boolean(isRunning) || !result);
  const shouldCloseAnsweredAsk = isAskUser && Boolean(result);
  // The deadline and submit action are provided by the host adapter, ensuring both ends use their own authoritative services.
  const askDeadlineAt =
    isAskUser && isRunning && !result
      ? readAskUserQuestionDeadline(item.toolCall.id, item.toolCall.arguments)
      : undefined;
  const submitAskAnswers = useCallback(
    (answers: AskUserQuestionAnswer[]) => submitAskUserQuestionAnswers(item.toolCall.id, answers),
    [item.toolCall.id],
  );
  // ExitPlanMode plan card: dispatched like AskUserQuestion (by tool name), with
  // details preferred and streaming arguments as fallback. Conversational
  // paradigm: submitting ends this turn; pending/approved state is provided
  // reactively by the host adapter (GUI subscribes to a registry, WebUI uses an
  // argument marker), and the approve action also goes through the adapter.
  const isPlanCard = !isRedactedToolContent && item.toolCall.name === EXIT_PLAN_MODE_TOOL_NAME;
  const planDetails = isPlanCard ? parseExitPlanModeResultDetails(result?.details) : null;
  const planMarkdown = isPlanCard
    ? (planDetails?.plan ?? sanitizePlanMarkdown(item.toolCall.arguments?.plan))
    : "";
  const planSettled = isPlanCard && (Boolean(isRunning) || Boolean(result));
  const planState = usePlanDecisionState(item.toolCall.id, item.toolCall.arguments);
  const submitPlanAnswer = useCallback(
    (answer: PlanDecisionAnswer) => submitPlanDecision(item.toolCall.id, answer),
    [item.toolCall.id],
  );
  // Tool approval is read by the host adapter. Approval happens before tool execution, so isRunning cannot be used as the gate.
  const pendingApproval = usePendingToolApproval(item.toolCall.id, item.toolCall.arguments);
  const isApprovalPending = !readOnly && !isRedactedToolContent && !result && pendingApproval;
  const shouldAutoOpen =
    !isRedactedToolContent &&
    (item.toolCall.name === "Image" || builtinResultKind === "display_image" || shouldKeepAskOpen);
  const [open, setOpen] = useState(readOnly || isRedactedToolContent ? false : shouldAutoOpen);
  const userInteractedRef = useRef(false);
  const isSubagentCard = isSubagentCardToolCall(item.toolCall);
  const hasArgs = Object.keys(item.toolCall.arguments || {}).length > 0;
  const isStreamingFilePreviewTool = FILE_TOOL_TEXT_FIELDS[item.toolCall.name] !== undefined;
  const shouldShowArgs =
    !isRedactedToolContent &&
    !isAskUser &&
    !isPlanCard &&
    (!isSubagentCard || !result) &&
    (isStreamingFilePreviewTool ? !result : hasArgs);
  const isManagedProcess = item.toolCall.name === "ManagedProcess";
  const inlineCommand =
    !isRedactedToolContent &&
    (isBash || isManagedProcess) &&
    typeof item.toolCall.arguments?.command === "string"
      ? item.toolCall.arguments.command.trim()
      : "";
  const firstLine = inlineCommand ? inlineCommand.split("\n")[0] : "";
  // Inline command in the collapsed row: visual truncation is left to CSS
  // (truncate emits the ellipsis at the actual available width), no longer hard-cut
  // at a fixed character count (#444). The DOM text and native title each get a
  // cap far beyond the visible width, so an extremely long single-line command
  // cannot render the resident summary row and tooltip unusable.
  const firstLinePreview = capInlineCommandPreview(firstLine);
  const inlineCommandTitle = inlineCommand ? capInlineCommandPreview(inlineCommand) : "";
  const toolArgsSummary =
    isRedactedToolContent || isBash || isShellSessionControl || inlineCommand || isPlanCard
      ? ""
      : isAskUser
        ? (askQuestions[0]?.prompt ?? "")
        : isSubagentCard
          ? getSubagentInlineSummary(item)
          : summarizeToolCall(item.toolCall, {
              includeName: false,
              includeManagerAction: false,
            });
  const fileChangeStats = useMemo(
    () => (isRedactedToolContent ? undefined : deriveFileChangeStats(item.toolCall)),
    [isRedactedToolContent, item.toolCall],
  );
  const fileOperation = useMemo(() => getFileOperationDisplay(item), [item]);
  const meta = getToolMeta(item.toolCall.name);
  const ToolIcon = meta.Icon;
  const activityCategory = getToolActivityCategory(item.toolCall.name);
  const activityPhase =
    result?.isError || shellSessionFailed
      ? "failed"
      : isRunning || !result
        ? "running"
        : "completed";
  const localizedActivityTitle =
    activityCategory === "other"
      ? null
      : t(`chat.tool.activity.${activityCategory}.${activityPhase}`);
  const localizedFileOperationTitle = fileOperation
    ? t(`chat.tool.file.${fileOperation.kind}.${activityPhase}`)
    : null;
  const title = isAskUser
    ? { name: t("chat.tool.askUserTitle"), action: "" }
    : isPlanCard
      ? { name: t("chat.planMode.cardTitle"), action: "" }
      : isRedactedToolContent
        ? { name: getToolDisplayName(item.toolCall.name), action: "" }
        : localizedFileOperationTitle
          ? { name: localizedFileOperationTitle, action: "" }
          : localizedActivityTitle
            ? { name: localizedActivityTitle, action: "" }
            : getToolDisplayTitle(item.toolCall);

  // Successful/running path-based file operations are deliberately a single
  // IDE link row. Failed operations retain the disclosure so the error stays
  // inspectable; Delete is concise but cannot link to a target that is gone.
  const simpleFileOperation =
    !isRedactedToolContent && fileOperation && !result?.isError ? fileOperation : null;

  const statusLabel = isApprovalPending
    ? t("chat.toolApproval.waitingStatus")
    : isRunning
      ? isAskUser
        ? askQuestions.length > 0
          ? t("chat.askUser.waiting")
          : t("chat.askUser.preparing")
        : isPlanCard
          ? t("chat.planMode.submitted")
          : t("chat.tool.running")
      : shellSessionStatus === "running"
        ? t("chat.tool.running")
        : shellSessionStatus === "cancelled"
          ? t("chat.tool.stopped")
          : shellSessionStatus === "completed"
            ? t("chat.tool.success")
            : shellSessionFailed
              ? t("chat.tool.failed")
              : result
                ? result.isError
                  ? t("chat.tool.failed")
                  : t("chat.tool.success")
                : t("chat.tool.waiting");

  const statusTextClass =
    result?.isError || shellSessionFailed ? "text-[hsl(var(--chat-error))]" : "text-foreground/45";

  useEffect(() => {
    if (readOnly || isRedactedToolContent) return;
    if (userInteractedRef.current) return;
    if (shouldKeepAskOpen) {
      setOpen(true);
    } else if (shouldCloseAnsweredAsk) {
      setOpen(false);
    } else if (shouldAutoOpen) {
      setOpen(true);
    }
  }, [isRedactedToolContent, readOnly, shouldAutoOpen, shouldCloseAnsweredAsk, shouldKeepAskOpen]);

  const canExpand =
    !isRedactedToolContent &&
    !simpleFileOperation &&
    !isPlanCard &&
    (shouldShowArgs || Boolean(result) || (isAskUser && askQuestions.length > 0));
  const effectiveOpen = canExpand && open;
  const summaryTitleName =
    isBash && effectiveOpen ? t(`chat.tool.shell.${activityPhase}Title`) : title.name;
  const compactChipText = simpleFileOperation
    ? ""
    : firstLinePreview
      ? firstLinePreview
      : toolArgsSummary || title.action;
  const summaryClassName = cn(
    "flex select-none items-center gap-1.5 text-left",
    compactChip
      ? "group/tool -mx-1.5 min-h-7 w-[calc(100%+0.75rem)] rounded-lg px-1.5 py-1 transition-colors duration-150 hover:bg-foreground/[0.04]"
      : "min-h-7 w-full py-1",
    canExpand ? "cursor-pointer" : "cursor-default",
  );
  const summaryContent = simpleFileOperation ? (
    <>
      <ToolIcon className="h-3 w-3 shrink-0 text-foreground/45" />
      <span
        className={cn(
          "shrink-0 font-[450] text-foreground/62",
          compactChip
            ? "text-[calc(13px*var(--zone-font-scale,1))]"
            : "text-[calc(13px*var(--zone-font-scale,1))]",
          displayIsRunning && "animate-pulse",
        )}
      >
        {summaryTitleName}
      </span>
      <span
        className={cn(
          "inline-flex min-w-0 flex-1 items-center gap-2 font-mono text-foreground/52",
          compactChip
            ? "h-[22px] text-[calc(11.5px*var(--zone-font-scale,1))]"
            : "text-[calc(11.5px*var(--zone-font-scale,1))]",
        )}
      >
        <FileOperationTarget
          operation={simpleFileOperation}
          actionLabel={summaryTitleName}
          onOpenFileLink={onOpenFileLink}
        />
        {fileChangeStats ? (
          <FileChangeBadge
            added={fileChangeStats.added}
            removed={fileChangeStats.removed}
            className={compactChip ? "gap-1" : undefined}
          />
        ) : null}
      </span>
    </>
  ) : compactChip ? (
    <>
      {/* The width is locked to the icon column's 12px (height still keeps a 14px
          breathing room), otherwise the centered box used for the hover swap would
          push the icon 1px right and misalign it with the simple file-operation row
          in the same group. */}
      <span className="relative flex h-3.5 w-3 shrink-0 items-center justify-center text-foreground/45">
        <ToolIcon className="h-3 w-3 transition-opacity duration-150 group-hover/tool:opacity-0 group-focus-within/tool:opacity-0" />
        {canExpand ? (
          <ChevronRight
            className={cn(
              "absolute h-3 w-3 opacity-0 transition-[opacity,transform] duration-150 group-hover/tool:opacity-100 group-focus-within/tool:opacity-100",
              effectiveOpen ? "rotate-90" : "",
            )}
          />
        ) : null}
      </span>

      <span className="shrink-0 text-[calc(13px*var(--zone-font-scale,1))] font-[450] text-foreground/62">
        {summaryTitleName}
      </span>

      {compactChipText || fileChangeStats ? (
        <span className="inline-flex h-[22px] min-w-0 flex-1 items-center gap-2 font-mono text-[calc(11.5px*var(--zone-font-scale,1))] text-foreground/48">
          {compactChipText ? (
            <span
              className="min-w-0 flex-1 truncate"
              title={inlineCommandTitle || toolArgsSummary || undefined}
            >
              {compactChipText}
            </span>
          ) : null}
          {fileChangeStats ? (
            <FileChangeBadge
              added={fileChangeStats.added}
              removed={fileChangeStats.removed}
              className="gap-1"
            />
          ) : null}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}

      {displayIsRunning || result?.isError || shellSessionFailed ? (
        <span
          className={cn("shrink-0 text-[calc(10.5px*var(--zone-font-scale,1))]", statusTextClass)}
        >
          {statusLabel}
        </span>
      ) : null}
    </>
  ) : (
    <>
      <ToolIcon className="h-3 w-3 shrink-0 text-foreground/45 group-hover/tool:text-foreground/65" />

      {/* Tool name + inline summary on same line. Name and summary must stay in
          one inline context (shared baseline): centering them as separate flex
          boxes drifts up to ~1.5px per device with the resolved font metrics. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {/* Container carries the summary styling so the truncation ellipsis
            (styled per the block container) matches the summary text */}
        <div
          className="min-w-0 truncate font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-5 text-foreground/48"
          title={inlineCommandTitle || toolArgsSummary || undefined}
        >
          <span className="font-sans text-[calc(13px*var(--zone-font-scale,1))] font-[450] text-foreground/62 group-hover/tool:text-foreground/75">
            {summaryTitleName}
            {title.action ? (
              <span className="font-mono text-[calc(11.5px*var(--zone-font-scale,1))] font-normal text-foreground/48">
                {" · "}
                {title.action}
              </span>
            ) : null}
          </span>

          {firstLinePreview ? (
            <span className="ml-1.5">{firstLinePreview}</span>
          ) : toolArgsSummary ? (
            <span className="ml-1.5">{toolArgsSummary}</span>
          ) : null}
        </div>

        {fileChangeStats ? (
          <FileChangeBadge added={fileChangeStats.added} removed={fileChangeStats.removed} />
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {displayIsRunning ? (
          <AssistantStatus
            className="min-h-0 gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] text-foreground/45"
            iconClassName="h-3 w-3"
          >
            {statusLabel}
          </AssistantStatus>
        ) : (
          <span className={cn("text-[calc(11px*var(--zone-font-scale,1))]", statusTextClass)}>
            {statusLabel}
          </span>
        )}
        {canExpand ? (
          <ChevronRight
            className={cn(
              "h-3 w-3 text-foreground/40 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/tool:opacity-100 group-focus-within/tool:opacity-100",
              effectiveOpen ? "rotate-90" : "",
            )}
          />
        ) : null}
      </div>
    </>
  );
  const resultContent =
    result &&
    !isShellSessionTool &&
    (!isAskUser || !askDetails) &&
    (!isPlanCard || !planDetails) ? (
      <div className="space-y-1.5">
        <ToolResultDisplay item={item} result={result} readOnly={readOnly} />

        {(() => {
          const resultText = toolResultMessageToText(result);
          if (!/\S/.test(resultText)) return null;
          if (builtinResultKind && builtinResultKind !== "read_image") return null;

          if (readOnly) {
            return (
              <ToolScrollablePre className="max-h-56 bg-black/[0.02] dark:bg-white/[0.03]">
                {previewText(resultText, 6000)}
              </ToolScrollablePre>
            );
          }

          // Errors must be readable at a glance — never behind the
          // collapsed "view return" toggle.
          if (result.isError) {
            return (
              <ToolScrollablePre className="max-h-56 bg-red-500/[0.05] text-red-700/90 dark:bg-red-500/[0.08] dark:text-red-300/90">
                {previewText(resultText, 6000)}
              </ToolScrollablePre>
            );
          }

          return (
            <details className="group/result">
              <summary className="flex cursor-pointer select-none items-center gap-1 text-[calc(10.5px*var(--zone-font-scale,1))] text-muted-foreground/50 transition-colors duration-150 hover:text-foreground/60">
                <ChevronRight className="h-2.5 w-2.5 transition-transform duration-200 group-open/result:rotate-90" />
                {t("chat.tool.viewReturn")}
              </summary>
              <ToolScrollablePre className="mt-1.5 max-h-56 bg-black/[0.02] dark:bg-white/[0.03]">
                {previewText(resultText, 6000)}
              </ToolScrollablePre>
            </details>
          );
        })()}
      </div>
    ) : null;
  const body = (
    <LazyCollapse
      open={effectiveOpen}
      retainWhileClosed={retainRunningToolContent && displayIsRunning}
    >
      {() => (
        <div
          className={cn(
            "pb-2 pt-1",
            compactChip
              ? "mb-1 space-y-1.5 border-l border-border/55 pl-3"
              : "space-y-3 border-l border-border/55 pl-3",
          )}
        >
          {isShellSessionTool ? <ShellToolDisplay item={item} result={result} /> : null}

          {!isShellSessionTool && shouldShowArgs && !compactChip ? (
            <ToolSection
              label={isBash || inlineCommand ? t("chat.tool.command") : t("chat.tool.args")}
            >
              <ToolArgsDisplay item={item} />
            </ToolSection>
          ) : null}

          {isAskUser && askQuestions.length > 0 ? (
            <AskUserQuestionCard
              questions={askQuestions}
              answers={askDetails?.answers}
              cancelled={askDetails?.cancelled === true}
              timedOut={askDetails?.timedOut === true}
              interactive={Boolean(isRunning) && !result && !readOnly}
              deadlineAt={askDeadlineAt}
              onSubmit={submitAskAnswers}
            />
          ) : null}

          {/* The question card/plan card displays its own answer state; fall back to
              the default error area only when argument validation fails (no details). */}
          {resultContent && compactChip ? (
            <div className="min-w-0 py-1 text-foreground/78 [&_.tool-text-scroll]:max-h-44 [&_.tool-text-scroll]:bg-foreground/[0.025]">
              {resultContent}
            </div>
          ) : resultContent ? (
            <ToolSection
              label={t("chat.tool.return")}
              trailing={
                result?.isError ? (
                  <span className="text-[calc(11px*var(--zone-font-scale,1))] font-medium text-red-500">
                    {t("chat.tool.error")}
                  </span>
                ) : null
              }
            >
              {resultContent}
            </ToolSection>
          ) : null}
        </div>
      )}
    </LazyCollapse>
  );
  const containerClassName = "group/tool min-w-0 max-w-full";

  // Plan card renders directly (task-card style): no collapse shell, no summary
  // row, the whole card shown as-is -- the card has its own "implementation plan"
  // header and status, and the body is not height-limited (same scroll context as
  // the message body).
  if (isPlanCard && planSettled && planMarkdown) {
    return (
      <div className={containerClassName}>
        <div className="py-1.5">
          <PlanModeCard
            plan={planMarkdown}
            approved={planState.approved || planDetails?.decision === "approve"}
            pending={planState.pending}
            readOnly={readOnly}
            onSubmit={submitPlanAnswer}
          />
        </div>
      </div>
    );
  }

  if (!canExpand) {
    return (
      <div className={containerClassName}>
        <div className={summaryClassName}>{summaryContent}</div>
      </div>
    );
  }

  return (
    <div className={containerClassName}>
      <button
        type="button"
        aria-expanded={effectiveOpen}
        className={summaryClassName}
        onClick={() => {
          userInteractedRef.current = true;
          setOpen((prev) => !prev);
        }}
      >
        {summaryContent}
      </button>
      {body}
    </div>
  );
}

function areToolResultsEqual(
  previous: ToolResultMessage | undefined,
  next: ToolResultMessage | undefined,
) {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }

  return (
    previous.toolCallId === next.toolCallId &&
    previous.toolName === next.toolName &&
    previous.isError === next.isError &&
    areStableValuesEqual(previous.content, next.content) &&
    areStableValuesEqual(previous.details, next.details)
  );
}

export function areToolTraceItemsEqual(previous: ToolTraceItem, next: ToolTraceItem) {
  if (previous === next) {
    return true;
  }
  return (
    previous.toolCall.id === next.toolCall.id &&
    previous.toolCall.name === next.toolCall.name &&
    areStableValuesEqual(previous.toolCall.arguments, next.toolCall.arguments) &&
    areToolResultsEqual(previous.toolResult, next.toolResult)
  );
}

export const MemoToolCallItem = memo(
  ToolCallItem,
  (previousProps, nextProps) =>
    previousProps.isRunning === nextProps.isRunning &&
    previousProps.readOnly === nextProps.readOnly &&
    previousProps.redactToolContent === nextProps.redactToolContent &&
    previousProps.compactChip === nextProps.compactChip &&
    previousProps.onOpenFileLink === nextProps.onOpenFileLink &&
    areToolTraceItemsEqual(previousProps.item, nextProps.item),
);
