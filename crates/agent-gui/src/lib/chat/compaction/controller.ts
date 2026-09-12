import type { Context, UserMessage } from "@earendil-works/pi-ai";
import {
  canManualCompact,
  contextUsageRatio,
  positiveTokenCount,
} from "@liveagent/ui/lib/chat/contextUsage";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { StreamDebugLogger } from "../../debug/agentDebug";
import type { ProviderId } from "../../settings";
import { type ConversationViewState, getActiveSegment } from "../conversation/conversationState";
import type { TurnCancellation } from "../conversation/turnCancellation";
import { isAbortLikeError } from "../page/chatPageHelpers";
import { createSyntheticContinueUserMessage, runCompaction } from "./engine";
import {
  createCompactionPressure,
  decideCompaction,
  normalizeCompactionPressure,
  notePressureAfterCompaction,
  resolvePruneOptions,
  shouldPruneBeforeCompaction,
} from "./policy";
import { type PruneConversationResult, pruneConversationState } from "./prune";
import {
  buildCompactionRunningStatus,
  buildPruneFallbackStatus,
  PRUNE_FALLBACK_NOTICE,
} from "./statusText";
import { type CompleteAssistantFn, createCompactionAbortError } from "./summarizer";
import { deriveContextTokens, TokenLedger } from "./tokenLedger";
import type {
  CompactionDecision,
  CompactionDecisionReason,
  CompactionIntent,
  CompactionStatus,
  CompactionTrigger,
  ProviderRuntimeConfig,
} from "./types";

type ContextBuildOptions = {
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
};

// All side effects go through injected sinks: ChatPage provides the full implementation, while
// subagents provide a lightweight subset. All are optional — absent means no-op, keeping the
// controller itself pure and testable.
export type CompactionSinks = {
  applyState?: (state: ConversationViewState) => void;
  // Mid-run re-base: apply + clear the live transcript (after compaction/prune results land,
  // the old streaming content is stale).
  applyStateMidRun?: (state: ConversationViewState) => void;
  publishStatus?: (status: CompactionStatus) => void;
  setBridgeToolStatus?: (status: string | null, isCompaction?: boolean) => void;
  queueCheckpoint?: (state: ConversationViewState, contextUsageTokens: number) => void;
  // false/null means persistence failed (compaction aborts and rolls back). On success it may
  // return the "stamped persisted state with a rebuilt revision" — finalizeCheckpoint applies
  // this one rather than the input state: the checkpoint state comes from
  // appendMessagesToConversation and its revision is always null, so applying it verbatim would
  // make the runtime cache lose the CAS token needed for replace/pagination (this is exactly why
  // edit-resend after compaction reports "history conversation is missing a revision"). Returning
  // true/undefined keeps the input state (the subagent's fire-and-forget persist takes this path).
  persist?: (
    state: ConversationViewState,
  ) => Promise<ConversationViewState | boolean | null | undefined>;
  restoreComposer?: (
    composerText: string | undefined,
    uploadedFiles: PendingUploadedFile[],
  ) => void;
  persistRollback?: (state: ConversationViewState) => Promise<unknown>;
  // Notification after a successful compaction lands (triggered uniformly by finalizeCheckpoint,
  // shared by all three compaction paths). Used to invalidate injected state attached to user
  // messages by message id: once the carrier message is compacted out of the active segment,
  // continuing to increment would silently drop changes, so the whole thing must be re-frozen.
  onCompacted?: () => void;
};

export type CompactionPreSendBinding = {
  // Baseline state to checkpoint (excluding this turn's pending user message).
  baseState: ConversationViewState;
  pendingUserText: string;
  composerText?: string;
  uploadedFiles?: PendingUploadedFile[];
  // How to derive the final state to apply after compaction/prune (e.g. re-attach the pending
  // user message).
  composeAppliedState: (state: ConversationViewState) => ConversationViewState;
};

export type CompactionTurnBinding = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  cancellation: TurnCancellation;
  debugLogger?: StreamDebugLogger;
  complete?: CompleteAssistantFn;
  sinks: CompactionSinks;
  buildPreparedContext: (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: ContextBuildOptions,
  ) => Context;
  buildResumeContext: (
    state: ConversationViewState,
    resumeMessage?: UserMessage,
    tools?: Context["tools"],
    options?: ContextBuildOptions,
  ) => Context;
  presend?: CompactionPreSendBinding;
};

export type CompactionDuringRunResult = {
  context: Context | null;
  shouldDisableProtection: boolean;
  // The explicit result channel for this call. statusPhase is a controller lifecycle field
  // (it carries over across operations and is not published when a decision is declined), so no
  // caller may infer the result of a single call from it.
  outcome: "compacted" | "skipped" | "failed";
  // Carries the decision-rejection reason when skipped; a no-op run without a binding makes no
  // decision and has no reason.
  reason?: CompactionDecisionReason;
};

