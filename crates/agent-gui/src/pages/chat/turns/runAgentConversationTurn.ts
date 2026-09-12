import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { ASK_USER_QUESTION_TOOL_NAME } from "@liveagent/ui/lib/chat/askUserQuestion";
import type { HostedSearchBlock } from "@liveagent/ui/lib/chat/hostedSearch";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import {
  composeTrajectorySystemPrompt,
  serializeToolCatalog,
} from "@liveagent/ui/lib/trajectory/sections";
import type { TrajectoryUsage } from "@liveagent/ui/lib/trajectory/types";
import type { CompactionController } from "../../../lib/chat/compaction/controller";
import {
  estimateTextTokens,
  estimateTextTokenUnits,
} from "../../../lib/chat/compaction/tokenLedger";
import type { ProviderRuntimeConfig } from "../../../lib/chat/compaction/types";
import { resolveTailBlockAnchorId } from "../../../lib/chat/context/contextTailBlock";
import {
  isAbortedAssistantMessage,
  type SuppressedToolTraceSnapshot,
} from "../../../lib/chat/conversation/chatAbort";
import {
  appendMessagesToConversation,
  appendRenderOnlyMessagesToConversation,
  type ConversationViewState,
} from "../../../lib/chat/conversation/conversationState";
import type {
  LiveTranscriptStore,
  RetryAttemptRecord,
} from "../../../lib/chat/conversation/liveTranscriptStore";
import type {
  ConversationHookLifecycle,
  GatewayBridgeEventController,
} from "../../../lib/chat/conversation/run";
import type { TurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import { memoryExtraction } from "../../../lib/chat/memory/extractionController";
import type {
  MemoryExtractionModelConfig,
  MemoryExtractionStatusText,
  MemoryExtractionVisibleEvents,
} from "../../../lib/chat/memory/extractionEngine";
import {
  appendTextDeltaToRound,
  appendThinkingDeltaToRound,
  attachToolResultToRound,
  collapseThinking,
  type LiveRound,
  markToolCallRunningInRound,
  updateLiveRound,
  upsertHostedSearchToRound,
  upsertToolCallToRound,
} from "../../../lib/chat/messages/uiMessages";
import {
  type AgentRunnerFailoverParams,
  runAssistantWithTools,
} from "../../../lib/chat/runner/agentRunner";
import { buildToolsSuffix } from "../../../lib/chat/runner/toolExecutionPrompt";
import type { StreamDebugLogger } from "../../../lib/debug/agentDebug";
import { assistantMessageToText } from "../../../lib/providers/llm";
import { resolveRuntimePlatform } from "../../../lib/runtimePlatform";
import {
  type AppSettings,
  type McpSettingsOp,
  type ProviderId,
  type SshHostConfig,
  selectEnabledMcpServers,
  workspaceProjectPathKey,
} from "../../../lib/settings";
import {
  AGENT_TOOL_NAME,
  buildRosterIdentitySection,
  buildRosterRunStatusSection,
  createSubagentScheduler,
  isSubagentCardToolCall,
  renderMessageBusDelta,
  renderMessageBusSnapshot,
  SUBAGENT_PARENT_ID,
  type SubagentConversationStore,
  type SubagentTemplate,
} from "../../../lib/subagents";
import type { AdditionalProjectRoot } from "../../../lib/tools/additionalProjectRoots";
import { buildBuiltinToolRegistry } from "../../../lib/tools/builtinRegistry";
import type { BuiltinToolExecutionContext } from "../../../lib/tools/builtinTypes";
import { createFileToolState } from "../../../lib/tools/fileToolState";
import {
  buildPlanModeSystemPromptSection,
  createPlanModeRunPolicy,
  isPlanModeAllowedTool,
} from "../../../lib/tools/planModeTools";
import { resolveShellSandboxSettings } from "../../../lib/tools/sandboxPolicy";
import type { SkillAccessPolicy } from "../../../lib/tools/skillAccessPolicy";
import type { SshManagerSessionChange } from "../../../lib/tools/sshManagerTools";
import { formatTaskListRuntimeContext, type TaskStateStore } from "../../../lib/tools/taskTools";
import { isSessionApproved, requestToolApproval } from "../../../lib/tools/toolApproval";
import { resolveToolPolicy } from "../../../lib/tools/toolPolicy";
import {
  buildMcpRequestToolFilter,
  getMcpToolActivation,
} from "../../../lib/tools/toolSearchTools";
import type { TunnelManagerChange } from "../../../lib/tools/tunnelManagerTools";
import { trajectoryTerminalInfo } from "../../../lib/trajectory/assistantOutcome";
import {
  NOOP_TRAJECTORY_RECORDER,
  type TrajectoryRecorder,
} from "../../../lib/trajectory/recorder";
import {
  appendSystemPrompt,
  buildPartialAssistantMessage,
  createEmptyAssistantUsage,
} from "../runtime/chatPageRuntime";
import {
  buildGatewayToolCallPreviewArguments,
  summarizeToolCallForApproval,
} from "./gatewayToolPreview";
import { buildTrajectoryRuntimeContext } from "./trajectoryRuntimeContext";

export type RuntimeModel = {
  api: AssistantMessage["api"];
  provider: AssistantMessage["provider"];
  id: string;
};

export type PersistConversationParams = {
  conversationId: string;
  sessionId: string;
  providerId: string;
  model: string;
  cwd?: string;
  state: ConversationViewState;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
};

const AGENT_PERF_LOG_THRESHOLD_MS = 250;
const TOOL_CALL_DELTA_RAF_FALLBACK_DELAY_MS = 64;
const PARENT_MESSAGE_BUS_AGENT_NAME = "Parent Agent";

function perfNowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function scheduleToolCallDeltaFlush(callback: () => void) {
  let frameId: number | null = null;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let finished = false;

  const run = () => {
    if (finished) return;
    finished = true;
    if (frameId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
      timeoutId = null;
    }
    callback();
  };

  const canUseAnimationFrame =
    typeof requestAnimationFrame === "function" &&
    (typeof document === "undefined" || document.visibilityState === "visible");
  if (canUseAnimationFrame) {
    frameId = requestAnimationFrame(run);
  }

  if (typeof globalThis.setTimeout === "function") {
    timeoutId = globalThis.setTimeout(
      run,
      canUseAnimationFrame ? TOOL_CALL_DELTA_RAF_FALLBACK_DELAY_MS : 0,
    );
  } else if (!canUseAnimationFrame && typeof queueMicrotask === "function") {
    queueMicrotask(run);
  }

  return () => {
    if (finished) return;
    finished = true;
    if (frameId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}

function finishAgentPerfSpan(
  logger: StreamDebugLogger,
  span: string,
  startedAt: number,
  fields: Record<string, unknown> = {},
  thresholdMs = AGENT_PERF_LOG_THRESHOLD_MS,
) {
  const durationMs = Math.round(perfNowMs() - startedAt);
  const payload = {
    type: "perf_span",
    span,
    durationMs,
    ...fields,
  };
  if (logger.enabled) {
    logger.logResult(payload);
  }
  if (durationMs >= thresholdMs) {
    console.warn(`[Agent perf] ${span} took ${durationMs}ms`, fields);
  }
  return durationMs;
}

// Only enabled, non-empty templates are resolvable from Agent calls.
function enabledSubagentTemplates(agentTemplates: AppSettings["agents"]): SubagentTemplate[] {
  return (agentTemplates ?? [])
    .filter((template) => template.enabled && template.prompt.trim())
    .map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      prompt: template.prompt,
    }));
}

// The parent Agent call is suppressed in favor of the per-agent cards; a
// rejected batch (error result) stays visible so validation failures are
// never silent.
function shouldShowToolEvent(toolCall: ToolCall, toolResult?: ToolResultMessage) {
  if (toolCall.name !== AGENT_TOOL_NAME) return true;
  if (isSubagentCardToolCall(toolCall)) return true;
  return toolResult?.isError === true;
}

