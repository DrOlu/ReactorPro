import { Agent, type AgentContext, type AgentTool } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Message,
  ModelThinkingLevel,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  appendHostedSearchBlocksToAssistant,
  type HostedSearchBlock,
  type HostedSearchOrderedBlock,
  mergeHostedSearchBlocks,
} from "@liveagent/ui/lib/chat/hostedSearch";
import type { PreparedProxyRequest } from "@liveagent/ui/lib/providers/proxy";
import { buildStreamRequestDebugPayload, type StreamDebugLogger } from "../../debug/agentDebug";
import { capturePrefixShape, comparePrefixShape } from "../../debug/prefixCacheShape";
import { readPreviousPrefixShape, recordPrefixShape } from "../../debug/prefixShapeStore";
import {
  createHostedSearchEventAggregator,
  createHostedSearchProbeId,
  startHostedSearchFetchProbe,
  withHostedSearchProbeHeader,
} from "../../providers/hostedSearchEvents";
import {
  buildProviderRequestMetadata,
  createModelFromConfig,
  createStreamingTextReconciler,
  describeProviderCacheShape,
  finalizeProviderStreamOptions,
  llm,
  normalizeErrorMessage,
  type ProviderRuntimeConfig,
  prepareProviderRequest,
  resolveProviderCacheRetention,
  type StreamOptionsEx,
  type ToolChoice,
  toSimpleStreamReasoning,
} from "../../providers/llm";
import {
  buildProviderNativeWebFetchBridgeResult,
  buildProviderNativeWebSearchBridgeResult,
  HIDDEN_PROVIDER_NATIVE_WEB_FETCH_TOOL_NAMES,
  HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES,
  isProviderNativeWebFetchToolName,
  isProviderNativeWebSearchToolName,
} from "../../providers/nativeWebSearch";
import { sanitizeAssistantMessage } from "../../providers/runtime/messageUtils";
import {
  failoverBreakerKey,
  type ModelFailoverRuntimeConfig,
  type ProviderFailoverCandidate,
  withProviderFailover,
} from "../../providers/runtime/providerFailover";
import { resolveStreamRetryConfig } from "../../providers/runtime/retryPolicy";
import type { RetryAttemptRecord } from "../../providers/runtime/streamRetry";
import {
  captureTransportSnapshot,
  type TransportSnapshot,
} from "../../providers/runtime/transportSnapshot";
import type { RuntimePlatform } from "../../runtimePlatform";
import type { ProviderId, ReasoningLevel, SelectedModel } from "../../settings";
import { createSubagentScheduler, type SubagentScheduler } from "../../subagents/scheduler";
import { withPowerActivity } from "../../system/powerActivity";
import type { AdditionalProjectRoot } from "../../tools/additionalProjectRoots";
import {
  attachPinnedTailBlocks,
  type PinnedTailBlock,
  resolveTailBlockAnchorId,
} from "../context/contextTailBlock";
import { sanitizeContextForModelRequest } from "../context/requestContextSanitizer";
import { summarizeToolCall } from "../messages/uiMessages";
import {
  createDeferredProviderNativeWebSearchStatus,
  resolveProviderNativeWebSearchStatus,
} from "../search/providerNativeSearchStatus";
import {
  comparableToolCall,
  recoverAssistantSeedToolCalls,
  stripSeedToolCallMarkup,
} from "./seedToolCalls";
import { wrapStreamWithToolCallArgumentGuard } from "./toolCallArgumentGuard";
import { buildToolsSuffix } from "./toolExecutionPrompt";

export { buildToolsSuffix } from "./toolExecutionPrompt";

function throwIfRunnerCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Cancelled");
  }
}

function createLinkedAbortSignal(signals: Array<AbortSignal | undefined>): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const activeSignals = Array.from(
    new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal))),
  );
  if (activeSignals.length <= 1) {
    return { signal: activeSignals[0], cleanup: () => undefined };
  }

  const controller = new AbortController();
  const cleanupFns: Array<() => void> = [];
  const cleanup = () => {
    while (cleanupFns.length > 0) {
      cleanupFns.pop()?.();
    }
  };
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    cleanup();
  };

  for (const sourceSignal of activeSignals) {
    if (sourceSignal.aborted) {
      abort();
      break;
    }
    sourceSignal.addEventListener("abort", abort, { once: true });
    cleanupFns.push(() => sourceSignal.removeEventListener("abort", abort));
  }

  return { signal: controller.signal, cleanup };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];

  const limit = Math.max(1, Math.floor(concurrency || 1));
  const results: R[] = new Array(n);
  let nextIndex = 0;

  async function runLoop() {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= n) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const runners = new Array(Math.min(limit, n)).fill(0).map(() => runLoop());
  await Promise.all(runners);
  return results;
}

function toolNameLookupKey(name: string) {
  return name.trim().toLowerCase();
}

function buildToolNameCanonicalizer(tools: readonly { name: string }[]) {
  const canonicalByKey = new Map<string, string | null>();
  for (const tool of tools) {
    const key = toolNameLookupKey(tool.name);
    if (!key) continue;
    const existing = canonicalByKey.get(key);
    if (existing === undefined) {
      canonicalByKey.set(key, tool.name);
    } else if (existing !== tool.name) {
      canonicalByKey.set(key, null);
    }
  }

  return (name: string) => {
    const canonical = canonicalByKey.get(toolNameLookupKey(name));
    return canonical ?? name;
  };
}

function normalizeToolCallName(toolCall: ToolCall, canonicalizeToolName: (name: string) => string) {
  const canonicalName = canonicalizeToolName(toolCall.name);
  if (canonicalName === toolCall.name) return toolCall;
  return {
    ...toolCall,
    name: canonicalName,
  };
}

function normalizeAssistantToolCallNames(
  assistant: AssistantMessage,
  canonicalizeToolName: (name: string) => string,
) {
  let changed = false;
  const nextContent = assistant.content.map((block) => {
    if (block.type !== "toolCall") return block;
    const nextBlock = normalizeToolCallName(block, canonicalizeToolName);
    if (nextBlock !== block) changed = true;
    return nextBlock;
  });

  if (changed) {
    assistant.content = nextContent;
  }
  return assistant;
}

function getComparableCanonicalToolCall(
  toolCall: ToolCall,
  canonicalizeToolName: (name: string) => string,
) {
  return comparableToolCall(normalizeToolCallName(toolCall, canonicalizeToolName));
}

function dedupeRecoveredToolCallsAgainstExisting(params: {
  existingAssistant: AssistantMessage;
  recoveredToolCalls: ToolCall[];
  canonicalizeToolName: (name: string) => string;
}) {
  const seen = new Set(
    params.existingAssistant.content
      .filter((block): block is ToolCall => block.type === "toolCall")
      .map((toolCall) => getComparableCanonicalToolCall(toolCall, params.canonicalizeToolName)),
  );
  const uniqueToolCalls: ToolCall[] = [];
  const duplicateToolCallIds = new Set<string>();

  for (const toolCall of params.recoveredToolCalls) {
    const normalizedToolCall = normalizeToolCallName(toolCall, params.canonicalizeToolName);
    const comparable = comparableToolCall(normalizedToolCall);
    if (seen.has(comparable)) {
      duplicateToolCallIds.add(normalizedToolCall.id);
      continue;
    }
    seen.add(comparable);
    uniqueToolCalls.push(normalizedToolCall);
  }

  return {
    uniqueToolCalls,
    duplicateToolCallIds,
  };
}

function buildSystemPrompt(base: string | undefined, suffix: string) {
  const head = (base || "").trim();
  if (!head) return suffix;
  return `${head}\n\n${suffix}`;
}

function toSyntheticToolCall(params: {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}): ToolCall {
  return {
    type: "toolCall",
    id: params.id,
    name: params.name,
    arguments: params.arguments ?? {},
  };
}

function toAssistantThinkingLevel(params: {
  providerId: ProviderId;
  reasoning?: ReasoningLevel;
  api: string;
}): ModelThinkingLevel {
  if (params.providerId === "claude_code") {
    return params.reasoning && params.reasoning !== "off" ? params.reasoning : "off";
  }
  if (params.providerId === "gemini") {
    if (!params.reasoning || params.reasoning === "off") return "off";
    return params.reasoning === "xhigh" || params.reasoning === "max" ? "high" : params.reasoning;
  }
  if (params.api !== "openai-responses" && params.api !== "openai-completions") {
    return "off";
  }
  return params.reasoning && params.reasoning !== "off" ? params.reasoning : "off";
}

function normalizeStreamReasoning(value: unknown): StreamOptionsEx["reasoning"] | undefined {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return undefined;
  }
}