export type ManualCompactionOutcome =
  | { status: "compacted" | "busy" }
  | { status: "failed"; aborted?: boolean }
  | { status: "skipped"; reason: CompactionDecisionReason };

export type ManualContextUsageSnapshot = {
  totalTokens?: number;
  fixedTokens?: number;
};

/**
 * An observer of the compaction lifecycle, for trajectory instrumentation to subscribe to.
 *
 * Attached to the controller rather than to each call site: compaction has four trigger paths
 * (pre-send / mid-stream / post-tool / manual), and instrumenting each call site would miss some
 * and break as new trigger modes are added. Inside the controller there is only one start point,
 * `publishRunning`, and three end points: `settleCompleted`/`settleFailed`/`settleAborted`.
 *
 * Deliberately does not reference trajectory types: the controller should not know who the
 * consumer is.
 */
export type CompactionObserver = {
  onStart: (info: { trigger: CompactionTrigger; tokensBefore?: number }) => void;
  onEnd: (info: {
    trigger: CompactionTrigger;
    status: "complete" | "error" | "aborted";
    tokensBefore?: number;
    tokensAfter?: number;
    newSegmentIndex?: number;
    error?: string;
  }) => void;
};

function withActiveSummaryContextTokens(
  state: ConversationViewState,
  contextUsageTokens: number,
): ConversationViewState {
  const segmentIndex = state.activeSegmentIndex;
  const segment = state.segments[segmentIndex];
  if (!segment?.summary) return state;
  const nextSegment = {
    ...segment,
    summary: {
      ...segment.summary,
      summaryMeta: {
        ...segment.summary.summaryMeta,
        stats: {
          ...(segment.summary.summaryMeta.stats ?? {
            sourceMessageCount: segment.summary.summaryMeta.coveredMessageCount,
          }),
          contextTokensAfter: contextUsageTokens,
        },
      },
    },
  };
  const segments = state.segments.slice();
  segments[segmentIndex] = nextSegment;
  return { ...state, segments };
}

type RollbackSnapshot = {
  state: ConversationViewState;
  composerText?: string;
  uploadedFiles?: PendingUploadedFile[];
  persistOnRollback?: boolean;
};

/**
 * Per-conversation compaction state machine. It holds the pressure ladder and token ledger
 * across turns; each turn's bindTurn injects the runtime/sinks/cancellation chain. Single-flight
 * is guaranteed by inFlight; the rollback snapshot is an instance field, and all terminal states
 * converge through settle*() (status publication and bridge-status cleanup are paired and no
 * longer scattered).
 */
export class CompactionController {
  private pressure = createCompactionPressure();
  private readonly ledger = new TokenLedger();
  /**
   * Estimate of the appended segment that the provider boundary only stitches into systemPrompt
   * (the agent-mode tool execution rules toolsSuffix measured ~4k). The turn runner injects it
   * before each turn's compaction decision; it persists across binds, and idle manual compaction's
   * checkpoint estimate benefits too. All rebase/estimates pass it through uniformly so the
   * checkpoint authority value and the ledger reading at send time use the same basis — an
   * inconsistency between the two is exactly what causes the ring to regress/jump after compaction.
   */
  private fixedOverheadTokens = 0;
  private binding: CompactionTurnBinding | null = null;
  private rollbackSnapshot: RollbackSnapshot | null = null;
  private inFlight = false;
  private statusPhase: CompactionStatus["phase"] = "idle";
  private turnMeta = { activeMessageCount: 0, userMessageCount: 0, lastSummaryAt: 0 };
  private observer: CompactionObserver | null = null;
  /** Context tokens at the start of this compaction, used to fill in the before/after comparison in the end event. */
  private observedTokensBefore: number | undefined;
  /** Context tokens after the checkpoint lands; only the success path has a value. */
  private observedTokensAfter: number | undefined;
  /** The compaction trigger type for which onStart has been emitted but not yet closed. */
  private observedTrigger: CompactionTrigger | undefined;
  /** Distinguishes two asynchronous compactions with the same trigger, rejecting a stale summarizer's late result. */
  private observedOperationId: number | undefined;
  private nextObservedOperationId = 0;

  /**
   * Subscribes to the compaction lifecycle.
   *
   * @param observer - the observer; pass null to unsubscribe.
   */
  setObserver(observer: CompactionObserver | null) {
    this.observer = observer;
  }

  /** Injects the provider-boundary appended-segment estimate; invalid values clear to 0 (no residue after a mode switch). */
  noteFixedOverheadTokens(tokens: number) {
    this.fixedOverheadTokens =
      typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  }

  /**
   * The currently injected boundary appended-segment estimate (0 = no turn has injected it in
   * this conversation). Idle manual compaction uses this to decide whether to supply a fallback
   * estimate based on the persisted tool set: the turn runner's current value comes from real
   * request parameters, is higher quality, and is never overwritten.
   */
  get contextFixedOverheadTokens(): number {
    return this.fixedOverheadTokens;
  }