/** Normalize provider usage into trajectory usage; missing fields are omitted rather than filled with 0 to fake a real value. */
function toTrajectoryUsage(value: unknown): TrajectoryUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const pick = (key: string) => (typeof raw[key] === "number" ? (raw[key] as number) : undefined);
  const usage: TrajectoryUsage = {
    ...(pick("totalTokens") === undefined ? {} : { totalTokens: pick("totalTokens") }),
    ...(pick("input") === undefined ? {} : { input: pick("input") }),
    ...(pick("output") === undefined ? {} : { output: pick("output") }),
    ...(pick("cacheRead") === undefined ? {} : { cacheRead: pick("cacheRead") }),
    ...(pick("cacheWrite") === undefined ? {} : { cacheWrite: pick("cacheWrite") }),
    ...(pick("reasoning") === undefined ? {} : { reasoning: pick("reasoning") }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/**
 * Extract subagent runIds from tool results.
 *
 * The Agent tool's details carry a batch of subagent runs; the trajectory only
 * records ids, and SUBTOOL rows are expanded in the layout layer after the host
 * prefetches the runs. On a structural mismatch it quietly returns an empty
 * array — instrumentation must never throw because the shape of details changed.
 */
function subagentRunIdsFromToolResult(toolResult: unknown): string[] {
  if (toolResult === null || typeof toolResult !== "object") return [];
  const details = (toolResult as { details?: unknown }).details;
  if (details === null || typeof details !== "object") return [];
  const agents = (details as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return [];
  const ids: string[] = [];
  for (const agent of agents) {
    if (agent === null || typeof agent !== "object") continue;
    const runId = (agent as { runId?: unknown }).runId;
    if (typeof runId === "string" && runId !== "") ids.push(runId);
  }
  return ids;
}

export type RunAgentConversationTurnParams = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  failover?: AgentRunnerFailoverParams;
  runtimeModel: RuntimeModel;
  selectedModel: {
    customProviderId: string;
    model: string;
  };
  effectiveWorkdir: string;
  additionalRoots?: readonly AdditionalProjectRoot[];
  effectiveSkillsEnabled: boolean;
  showSilentMemoryExtraction: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  onManagedSkillsChanged?: (change: {
    action: "install" | "create" | "delete";
    names: string[];
    baseDirs: string[];
  }) => void | Promise<void>;
  agentTemplates: AppSettings["agents"];
  getMcpSettings: () => AppSettings["mcp"];
  /** Live read of the tool approval policy (authoritative settingsRef, not a turn-level snapshot); absent is treated as an empty map. */
  getToolPolicies?: () => AppSettings["system"]["toolPolicies"];
  /** Allow CUA tools to operate on ReactorPro itself; defaults to false, see lib/tools/cuaSelfGuard.ts. */
  getCuaAllowSelfTargeting?: () => boolean;
  /** Command execution mode (turn-level snapshot): ask = approve everything / auto = follow policy / sandbox (± offline). */
  commandSafetyMode?: AppSettings["system"]["commandSafetyMode"];
  /** Plan mode (turn-level snapshot): when true, this turn injects only read-only tools + the ExitPlanMode submission gate. */
  planModeEnabled?: boolean;
  applyMcpOps?: (ops: McpSettingsOp[]) => void;
  remoteWebTunnelsEnabled?: boolean;
  tunnelPublicBaseUrl?: string;
  onTunnelsChanged?: (change: TunnelManagerChange) => void;
  sshHosts?: SshHostConfig[];
  associatedSshHostIds?: string[];
  sshManagerRemoteAllowed?: boolean;
  onSshSessionsChanged?: (change: SshManagerSessionChange) => void;
  sessionId: string;
  /** Run-level task state store: built by the send pipeline; commits go through non-terminal persistence. */
  taskStateStore: TaskStateStore;
  conversationId: string;
  /** Structured conversation references explicitly selected in the current composer draft. */
  referencedConversations?: readonly ConversationMentionReference[];
  checkpointTurnId?: string;
  conversationCwd?: string;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
  transcriptStore: LiveTranscriptStore;
  gatewayBridgeEvents: GatewayBridgeEventController;
  hookLifecycle: ConversationHookLifecycle;
  conversationDebugLogger: StreamDebugLogger;
  subagentStore?: SubagentConversationStore;
  getNextConversationState: () => ConversationViewState;
  applyConversationState: (state: ConversationViewState) => void;
  buildPreparedContext: (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: {
      includeAbortedMessages?: boolean;
      includeUploadedFilesMetadata?: boolean;
      includeMemoryTurnUpdates?: boolean;
    },
  ) => Context;
  compaction: CompactionController;
  cancellation: TurnCancellation;
  resetLiveTranscript: (store: LiveTranscriptStore) => void;
  settleLiveTranscript: (store: LiveTranscriptStore) => void;
  batchLiveRoundsUpdate: (
    updater: (prev: LiveRound[]) => LiveRound[],
    store: LiveTranscriptStore,
  ) => void;
  updateToolStatus: (status: string | null, store: LiveTranscriptStore) => void;
  updateRetryAttempts: (attempts: RetryAttemptRecord[], store: LiveTranscriptStore) => void;
  updatePersistableAgentProgress: (progress: {
    completedThroughRound: number;
    suppressedToolTrace: SuppressedToolTraceSnapshot[];
  }) => void;
  commitVisibleAbortedConversation: () => boolean;
  freezeGatewayFinalProjection: (state: ConversationViewState, contentComplete?: boolean) => void;
  persistConversationWithHistorySync: (params: PersistConversationParams) => Promise<boolean>;
  memoryExtractionModel?: MemoryExtractionModelConfig;
  onMemoryExtractionModelFailure?: (model: MemoryExtractionModelConfig) => void;
  memoryExtractionStatusText?: MemoryExtractionStatusText;
  /** Trajectory instrumentation; when absent nothing is recorded and conversation behavior is completely unchanged. */
  trajectory?: TrajectoryRecorder;
  /** This turn's ordinal within the conversation (1-based), used to place trajectory entries. */
  trajectoryTurn?: number;
  /** 0-based messageIndex of the user message in the full conversation, used for precise branch/resend trimming. */
  trajectoryMessageIndex?: number;
  /** Stable id of the user message; the body window prefers aligning trajectory turns by it. */
  trajectoryMessageId?: string;
  /** Reads the system prompt segments from the most recent context build, for trajectory segment deduplication. */
  readTrajectorySlots?: () => {
    base?: string;
    agent?: string;
    skills?: string;
    memory?: string;
  };
};

export async function runAgentConversationTurn(params: RunAgentConversationTurnParams) {
  const {
    providerId,
    model,
    runtime,
    runtimeModel,
    selectedModel,
    effectiveWorkdir,
    additionalRoots,
    effectiveSkillsEnabled,
    showSilentMemoryExtraction,
    skillsRootDir,
    skillAccessPolicy,
    onManagedSkillsChanged,
    agentTemplates,
    getMcpSettings,
    getToolPolicies,
    getCuaAllowSelfTargeting,
    commandSafetyMode,
    planModeEnabled,
    applyMcpOps,
    remoteWebTunnelsEnabled,
    tunnelPublicBaseUrl,
    onTunnelsChanged,
    sshHosts,
    associatedSshHostIds,
    sshManagerRemoteAllowed,
    onSshSessionsChanged,
    sessionId,
    taskStateStore,
    conversationId,
    referencedConversations,
    checkpointTurnId,
    conversationCwd,
    fallbackTitle,
    createdAt,
    titlePromise,
    transcriptStore,
    gatewayBridgeEvents,
    hookLifecycle,
    conversationDebugLogger,
    subagentStore,
    getNextConversationState,
    applyConversationState,
    buildPreparedContext,
    compaction,
    cancellation,
    resetLiveTranscript,
    settleLiveTranscript,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
    updatePersistableAgentProgress,
    commitVisibleAbortedConversation,
    freezeGatewayFinalProjection,
    persistConversationWithHistorySync,
    memoryExtractionModel,
    onMemoryExtractionModelFailure,
    memoryExtractionStatusText,
  } = params;
  // Instrumentation is optional throughout: when no recorder is injected, all
  // calls land on a side-effect-free NOOP implementation and not a single line
  // of the conversation path changes.
  const trajectory = params.trajectory ?? NOOP_TRAJECTORY_RECORDER;
  if (params.trajectoryTurn !== undefined) {
    // The body (the user's actual words) does not enter the event stream; at
    // render time the body index fills it in from messages.
    trajectory.beginTurn({
      turn: params.trajectoryTurn,
      ...(params.trajectoryMessageIndex === undefined
        ? {}
        : { messageIndex: params.trajectoryMessageIndex }),
      ...(params.trajectoryMessageId === undefined
        ? {}
        : { messageId: params.trajectoryMessageId }),
    });
  }

  if (!effectiveWorkdir) {
    throw new Error("Tool mode requires a project directory from the chat sidebar.");
  }

  // Reset per-turn dedup state so <already-written-this-turn> reflects only
  // this turn. In-flight extraction from the previous turn keeps running.
  memoryExtraction.noteTurnBoundary(conversationId);

  const loadParentBusMessages = async () => {
    if (!subagentStore) return null;
    try {
      return await subagentStore.listBusMessages(SUBAGENT_PARENT_ID);
    } catch (error) {
      console.warn("Failed to load parent message bus snapshot", error);
      return null;
    }
  };
  const subagentStoreReadyStartedAt = perfNowMs();
  // The roster is split into two parts: identity fields (id / name / role / mode)
  // are stable and stay in systemPrompt; runtime state (status / last_task /
  // last_summary) changes as the subagent run progresses and is moved to the tail
  // of the messages, otherwise every state advance would rewrite systemPrompt
  // and invalidate the system block together with all history after it.
  let rosterIdentitySection = "";
  // The message bus snapshot is likewise frozen per "compaction epoch":
  // recomputed only at run start and each compaction boundary. Newly arrived
  // subagent messages within a run do not retroactively rewrite systemPrompt
  // (that would invalidate the system block and all history after it); instead
  // renderMessageBusDelta renders them as an incremental block appended to the
  // message tail — the tail already sits after the cache breakpoint and is
  // re-read every round, so appending loses no extra hit rate.
  let parentMessageBusSnapshot = "";
  // The bus cursor already rendered into the context (seq): within a run only
  // increments after it are delivered.
  let renderedBusSeq = 0;
  // The seq actually covered by the currently frozen snapshot. It must be tracked
  // separately from renderedBusSeq: the latter advances with tail increments,
  // while the snapshot is recomputed only at compaction boundaries, so the two
  // are simply not paired within a run.
  let frozenBusSeq = 0;
  const refreezeParentMessageBus = async () => {
    const messages = await loadParentBusMessages();
    // On read failure, keep the previous snapshot and rewind the cursor to the
    // position that snapshot covered: all call sites are after compaction, the
    // tail block holding increments may already be truncated, and leaving the
    // cursor where it is would make those messages neither in the snapshot nor
    // in history, permanently lost. After rewinding, the next round redelivers —
    // redelivery only costs extra tokens, losing messages is irreversible.
    if (!messages) {
      renderedBusSeq = frozenBusSeq;
      return;
    }
    const snapshot = renderMessageBusSnapshot({
      messages,
      currentAgentId: SUBAGENT_PARENT_ID,
      currentAgentName: PARENT_MESSAGE_BUS_AGENT_NAME,
    });
    parentMessageBusSnapshot = snapshot.text;
    // The cursor must use the seq actually covered by the snapshot (the
    // contiguous rendered prefix), not the maximum seq of all visible messages:
    // the snapshot has an item cap, and messages squeezed out by the quota would,
    // if skipped by the cursor, be neither in the snapshot nor delivered again as
    // deltas — silently lost.
    frozenBusSeq = snapshot.renderedSeq;
    renderedBusSeq = frozenBusSeq;
  };
  if (subagentStore) {
    try {
      await subagentStore.ready();
      rosterIdentitySection = buildRosterIdentitySection({
        identities: subagentStore.listIdentities(),
      });
    } catch (error) {
      console.warn("Failed to load the subagent roster", error);
    }
    await refreezeParentMessageBus();
  }
  finishAgentPerfSpan(
    conversationDebugLogger,
    "subagent_store.ready",
    subagentStoreReadyStartedAt,
    {
      conversationId,
      identityCount: subagentStore?.listIdentities().length ?? 0,
    },
  );
  const buildParentMessageBusDelta = async () => {
    const messages = await loadParentBusMessages();
    if (!messages) return { text: "", lastSeq: renderedBusSeq };
    return renderMessageBusDelta({
      messages,
      sinceSeq: renderedBusSeq,
      currentAgentId: SUBAGENT_PARENT_ID,
      currentAgentName: PARENT_MESSAGE_BUS_AGENT_NAME,
    });
  };
  let currentTrajectoryRuntimeContext = buildTrajectoryRuntimeContext([]);
  const lastRecordedRuntimeContextBySource = new Map<string, string>();
  // The mutable roster segment already delivered into the context: like the bus
  // seq cursor, it advances only when actually attached. Nothing is delivered at
  // run start — at that point the message tail has no safe anchor yet (the last
  // message is a user message), so the first delivery happens after the first
  // round's tool result; before that the roster in the Agent tool description
  // already carries status / summary, so the model can see it when it actually
  // wants to delegate.
  let renderedRosterRunStatus = "";
  const buildRosterRunStatusDelta = () => {
    if (!subagentStore) return "";
    let section = "";
    try {
      section = buildRosterRunStatusSection({
        identities: subagentStore.listIdentities(),
        latestRunsByAgent: subagentStore.latestRunsByAgent(),
      });
    } catch (error) {
      console.warn("Failed to render the subagent run status", error);
      return "";
    }
    // If the content has not changed, do not deliver: unconditionally appending
    // every round is effectively punching through the cache yourself.
    return section === renderedRosterRunStatus ? "" : section;
  };
  // The task state snapshot is frozen per "compaction epoch": recomputed only at
  // run start and each compaction boundary, never re-read within a run. The cache
  // prefix is matched bytewise and systemPrompt comes before all messages —
  // re-reading meta.taskList every round would mean every TaskUpdate rewrites the
  // prefix, invalidating the system block together with all history after it. The
  // model's main channel for perceiving task state is the tool results of
  // TaskCreate / TaskUpdate / TaskList; this JSON only becomes irreplaceable
  // after history is truncated by compaction and tool results are summarized away
  // (see the text in formatTaskListRuntimeContext), and at that moment the prefix
  // is being rebuilt anyway, so re-freezing is free. The cost is that tasks
  // created within the run do not appear in the system segment and are covered by
  // tool results.
  let frozenTaskListContext = "";
  const refreezeTaskListContext = () => {
    // Only inject this Run's authoritative task state: paths such as edit-resend
    // may bring a previous Run's persisted taskList back into meta; the tool
    // layer treats it as nonexistent by runId, and injection must use the same
    // semantics.
    const taskList = getNextConversationState().meta.taskList;
    frozenTaskListContext =
      taskList && taskList.runId === taskStateStore.runId
        ? formatTaskListRuntimeContext(taskList)
        : "";
    return frozenTaskListContext;
  };
  refreezeTaskListContext();
  // Plan mode segment: turn-level snapshot, constant text within the run,
  // injected frozen alongside frozenTaskListContext — any change to the system
  // segment invalidates the entire prefix cache, so it must never be rewritten
  // mid-run as state changes.
  const planModeSection = planModeEnabled ? buildPlanModeSystemPromptSection() : "";
  // Plan mode runtime policy (turn-level instance): a bounded-escalation state
  // machine — termination predicate, round circuit breaker, repeated-call guard,
  // and post-run supplementary submission/fallback arbitration all converge here,
  // keeping the runner mode-agnostic.
  const planRunPolicy = planModeEnabled ? createPlanModeRunPolicy({ conversationId }) : null;
  const withAgentRuntimeContext = (context: Context): Context => {
    let systemPrompt = context.systemPrompt;
    if (planModeSection) {
      systemPrompt = appendSystemPrompt(systemPrompt, planModeSection);
    }
    if (rosterIdentitySection) {
      systemPrompt = appendSystemPrompt(systemPrompt, rosterIdentitySection);
    }
    if (parentMessageBusSnapshot) {
      systemPrompt = appendSystemPrompt(systemPrompt, parentMessageBusSnapshot);
    }
    if (frozenTaskListContext) {
      systemPrompt = appendSystemPrompt(systemPrompt, frozenTaskListContext);
    }
    // The trajectory runtime segment uses the same semantics as real injection:
    // it records only the parts actually concatenated into systemPrompt at this
    // moment; the builder skips empty segments, corresponding one-to-one with
    // the appendSystemPrompt conditions above.
    currentTrajectoryRuntimeContext = buildTrajectoryRuntimeContext([
      { source: "plan-mode", text: planModeSection },
      { source: "subagent-roster", text: rosterIdentitySection },
      { source: "parent-message-bus", text: parentMessageBusSnapshot },
      { source: "task-list", text: frozenTaskListContext },
    ]);
    return systemPrompt !== context.systemPrompt
      ? {
          ...context,
          systemPrompt,
        }
      : context;
  };
  const fileState = createFileToolState();
  const subagentScheduler = createSubagentScheduler();
  const runtimePlatform = await resolveRuntimePlatform();
  const buildRegistryStartedAt = perfNowMs();
  const safetyMode = commandSafetyMode ?? "auto";
  const builtinRegistry = await buildBuiltinToolRegistry({
    workdir: effectiveWorkdir,
    additionalRoots,
    providerId,
    runtimePlatform,
    fileState,
    sandbox: resolveShellSandboxSettings(safetyMode),
    taskStateStore,
    askUserQuestionConversationId: conversationId,
    planMode: planModeEnabled ? { conversationId } : undefined,
    toolSearch: { conversationId },
    currentConversationId: conversationId,
    referencedConversations,
    checkpoint: {
      conversationId,
      turnId: checkpointTurnId?.trim() || crypto.randomUUID(),
    },
    skillsEnabled: effectiveSkillsEnabled,
    skillsRootDir,
    skillAccessPolicy,
    onManagedSkillsChanged,
    runtimeScope: "chat",
    currentChatModel: selectedModel,
    getMcpSettings,
    applyMcpOps,
    remoteWebTunnelsEnabled,
    tunnelProjectPathKey: workspaceProjectPathKey(effectiveWorkdir),
    tunnelPublicBaseUrl,
    sshHosts,
    associatedSshHostIds,
    sshManagerRemoteAllowed,
    onSshSessionsChanged,
    onTunnelsChanged,
    cuaAllowSelfTargeting: getCuaAllowSelfTargeting?.() === true,
    onMcpLoadError: (message) => {
      const warning = `Failed to load MCP tools, skipping and continuing the conversation: ${message || "Unknown error"}`;
      console.warn(warning);
      updateToolStatus(warning, transcriptStore);
    },
    subagentRuntime: subagentStore
      ? {
          providerId,
          model,
          runtime,
          sessionId,
          templates: enabledSubagentTemplates(agentTemplates),
          store: subagentStore,
          scheduler: subagentScheduler,
        }
      : undefined,
  });
  finishAgentPerfSpan(conversationDebugLogger, "builtin_registry.build", buildRegistryStartedAt, {
    toolCount: builtinRegistry.tools.length,
    enabledMcpServerCount: selectEnabledMcpServers(getMcpSettings()).length,
  });
  // Tools whose policy is deny are simply not sent to the model: it saves tokens,
  // and the model will not fruitlessly attempt them only to be blocked. The deny
  // branch of resolveToolGate is kept as a fallback (in theory the model can no
  // longer see them, so it will not trigger).
  const toolPoliciesSnapshot = getToolPolicies?.();
  const combinedTools = builtinRegistry.tools.filter(
    (tool) =>
      resolveToolPolicy(
        tool.name,
        builtinRegistry.metadataByName.get(tool.name),
        toolPoliciesSnapshot,
      ) !== "deny",
  );

  // The tool execution rules segment (toolsSuffix) is concatenated into
  // systemPrompt by the runner at the provider boundary, while the context passed
  // to ledger/checkpoint estimation is before that. Without injecting this
  // estimate, the anchorless window after compaction (authoritative checkpoint
  // value + before the first real usage arrives) would systematically undercount
  // by ~4k, and the ring would jump as soon as the first usage arrives.
  // Reinject every round: it updates as the tool set changes, and text mode
  // overrides it to a small value.
  compaction.noteFixedOverheadTokens(
    estimateTextTokens(
      buildToolsSuffix(
        effectiveWorkdir,
        combinedTools.map((tool) => tool.name),
        runtimePlatform,
        additionalRoots,
      ),
    ),
  );

  const preCompactionStartedAt = perfNowMs();
  await compaction.maybeCompactPreSend({
    budgetContext: withAgentRuntimeContext(
      buildPreparedContext(getNextConversationState(), combinedTools, {
        includeUploadedFilesMetadata: true,
      }),
    ),
    tools: combinedTools,
    includeUploadedFilesMetadata: true,
  });
  finishAgentPerfSpan(
    conversationDebugLogger,
    "conversation.pre_compaction",
    preCompactionStartedAt,
    {
      toolCount: combinedTools.length,
    },
  );
  // Compaction boundary #1: pre-send compaction has already rebuilt the prefix,
  // so re-freezing here costs no extra hit rate. The bus snapshot is not
  // re-frozen here: it was frozen just milliseconds ago at the start of this
  // function, and pre-send compaction only rewrites history and systemPrompt, so
  // it cannot produce new bus messages; re-reading once would be a pure surplus
  // IPC.
  refreezeTaskListContext();

  // MCP lazy loading: inactive MCP tools do not enter the model request (the
  // runner re-evaluates this predicate every round, so once ToolSearch activates
  // one it is visible the next round); the execution layer keeps the full
  // registration.
  const requestToolFilter = builtinRegistry.mcpToolDeferralActive
    ? buildMcpRequestToolFilter({
        conversationId,
        metadataByName: builtinRegistry.metadataByName,
      })
    : undefined;

  const combinedExecutor: (
    toolCall: ToolCall,
    signal?: AbortSignal,
    context?: BuiltinToolExecutionContext,
  ) => Promise<Message> = (tc, signal, context) => {
    // Directly calling an inactive MCP business tool (the model relying on
    // history or guessing the exact name) is also allowed and activates it along
    // the way — the execution layer can find it anyway; activation ensures the
    // schema is visible in subsequent rounds' requests, sparing the model
    // confusion. The check matches requestToolFilter: only kind === "mcp" is a
    // deferred object (McpManager is not).
    const tcMetadata = builtinRegistry.metadataByName.get(tc.name);
    if (
      builtinRegistry.mcpToolDeferralActive &&
      tcMetadata?.groupId === "mcp" &&
      tcMetadata.kind === "mcp"
    ) {
      getMcpToolActivation(conversationId).add(tc.name);
    }
    return builtinRegistry.executeToolCall(tc, signal, context);
  };

  // Tool approval gate: adjudicates each call by the live policy. deny → block
  // directly; ask → suspend and wait for the user to decide on the chat approval
  // card (tools "remembered" for this conversation are exempt); allow → pass
  // through. When the command execution mode is ask, non-read-only tools are
  // escalated to ask regardless of policy (deny still blocks).
  const resolveToolGate = async (
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<{ allow: true } | { allow: false; reason: string }> => {
    const metadata = builtinRegistry.metadataByName.get(toolCall.name);
    // Plan mode fallback interception: the registry assembly layer has already
    // trimmed non-read-only tools (the model cannot see them); this branch only
    // catches the extreme case where a bypass such as seed recovery sends a write
    // call into the execution layer — its semantics must match the tool table.
    if (planModeEnabled && !isPlanModeAllowedTool(toolCall.name, metadata)) {
      return {
        allow: false,
        reason: `Plan mode is active: ${toolCall.name} is unavailable during planning. Research with read-only tools and submit the plan via ExitPlanMode.`,
      };
    }
    // Anti-spin guard: in plan mode, research calls repeated with the same
    // arguments beyond the allowed count are intercepted, and the interception
    // reason is returned as a toolResult to guide the model to stop re-reading
    // and submit its plan (Read's unchanged stub only saves tokens without
    // breaking the loop; this is the actual break point).
    if (planRunPolicy) {
      const repeatGate = planRunPolicy.guardRepeatedToolCall(toolCall);
      if (!repeatGate.allow) {
        return repeatGate;
      }
    }
    const policy = resolveToolPolicy(toolCall.name, metadata, getToolPolicies?.());
    if (policy === "deny") {
      return {
        allow: false,
        reason: `Tool ${toolCall.name} is forbidden by the user's permission policy (deny). Do not retry; if it is genuinely needed, ask the user to allow it in the tool permission settings.`,
      };
    }
    const effectivePolicy = safetyMode === "ask" && !metadata?.isReadOnly ? "ask" : policy;
    if (effectivePolicy !== "ask") {
      return { allow: true };
    }
    if (isSessionApproved(conversationId, toolCall.name)) {
      return { allow: true };
    }
    // The pending-approval marker must be delivered through the event stream, not
    // only via the runtime snapshot: approval suspends at beforeToolCall without
    // appending any chat event, so the snapshot's as_of_seq stays at the previous
    // tool_call event and would be discarded by the WebUI's "stale snapshots do
    // not roll back" seq gate (transcriptStore snapshot branch). Re-sending one
    // tool_call event obtains a new seq: while pending is registered the
    // arguments carry the marker → the remote renders the approval card; after it
    // settles, re-send another (pending now cleared) to overwrite back to no
    // marker → the card hides. On the desktop locally, the pending table drives
    // it reactively via useSyncExternalStore and does not depend on this event.
    const emitApprovalMarkerEvent = () => {
      if (!shouldShowToolEvent(toolCall)) return;
      gatewayBridgeEvents.queueEvent({
        type: "tool_call",
        id: toolCall.id,
        name: toolCall.name,
        arguments: buildGatewayToolCallPreviewArguments(toolCall),
        round: activeAgentRound,
        conversation_id: conversationId,
      });
    };
    // requestToolApproval synchronously registers pending before returning the
    // Promise, so the immediately following re-send can read pending and attach
    // the marker; settle deletes pending before resolving, so the re-send in
    // finally necessarily sees unmarked arguments.
    const approvalPromise = requestToolApproval({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      summary: summarizeToolCallForApproval(toolCall),
      conversationId,
      signal,
    });
    emitApprovalMarkerEvent();
    const settlement = await approvalPromise.finally(emitApprovalMarkerEvent);
    if (settlement.kind === "decided" && settlement.decision !== "deny") {
      return { allow: true };
    }
    const reason =
      settlement.kind === "timeout"
        ? `Approval for tool ${toolCall.name} was not confirmed by the user within the wait window, so it has been treated as denied. Do not retry.`
        : settlement.kind === "cancelled"
          ? `The user stopped this turn before approving ${toolCall.name}. Do not assume approval was granted.`
          : `The user rejected execution of tool ${toolCall.name}. Do not retry; use another approach or ask the user.`;
    return { allow: false, reason };
  };

  hookLifecycle.startAgent();
  let result: Awaited<ReturnType<typeof runAssistantWithTools>> | null = null;
  let latestAgentEmittedMessages: Message[] = [];
  let suppressedToolTrace: SuppressedToolTraceSnapshot[] = [];
  let activeAgentRound = 0;
  let pendingAgentContext: Context | null = null;
  const pendingTerminalAssistantMetaRef: {
    current: {
      assistant: AssistantMessage;
      round: number;
    } | null;
  } = {
    current: null,
  };

  function publishPersistableAgentProgress(
    round: number,
    assistant: AssistantMessage,
    toolResults: ToolResultMessage[],
  ) {
    const toolResultsById = new Map(
      toolResults.map((toolResult) => [toolResult.toolCallId, toolResult]),
    );
    const roundTrace = assistant.content
      .filter(
        (block): block is ToolCall =>
          block.type === "toolCall" &&
          block.name === AGENT_TOOL_NAME &&
          !isSubagentCardToolCall(block),
      )
      .map((toolCall) => ({
        round,
        toolCall,
        toolResult: toolResultsById.get(toolCall.id),
      }));

    suppressedToolTrace = [
      ...suppressedToolTrace.filter((item) => item.round !== round),
      ...roundTrace,
    ];
    updatePersistableAgentProgress({
      completedThroughRound: round,
      suppressedToolTrace: suppressedToolTrace.slice(),
    });
  }

  function clearPersistableAgentProgress() {
    suppressedToolTrace = [];
    updatePersistableAgentProgress({
      completedThroughRound: 0,
      suppressedToolTrace: [],
    });
  }

  // Rounds in this run where hosted search occurred. The usage of such rounds is
  // an aggregate of several internal server-side calls and cannot serve as a
  // context anchor; moreover, search finalization asynchronously replaces the
  // assistant message object, so detecting it by content block at commit time is
  // unreliable — it must be tracked explicitly here.
  const hostedSearchRounds = new Set<number>();

  function commitAssistantRoundMeta(
    assistant: AssistantMessage,
    round: number,
    options?: { contextRelevant?: boolean },
  ) {
    const contextRelevant = options?.contextRelevant !== false;
    const suppressUsageAnchors = hostedSearchRounds.has(round);
    if (contextRelevant) {
      compaction.observeContextMessages([assistant], { suppressUsageAnchors });
    }
    // The usage-ring anchor is not carried with events: both ends compute it on
    // the fly from meta's usage + stopReason (the shared layer's
    // assistantAnchorTokens); meta sends only raw facts.
    gatewayBridgeEvents.queueToken("", {
      round,
      provider: assistant.provider,
      model: assistant.model,
      api: assistant.api,
      stopReason: assistant.stopReason,
      usage: assistant.usage,
      ...(contextRelevant ? {} : { contextRelevant: false }),
    });
    batchLiveRoundsUpdate(
      (prev) =>
        updateLiveRound(prev, round, (target) => ({
          ...collapseThinking(target),
          meta: {
            provider: String(assistant.provider ?? ""),
            model: String(assistant.model ?? ""),
            api: String(assistant.api ?? ""),
            stopReason: String(assistant.stopReason ?? ""),
            usage: assistant.usage,
            contextRelevant,
          },
        })),
      transcriptStore,
    );
  }

  function updateHostedSearch(hostedSearch: HostedSearchBlock, round: number) {
    hostedSearchRounds.add(round);
    gatewayBridgeEvents.queueEvent({
      type: "hosted_search",
      id: hostedSearch.id,
      provider: hostedSearch.provider,
      status: hostedSearch.status,
      queries: hostedSearch.queries,
      sources: hostedSearch.sources,
      updatedAt: hostedSearch.updatedAt,
      round,
      conversation_id: conversationId,
    });
    batchLiveRoundsUpdate((prev) => {
      const withRound = prev.some((item) => item.round === round)
        ? prev
        : [
            ...prev,
            {
              key: `r${round}`,
              round,
              blocks: [],
              runningToolCallIds: [],
              thinkingOpen: false,
            },
          ];
      return updateLiveRound(withRound, round, (target) =>
        upsertHostedSearchToRound(collapseThinking(target), hostedSearch),
      );
    }, transcriptStore);
  }

  const pendingToolCallDeltas = new Map<string, { round: number; toolCall: ToolCall }>();
  let cancelPendingToolCallDeltaFlush: (() => void) | null = null;

  function toolCallDeltaKey(round: number, toolCallId: string) {
    return `${round}:${toolCallId}`;
  }

  function flushPendingToolCallDeltas() {
    cancelPendingToolCallDeltaFlush?.();
    cancelPendingToolCallDeltaFlush = null;
    if (pendingToolCallDeltas.size === 0) return;

    const deltas = Array.from(pendingToolCallDeltas.values());
    pendingToolCallDeltas.clear();

    for (const { round, toolCall } of deltas) {
      gatewayBridgeEvents.queueEvent({
        type: "tool_call_delta",
        id: toolCall.id,
        name: toolCall.name,
        arguments: buildGatewayToolCallPreviewArguments(toolCall),
        round,
        conversation_id: conversationId,
      });
    }

    batchLiveRoundsUpdate((prev) => {
      let next = prev;
      for (const { round, toolCall } of deltas) {
        next = updateLiveRound(next, round, (target) => {
          const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
          return markToolCallRunningInRound(withToolCall, toolCall);
        });
      }
      return next;
    }, transcriptStore);
  }

  function schedulePendingToolCallDeltaFlush() {
    if (cancelPendingToolCallDeltaFlush !== null) return;
    cancelPendingToolCallDeltaFlush = scheduleToolCallDeltaFlush(flushPendingToolCallDeltas);
  }

  function queueToolCallDelta(toolCall: ToolCall, round: number) {
    if (!shouldShowToolEvent(toolCall)) return;
    // The question card must be shown only after the question and options are
    // fully generated and the tool has actually started executing: streaming
    // increments and onToolCall only do internal bookkeeping, and both ends
    // uniformly publish the interactive card via onToolExecutionStart.
    if (toolCall.name === ASK_USER_QUESTION_TOOL_NAME) return;
    pendingToolCallDeltas.set(toolCallDeltaKey(round, toolCall.id), { round, toolCall });
    schedulePendingToolCallDeltaFlush();
  }

  function discardPendingToolCallDelta(toolCall: ToolCall, round: number) {
    pendingToolCallDeltas.delete(toolCallDeltaKey(round, toolCall.id));
    if (pendingToolCallDeltas.size === 0) {
      cancelPendingToolCallDeltaFlush?.();
      cancelPendingToolCallDeltaFlush = null;
    }
  }

  // The synthetic message pair produced by Plan mode's text fallback (assistant
  // toolCall + toolResult) is persisted in one shot with the final state; the
  // card is rendered from the persisted messages once the turn settles.
  let planFallbackMessages: Message[] = [];
  const lastVisibleAssistantText = (messages: readonly Message[]): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      const text = assistantMessageToText(message).trim();
      if (text) return text;
    }
    return "";
  };

  let midStreamProtectionDisabled = false;
  while (!result) {
    let streamedAgentText = "";
    let streamedAgentTokenUnits = 0;
    let protectionCheckChars = 0;
    let midStreamCompactionRequested = false;
    let sawToolCallInRound = false;
    const nativeWebSearchEnabled = runtime.nativeWebSearchEnabled !== false;
    const agentContext = withAgentRuntimeContext(
      pendingAgentContext ??
        buildPreparedContext(getNextConversationState(), combinedTools, {
          includeUploadedFilesMetadata: true,
        }),
    );
    pendingAgentContext = null;
    // The main request runs on a derived scope: mid-stream compaction aborts only
    // that scope, and a user stop (userStop) propagates down the chain at any
    // time, with no generation-switch window.
    const scope = cancellation.deriveScope();
    compaction.beginRequest(agentContext, getNextConversationState());
    try {
      const assistantRunStartedAt = perfNowMs();
      result = await runAssistantWithTools({
        providerId,
        model,
        runtime,
        failover: params.failover,
        runtimePlatform,
        context: agentContext,
        workdir: effectiveWorkdir,
        additionalRoots,
        sessionId,
        nativeWebSearch: nativeWebSearchEnabled,
        tools: combinedTools,
        subagentScheduler,
        executeToolCall: combinedExecutor,
        resolveToolGate,
        requestToolFilter,
        // Submitting the plan terminates this turn (conversational paradigm,
        // aligned with Codex): the plan is shown by a card and the user responds
        // with a message or button; there is no suspended wait and no closing
        // model round. tool_choice is normally auto (the policy forces it once
        // only in the supplementary submission round), and maxRounds is the
        // circuit breaker for runaway loops.
        resolveToolTermination: planRunPolicy?.resolveToolTermination,
        resolveToolChoice: planRunPolicy ? () => planRunPolicy.resolveToolChoice() : undefined,
        maxRounds: planRunPolicy?.maxRounds(),
        onRequestStart: ({ round, context, toolsSuffix }) => {
          const activeSources = new Set(
            currentTrajectoryRuntimeContext.entries.map((entry) => entry.source),
          );
          for (const source of lastRecordedRuntimeContextBySource.keys()) {
            if (!activeSources.has(source)) lastRecordedRuntimeContextBySource.delete(source);
          }
          for (const entry of currentTrajectoryRuntimeContext.entries) {
            if (lastRecordedRuntimeContextBySource.get(entry.source) === entry.text) continue;
            trajectory.noteContext(entry);
            lastRecordedRuntimeContextBySource.set(entry.source, entry.text);
          }

          const toolCatalog = serializeToolCatalog(context.tools);
          const segmentedHeader = {
            ...(params.readTrajectorySlots?.() ?? {}),
            ...(currentTrajectoryRuntimeContext.prompt === undefined
              ? {}
              : { runtime: currentTrajectoryRuntimeContext.prompt }),
            toolsSuffix,
            toolCatalog,
          };
          const actualSystemPrompt =
            typeof context.systemPrompt === "string" ? context.systemPrompt : undefined;
          const reconstructed = composeTrajectorySystemPrompt(segmentedHeader);
          const headerInput =
            actualSystemPrompt !== undefined && reconstructed !== actualSystemPrompt
              ? {
                  // Diagnostic fallback: preserve the exact provider-boundary prompt even if a
                  // future builder adds an unsegmented source. The warning makes the drift visible.
                  runtime: actualSystemPrompt,
                  toolCatalog,
                }
              : segmentedHeader;
          if (headerInput !== segmentedHeader) {
            console.warn(
              "[trajectory] segmented system prompt drifted from provider context; recording exact fallback",
            );
          }
          const headerId = trajectory.captureHeader(headerInput);
          trajectory.stepStart(round, headerId);
        },
        onTurnStart: (round) => {
          activeAgentRound = round;
          streamedAgentText = "";
          streamedAgentTokenUnits = 0;
          protectionCheckChars = 0;
          sawToolCallInRound = false;
          hookLifecycle.startTurn(round);
          batchLiveRoundsUpdate(
            (prev) => [
              ...prev,
              {
                key: `r${round}`,
                round,
                blocks: [],
                runningToolCallIds: [],
                thinkingOpen: false,
              },
            ],
            transcriptStore,
          );
        },
        onTextDelta: (delta, round) => {
          trajectory.firstToken(round);
          gatewayBridgeEvents.queueToken(delta, { round });
          streamedAgentText += delta;
          streamedAgentTokenUnits += estimateTextTokenUnits(delta);
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => {
                const nextTarget = collapseThinking(target);
                return appendTextDeltaToRound(nextTarget, delta);
              }),
            transcriptStore,
          );

          protectionCheckChars += delta.length;
          if (
            midStreamCompactionRequested ||
            midStreamProtectionDisabled ||
            sawToolCallInRound ||
            protectionCheckChars < 160
          ) {
            return;
          }

          protectionCheckChars = 0;
          // O(1) ledger check; only on trigger does it abort the local scope and
          // build the compaction input in catch.
          if (!compaction.shouldProtectMidStream(streamedAgentTokenUnits)) return;
          midStreamCompactionRequested = true;
          scope.controller.abort();
        },
        onThinkingDelta: (delta, round) => {
          // thinking also counts as the first token: a reasoning model's TTFT
          // lands here, and recognizing only text would misattribute the entire
          // reasoning time to decoding.
          trajectory.firstToken(round);
          gatewayBridgeEvents.queueEvent({
            type: "thinking",
            text: delta,
            round,
            conversation_id: conversationId,
          });
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => ({
                ...appendThinkingDeltaToRound(target, delta),
                thinkingOpen: true,
              })),
            transcriptStore,
          );
        },
        onHostedSearch: (hostedSearch, round) => {
          trajectory.firstToken(round);
          updateHostedSearch(hostedSearch, round);
        },
        onToolCall: (toolCall, round) => {
          trajectory.firstToken(round);
          sawToolCallInRound = true;
          discardPendingToolCallDelta(toolCall, round);
          // isRunning only means the tool has appeared in the current round; it
          // does not mean the question has entered the authoritative pending
          // table. The question card is delayed until onToolExecutionStart to
          // prevent the user from submitting before executeToolCall establishes
          // pending.
          if (toolCall.name === ASK_USER_QUESTION_TOOL_NAME) return;
          if (!shouldShowToolEvent(toolCall)) return;
          gatewayBridgeEvents.queueEvent({
            type: "tool_call",
            id: toolCall.id,
            name: toolCall.name,
            arguments: buildGatewayToolCallPreviewArguments(toolCall),
            round,
            conversation_id: conversationId,
          });
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => {
                const nextTarget = collapseThinking(target);
                const withToolCall = upsertToolCallToRound(nextTarget, toolCall);
                return markToolCallRunningInRound(withToolCall, toolCall);
              }),
            transcriptStore,
          );
        },
        onToolCallDelta: (toolCall, round) => {
          trajectory.firstToken(round);
          sawToolCallInRound = true;
          queueToolCallDelta(toolCall, round);
        },
        onToolExecutionStart: (toolCall, round) => {
          trajectory.firstToken(round);
          sawToolCallInRound = true;
          trajectory.toolStart(round, toolCall);
          discardPendingToolCallDelta(toolCall, round);
          if (!isSubagentCardToolCall(toolCall)) {
            hookLifecycle.toolExecutionStarted();
          }
          if (!shouldShowToolEvent(toolCall)) return;
          gatewayBridgeEvents.queueEvent({
            type: "tool_call",
            id: toolCall.id,
            name: toolCall.name,
            arguments: buildGatewayToolCallPreviewArguments(toolCall),
            round,
            conversation_id: conversationId,
          });
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => {
                const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
                return markToolCallRunningInRound(withToolCall, toolCall);
              }),
            transcriptStore,
          );
        },
        onToolResult: (toolCall, toolResult, round) => {
          if (toolResult.role !== "toolResult") return;
          trajectory.toolEnd(toolCall.id, {
            isError: toolResult.isError === true,
            ...(() => {
              const runIds = subagentRunIdsFromToolResult(toolResult);
              return runIds.length === 0 ? {} : { subagentRunIds: runIds };
            })(),
          });
          compaction.observeContextMessages([toolResult]);
          discardPendingToolCallDelta(toolCall, round);
          if (!isSubagentCardToolCall(toolCall)) {
            hookLifecycle.toolResultReceived(round);
          }
          if (!shouldShowToolEvent(toolCall, toolResult)) return;
          gatewayBridgeEvents.queueEvent({
            type: "tool_result",
            id: toolCall.id,
            name: toolCall.name,
            arguments: buildGatewayToolCallPreviewArguments(toolCall),
            content: toolResult.content,
            details: toolResult.details,
            isError: toolResult.isError ?? false,
            round,
            conversation_id: conversationId,
          });
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => {
                const tr: ToolResultMessage = toolResult as ToolResultMessage;
                const nextTarget = attachToolResultToRound(collapseThinking(target), toolCall, tr);

                return {
                  ...nextTarget,
                  runningToolCallIds: (nextTarget.runningToolCallIds || []).filter(
                    (id) => id !== toolCall.id,
                  ),
                };
              }),
            transcriptStore,
          );
        },
        onAssistantMessage: (assistant, round) => {
          if (assistant.role !== "assistant") return;
          // Some transports only surface a final message (no incremental text/tool callback).
          trajectory.firstToken(round);
          // stepEnd is recorded here rather than after tool execution: this way
          // the step duration is pure model time, tools each have their own
          // interval, and on the Gantt chart tool time is not double-counted into
          // the model lane.
          const trajectoryUsage = toTrajectoryUsage(assistant.usage);
          const terminalInfo = trajectoryTerminalInfo(assistant);
          trajectory.stepEnd(round, {
            ...terminalInfo,
            ...(trajectoryUsage === undefined ? {} : { usage: trajectoryUsage }),
            provider: assistant.provider || providerId,
            model: assistant.model || model,
            ...(assistant.api ? { api: assistant.api } : {}),
            ...(typeof assistant.stopReason === "string"
              ? { stopReason: assistant.stopReason }
              : {}),
          });
          hookLifecycle.ensureMessageEnded();
          const toolCallCount = assistant.content.filter(
            (block) => block.type === "toolCall",
          ).length;
          hookLifecycle.assistantMessageCompleted(round, toolCallCount);
          if (toolCallCount === 0 && assistant.stopReason !== "toolUse") {
            pendingTerminalAssistantMetaRef.current = { assistant, round };
            return;
          }
          commitAssistantRoundMeta(assistant, round);
        },
        onToolStatus: (s) => {
          gatewayBridgeEvents.queueToolStatus(s, false);
          updateToolStatus(s, transcriptStore);
        },
        onRetryAttempts: (_round, attempts) => {
          const latest = attempts.at(-1);
          if (latest !== undefined) {
            trajectory.noteRetry(activeAgentRound, {
              attempt: latest.attempt,
              // RetryAttemptRecord.maxAttempts already stores the retry budget —
              // the initial attempt was subtracted before the withStreamRetry
              // callback is passed in (same semantics as the m in the status hint
              // "(n/m)"), so it is recorded directly.
              maxRetries: latest.maxAttempts,
              ...(latest.plannedDelayMs === undefined ? {} : { delayMs: latest.plannedDelayMs }),
              ...(latest.errorMessage === "" ? {} : { error: latest.errorMessage }),
              ...(latest.providerLabel === undefined ? {} : { provider: latest.providerLabel }),
            });
          }
          updateRetryAttempts(attempts, transcriptStore);
        },
        onFailoverAttempt: (_round, event) => {
          trajectory.noteFailover(activeAgentRound, {
            attempt: event.attempt,
            fromLabel: event.fromLabel,
            toLabel: event.toLabel,
            targetIndex: event.targetIndex,
            ...(event.errorMessage === "" ? {} : { error: event.errorMessage }),
          });
        },
        onTransportAttempt: (_round, snapshot) => {
          trajectory.noteTransport(activeAgentRound, {
            provider: snapshot.providerLabel,
            ...(snapshot.upstreamOrigin === undefined
              ? {}
              : { upstreamOrigin: snapshot.upstreamOrigin }),
            useSystemProxy: snapshot.useSystemProxy,
            fullUrl: snapshot.fullUrl,
            headerNames: snapshot.headerNames,
          });
        },
        onBeforeNextTurn: async ({ round, assistant, toolResults, emittedMessages }) => {
          publishPersistableAgentProgress(round, assistant, toolResults);
          latestAgentEmittedMessages = emittedMessages.slice();
          const tempState = appendMessagesToConversation(
            getNextConversationState(),
            emittedMessages,
          );
          const tempContext = withAgentRuntimeContext(
            buildPreparedContext(tempState, combinedTools, {
              includeUploadedFilesMetadata: true,
            }),
          );
          // Tail delivery: the bus snapshot and roster identity segment in
          // systemPrompt are already frozen; newly arrived bus messages within the
          // run and the advanced roster runtime state are merged into **one and
          // the same** block handed to the runner as wireTailText — after
          // accumulation the runner attaches it only to each outbound request, so
          // agent runtime state and emittedMessages never contain it and it does
          // not leak into persistence, the UI, or memory extraction.
          const busDelta = await buildParentMessageBusDelta();
          const rosterRunStatusDelta = buildRosterRunStatusDelta();
          const tailBlockText = [busDelta.text, rosterRunStatusDelta].filter(Boolean).join("\n\n");
          // Anchor probe: only determines whether the tail block can be safely
          // attached right now (an anchor parsed = attachable), without rewriting
          // tempContext.messages itself. The actual attachment and anchor pinning
          // happen on the runner side.
          const tailBlockAttachable =
            Boolean(tailBlockText) && resolveTailBlockAnchorId(tempContext.messages) !== null;
          const { context: compactedContext } = await compaction.compactDuringRun({
            trigger: "post-tool",
            state: tempState,
            budgetContext: tempContext,
            tools: combinedTools,
            includeUploadedFilesMetadata: true,
          });
          if (!compactedContext) {
            // Returns null when there is no increment: no extra content is
            // produced and the runtime state resumes as-is.
            if (!tailBlockAttachable) {
              return null;
            }
            // The cursor and baseline advance only once attachment is confirmed;
            // when there is no safe anchor, retry the next round to avoid losing
            // content.
            renderedBusSeq = busDelta.lastSeq;
            if (rosterRunStatusDelta) {
              renderedRosterRunStatus = rosterRunStatusDelta;
            }
            return {
              context: tempContext,
              emittedMessages,
              wireTailText: tailBlockText,
            };
          }
          latestAgentEmittedMessages = [];
          clearPersistableAgentProgress();
          // Compaction boundary #2: re-freeze after in-run compaction, which must
          // happen before the resume context is assembled below.
          refreezeTaskListContext();
          // Compaction truncates history, and the tail-delivered content
          // accumulated in the runner is also cleared because this override
          // carries no wireTailText, so it must be re-frozen together with the
          // cursor; otherwise those messages would be neither in the snapshot nor
          // delivered again.
          await refreezeParentMessageBus();
          // Likewise: the delivery baseline for the mutable roster segment is
          // invalidated too, and after resetting it is re-delivered the next
          // round.
          renderedRosterRunStatus = "";
          return {
            context: withAgentRuntimeContext(compactedContext),
            emittedMessages: [],
          };
        },
        signal: scope.controller.signal,
        debugLogger: conversationDebugLogger,
      });
      finishAgentPerfSpan(
        conversationDebugLogger,
        "assistant.run_with_tools",
        assistantRunStartedAt,
        {
          emittedMessageCount: result.emittedMessages.length,
          messageCount: result.messages.length,
        },
      );

      // Plan mode bounded escalation: when the run ends normally but ExitPlanMode
      // was never submitted, first nudge with one supplementary submission round;
      // if still unsubmitted, the final assistant text is registered as a pending
      // plan as a fallback. Each step runs at most once, so the turn necessarily
      // converges in a bounded number of steps.
      if (planRunPolicy) {
        const decision = planRunPolicy.decideAfterRun({
          emittedMessages: result.emittedMessages,
        });
        if (decision.kind === "nudge") {
          // Aligned with mid-stream compaction's loop-reentry paradigm: first
          // commit this run's messages into the conversation state and reset the
          // live round (avoiding round key conflicts and double rendering after
          // reentry), then resume with a wire-only reminder. The reminder goes
          // only into outbound requests — it is not appended to conversation
          // state, not persisted, and does not enter the UI or memory extraction.
          const interimState = appendMessagesToConversation(
            getNextConversationState(),
            result.emittedMessages,
          );
          latestAgentEmittedMessages = [];
          applyConversationState(interimState);
          clearPersistableAgentProgress();
          resetLiveTranscript(transcriptStore);
          const preparedContext = buildPreparedContext(interimState, combinedTools, {
            includeUploadedFilesMetadata: true,
          });
          pendingAgentContext = {
            ...preparedContext,
            messages: [
              ...preparedContext.messages,
              {
                role: "user",
                content: [{ type: "text", text: decision.reminderText }],
                timestamp: Date.now(),
              },
            ],
          };
          result = null;
        } else if (decision.kind === "fallback") {
          const fallback = planRunPolicy.registerFallbackPlan({
            planText: lastVisibleAssistantText(result.messages),
          });
          if (fallback) {
            // The synthetic ExitPlanMode call pair is appended to the final
            // history: protocol-consistent (assistant toolCall + toolResult),
            // reusing the plan card and approval chain with zero changes; usage is
            // set to zero so it does not pollute usage statistics.
            planFallbackMessages = [
              {
                role: "assistant",
                content: [fallback.toolCall],
                api: runtimeModel.api,
                provider: runtimeModel.provider,
                model: runtimeModel.id,
                usage: createEmptyAssistantUsage(),
                stopReason: "toolUse",
                timestamp: fallback.toolResult.timestamp,
              } satisfies AssistantMessage,
              fallback.toolResult,
            ];
          }
        }
      }
    } catch (error) {
      if (!midStreamCompactionRequested) {
        throw error;
      }

      hookLifecycle.ensureMessageEnded();
      if (activeAgentRound > 0) {
        hookLifecycle.endTurn(activeAgentRound);
      }
      resetLiveTranscript(transcriptStore);

      const partialAssistant = buildPartialAssistantMessage({
        model: runtimeModel,
        text: streamedAgentText,
        stopReason: "aborted",
      });
      const tempState = appendMessagesToConversation(getNextConversationState(), [
        ...latestAgentEmittedMessages,
        ...(partialAssistant ? [partialAssistant] : []),
      ]);
      latestAgentEmittedMessages = [];
      applyConversationState(tempState);
      clearPersistableAgentProgress();

      const compactionResult = await compaction.compactDuringRun({
        trigger: "mid-stream",
        state: tempState,
        budgetContext: withAgentRuntimeContext(
          buildPreparedContext(tempState, combinedTools, {
            includeAbortedMessages: true,
            includeUploadedFilesMetadata: true,
          }),
        ),
        tools: combinedTools,
        includeAbortedMessages: true,
        includeUploadedFilesMetadata: true,
      });

      if (!compactionResult.context) {
        throw new Error("Mid-stream compaction did not provide a continuation context.");
      }
      // Compaction boundary #3: re-freeze after mid-stream compaction; the resume
      // context reads the frozen value only when withAgentRuntimeContext wraps
      // pendingAgentContext in the next loop iteration.
      refreezeTaskListContext();
      await refreezeParentMessageBus();
      renderedRosterRunStatus = "";
      pendingAgentContext = compactionResult.context;
      if (compactionResult.shouldDisableProtection) {
        midStreamProtectionDisabled = true;
      }
    } finally {
      scope.release();
    }
  }

  const assistantStopReason = result.assistant.stopReason;
  if (
    isAbortedAssistantMessage(result.assistant) ||
    isAbortedAssistantMessage(result.messages[result.messages.length - 1])
  ) {
    if (commitVisibleAbortedConversation()) {
      return;
    }
    throw new Error("Cancelled");
  }

  const finalState = appendMessagesToConversation(getNextConversationState(), [
    ...result.emittedMessages,
    ...planFallbackMessages,
  ]);
  let completedState = finalState;
  const gatewayAssistantText = assistantMessageToText(result.assistant);
  if (!gatewayBridgeEvents.hasForwardedText() && gatewayAssistantText.length > 0) {
    gatewayBridgeEvents.queueToken(gatewayAssistantText, {
      round: activeAgentRound || 1,
    });
  }
  const shouldRunMemoryExtraction =
    assistantStopReason !== "error" && assistantStopReason !== "aborted";
  const memoryRoundOffset = Math.max(
    activeAgentRound || pendingTerminalAssistantMetaRef.current?.round || 1,
    1,
  );

  const runPostTurnMemoryExtraction = (visibleEvents?: MemoryExtractionVisibleEvents) => {
    const currentMemoryExtractionModel: MemoryExtractionModelConfig = {
      providerId,
      model,
      runtime,
      selectedModel,
    };
    // The controller owns the extraction scope and links this stable turn-level
    // userStop signal, so request-scope churn cannot detach cancellation.
    return memoryExtraction.requestExtraction({
      primary: memoryExtractionModel ?? currentMemoryExtractionModel,
      fallback: memoryExtractionModel ? currentMemoryExtractionModel : undefined,
      onPrimaryFailure: memoryExtractionModel ? onMemoryExtractionModelFailure : undefined,
      sessionId,
      conversationId,
      workdir: conversationCwd ?? effectiveWorkdir,
      // The extraction sub-model must see exactly what the user said: the memory
      // incremental block only serves the main model's cache, and mixing it in
      // would treat index lines as user utterances, both breaking the
      // short-message gate and inducing duplicate writes.
      messages: buildPreparedContext(finalState, undefined, { includeMemoryTurnUpdates: false })
        .messages,
      statusText: memoryExtractionStatusText,
      signal: cancellation.userStop.signal,
      debugLogger: conversationDebugLogger,
      visibleEvents,
    });
  };

  const persistCompletedState = (state: ConversationViewState) =>
    persistConversationWithHistorySync({
      conversationId,
      sessionId,
      providerId,
      model,
      cwd: conversationCwd,
      state,
      fallbackTitle,
      createdAt,
      titlePromise,
    });

  const pendingTerminalAssistantMeta = pendingTerminalAssistantMetaRef.current;
  if (pendingTerminalAssistantMeta) {
    commitAssistantRoundMeta(
      pendingTerminalAssistantMeta.assistant,
      pendingTerminalAssistantMeta.round,
    );
  }
  hookLifecycle.endAgent();

  applyConversationState(finalState);
  freezeGatewayFinalProjection(finalState, true);
  settleLiveTranscript(transcriptStore);
  const historyPersisted = await persistCompletedState(finalState);
  trajectory.endTurn(
    pendingTerminalAssistantMeta === null
      ? { status: "complete" }
      : trajectoryTerminalInfo(pendingTerminalAssistantMeta.assistant),
  );
  // Persistence aligns with history writing: the turn boundary is the ledger's
  // consistency point, and memory extraction after it does not belong to this
  // turn's trajectory.
  await trajectory.flush();

  // Memory extraction reads the in-memory final state. Only run it after the
  // durable history write succeeds so we never keep "memory has the answer,
  // chat history only has the user prompt" after a failed final persist.
  if (historyPersisted && showSilentMemoryExtraction && shouldRunMemoryExtraction) {
    const extraction = await runPostTurnMemoryExtraction({
      roundOffset: memoryRoundOffset,
      onTurnStart: (round) => {
        gatewayBridgeEvents.queueToken("", { round, contextRelevant: false });
        batchLiveRoundsUpdate(
          (prev) => [
            ...prev,
            {
              key: `r${round}`,
              round,
              blocks: [],
              meta: { contextRelevant: false },
              runningToolCallIds: [],
              thinkingOpen: false,
            },
          ],
          transcriptStore,
        );
      },
      onTextDelta: (delta, round) => {
        gatewayBridgeEvents.queueToken(delta, { round });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) =>
              appendTextDeltaToRound(collapseThinking(target), delta),
            ),
          transcriptStore,
        );
      },
      onThinkingDelta: (delta, round) => {
        gatewayBridgeEvents.queueEvent({
          type: "thinking",
          text: delta,
          round,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => ({
              ...appendThinkingDeltaToRound(target, delta),
              thinkingOpen: true,
            })),
          transcriptStore,
        );
      },
      onToolCall: (toolCall, round) => {
        if (!shouldShowToolEvent(toolCall)) return;
        gatewayBridgeEvents.queueEvent({
          type: "tool_call",
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          round,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => {
              const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
              return markToolCallRunningInRound(withToolCall, toolCall);
            }),
          transcriptStore,
        );
      },
      onToolExecutionStart: (toolCall, round) => {
        if (!shouldShowToolEvent(toolCall)) return;
        gatewayBridgeEvents.queueEvent({
          type: "tool_call",
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          round,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => {
              const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
              return markToolCallRunningInRound(withToolCall, toolCall);
            }),
          transcriptStore,
        );
      },
      onToolResult: (toolCall, toolResult, round) => {
        if (!shouldShowToolEvent(toolCall)) return;
        gatewayBridgeEvents.queueEvent({
          type: "tool_result",
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          content: toolResult.content,
          details: toolResult.details,
          isError: toolResult.isError ?? false,
          round,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => {
              const nextTarget = attachToolResultToRound(
                collapseThinking(target),
                toolCall,
                toolResult,
              );

              return {
                ...nextTarget,
                runningToolCallIds: (nextTarget.runningToolCallIds || []).filter(
                  (id) => id !== toolCall.id,
                ),
              };
            }),
          transcriptStore,
        );
      },
      onAssistantMessage: (assistant, round) =>
        commitAssistantRoundMeta(assistant, round, { contextRelevant: false }),
      onToolStatus: (s) => {
        gatewayBridgeEvents.queueToolStatus(s, false);
        updateToolStatus(s, transcriptStore);
      },
    });
    if (extraction.emittedMessages.length > 0) {
      completedState = appendRenderOnlyMessagesToConversation(
        finalState,
        extraction.emittedMessages,
      );
    }
  }
  if (completedState !== finalState) {
    applyConversationState(completedState);
    freezeGatewayFinalProjection(completedState, true);
    settleLiveTranscript(transcriptStore);
    await persistCompletedState(completedState);
  }
  if (historyPersisted && !showSilentMemoryExtraction && shouldRunMemoryExtraction) {
    void runPostTurnMemoryExtraction();
  }
}