function getAssistantToolCalls(assistant: AssistantMessage): ToolCall[] {
  return assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function findConsecutiveToolGroup(
  assistant: AssistantMessage,
  toolCallId: string,
  toolName: string,
): ToolCall[] | null {
  const toolCalls = getAssistantToolCalls(assistant);
  const idx = toolCalls.findIndex((call) => call.id === toolCallId);
  if (idx < 0 || toolCalls[idx].name !== toolName) return null;

  let start = idx;
  while (start > 0 && toolCalls[start - 1].name === toolName) start -= 1;

  let end = idx;
  while (end + 1 < toolCalls.length && toolCalls[end + 1].name === toolName) end += 1;

  return toolCalls.slice(start, end + 1);
}

function buildParallelToolBatchKey(group: ToolCall[]) {
  return group.map((call) => call.id).join("|");
}

type ParallelToolBatch = {
  toolName: string;
  toolCalls: ToolCall[];
  started: boolean;
  announced: boolean;
  resultPromises: Map<string, Promise<ToolResultMessage>>;
};

function getParallelToolBatch(
  toolCallId: string,
  parallelBatchKeyByToolCallId: Map<string, string>,
  parallelToolBatches: Map<string, ParallelToolBatch>,
) {
  const batchKey = parallelBatchKeyByToolCallId.get(toolCallId);
  if (!batchKey) return null;
  return parallelToolBatches.get(batchKey) ?? null;
}

function getParallelToolBatchStatus(batch: ParallelToolBatch) {
  if (batch.toolName === "Bash") {
    return `Running ${batch.toolCalls.length} Bash commands in parallel...`;
  }
  if (batch.toolName === "Agent") {
    return `Running ${batch.toolCalls.length} Agent calls in parallel...`;
  }
  return `Running ${batch.toolCalls.length} ${batch.toolName} calls in parallel...`;
}

function toMessageToolResult(message: Message, toolCall: ToolCall): ToolResultMessage {
  if (message.role === "toolResult") return message;
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: "Tool did not return a toolResult message" }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

type TurnContextOverride = {
  context: Context;
  emittedMessages: Message[];
  /**
   * Tail text delivered only with outbound requests (volatile content such as bus deltas and
   * roster running status). Not written into agent.state.messages: doing so would leak through
   * emittedMessages into persistence, the UI, and memory extraction. The runner accumulates it and
   * re-attaches it on every outbound request.
   */
  wireTailText?: string;
} | null;

type ToolExecutionEventContext = {
  parentToolCall: ToolCall;
  subagentScheduler: SubagentScheduler;
  emitToolCall: (toolCall: ToolCall) => void;
  emitToolExecutionStart: (toolCall: ToolCall) => void;
  emitToolResult: (toolCall: ToolCall, toolResult: ToolResultMessage) => void;
  emitToolStatus: (status: string | null) => void;
};

function getAgentMessages(agent: Agent | null): Message[] {
  return agent ? (agent.state.messages as Message[]) : [];
}

function getMessagesSinceBaseline(agent: Agent | null, baselineIndex: number): Message[] {
  const messages = getAgentMessages(agent);
  if (baselineIndex <= 0) return messages.slice();
  if (baselineIndex >= messages.length) return [];
  return messages.slice(baselineIndex);
}

function findLastAssistantMessage(messages: Message[]): AssistantMessage | null {
  return (
    [...messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant") ?? null
  );
}

export type AgentRunnerFailoverTarget = {
  /** Stable identity used for breaker keys and switch callbacks. */
  selectedModel: SelectedModel;
  providerId: ProviderId;
  model: string;
  /** Display label, e.g. "PackyCode · claude-sonnet-4-5". */
  label: string;
  runtime: ProviderRuntimeConfig;
};

export type AgentRunnerFailoverSwitchEvent = {
  /** The fallback target now active, or null when back on the primary. */
  target: AgentRunnerFailoverTarget | null;
  round: number;
  errorMessage: string;
};

export type AgentRunnerFailoverParams = {
  config: ModelFailoverRuntimeConfig;
  /** Identity of the primary target described by params.providerId/model/runtime. */
  primary: { selectedModel?: SelectedModel; label: string };
  /** Fallback targets in failover-queue order, primary duplicates removed. */
  fallbacks: AgentRunnerFailoverTarget[];
  /** Fired when a round commits on a different target than the previous rounds. */
  onSwitched?: (event: AgentRunnerFailoverSwitchEvent) => void;
};

export async function runAssistantWithTools(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  failover?: AgentRunnerFailoverParams;
  runtimePlatform?: RuntimePlatform;
  context: Context;
  workdir: string;
  /** Structured file-tool roots, also documented in the generated tool prompt. */
  additionalRoots?: readonly AdditionalProjectRoot[];
  sessionId?: string;
  nativeWebSearch?: boolean;
  tools: Context["tools"];
  executeToolCall: (
    toolCall: ToolCall,
    signal?: AbortSignal,
    context?: ToolExecutionEventContext,
  ) => Promise<Message>;
  /** Exact sanitized context immediately before a provider request starts. */
  onRequestStart?: (info: { round: number; context: Context; toolsSuffix: string }) => void;
  onTurnStart?: (round: number) => void;
  onTextDelta: (delta: string, round: number) => void;
  onThinkingDelta?: (delta: string, round: number) => void;
  onToolCall?: (toolCall: ToolCall, round: number) => void;
  onToolCallDelta?: (toolCall: ToolCall, round: number) => void;
  onHostedSearch?: (hostedSearch: HostedSearchBlock, round: number) => void;
  onToolExecutionStart?: (toolCall: ToolCall, round: number) => void;
  onToolResult?: (toolCall: ToolCall, toolResult: Message, round: number) => void;
  onAssistantMessage?: (assistant: Message, round: number) => void;
  onBeforeNextTurn?: (params: {
    round: number;
    assistant: AssistantMessage;
    toolResults: ToolResultMessage[];
    runtimeContext: Context;
    emittedMessages: Message[];
    signal?: AbortSignal;
  }) => Promise<{
    context: Context;
    emittedMessages: Message[];
    wireTailText?: string;
  } | null>;
  onToolStatus?: (status: string | null) => void;
  onRetryAttempts?: (round: number, attempts: RetryAttemptRecord[]) => void;
  /** On every cross-provider switch (including skipping a primary whose circuit breaker is open). targetIndex is the stable candidate index (0 = primary). */
  onFailoverAttempt?: (
    round: number,
    event: {
      attempt: number;
      fromLabel: string;
      toLabel: string;
      targetIndex: number;
      errorMessage: string;
    },
  ) => void;
  /** Fires once per candidate actually attempted: a redacted transport assembly snapshot (header names only, no values). */
  onTransportAttempt?: (
    round: number,
    snapshot: TransportSnapshot & { providerLabel: string },
  ) => void;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  subagentScheduler?: SubagentScheduler;
  allowEmptyWorkdir?: boolean;
  /**
   * Tool approval gate: called once per tool execution (after truncation validation) on the
   * normalized call. When it returns allow:false the call is blocked, and reason is handed to the
   * model as the toolResult (the same render path as a truncation rejection). The callback may be
   * awaited (interactive approval) and should reject/deny when the turn is aborted. Decoupled from
   * policy/metadata implementations: the runner recognizes only this result and is unaware of
   * toolPolicies details.
   */
  resolveToolGate?: (
    toolCall: ToolCall,
    signal?: AbortSignal,
  ) => Promise<{ allow: true } | { allow: false; reason: string }>;
  /**
   * Request-layer tool visibility predicate (MCP lazy loading): tools returning false do not go
   * into the request sent to the model but remain in the execution layer (loop snapshot) --
   * already-issued calls are validated and executed as usual. Re-evaluated before each round's
   * request, so a tool becomes visible in the next round once ToolSearch activates it. Same
   * mechanism as the hidden provider-native search bridge.
   */
  requestToolFilter?: (toolName: string) => boolean;
  /**
   * Tool-level termination predicate: if any call in a batch matches, the run for this turn ends
   * after that batch finishes and no further model rounds run (pi-agent-core afterToolCall
   * terminate only takes effect when all calls in the batch are marked terminate, so the predicate
   * is spread per batch -- parallel calls in the same batch still execute and their results stay
   * in history). Plan submission uses this to skip a meaningless "wrap-up" round -- the approval
   * fact is shown on the card and execution is taken up by the next turn.
   */
  resolveToolTermination?: (toolCall: ToolCall) => boolean;
  /**
   * tool_choice decision hook for each round's outbound request (orchestration-layer policy; the
   * runner is unaware of specific modes). Returning undefined uses the default ("auto" when tools
   * are present). Targeted forcing ({type:"tool"}) should only be used by the caller in bounded
   * scenarios -- unbounded forcing would strip the model's ability to wrap up with text and cause
   * a runaway loop.
   */
  resolveToolChoice?: (round: number) => ToolChoice | undefined;
  /**
   * Maximum number of model rounds (inclusive): once reached, the current tool batch finishes
   * and the turn's run terminates gracefully (no throw; results stay in history), leaving
   * subsequent handling to the orchestration layer (such as plan mode's supplementary
   * submission/fallback). No limit by default.
   */
  maxRounds?: number;
}) {
  const modelId = params.model.trim();
  if (!modelId) throw new Error("No model selected");
  if (!params.runtime.baseUrl.trim()) throw new Error("Base URL cannot be empty");
  if (!params.runtime.apiKey.trim()) throw new Error("API Key cannot be empty");
  if (!params.workdir.trim() && !params.allowEmptyWorkdir) {
    throw new Error("A working directory must be configured for tool mode");
  }
  throwIfRunnerCancelled(params.signal);

  const subagentScheduler = params.subagentScheduler ?? createSubagentScheduler();

  return withPowerActivity("assistant-tools", `${params.providerId}:${modelId}`, async () => {
    const proxyRequest = await prepareProviderRequest(params.providerId, params.runtime, {
      sessionId: params.sessionId,
    });

    const model = createModelFromConfig(
      params.providerId,
      modelId,
      proxyRequest.baseUrl,
      params.runtime.requestFormat,
      params.runtime.modelConfig,
      params.runtime.baseUrl.trim(),
    );
    const nativeWebSearchStatus = resolveProviderNativeWebSearchStatus({
      providerId: params.providerId,
      api: model.api,
      enabled: params.nativeWebSearch,
      baseUrl: params.runtime.baseUrl,
      modelId,
    });
    const nativeWebSearchStatusController = createDeferredProviderNativeWebSearchStatus({
      status: nativeWebSearchStatus,
      onStatus: (status) => params.onToolStatus?.(status),
    });

    const thinkingLevel = toAssistantThinkingLevel({
      providerId: params.providerId,
      reasoning: params.runtime.reasoning,
      api: model.api,
    });

    // ---- Provider auto-failover targets -----------------------------------
    // Target 0 is the primary (params.providerId/model/runtime); the rest map
    // to params.failover.fallbacks in queue order. Fallback proxy/model
    // preparation is lazy so unused fallbacks never touch the hot path.
    type PreparedFailoverTarget = {
      index: number;
      key: string;
      label: string;
      selectedModel?: SelectedModel;
      providerId: ProviderId;
      modelId: string;
      runtime: ProviderRuntimeConfig;
      proxyRequest: PreparedProxyRequest;
      model: ReturnType<typeof createModelFromConfig>;
    };

    const failoverParams = params.failover;
    const primaryTarget: PreparedFailoverTarget = {
      index: 0,
      key: failoverParams?.primary.selectedModel
        ? failoverBreakerKey(
            failoverParams.primary.selectedModel.customProviderId,
            failoverParams.primary.selectedModel.model,
          )
        : failoverBreakerKey(params.providerId, modelId),
      label: failoverParams?.primary.label ?? `${params.providerId} · ${modelId}`,
      selectedModel: failoverParams?.primary.selectedModel,
      providerId: params.providerId,
      modelId,
      runtime: params.runtime,
      proxyRequest,
      model,
    };

    const preparedFallbackTargets = new Map<number, Promise<PreparedFailoverTarget>>();
    const prepareFallbackTarget = (index: number): Promise<PreparedFailoverTarget> => {
      const existing = preparedFallbackTargets.get(index);
      if (existing) return existing;
      const fallback = failoverParams?.fallbacks[index - 1];
      if (!fallback) {
        return Promise.reject(new Error(`Unknown failover target index: ${index}`));
      }
      const prepared = (async () => {
        const fallbackProxyRequest = await prepareProviderRequest(
          fallback.providerId,
          fallback.runtime,
          { sessionId: params.sessionId },
        );
        return {
          index,
          key: failoverBreakerKey(
            fallback.selectedModel.customProviderId,
            fallback.selectedModel.model,
          ),
          label: fallback.label,
          selectedModel: fallback.selectedModel,
          providerId: fallback.providerId,
          modelId: fallback.model,
          runtime: fallback.runtime,
          proxyRequest: fallbackProxyRequest,
          model: createModelFromConfig(
            fallback.providerId,
            fallback.model,
            fallbackProxyRequest.baseUrl,
            fallback.runtime.requestFormat,
            fallback.runtime.modelConfig,
            fallback.runtime.baseUrl.trim(),
          ),
        } satisfies PreparedFailoverTarget;
      })();
      // A failed preparation must not be cached forever; allow later retries.
      preparedFallbackTargets.set(
        index,
        prepared.catch((error) => {
          preparedFallbackTargets.delete(index);
          throw error;
        }),
      );
      return preparedFallbackTargets.get(index) as Promise<PreparedFailoverTarget>;
    };

    /** Cheap, IO-free model identity for failover bookkeeping/synthesis. */
    const fallbackTargetIdentity = (index: number) => {
      const fallback = failoverParams?.fallbacks[index - 1];
      if (!fallback) return { api: model.api, provider: model.provider, id: modelId };
      const identity = createModelFromConfig(
        fallback.providerId,
        fallback.model,
        fallback.runtime.baseUrl.trim(),
        fallback.runtime.requestFormat,
        fallback.runtime.modelConfig,
        fallback.runtime.baseUrl.trim(),
      );
      return { api: identity.api, provider: identity.provider, id: identity.id };
    };

    // Sticky winner: rounds after a successful failover start on the target
    // that actually answered, mirroring cc-switch's hot switch semantics.
    let activeFailoverTargetIndex = 0;
    let lastFailoverErrorMessage = "";
    // ------------------------------------------------------------------------

    const toolResultErrorFlags = new Map<string, boolean>();
    const toolCallsById = new Map<string, ToolCall>();
    const incompleteToolCallArguments = new Map<string, string>();
    const refusedTruncatedToolCallIds = new Set<string>();
    const buildTruncatedToolCallText = (toolName: string, reason: string) =>
      `${toolName} was not executed: its arguments were truncated in transit (${reason}). ` +
      `This is a transport error, not a mistake in your call — re-issue the complete ${toolName} call with full arguments.`;
    const parallelBatchKeyByToolCallId = new Map<string, string>();
    const parallelToolBatches = new Map<string, ParallelToolBatch>();
    const llmTools = params.tools ?? [];
    const canonicalizeToolName = buildToolNameCanonicalizer(llmTools);
    const normalizeToolCallNameForExecution = (toolCall: ToolCall) =>
      normalizeToolCallName(toolCall, canonicalizeToolName);
    const normalizeAssistantToolCallNamesForExecution = (assistant: AssistantMessage) =>
      normalizeAssistantToolCallNames(assistant, canonicalizeToolName);
    let currentRound = 0;

    const executeSingleToolCall = async (
      toolCall: ToolCall,
      signal?: AbortSignal,
    ): Promise<{ content: ToolResultMessage["content"]; details: unknown }> => {
      throwIfRunnerCancelled(signal ?? params.signal);
      const effectiveToolCall = normalizeToolCallNameForExecution(toolCall);
      if (effectiveToolCall !== toolCall) {
        toolCallsById.set(effectiveToolCall.id, effectiveToolCall);
      }
      let toolResult: ToolResultMessage;
      const linkedSignal = createLinkedAbortSignal([signal, params.signal]);
      try {
        if (shouldSilenceProviderNativeWebSearchToolCall(effectiveToolCall)) {
          toolResult = buildProviderNativeWebSearchBridgeResult({
            toolCall: effectiveToolCall,
            hostedSearchBlocks: hostedSearchBlocksByRound.get(currentRound) ?? [],
            sourcesIntro: "Hosted search sources already captured in this round:",
            fallbackText:
              "No local web_search executor is available. Continue from existing context, or request provider-native web search through the model/tool protocol instead of printing raw tool-call markup.",
            extraInstructions: ["Do not repeat raw tool-call markup in the final answer."],
          });
        } else if (shouldSilenceProviderNativeWebFetchToolCall(effectiveToolCall)) {
          toolResult = buildProviderNativeWebFetchBridgeResult({
            toolCall: effectiveToolCall,
            hostedSearchBlocks: hostedSearchBlocksByRound.get(currentRound) ?? [],
            sourcesIntro: "Hosted search sources already captured in this round:",
            fallbackText:
              "No hosted search sources were captured in this round. Continue from existing context.",
            extraInstructions: ["Do not repeat raw tool-call markup in the final answer."],
          });
        } else {
          const execute = () =>
            params.executeToolCall(effectiveToolCall, linkedSignal.signal, {
              parentToolCall: effectiveToolCall,
              subagentScheduler,
              emitToolCall: (emittedToolCall) => {
                toolCallsById.set(emittedToolCall.id, emittedToolCall);
                params.onToolCall?.(emittedToolCall, currentRound);
              },
              emitToolExecutionStart: (emittedToolCall) => {
                toolCallsById.set(emittedToolCall.id, emittedToolCall);
                params.onToolExecutionStart?.(emittedToolCall, currentRound);
              },
              emitToolResult: (emittedToolCall, emittedToolResult) => {
                toolCallsById.set(emittedToolCall.id, emittedToolCall);
                toolResultErrorFlags.set(emittedToolCall.id, Boolean(emittedToolResult.isError));
                params.onToolResult?.(emittedToolCall, emittedToolResult, currentRound);
              },
              emitToolStatus: (status) => params.onToolStatus?.(status),
            });
          toolResult = toMessageToolResult(
            await (effectiveToolCall.name === "Bash"
              ? subagentScheduler.runBash(execute, linkedSignal.signal)
              : execute()),
            effectiveToolCall,
          );
        }
      } catch (error) {
        toolResult = {
          role: "toolResult",
          toolCallId: effectiveToolCall.id,
          toolName: effectiveToolCall.name,
          content: [
            {
              type: "text",
              text: normalizeErrorMessage(
                error instanceof Error ? error.message : String(error),
                "Tool execution failed",
              ),
            },
          ],
          details: {},
          isError: true,
          timestamp: Date.now(),
        };
      } finally {
        linkedSignal.cleanup();
      }
      throwIfRunnerCancelled(linkedSignal.signal);

      toolResultErrorFlags.set(effectiveToolCall.id, Boolean(toolResult.isError));
      return {
        content: toolResult.content,
        details: toolResult.details ?? {},
      };
    };

    const startParallelToolBatchIfNeeded = (batchKey: string, signal?: AbortSignal) => {
      const batch = parallelToolBatches.get(batchKey);
      if (!batch || batch.started) return batch;

      batch.started = true;
      if (batch.toolCalls.length > 1 && !batch.announced) {
        batch.announced = true;
        params.onToolStatus?.(getParallelToolBatchStatus(batch));
      }

      const allResultsPromise = runWithConcurrency(
        batch.toolCalls,
        subagentScheduler.getParallelToolLimit(batch.toolName),
        async (call) => {
          const result = await executeSingleToolCall(call, signal);
          return {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
            details: result.details,
            isError: toolResultErrorFlags.get(call.id) ?? false,
            timestamp: Date.now(),
          } satisfies ToolResultMessage;
        },
      );

      batch.resultPromises = new Map(
        batch.toolCalls.map((call, index) => [
          call.id,
          allResultsPromise.then((results) => results[index]),
        ]),
      );

      return batch;
    };

    const localToolNames = new Set(llmTools.map((tool) => tool.name));
    const hiddenProviderNativeWebSearchToolNames = new Set<string>(
      nativeWebSearchStatus
        ? HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES.filter((name) => !localToolNames.has(name))
        : [],
    );
    const hiddenProviderNativeWebFetchToolNames = new Set<string>(
      nativeWebSearchStatus
        ? HIDDEN_PROVIDER_NATIVE_WEB_FETCH_TOOL_NAMES.filter((name) => !localToolNames.has(name))
        : [],
    );
    const shouldSilenceProviderNativeWebSearchToolCall = (toolCall: ToolCall) =>
      Boolean(
        nativeWebSearchStatus &&
          !localToolNames.has(toolCall.name) &&
          isProviderNativeWebSearchToolName(toolCall.name),
      );
    const shouldSilenceProviderNativeWebFetchToolCall = (toolCall: ToolCall) =>
      Boolean(
        nativeWebSearchStatus &&
          !localToolNames.has(toolCall.name) &&
          isProviderNativeWebFetchToolName(toolCall.name),
      );
    // Single gate for every tool-event suppression site: bridged web_search and
    // web_fetch calls must never surface as tool rows/status lines in the UI.
    const shouldSilenceProviderNativeToolCall = (toolCall: ToolCall) =>
      shouldSilenceProviderNativeWebSearchToolCall(toolCall) ||
      shouldSilenceProviderNativeWebFetchToolCall(toolCall);
    const filterRequestTools = (
      tools: Context["tools"] | undefined,
    ): Context["tools"] | undefined =>
      tools?.filter(
        (tool) =>
          !hiddenProviderNativeWebSearchToolNames.has(tool.name) &&
          !hiddenProviderNativeWebFetchToolNames.has(tool.name) &&
          (params.requestToolFilter?.(tool.name) ?? true),
      );

    const assistantVisibleAnswerText = (assistant: AssistantMessage) =>
      stripSeedToolCallMarkup(
        assistant.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n"),
      ).trim();

    // Relays that execute Anthropic server tools in-band can leak the original
    // tool_use blocks with stop_reason end_turn *after* the model has already
    // written its final answer (the server results streamed mid-generation, so
    // the answer text follows them in the same message). Bridging those calls
    // and letting pi-agent-core run another model turn makes Claude answer the
    // same question again — duplicate output after every web search. Marking
    // every bridged call of such a batch as terminate keeps the bridge results
    // in history (the next request stays protocol-consistent) but ends the run
    // on the answer the user already has. Guards: the model must have finished
    // normally with visible answer text, and a leaked search call additionally
    // needs completed in-round hosted-search sources — a model that is still
    // waiting for results (raw-markup recovery, relays that execute nothing)
    // keeps its follow-up turn.
    const shouldTerminateBridgedProviderNativeToolCall = async (
      assistant: AssistantMessage,
      toolCall: ToolCall,
    ) => {
      if (!shouldSilenceProviderNativeToolCall(toolCall)) return false;
      if (assistant.stopReason !== "stop") return false;
      if (assistantVisibleAnswerText(assistant).length === 0) return false;
      if (isProviderNativeWebSearchToolName(toolCall.name)) {
        // Await the round's probe finalization (message_end already queued this
        // exact promise) so the coverage decision reads the complete in-band
        // search metadata instead of racing the response-clone parser.
        const blocks = await finishHostedSearchRound(currentRound, "completed");
        return blocks.some((block) => block.status === "completed" && block.sources.length > 0);
      }
      // web_fetch bridges never add new information; once the model has
      // delivered its answer there is nothing for a follow-up turn to do.
      return true;
    };
    const toolsSuffix = buildToolsSuffix(
      params.workdir,
      llmTools.map((tool) => tool.name),
      params.runtimePlatform,
      params.additionalRoots,
    );
    let currentSystemPrompt = params.context.systemPrompt;
    let emittedBaselineIndex = params.context.messages.length;
    let latestAgentEndMessages: Message[] = [];
    // Accumulator for tail-delivered content: goes only into outbound requests, never into
    // agent.state.messages. Each block is remembered along with the anchor toolCallId it was first
    // attached to -- the anchor must be pinned down; re-searching would move the block from an old
    // message to a new one as the tool loop advances, reverting the old message's bytes and thus
    // breaking the prefix. Semantics: overrides carrying wireTailText append (in arrival order);
    // overrides without wireTailText clear -- only the compaction/re-freeze branch omits it, and at
    // that point the snapshot has been recomputed into systemPrompt, so the old tail content is
    // already covered by the snapshot and keeping it attached would only deliver it twice.
    let accumulatedWireTailBlocks: PinnedTailBlock[] = [];
    let agentTools: AgentTool[] = [];
    const pendingRecoveredSeedTurnRef: {
      current: {
        round: number;
        assistant: AssistantMessage;
        toolCalls: ToolCall[];
      } | null;
    } = {
      current: null,
    };
    let agent: Agent | null = null;
    const hostedSearchBlocksByRound = new Map<number, HostedSearchBlock[]>();
    const hostedSearchOrderedBlocksByRound = new Map<number, HostedSearchOrderedBlock[]>();
    const hostedSearchProbeByRound = new Map<
      number,
      {
        finishProbe: () => Promise<void>;
        completeAggregator: () => HostedSearchBlock[];
        failAggregator: () => HostedSearchBlock[];
        disposeAggregator: () => HostedSearchBlock[];
        finalization?: Promise<HostedSearchBlock[]>;
      }
    >();
    const hostedSearchFinalizations = new Set<Promise<void>>();

    function upsertHostedSearchBlockForRound(round: number, hostedSearch: HostedSearchBlock) {
      const blocks = hostedSearchBlocksByRound.get(round) ?? [];
      const idx = blocks.findIndex((block) => block.id === hostedSearch.id);
      const next = blocks.slice();
      if (idx >= 0) {
        next[idx] = mergeHostedSearchBlocks(next[idx], hostedSearch);
      } else {
        next.push(hostedSearch);
      }
      hostedSearchBlocksByRound.set(round, next);
    }

    function getHostedSearchOrderedBlocksForRound(round: number) {
      const blocks = hostedSearchOrderedBlocksByRound.get(round) ?? [];
      if (!hostedSearchOrderedBlocksByRound.has(round)) {
        hostedSearchOrderedBlocksByRound.set(round, blocks);
      }
      return blocks;
    }

    function appendHostedSearchOrderedTextForRound(round: number, delta: string) {
      if (!delta) return;
      const blocks = getHostedSearchOrderedBlocksForRound(round);
      const last = blocks[blocks.length - 1];
      if (last?.kind === "text") {
        blocks[blocks.length - 1] = {
          kind: "text",
          text: last.text + delta,
        };
      } else {
        blocks.push({ kind: "text", text: delta });
      }
    }

    function upsertHostedSearchOrderedBlockForRound(
      round: number,
      hostedSearch: HostedSearchBlock,
    ) {
      const blocks = getHostedSearchOrderedBlocksForRound(round);
      const idx = blocks.findIndex(
        (block) => block.kind === "hostedSearch" && block.item.id === hostedSearch.id,
      );
      if (idx >= 0) {
        const existing = blocks[idx];
        if (existing?.kind === "hostedSearch") {
          blocks[idx] = {
            kind: "hostedSearch",
            item: mergeHostedSearchBlocks(existing.item, hostedSearch),
          };
        }
        return;
      }
      blocks.push({ kind: "hostedSearch", item: hostedSearch });
    }

    function getHostedSearchBlocksForRound(round: number) {
      return hostedSearchBlocksByRound.get(round) ?? [];
    }

    function finishHostedSearchRound(
      round: number,
      mode: "completed" | "failed" | "dispose",
    ): Promise<HostedSearchBlock[]> {
      const controller = hostedSearchProbeByRound.get(round);
      if (!controller) return Promise.resolve(getHostedSearchBlocksForRound(round));
      if (!controller.finalization) {
        controller.finalization = (async () => {
          await controller.finishProbe();
          const blocks =
            mode === "completed"
              ? controller.completeAggregator()
              : mode === "failed"
                ? controller.failAggregator()
                : controller.disposeAggregator();
          hostedSearchProbeByRound.delete(round);
          if (blocks.length > 0) {
            hostedSearchBlocksByRound.set(round, blocks);
          }
          return getHostedSearchBlocksForRound(round);
        })();
      }
      return controller.finalization;
    }

    function replaceAgentStateMessage(target: Message, replacement: Message) {
      const currentAgent = agent;
      if (!currentAgent) return false;
      const stateMessages = getAgentMessages(currentAgent);
      let targetIndex = stateMessages.lastIndexOf(target);
      if (targetIndex < 0) {
        for (let index = stateMessages.length - 1; index >= 0; index -= 1) {
          const message = stateMessages[index];
          if (!message) continue;
          if (message.role !== target.role) continue;
          if (message.role !== "assistant" || target.role !== "assistant") continue;
          if (
            typeof message.timestamp === "number" &&
            typeof target.timestamp === "number" &&
            message.timestamp === target.timestamp
          ) {
            targetIndex = index;
            break;
          }
        }
      }
      if (targetIndex < 0) return false;
      currentAgent.state.messages = [
        ...stateMessages.slice(0, targetIndex),
        replacement,
        ...stateMessages.slice(targetIndex + 1),
      ];
      return true;
    }

    function applyHostedSearchBlocksToAssistant(
      assistant: AssistantMessage,
      round: number,
      hostedSearchBlocks: HostedSearchBlock[],
    ) {
      return appendHostedSearchBlocksToAssistant(
        assistant as AssistantMessage & { content: unknown[] },
        hostedSearchBlocks,
        {
          orderedBlocks: hostedSearchOrderedBlocksByRound.get(round),
        },
      ) as AssistantMessage;
    }

    function queueHostedSearchFinalization(
      round: number,
      mode: "completed" | "failed" | "dispose",
      assistantRef?: { current: AssistantMessage },
    ) {
      const finalization = finishHostedSearchRound(round, mode)
        .then((hostedSearchBlocks) => {
          if (!assistantRef) return;
          const nextAssistant = applyHostedSearchBlocksToAssistant(
            assistantRef.current,
            round,
            hostedSearchBlocks,
          );
          if (nextAssistant === assistantRef.current) return;
          if (replaceAgentStateMessage(assistantRef.current, nextAssistant)) {
            assistantRef.current = nextAssistant;
          }
        })
        .catch(() => undefined);
      hostedSearchFinalizations.add(finalization);
      void finalization.finally(() => {
        hostedSearchFinalizations.delete(finalization);
      });
    }

    function queueAllHostedSearchFinalizations(mode: "completed" | "failed" | "dispose") {
      for (const round of [...hostedSearchProbeByRound.keys()]) {
        queueHostedSearchFinalization(round, mode);
      }
    }

    async function waitForHostedSearchFinalizations() {
      while (hostedSearchFinalizations.size > 0) {
        await Promise.allSettled([...hostedSearchFinalizations]);
      }
    }

    function applyTurnContextOverride(
      override: Exclude<TurnContextOverride, null>,
    ): AgentContext | undefined {
      if (!agent) return undefined;
      if (override.wireTailText) {
        // The anchor is resolved once here and pinned down: override.context.messages is this
        // round's outbound request message list, and the "last safe tool result" at this moment is
        // where this block should attach long-term. Discard the block if no anchor can be resolved
        // -- the caller already confirmed it can be attached during the anchor-probing stage, so
        // arriving here empty can only mean compaction rewrote the message list; in that case the
        // cursor does not advance either and it is re-delivered next round.
        const anchorToolCallId = resolveTailBlockAnchorId(override.context.messages);
        if (anchorToolCallId) {
          accumulatedWireTailBlocks = [
            ...accumulatedWireTailBlocks,
            { anchorToolCallId, text: override.wireTailText },
          ];
        }
      } else {
        // See the semantics note where accumulatedWireTailBlocks is declared: the compaction/
        // re-freeze branch carries no wireTailText, and the old tail content has been merged into
        // the recomputed snapshot, so the accumulation must be cleared.
        accumulatedWireTailBlocks = [];
      }
      currentSystemPrompt = override.context.systemPrompt;
      agent.state.systemPrompt = buildSystemPrompt(currentSystemPrompt, toolsSuffix);
      agent.state.messages = override.context.messages.slice();
      agent.state.tools = agentTools;
      emittedBaselineIndex = Math.max(
        0,
        override.context.messages.length - override.emittedMessages.length,
      );
      latestAgentEndMessages = [];
      return {
        systemPrompt: agent.state.systemPrompt,
        messages: agent.state.messages.slice(),
        tools: agentTools,
      };
    }

    const visibleAgentTools: AgentTool[] = llmTools.map((tool) => ({
      ...tool,
      label: tool.name,
      async execute(toolCallId, toolArgs, signal) {
        const toolCall = toSyntheticToolCall({
          id: toolCallId,
          name: tool.name,
          arguments: (toolArgs ?? {}) as Record<string, unknown>,
        });
        toolCallsById.set(toolCall.id, toolCall);

        if (tool.name === "Bash" || tool.name === "Agent") {
          const batchKey = parallelBatchKeyByToolCallId.get(toolCallId);
          if (batchKey) {
            const batch = startParallelToolBatchIfNeeded(batchKey, signal);
            const toolResult = batch?.resultPromises.get(toolCallId);
            if (toolResult) {
              const resolved = await toolResult;
              toolResultErrorFlags.set(toolCallId, Boolean(resolved.isError));
              return {
                content: resolved.content,
                details: resolved.details ?? {},
              };
            }
          }
        }

        return executeSingleToolCall(toolCall, signal);
      },
    }));
    const hiddenProviderNativeWebSearchAgentTools: AgentTool[] = [
      ...hiddenProviderNativeWebSearchToolNames,
    ].map((name) => ({
      name,
      label: name,
      description: "Internal provider-native web search bridge.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          search_query: { type: "string" },
          additionalContext: { type: "string" },
        },
        additionalProperties: true,
      },
      async execute(toolCallId, toolArgs, signal) {
        const toolCall = toSyntheticToolCall({
          id: toolCallId,
          name,
          arguments: (toolArgs ?? {}) as Record<string, unknown>,
        });
        toolCallsById.set(toolCall.id, toolCall);
        return executeSingleToolCall(toolCall, signal);
      },
    }));
    // Registered so pi-agent-core resolves leaked provider-native web_fetch
    // calls instead of erroring with "Tool web_fetch not found"; execution
    // routes into the silent bridge above.
    const hiddenProviderNativeWebFetchAgentTools: AgentTool[] = [
      ...hiddenProviderNativeWebFetchToolNames,
    ].map((name) => ({
      name,
      label: name,
      description: "Internal provider-native web fetch bridge.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        additionalProperties: true,
      },
      async execute(toolCallId, toolArgs, signal) {
        const toolCall = toSyntheticToolCall({
          id: toolCallId,
          name,
          arguments: (toolArgs ?? {}) as Record<string, unknown>,
        });
        toolCallsById.set(toolCall.id, toolCall);
        return executeSingleToolCall(toolCall, signal);
      },
    }));
    agentTools = [
      ...visibleAgentTools,
      ...hiddenProviderNativeWebSearchAgentTools,
      ...hiddenProviderNativeWebFetchAgentTools,
    ];

    let streamRound = 0;
    const streamFn = (
      streamModel: typeof model,
      streamContext: Context,
      options?: StreamOptionsEx,
    ) => {
      const round = ++streamRound;
      const retryAttemptsForRound: RetryAttemptRecord[] = [];
      let failoverAttemptsForRound = 0;
      params.onRetryAttempts?.(round, retryAttemptsForRound);
      const streamTools =
        streamContext.tools ?? (agent?.state.tools as Context["tools"] | undefined) ?? llmTools;
      // Tail-delivered content exists only in outbound requests: on each request it is re-attached
      // here to its pinned-down anchor (the same policy as per-request rebuild of memory deltas),
      // and agent.state.messages never contains it. Attached before sanitize and reading
      // effectiveContext after capturePrefixShape means attribution sees the real outbound bytes.
      const outboundMessages =
        accumulatedWireTailBlocks.length > 0
          ? attachPinnedTailBlocks(streamContext.messages.slice(), accumulatedWireTailBlocks)
          : streamContext.messages.slice();
      const effectiveContext = sanitizeContextForModelRequest({
        ...streamContext,
        // Keep the runtime-only tool rules out of compaction and persistence,
        // then reattach them at the provider boundary on every model round.
        systemPrompt: buildSystemPrompt(currentSystemPrompt, toolsSuffix),
        messages: outboundMessages,
        tools: filterRequestTools(streamTools),
      });
      try {
        params.onRequestStart?.({ round, context: effectiveContext, toolsSuffix });
      } catch (error) {
        // Request observers are diagnostics only and must never break generation.
        console.warn("[agent-runner] request observer threw; request is unaffected", error);
      }

      // pi-agent-core passes the agent-state model; honor it for the primary
      // target so external model swaps keep working through the failover path.
      const primaryRoundTarget: PreparedFailoverTarget =
        streamModel === model ? primaryTarget : { ...primaryTarget, model: streamModel };

      // The hash is computed once at the request boundary: failover/retry within the same round
      // reuse the same attribution, and it must not go into streaming callbacks -- that would
      // scale the overhead with token count.
      //
      // Cache parameters are recorded under the primary target: a TTL or breakpoint-policy change
      // genuinely invalidates the cache, whereas the system and tools bytes can be identical, so
      // not tracking this dimension separately would report "unchanged" when something actually
      // went wrong.
      // Protocol-family dispatch converges in the providers layer's describeProviderCacheShape;
      // this only forwards input from the same source as the injection side (including request
      // headers; if x-session-id is already present, its header value wins).
      const roundCacheRetention =
        options?.cacheRetention ??
        resolveProviderCacheRetention(
          primaryRoundTarget.providerId,
          primaryRoundTarget.runtime.promptCachingEnabled,
          undefined,
          primaryRoundTarget.runtime.promptCacheRetention,
        );
      const roundSessionId = options?.sessionId ?? params.sessionId;
      const prefixShape = capturePrefixShape({
        systemPrompt: effectiveContext.systemPrompt,
        tools: effectiveContext.tools,
        cacheControl: describeProviderCacheShape({
          providerId: primaryRoundTarget.providerId,
          baseUrl: primaryRoundTarget.runtime.baseUrl,
          promptCacheHintMode:
            primaryRoundTarget.runtime.modelConfig?.promptCacheHintMode ??
            primaryRoundTarget.runtime.promptCacheHintMode,
          modelApi: primaryRoundTarget.model.api,
          sessionId: roundSessionId,
          cacheRetention: roundCacheRetention,
          // Consistent with the header merge policy of streamOptions below: this is exactly what the injection side sees.
          headers: {
            ...(options?.headers ?? {}),
            ...primaryRoundTarget.proxyRequest.headers,
          },
        }),
      });
      const prefixCacheDiagnostics = comparePrefixShape(
        readPreviousPrefixShape(roundSessionId),
        prefixShape,
      );
      recordPrefixShape(roundSessionId, prefixShape);

      const buildTargetRoundStream = (target: PreparedFailoverTarget) => {
        const targetModel = target.model;
        const fallbackReasoning =
          target.providerId === "claude_code" ||
          target.providerId === "gemini" ||
          target.providerId === "deepseek" ||
          targetModel.api === "openai-responses" ||
          targetModel.api === "openai-completions"
            ? toSimpleStreamReasoning(target.runtime.reasoning)
            : undefined;
        const targetNativeWebSearchStatus =
          target.index === 0
            ? nativeWebSearchStatus
            : resolveProviderNativeWebSearchStatus({
                providerId: target.providerId,
                api: targetModel.api,
                enabled: params.nativeWebSearch,
                baseUrl: target.runtime.baseUrl,
                modelId: target.modelId,
              });
        const shouldProbeHostedSearch = Boolean(targetNativeWebSearchStatus);
        const hostedSearchProbeId = shouldProbeHostedSearch
          ? createHostedSearchProbeId(target.providerId)
          : undefined;
        let streamOptions: StreamOptionsEx = {
          ...(options ?? {}),
          apiKey: options?.apiKey ?? target.runtime.apiKey,
          headers: withHostedSearchProbeHeader(
            {
              ...(options?.headers ?? {}),
              ...target.proxyRequest.headers,
            },
            hostedSearchProbeId,
          ),
          signal: options?.signal,
          sessionId: options?.sessionId ?? params.sessionId,
          cacheRetention:
            options?.cacheRetention ??
            resolveProviderCacheRetention(
              target.providerId,
              target.runtime.promptCachingEnabled,
              undefined,
              target.runtime.promptCacheRetention,
            ),
          metadata: buildProviderRequestMetadata(target.providerId, params.sessionId),
          toolChoice:
            params.resolveToolChoice?.(round) ??
            options?.toolChoice ??
            (effectiveContext.tools?.length ? "auto" : undefined),
          reasoning: normalizeStreamReasoning(options?.reasoning) ?? fallbackReasoning,
          workdir: params.workdir,
          streamRetry: {
            ...resolveStreamRetryConfig(target.runtime.retryPolicy),
            onRetry: (attempt, maxAttempts, errorMessage, plannedDelayMs) => {
              params.onToolStatus?.(
                `Round ${round}: connection lost, retrying (${attempt}/${maxAttempts})...`,
              );
              retryAttemptsForRound.push({
                attempt,
                maxAttempts,
                errorMessage,
                ...(plannedDelayMs === undefined ? {} : { plannedDelayMs }),
                providerLabel: target.label,
              });
              params.onRetryAttempts?.(round, retryAttemptsForRound.slice());
            },
            onRetryRecovered: () => {
              params.onToolStatus?.(`Round ${round}: model is generating...`);
            },
          },
        };

        streamOptions = finalizeProviderStreamOptions({
          providerId: target.providerId,
          baseUrl: target.runtime.baseUrl,
          options: streamOptions,
          context: effectiveContext,
          model: targetModel,
          workdir: params.workdir,
          nativeWebSearch: params.nativeWebSearch,
          promptCacheHintMode:
            target.runtime.modelConfig?.promptCacheHintMode ?? target.runtime.promptCacheHintMode,
          debugLogger: params.debugLogger,
          extra: {
            round,
            sessionId: params.sessionId,
          },
        });

        try {
          // Sample independently per candidate: keeping each failover target's assembly header
          // set from leaking into others is a core correctness requirement; a snapshot is recorded
          // per actually-attempted target, and an observation failure does not affect the request.
          params.onTransportAttempt?.(round, {
            ...captureTransportSnapshot(streamOptions.headers),
            providerLabel: target.label,
          });
        } catch (error) {
          console.warn("[agent-runner] transport observer threw; request is unaffected", error);
        }

        // A discarded failover attempt for this round may have left a live
        // probe/aggregator behind; finish it quietly and drop its blocks so
        // the winning attempt starts from a clean slate.
        const staleProbe = hostedSearchProbeByRound.get(round);
        if (staleProbe) {
          hostedSearchProbeByRound.delete(round);
          hostedSearchBlocksByRound.delete(round);
          hostedSearchOrderedBlocksByRound.delete(round);
          void staleProbe
            .finishProbe()
            .then(() => staleProbe.disposeAggregator())
            .catch(() => undefined);
        }

        const hostedSearchAggregator = createHostedSearchEventAggregator({
          providerId: target.providerId,
          onHostedSearch: (hostedSearch) => {
            if (hostedSearch.status === "searching") {
              nativeWebSearchStatusController.schedule();
            } else {
              nativeWebSearchStatusController.pause();
            }
            upsertHostedSearchBlockForRound(round, hostedSearch);
            upsertHostedSearchOrderedBlockForRound(round, hostedSearch);
            params.onHostedSearch?.(hostedSearch, round);
          },
        });
        const hostedSearchProbe = startHostedSearchFetchProbe({
          providerId: target.providerId,
          sessionId: params.sessionId,
          requestId: hostedSearchProbeId,
          enabled: shouldProbeHostedSearch,
          onRawEvent: hostedSearchAggregator.accept,
        });
        hostedSearchProbeByRound.set(round, {
          finishProbe: hostedSearchProbe.finish,
          completeAggregator: hostedSearchAggregator.complete,
          failAggregator: hostedSearchAggregator.fail,
          disposeAggregator: hostedSearchAggregator.dispose,
        });

        params.debugLogger?.logRequest(
          buildStreamRequestDebugPayload({
            runtime: target.runtime,
            context: effectiveContext,
            options: streamOptions,
            round,
            prefixCache: prefixCacheDiagnostics,
          }),
        );

        return llm.stream({
          model: targetModel,
          context: effectiveContext,
          options: streamOptions,
        });
      };

      const wrapWithGuard = (stream: ReturnType<typeof llm.stream>) =>
        wrapStreamWithToolCallArgumentGuard(stream, (toolCall, reason) => {
          incompleteToolCallArguments.set(toolCall.id, reason);
        });

      if (!failoverParams || failoverParams.fallbacks.length === 0) {
        return wrapWithGuard(buildTargetRoundStream(primaryRoundTarget));
      }

      // Candidate order: sticky active target first, then the rest in
      // primary→queue order. Breaker-open targets are skipped inside
      // withProviderFailover.
      const totalTargets = failoverParams.fallbacks.length + 1;
      const targetOrder = [
        activeFailoverTargetIndex,
        ...Array.from({ length: totalTargets }, (_, i) => i).filter(
          (i) => i !== activeFailoverTargetIndex,
        ),
      ];
      const candidates = targetOrder.map((targetIndex) => {
        const fallback = targetIndex === 0 ? null : failoverParams.fallbacks[targetIndex - 1];
        return {
          key:
            targetIndex === 0
              ? primaryTarget.key
              : failoverBreakerKey(
                  fallback?.selectedModel.customProviderId ?? "",
                  fallback?.selectedModel.model ?? "",
                ),
          label: targetIndex === 0 ? primaryTarget.label : (fallback?.label ?? ""),
          model:
            targetIndex === 0
              ? { api: model.api, provider: model.provider, id: model.id }
              : fallbackTargetIdentity(targetIndex),
          start: async () => {
            const target =
              targetIndex === 0 ? primaryRoundTarget : await prepareFallbackTarget(targetIndex);
            return buildTargetRoundStream(target);
          },
        } satisfies ProviderFailoverCandidate;
      });

      const failoverStream = withProviderFailover(candidates, {
        config: failoverParams.config,
        signal: options?.signal,
        onFailover: ({ fromLabel, toLabel, toIndex, errorMessage }) => {
          lastFailoverErrorMessage = errorMessage;
          failoverAttemptsForRound += 1;
          params.onFailoverAttempt?.(round, {
            attempt: failoverAttemptsForRound,
            fromLabel,
            toLabel,
            // toIndex is this round's candidates array index; map it back to the stable candidate
            // index (0 = primary) so that after sticky reordering the target identity in the ledger
            // does not drift with the round.
            targetIndex: targetOrder[toIndex] ?? toIndex,
            errorMessage,
          });
          params.onToolStatus?.(`Round ${round}: ${fromLabel} unavailable, switching to ${toLabel}...`);
        },
        onCommitted: (candidateIndex) => {
          const targetIndex = targetOrder[candidateIndex] ?? activeFailoverTargetIndex;
          if (targetIndex === activeFailoverTargetIndex) return;
          activeFailoverTargetIndex = targetIndex;
          failoverParams.onSwitched?.({
            target: targetIndex === 0 ? null : (failoverParams.fallbacks[targetIndex - 1] ?? null),
            round,
            errorMessage: lastFailoverErrorMessage,
          });
        },
      });
      return wrapWithGuard(failoverStream);
    };

    // A truncated call whose repaired arguments also fail schema validation
    // never reaches beforeToolCall (pi-agent-core validates first), so the
    // model would see a schema error blaming its own call. Rewrite such tool
    // results into the truthful transport-error teaching before the next turn.
    const reconcileTruncatedToolResults = () => {
      if (incompleteToolCallArguments.size === 0) return false;
      const messages = getAgentMessages(agent);
      let changed = false;
      const next = messages.map((message) => {
        if (message.role !== "toolResult" || !message.isError) return message;
        const reason = incompleteToolCallArguments.get(message.toolCallId);
        if (!reason) return message;
        incompleteToolCallArguments.delete(message.toolCallId);
        refusedTruncatedToolCallIds.add(message.toolCallId);
        changed = true;
        return {
          ...message,
          content: [
            { type: "text" as const, text: buildTruncatedToolCallText(message.toolName, reason) },
          ],
        };
      });
      if (changed && agent) {
        agent.state.messages = next;
      }
      return changed;
    };

    agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(currentSystemPrompt, toolsSuffix),
        model,
        thinkingLevel,
        tools: agentTools,
        messages: params.context.messages.slice(),
      },
      sessionId: params.sessionId,
      streamFn,
      toolExecution: "sequential",
      afterToolCall: async ({ assistantMessage, toolCall }) => ({
        isError: toolResultErrorFlags.get(toolCall.id) ?? false,
        // The batch only terminates when *every* call terminates. A terminating
        // call (ExitPlanMode) can arrive batched with ordinary parallel calls,
        // so the predicate must spread across the whole batch: every sibling
        // still executes and keeps its result in history, then the run ends —
        // otherwise one Read next to ExitPlanMode would silently void the
        // "submitting ends this turn" guarantee and run a wrap-up round.
        // maxRounds is the run-level circuit breaker: once the cap is reached
        // the current batch finishes normally, then the run ends gracefully.
        terminate:
          (params.maxRounds !== undefined && currentRound >= params.maxRounds) ||
          (params.resolveToolTermination
            ? getAssistantToolCalls(assistantMessage).some((call) =>
                params.resolveToolTermination?.(call),
              )
            : false) ||
          (await shouldTerminateBridgedProviderNativeToolCall(assistantMessage, toolCall)),
      }),
      beforeToolCall: async ({ assistantMessage, toolCall }) => {
        const effectiveToolCall = normalizeToolCallNameForExecution(toolCall);
        const effectiveAssistantMessage =
          normalizeAssistantToolCallNamesForExecution(assistantMessage);
        toolCallsById.set(effectiveToolCall.id, effectiveToolCall);
        const truncationReason = incompleteToolCallArguments.get(effectiveToolCall.id);
        if (truncationReason) {
          refusedTruncatedToolCallIds.add(effectiveToolCall.id);
          incompleteToolCallArguments.delete(effectiveToolCall.id);
          return {
            block: true,
            reason: buildTruncatedToolCallText(effectiveToolCall.name, truncationReason),
          };
        }
        // Approval gate: adjudicate each tool call (including Bash/Agent batch members, all of
        // which pass through here individually first) before execution. deny/not approved ->
        // block, and reason becomes that call's toolResult. The turn signal is passed in: a
        // suspended approval under the ask policy should be aborted when the turn stops.
        if (params.resolveToolGate) {
          const gate = await params.resolveToolGate(effectiveToolCall, params.signal);
          if (!gate.allow) {
            return { block: true, reason: gate.reason };
          }
        }
        if (effectiveToolCall.name !== "Agent") {
          return undefined;
        }
        const rawGroup = findConsecutiveToolGroup(
          effectiveAssistantMessage,
          effectiveToolCall.id,
          effectiveToolCall.name,
        );
        if (!rawGroup || rawGroup.length <= 1) return undefined;
        // A member with truncated arguments must not ride into execution on a
        // sibling's batch — it is refused individually by the guard above.
        const group = rawGroup
          .map(normalizeToolCallNameForExecution)
          .filter(
            (call) =>
              !incompleteToolCallArguments.has(call.id) &&
              !refusedTruncatedToolCallIds.has(call.id),
          );
        if (group.length <= 1) return undefined;

        const batchKey = buildParallelToolBatchKey(group);
        if (!parallelToolBatches.has(batchKey)) {
          parallelToolBatches.set(batchKey, {
            toolName: effectiveToolCall.name,
            toolCalls: group,
            started: false,
            announced: false,
            resultPromises: new Map(),
          });
        }
        for (const call of group) {
          parallelBatchKeyByToolCallId.set(call.id, batchKey);
        }
        return undefined;
      },
      // Since 0.84, pi-agent-core uses prepareNextTurnWithContext instead of the inter-turn
      // rewrite that transformContext used to do incidentally. The key difference: transformContext
      // cannot access the loop's context and can only read back agent.state.messages, whereas the
      // loop's currentContext.messages is a **different array** sliced out by
      // createContextSnapshot(), so rewrites on agent.state do not automatically flow back.
      // Therefore the rewritten messages must be returned explicitly as context here; otherwise
      // the assistant normalization in message_end (tool-name canonicalization, hostedSearch block
      // backfill, seed tool-call dedup) and the truncation-result rewrite all live only in
      // agent.state, and the next round's request is still sent with the old snapshot.
      prepareNextTurnWithContext: async ({ message, toolResults, context }, signal) => {
        const reconciled = reconcileTruncatedToolResults();
        // agent.state is the authoritative copy after message_end normalization; as long as its
        // length matches the loop snapshot, use it (content may have been replaced in place, and
        // equal length does not mean equal content).
        const stateMessages = getAgentMessages(agent);
        const currentContext: AgentContext =
          agent && stateMessages.length === context.messages.length
            ? { ...context, messages: stateMessages.slice() }
            : reconciled
              ? { ...context, messages: agent ? stateMessages.slice() : context.messages }
              : context;
        const contextChanged = currentContext !== context;
        if (
          !params.onBeforeNextTurn ||
          message.stopReason !== "toolUse" ||
          toolResults.length === 0
        ) {
          return contextChanged ? { context: currentContext } : undefined;
        }

        const runtimeMessages = currentContext.messages as Message[];
        const override = await params.onBeforeNextTurn({
          round: currentRound,
          assistant: message,
          toolResults,
          runtimeContext: {
            systemPrompt: currentSystemPrompt,
            messages: runtimeMessages.slice(),
            tools: llmTools,
          },
          emittedMessages:
            emittedBaselineIndex <= 0
              ? runtimeMessages.slice()
              : runtimeMessages.slice(emittedBaselineIndex),
          signal: signal ?? params.signal,
        });
        if (!override) {
          return contextChanged ? { context: currentContext } : undefined;
        }
        const nextContext = applyTurnContextOverride(override);
        return nextContext ? { context: nextContext } : undefined;
      },
    });

    const textReconciler = createStreamingTextReconciler();

    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case "turn_start":
          currentRound += 1;
          params.onTurnStart?.(currentRound);
          params.onToolStatus?.(`Round ${currentRound}: model is generating...`);
          break;
        case "message_update": {
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent.type === "text_delta") {
            nativeWebSearchStatusController.noteVisibleActivity();
            const delta = textReconciler.appendDelta(
              `${currentRound}:${streamEvent.contentIndex}`,
              streamEvent.delta,
            );
            if (delta) {
              appendHostedSearchOrderedTextForRound(currentRound, delta);
              params.onTextDelta(delta, currentRound);
            }
          } else if (streamEvent.type === "text_end") {
            const delta = textReconciler.reconcileFinalText(
              `${currentRound}:${streamEvent.contentIndex}`,
              streamEvent.content,
            );
            nativeWebSearchStatusController.pause();
            if (delta) {
              appendHostedSearchOrderedTextForRound(currentRound, delta);
              params.onTextDelta(delta, currentRound);
            }
          } else if (streamEvent.type === "thinking_delta") {
            nativeWebSearchStatusController.noteVisibleActivity();
            params.onThinkingDelta?.(streamEvent.delta, currentRound);
          } else if (streamEvent.type === "thinking_end") {
            nativeWebSearchStatusController.pause();
          } else if (streamEvent.type === "toolcall_start") {
            nativeWebSearchStatusController.pause();
            const block = streamEvent.partial.content[streamEvent.contentIndex];
            if (block && block.type === "toolCall") {
              const effectiveToolCall = normalizeToolCallNameForExecution(block);
              if (effectiveToolCall !== block) {
                streamEvent.partial.content[streamEvent.contentIndex] = effectiveToolCall;
              }
              toolCallsById.set(effectiveToolCall.id, effectiveToolCall);
              if (!shouldSilenceProviderNativeToolCall(effectiveToolCall)) {
                params.onToolCall?.(effectiveToolCall, currentRound);
              }
            }
          } else if (streamEvent.type === "toolcall_delta") {
            nativeWebSearchStatusController.pause();
            const block = streamEvent.partial.content[streamEvent.contentIndex];
            if (block && block.type === "toolCall") {
              const effectiveToolCall = normalizeToolCallNameForExecution(block);
              if (effectiveToolCall !== block) {
                streamEvent.partial.content[streamEvent.contentIndex] = effectiveToolCall;
              }
              toolCallsById.set(effectiveToolCall.id, effectiveToolCall);
              if (!shouldSilenceProviderNativeToolCall(effectiveToolCall)) {
                params.onToolCallDelta?.(effectiveToolCall, currentRound);
              }
            }
          } else if (streamEvent.type === "toolcall_end") {
            nativeWebSearchStatusController.pause();
            const effectiveToolCall = normalizeToolCallNameForExecution(streamEvent.toolCall);
            toolCallsById.set(effectiveToolCall.id, effectiveToolCall);
            if (!shouldSilenceProviderNativeToolCall(effectiveToolCall)) {
              params.onToolCall?.(effectiveToolCall, currentRound);
            }
          }
          break;
        }
        case "message_end":
          if (event.message.role === "assistant") {
            const hostedSearchFinishMode =
              event.message.stopReason === "aborted"
                ? "dispose"
                : event.message.stopReason === "error"
                  ? "failed"
                  : "completed";
            const hostedSearchBlocks = getHostedSearchBlocksForRound(currentRound);
            const assistantWithCanonicalToolNames = normalizeAssistantToolCallNamesForExecution(
              sanitizeAssistantMessage(event.message as AssistantMessage),
            );
            const assistantWithHostedSearch = applyHostedSearchBlocksToAssistant(
              assistantWithCanonicalToolNames,
              currentRound,
              hostedSearchBlocks,
            );
            const normalizedSeedTurn = recoverAssistantSeedToolCalls(assistantWithHostedSearch);
            let recoveredSeedToolCalls: ToolCall[] = [];
            let assistantWithRecoveredToolCalls =
              normalizedSeedTurn?.assistant ?? assistantWithHostedSearch;
            if (normalizedSeedTurn) {
              const deduped = dedupeRecoveredToolCallsAgainstExisting({
                existingAssistant: assistantWithHostedSearch,
                recoveredToolCalls: normalizedSeedTurn.toolCalls,
                canonicalizeToolName,
              });
              recoveredSeedToolCalls = deduped.uniqueToolCalls;
              if (deduped.duplicateToolCallIds.size > 0) {
                assistantWithRecoveredToolCalls = {
                  ...assistantWithRecoveredToolCalls,
                  content: assistantWithRecoveredToolCalls.content.filter(
                    (block) =>
                      block.type !== "toolCall" || !deduped.duplicateToolCallIds.has(block.id),
                  ),
                };
              }
            }
            const assistantMessage = normalizeAssistantToolCallNamesForExecution(
              assistantWithRecoveredToolCalls,
            );
            if (
              normalizedSeedTurn ||
              assistantMessage !== event.message ||
              assistantWithHostedSearch !== event.message
            ) {
              const stateMessages = getAgentMessages(agent);
              if (stateMessages.length > 0) {
                agent.state.messages = [...stateMessages.slice(0, -1), assistantMessage];
              }
            }
            if (normalizedSeedTurn && recoveredSeedToolCalls.length > 0) {
              pendingRecoveredSeedTurnRef.current = {
                round: currentRound,
                assistant: assistantMessage,
                toolCalls: recoveredSeedToolCalls,
              };
              params.debugLogger?.logResponse({
                type: "seed_tool_call_recovery",
                round: currentRound,
                toolCalls: recoveredSeedToolCalls,
              });
            }
            queueHostedSearchFinalization(currentRound, hostedSearchFinishMode, {
              current: assistantMessage,
            });
            params.debugLogger?.logResult({
              round: currentRound,
              assistant: assistantMessage,
            });
            const toolCallCount = getAssistantToolCalls(assistantMessage).filter(
              (toolCall) => !shouldSilenceProviderNativeToolCall(toolCall),
            ).length;
            if (toolCallCount > 0) {
              nativeWebSearchStatusController.pause();
              params.onToolStatus?.(`Round ${currentRound}: preparing to run ${toolCallCount} tools...`);
            }
            params.onAssistantMessage?.(assistantMessage, currentRound);
          } else if (event.message.role === "toolResult") {
            const toolCall =
              toolCallsById.get(event.message.toolCallId) ??
              toSyntheticToolCall({
                id: event.message.toolCallId,
                name: event.message.toolName,
              });
            if (!shouldSilenceProviderNativeToolCall(toolCall)) {
              params.onToolResult?.(toolCall, event.message, currentRound);
            }
          }
          break;
        case "tool_execution_start": {
          nativeWebSearchStatusController.pause();
          const toolCall =
            toolCallsById.get(event.toolCallId) ??
            toSyntheticToolCall({
              id: event.toolCallId,
              name: event.toolName,
              arguments: event.args ?? {},
            });
          toolCallsById.set(toolCall.id, toolCall);
          if (shouldSilenceProviderNativeToolCall(toolCall)) {
            break;
          }
          const parallelBatch = getParallelToolBatch(
            toolCall.id,
            parallelBatchKeyByToolCallId,
            parallelToolBatches,
          );
          if (parallelBatch && parallelBatch.toolCalls.length > 1) {
            params.onToolStatus?.(getParallelToolBatchStatus(parallelBatch));
          } else {
            params.onToolStatus?.(`Running: ${summarizeToolCall(toolCall)}`);
          }
          params.onToolExecutionStart?.(toolCall, currentRound);
          break;
        }
        case "agent_end":
          latestAgentEndMessages = event.messages as Message[];
          {
            const assistant = findLastAssistantMessage(latestAgentEndMessages);
            const hostedSearchFinishMode =
              assistant?.stopReason === "aborted"
                ? "dispose"
                : assistant?.stopReason === "error"
                  ? "failed"
                  : "completed";
            queueAllHostedSearchFinalizations(hostedSearchFinishMode);
          }
          nativeWebSearchStatusController.finish();
          params.onToolStatus?.(null);
          break;
      }
    });

    let abortListener: (() => void) | undefined;
    if (params.signal) {
      const onAbort = () => agent.abort();
      params.signal.addEventListener("abort", onAbort, { once: true });
      abortListener = () => params.signal?.removeEventListener("abort", onAbort);
    }

    try {
      let recoveredSeedTurnCount = 0;
      while (true) {
        throwIfRunnerCancelled(params.signal);
        await agent.continue();
        throwIfRunnerCancelled(params.signal);

        const recoveredSeedTurn = pendingRecoveredSeedTurnRef.current;
        pendingRecoveredSeedTurnRef.current = null;
        if (recoveredSeedTurn === null) {
          break;
        }
        const recoveredSeedRound = recoveredSeedTurn.round;
        const recoveredSeedAssistant = recoveredSeedTurn.assistant;
        const recoveredSeedToolCalls = recoveredSeedTurn.toolCalls;

        recoveredSeedTurnCount += 1;
        if (recoveredSeedTurnCount > 8) {
          throw new Error("Too many seed tool-call recovery attempts");
        }

        const visibleRecoveredSeedToolCalls = recoveredSeedToolCalls.filter(
          (toolCall) => !shouldSilenceProviderNativeToolCall(toolCall),
        );
        if (visibleRecoveredSeedToolCalls.length > 0) {
          params.onToolStatus?.(
            `Round ${recoveredSeedRound}: resuming execution of ${visibleRecoveredSeedToolCalls.length} tools...`,
          );
        }

        const syntheticToolResults: ToolResultMessage[] = [];
        for (const toolCall of recoveredSeedToolCalls) {
          throwIfRunnerCancelled(params.signal);
          toolCallsById.set(toolCall.id, toolCall);
          const shouldSilenceToolCall = shouldSilenceProviderNativeToolCall(toolCall);
          if (!shouldSilenceToolCall) {
            params.onToolCall?.(toolCall, recoveredSeedRound);
            params.onToolStatus?.(`Running: ${summarizeToolCall(toolCall)}`);
            params.onToolExecutionStart?.(toolCall, recoveredSeedRound);
          }

          const result = await executeSingleToolCall(toolCall, params.signal);
          throwIfRunnerCancelled(params.signal);
          const toolResult = {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: result.content,
            details: result.details,
            isError: toolResultErrorFlags.get(toolCall.id) ?? false,
            timestamp: Date.now(),
          } satisfies ToolResultMessage;

          syntheticToolResults.push(toolResult);
          if (!shouldSilenceToolCall) {
            params.onToolResult?.(toolCall, toolResult, recoveredSeedRound);
          }
        }

        if (syntheticToolResults.length > 0) {
          agent.state.messages = [...getAgentMessages(agent), ...syntheticToolResults];
        }

        if (params.onBeforeNextTurn) {
          throwIfRunnerCancelled(params.signal);
          const override = await params.onBeforeNextTurn({
            round: recoveredSeedRound,
            assistant: recoveredSeedAssistant,
            toolResults: syntheticToolResults,
            runtimeContext: {
              systemPrompt: currentSystemPrompt,
              messages: getAgentMessages(agent).slice(),
              tools: llmTools,
            },
            emittedMessages: getMessagesSinceBaseline(agent, emittedBaselineIndex),
            signal: params.signal,
          });
          throwIfRunnerCancelled(params.signal);
          if (override) {
            applyTurnContextOverride(override);
          }
        }
      }

      throwIfRunnerCancelled(params.signal);
      await waitForHostedSearchFinalizations();
      throwIfRunnerCancelled(params.signal);

      const messages = getAgentMessages(agent).slice();
      const assistant =
        findLastAssistantMessage(messages) ?? findLastAssistantMessage(latestAgentEndMessages);

      if (!assistant) {
        throw new Error("Model did not return an assistant message");
      }

      if (assistant.stopReason === "error") {
        throw new Error(normalizeErrorMessage(assistant.errorMessage, "Request failed"));
      }
      if (assistant.stopReason === "aborted") {
        throw new Error(normalizeErrorMessage(assistant.errorMessage, "Cancelled"));
      }

      await params.debugLogger?.flush();
      return {
        messages,
        assistant,
        emittedMessages: getMessagesSinceBaseline(agent, emittedBaselineIndex),
      };
    } catch (error) {
      queueAllHostedSearchFinalizations(params.signal?.aborted ? "dispose" : "failed");
      await waitForHostedSearchFinalizations();
      nativeWebSearchStatusController.finish();
      params.onToolStatus?.(null);
      params.debugLogger?.logError(error);
      await params.debugLogger?.flush();
      throw error;
    } finally {
      queueAllHostedSearchFinalizations("dispose");
      await waitForHostedSearchFinalizations();
      nativeWebSearchStatusController.finish();
      abortListener?.();
      unsubscribe();
    }
  });
}