  /**
   * Authority context snapshot of the active segment checkpoint (stats.contextTokensAfter). The
   * checkpoint context has no messages, so this value is essentially the "fixed of the new prefix"
   * (system + summary + tools + boundary appended segment, possibly including calibration) — it is
   * exactly what both idle rings show in the anchorless window after compaction. Later rebases use
   * it as the fixed lower bound: any input drift in freshly computed estimates (narrowed active
   * tool subset, re-frozen memory segment, overhead lost by the controller after restart, mode
   * switch) must not let the post-send running reading fall below the idle reading, otherwise the
   * ring regresses first and then jumps once the first real usage arrives. Read from state rather
   * than a controller field, so it still works across restarts; when a real usage anchor exists,
   * fixed does not participate in the reading and the lower bound retires automatically.
   */
  private checkpointFixedFloor(state: ConversationViewState): number | undefined {
    return positiveTokenCount(
      getActiveSegment(state)?.summary?.summaryMeta.stats?.contextTokensAfter,
    );
  }

  // Unified ledger-rebuild entry point: take the larger of the checkpoint lower bound and the
  // caller's calibration value, and always pass the boundary appended segment through.
  private rebaseLedger(
    ledger: TokenLedger,
    context: Context,
    state: ConversationViewState,
    fixedTokens?: number,
  ) {
    const floor = this.checkpointFixedFloor(state);
    const calibration =
      fixedTokens === undefined
        ? floor
        : floor === undefined
          ? fixedTokens
          : Math.max(fixedTokens, floor);
    ledger.rebase(context, {
      ...(calibration === undefined ? {} : { fixedTokens: calibration }),
      fixedOverheadTokens: this.fixedOverheadTokens,
    });
  }

  bindTurn(binding: CompactionTurnBinding) {
    // A defensive rebind must not strand the previous observer interval.
    this.settleAbortedIfRunning();
    this.binding = binding;
    this.rollbackSnapshot = null;
    this.inFlight = false;
  }

  unbindTurn() {
    // Every published start receives exactly one terminal notification, even when a caller
    // tears down the turn without first reaching the ordinary completion path.
    this.settleAbortedIfRunning();
    this.binding = null;
    this.rollbackSnapshot = null;
    this.inFlight = false;
  }

  get stats() {
    return { compactionsApplied: this.pressure.compactionsApplied };
  }

  private async persistCheckpoint(
    binding: CompactionTurnBinding,
    state: ConversationViewState,
  ): Promise<ConversationViewState> {
    const persisted = await binding.sinks.persist?.(state);
    if (persisted === false || persisted === null) {
      throw new Error("compaction checkpoint persistence failed");
    }
    // The stamped state returned by the persistence hook (with a rebuilt revision) takes
    // priority; boolean/undefined falls back to the input.
    return typeof persisted === "object" ? persisted : state;
  }

  // Unified wrap-up after a successful compaction (pre-send and during-run share the same
  // ordering invariant): checkpoint context estimate → write back summary stats → persistence
  // barrier → invalidate rollback snapshot → apply → completed terminal state → enqueue
  // checkpoint. tools must use the same arguments as the real request, otherwise
  // contextTokensAfter systematically undercounts tool weight; fixedTokens is the lower bound of
  // the dynamic-overhead calibration (rebase internally takes max with the new context estimate —
  // the checkpoint's systemPrompt already contains the new summary, so replacing the whole thing
  // would drop the summary from the estimate and make the ring jump or regress on the next send).
  private async finalizeCheckpoint(params: {
    binding: CompactionTurnBinding;
    trigger: CompactionTrigger;
    state: ConversationViewState;
    newSegmentIndex: number;
    tools?: Context["tools"];
    buildOptions: ContextBuildOptions;
    fixedTokens?: number;
    operationId: number;
    // State-landing hook executed synchronously after the persist barrier and before the
    // completed terminal state.
    apply: (checkpointState: ConversationViewState) => void;
  }): Promise<{ checkpointState: ConversationViewState; checkpointTokens: number }> {
    this.assertObservedOperation(params.operationId);
    const checkpointContext = params.binding.buildPreparedContext(
      params.state,
      params.tools,
      params.buildOptions,
    );
    const checkpointTokens = deriveContextTokens(checkpointContext, {
      ...(params.fixedTokens === undefined ? {} : { fixedTokens: params.fixedTokens }),
      fixedOverheadTokens: this.fixedOverheadTokens,
    });
    this.assertObservedOperation(params.operationId);
    const checkpointState = await this.persistCheckpoint(
      params.binding,
      withActiveSummaryContextTokens(params.state, checkpointTokens),
    );
    this.assertObservedOperation(params.operationId);
    this.rollbackSnapshot = null;
    params.apply(checkpointState);
    // settleCompleted reads it, so it must be set before that call.
    this.observedTokensAfter = checkpointTokens;
    this.settleCompleted(params.trigger, params.newSegmentIndex, params.operationId);
    params.binding.sinks.queueCheckpoint?.(checkpointState, checkpointTokens);
    // Placed last: the checkpoint context estimate must still be computed from the pre-compaction
    // injected state, and the notification only affects the direction of the next planTurn.
    params.binding.sinks.onCompacted?.();
    return { checkpointState, checkpointTokens };
  }

