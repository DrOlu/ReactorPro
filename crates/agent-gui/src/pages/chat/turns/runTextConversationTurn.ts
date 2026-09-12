import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { HostedSearchBlock } from "@liveagent/ui/lib/chat/hostedSearch";
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
import {
  appendMessagesToConversation,
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
} from "../../../lib/chat/memory/extractionEngine";
import {
  appendTextDeltaToRound,
  appendThinkingDeltaToRound,
  collapseThinking,
  type LiveRound,
  updateLiveRound,
  upsertHostedSearchToRound,
} from "../../../lib/chat/messages/uiMessages";
import { isAbortLikeError } from "../../../lib/chat/page/chatPageHelpers";
import type { AgentRunnerFailoverParams } from "../../../lib/chat/runner/agentRunner";
import {
  createDeferredProviderNativeWebSearchStatus,
  resolveProviderNativeWebSearchStatus,
} from "../../../lib/chat/search/providerNativeSearchStatus";
import type { StreamDebugLogger } from "../../../lib/debug/agentDebug";
import { assistantMessageToText, streamAssistantMessage } from "../../../lib/providers/llm";
import { buildTextOnlySystemSuffix } from "../../../lib/providers/runtime/textOnlyRuntime";
import type { ProviderId } from "../../../lib/settings";
import { trajectoryTerminalInfo } from "../../../lib/trajectory/assistantOutcome";
import {
  NOOP_TRAJECTORY_RECORDER,
  type TrajectoryRecorder,
} from "../../../lib/trajectory/recorder";
import { buildPartialAssistantMessage } from "../runtime/chatPageRuntime";

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

/** Normalize provider usage without inventing zero-valued fields. */
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

export type RunTextConversationTurnParams = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  failover?: AgentRunnerFailoverParams;
  runtimeModel: RuntimeModel;
  selectedModel: {
    customProviderId: string;
    model: string;
  };
  sessionId: string;
  conversationId: string;
  conversationCwd?: string;
  historyCwd?: string;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
  transcriptStore: LiveTranscriptStore;
  gatewayBridgeEvents: GatewayBridgeEventController;
  hookLifecycle: ConversationHookLifecycle;
  conversationDebugLogger: StreamDebugLogger;
  recoveryDebugLogger: StreamDebugLogger;
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
  appendDraftAssistantText: (delta: string, store: LiveTranscriptStore) => void;
  batchLiveRoundsUpdate: (
    updater: (prev: LiveRound[]) => LiveRound[],
    store: LiveTranscriptStore,
  ) => void;
  updateGatewayBridgeToolStatus: (status: string | null, isCompaction?: boolean) => void;
  updateRetryAttempts: (attempts: RetryAttemptRecord[], store: LiveTranscriptStore) => void;
  commitVisibleAbortedConversation: () => boolean;
  freezeGatewayFinalProjection: (state: ConversationViewState, contentComplete?: boolean) => void;
  persistConversationWithHistorySync: (params: PersistConversationParams) => Promise<boolean>;
  memoryExtractionModel?: MemoryExtractionModelConfig;
  onMemoryExtractionModelFailure?: (model: MemoryExtractionModelConfig) => void;
  memoryExtractionStatusText?: MemoryExtractionStatusText;
  /** Trajectory instrumentation; optional for isolated tests and non-chat callers. */
  trajectory?: TrajectoryRecorder;
  trajectoryTurn?: number;
  trajectoryMessageIndex?: number;
  trajectoryMessageId?: string;
  readTrajectorySlots?: () => {
    base?: string;
    agent?: string;
    skills?: string;
    memory?: string;
  };
};

