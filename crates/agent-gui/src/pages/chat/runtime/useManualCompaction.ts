import { deriveContextUsageTokens } from "@liveagent/ui/lib/chat/contextUsage";
import { invoke } from "@tauri-apps/api/core";
import type { MutableRefObject } from "react";
import { useCallback } from "react";
import type {
  CompactionController,
  CompactionSinks,
  ManualCompactionOutcome,
  ManualContextUsageSnapshot,
} from "../../../lib/chat/compaction/controller";
import { estimateTextTokens } from "../../../lib/chat/compaction/tokenLedger";
import type { CompactionDecisionReason } from "../../../lib/chat/compaction/types";
import { getActiveSegment } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import { createGatewayBridgeEventController } from "../../../lib/chat/conversation/run/gatewayBridgeEvents";
import { createTurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import { memoryTurnInjection } from "../../../lib/chat/memory/injectionController";
import { buildToolsSuffix } from "../../../lib/chat/runner/toolExecutionPrompt";
import { skillMentionInjection } from "../../../lib/chat/skills/mentionInjection";
import { createProviderRuntimeConfig } from "../../../lib/providers/llm";
import type { AppSettings } from "../../../lib/settings";
import {
  acquireTrajectoryRecorder,
  updateTrajectoryRecorderSegment,
} from "../../../lib/trajectory/recorderRegistry";
import { createLocalGatewayChatRunId } from "../gateway/gatewayRuntimeStatusModel";
import type {
  FinishGatewayRunMirrorInput,
  RegisterGatewayRunMirrorInput,
} from "../gateway/useGatewayRunMirrorCoordinator";
import type { PersistConversationAction } from "../history/useConversationHistoryActions";
import type { ConversationRuntimeEntry } from "./chatPageRuntime";
import {
  buildPreparedContext as buildPreparedConversationContext,
  buildResumeContext as buildResumeConversationContext,
} from "./conversationContextBuilders";
import { resolveEffectiveChatModelSelection } from "./modelSelection";

export type ManualCompactionResult = {
  status: "compacted" | "failed" | "busy" | "skipped";
  message?: string;
};

export type ManualCompactionRequest = {
  conversationId?: string;
  operationId?: string;
  // Relay-layer acceptance callback: invoked synchronously once, when the probe
  // passes and compaction actually begins. A rejected compaction never triggers
  // it; the relay layer replies synchronously based on the return value
  // (accepted:false + message).
  onAccepted?: () => void;
};

// Reading snapshot for manual compaction: prefer the controller ledger, and only
// fall back to a transcript scan when it is missing (no request sent in this
// conversation yet); when fixedTokens is absent the probe's rebase estimates from
// the current context on its own.
function resolveManualContextUsage(
  controller: CompactionController,
  runtimeEntry: ConversationRuntimeEntry,
): ManualContextUsageSnapshot {
  const runtimeSnapshot = controller.contextUsageSnapshot;
  return {
    totalTokens:
      runtimeSnapshot?.totalTokens ?? deriveContextUsageTokens(runtimeEntry.state.transcript.items),
    fixedTokens: runtimeSnapshot?.fixedTokens,
  };
}

type ConversationStopHandler = (options: { force: boolean; requestVersion: number }) => void;

/**
 * Single assembly point for manual compaction: assemble the sinks / providerConfig
 * / gateway bridge that the send path shares into one
 * CompactionController.compactManually call. Runs only when idle; compaction
 * progress state and checkpoints are mirrored to the WebUI over the existing
 * bridge channel.
 *
 * Invariant (the run lifecycle holds only when compaction actually happens):
 * bridge events go over reliable ingress, and the gateway establishes real run
 * activity for any run's first delta -- so any run trace must be deferred until
 * after the probe passes. Pre-checks (running/runtime/model/compactionStatus) leave
 * zero run trace throughout; gateway_chat_mark_local_started and
 * registerGatewayRunMirror only happen inside compactManually's onProceed
 * callback (proceeded is set only when onProceed=true); the finally block's
 * queueManualCompactionResult / finishGatewayRunMirror run only when proceeded.
 * A rejected compaction emits no events at all; the result goes back
 * synchronously through the return value, avoiding a fabricated empty run (which
 * would collapse the WebUI transcript, keep the composer busy, and replay the
 * empty run forever).
 *
 * Stop semantics: during compaction, register the same stop handler and abort
 * controller as the send path. When the user stops, cancellation.userStop.abort()
 * aborts compactManually (returning aborted), and the finally block consumes the
 * stop intent (otherwise it would swallow the next message / race a second force
 * against the queue drain).
 */
export function useManualCompaction(params: {
  settings: AppSettings;
  t: (key: string) => string;
  currentConversationIdRef: MutableRefObject<string>;
  isConversationRunning: (conversationId: string) => boolean;
  setConversationRunningState: (conversationId: string, value: boolean) => void;
  setConversationAbortController: (
    conversationId: string,
    controller: AbortController | null,
  ) => void;
  setConversationStopHandler: (
    conversationId: string,
    handler: ConversationStopHandler | null,
  ) => void;
  clearConversationStopHandler: (conversationId: string, handler: ConversationStopHandler) => void;
  consumeConversationStop: (conversationId: string, expectedVersion?: number) => boolean;
  buildRuntimeEntryFromVisibleState: () => ConversationRuntimeEntry;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  ensureConversationReady: (conversationId: string) => Promise<string>;
  getCompactionController: (conversationId: string) => CompactionController;
  getConversationLiveTranscriptStore: (conversationId: string) => LiveTranscriptStore;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => void;
  resetLiveTranscript: (store?: LiveTranscriptStore) => void;
  updateToolStatus: (status: string | null, store?: LiveTranscriptStore) => void;
  queueGatewayBridgeEventForRequest: (
    requestId: string,
    event: Record<string, unknown>,
    options?: { workerId?: string },
  ) => Promise<void> | void;
  flushGatewayBridgeEventsForRequest: (requestId: string) => Promise<void>;
  registerGatewayRunMirror: (input: RegisterGatewayRunMirrorInput) => void;
  finishGatewayRunMirror: (input: FinishGatewayRunMirrorInput) => Promise<void>;
  persistConversation: PersistConversationAction;
  setErrorMessage: (message: string | null) => void;
  // Prompt construction shared with the send path: the current conversation
  // resolves skills/memory prompts from the current workspace; a background
  // conversation (cross-conversation relay) cannot get that context and returns
  // empty strings (see the call-site comment).
  resolveManualCompactionPromptInputs: (input: {
    isCurrentConversation: boolean;
    workdir?: string;
  }) => Promise<{ activeAgentPrompt: string; skillsPrompt: string; memoryPrompt: string }>;
}) {
  const {
    settings,
    t,
    currentConversationIdRef,
    isConversationRunning,
    setConversationRunningState,
    setConversationAbortController,
    setConversationStopHandler,
    clearConversationStopHandler,
    consumeConversationStop,
    buildRuntimeEntryFromVisibleState,
    conversationRuntimeCacheRef,
    ensureConversationReady,
    getCompactionController,
    getConversationLiveTranscriptStore,
    updateConversationRuntimeEntry,
    resetLiveTranscript,
    updateToolStatus,
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    registerGatewayRunMirror,
    finishGatewayRunMirror,
    persistConversation,
    setErrorMessage,
    resolveManualCompactionPromptInputs,
  } = params;

  return useCallback(
    async (request?: ManualCompactionRequest): Promise<ManualCompactionResult> => {
      const conversationId =
        request?.conversationId?.trim() || currentConversationIdRef.current.trim();
      if (!conversationId) {
        return { status: "skipped", message: t("chat.manualCompactRejected") };
      }

      // After an await the ref may have switched conversations; re-read the
      // check rather than freezing it at closure creation time.
      const isCurrentConversation = () =>
        conversationId === currentConversationIdRef.current.trim();
      const hasRemoteGatewayTarget =
        settings.remote.enabled &&
        settings.remote.gatewayUrl.trim() !== "" &&
        settings.remote.token.trim() !== "";
      const bridgeRequestId = createLocalGatewayChatRunId(conversationId);
      const transcriptStore = getConversationLiveTranscriptStore(conversationId);
      const gatewayBridgeEvents = createGatewayBridgeEventController({
        conversationId,
        requestId: bridgeRequestId,
        workerId: "gui-live",
        enabled: hasRemoteGatewayTarget,
        sendEvent: queueGatewayBridgeEventForRequest,
        flushEvents: flushGatewayBridgeEventsForRequest,
        resolveErrorConversationId: () => conversationId,
      });
      const resultOperationId =
        request?.operationId?.trim() || createLocalGatewayChatRunId(conversationId);

      const cancellation = createTurnCancellation();
      let proceeded = false;
      let runningStateClaimed = false;
      let stopHandlerRegistered = false;
      let stopRequestVersion: number | null = null;
      let flushTrajectory: (() => Promise<void>) | null = null;
      // Same stop handler as the send path's handleConversationStop: record the
      // version number for the finally block to consume the stop intent; abort
      // makes compactManually stop (the controller returns aborted).
      const handleStop: ConversationStopHandler = (options) => {
        stopRequestVersion = options.requestVersion;
        cancellation.userStop.abort();
      };

      const messageForSkipReason = (reason: CompactionDecisionReason): string => {
        switch (reason) {
          case "below-manual-threshold":
            return t("chat.manualCompactBelowThreshold");
          case "no-active-messages":
            return t("chat.manualCompactEmpty");
          default:
            return t("chat.manualCompactUnavailable");
        }
      };

      const mapOutcome = (
        outcome: ManualCompactionOutcome,
        compactionFailureMessage: string,
      ): ManualCompactionResult => {
        switch (outcome.status) {
          case "compacted":
            return { status: "compacted" };
          case "busy":
            return { status: "busy", message: t("chat.manualCompactRejected") };
          case "skipped":
            return { status: "skipped", message: messageForSkipReason(outcome.reason) };
          default:
            // Aborted (user stop) maps to skipped + cancellation message; other failures carry failure details.
            return outcome.aborted
              ? { status: "skipped", message: t("chat.manualCompactCancelled") }
              : {
                  status: "failed",
                  message: compactionFailureMessage || t("chat.manualCompactFailed"),
                };
        }
      };

      let result: ManualCompactionResult = {
        status: "failed",
        message: t("chat.manualCompactFailed"),
      };

      const run = async (): Promise<ManualCompactionResult> => {
        if (isConversationRunning(conversationId)) {
          return { status: "busy", message: t("chat.manualCompactRejected") };
        }

        // Runtime snapshot resolution: the current conversation uses visible
        // state, but visible state is empty while history is still hydrating, so
        // if the active segment has no messages, re-check the runtime cache once
        // (otherwise it would falsely report "nothing to compact").
        let runtimeEntry: ConversationRuntimeEntry;
        if (isCurrentConversation()) {
          const visibleEntry = buildRuntimeEntryFromVisibleState();
          const visibleMessages = getActiveSegment(visibleEntry.state)?.messages ?? [];
          if (visibleMessages.length > 0) {
            runtimeEntry = visibleEntry;
          } else {
            await ensureConversationReady(conversationId);
            runtimeEntry = conversationRuntimeCacheRef.current.get(conversationId) ?? visibleEntry;
          }
        } else {
          await ensureConversationReady(conversationId);
          const cached = conversationRuntimeCacheRef.current.get(conversationId);
          if (!cached) {
            throw new Error("Conversation runtime is unavailable after history hydration");
          }
          runtimeEntry = cached;
        }

        // Hydration may take a while; re-check the running state once more before claiming the running flag.
        if (isConversationRunning(conversationId)) {
          return { status: "busy", message: t("chat.manualCompactRejected") };
        }
        setConversationRunningState(conversationId, true);
        runningStateClaimed = true;
        // Register the stop handler and abort controller (if a stop was already requested it fires immediately and aborts).
        setConversationStopHandler(conversationId, handleStop);
        setConversationAbortController(conversationId, cancellation.userStop);
        stopHandlerRegistered = true;

        if (runtimeEntry.compactionStatus.phase === "running") {
          return { status: "busy", message: t("chat.manualCompactRejected") };
        }

        let effective: ReturnType<typeof resolveEffectiveChatModelSelection>;
        try {
          effective = resolveEffectiveChatModelSelection({
            settings,
            conversationSelectedModel: runtimeEntry.selectedModel,
          });
        } catch (error) {
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        const { provider, providerId, model, selectedModel } = effective;
        const runtime = createProviderRuntimeConfig(provider, model, settings.chatRuntimeControls);

        // Checkpoint context shared with the send path: inject the agent/skills/
        // memory prompts and tools so that the checkpoint's contextTokensAfter
        // (the authoritative anchor for both ends' rings) includes the system
        // prompt and tool weight; otherwise it undercounts and both rings read low
        // after compaction.
        const {
          activeAgentPrompt: resolvedAgentPrompt,
          skillsPrompt,
          memoryPrompt: freshMemoryPrompt,
        } = await resolveManualCompactionPromptInputs({
          isCurrentConversation: isCurrentConversation(),
          workdir: runtimeEntry.workdir,
        });
        // The memory section was frozen into the system prompt on the first turn,
        // so we must reuse the same snapshot and the same batch of delta blocks
        // here: otherwise the compaction turn uses a freshly read snapshot while
        // the next send flips back to the frozen one, flipping the system section
        // twice for nothing and leaving the retained user message bytes mismatched.
        // When there is no baseline yet (e.g. a background conversation), fall back
        // to the freshly read result.
        const memoryPrompt = memoryTurnInjection.getSystemText(conversationId) ?? freshMemoryPrompt;
        const memoryTurnUpdates = memoryTurnInjection.getMessageUpdates(conversationId);
        // User messages retained after compaction must be replayed together with
        // the explicit mention blocks already attached to them; otherwise those
        // messages' bytes no longer match what was sent, and the prefix saved by
        // compaction is wasted again.
        const skillMentionUpdates = skillMentionInjection.getMessageUpdates(conversationId);

        let compactionFailureMessage = "";
        const sinks: CompactionSinks = {
          applyState: (state) =>
            updateConversationRuntimeEntry(conversationId, (prev) => ({ ...prev, state })),
          applyStateMidRun: (state) => {
            updateConversationRuntimeEntry(conversationId, (prev) => ({ ...prev, state }));
            resetLiveTranscript(transcriptStore);
          },
          publishStatus: (status) => {
            if (status.phase === "failed") compactionFailureMessage = status.message;
            updateConversationRuntimeEntry(conversationId, (prev) => ({
              ...prev,
              compactionStatus: status,
            }));
          },
          setBridgeToolStatus: (status, isCompaction = false) => {
            gatewayBridgeEvents.queueToolStatus(status, isCompaction);
            updateToolStatus(status, transcriptStore);
          },
          queueCheckpoint: (state, contextUsageTokens) =>
            gatewayBridgeEvents.queueCheckpoint(state, contextUsageTokens),
          persist: (state) =>
            persistConversation({
              conversationId,
              sessionId: runtimeEntry.sessionId,
              providerId,
              model,
              selectedModel,
              cwd: runtimeEntry.workdir,
              state,
              fallbackTitle: t("chat.pendingTitle"),
              createdAt: runtimeEntry.createdAt,
              titlePromise: null,
            }),
          // Compaction moves the user messages carrying memory delta blocks out of
          // the active segment; after discarding the injection state, the next
          // send's getSystemText falls back to a freshly read snapshot and freezes
          // it again.
          onCompacted: () => memoryTurnInjection.invalidate(conversationId),
        };

        const compactionController = getCompactionController(conversationId);
        // Manual compaction right after a restart: the controller has not yet had
        // any turn inject the provider boundary suffix (in agent mode toolsSuffix
        // measures ~4k), so the authoritative checkpoint value is systematically
        // low and the ring jumps up in steps on the next send. Supply a fallback
        // estimate from the persisted tool set; if this conversation already has a
        // current value injected by a turn (derived from real request params),
        // prefer it and never overwrite.
        if (compactionController.contextFixedOverheadTokens === 0) {
          const persistedTools = runtimeEntry.state.meta.tools;
          if (Array.isArray(persistedTools) && persistedTools.length > 0) {
            compactionController.noteFixedOverheadTokens(
              estimateTextTokens(
                buildToolsSuffix(
                  runtimeEntry.workdir ?? "",
                  persistedTools
                    .map((tool) => (typeof tool?.name === "string" ? tool.name : ""))
                    .filter(Boolean),
                ),
              ),
            );
          }
        }
        const trajectoryRecording = acquireTrajectoryRecorder(
          conversationId,
          getActiveSegment(runtimeEntry.state)?.segmentIndex ??
            runtimeEntry.state.meta.activeSegmentIndex,
          (events) => {
            for (const event of events) {
              gatewayBridgeEvents.queueEvent({
                type: "trajectory",
                event,
                conversation_id: conversationId,
              });
            }
          },
        );
        flushTrajectory = trajectoryRecording.recorder.flush;
        compactionController.setObserver({
          onStart: ({ trigger }) => {
            trajectoryRecording.recorder.compactionStart({ standalone: trigger === "manual" });
          },
          onEnd: ({ trigger, status, tokensBefore, tokensAfter, newSegmentIndex, error }) => {
            trajectoryRecording.recorder.compactionEnd({
              status,
              standalone: trigger === "manual",
              ...(tokensBefore === undefined ? {} : { tokensBefore }),
              ...(tokensAfter === undefined ? {} : { tokensAfter }),
              ...(error === undefined ? {} : { error }),
            });
            if (status === "complete" && newSegmentIndex !== undefined) {
              updateTrajectoryRecorderSegment(conversationId, newSegmentIndex);
            }
          },
        });
        const outcome = await compactionController.compactManually(
          {
            providerId,
            model,
            runtime,
            cancellation,
            sinks,
            buildPreparedContext: (state, tools, options) =>
              buildPreparedConversationContext({
                state,
                tools,
                activeAgentPrompt: resolvedAgentPrompt,
                skillsPrompt,
                memoryPrompt,
                memoryTurnUpdates,
                skillMentionUpdates,
                includeAbortedMessages: options?.includeAbortedMessages,
                includeUploadedFilesMetadata: options?.includeUploadedFilesMetadata,
              }),
            buildResumeContext: (state, resumeMessage, tools, options) =>
              buildResumeConversationContext({
                state,
                resumeMessage,
                tools,
                activeAgentPrompt: resolvedAgentPrompt,
                skillsPrompt,
                memoryPrompt,
                memoryTurnUpdates,
                skillMentionUpdates,
                includeAbortedMessages: options?.includeAbortedMessages,
                includeUploadedFilesMetadata: options?.includeUploadedFilesMetadata,
              }),
          },
          runtimeEntry.state,
          resolveManualContextUsage(compactionController, runtimeEntry),
          {
            tools: runtimeEntry.state.meta.tools,
            onProceed: () => {
              proceeded = true;
              if (hasRemoteGatewayTarget) {
                // Same mirror registration as useSendChatTurn: userMessage takes the
                // most recent user message (a real message already in history), and
                // transcriptStore is ready. A missing userMessage makes the gateway
                // checkpoint request hit lastError and the TTL sweeper declare the
                // unregistered mirror dead.
                const activeMessages = getActiveSegment(runtimeEntry.state)?.messages ?? [];
                let lastUserMessage: (typeof activeMessages)[number] | undefined;
                for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
                  if (activeMessages[index]?.role === "user") {
                    lastUserMessage = activeMessages[index];
                    break;
                  }
                }
                if (lastUserMessage) {
                  registerGatewayRunMirror({
                    runId: bridgeRequestId,
                    conversationId,
                    workerId: "gui-live",
                    userMessage: lastUserMessage,
                    transcriptStore,
                    state: "running",
                  });
                }
                // Ledger accounting: the 2s-heartbeat active_runs keeps the summarizer alive during its silent period.
                void invoke("gateway_chat_mark_local_started", {
                  request_id: bridgeRequestId,
                  conversation_id: conversationId,
                }).catch((error) => {
                  console.warn("gateway_chat_mark_local_started failed", error);
                });
              }
              request?.onAccepted?.();
            },
          },
        );

        return mapOutcome(outcome, compactionFailureMessage);
      };

      try {
        result = await run();
        if (result.status === "failed" && result.message && isCurrentConversation()) {
          setErrorMessage(result.message);
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isCurrentConversation()) {
          setErrorMessage(message);
        }
        result = { status: "failed", message };
        return result;
      } finally {
        const flushRecordedTrajectory = flushTrajectory as (() => Promise<void>) | null;
        if (flushRecordedTrajectory !== null) {
          await flushRecordedTrajectory();
        }
        if (stopHandlerRegistered) {
          clearConversationStopHandler(conversationId, handleStop);
          setConversationAbortController(conversationId, null);
        }
        if (runningStateClaimed) {
          setConversationRunningState(conversationId, false);
        }
        // The stop intent must be consumed, or the leftover would swallow that
        // conversation's next message. A version mismatch means a newer stop
        // request came after, to be handled by the subsequent path.
        if (stopRequestVersion !== null) {
          consumeConversationStop(conversationId, stopRequestVersion);
        }
        // Only a compaction that actually started has a run trace to wind down; a rejected compaction emits nothing.
        if (proceeded) {
          try {
            gatewayBridgeEvents.queueManualCompactionResult(
              resultOperationId,
              result.status,
              result.message,
            );
          } catch (error) {
            console.warn("manual compaction result event failed", error);
          }
          try {
            await gatewayBridgeEvents.close();
          } catch (error) {
            console.warn("manual compaction bridge flush failed", error);
          }
          if (hasRemoteGatewayTarget) {
            // Terminal-state accounting: compacted -> completed + historyRequired
            // (the WebUI retains the checkpoint row via persisted-history
            // convergence); failed -> failed; skipped (including cancellation)
            // converges as completed.
            try {
              await finishGatewayRunMirror({
                runId: bridgeRequestId,
                conversationId,
                entriesJson: "[]",
                state: result.status === "failed" ? "failed" : "completed",
                errorCode: result.status === "failed" ? "manual_compaction_failed" : undefined,
                errorMessage: result.status === "failed" ? result.message : undefined,
                contentComplete: result.status !== "compacted",
                historyRequired: result.status === "compacted",
              });
            } catch (error) {
              console.warn("manual compaction terminal commit failed", error);
            }
          }
        }
      }
    },
    [
      buildRuntimeEntryFromVisibleState,
      clearConversationStopHandler,
      consumeConversationStop,
      conversationRuntimeCacheRef,
      currentConversationIdRef,
      ensureConversationReady,
      finishGatewayRunMirror,
      flushGatewayBridgeEventsForRequest,
      getCompactionController,
      getConversationLiveTranscriptStore,
      isConversationRunning,
      persistConversation,
      queueGatewayBridgeEventForRequest,
      registerGatewayRunMirror,
      resetLiveTranscript,
      resolveManualCompactionPromptInputs,
      setConversationAbortController,
      setConversationRunningState,
      setConversationStopHandler,
      setErrorMessage,
      settings,
      t,
      updateConversationRuntimeEntry,
      updateToolStatus,
    ],
  );
}