  beginRequest(context: Context, state: ConversationViewState) {
    this.rebaseLedger(this.ledger, context, state);
    this.updateTurnMeta(state);
    return this.ledger.total();
  }

  observeContextMessages(
    messages: readonly Context["messages"][number][],
    options?: { suppressUsageAnchors?: boolean },
  ) {
    this.ledger.addMessages(messages, options);
    return this.ledger.total();
  }

  get contextUsageTokens() {
    const totalTokens = this.ledger.total();
    return totalTokens > 0 ? totalTokens : undefined;
  }

  /** The ledger's current system+tools fixed-overhead estimate; used by the idle back-scan to fill in the same basis when there is no anchor. */
  get contextFixedTokens(): number | undefined {
    const { fixedTokens } = this.ledger.snapshot();
    return fixedTokens > 0 ? fixedTokens : undefined;
  }

  get contextUsageSnapshot(): ManualContextUsageSnapshot | undefined {
    const snapshot = this.ledger.snapshot();
    return snapshot.totalTokens > 0
      ? { totalTokens: snapshot.totalTokens, fixedTokens: snapshot.fixedTokens }
      : undefined;
  }

  // O(1): ledger reading + streaming-increment estimate + pure decision, no state construction
  // or serialization. pendingTokenUnits is accumulated by the caller from streaming deltas using
  // estimateTextTokenUnits.
  shouldProtectMidStream(pendingTokenUnits: number): boolean {
    if (!this.binding || this.inFlight) return false;
    return this.decide("protection", this.ledger.totalWithPendingTokens(pendingTokenUnits))
      .shouldCompact;
  }

  async maybeCompactPreSend(params: {
    budgetContext: Context;
    tools?: Context["tools"];
    includeUploadedFilesMetadata?: boolean;
  }): Promise<boolean> {
    const binding = this.binding;
    const presend = binding?.presend;
    if (!binding || !presend) return false;
    if (binding.cancellation.userStop.signal.aborted) {
      throw createCompactionAbortError();
    }
    const now = Date.now();
    const buildOptions: ContextBuildOptions = {
      includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
    };

    let workingState = presend.baseState;
    let pruned: PruneConversationResult | null = null;
    if (shouldPruneBeforeCompaction(this.pressure, now)) {
      const attempt = pruneConversationState(workingState, resolvePruneOptions(this.pressure));
      if (attempt.applied) {
        pruned = attempt;
        workingState = attempt.state;
      }
    }

    const budgetContext = pruned
      ? binding.buildPreparedContext(workingState, params.tools, buildOptions)
      : params.budgetContext;
    this.rebaseLedger(this.ledger, budgetContext, workingState);
    this.updateTurnMeta(workingState);
    const decision = this.decide("optimization", this.ledger.total(), now);
    this.logDecision(decision);

    if (!decision.shouldCompact) {
      if (pruned) {
        binding.sinks.applyState?.(presend.composeAppliedState(pruned.state));
        return true;
      }
      return false;
    }

    this.rollbackSnapshot = {
      state: presend.baseState,
      composerText: presend.composerText,
      uploadedFiles: presend.uploadedFiles,
    };
    this.inFlight = true;
    const operationId = this.publishRunning(
      "pre-send",
      workingState.meta.activeSegmentIndex,
      decision,
    );

    const scope = binding.cancellation.deriveScope();
    try {
      const outcome = await runCompaction({
        state: workingState,
        incomingUserText: presend.pendingUserText,
        intent: "optimization",
        contextTokens: decision.totalTokens,
        threshold: decision.threshold,
        providerId: binding.providerId,
        model: binding.model,
        runtime: binding.runtime,
        signal: scope.controller.signal,
        debugLogger: binding.debugLogger,
        complete: binding.complete,
      });

      // apply runs synchronously inside finalizeCheckpoint, so appliedState is definitely
      // assigned before it returns.
      let appliedState!: ConversationViewState;
      await this.finalizeCheckpoint({
        binding,
        trigger: "pre-send",
        state: outcome.state,
        newSegmentIndex: outcome.newSegmentIndex,
        tools: params.tools,
        buildOptions,
        operationId,
        apply: (checkpointState) => {
          appliedState = presend.composeAppliedState(checkpointState);
          // compose going through appendMessagesToConversation clears the revision just stamped.
          // The append only happens in memory and the DB still sits at the moment the checkpoint
          // was persisted, so the CAS token still points at the current DB version; restore it,
          // and the next successful persist will re-stamp.
          const revision = checkpointState.transcript.revision;
          if (revision && !appliedState.transcript.revision) {
            appliedState = {
              ...appliedState,
              transcript: { ...appliedState.transcript, revision },
            };
          }
          binding.sinks.applyState?.(appliedState);
        },
      });
      this.notePostCompactionPressure(
        binding.buildPreparedContext(appliedState, params.tools, buildOptions),
        appliedState,
        decision.threshold,
      );
      return true;
    } catch (error) {
      if (this.isAbortOutcome(scope.controller.signal, error)) {
        throw error;
      }
      this.rollbackSnapshot = null;
      const fallback =
        pruned ?? pruneConversationState(presend.baseState, resolvePruneOptions(this.pressure));
      if (fallback.applied) {
        binding.sinks.applyState?.(presend.composeAppliedState(fallback.state));
        this.settleFailed("pre-send", PRUNE_FALLBACK_NOTICE, operationId);
        binding.sinks.setBridgeToolStatus?.(buildPruneFallbackStatus(fallback.prunedMessageCount));
        return true;
      }
      console.warn(
        "pre-send context compaction failed; continuing with the original context",
        error,
      );
      this.settleFailed(
        "pre-send",
        error instanceof Error ? error.message : String(error),
        operationId,
      );
      return false;
    } finally {
      scope.release();
      this.inFlight = false;
      this.binding?.sinks.setBridgeToolStatus?.(null);
    }
  }

