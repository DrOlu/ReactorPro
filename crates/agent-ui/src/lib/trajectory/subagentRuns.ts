/**
 * Data source for subagent runs -> trajectory SUBTOOL rows.
 *
 * A subagent's full trajectory is persisted independently in the `subagentRun` table and does not
 * enter the main conversation event stream - otherwise a single 8-way parallel delegation would
 * fill the relay window. The main event stream only records the runId on `tool_end`, and on
 * expansion the host prefetches the run and hands it to the layout layer.
 *
 * This parses the raw message array directly rather than reusing `buildUiMessages`: only the tool
 * call skeleton is needed, and going through the full UI message folding is both slower and drags
 * host types into the shared layer.
 */

import type { TrajectoryStatus, TrajectorySubagentRun } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalize the backend's run status string to a trajectory status; unknown values are treated as running. */
export function normalizeSubagentStatus(value: unknown): TrajectoryStatus {
  switch (value) {
    case "complete":
    case "completed":
    case "succeeded":
      return "complete";
    case "error":
    case "failed":
      return "error";
    case "cancelled":
    case "canceled":
    case "aborted":
      return "aborted";
    default:
      return "running";
  }
}

type ExtractedTool = {
  callId: string;
  name: string;
  isError: boolean;
  /** Timestamp of the assistant message containing the toolCall; stays null when the message has no timestamp. */
  startedAt: number | null;
  /** Timestamp of the toolResult message; stays null when the result has not come back (still running/interrupted). */
  endedAt: number | null;
};

type ExtractedStep = {
  step: number;
  startedAt: number | null;
  endedAt: number | null;
  tools: ExtractedTool[];
};

/**
 * Extract a per-step tool skeleton from the subagent's raw message array.
 *
 * @param messages - the array parsed from `messages_json`; its contents are untrusted.
 * @returns the step list split by assistant message.
 */
export function extractSubagentSteps(messages: unknown): ExtractedStep[] {
  if (!Array.isArray(messages)) return [];
  const steps: ExtractedStep[] = [];
  const toolIndex = new Map<string, ExtractedTool>();

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const timestamp = finiteOrNull(message.timestamp);

    if (message.role === "assistant") {
      const tools: ExtractedTool[] = [];
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const callId = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "";
        if (callId === "" || name === "") continue;
        // The tool's start uses the assistant message's own timestamp; it is the truest signal the
        // layout layer can get for "when this call was initiated", so it no longer shares the same
        // span as the whole step.
        const tool: ExtractedTool = {
          callId,
          name,
          isError: false,
          startedAt: timestamp,
          endedAt: null,
        };
        tools.push(tool);
        toolIndex.set(callId, tool);
      }
      steps.push({
        step: steps.length + 1,
        startedAt: timestamp,
        endedAt: timestamp,
        tools,
      });
      continue;
    }

    if (message.role === "toolResult") {
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const tool = toolIndex.get(callId);
      if (tool !== undefined) {
        tool.isError = message.isError === true;
        if (timestamp !== null) tool.endedAt = timestamp;
      }
      // The tool result's timestamp is closer to this step's real end point than the assistant message.
      const owner = steps.at(-1);
      if (owner !== undefined && timestamp !== null) owner.endedAt = timestamp;
    }
  }

  return steps;
}

/**
 * Assemble the trajectory view for one subagent run.
 *
 * @param params - the run metadata and its raw message array.
 * @returns a run the layout layer can expand directly into SUBTOOL rows.
 */
export function buildTrajectorySubagentRun(params: {
  runId: string;
  agentId: string;
  name?: string;
  mode?: string;
  status: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  messages: unknown;
}): TrajectorySubagentRun {
  return {
    runId: params.runId,
    agentId: params.agentId,
    ...(params.name === undefined ? {} : { name: params.name }),
    ...(params.mode === undefined ? {} : { mode: params.mode }),
    status: normalizeSubagentStatus(params.status),
    startedAt: finiteOrNull(params.startedAt),
    endedAt: finiteOrNull(params.endedAt),
    steps: extractSubagentSteps(params.messages),
  };
}

/**
 * Merge the multiple segment messages of one run.
 *
 * @param segments - the segments returned by the backend, containing `messagesJson`.
 * @returns the message array concatenated in segment order; segments that fail to parse are skipped.
 */
export function concatSubagentSegmentMessages(segments: unknown): unknown[] {
  if (!Array.isArray(segments)) return [];
  const out: unknown[] = [];
  for (const segment of segments) {
    if (!isRecord(segment)) continue;
    const raw = segment.messagesJson ?? segment.messages_json;
    if (typeof raw !== "string" || raw.trim() === "") continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
    } catch {
      // A single corrupt segment only drops that segment; the rest still expand normally.
    }
  }
  return out;
}
