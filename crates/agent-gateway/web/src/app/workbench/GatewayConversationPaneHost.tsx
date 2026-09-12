// Unified host for conversation Panes — mirrors the desktop
// RestorableConversationPaneHost:
// Every Pane always mounts the same component; a focus change only swaps the
// primary/background binding, never tearing down the host.
// Send/stop/queue/upload/approval are routed by this Pane's conversationId;
// page-level operations such as model selection, queue item editing and
// resend-from-body go through focusGuard first on a background Pane. Primary
// attaches its own input box to the page composerRef and writes unsent drafts
// back to the cache on unmount.

import {
  type ChangedFilesActions,
  ChangedFilesActionsProvider,
} from "@liveagent/ui/components/chat/ChangedFilesCard";
import type {
  ClarifyContext,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import { TaskProgressBar } from "@liveagent/ui/components/chat/TaskProgressBar";
import { ToolApprovalBar } from "@liveagent/ui/components/chat/ToolApprovalBar";
import { ChevronDown, Loader2 } from "@liveagent/ui/components/IconSet";
import { TrajectoryView } from "@liveagent/ui/components/trajectory/TrajectoryView";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type CheckpointRewindClient,
  CheckpointRewindProvider,
  type CheckpointRewoundInfo,
} from "@liveagent/ui/lib/chat/checkpointRewind";
import { deriveContextUsageTokens } from "@liveagent/ui/lib/chat/contextUsage";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import { selectLatestTaskProgress } from "@liveagent/ui/lib/chat/taskProgress";
import {
  readToolApprovalDeadlineAt,
  readToolApprovalPending,
  readToolApprovalSummary,
} from "@liveagent/ui/lib/chat/toolApprovalArgs";
import {
  mergePendingUploadedFiles,
  type PendingUploadedFile,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import { toTrajectoryMessages } from "@liveagent/ui/lib/trajectory/transcriptMessages";
import {
  ChatComposerBar,
  type ChatComposerBarProps,
  type ChatQueueTurnPreview,
  type ContextUsageTokensSource,
} from "@liveagent/ui/pages/chat/ChatComposerBar";
import { CHAT_TRANSCRIPT_WIDTH_CSS_VAR } from "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls";
import {
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { createGatewayTrajectoryHost } from "@/agent-ui-adapters/trajectory";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import { executeClarifyPromptTurn } from "@/lib/chat/clarifyPromptTurn";
import { trimLeadingHeadlessEntries } from "@/lib/chat/historyWindow";
import type { TranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import { submitToolApprovalDecision } from "@/lib/chat/toolApprovalBridge";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";
import { parseHistoryMessagesJsonAsync } from "@/lib/historyParser";
import { toModelValue } from "@/lib/providers/llm";
import {
  type AppSettings,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  isThinkingAlwaysOnForModel,
  normalizeChatRuntimeControlsForProvider,
  type SelectedModel,
} from "@/lib/settings";
import {
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
  subscribeLiveTrajectory,
} from "@/lib/trajectory/liveTrajectory";
import type { SectionId } from "@/pages/settings/types";
import { ConversationStatsBarHost } from "../ConversationStatsBarHost";
import {
  HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
  HISTORY_DETAIL_LOAD_EARLIER_PAGE_MESSAGES,
} from "../constants";
import { isLocalDraftConversationId } from "../gatewayLocalDraft";
import type { SendChatFn } from "../types";
import { resolveWorkbenchComposerInputDisabled } from "./composerInputState";

type ChatQueueSnapshotLike = Parameters<
  Parameters<GatewayWebSocketClient["subscribeChatQueue"]>[0]
>[0];

/**
 * Page-level shared context: one instance shared by all background conversation
 * Panes, rebuilt every frame inside the GatewayAppView render body (not memoized
 * — the host reads the latest value through contextRef and does not depend on
 * reference stability; true stabilization would first require converting the
 * whole upstream handler chain to useCallback, deferred until performance
 * convergence). Function fields are always explicitly routed by conversationId
 * and never rely on the "currently displayed conversation".
 */
export type GatewayConversationPaneHostContext = {
  api: GatewayWebSocketClient;
  registry: TranscriptStoreRegistry;
  settings: AppSettings;
  hasModels: boolean;
  showUsage: boolean;
  /** Page-level input disabled (history loading/compaction) — applies only to the primary Pane. */
  isInputDisabled: boolean;
  /** Transport-level disabled (offline/incompatible protocol) — background Panes must block sending too. */
  transportInputDisabled: boolean;
  inputPlaceholder: string;
  modelOptions: ChatComposerBarProps["modelOptions"];
  enabledSkills: ChatComposerBarProps["enabledSkills"];
  mentionableConversations: ChatComposerBarProps["mentionableConversations"];
  searchMentionableConversations: ChatComposerBarProps["searchMentionableConversations"];
  mentionApps: ChatComposerBarProps["mentionApps"];
  contextDisplayMode: ChatComposerBarProps["contextDisplayMode"];
  commandSafetyMode: ChatComposerBarProps["commandSafetyMode"];
  onCommandSafetyModeChange: ChatComposerBarProps["onCommandSafetyModeChange"];
  gitClient: ChatComposerBarProps["gitClient"];
  gitWriteEnabled: boolean;
  gitDisabledMessage: string | undefined;
  workspaceActivityClient: ChatComposerBarProps["workspaceActivityClient"];
  onOpenWorktree: ChatComposerBarProps["onOpenWorktree"];
  onWorktreeRemoved: ChatComposerBarProps["onWorktreeRemoved"];
  openSettings: (section?: SectionId, providerId?: string) => void;
  onOpenFileLink: Parameters<typeof GatewayTranscript>[0]["onOpenFileLink"];
  onLoadUploadedImagePreview: ChatComposerBarProps["onLoadUploadedImagePreview"];
  transcriptContentWidth: number;
  selectionForConversation: (conversationId: string) => SelectedModel | undefined;
  workdirForConversation: (conversationId: string) => string;
  isConversationBusy: (conversationId: string) => boolean;
  sendChat: SendChatFn;
  cancelChat: (conversationId: string) => Promise<void> | void;
  materializeComposerDraftForSend: (
    draft: MentionComposerDraft,
    files: PendingUploadedFile[],
    workdir: string,
    targetConversationId?: string,
  ) => Promise<{
    text: string;
    uploadedFiles: PendingUploadedFile[];
    referencedConversations: ConversationMentionReference[];
  }>;
  /** Conversation id owning an in-flight import: upload disabling/animation applies only to the target conversation's Pane. */
  uploadingConversationId: string | null;
  getPendingUploads: (conversationId: string) => PendingUploadedFile[];
  subscribePendingUploads: (listener: () => void) => () => void;
  updatePendingUploads: (
    conversationId: string,
    updater: (current: PendingUploadedFile[]) => PendingUploadedFile[],
  ) => PendingUploadedFile[];
  importFilesForConversation: (
    conversationId: string,
    workdir: string,
    files: File[],
  ) => Promise<void>;
  getCachedComposerDraft: (conversationId: string) => MentionComposerDraft | undefined;
  setCachedComposerDraft: (conversationId: string, draft: MentionComposerDraft) => void;
  notifyError: (message: string) => void;
  trajectoryHost: ReturnType<typeof createGatewayTrajectoryHost>;
};

export type GatewayConversationPrimarySurface = {
  isSending: boolean;
  isUploadingFiles: boolean;
  isInputDisabled: boolean;
  onSend: () => void;
  onStop: () => void;
  onSelectModel: ChatComposerBarProps["onSelectModel"];
  onSelectExecutionMode: ChatComposerBarProps["onSelectExecutionMode"];
  onChatRuntimeControlsChange: ChatComposerBarProps["onChatRuntimeControlsChange"];
  onPrepareChatRuntime: ChatComposerBarProps["onPrepareChatRuntime"];
  onComposerBusyChange: ChatComposerBarProps["onComposerBusyChange"];
  onPickReadableFiles: ChatComposerBarProps["onPickReadableFiles"];
  onPickWorkspaceFolder: ChatComposerBarProps["onPickWorkspaceFolder"];
  onPasteFiles: ChatComposerBarProps["onPasteFiles"];
  loadHistoryPrompts: ChatComposerBarProps["loadHistoryPrompts"];
  pendingUploadedFiles: PendingUploadedFile[];
  onRemovePendingUpload: ChatComposerBarProps["onRemovePendingUpload"];
  queuedTurns: ChatQueueTurnPreview[];
  onRunQueuedTurnNow: ChatComposerBarProps["onRunQueuedTurnNow"];
  onMoveQueuedTurnUp: ChatComposerBarProps["onMoveQueuedTurnUp"];
  onEditQueuedTurn: ChatComposerBarProps["onEditQueuedTurn"];
  onRemoveQueuedTurn: ChatComposerBarProps["onRemoveQueuedTurn"];
  onManualCompactConfirm: ChatComposerBarProps["onManualCompactConfirm"];
  manualCompactBlocked: boolean;
  approvalBar: ReactNode;
  taskProgressBar: ReactNode;
  statsBar: ReactNode;
  fileDropOverlay: ReactNode;
  transcriptExtras: ReactNode;
  stageRef?: MutableRefObject<HTMLElement | null>;
  setTranscriptScrollAreaRoot?: (node: HTMLDivElement | null) => void;
  setTranscriptViewport?: (node: HTMLDivElement | null) => void;
  isViewportFollowing?: () => boolean;
  viewportFollowing?: boolean;
  onJumpToBottom?: () => void;
  navRef?: Parameters<typeof GatewayTranscript>[0]["navRef"];
  onAnchorUserRowChange?: Parameters<typeof GatewayTranscript>[0]["onAnchorUserRowChange"];
  onResendFromEdit: Parameters<typeof GatewayTranscript>[0]["onResendFromEdit"];
  onBranchConversation: Parameters<typeof GatewayTranscript>[0]["onBranchConversation"];
  branchPendingMessageId: string | null;
  onSuggestionSelect: Parameters<typeof GatewayTranscript>[0]["onSuggestionSelect"];
  suggestionsDisabled: boolean;
  hasMoreHistory: boolean;
  isLoadingMoreHistory: boolean;
  onLoadEarlierHistory?: () => void;
  isLoading: boolean;
  loadingTitle?: string;
  transcriptError?: string | null;
  changedFilesActions: ChangedFilesActions;
  checkpoint: {
    client: CheckpointRewindClient;
    disabled: boolean;
    resolveAuthorizedRoots: () => string[] | Promise<string[]>;
    onRewound: (info: CheckpointRewoundInfo) => void;
  };
};

export type GatewayConversationPaneHostProps = {
  paneId: string;
  conversationId: string;
  context: GatewayConversationPaneHostContext;
  /** Whether this Pane carries the page's current conversation (primary binding). A focus change does not tear down the host. */
  isPrimary: boolean;
  /** focusGuard exit: page-level operations focus this Pane first. */
  onFocusPane: () => void;
  /** Page composerRef: the primary Pane attaches its own input box to it. */
  pageComposerRef?: MutableRefObject<MentionComposerHandle | null>;
  primary?: GatewayConversationPrimarySurface;
  blockedMessage?: string | null;
  /** This Pane's independent conversation/trajectory view (one per conversation, so background Panes keep theirs too). */
  trajectoryActive?: boolean;
};

export function GatewayConversationPaneHost(props: GatewayConversationPaneHostProps) {
  const {
    paneId,
    conversationId,
    context,
    isPrimary,
    onFocusPane,
    pageComposerRef,
    primary,
    blockedMessage,
    trajectoryActive = false,
  } = props;
  const { api, registry } = context;
  // Some functions in context (sendChat, etc.) are new references on every
  // render; any effect that runs per conversationId reads through a ref to
  // avoid identity churn triggering spurious resets.
  const contextRef = useRef(context);
  contextRef.current = context;
  const { t } = useLocale();
  const isDraft = isLocalDraftConversationId(conversationId);
  const store = registry.get(conversationId);

  // ---- Data layer: independent stream subscription + one-shot tail hydration
  // The primary's stream is held in the same store by the page-level
  // useConversationChat; background Panes subscribe on their own. When isPrimary
  // flips the effect reruns, ensuring that after "a later subscription replaces
  // the earlier one" a background Pane can reconnect its stream.
  useEffect(() => {
    if (isDraft || isPrimary) return;
    return api.subscribeConversationStream(conversationId, {
      onSync: (result) => store.applySync(result),
      onEvent: (event) => store.applyEvent(event),
    });
  }, [api, conversationId, isDraft, isPrimary, store]);

  const [hydrated, setHydrated] = useState(isDraft);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const loadedMaxMessagesRef = useRef(HISTORY_DETAIL_INITIAL_MAX_MESSAGES);
  const historyConversationIdRef = useRef(conversationId);
  historyConversationIdRef.current = conversationId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation identity is the reset trigger; the effect intentionally does not read it.
  useEffect(() => {
    loadedMaxMessagesRef.current = HISTORY_DETAIL_INITIAL_MAX_MESSAGES;
    setHasMoreHistory(false);
  }, [conversationId]);
  useEffect(() => {
    if (isDraft || isPrimary) {
      setHydrated(true);
      return;
    }
    if (store.getSnapshot().rows.length > 0) {
      setHydrated(true);
      return;
    }
    let cancelled = false;
    setHydrated(false);
    void (async () => {
      try {
        const detail = await api.getHistory(conversationId, {
          maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
        });
        if (cancelled) return;
        const parsed = await parseHistoryMessagesJsonAsync(detail.messages_json);
        if (cancelled) return;
        const entries = detail.has_more === true ? trimLeadingHeadlessEntries(parsed) : parsed;
        const mode = store.getSnapshot().rows.length > 0 ? "enrich" : "replace";
        store.applyHistorySnapshot(entries, { mode });
        setHasMoreHistory(detail.has_more === true);
      } catch {
        // On history read failure, degrade to a live-only view; once focused,
        // the main view re-fetches.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, conversationId, isDraft, isPrimary, store]);

  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef(false);
  const handleLoadEarlierHistory = useCallback(() => {
    if (isDraft || loadingEarlierRef.current) return;
    const requestedConversationId = conversationId;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    const nextMax = loadedMaxMessagesRef.current + HISTORY_DETAIL_LOAD_EARLIER_PAGE_MESSAGES;
    void (async () => {
      try {
        const detail = await api.getHistory(requestedConversationId, { maxMessages: nextMax });
        if (historyConversationIdRef.current !== requestedConversationId) return;
        const parsed = await parseHistoryMessagesJsonAsync(detail.messages_json);
        if (historyConversationIdRef.current !== requestedConversationId) return;
        const entries = detail.has_more === true ? trimLeadingHeadlessEntries(parsed) : parsed;
        store.applyHistorySnapshot(entries, { mode: "enrich" });
        loadedMaxMessagesRef.current = nextMax;
        setHasMoreHistory(detail.has_more === true);
      } catch {
        // On fetch failure keep the current state; the button allows a retry.
      } finally {
        if (historyConversationIdRef.current === requestedConversationId) {
          loadingEarlierRef.current = false;
          setLoadingEarlier(false);
        }
      }
    })();
  }, [api, conversationId, isDraft, store]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation identity cancels the previous pane's loading indicator; the effect intentionally does not read it.
  useEffect(() => {
    loadingEarlierRef.current = false;
    setLoadingEarlier(false);
  }, [conversationId]);

  const subscribeTranscript = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getTranscript = useCallback(() => store.getSnapshot(), [store]);
  const transcript = useSyncExternalStore(subscribeTranscript, getTranscript, getTranscript);
  const paneTrajectoryMessages = useMemo(
    () => toTrajectoryMessages(transcript.rows),
    [transcript.rows],
  );
  const liveTrajectory = useSyncExternalStore(subscribeLiveTrajectory, () =>
    isDraft ? null : liveTrajectoryEvents(conversationId),
  );
  const trajectoryAuthoritativeRevision = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryAuthoritativeRevision(conversationId),
  );

  // ---- Per-conversation queue: subscribe to queue snapshots relayed by the
  // gateway, using a monotonically increasing revision to drop stale ones ----
  const [queuedTurns, setQueuedTurns] = useState<ChatQueueTurnPreview[]>([]);
  const queuedTurnsRef = useRef<ChatQueueTurnPreview[]>([]);
  const queueRevisionRef = useRef(0);
  const applyQueueSnapshot = useCallback(
    (snapshot: ChatQueueSnapshotLike | null | undefined) => {
      if (!snapshot || snapshot.conversationId !== conversationId) return;
      const revision = Number(snapshot.revision ?? 0);
      if (revision < queueRevisionRef.current) return;
      queueRevisionRef.current = revision;
      const items = snapshot.items.map((item) => ({
        id: item.id,
        previewText: item.previewText,
        fileCount: item.fileCount,
      }));
      queuedTurnsRef.current = items;
      setQueuedTurns(items);
    },
    [conversationId],
  );
  useEffect(() => {
    if (isDraft) return;
    queueRevisionRef.current = 0;
    queuedTurnsRef.current = [];
    setQueuedTurns([]);
    let cancelled = false;
    const unsubscribe = api.subscribeChatQueue(applyQueueSnapshot);
    void api
      .chatQueueGet(conversationId)
      .then((response) => {
        if (!cancelled) applyQueueSnapshot(response.snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, applyQueueSnapshot, conversationId, isDraft]);

  // Queue operations go straight to the gateway RPC with this conversation id
  // (equivalent to the desktop's per-conversation routing); editing a queue item
  // needs the page-level editing conversation, so as on the desktop this Pane is
  // focused first.
  const handleRunQueuedTurnNow = useCallback(
    (id: string) => {
      void api
        .chatQueueRunNow(conversationId, id)
        .then((response) => applyQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyQueueSnapshot, conversationId],
  );
  const handleMoveQueuedTurnUp = useCallback(
    (id: string) => {
      void api
        .chatQueueMove(conversationId, id, "up")
        .then((response) => applyQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyQueueSnapshot, conversationId],
  );
  const handleRemoveQueuedTurn = useCallback(
    (id: string) => {
      void api
        .chatQueueRemove(conversationId, id)
        .then((response) => applyQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyQueueSnapshot, conversationId],
  );

  // ---- Per-conversation pending attachments: subscribe directly to the
  // page-level per-conversation store ----
  // Document-level paste/drop can write into a background conversation; the
  // subscription ensures chips and sending read the same authoritative snapshot,
  // no longer relying on a manual mirror refresh after the Pane's own actions.
  const pendingUploads = useSyncExternalStore(
    context.subscribePendingUploads,
    () => context.getPendingUploads(conversationId),
    () => context.getPendingUploads(conversationId),
  );

  // ---- Send/stop: routed strictly by this Pane's conversationId (desktop semantics) ----
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const sendInFlightRef = useRef(false);
  const workdir = context.workdirForConversation(conversationId);
  const workdirRef = useRef(workdir);
  workdirRef.current = workdir;
  const selection = context.selectionForConversation(conversationId);
  const selectedProvider = selection
    ? context.settings.customProviders.find((item) => item.id === selection.customProviderId)
    : undefined;
  const paneRuntimeControls = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(context.settings.chatRuntimeControls, {
        providerId: selectedProvider?.type,
        requestFormat: selectedProvider?.requestFormat,
        modelId: selection?.model,
      }),
    [
      context.settings.chatRuntimeControls,
      selectedProvider?.requestFormat,
      selectedProvider?.type,
      selection?.model,
    ],
  );
  const paneReasoningOptions = useMemo(
    () =>
      getChatRuntimeReasoningLevelsForProvider({
        providerId: selectedProvider?.type,
        requestFormat: selectedProvider?.requestFormat,
        modelId: selection?.model,
      }),
    [selectedProvider?.requestFormat, selectedProvider?.type, selection?.model],
  );
  const paneThinkingAlwaysOn = useMemo(
    () => isThinkingAlwaysOnForModel(selectedProvider?.type ?? "claude_code", selection?.model),
    [selectedProvider?.type, selection?.model],
  );

  // Prompt clarification executor (desktop background Pane semantics): model
  // override/fallback/error flattening lives in executeClarifyPromptTurn (shared
  // by both hosts), with the fallback resolved by this Pane's conversation.
  // runTurn uses a latest-ref inside useClarifySession, so dependency changes
  // only swap identity without interrupting the session.
  const runClarifyTurn = useCallback<RunClarifyTurn>(
    (messages, _signal, onTextDelta) =>
      executeClarifyPromptTurn(
        context.api,
        context.settings,
        {
          provider: selectedProvider,
          model: selection?.model,
          runtimeControls: paneRuntimeControls,
        },
        messages,
        onTextDelta,
      ),
    [context, selection, selectedProvider, paneRuntimeControls],
  );
  // Consistent with the desktop: when the conversation has no workdir, pass no
  // empty string, avoiding noise in the system prompt.
  const clarifyContext = useMemo<ClarifyContext | undefined>(
    () => (workdir ? { workdir } : undefined),
    [workdir],
  );

  const isRunning = transcript.activeRun !== null || context.isConversationBusy(conversationId);
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;

  const handleSend = useCallback(() => {
    if (sendInFlightRef.current || context.transportInputDisabled) return;
    // Do not send while this conversation's attachment import has not yet been
    // committed: at that moment getPendingUploads reads an empty list and the
    // message would lose its attachments (same boundary as the main Pane's
    // uploading-disable).
    if (context.uploadingConversationId === conversationId) return;
    const composer = composerRef.current;
    const draft = composer?.getDraft() ?? null;
    sendInFlightRef.current = true;
    void (async () => {
      try {
        const files = context.getPendingUploads(conversationId).slice();
        let text: string;
        let uploadedFiles: PendingUploadedFile[];
        let referencedConversations = draft?.conversationMentions ?? [];
        try {
          const materialized = draft
            ? await context.materializeComposerDraftForSend(
                draft,
                files,
                workdirRef.current,
                conversationId,
              )
            : { text: "", uploadedFiles: files, referencedConversations: [] };
          text = materialized.text;
          uploadedFiles = materialized.uploadedFiles;
          referencedConversations = materialized.referencedConversations;
        } catch (error) {
          context.notifyError(
            error instanceof Error ? error.message : "Failed to import large pasted content",
          );
          return;
        }
        if (!text && uploadedFiles.length === 0) return;
        composerRef.current?.clear();
        context.updatePendingUploads(conversationId, () => []);
        // Enqueue when busy (consistent with the desktop background Pane's
        // enqueue): the queue panel holds the prompt and no optimistic
        // transcript echo is made; when idle, send directly.
        const busy = isRunningRef.current || queuedTurnsRef.current.length > 0;
        const restore = () => {
          context.updatePendingUploads(conversationId, (current) =>
            mergePendingUploadedFiles(current, uploadedFiles),
          );
          const currentComposer = composerRef.current;
          if (draft && currentComposer && !currentComposer.hasContent()) {
            currentComposer.setDraft(draft);
          }
        };
        try {
          const outcome = await context.sendChat(text, {
            conversationId,
            uploadedFiles,
            referencedConversations,
            runtimeControls: paneRuntimeControls,
            ...(busy ? { queuePolicy: "append" as const, optimisticEcho: false } : {}),
          });
          if (outcome?.kind === "failed") restore();
        } catch {
          restore();
        }
      } finally {
        sendInFlightRef.current = false;
      }
    })();
  }, [context, conversationId, paneRuntimeControls]);

  const handleStop = useCallback(() => {
    // Consistent with the desktop/focused stage: with queued turns, first
    // "stop the current one and run the next", otherwise just stop.
    const nextQueuedTurn = queuedTurnsRef.current[0];
    if (nextQueuedTurn) {
      handleRunQueuedTurnNow(nextQueuedTurn.id);
      return;
    }
    void context.cancelChat(conversationId);
  }, [context, conversationId, handleRunQueuedTurnNow]);

  // ---- Draft: restore the cache on mount, write back to the cache on unmount
  // (focus change / Pane close) (desktop semantics) ----
  // hydrated must participate in the trigger: on a background Pane's cold start
  // a loading placeholder renders first, the composer is not yet mounted, and
  // the restore would be silently skipped; rerunning once after hydration
  // actually writes the cached draft into the input box.
  useLayoutEffect(() => {
    if (!hydrated) return;
    const composer = composerRef.current;
    const cached = contextRef.current.getCachedComposerDraft(conversationId);
    if (cached) {
      composer?.setDraft(cached);
    } else {
      composer?.clear();
    }
    return () => {
      // Only write back non-empty drafts: an empty input box must not delete the
      // cached draft (the focused stage's restore path still needs it),
      // consistent with the desktop ConversationPaneHost unmount semantics.
      const nextDraft = composerRef.current?.getDraft();
      if (!nextDraft || nextDraft.isEmpty || !nextDraft.text.trim()) return;
      contextRef.current.setCachedComposerDraft(conversationId, nextDraft);
    };
  }, [conversationId, hydrated]);

  useLayoutEffect(() => {
    if (!isPrimary || !pageComposerRef) return;
    // Assign on attach only. Nulling on detach is order-dependent: the
    // outgoing primary's cleanup can run after the incoming assign (or
    // assign null while this pane's composer is still mounting) and leave
    // Enter reading an empty page composer.
    if (composerRef.current) pageComposerRef.current = composerRef.current;
  });

  // ---- Transcript scroll following: auto-follow when pinned to the bottom,
  // released when the user scrolls up, with one-click return to bottom ----
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const detachScrollRef = useRef<(() => void) | null>(null);
  const setViewport = useCallback((element: HTMLDivElement | null) => {
    detachScrollRef.current?.();
    detachScrollRef.current = null;
    viewportRef.current = element;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    const handleScroll = () => {
      const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      followingRef.current = nearBottom;
      setFollowing(nearBottom);
    };
    element.addEventListener("scroll", handleScroll, { passive: true });
    detachScrollRef.current = () => element.removeEventListener("scroll", handleScroll);
  }, []);
  useEffect(() => () => detachScrollRef.current?.(), []);
  const rowCount = transcript.rows.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: pin to bottom according to follow state when row count/revision changes; the effect body does not read them directly.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followingRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [rowCount, transcript.revision]);
  const jumpToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    followingRef.current = true;
    setFollowing(true);
  }, []);
  const isViewportFollowing = useCallback(() => followingRef.current, []);

  // ---- Per-conversation model/usage/progress/approval ----
  const selectedValue = selection
    ? toModelValue(selection.customProviderId, selection.model)
    : undefined;
  const modelLabel = useMemo(() => {
    if (!selection) return t("chat.selectModel");
    return selectedProvider ? `${selectedProvider.name} / ${selection.model}` : selection.model;
  }, [selectedProvider, selection, t]);
  const contextWindow = useMemo(() => {
    if (!selection) return undefined;
    const provider = context.settings.customProviders.find(
      (item) => item.id === selection.customProviderId,
    );
    return provider ? findProviderModelConfig(provider, selection.model).contextWindow : undefined;
  }, [context.settings.customProviders, selection]);
  const contextUsageTokensSource = useMemo<ContextUsageTokensSource>(() => {
    let cache: { revision: number; value: number | undefined } | null = null;
    return {
      subscribe: store.subscribe,
      getContextUsageTokens: () => {
        const snapshot = store.getSnapshot();
        if (cache && cache.revision === snapshot.revision) return cache.value;
        const value = deriveContextUsageTokens(snapshot.rows);
        cache = { revision: snapshot.revision, value };
        return value;
      },
    };
  }, [store]);
  const taskProgressSnapshot = useMemo(
    () => selectLatestTaskProgress(transcript.rows),
    [transcript.rows],
  );
  const pendingToolApprovals = useMemo(() => {
    const result: {
      toolCallId: string;
      toolName: string;
      summary?: string;
      deadlineAt?: number;
    }[] = [];
    for (const row of transcript.rows) {
      if (row.kind !== "assistant") continue;
      for (const round of row.rounds) {
        for (const block of round.blocks) {
          if (block.kind !== "tool") continue;
          const { toolCall, toolResult } = block.item;
          if (toolResult || !readToolApprovalPending(toolCall.arguments)) continue;
          result.push({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            summary: readToolApprovalSummary(toolCall.arguments),
            deadlineAt: readToolApprovalDeadlineAt(toolCall.arguments) ?? undefined,
          });
        }
      }
    }
    return result;
  }, [transcript.rows]);
  // Approval decisions explicitly carry this Pane's conversation id and never
  // fall onto the focused conversation.
  const approvalBar =
    pendingToolApprovals.length > 0 ? (
      <ToolApprovalBar
        pending={pendingToolApprovals}
        onDecide={(toolCallId, decision) =>
          submitToolApprovalDecision(toolCallId, decision, conversationId)
        }
        onDecideAll={async (decision) => {
          for (const item of pendingToolApprovals) {
            await submitToolApprovalDecision(item.toolCallId, decision, conversationId);
          }
        }}
      />
    ) : null;

  if (!hydrated && !isPrimary && rowCount === 0) {
    return (
      <div
        data-workbench-pane-id={paneId}
        data-workbench-surface="conversation"
        data-workbench-surface-id={`conversation:${conversationId}`}
        className="flex h-full min-h-0 w-full items-center justify-center"
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const usePrimary = Boolean(isPrimary && primary);
  const transcriptFollowing = usePrimary ? (primary?.viewportFollowing ?? following) : following;
  const transcriptIsViewportFollowing =
    usePrimary && primary?.isViewportFollowing ? primary.isViewportFollowing : isViewportFollowing;
  const handleJumpToBottom =
    usePrimary && primary?.onJumpToBottom ? primary.onJumpToBottom : jumpToBottom;
  const transcriptTree = (
    <GatewayTranscript
      conversationId={conversationId}
      rows={transcript.rows}
      liveStartIndex={transcript.liveStartIndex}
      activeTurnKey={transcript.activeTurnKey}
      contentWidth={context.transcriptContentWidth}
      isViewportFollowing={transcriptIsViewportFollowing}
      viewportFollowing={transcriptFollowing}
      toolStatus={transcript.toolStatus}
      toolStatusIsCompaction={transcript.toolStatusIsCompaction}
      retryAttempts={transcript.retryAttempts}
      isStreaming={transcript.activeRun !== null}
      isLoading={usePrimary ? primary?.isLoading : false}
      loadingTitle={usePrimary ? primary?.loadingTitle : undefined}
      error={usePrimary ? (primary?.transcriptError ?? undefined) : undefined}
      hasModels={context.hasModels}
      onOpenSettings={context.openSettings}
      hasMoreHistory={usePrimary ? (primary?.hasMoreHistory ?? false) : hasMoreHistory}
      isLoadingMoreHistory={usePrimary ? (primary?.isLoadingMoreHistory ?? false) : loadingEarlier}
      onLoadEarlierHistory={
        usePrimary
          ? primary?.onLoadEarlierHistory
          : hasMoreHistory
            ? handleLoadEarlierHistory
            : undefined
      }
      showUsage={context.showUsage}
      usageContextWindow={contextWindow}
      workspaceRoot={workdir}
      onOpenFileLink={context.onOpenFileLink}
      gitClient={context.gitClient}
      onLoadUploadedImagePreview={context.onLoadUploadedImagePreview}
      navRef={usePrimary ? primary?.navRef : undefined}
      onAnchorUserRowChange={usePrimary ? primary?.onAnchorUserRowChange : undefined}
      onResendFromEdit={usePrimary ? primary?.onResendFromEdit : () => onFocusPane()}
      onBranchConversation={usePrimary ? primary?.onBranchConversation : undefined}
      branchPendingMessageId={
        usePrimary ? (primary?.branchPendingMessageId ?? undefined) : undefined
      }
      onSuggestionSelect={usePrimary ? primary?.onSuggestionSelect : () => onFocusPane()}
      suggestionsDisabled={usePrimary ? primary?.suggestionsDisabled : undefined}
    />
  );

  // Nest a .gateway-chat-frame layer: ChatComposerBar(surface="web") writes the
  // input box height to the nearest chat-frame CSS variable, and this makes the
  // variable scoped per Pane so multiple input boxes do not interfere with each
  // other; the DOM structure matches the desktop ConversationSurface.
  return (
    <div
      data-workbench-pane-id={paneId}
      data-workbench-surface="conversation"
      data-workbench-surface-id={`conversation:${conversationId}`}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {blockedMessage ? (
        <div
          data-workbench-pane-blocked=""
          className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400"
        >
          {blockedMessage}
        </div>
      ) : null}
      <div className="gateway-chat-frame relative flex h-full min-h-0 w-full flex-col overflow-hidden">
        <section
          ref={usePrimary ? primary?.stageRef : undefined}
          className="gateway-transcript-stage"
          style={
            {
              [CHAT_TRANSCRIPT_WIDTH_CSS_VAR]: `${context.transcriptContentWidth}px`,
            } as CSSProperties
          }
        >
          {trajectoryActive ? (
            <TrajectoryView
              conversationId={conversationId}
              host={context.trajectoryHost}
              messages={paneTrajectoryMessages}
              workdir={workdir}
              hasMoreMessages={usePrimary ? (primary?.hasMoreHistory ?? false) : hasMoreHistory}
              loadEarlierMessages={
                usePrimary
                  ? primary?.onLoadEarlierHistory
                  : hasMoreHistory
                    ? handleLoadEarlierHistory
                    : undefined
              }
              liveEvents={liveTrajectory ?? undefined}
              authoritativeRevision={trajectoryAuthoritativeRevision}
            />
          ) : (
            <div className="gateway-transcript-scroll-shell">
              <ScrollArea
                ref={usePrimary ? primary?.setTranscriptScrollAreaRoot : undefined}
                viewportRef={
                  usePrimary && primary?.setTranscriptViewport
                    ? primary.setTranscriptViewport
                    : setViewport
                }
                className="gateway-transcript-scroll"
              >
                {usePrimary && primary ? (
                  <ChangedFilesActionsProvider value={primary.changedFilesActions}>
                    <CheckpointRewindProvider
                      client={primary.checkpoint.client}
                      conversationId={conversationId}
                      disabled={primary.checkpoint.disabled}
                      resolveAuthorizedRoots={() =>
                        Promise.resolve(primary.checkpoint.resolveAuthorizedRoots())
                      }
                      onRewound={primary.checkpoint.onRewound}
                    >
                      {transcriptTree}
                    </CheckpointRewindProvider>
                  </ChangedFilesActionsProvider>
                ) : (
                  transcriptTree
                )}
              </ScrollArea>
              {usePrimary ? primary?.transcriptExtras : null}
              {!transcriptFollowing && rowCount > 0 ? (
                <button
                  type="button"
                  className="gateway-scroll-to-bottom"
                  onClick={handleJumpToBottom}
                  aria-label="Scroll to bottom"
                  title="Scroll to bottom"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          )}
          <ChatComposerBar
            surface="web"
            runClarifyTurn={
              context.settings.customSettings.promptClarifyEnabled ? runClarifyTurn : undefined
            }
            clarifyContext={clarifyContext}
            conversationId={conversationId}
            hidden={trajectoryActive}
            composerRef={composerRef}
            isSending={usePrimary ? (primary?.isSending ?? isRunning) : isRunning}
            isUploadingFiles={
              usePrimary
                ? (primary?.isUploadingFiles ?? false)
                : context.uploadingConversationId === conversationId
            }
            isInputDisabled={resolveWorkbenchComposerInputDisabled({
              isPrimary: usePrimary,
              primaryInputDisabled: primary?.isInputDisabled ?? context.isInputDisabled,
              transportInputDisabled: context.transportInputDisabled,
              conversationIsCompacting: transcript.toolStatusIsCompaction === true,
            })}
            inputPlaceholder={context.inputPlaceholder}
            workdir={workdir}
            enabledSkills={context.enabledSkills}
            mentionableConversations={context.mentionableConversations}
            searchMentionableConversations={context.searchMentionableConversations}
            mentionApps={context.mentionApps}
            executionMode={context.settings.system.executionMode}
            hasModels={context.hasModels}
            currentModelLabel={modelLabel}
            modelOptions={context.modelOptions}
            selectedValue={selectedValue}
            chatRuntimeControls={paneRuntimeControls}
            commandSafetyMode={context.commandSafetyMode}
            onCommandSafetyModeChange={context.onCommandSafetyModeChange}
            reasoningOptions={paneReasoningOptions}
            thinkingAlwaysOn={paneThinkingAlwaysOn}
            contextUsageTokensSource={contextUsageTokensSource}
            contextWindow={contextWindow}
            contextDisplayMode={context.contextDisplayMode}
            onManualCompactConfirm={
              usePrimary && primary ? primary.onManualCompactConfirm : () => onFocusPane()
            }
            manualCompactBlocked={
              usePrimary
                ? (primary?.manualCompactBlocked ?? false)
                : transcript.toolStatusIsCompaction === true
            }
            gitClient={context.gitClient}
            gitWriteEnabled={context.gitWriteEnabled}
            gitDisabledMessage={context.gitDisabledMessage}
            workspaceActivityClient={context.workspaceActivityClient}
            onOpenWorktree={context.onOpenWorktree}
            onWorktreeRemoved={context.onWorktreeRemoved}
            onSend={usePrimary && primary ? primary.onSend : handleSend}
            onStop={usePrimary && primary ? primary.onStop : handleStop}
            onComposerBusyChange={
              usePrimary && primary ? primary.onComposerBusyChange : () => undefined
            }
            onSelectModel={usePrimary && primary ? primary.onSelectModel : () => onFocusPane()}
            onSelectExecutionMode={
              usePrimary && primary ? primary.onSelectExecutionMode : () => onFocusPane()
            }
            onOpenSettings={context.openSettings}
            onChatRuntimeControlsChange={
              usePrimary && primary ? primary.onChatRuntimeControlsChange : () => onFocusPane()
            }
            onPrepareChatRuntime={usePrimary && primary ? primary.onPrepareChatRuntime : undefined}
            onPickReadableFiles={
              usePrimary && primary ? primary.onPickReadableFiles : () => onFocusPane()
            }
            onPickWorkspaceFolder={
              usePrimary && primary ? primary.onPickWorkspaceFolder : () => onFocusPane()
            }
            onPasteFiles={
              usePrimary && primary
                ? primary.onPasteFiles
                : (files) => {
                    void context.importFilesForConversation(
                      conversationId,
                      workdirRef.current,
                      files,
                    );
                  }
            }
            onLoadUploadedImagePreview={context.onLoadUploadedImagePreview}
            loadHistoryPrompts={usePrimary && primary ? primary.loadHistoryPrompts : undefined}
            pendingUploadedFiles={
              usePrimary && primary ? primary.pendingUploadedFiles : pendingUploads
            }
            onRemovePendingUpload={
              usePrimary && primary
                ? primary.onRemovePendingUpload
                : (relativePath) => {
                    context.updatePendingUploads(conversationId, (current) =>
                      current.filter((file) => file.relativePath !== relativePath),
                    );
                  }
            }
            queuedTurns={usePrimary && primary ? primary.queuedTurns : queuedTurns}
            onRunQueuedTurnNow={
              usePrimary && primary ? primary.onRunQueuedTurnNow : handleRunQueuedTurnNow
            }
            onMoveQueuedTurnUp={
              usePrimary && primary ? primary.onMoveQueuedTurnUp : handleMoveQueuedTurnUp
            }
            onEditQueuedTurn={
              usePrimary && primary ? primary.onEditQueuedTurn : () => onFocusPane()
            }
            onRemoveQueuedTurn={
              usePrimary && primary ? primary.onRemoveQueuedTurn : handleRemoveQueuedTurn
            }
            taskProgressBar={
              usePrimary ? (
                primary?.taskProgressBar
              ) : (
                <TaskProgressBar
                  key={conversationId}
                  snapshot={taskProgressSnapshot}
                  isConversationRunning={isRunning}
                />
              )
            }
            approvalBar={usePrimary ? primary?.approvalBar : approvalBar}
            statsBar={
              usePrimary ? (
                primary?.statsBar
              ) : (
                <ConversationStatsBarHost
                  key={`stats-${conversationId}`}
                  conversationId={conversationId}
                  host={context.trajectoryHost}
                  enabled={!trajectoryActive}
                  contextUsageTokensSource={contextUsageTokensSource}
                  contextWindow={contextWindow}
                  onManualCompactConfirm={() => onFocusPane()}
                  manualCompactBlocked={transcript.toolStatusIsCompaction === true}
                />
              )
            }
            fileDropOverlay={usePrimary ? primary?.fileDropOverlay : null}
          />
        </section>
      </div>
    </div>
  );
}