  async compactDuringRun(params: {
    trigger: Exclude<CompactionTrigger, "pre-send">;
    state: ConversationViewState;
    budgetContext?: Context;
    tools?: Context["tools"];
    includeAbortedMessages?: boolean;
    includeUploadedFilesMetadata?: boolean;
    // The manual trigger passes through to the decision: it skips threshold/cooldown, while hard guards are unaffected.
    bypassThresholdAndCooldown?: boolean;
    manualContextUsage?: ManualContextUsageSnapshot;
  }): Promise<CompactionDuringRunResult> {
    const binding = this.binding;
    if (!binding) {
      return { context: null, shouldDisableProtection: false, outcome: "skipped" };
    }
    // Covers the gap where the user hits stop exactly "after a mid-stream abort and before the summarizer starts".
    if (binding.cancellation.userStop.signal.aborted) {
      throw createCompactionAbortError();
    }
    const now = Date.now();
    const buildOptions: ContextBuildOptions = {
      includeAbortedMessages: params.includeAbortedMessages,
      includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
    };
    const buildFallbackContext = (state: ConversationViewState): Context => {
      if (params.trigger !== "mid-stream") {
        return binding.buildPreparedContext(state, params.tools, buildOptions);
      }
      const messages = getActiveSegment(state)?.messages ?? [];
      const lastTimestamp = messages[messages.length - 1]?.timestamp;
      const resumeMessage = createSyntheticContinueUserMessage(
        typeof lastTimestamp === "number" ? lastTimestamp + 1 : now,
      );
      return binding.buildResumeContext(state, resumeMessage, params.tools, {
        includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
      });
    };

    let workingState = params.state;
    let pruned: PruneConversationResult | null = null;
    // manual (idle trigger) does no pre-prune: prune is a mid-run pressure-release measure, and
    // the idle path has no later persist to fall back on, so landing an unpersisted pruned state
    // would fork memory from disk. It also ensures the execution path and the probe (which also
    // does not prune) make their decision on the same state, eliminating divergence between them.
    if (params.trigger !== "manual" && shouldPruneBeforeCompaction(this.pressure, now)) {
      const attempt = pruneConversationState(workingState, resolvePruneOptions(this.pressure));
      if (attempt.applied) {
        pruned = attempt;
        workingState = attempt.state;
      }
    }

    const budgetContext =
      !pruned && params.budgetContext
        ? params.budgetContext
        : binding.buildPreparedContext(workingState, params.tools, buildOptions);
    const manualFixedTokens = params.manualContextUsage?.fixedTokens;
    // rebase validates fixedTokens internally (invalid/undefined falls back to the estimate), so
    // there is no need to branch at the call site.
    this.rebaseLedger(this.ledger, budgetContext, workingState, manualFixedTokens);
    this.updateTurnMeta(workingState);
    // manual is unhurried compaction while idle and uses the optimization basis; mid-run triggers keep protection.
    const intent: CompactionIntent = params.trigger === "manual" ? "optimization" : "protection";
    const totalTokens =
      positiveTokenCount(params.manualContextUsage?.totalTokens) ?? this.ledger.total();
    const decision =
      params.trigger === "manual"
        ? this.decideManual(totalTokens, now)
        : this.decide(intent, totalTokens, now, params.bypassThresholdAndCooldown);
    this.logDecision(decision);

    if (!decision.shouldCompact) {
      if (pruned) {
        binding.sinks.applyStateMidRun?.(pruned.state);
        return {
          context: buildFallbackContext(pruned.state),
          shouldDisableProtection: false,
          outcome: "skipped",
          reason: decision.reason,
        };
      }
      return params.trigger === "mid-stream"
        ? {
            context: buildFallbackContext(workingState),
            shouldDisableProtection: true,
            outcome: "skipped",
            reason: decision.reason,
          }
        : {
            context: null,
            shouldDisableProtection: false,
            outcome: "skipped",
            reason: decision.reason,
          };
    }

    this.rollbackSnapshot = { state: params.state, persistOnRollback: true };
    this.inFlight = true;
    const operationId = this.publishRunning(
      params.trigger,
      workingState.meta.activeSegmentIndex,
      decision,
    );

    const scope = binding.cancellation.deriveScope();
    try {
      const outcome = await runCompaction({
        state: workingState,
        intent,
        contextTokens: decision.totalTokens,
        threshold: decision.threshold,
        providerId: binding.providerId,
        model: binding.model,
        runtime: binding.runtime,
        signal: scope.controller.signal,
        debugLogger: binding.debugLogger,
        complete: binding.complete,
      });

      const { checkpointState } = await this.finalizeCheckpoint({
        binding,
        trigger: params.trigger,
        state: outcome.state,
        newSegmentIndex: outcome.newSegmentIndex,
        tools: params.tools,
        buildOptions,
        fixedTokens: manualFixedTokens,
        operationId,
        apply: (state) => binding.sinks.applyStateMidRun?.(state),
      });

      const resumeMessage = createSyntheticContinueUserMessage(
        (outcome.checkpointMessage.timestamp ?? now) + 1,
      );
      const resumeContext = binding.buildResumeContext(
        checkpointState,
        resumeMessage,
        params.tools,
        {
          includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
        },
      );
      this.notePostCompactionPressure(
        resumeContext,
        checkpointState,
        decision.threshold,
        manualFixedTokens,
      );
      return { context: resumeContext, shouldDisableProtection: false, outcome: "compacted" };
    } catch (error) {
      if (this.isAbortOutcome(scope.controller.signal, error)) {
        throw error;
      }
      this.rollbackSnapshot = null;
      // manual targets an idle conversation: no later turn consumes the fallback context, and the
      // prune result is not persisted either (applying it would fork memory from disk), so on
      // failure the conversation must be preserved as-is.
      if (params.trigger !== "manual") {
        const fallback =
          pruned ?? pruneConversationState(workingState, resolvePruneOptions(this.pressure));
        if (fallback.applied) {
          binding.sinks.applyStateMidRun?.(fallback.state);
          this.settleFailed(params.trigger, PRUNE_FALLBACK_NOTICE, operationId);
          binding.sinks.setBridgeToolStatus?.(
            buildPruneFallbackStatus(fallback.prunedMessageCount),
          );
          return {
            context: buildFallbackContext(fallback.state),
            shouldDisableProtection: false,
            outcome: "failed",
          };
        }
      }
      this.settleFailed(
        params.trigger,
        (error instanceof Error ? error.message : String(error)) || "compaction failed",
        operationId,
      );
      return params.trigger === "mid-stream"
        ? {
            context: buildFallbackContext(workingState),
            shouldDisableProtection: true,
            outcome: "failed",
          }
        : { context: null, shouldDisableProtection: false, outcome: "failed" };
    } finally {
      scope.release();
      this.inFlight = false;
      this.binding?.sinks.setBridgeToolStatus?.(null);
    }
  }

