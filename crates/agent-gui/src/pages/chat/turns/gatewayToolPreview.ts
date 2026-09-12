import type { ToolCall } from "@earendil-works/pi-ai";

import {
  ASK_USER_QUESTION_DEADLINE_ARG,
  ASK_USER_QUESTION_TOOL_NAME,
} from "@liveagent/ui/lib/chat/askUserQuestion";
import {
  EXIT_PLAN_MODE_APPROVED_ARG,
  EXIT_PLAN_MODE_PENDING_ARG,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "@liveagent/ui/lib/chat/planMode";
import {
  TOOL_APPROVAL_DEADLINE_ARG,
  TOOL_APPROVAL_PENDING_ARG,
  TOOL_APPROVAL_SUMMARY_ARG,
} from "@liveagent/ui/lib/chat/toolApprovalArgs";
import {
  countTextLines,
  FILE_TOOL_TEXT_FIELDS,
  LIVE_TOOL_PREVIEW_META_KEY,
  type PreviewFieldMetrics,
  type StreamPreviewMeta,
} from "@liveagent/ui/lib/chat/toolPreview";
import { summarizeToolCall } from "../../../lib/chat/messages/uiMessages";
import { ensureAskUserQuestionDeadlineAt } from "../../../lib/tools/askUserQuestionTools";
import { isPlanApprovalToolCall, isPlanDecisionPending } from "../../../lib/tools/planModeTools";
import { getToolApprovalDeadlineAt, hasPendingToolApproval } from "../../../lib/tools/toolApproval";

const GATEWAY_TOOL_TEXT_PREVIEW_MAX_CHARS = 4000;

// Approval bar summary limit: enough to fully display the vast majority of commands while
// preventing the sync marker payload from growing too large; extremely long cases fall back to
// truncation (the command block inside the approval bar also has max-height + scrolling).
const TOOL_APPROVAL_SUMMARY_MAX_CHARS = 2000;

// Summary of the tool awaiting approval, for the approval bar to display completely and uniformly
// (Bash/ManagedProcess keep the raw command including newlines; other tools reuse
// summarizeToolCall's argument summary). Truncated only in extremely long cases.
export function summarizeToolCallForApproval(
  toolCall: Pick<ToolCall, "id" | "name" | "arguments">,
): string {
  const args = toolCall.arguments || {};
  let text = "";
  if (
    (toolCall.name === "Bash" || toolCall.name === "ManagedProcess") &&
    typeof args.command === "string"
  ) {
    // Commands keep their original newlines (the approval bar displays them fully with pre-wrap); whitespace is not collapsed.
    text = args.command.trim();
  } else if (toolCall.name === "Browser" && typeof args.action === "string") {
    // The browser approval summary must pick the argument corresponding precisely to the action,
    // not "the first non-empty field": the model may pass fields unrelated to this action at the
    // same time (for example eval carrying a url), which would push a harmless target into the
    // summary and obscure the real execution content. The type input text and the eval expression
    // are high-risk information and are displayed in full (the approval bar uses pre-wrap, with
    // extreme length falling back to unified truncation at the end).
    const pick = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const action = args.action;
    let target: string | undefined;
    if (action === "navigate") {
      target = pick(args.url);
    } else if (action === "click") {
      target = pick(args.ref);
    } else if (action === "type") {
      const typed = typeof args.text === "string" ? args.text : "";
      target = [
        pick(args.ref),
        `text: ${JSON.stringify(typed)}`,
        args.submit === true ? "+Enter" : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    } else if (action === "eval") {
      target = typeof args.expression === "string" ? args.expression.trim() : undefined;
    } else if (action === "wait") {
      target =
        pick(args.selector) ?? (typeof args.timeMs === "number" ? `${args.timeMs}ms` : undefined);
    }
    text = [action, target].filter(Boolean).join(" ");
  } else {
    text = summarizeToolCall(toolCall as ToolCall, {
      includeName: false,
      includeManagerAction: false,
    })
      .replace(/\s+/g, " ")
      .trim();
  }
  if (text.length > TOOL_APPROVAL_SUMMARY_MAX_CHARS) {
    return `${text.slice(0, TOOL_APPROVAL_SUMMARY_MAX_CHARS - 1)}…`;
  }
  return text;
}

function buildHeadTailPreview(input: string, maxChars = GATEWAY_TOOL_TEXT_PREVIEW_MAX_CHARS) {
  if (input.length <= maxChars) {
    return {
      text: input,
      metrics: {
        chars: input.length,
        lines: countTextLines(input),
        truncated: false,
      } satisfies PreviewFieldMetrics,
    };
  }

  const omittedChars = Math.max(0, input.length - maxChars);
  const marker = `\n...[truncated ${omittedChars} chars]...\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const headChars = Math.max(0, Math.floor(budget * 0.68));
  const tailChars = Math.max(0, budget - headChars);
  const text =
    budget > 0
      ? `${input.slice(0, headChars)}${marker}${tailChars > 0 ? input.slice(-tailChars) : ""}`
      : input.slice(0, maxChars);

  return {
    text,
    metrics: {
      chars: input.length,
      lines: countTextLines(input),
      truncated: true,
    } satisfies PreviewFieldMetrics,
  };
}

// The canonical producer of streaming tool previews: bridge events
// (tool_call / tool_call_delta / tool_result) and runtime snapshot entries
// all pass through here, so every remote representation of a file tool's
// args carries the same truncated text + true metrics + monotonic progress.
export function buildGatewayToolCallPreviewArguments(
  toolCall: Pick<ToolCall, "id" | "name" | "arguments">,
) {
  const sourceArgs = toolCall.arguments || {};
  // Pending-approval marker: when any tool suspends at beforeToolCall waiting for approval, stamp
  // it onto the arguments synced to the WebUI so the remote renders the approval card and shows a
  // countdown from the same source as the desktop. Snapshots re-sent after approval resolves no
  // longer carry this marker, and the card hides accordingly. Synthetic arguments with a __ prefix
  // are not displayed and do not affect local execution.
  const approvalOverlay: Record<string, unknown> | null =
    toolCall.id && hasPendingToolApproval(toolCall.id)
      ? {
          [TOOL_APPROVAL_PENDING_ARG]: true,
          [TOOL_APPROVAL_DEADLINE_ARG]: getToolApprovalDeadlineAt(toolCall.id) ?? undefined,
          [TOOL_APPROVAL_SUMMARY_ARG]: summarizeToolCallForApproval(toolCall),
        }
      : null;
  // AskUserQuestion: carries the authoritative answer deadline, so the WebUI card countdown shares
  // the same source as the desktop timer (the same preset value is reused when execute suspends;
  // see askUserQuestionTools). The ask tool is read-only and never enters the approval gate, so no
  // approvalOverlay needs to be layered on here.
  if (toolCall.name === ASK_USER_QUESTION_TOOL_NAME) {
    return {
      ...sourceArgs,
      [ASK_USER_QUESTION_DEADLINE_ARG]: ensureAskUserQuestionDeadlineAt(toolCall.id),
    };
  }
  // ExitPlanMode: carries a pending/approved marker (authoritative from the desktop registry), and
  // the WebUI card uses it to render the approve button and the settled state; the snapshot/event
  // is rebuilt through here each time, and state flips sync with the re-sent events.
  if (toolCall.name === EXIT_PLAN_MODE_TOOL_NAME) {
    return {
      ...sourceArgs,
      [EXIT_PLAN_MODE_PENDING_ARG]: isPlanDecisionPending(toolCall.id),
      [EXIT_PLAN_MODE_APPROVED_ARG]: isPlanApprovalToolCall(toolCall.id),
    };
  }
  const fieldsToPreview = FILE_TOOL_TEXT_FIELDS[toolCall.name];
  if (!fieldsToPreview) {
    return approvalOverlay ? { ...sourceArgs, ...approvalOverlay } : sourceArgs;
  }

  const args: Record<string, unknown> = { ...sourceArgs, ...(approvalOverlay ?? {}) };
  const fields: Record<string, PreviewFieldMetrics> = {};
  let progress = 0;

  for (const field of fieldsToPreview) {
    const value = args[field];
    if (typeof value !== "string") continue;
    const preview = buildHeadTailPreview(value);
    args[field] = preview.text;
    fields[field] = preview.metrics;
    progress += preview.metrics.chars;
  }

  if (Object.keys(fields).length > 0) {
    args[LIVE_TOOL_PREVIEW_META_KEY] = { v: 2, progress, fields } satisfies StreamPreviewMeta;
  }

  return args;
}