export async function runTextConversationTurn(params: RunTextConversationTurnParams) {
  const {
    providerId,
    model,
    runtime,
    failover,
    runtimeModel,
    selectedModel,
    sessionId,
    conversationId,
    conversationCwd,
    historyCwd = conversationCwd,
    fallbackTitle,
    createdAt,
    titlePromise,
    transcriptStore,
    gatewayBridgeEvents,
    hookLifecycle,
    conversationDebugLogger,
    recoveryDebugLogger,
    getNextConversationState,
    applyConversationState,
    buildPreparedContext,
    compaction,
    cancellation,
    resetLiveTranscript,
    settleLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateGatewayBridgeToolStatus,
    updateRetryAttempts,
    commitVisibleAbortedConversation,
    freezeGatewayFinalProjection,
    persistConversationWithHistorySync,
    memoryExtractionModel,
    onMemoryExtractionModelFailure,
    memoryExtractionStatusText,
  } = params;

  const trajectory = params.trajectory ?? NOOP_TRAJECTORY_RECORDER;
  if (params.trajectoryTurn !== undefined) {
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

  // Reset per-turn dedup state so <already-written-this-turn> reflects only
  // this turn. In-flight extraction from the previous turn keeps running.
  memoryExtraction.noteTurnBoundary(conversationId);

  let finalAssistant: AssistantMessage | null = null;
  let contextWithSkills = buildPreparedContext(getNextConversationState());
  let pendingTextContext: Context | null = null;
  let textRound = 1;
  const startedTrajectorySteps = new Set<number>();
  let trajectoryFailoverAttempt = 0;
  let protectionCompactionDisabled = false;
  // A failover status stays visible until the winning attempt streams content;
  // the status channel has no other owner between switch and first delta.
  let failoverStatusVisible = false;

  // Rounds in this run that had hosted search: their usage is an aggregate of
  // several server-side internal calls and cannot serve as a context anchor
  // (search finalization asynchronously replaces the message object, so content
  // detection at commit time is unreliable).
  const hostedSearchRounds = new Set<number>();

  function commitAssistantRoundMeta(assistant: AssistantMessage, round: number) {
    const suppressUsageAnchors = hostedSearchRounds.has(round);
    compaction.observeContextMessages([assistant], { suppressUsageAnchors });
    // Same convention as agent mode: the usage-ring anchor is not carried with
    // the event; both sides' back-scan computes it on the spot from meta's
    // usage + stopReason (shared-layer assistantAnchorTokens), and meta emits
    // only raw facts.
    gatewayBridgeEvents.queueToken("", {
      round,
      provider: assistant.provider,
      model: assistant.model,
      api: assistant.api,
      stopReason: assistant.stopReason,
      usage: assistant.usage,
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
          },
        })),
      transcriptStore,
    );
  }

  let textModeUsesLiveRounds = false;

  function ensureTextLiveRound(round: number) {
    textModeUsesLiveRounds = true;
    batchLiveRoundsUpdate((prev) => {
      if (prev.some((item) => item.round === round)) return prev;
      return [
        ...prev,
        {
          key: `r${round}`,
          round,
          blocks: [],
          runningToolCallIds: [],
          thinkingOpen: false,
        },
      ];
    }, transcriptStore);
  }

  function updateHostedSearch(hostedSearch: HostedSearchBlock, round: number, existingText = "") {
    hostedSearchRounds.add(round);
    const shouldSeedExistingText = !textModeUsesLiveRounds && existingText.length > 0;
    ensureTextLiveRound(round);
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
    batchLiveRoundsUpdate(
      (prev) =>
        updateLiveRound(prev, round, (target) =>
          upsertHostedSearchToRound(
            shouldSeedExistingText
              ? appendTextDeltaToRound(collapseThinking(target), existingText)
              : collapseThinking(target),
            hostedSearch,
          ),
        ),
      transcriptStore,
    );
  }

  function recordTextRequestStart(context: Context, systemSuffix: string) {
    const toolCatalog = serializeToolCatalog(context.tools);
    const segmentedHeader = {
      ...(params.readTrajectorySlots?.() ?? {}),
      toolsSuffix: systemSuffix,
      ...(toolCatalog === undefined ? {} : { toolCatalog }),
    };
    const actualSystemPrompt =
      typeof context.systemPrompt === "string" ? context.systemPrompt : undefined;
    const reconstructed = composeTrajectorySystemPrompt(segmentedHeader);
    const headerInput =
      actualSystemPrompt !== undefined && reconstructed !== actualSystemPrompt
        ? {
            runtime: actualSystemPrompt,
            ...(toolCatalog === undefined ? {} : { toolCatalog }),
          }
        : segmentedHeader;
    if (headerInput !== segmentedHeader) {
      console.warn(
        "[trajectory] text-mode segmented system prompt drifted from provider context; recording exact fallback",
      );
    }
    const headerId = trajectory.captureHeader(headerInput);
    if (startedTrajectorySteps.has(textRound)) return;
    startedTrajectorySteps.add(textRound);
    trajectory.stepStart(textRound, headerId);
  }

  // Text mode likewise appends a system suffix at the provider boundary (the
  // textOnlyRuntime rules segment), and it must be re-injected every turn: the
  // controller persists per conversation, and if an agent-mode toolsSuffix
  // estimate (~4k) lingers after switching back to text mode, the ledger and
  // checkpoint estimates would be systematically inflated.
  compaction.noteFixedOverheadTokens(estimateTextTokens(buildTextOnlySystemSuffix()));

  await compaction.maybeCompactPreSend({
    budgetContext: buildPreparedContext(getNextConversationState(), undefined, {
      includeUploadedFilesMetadata: true,
    }),
    includeUploadedFilesMetadata: true,
  });
  hookLifecycle.startAgent();

  textResponseLoop: while (!finalAssistant) {
    contextWithSkills =
      pendingTextContext ??
      buildPreparedContext(getNextConversationState(), undefined, {
        includeUploadedFilesMetadata: true,
      });
    pendingTextContext = null;
    compaction.beginRequest(contextWithSkills, getNextConversationState());
    hookLifecycle.startTurn(textRound);
    textModeUsesLiveRounds = false;
    trajectoryFailoverAttempt = 0;

    let streamedAssistantText = "";
    let streamedAssistantTokenUnits = 0;
    let protectionCheckChars = 0;
    let compactionRequested = false;
    let streamAttempt = 0;
    const nativeWebSearchEnabled = runtime.nativeWebSearchEnabled !== false;
    const nativeWebSearchStatus = resolveProviderNativeWebSearchStatus({
      providerId,
      api: runtimeModel.api,
      enabled: nativeWebSearchEnabled,
      baseUrl: runtime.baseUrl,
      modelId: model,
    });

    while (!finalAssistant) {
      const scope = cancellation.deriveScope();
      const nativeWebSearchStatusController = createDeferredProviderNativeWebSearchStatus({
        status: nativeWebSearchStatus,
        onStatus: (status) => updateGatewayBridgeToolStatus(status),
      });
      const retryAttemptsForAttempt: RetryAttemptRecord[] = [];
      updateRetryAttempts(retryAttemptsForAttempt, transcriptStore);
      try {
        finalAssistant = await streamAssistantMessage({
          providerId,
          model,
          runtime,
          failover: failover
            ? {
                config: failover.config,
                primary: failover.primary,
                fallbacks: failover.fallbacks,
                onSwitched: ({ target, errorMessage }) => {
                  failover.onSwitched?.({ target, round: textRound, errorMessage });
                },
                onFailover: ({ fromLabel, toLabel, targetIndex, errorMessage }) => {
                  trajectoryFailoverAttempt += 1;
                  trajectory.noteFailover(textRound, {
                    attempt: trajectoryFailoverAttempt,
                    fromLabel,
                    toLabel,
                    targetIndex,
                    ...(errorMessage === "" ? {} : { error: errorMessage }),
                  });
                  failoverStatusVisible = true;
                  updateGatewayBridgeToolStatus(
                    `Round ${textRound}: ${fromLabel} is unavailable, switching to ${toLabel}...`,
                  );
                },
              }
            : undefined,
          context: contextWithSkills,
          workdir: conversationCwd,
          sessionId,
          nativeWebSearch: nativeWebSearchEnabled,
          onTransportAttempt: (snapshot) => {
            trajectory.noteTransport(textRound, {
              provider: snapshot.providerLabel,
              ...(snapshot.upstreamOrigin === undefined
                ? {}
                : { upstreamOrigin: snapshot.upstreamOrigin }),
              useSystemProxy: snapshot.useSystemProxy,
              fullUrl: snapshot.fullUrl,
              headerNames: snapshot.headerNames,
            });
          },
          onRequestStart: ({ context, systemSuffix }) => {
            recordTextRequestStart(context, systemSuffix);
          },
          onTextDelta: (delta) => {
            trajectory.firstToken(textRound);
            if (failoverStatusVisible) {
              failoverStatusVisible = false;
              updateGatewayBridgeToolStatus(null);
            }
            nativeWebSearchStatusController.noteVisibleActivity();
            gatewayBridgeEvents.queueToken(delta, { round: textRound });
            if (textModeUsesLiveRounds) {
              batchLiveRoundsUpdate(
                (prev) =>
                  updateLiveRound(prev, textRound, (target) =>
                    appendTextDeltaToRound(collapseThinking(target), delta),
                  ),
                transcriptStore,
              );
            } else {
              appendDraftAssistantText(delta, transcriptStore);
            }
            streamedAssistantText += delta;
            streamedAssistantTokenUnits += estimateTextTokenUnits(delta);
            protectionCheckChars += delta.length;
            if (compactionRequested || protectionCompactionDisabled || protectionCheckChars < 160) {
              return;
            }
            protectionCheckChars = 0;
            if (!compaction.shouldProtectMidStream(streamedAssistantTokenUnits)) return;
            compactionRequested = true;
            scope.controller.abort();
          },
          onThinkingDelta: (delta) => {
            if (failoverStatusVisible) {
              failoverStatusVisible = false;
              updateGatewayBridgeToolStatus(null);
            }
            nativeWebSearchStatusController.noteVisibleActivity();
            gatewayBridgeEvents.queueEvent({
              type: "thinking",
              text: delta,
              round: textRound,
              conversation_id: conversationId,
            });
            // Thinking can only be attached to a live round; the draft channel
            // has no thinking blocks. Before switching over, feed any existing
            // draft text into this round, or that text would disappear once the
            // render layer switches to the live round.
            const shouldSeedExistingText =
              !textModeUsesLiveRounds && streamedAssistantText.length > 0;
            ensureTextLiveRound(textRound);
            batchLiveRoundsUpdate(
              (prev) =>
                updateLiveRound(prev, textRound, (target) => ({
                  ...appendThinkingDeltaToRound(
                    shouldSeedExistingText
                      ? appendTextDeltaToRound(target, streamedAssistantText)
                      : target,
                    delta,
                  ),
                  thinkingOpen: true,
                })),
              transcriptStore,
            );
          },
          onHostedSearch: (hostedSearch) => {
            trajectory.firstToken(textRound);
            if (hostedSearch.status === "searching") {
              nativeWebSearchStatusController.schedule();
            } else {
              nativeWebSearchStatusController.pause();
            }
            updateHostedSearch(hostedSearch, textRound, streamedAssistantText);
          },
          signal: scope.controller.signal,
          debugLogger: streamAttempt === 0 ? conversationDebugLogger : recoveryDebugLogger,
          onRetryStatus: (attempt, maxAttempts, errorMessage, plannedDelayMs, providerLabel) => {
            trajectory.noteRetry(textRound, {
              attempt,
              // The callback's maxAttempts is already the retry budget —
              // withStreamRetry subtracts the first attempt before passing it in
              // (the same convention as the m in the "(n/m)" status hint), so
              // record it directly.
              maxRetries: maxAttempts,
              ...(plannedDelayMs === undefined ? {} : { delayMs: plannedDelayMs }),
              ...(errorMessage === "" ? {} : { error: errorMessage }),
              // Same convention as agent mode: under failover, attribute the retry to the specific candidate.
              ...(providerLabel === undefined ? {} : { provider: providerLabel }),
            });
            updateGatewayBridgeToolStatus(
              `Connection lost, retrying (${attempt}/${maxAttempts})...`,
            );
            retryAttemptsForAttempt.push({
              attempt,
              maxAttempts,
              errorMessage,
              ...(plannedDelayMs === undefined ? {} : { plannedDelayMs }),
              ...(providerLabel === undefined ? {} : { providerLabel }),
            });
            updateRetryAttempts(retryAttemptsForAttempt.slice(), transcriptStore);
          },
          onRetryRecovered: () => {
            updateGatewayBridgeToolStatus(null);
          },
        });
        trajectory.firstToken(textRound);
        const trajectoryUsage = toTrajectoryUsage(finalAssistant.usage);
        const terminalInfo = trajectoryTerminalInfo(finalAssistant);
        trajectory.stepEnd(textRound, {
          ...terminalInfo,
          ...(trajectoryUsage === undefined ? {} : { usage: trajectoryUsage }),
          provider: finalAssistant.provider || providerId,
          model: finalAssistant.model || model,
          ...(finalAssistant.api ? { api: finalAssistant.api } : {}),
          ...(typeof finalAssistant.stopReason === "string"
            ? { stopReason: finalAssistant.stopReason }
            : {}),
        });
        nativeWebSearchStatusController.finish();
      } catch (streamErr) {
        nativeWebSearchStatusController.finish();
        if (compactionRequested) {
          trajectory.stepEnd(textRound, {
            status: "aborted",
            error: "Provider request restarted after mid-stream compaction.",
          });
          hookLifecycle.ensureMessageEnded();
          hookLifecycle.endTurn(textRound);
          resetLiveTranscript(transcriptStore);
          textModeUsesLiveRounds = false;

          const partialAssistant = buildPartialAssistantMessage({
            model: runtimeModel,
            text: streamedAssistantText,
            stopReason: "aborted",
          });
          if (partialAssistant) {
            applyConversationState(
              appendMessagesToConversation(getNextConversationState(), [partialAssistant]),
            );
          }

          const compactionResult = await compaction.compactDuringRun({
            trigger: "mid-stream",
            state: getNextConversationState(),
            includeAbortedMessages: true,
            includeUploadedFilesMetadata: true,
          });

          if (!compactionResult.context) {
            throw new Error("Mid-stream compaction did not provide a continuation context.");
          }
          pendingTextContext = compactionResult.context;
          if (compactionResult.shouldDisableProtection) {
            protectionCompactionDisabled = true;
          }
          textRound += 1;
          continue textResponseLoop;
        }

        if (cancellation.userStop.signal.aborted || isAbortLikeError(streamErr)) {
          if (commitVisibleAbortedConversation()) {
            return;
          }
          throw streamErr;
        }

        if (streamAttempt < 1) {
          streamAttempt += 1;
          trajectory.noteRetry(textRound, {
            attempt: streamAttempt,
            maxRetries: 1,
            error: streamErr instanceof Error ? streamErr.message : String(streamErr),
          });
          streamedAssistantText = "";
          streamedAssistantTokenUnits = 0;
          protectionCheckChars = 0;
          resetLiveTranscript(transcriptStore);
          textModeUsesLiveRounds = false;
          continue;
        }

        throw streamErr;
      } finally {
        scope.release();
      }
    }

    hookLifecycle.ensureMessageEnded();
    hookLifecycle.endTurn(textRound);
  }

  const gatewayAssistantText = assistantMessageToText(finalAssistant);
  if (!gatewayBridgeEvents.hasForwardedText() && gatewayAssistantText.length > 0) {
    gatewayBridgeEvents.queueToken(gatewayAssistantText, { round: textRound });
  }
  const finalState = appendMessagesToConversation(getNextConversationState(), [finalAssistant]);
  const shouldRunMemoryExtraction =
    finalAssistant.stopReason !== "error" && finalAssistant.stopReason !== "aborted";
  commitAssistantRoundMeta(finalAssistant, textRound);
  applyConversationState(finalState);
  freezeGatewayFinalProjection(finalState, true);
  settleLiveTranscript(transcriptStore);
  hookLifecycle.ensureMessageEnded();
  hookLifecycle.endAgent();
  const historyPersisted = await persistConversationWithHistorySync({
    conversationId,
    sessionId,
    providerId,
    model,
    cwd: historyCwd,
    state: finalState,
    fallbackTitle,
    createdAt,
    titlePromise,
  });
  trajectory.endTurn(trajectoryTerminalInfo(finalAssistant));
  await trajectory.flush();
  // Only extract memory after durable history lands; otherwise memory can
  // retain the answer while a failed final persist leaves chat history on the
  // user-only snapshot.
  if (historyPersisted && shouldRunMemoryExtraction) {
    const currentMemoryExtractionModel: MemoryExtractionModelConfig = {
      providerId,
      model,
      runtime,
      selectedModel,
    };
    // Fire-and-forget; the controller owns lifecycle while the stable turn-level
    // userStop signal still cancels extraction.
    void memoryExtraction.requestExtraction({
      primary: memoryExtractionModel ?? currentMemoryExtractionModel,
      fallback: memoryExtractionModel ? currentMemoryExtractionModel : undefined,
      onPrimaryFailure: memoryExtractionModel ? onMemoryExtractionModelFailure : undefined,
      sessionId,
      conversationId,
      workdir: conversationCwd,
      // The extraction sub-model must see only what the user actually said:
      // memory increment blocks serve only the main model's cache, and mixing
      // them in would treat index lines as user speech, both blowing past the
      // short-message gate and inducing duplicate writes.
      messages: buildPreparedContext(finalState, undefined, { includeMemoryTurnUpdates: false })
        .messages,
      statusText: memoryExtractionStatusText,
      signal: cancellation.userStop.signal,
      debugLogger: conversationDebugLogger,
    });
  }
}