  /**
   * User-triggered manual compaction (usage ring → confirm). Idle only: if a turn is already
   * bound or a compaction is in flight, returns "busy". It temporarily binds a turn to reuse the
   * compactDuringRun main flow; the decision skips the automatic threshold and cooldown but still
   * enforces the shared 50% manual threshold and hard guards such as disabled / no-active-messages
   * (if a guard does not pass it returns "skipped").
   */
  async compactManually(
    binding: Omit<CompactionTurnBinding, "presend">,
    state: ConversationViewState,
    contextUsage?: ManualContextUsageSnapshot,
    options?: {
      // Tool set with the same arguments as the real request: without tool weight, the checkpoint estimate is systematically low.
      tools?: Context["tools"];
      // Called synchronously exactly once after the probe passes and before compaction actually
      // begins (not triggered on skip / busy).
      onProceed?: () => void;
    },
  ): Promise<ManualCompactionOutcome> {
    if (this.binding || this.inFlight) return { status: "busy" };
    this.bindTurn(binding);
    try {
      const probe = this.probeManualDecision(binding, state, contextUsage, options?.tools);
      if (!probe.shouldCompact) {
        // in-flight has already been ruled out by the entry busy check (bindTurn just reset
        // inFlight), so a probe rejection can only be a hard guard such as disabled /
        // no-active-messages / below-manual-threshold.
        return { status: "skipped", reason: probe.reason };
      }
      options?.onProceed?.();
      const result = await this.compactDuringRun({
        trigger: "manual",
        state,
        tools: options?.tools,
        manualContextUsage: contextUsage,
      });
      // Trust only this call's explicit outcome: statusPhase may hold the previous compaction's
      // terminal state, and the inner second decision publishes no status when it skips.
      switch (result.outcome) {
        case "compacted":
          return { status: "compacted" };
        case "skipped":
          // The binding always exists, so an inner skip always carries a decision reason; the
          // fallback is only for type completeness.
          return { status: "skipped", reason: result.reason ?? "disabled" };
        default:
          return { status: "failed" };
      }
    } catch {
      // Abort or unexpected exception: run the unified cleanup (roll back the snapshot / reset the
      // running state to idle).
      await this.handleTurnAbort();
      return binding.cancellation.userStop.signal.aborted
        ? { status: "failed", aborted: true }
        : { status: "failed" };
    } finally {
      this.unbindTurn();
    }
  }

  // Pre-probe for manual compaction: run a decision using the same basis as the execution path,
  // blocking the manual 50% threshold and hard guards such as disabled before publishRunning.
  // Readings are computed with a local temporary ledger — the shared ledger is the source of truth
  // for the usage ring, and a rejected probe must leave no residue on it.
  private probeManualDecision(
    binding: Omit<CompactionTurnBinding, "presend">,
    state: ConversationViewState,
    contextUsage?: ManualContextUsageSnapshot,
    tools?: Context["tools"],
  ) {
    const probeLedger = new TokenLedger();
    this.rebaseLedger(
      probeLedger,
      binding.buildPreparedContext(state, tools),
      state,
      contextUsage?.fixedTokens,
    );
    // turnMeta is an idempotent derivation from state (needed by decide's hard guards), so
    // updating it carries no residue risk.
    this.updateTurnMeta(state);
    return this.decideManual(
      positiveTokenCount(contextUsage?.totalTokens) ?? probeLedger.total(),
      Date.now(),
    );
  }

  private decideManual(totalTokens: number, now: number): CompactionDecision {
    const decision = this.decide("optimization", totalTokens, now, true);
    if (!decision.shouldCompact) return decision;
    if (canManualCompact(contextUsageRatio(decision.totalTokens, decision.contextWindow))) {
      return decision;
    }
    return { ...decision, shouldCompact: false, reason: "below-manual-threshold" };
  }

  // Unified cleanup after a user abort: if a snapshot exists, roll back (restore state/composer/
  // optional persistence) and return true.
  async handleTurnAbort(): Promise<boolean> {
    const binding = this.binding;
    const snapshot = this.rollbackSnapshot;
    this.rollbackSnapshot = null;
    this.inFlight = false;
    this.settleAbortedIfRunning();
    if (!binding) return false;

    if (!snapshot) return false;

    binding.sinks.applyStateMidRun?.(snapshot.state);
    binding.sinks.setBridgeToolStatus?.(null, false);
    binding.sinks.restoreComposer?.(snapshot.composerText, snapshot.uploadedFiles ?? []);
    if (snapshot.persistOnRollback) {
      await binding.sinks.persistRollback?.(snapshot.state);
    }
    return true;
  }

  private updateTurnMeta(state: ConversationViewState) {
    const segment = getActiveSegment(state);
    const messages = segment?.messages ?? [];
    let userMessageCount = 0;
    for (const message of messages) {
      if (message.role === "user") userMessageCount += 1;
    }
    this.turnMeta = {
      activeMessageCount: messages.length,
      userMessageCount,
      lastSummaryAt: segment?.summary?.timestamp ?? 0,
    };
  }

  private decide(
    intent: CompactionIntent,
    totalTokens: number,
    now = Date.now(),
    bypassThresholdAndCooldown?: boolean,
  ) {
    const binding = this.binding;
    if (!binding) {
      throw new Error("compaction decision requested without an active turn binding");
    }
    this.pressure = normalizeCompactionPressure(this.pressure, now);
    return decideCompaction({
      intent,
      totalTokens,
      modelConfig: binding.runtime.modelConfig,
      activeMessageCount: this.turnMeta.activeMessageCount,
      userMessageCount: this.turnMeta.userMessageCount,
      lastCompactionAt: Math.max(this.turnMeta.lastSummaryAt, this.pressure.lastCompactionAt),
      pressure: this.pressure,
      inFlight: this.inFlight,
      now,
      bypassThresholdAndCooldown,
    });
  }

  private notePostCompactionPressure(
    contextAfter: Context,
    stateAfter: ConversationViewState,
    threshold: number,
    fixedTokens?: number,
  ) {
    // stateAfter already carries the just-written-back contextTokensAfter: the post-compaction
    // ledger reading starts from the checkpoint authority value rather than recomputing a possibly
    // lower estimate.
    this.rebaseLedger(this.ledger, contextAfter, stateAfter, fixedTokens);
    this.updateTurnMeta(stateAfter);
    this.pressure = notePressureAfterCompaction(this.pressure, {
      totalTokensAfter: this.ledger.total(),
      threshold,
      now: Date.now(),
    });
  }

  private isAbortOutcome(scopeSignal: AbortSignal, error: unknown) {
    return (
      this.binding?.cancellation.userStop.signal.aborted ||
      scopeSignal.aborted ||
      isAbortLikeError(error)
    );
  }

  private publishStatus(status: CompactionStatus) {
    this.statusPhase = status.phase;
    this.binding?.sinks.publishStatus?.(status);
  }

  private publishRunning(
    trigger: CompactionTrigger,
    sourceSegmentIndex: number,
    decision: CompactionDecision,
  ): number {
    const operationId = ++this.nextObservedOperationId;
    this.observedOperationId = operationId;
    this.observedTrigger = trigger;
    this.observedTokensBefore = decision.totalTokens;
    this.notifyObserver(() =>
      this.observer?.onStart({ trigger, tokensBefore: decision.totalTokens }),
    );
    this.publishStatus({
      phase: "running",
      trigger,
      startedAt: Date.now(),
      sourceSegmentIndex,
    });
    this.binding?.sinks.setBridgeToolStatus?.(
      buildCompactionRunningStatus(decision, this.pressure),
      true,
    );
    return operationId;
  }

  private settleCompleted(
    trigger: CompactionTrigger,
    newSegmentIndex: number,
    operationId: number,
  ) {
    // A prior abort/unbind may already have closed this interval while the async summarizer
    // was unwinding. Late completion is then operationally stale and must not emit a second end.
    if (this.observedTrigger !== trigger || this.observedOperationId !== operationId) return;
    this.notifyObserver(() =>
      this.observer?.onEnd({
        trigger,
        status: "complete",
        ...(this.observedTokensBefore === undefined
          ? {}
          : { tokensBefore: this.observedTokensBefore }),
        ...(this.observedTokensAfter === undefined
          ? {}
          : { tokensAfter: this.observedTokensAfter }),
        newSegmentIndex,
      }),
    );
    this.clearObservedCompaction();
    this.publishStatus({
      phase: "completed",
      trigger,
      newSegmentIndex,
      completedAt: Date.now(),
    });
  }

  private settleFailed(trigger: CompactionTrigger, message: string, operationId: number) {
    if (this.observedTrigger !== trigger || this.observedOperationId !== operationId) return;
    this.notifyObserver(() =>
      this.observer?.onEnd({
        trigger,
        status: "error",
        ...(this.observedTokensBefore === undefined
          ? {}
          : { tokensBefore: this.observedTokensBefore }),
        error: message,
      }),
    );
    this.clearObservedCompaction();
    this.publishStatus({ phase: "failed", trigger, failedAt: Date.now(), message });
  }

  private settleAbortedIfRunning(): boolean {
    const trigger = this.observedTrigger;
    if (trigger === undefined) {
      if (this.statusPhase === "running") this.publishStatus({ phase: "idle" });
      return false;
    }
    this.notifyObserver(() =>
      this.observer?.onEnd({
        trigger,
        status: "aborted",
        ...(this.observedTokensBefore === undefined
          ? {}
          : { tokensBefore: this.observedTokensBefore }),
      }),
    );
    this.clearObservedCompaction();
    this.publishStatus({ phase: "idle" });
    return true;
  }

  private assertObservedOperation(operationId: number) {
    if (this.observedOperationId !== operationId) throw createCompactionAbortError();
  }

  private clearObservedCompaction() {
    this.observedOperationId = undefined;
    this.observedTrigger = undefined;
    this.observedTokensBefore = undefined;
    this.observedTokensAfter = undefined;
  }

  /** The observer is a diagnostic channel; its throwing must never crash the main compaction path. */
  private notifyObserver(run: () => void) {
    try {
      run();
    } catch (error) {
      console.warn("[compaction] observer threw; compaction is unaffected", error);
    }
  }

  private logDecision(decision: CompactionDecision) {
    this.binding?.debugLogger?.logResult({
      event: "compaction_decision",
      intent: decision.intent,
      reason: decision.reason,
      shouldCompact: decision.shouldCompact,
      totalTokens: decision.totalTokens,
      threshold: decision.threshold,
      contextWindow: decision.contextWindow,
      maxOutputToken: decision.maxOutputToken,
      pressure: this.pressure,
      ledger: this.ledger.snapshot(),
    });
  }
}

export type CompactionControllerRegistry = {
  get: (conversationId: string) => CompactionController;
  dispose: (conversationId: string) => void;
};

export function createCompactionControllerRegistry(): CompactionControllerRegistry {
  const controllers = new Map<string, CompactionController>();
  return {
    get(conversationId: string) {
      const key = conversationId.trim();
      const existing = controllers.get(key);
      if (existing) return existing;
      const created = new CompactionController();
      controllers.set(key, created);
      return created;
    },
    dispose(conversationId: string) {
      controllers.delete(conversationId.trim());
    },
  };
}
