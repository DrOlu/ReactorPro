import { useApplicationViewState } from "@liveagent/ui/application/useApplicationViewState";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import type { NotifyItem } from "@liveagent/ui/components/chat/NotifyToast";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { LocaleContext, t as translate, useLocaleContextValue } from "@liveagent/ui/i18n/index";
import { searchMentionConversations } from "@liveagent/ui/lib/chat/conversationSearch";
import { useMentionApps } from "@liveagent/ui/lib/chat/useMentionApps";
import { useScrollFollow } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { releaseProjectToolFromDock } from "@liveagent/ui/lib/projectTools/releaseProjectToolFromDock";
import type { ConversationOpenRequest } from "@liveagent/ui/lib/sidebar/openController";
import {
  type ConversationOpenState,
  createConversationOpenController,
} from "@liveagent/ui/lib/sidebar/openController";
import { createSidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import {
  sortTerminalSessions,
  terminalSessionBelongsToProject,
} from "@liveagent/ui/lib/terminal/sessionStore";
import { useWorkspaceProjectDeletion } from "@liveagent/ui/lib/useWorkspaceProjectRemoval";
import { projectToolSurfaceTitleKey } from "@liveagent/ui/lib/workbench/projectToolSurfaces";
import { useWorkspaceProjectSettingsActions } from "@liveagent/ui/lib/workspaceProjectRemoval";
import type { ChatQueueTurnPreview } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createGatewayWorkspaceProjectRootClient } from "@/agent-ui-adapters/workspaceProjectRoots";
import type { GatewayTranscriptNavHandle } from "@/components/GatewayTranscript";
import { registerAskUserQuestionAnswerHandler } from "@/lib/chat/askUserQuestionBridge";
import type { HistoryWindowState } from "@/lib/chat/historyWindow";
import { registerPlanDecisionHandler } from "@/lib/chat/planModeBridge";
import { createActivityStore } from "@/lib/chat/stream/activityStore";
import {
  ChatCommandPipeline,
  type PendingChatCommand,
} from "@/lib/chat/stream/chatCommandPipeline";
import type { ChatCommandUpdate } from "@/lib/chat/stream/streamTypes";
import { createTranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import { registerToolApprovalDecisionHandler } from "@/lib/chat/toolApprovalBridge";
import type {
  AgentStatus,
  ChatEvent,
  ChatQueueItemSummary,
  ChatQueueSnapshot,
  HistoryDetail,
} from "@/lib/gatewayTypes";
import { parseHistoryShareToken } from "@/lib/historyShare";
import {
  openRightDockSingletonTab,
  parseSelectedModelJson,
  resolveEffectiveTheme,
  type SelectedModel,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@/lib/settings";
import { createIdleSidebarBackend, createWebSidebarBackend } from "@/lib/sidebar/webSidebarBackend";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsSyncLoading } from "@/pages/SettingsSyncLoading";
import { SharedHistoryPage } from "@/pages/SharedHistoryPage";
import {
  asErrorMessage,
  readTunnelManagerToolChange,
  resolveActiveModelSelection,
} from "./chatEventUtils";
import { HISTORY_LIST_PAGE_SIZE, PROTECTED_DRAFT_CONVERSATION } from "./constants";
import { GatewayAppView } from "./GatewayAppView";
import { createGatewayChatCommandActions } from "./gatewayChatCommandActions";
import { createGatewayConversationActions } from "./gatewayConversationActions";
import {
  createOpenConversationInitial,
  createRefreshDisplayedConversationHistorySnapshot,
} from "./gatewayHistoryWindowActions";
import {
  createGatewayHomeConversationState,
  createLocalDraftConversationId,
  isLocalDraftConversationId,
} from "./gatewayLocalDraft";
import { resolveVisibleConversationId, shouldOpenSidebarByDefault } from "./historyUtils";
import { resolveConversationUploadWorkdir } from "./hooks/uploadWorkdirRouting";
import { useDirectoryDropActions } from "./hooks/useDirectoryDropActions";
import { useGatewayChatConfiguration } from "./hooks/useGatewayChatConfiguration";
import { useGatewayChatPresentation } from "./hooks/useGatewayChatPresentation";
import { useGatewayClients } from "./hooks/useGatewayClients";
import {
  type ManualCompactPendingRequest,
  useGatewayConversationRuntime,
} from "./hooks/useGatewayConversationRuntime";
import { useGatewayConversationState } from "./hooks/useGatewayConversationState";
import { useGatewayHistoryReconciliation } from "./hooks/useGatewayHistoryReconciliation";
import { useGatewayProjectTools } from "./hooks/useGatewayProjectTools";
import { useGatewayRuntimePreparation } from "./hooks/useGatewayRuntimePreparation";
import { useGatewaySession } from "./hooks/useGatewaySession";
import { useGatewaySettingsOverlay } from "./hooks/useGatewaySettingsOverlay";
import { useGatewaySettingsSync } from "./hooks/useGatewaySettingsSync";
import { useGatewaySharedHistory } from "./hooks/useGatewaySharedHistory";
import { useGatewayTransportStatus } from "./hooks/useGatewayTransportStatus";
import { useGatewayWorkspaceProjects } from "./hooks/useGatewayWorkspaceProjects";
import { usePendingUploads } from "./hooks/usePendingUploads";
import { useStableCallback } from "./hooks/useStableCallback";
import type { SendChatFn } from "./types";
import { shouldRestorePageComposerDraft } from "./workbench/pageComposerDraftRestore";
import { sessionWorkbench } from "./workbench/sessionWorkbench";
import { useGatewayWorkbench } from "./workbench/useGatewayWorkbench";

function useGatewayAppController() {
  const historyShareToken = useMemo(() => parseHistoryShareToken(), []);
  const {
    token,
    loginToken,
    authSubmitting,
    authError,
    setLoginToken,
    setAuthError,
    login: handleLoginSubmit,
    clearSession,
  } = useGatewaySession(historyShareToken);
  const { api, terminalClient, sftpClient, gitClient } = useGatewayClients(token);
  const [activeAgentId, setActiveAgentId] = useState(() => api?.getActiveAgent() ?? "");
  const activeAgentIdRef = useRef(activeAgentId);
  const activeAgentScope = activeAgentId || api?.getActiveAgent() || "";
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // True only after an authenticated gateway connection has been established
  // and then dropped; the initial connect never shows lost-connection UI.
  const [gatewayConnectionLost, setGatewayConnectionLost] = useState(false);
  // A cached Agent status is usable only after it has been observed on the
  // currently authenticated browser-socket epoch.
  const [sidebarAgentStatusFresh, setSidebarAgentStatusFresh] = useState(false);
  // The homepage is a real unsaved conversation. A stable local-draft id keeps
  // the initial Workbench root valid and lets the first sidebar/dock drop form
  // an actual split without changing the visible homepage experience.
  const [initialHomeConversation] = useState(createGatewayHomeConversationState);
  const [conversationId, setConversationId] = useState(initialHomeConversation.conversationId);
  // Local, unpersisted per-conversation model switches (keyed by conversation id); after a
  // message is sent and selected_model is persisted, the history-sync echo converges and deletes
  // them in the cleanup effect.
  const [conversationModelOverrides, setConversationModelOverrides] = useState<
    ReadonlyMap<string, SelectedModel>
  >(new Map());
  const [chatError, setChatError] = useState<string | null>(null);
  // Usage-ring manual compaction: associates the desktop terminal state by operationId so
  // "accepted" is not mistaken for completion. Keyed by conversation id (issue #359 bug #3):
  // different conversations each have their own pending state, and while one conversation is
  // compacting it never silently blocks another conversation's compaction request. State and ref
  // are written synchronously through a single setter/clearer to keep the two consistent.
  const [manualCompactPendingByConversation, setManualCompactPendingState] = useState<
    ReadonlyMap<string, ManualCompactPendingRequest>
  >(() => new Map());
  const manualCompactPendingRef = useRef<ReadonlyMap<string, ManualCompactPendingRequest>>(
    manualCompactPendingByConversation,
  );
  const setManualCompactPendingRequest = useCallback((request: ManualCompactPendingRequest) => {
    const next = new Map(manualCompactPendingRef.current);
    next.set(request.conversationId, request);
    manualCompactPendingRef.current = next;
    setManualCompactPendingState(next);
  }, []);
  const clearManualCompactPendingRequest = useCallback(
    (conversationId: string, operationId: string) => {
      const current = manualCompactPendingRef.current;
      const pending = current.get(conversationId);
      if (!pending || pending.operationId !== operationId) return false;
      const next = new Map(current);
      next.delete(conversationId);
      manualCompactPendingRef.current = next;
      setManualCompactPendingState(next);
      return true;
    },
    [],
  );
  // Top-right toast stack for upload/attachment feedback — mirrors the GUI's
  // NotifyToast usage so upload failures never render as conversation output.
  const [notifyItems, setNotifyItems] = useState<NotifyItem[]>([]);
  const notifyIdCounter = useRef(0);
  const addNotify = useCallback((type: NotifyItem["type"], message: string) => {
    const id = `notify-${++notifyIdCounter.current}`;
    setNotifyItems((prev) => [...prev, { id, type, message }]);
  }, []);
  const dismissNotify = useCallback((id: string) => {
    setNotifyItems((prev) => prev.filter((item) => item.id !== id));
  }, []);
  // Sidebar errors raised outside the sidebar store (project removal flow).
  const [sidebarActionError, setSidebarActionError] = useState<string | null>(null);
  const [queuedChatTurns, setQueuedChatTurns] = useState<ChatQueueItemSummary[]>([]);
  const [, setChatQueueRevision] = useState(0);
  const [selectedHistoryId, setSelectedHistoryId] = useState(
    initialHomeConversation.selectedHistoryId,
  );
  const [selectedHistory, setSelectedHistory] = useState<HistoryDetail | null>(null);
  // Two-phase conversation open (openController): "opening" gates the
  // composer/transcript loading affordances; showOverlay drives the switch
  // overlay (appears only after ~150ms of still-loading).
  const [conversationOpenState, setConversationOpenState] = useState<ConversationOpenState>({
    conversationId: "",
    phase: "idle",
    showOverlay: false,
    errorCode: null,
  });
  // Explicit "load full history" request from the transcript header.
  const [fullHistoryLoading, setFullHistoryLoading] = useState(false);
  // Bumped whenever the command pipeline's pending set changes so busy state
  // re-derives.
  const [pendingCommandRevision, setPendingCommandRevision] = useState(0);
  const { settings, setSettings, settingsSyncReady, settingsSyncError, settingsSaveState } =
    useGatewaySettingsSync({ token, api, activeAgentId: activeAgentScope });
  const workspaceProjectRootClient = useMemo(
    () => (api ? createGatewayWorkspaceProjectRootClient(api) : undefined),
    [api],
  );
  const [workspaceRootRevision, setWorkspaceRootRevision] = useState(0);
  const handleWorkspaceDirectoriesMounted = useCallback(() => {
    setWorkspaceRootRevision((revision) => revision + 1);
  }, []);
  const effectiveTheme = resolveEffectiveTheme(settings.theme);
  const isAgentMode = settings.system.executionMode !== "text";
  const [sidebarOpen, setSidebarOpen] = useState(shouldOpenSidebarByDefault);
  const {
    settingsOpen,
    overlay,
    openSettings,
    closeSettings,
    handleSettingsTransitionEnd,
    resetSettingsOverlay,
    settingsSection,
    settingsProviderId,
  } = useGatewaySettingsOverlay(setSidebarOpen);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const {
    activeView,
    setActiveView,
    projectSettingsProject,
    setProjectSettingsProject,
    rightDockOpen,
    setRightDockOpen,
  } = useApplicationViewState<WorkspaceProject>();
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();
  // Both elements arrive via callback refs → state so the scroll-follow hook
  // re-binds on element identity change and can never keep listeners on a
  // dead node.
  const [transcriptScrollAreaRoot, setTranscriptScrollAreaRoot] = useState<HTMLDivElement | null>(
    null,
  );
  const [transcriptViewport, setTranscriptViewport] = useState<HTMLDivElement | null>(null);
  const transcriptStageRef = useRef<HTMLElement | null>(null);
  const { handle: transcriptFollow, following: transcriptFollowing } = useScrollFollow({
    viewport: transcriptViewport,
    listenerRoot: transcriptScrollAreaRoot,
    trackKeys: true,
  });
  // Floor navigation: the current floor is reported by the transcript area, and jumps go through
  // navRef straight to the virtual list; while stick-to-bottom following is active, a programmatic
  // scroll is immediately yanked back to the bottom -- so before jumping, release following using
  // the "jump into history" semantics.
  const transcriptNavRef = useRef<GatewayTranscriptNavHandle | null>(null);
  const [activeFloorKey, setActiveFloorKey] = useState<string | null>(null);
  const handleFloorJump = useCallback(
    (rowKey: string) => {
      transcriptFollow.breakFollow();
      transcriptNavRef.current?.scrollToRowKey(rowKey);
    },
    [transcriptFollow],
  );
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const composerDraftCacheRef = useRef<Map<string, MentionComposerDraft>>(new Map());
  // Draft id -> real conversation id. The Pane host's draft effect cleanup closes over the old
  // conversationId: when rebinding in place from draft to real, the cleanup runs after the rename,
  // so writing directly to the draft key would land on an orphan entry that can never be read, and
  // the host's new effect would immediately clear() what the user is typing. Reads and writes are
  // uniformly rewritten to the real id through this mapping.
  const boundComposerDraftIdsRef = useRef<Map<string, string>>(new Map());
  const resolveComposerDraftKey = useCallback((conversationId: string) => {
    return boundComposerDraftIdsRef.current.get(conversationId) ?? conversationId;
  }, []);
  const composerDraftOwnerRef = useRef("");
  const conversationIdRef = useRef(conversationId);
  const selectedHistoryIdRef = useRef(selectedHistoryId);
  const statusRef = useRef<AgentStatus | null>(status);
  const queuedChatTurnsRef = useRef<ChatQueueItemSummary[]>([]);
  const chatQueueConversationIdRef = useRef("");
  const chatQueueRevisionRef = useRef(0);
  const queuedChatEditSessionRef = useRef<{ itemId: string; revision: number } | null>(null);
  const selectedHistoryRef = useRef(selectedHistory);
  // Per-conversation runtime workdir (drafts have no persisted summary yet).
  const conversationWorkdirsRef = useRef<Map<string, string>>(new Map());
  // Lazy history windows: per conversation, the persisted-message edge the
  // loaded transcript starts at (see lib/chat/historyWindow.ts). Entries are
  // (re)established by every applied history fetch and dropped with the
  // conversation's other per-id resources.
  const historyWindowStatesRef = useRef<Map<string, HistoryWindowState>>(new Map());
  const displayedConversationWorkdirRef = useRef("");
  const pendingUploadContextRef = useRef<{
    conversationId: string;
    workdir: string;
    executionMode: string;
  } | null>(null);
  const displayedConversationBusyRef = useRef(false);
  const historyLoadSequenceRef = useRef(0);
  const visibleConversationRevisionRef = useRef(0);
  const previousDisplayedConversationIdRef = useRef("");
  const pendingDisplayedConversationAutoBottomRef = useRef<string | null>(null);
  const protectedConversationRef = useRef(PROTECTED_DRAFT_CONVERSATION);
  const chatRuntimePreparePromiseRef = useRef<Promise<AgentStatus> | null>(null);
  const submitInFlightRef = useRef(false);
  // clientRequestId → draft conversation id, until the command binds.
  const draftClientRequestsRef = useRef<Map<string, string>>(new Map());
  const sendChatRef = useRef<SendChatFn | null>(null);
  const isImportingPastedTextRef = useRef(false);
  const resetProjectToolsRuntimeRef = useRef<() => void>(() => undefined);

  const resetToFreshHomeConversation = useCallback(() => {
    const next = createGatewayHomeConversationState();
    conversationIdRef.current = next.conversationId;
    selectedHistoryIdRef.current = next.selectedHistoryId;
    selectedHistoryRef.current = null;
    protectedConversationRef.current = PROTECTED_DRAFT_CONVERSATION;
    setConversationId(next.conversationId);
    setSelectedHistoryId(next.selectedHistoryId);
    setSelectedHistory(null);
  }, []);

  // --- Chat streaming infrastructure (Phase 4) -----------------------------
  // Transcript stores (one per conversation), the global activity map, and
  // the command pipeline replace the old live-store registry, running-id
  // unions, and recovery machinery.
  // Ref indirection: the registry memo is stable across token changes while
  // the api client is not, and divergence resyncs must reach the live client.
  const apiRef = useRef(api);
  apiRef.current = api;
  const transcriptStoreRegistry = useMemo(
    () =>
      createTranscriptStoreRegistry({
        onDivergence: (divergedConversationId) =>
          apiRef.current?.resyncConversation(divergedConversationId),
      }),
    [],
  );
  const activityStore = useMemo(() => createActivityStore(), []);
  const pipelineOnBoundRef = useRef<
    (update: ChatCommandUpdate, pending: PendingChatCommand) => void
  >(() => undefined);
  const pipelineOnQueuedInGuiRef = useRef<
    (update: ChatCommandUpdate, pending: PendingChatCommand) => void
  >(() => undefined);
  const pipelineOnFailedRef = useRef<
    (pending: PendingChatCommand, errorCode: string | null, message: string) => void
  >(() => undefined);
  const chatCommandPipeline = useMemo(
    () =>
      new ChatCommandPipeline({
        getTranscriptStore: (targetConversationId) =>
          transcriptStoreRegistry.get(targetConversationId),
        onBound: (update, pending) => pipelineOnBoundRef.current(update, pending),
        onQueuedInGui: (update, pending) => pipelineOnQueuedInGuiRef.current(update, pending),
        onFailed: (pending, errorCode, message) =>
          pipelineOnFailedRef.current(pending, errorCode, message),
        onPendingChanged: () => setPendingCommandRevision((current) => current + 1),
      }),
    [transcriptStoreRegistry],
  );

  // --- Sidebar state layer --------------------------------------------------
  // One external store owns the whole sidebar domain (list, workdirs, running
  // set, per-row mutations); GatewayApp only creates it, feeds it the scope,
  // and makes imperative peek/upsertLocal/removeLocal calls. All rendering
  // subscriptions live in <GatewaySidebarContainer/>.
  const getSidebarProtectedConversationIds = useCallback(() => {
    // Authoritative reconciles keep only these ids when the server list omits
    // them: in-flight commands, the protected (displayed) conversation, and
    // running conversations. Never a blanket retain-all — that resurrects
    // deletions made by other clients while this one was offline.
    const ids = new Set<string>(chatCommandPipeline.pendingConversationIds());
    const protectedId = protectedConversationRef.current.trim();
    if (protectedId && protectedId !== PROTECTED_DRAFT_CONVERSATION) {
      ids.add(protectedId);
    }
    for (const id of activityStore.getSnapshot().activities.keys()) {
      ids.add(id);
    }
    return ids;
  }, [activityStore, chatCommandPipeline]);
  const getActivityKeepConversationIds = useCallback(
    () => chatCommandPipeline.pendingConversationIds(),
    [chatCommandPipeline],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Agent ID is the data isolation boundary of the sidebar Store.
  const sidebarStore = useMemo(
    () =>
      createSidebarStore(
        api
          ? createWebSidebarBackend({
              api,
              activityStore,
              getProtectedConversationIds: getSidebarProtectedConversationIds,
              getActivityKeepConversationIds,
            })
          : createIdleSidebarBackend(),
        { pageSize: HISTORY_LIST_PAGE_SIZE },
      ),
    [
      activeAgentScope,
      activityStore,
      api,
      getActivityKeepConversationIds,
      getSidebarProtectedConversationIds,
    ],
  );
  useEffect(() => {
    if (!api) {
      return;
    }
    sidebarStore.start();
    return () => {
      sidebarStore.stop();
    };
  }, [api, sidebarStore]);

  // Narrow app-root subscriptions: workdirs (rare commits — project merge
  // inputs) and the byId index (list commits only; never running/idle ticks).
  const sidebarWorkdirs = useSidebarSelector(sidebarStore, (snapshot) => snapshot.workdirs);
  const sidebarConversationsById = useSidebarSelector(sidebarStore, (snapshot) => snapshot.byId);
  const mentionableConversations = useMemo(
    () =>
      [...sidebarConversationsById.values()]
        .filter((item) => !item.isPending)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ id, title, cwd, updatedAt, messageCount }) => ({
          id,
          title,
          cwd,
          updatedAt,
          messageCount,
        })),
    [sidebarConversationsById],
  );
  const {
    handleCloseShareModal,
    handleDisableSharedHistory,
    handleLoadSharedHistoryStatus,
    handleOpenShareModal,
    handleOpenSharedHistoryManager,
    handleRefreshSharedHistoryStatuses,
    handleSetShareRedactToolContent,
    handleSetSharedHistoryRedactToolContent,
    handleToggleHistoryShare,
    removeSharedHistoryItems,
    resetSharedHistory,
    setSharedManagerOpen,
    shareConversation,
    shareError,
    shareLoading,
    shareStatus,
    shareUpdating,
    sharedHistoryItems,
    sharedHistoryListError,
    sharedManagerErrors,
    sharedManagerLoadingIds,
    sharedManagerOpen,
    sharedManagerStatuses,
    sharedManagerUpdatingIds,
  } = useGatewaySharedHistory({ api, gatewayConnectionLost, sidebarStore, status });

  const startNewConversationRef = useRef<
    (options?: { workdir?: string; preserveCurrentComposerDraft?: boolean }) => string
  >(() => "");
  const {
    activateWorkspaceProject,
    activateSearchConversationWorkspace,
    clearSearchConversationWorkspace,
    searchConversationWorkdir,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    archivedWorkspaceProjectPathKeys,
    handleBrowseWorkspaceProjectInFileTree,
    handleCancelWorkspaceCloneTask,
    handleCloneWorkspaceProject,
    handleCommitWorkspaceProjectRename,
    handleCreateWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleDismissWorkspaceCloneTask,
    handleLoadWorkspaceRemoteBranches,
    handleMoveWorkspaceProjectToGroup,
    handleNewConversationForProject,
    handleOpenClonedWorkspace,
    handleOpenCreateWorkspaceProject,
    handleOpenWorkspaceFolder,
    handleOpenWorktree,
    handleRenameWorkspaceGroup,
    handleSelectWorkspaceProject,
    handleSetWorkspaceProjectPinned,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
    handleToggleWorkspaceGroupCollapsed,
    handleWorkdirPickerSelect,
    missingWorkspaceProjectPathKeys,
    projectPickerOpen,
    setActiveWorkspaceProjectId,
    setProjectPickerOpen,
    setWorkspaceCreateModalOpen,
    workspaceCloneTasks,
    workspaceCreateModalOpen,
    workspaceProjects,
  } = useGatewayWorkspaceProjects({
    api,
    displayedConversationWorkdirRef,
    setActiveView,
    setRightDockOpen,
    setSettings,
    setSidebarOpen,
    settings,
    sidebarStore,
    sidebarWorkdirs,
    startNewConversationRef,
  });

  // Conversation-open controller: the web end paints the conversation's whole
  // established history window in the single open phase — messages above the
  // window edge stay unfetched until the user pages up. Deps go through refs
  // (assigned per render) so the controller instance stays stable.
  const openInitialRef = useRef<
    (id: string, request?: ConversationOpenRequest) => Promise<"cache-hit" | "painted">
  >(() => Promise.resolve("painted"));
  const openController = useMemo(
    () =>
      createConversationOpenController({
        openInitial: (id, request) => openInitialRef.current(id, request),
        onStateChange: setConversationOpenState,
      }),
    [],
  );

  const resolveActiveAgentID = useCallback(async () => {
    const currentApi = apiRef.current;
    if (!currentApi) {
      throw new Error("Gateway is not connected yet.");
    }
    let agentID = currentApi.getActiveAgent().trim();
    if (!agentID) {
      await currentApi.listAgents();
      agentID = currentApi.getActiveAgent().trim();
    }
    if (!agentID) {
      throw new Error("No Agent is available.");
    }
    return agentID;
  }, []);

  const { workspaceFolderDropActive, workspaceFolderDropHandlers, mountDroppedDirectories } =
    useDirectoryDropActions({
      token,
      historyShareToken,
      locale: settings.locale,
      resolveAgentID: resolveActiveAgentID,
      addNotify,
      activeWorkspaceProject,
      workspaceProjectRootClient,
      onWorkspaceCreated: handleWorkdirPickerSelect,
      onWorkspaceDirectoriesMounted: handleWorkspaceDirectoriesMounted,
    });

  // No-conversation fallback: equivalent to clicking "New chat" once; returns the new draft
  // conversation id so the upload can attach immediately.
  const ensureUploadConversation = useCallback(() => startNewConversationRef.current(), []);
  const workdirForConversation = useCallback(
    (targetConversationId: string) => {
      const targetId = targetConversationId.trim();
      const displayedId = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      );
      return resolveConversationUploadWorkdir({
        targetConversationId: targetId,
        displayedConversationId: displayedId,
        persistedWorkdir: sidebarStore.peek(targetId)?.cwd,
        runtimeWorkdir: conversationWorkdirsRef.current.get(targetId),
        isAgentMode,
        activeWorkspacePath: activeWorkspaceProjectPath,
        defaultWorkdir: settings.system.workdir,
      });
    },
    [activeWorkspaceProjectPath, isAgentMode, settings.system.workdir, sidebarStore],
  );

  const {
    pendingUploadedFiles,
    isUploadingFiles,
    uploadingConversationId,
    isFileDropActive,
    fileInputRef,
    folderInputRef,
    setUploadingFiles,
    getPendingUploadsForConversation,
    subscribePendingUploads,
    setPendingUploadsForConversation,
    updatePendingUploadsForConversation,
    moveConversationUploads,
    clearPendingUploads,
    handleImportReadableFiles,
    handleImportSelectedDirectoryFiles,
    handleFileDragEnter,
    handleFileDragOver: handlePendingFileDragOver,
    handleFileDragLeave,
    handleFileDrop: handlePendingFileDrop,
  } = usePendingUploads({
    token,
    resolveAgentID: resolveActiveAgentID,
    historyShareToken,
    settingsSyncReady,
    settingsOpen,
    activeView,
    locale: settings.locale,
    executionMode: settings.system.executionMode,
    conversationId,
    selectedHistoryId,
    displayedConversationWorkdirRef,
    composerRef,
    addNotify,
    onDropDirectories: mountDroppedDirectories,
    ensureUploadConversation,
    workdirForConversation,
  });

  const applyChatQueueSnapshot = useCallback((snapshot: ChatQueueSnapshot | null | undefined) => {
    if (!snapshot) return;
    const visibleConversationId = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    );
    if (snapshot.conversationId !== visibleConversationId) {
      return;
    }
    const revision = Number(snapshot.revision ?? 0);
    const isSameQueueConversation = snapshot.conversationId === chatQueueConversationIdRef.current;
    if (isSameQueueConversation && revision < chatQueueRevisionRef.current) {
      return;
    }
    chatQueueConversationIdRef.current = snapshot.conversationId;
    chatQueueRevisionRef.current = revision;
    queuedChatTurnsRef.current = snapshot.items.slice();
    setChatQueueRevision(revision);
    setQueuedChatTurns(snapshot.items.slice());
  }, []);

  useEffect(() => {
    if (!api) return;
    return api.subscribeChatQueue((snapshot) => {
      applyChatQueueSnapshot(snapshot);
    });
  }, [api, applyChatQueueSnapshot]);

  // Answer outlet for the AskUserQuestion card: delivered via the gateway
  // chat_queue.tool_answer to the desktop's tool suspension table; after the desktop resolves it,
  // the result flows back here as a tool_result event as usual.
  useEffect(() => {
    if (!api) {
      registerAskUserQuestionAnswerHandler(null);
      return;
    }
    registerAskUserQuestionAnswerHandler(async (toolCallId, answers) => {
      const conversationIdValue = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      ).trim();
      if (!conversationIdValue) {
        return { ok: false, message: "No active conversation." };
      }
      try {
        const response = await api.chatQueueToolAnswer(
          conversationIdValue,
          toolCallId,
          JSON.stringify(answers),
        );
        return { ok: response.accepted, message: response.message || undefined };
      } catch (error) {
        return { ok: false, message: asErrorMessage(error, "Failed to submit the answer.") };
      }
    });
    return () => registerAskUserQuestionAnswerHandler(null);
  }, [api]);

  // Decision outlet for the tool approval card: delivered via the gateway
  // chat_queue.tool_approval to the desktop's approval suspension table; the desktop then
  // allows/denies the tool, and the result flows back here as a tool_result event as usual.
  useEffect(() => {
    if (!api) {
      registerToolApprovalDecisionHandler(null);
      return;
    }
    registerToolApprovalDecisionHandler(async (toolCallId, decision, targetConversationId) => {
      // Background Panes explicitly carry their own conversation id; the main view by default
      // still routes by the currently displayed conversation.
      const conversationIdValue = (
        targetConversationId?.trim() ||
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current)
      ).trim();
      if (!conversationIdValue) {
        return { ok: false, message: "No active conversation." };
      }
      try {
        const response = await api.chatQueueToolApproval(
          conversationIdValue,
          toolCallId,
          JSON.stringify({ decision }),
        );
        return { ok: response.accepted, message: response.message || undefined };
      } catch (error) {
        return { ok: false, message: asErrorMessage(error, "Failed to submit the decision.") };
      }
    });
    return () => registerToolApprovalDecisionHandler(null);
  }, [api]);

  // Decision outlet for the plan card: delivered via the gateway chat_queue.plan_decision to the
  // desktop's plan suspension table; the desktop then approves/rejects the plan, and the result
  // flows back here as a tool_result event as usual.
  useEffect(() => {
    if (!api) {
      registerPlanDecisionHandler(null);
      return;
    }
    registerPlanDecisionHandler(async (toolCallId, answer) => {
      const conversationIdValue = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      ).trim();
      if (!conversationIdValue) {
        return { ok: false, message: "No active conversation." };
      }
      try {
        const response = await api.chatQueuePlanDecision(
          conversationIdValue,
          toolCallId,
          JSON.stringify(answer),
        );
        return {
          ok: response.accepted,
          message: response.message || undefined,
          errorCode: response.errorCode || undefined,
        };
      } catch (error) {
        return { ok: false, message: asErrorMessage(error, "Failed to submit the decision.") };
      }
    });
    return () => registerPlanDecisionHandler(null);
  }, [api]);

  const {
    applyLiveConversationTitle,
    cacheVisibleComposerDraft,
    clearCachedComposerDraft,
    getDisplayedConversationId,
    getVisibleComposerConversationId,
    isConversationBusy,
    isDisplayedConversation,
    loadComposerHistoryPrompts,
    prepareComposerForConversationChange,
    restoreCachedComposerDraft,
  } = useGatewayConversationState({
    activeWorkspaceProjectPath,
    activityStore,
    chatCommandPipeline,
    composerDraftCacheRef,
    composerDraftOwnerRef,
    composerRef,
    conversationId,
    conversationIdRef,
    conversationWorkdirsRef,
    getPendingUploadsForConversation,
    isAgentMode,
    isLocalDraftConversationId,
    selectedHistory,
    selectedHistoryId,
    selectedHistoryIdRef,
    selectedHistoryRef,
    sidebarStore,
    status,
    statusRef,
    transcriptStoreRegistry,
  });

  const refreshDisplayedConversationHistorySnapshot = useMemo(
    () =>
      createRefreshDisplayedConversationHistorySnapshot({
        api,
        conversationIdRef,
        historyWindowStatesRef,
        isConversationBusy,
        isLocalDraftConversationId,
        selectedHistoryIdRef,
        selectedHistoryRef,
        setSelectedHistory,
        transcriptStoreRegistry,
      }),
    [api, isConversationBusy, transcriptStoreRegistry],
  );

  const markVisibleConversationRevision = useCallback(() => {
    visibleConversationRevisionRef.current += 1;
    return visibleConversationRevisionRef.current;
  }, []);

  const invalidateHistoryLoad = useCallback(() => {
    historyLoadSequenceRef.current += 1;
    return historyLoadSequenceRef.current;
  }, []);

  // Session Workbench: when a draft is promoted, rebind the Pane hosting the draft in place to
  // the real conversation id, committed in the same batch as setConversationId -- the focused Pane
  // never flashes a read-only preview, and the DOM is not remounted. workbenchController is
  // created below and backfills this ref.
  const workbenchRenameConversationRef = useRef<(fromId: string, toId: string) => void>(() => {});
  const workbenchClearRef = useRef<() => void>(() => {});

  // A draft conversation got its real id (authoritative `command_update
  // bound`): re-key every draft-scoped resource onto the real conversation.
  const bindDraftConversation = useCallback(
    (previousConversationId: string, nextConversationId: string) => {
      const previousId = previousConversationId.trim();
      const nextId = nextConversationId.trim();
      if (!previousId || !nextId || previousId === nextId) {
        return;
      }

      transcriptStoreRegistry.move(previousId, nextId);
      workbenchRenameConversationRef.current(previousId, nextId);

      const windowState = historyWindowStatesRef.current.get(previousId);
      if (windowState !== undefined) {
        historyWindowStatesRef.current.delete(previousId);
        historyWindowStatesRef.current.set(nextId, windowState);
      }

      const workdir = conversationWorkdirsRef.current.get(previousId);
      if (workdir !== undefined) {
        conversationWorkdirsRef.current.delete(previousId);
        conversationWorkdirsRef.current.set(nextId, workdir);
      }

      // Register the rewrite mapping before moving the cache: the host's draft effect cleanup
      // writes back with the old id even after the rename commits, but the mapping lands it on the
      // real id, so no orphan entry is produced.
      for (const [draftId, boundId] of boundComposerDraftIdsRef.current) {
        if (boundId === previousId) boundComposerDraftIdsRef.current.set(draftId, nextId);
      }
      boundComposerDraftIdsRef.current.set(previousId, nextId);
      const cachedComposerDraft = composerDraftCacheRef.current.get(previousId);
      if (cachedComposerDraft) {
        composerDraftCacheRef.current.delete(previousId);
        composerDraftCacheRef.current.set(nextId, cachedComposerDraft);
      }
      if (composerDraftOwnerRef.current === previousId) {
        composerDraftOwnerRef.current = nextId;
      }
      moveConversationUploads(previousId, nextId);
      if (chatQueueConversationIdRef.current === previousId) {
        chatQueueConversationIdRef.current = nextId;
      }

      if (conversationIdRef.current === previousId) {
        conversationIdRef.current = nextId;
        setConversationId(nextId);
      }
      if (selectedHistoryIdRef.current === previousId) {
        selectedHistoryIdRef.current = nextId;
        setSelectedHistoryId(nextId);
      }
      if (protectedConversationRef.current.trim() === previousId) {
        protectedConversationRef.current = nextId;
      }

      // Re-key the sidebar row: drop the draft row, merge its fields under
      // the real id. The row stays pending until a server upsert confirms it.
      const draftRow = sidebarStore.peek(previousId);
      sidebarStore.removeLocal(previousId);
      if (draftRow) {
        const existingNext = sidebarStore.peek(nextId);
        sidebarStore.upsertLocal({
          id: nextId,
          title: existingNext?.title?.trim() || draftRow.title,
          providerId: existingNext?.providerId || draftRow.providerId,
          model: existingNext?.model || draftRow.model,
          sessionId: existingNext?.sessionId || draftRow.sessionId,
          cwd: existingNext?.cwd || draftRow.cwd,
          messageCount: existingNext?.messageCount ?? draftRow.messageCount,
          createdAt: existingNext?.createdAt ?? draftRow.createdAt,
          updatedAt: existingNext?.updatedAt ?? draftRow.updatedAt,
          isPinned: existingNext?.isPinned ?? draftRow.isPinned,
          pinnedAt: existingNext ? existingNext.pinnedAt : draftRow.pinnedAt,
          isShared: existingNext?.isShared ?? draftRow.isShared,
          selectedModelJson: existingNext?.selectedModelJson || draftRow.selectedModelJson,
          isPending: existingNext && existingNext.isPending !== true ? undefined : true,
        });
      }
      // Re-key the local model override so the pick made on the draft keeps
      // applying to the bound conversation.
      setConversationModelOverrides((prev) => {
        const override = prev.get(previousId);
        if (!override) return prev;
        const next = new Map(prev);
        next.delete(previousId);
        if (!next.has(nextId)) next.set(nextId, override);
        return next;
      });
    },
    [moveConversationUploads, sidebarStore, transcriptStoreRegistry],
  );

  const ensureTunnelToolTab = useCallback(
    (projectPathKey?: string) => {
      const targetProjectPathKey =
        workspaceProjectPathKey(projectPathKey) ||
        workspaceProjectPathKey(activeWorkspaceProjectPath);
      if (!targetProjectPathKey) return;
      setSettings((prev) => openRightDockSingletonTab(prev, targetProjectPathKey, "tunnel"));
    },
    [activeWorkspaceProjectPath, setSettings],
  );

  // Tunnel list refreshes arrive through the tunnel.state push; the chat
  // event only opens the tunnel tool tab when the agent creates a tunnel.
  const handleTunnelManagerChatEvent = useCallback(
    (event: ChatEvent) => {
      const change = readTunnelManagerToolChange(event);
      if (!change) return;
      if (change.action === "create") {
        ensureTunnelToolTab(change.projectPathKey);
      }
    },
    [ensureTunnelToolTab],
  );

  useGatewayTransportStatus({
    activityStore,
    api,
    chatCommandPipeline,
    setGatewayConnectionLost,
    setSidebarAgentStatusFresh,
    setStatus,
    setStatusError,
    statusRef,
  });

  const refreshChatQueueSnapshot = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue) {
        return;
      }
      void currentApi
        .chatQueueGet(conversationIdValue)
        .then((response) => applyChatQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyChatQueueSnapshot],
  );

  // Command pipeline hooks (assigned per render so they see fresh closures).
  pipelineOnBoundRef.current = (update, pending) => {
    const draftId = draftClientRequestsRef.current.get(pending.clientRequestId)?.trim() ?? "";
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    const realId = update.conversationId?.trim() ?? "";
    if (draftId && realId && draftId !== realId) {
      bindDraftConversation(draftId, realId);
    }
  };
  pipelineOnQueuedInGuiRef.current = (update, pending) => {
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    refreshChatQueueSnapshot(update.conversationId?.trim() || pending.conversationId);
    if (pending.isEditResend) {
      // The seeded `rebased` already truncated committed optimistically, but
      // the command was parked — server-side history is unchanged; a quiet
      // window refresh restores the truncated suffix (the edit anchor always
      // sits inside the loaded window, so the window covers the whole cut).
      void refreshDisplayedConversationHistorySnapshot(
        update.conversationId?.trim() || pending.conversationId,
        api,
      );
    }
  };
  pipelineOnFailedRef.current = (pending, _errorCode, message) => {
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    const conversationIdValue = pending.conversationId.trim();
    if (pending.isEditResend) {
      void refreshDisplayedConversationHistorySnapshot(conversationIdValue, api);
    }
    if (isLocalDraftConversationId(conversationIdValue)) {
      // The draft never materialized: drop its optimistic sidebar row. The
      // transcript keeps the pipeline's error entry.
      sidebarStore.removeLocal(conversationIdValue);
    }
    if (isDisplayedConversation(conversationIdValue)) {
      setChatError(message);
    }
  };

  // THE transcript source: the displayed conversation's store snapshot plus a
  // persistent stream subscription (subscribed whenever the id is real —
  // regardless of running state, which is what makes GUI queue auto-sends
  // race-free: the next run's events simply flow in).
  const displayedConversationId = resolveVisibleConversationId(selectedHistoryId, conversationId);

  // Effective model for a conversation: local override > persisted choice carried by the sidebar
  // row > global default.
  const selectionForConversation = useCallback(
    (targetConversationId: string) =>
      resolveActiveModelSelection({
        settings,
        override: conversationModelOverrides.get(targetConversationId),
        persistedSelectedModelJson: sidebarStore.peek(targetConversationId)?.selectedModelJson,
      }),
    [conversationModelOverrides, settings, sidebarStore],
  );
  const activeSelectedModel = useMemo(
    () =>
      resolveActiveModelSelection({
        settings,
        override: conversationModelOverrides.get(displayedConversationId),
        persistedSelectedModelJson:
          sidebarConversationsById.get(displayedConversationId)?.selectedModelJson,
      }),
    [conversationModelOverrides, displayedConversationId, settings, sidebarConversationsById],
  );
  // The persistence echo of the override (which flows back with history-sync after this
  // conversation's selected_model is persisted) is cleared on arrival, and the conversation then
  // uses the server-authoritative value.
  useEffect(() => {
    if (conversationModelOverrides.size === 0) return;
    let changed = false;
    const next = new Map(conversationModelOverrides);
    for (const [id, override] of conversationModelOverrides) {
      const persisted = parseSelectedModelJson(sidebarConversationsById.get(id)?.selectedModelJson);
      if (
        persisted &&
        persisted.customProviderId === override.customProviderId &&
        persisted.model === override.model
      ) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setConversationModelOverrides(next);
  }, [conversationModelOverrides, sidebarConversationsById]);

  const {
    displayedConversationBusy,
    displayedTranscript,
    manualCompactPending,
    manualCompactTransientConversations,
  } = useGatewayConversationRuntime({
    activityStore,
    api,
    applyLiveConversationTitle,
    chatCommandPipeline,
    clearManualCompactPendingRequest,
    displayedConversationBusyRef,
    displayedConversationId,
    handleTunnelManagerChatEvent,
    isLocalDraftConversationId,
    locale: settings.locale,
    manualCompactPendingByConversation,
    manualCompactPendingRef,
    pendingCommandRevision,
    refreshChatQueueSnapshot,
    setChatError,
    transcriptStoreRegistry,
  });

  // Open in flight (history-window fetch, before the replace apply paints).
  const historyDetailLoading = conversationOpenState.phase === "opening";

  useGatewayHistoryReconciliation({
    api,
    conversationIdRef,
    displayedConversationBusy,
    displayedConversationId,
    historyWindowStatesRef,
    isConversationBusy,
    needsHistoryRefresh: displayedTranscript.needsHistoryRefresh,
    refreshDisplayedConversationHistorySnapshot,
    selectedHistoryIdRef,
    transcriptStoreRegistry,
  });

  // --- Conversation open (controller deps) ----------------------------------
  // Single-phase open: paint the conversation's established history window
  // (first opens fetch the initial tail, revisits everything the user has
  // paged up to). Sets the selection state synchronously (controller.open
  // calls this in the same tick), fetches the window, and replace-applies it
  // to the transcript store. The web end has no synchronous local-activation
  // path, so it always resolves "painted" (never "cache-hit") — revisits
  // still show the cached transcript instantly because the registry store
  // keeps rendering underneath. Messages above the window edge stay
  // unfetched until the user pages up ("load earlier history"): hydrating
  // the full record on open would put open cost back on the conversation's
  // lifetime size, which is exactly what the lazy window avoids.
  const openConversationInitial = useMemo(
    () =>
      createOpenConversationInitial({
        api,
        conversationIdRef,
        conversationWorkdirsRef,
        getDisplayedConversationId,
        historyLoadSequenceRef,
        historyWindowStatesRef,
        invalidateHistoryLoad,
        localeErrorMessage: translate("chat.history.openFailed", settings.locale),
        markVisibleConversationRevision,
        pendingDisplayedConversationAutoBottomRef,
        protectedConversationRef,
        selectedHistoryIdRef,
        setChatError,
        setConversationId,
        setSelectedHistory,
        setSelectedHistoryId,
        transcriptStoreRegistry,
        visibleConversationRevisionRef,
      }),
    [
      api,
      getDisplayedConversationId,
      invalidateHistoryLoad,
      markVisibleConversationRevision,
      settings.locale,
      transcriptStoreRegistry,
    ],
  );

  openInitialRef.current = openConversationInitial;

  const prepareChatRuntime = useGatewayRuntimePreparation({
    api,
    historyShareToken,
    locale: settings.locale,
    preparePromiseRef: chatRuntimePreparePromiseRef,
    setStatus,
    setStatusError,
    statusOnline: status?.online,
    statusRef,
  });

  const branchInFlightRef = useRef(false);
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);
  const {
    handleBranchConversation: handleBranchConversationImpl,
    handleLoadUploadedImagePreview: handleLoadUploadedImagePreviewImpl,
    handleResendFromEdit: handleResendFromEditImpl,
    handleSidebarConversationsRemoved,
    handleSidebarLocalDraftDeleted,
    handleSidebarNewConversation,
    handleSidebarOpenResourceHub,
    handleSidebarSelectConversation,
    startNewConversation,
  } = createGatewayConversationActions({
    activateSearchConversationWorkspace,
    clearSearchConversationWorkspace,
    activeView,
    activeWorkspaceProjectPath,
    api,
    branchFailureMessage: translate("chat.branchFailed", settings.locale),
    branchInFlightRef,
    cacheVisibleComposerDraft,
    clearCachedComposerDraft,
    composerDraftCacheRef,
    composerDraftOwnerRef,
    composerRef,
    conversationIdRef,
    conversationWorkdirsRef,
    createLocalDraftConversationId,
    getDisplayedConversationId,
    getVisibleComposerConversationId,
    historyWindowStatesRef,
    invalidateHistoryLoad,
    isAgentMode,
    isConversationBusy,
    isLocalDraftConversationId,
    markVisibleConversationRevision,
    openController,
    pendingDisplayedConversationAutoBottomRef,
    prepareComposerForConversationChange,
    protectedConversationRef,
    removeSharedHistoryItems,
    restoreCachedComposerDraft,
    selectedHistoryIdRef,
    sendChatRef,
    setActiveView,
    setBranchPendingMessageId,
    setChatError,
    setConversationId,
    setPendingUploadsForConversation,
    setRightDockOpen,
    setSelectedHistory,
    setSelectedHistoryId,
    setSidebarOpen,
    sidebarStore,
    submitInFlightRef,
    transcriptStoreRegistry,
  });
  startNewConversationRef.current = startNewConversation;

  // The factory above rebuilds every closure per render so handlers always see
  // fresh state, but these three flow into the memo'd transcript region
  // (GatewayTranscriptListRegion / row components / ChatComposerBar). Pin their
  // identities — same pattern as sendChatRef in the pre-split monolith — so
  // unrelated GatewayApp renders (composer keystrokes, queue ticks, status
  // polls) cannot defeat that memo boundary.
  const handleBranchConversation = useStableCallback(handleBranchConversationImpl);
  const handleResendFromEdit = useStableCallback(handleResendFromEditImpl);
  const handleLoadUploadedImagePreview = useStableCallback(handleLoadUploadedImagePreviewImpl);

  const translateWorkspaceProject = useCallback(
    (key: string) => translate(key, settings.locale),
    [settings.locale],
  );
  const beforeRemoveWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!workspaceProjectRootClient) {
        throw new Error(translateWorkspaceProject("chat.workspaceRootGrantsRevokeFailed"));
      }
      await workspaceProjectRootClient.revoke(project);
    },
    [translateWorkspaceProject, workspaceProjectRootClient],
  );

  const {
    removeWorkspaceProject,
    handleArchiveWorkspaceProject,
    handleUnarchiveWorkspaceProject,
    handleWorktreeRemoved,
  } = useWorkspaceProjectSettingsActions({
    setSettings,
    workspaceProjects,
    archivedWorkspaceProjectPathKeys,
    activeWorkspaceProject,
    activateWorkspaceProject,
    setActiveWorkspaceProjectId,
    t: translateWorkspaceProject,
    setErrorMessage: setSidebarActionError,
    beforeRemoveWorkspaceProject,
  });

  const isWorkspaceProjectRunning = useCallback(
    (pathKey: string) => {
      if (sidebarStore.getSnapshot().runningWorkdirPathKeys.has(pathKey)) {
        return true;
      }
      for (const [conversationId, activity] of activityStore.getSnapshot().activities) {
        const runtimeWorkdir =
          activity.workdir?.trim() ||
          conversationWorkdirsRef.current.get(conversationId)?.trim() ||
          "";
        const persistedWorkdir = sidebarStore.peek(conversationId)?.cwd?.trim() || "";
        if (workspaceProjectPathKey(runtimeWorkdir || persistedWorkdir) === pathKey) {
          return true;
        }
      }
      return false;
    },
    [activityStore, sidebarStore],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: workbench setter and version ref are stable hook outputs declared later in the composition
  const pruneWorkspaceProjectTerminalSessions = useCallback((pathKey: string) => {
    terminalSessionsVersionRef.current += 1;
    setTerminalSessions((current) =>
      current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
    );
  }, []);
  const closeWorkspaceProjectRightDock = useCallback(
    (pathKey: string) => {
      if (workspaceProjectPathKey(activeWorkspaceProjectPath) === pathKey) {
        setRightDockOpen(false);
      }
    },
    [activeWorkspaceProjectPath, setRightDockOpen],
  );
  const getDisplayedConversationWorkdir = useCallback(
    () => displayedConversationWorkdirRef.current,
    [],
  );
  const refreshWorkspaceProjectWorkdirs = useCallback(() => {
    void sidebarStore.refreshWorkdirs("delete");
  }, [sidebarStore]);
  const handleRemoveWorkspaceProject = useWorkspaceProjectDeletion({
    settings,
    t: translateWorkspaceProject,
    requestConfirmDialog,
    setErrorMessage: setSidebarActionError,
    removeWorkspaceProject,
    gitClient,
    terminalClient,
    shouldInspectTerminalSessions:
      settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal,
    isWorkspaceProjectRunning,
    onPruneTerminalSessions: pruneWorkspaceProjectTerminalSessions,
    onCloseRightDockProject: closeWorkspaceProjectRightDock,
    getDisplayedConversationWorkdir,
    startNewConversation,
    onWorktreeRemoved: refreshWorkspaceProjectWorkdirs,
  });

  const handleComposerBusyChange = useCallback((_isBusy: boolean) => {}, []);

  const handleLogout = useCallback(() => {
    invalidateHistoryLoad();
    markVisibleConversationRevision();
    // Dropping the api swaps in a fresh (empty) sidebar store; the start/stop
    // effect stops the old one.
    openController.cancel();
    clearSession();
    chatCommandPipeline.reset();
    transcriptStoreRegistry.clear();
    activityStore.clear();
    draftClientRequestsRef.current.clear();
    historyWindowStatesRef.current.clear();
    conversationWorkdirsRef.current.clear();
    composerDraftCacheRef.current.clear();
    boundComposerDraftIdsRef.current.clear();
    composerDraftOwnerRef.current = "";
    composerRef.current?.clear();
    resetSharedHistory();
    clearPendingUploads();
    submitInFlightRef.current = false;
    setUserMenuOpen(false);
    setProjectSettingsProject(null);
    resetSettingsOverlay();
    setStatus(null);
    setStatusError(null);
    setChatError(null);
    setSidebarActionError(null);
    setFullHistoryLoading(false);
    queuedChatTurnsRef.current = [];
    chatQueueConversationIdRef.current = "";
    chatQueueRevisionRef.current = 0;
    queuedChatEditSessionRef.current = null;
    setQueuedChatTurns([]);
    setChatQueueRevision(0);
    resetProjectToolsRuntimeRef.current();
    workbenchClearRef.current();
    resetToFreshHomeConversation();
  }, [
    activityStore,
    chatCommandPipeline,
    clearPendingUploads,
    clearSession,
    invalidateHistoryLoad,
    markVisibleConversationRevision,
    openController,
    resetSharedHistory,
    resetToFreshHomeConversation,
    transcriptStoreRegistry,
    resetSettingsOverlay,
    setProjectSettingsProject,
  ]);

  const currentUserLabel = translate("common.currentUser", settings.locale);
  const userMenuLabel =
    (status?.name || status?.agent_id || currentUserLabel).trim() || currentUserLabel;
  const userAvatarLabel = userMenuLabel.slice(0, 1).toUpperCase();
  const handleActiveAgentChange = useCallback(
    (agentId: string) => {
      const nextAgentId = agentId.trim();
      const previousAgentId = activeAgentIdRef.current.trim();
      activeAgentIdRef.current = nextAgentId;
      setActiveAgentId(nextAgentId);
      setStatusError(null);
      setChatError(null);
      setSidebarActionError(null);
      if (!previousAgentId || previousAgentId === nextAgentId) {
        return;
      }

      invalidateHistoryLoad();
      markVisibleConversationRevision();
      openController.cancel();
      chatCommandPipeline.reset();
      transcriptStoreRegistry.clear();
      activityStore.clear();
      draftClientRequestsRef.current.clear();
      conversationWorkdirsRef.current.clear();
      composerDraftCacheRef.current.clear();
      boundComposerDraftIdsRef.current.clear();
      composerDraftOwnerRef.current = "";
      composerRef.current?.clear();
      clearPendingUploads();
      pendingUploadContextRef.current = null;
      submitInFlightRef.current = false;
      previousDisplayedConversationIdRef.current = "";
      pendingDisplayedConversationAutoBottomRef.current = null;
      displayedConversationWorkdirRef.current = "";
      resetSharedHistory();
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = "";
      chatQueueRevisionRef.current = 0;
      queuedChatEditSessionRef.current = null;
      statusRef.current = null;
      setStatus(null);
      setSidebarAgentStatusFresh(false);
      setGatewayConnectionLost(false);
      setConversationModelOverrides(new Map());
      setFullHistoryLoading(false);
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
      setProjectPickerOpen(false);
      setProjectSettingsProject(null);
      resetSettingsOverlay();
      setActiveView("chat");
      setRightDockOpen(false);
      setNotifyItems([]);
      resetProjectToolsRuntimeRef.current();
      workbenchClearRef.current();
      resetToFreshHomeConversation();
    },
    [
      activityStore,
      chatCommandPipeline,
      clearPendingUploads,
      invalidateHistoryLoad,
      markVisibleConversationRevision,
      openController,
      resetSharedHistory,
      resetToFreshHomeConversation,
      transcriptStoreRegistry,
      setRightDockOpen,
      setActiveView,
      resetSettingsOverlay,
      setProjectSettingsProject,
      setProjectPickerOpen,
    ],
  );

  const localeContextValue = useLocaleContextValue(settings.locale);

  const resourceWorkdir =
    sidebarConversationsById.get(displayedConversationId)?.cwd?.trim() ||
    conversationWorkdirsRef.current.get(displayedConversationId)?.trim() ||
    (searchConversationWorkdir === ""
      ? ""
      : isAgentMode
        ? activeWorkspaceProjectPath || settings.system.workdir.trim()
        : "");
  const {
    activeProviders,
    availableSkills,
    chatRuntimeControlsForCurrentProvider,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    codeReviewSkill,
    currentChatProvider,
    currentModelContextWindow,
    currentModelLabel,
    enabledComposerSkills,
    handleChatRuntimeControlsChange,
    handleSelectModel,
    isAgentDevExecutionMode,
    modelOptions,
    selectedValue,
    skillsRootDir,
    workspaceResources,
  } = useGatewayChatConfiguration({
    activeSelectedModel,
    displayedConversationId,
    isAgentMode,
    resourceWorkdir,
    setConversationModelOverrides,
    setSettings,
    settings,
  });
  // App candidates for the @ popover: gating is exactly the same as the GUI (agent mode +
  // workspace with cua-driver attached), and the list is relayed straight through the Gateway from
  // the desktop host machine.
  const mentionApps = useMentionApps(workspaceResources.mcpServers, isAgentMode);
  const {
    cancelChat,
    commitQueuedChatEdit,
    editQueuedTurn,
    materializeComposerDraftForSend,
    moveQueuedTurnUp,
    removeQueuedTurn,
    runQueuedTurnNow,
    sendChat,
    submitCurrentComposerToGuiQueue,
  } = createGatewayChatCommandActions({
    activeProviders,
    activeWorkspaceProjectPath,
    activityStore,
    api,
    apiRef,
    applyChatQueueSnapshot,
    chatCommandPipeline,
    chatQueueRevisionRef,
    chatRuntimeControlsForCurrentProvider,
    clearCachedComposerDraft,
    composerRef,
    conversationIdRef,
    conversationWorkdirsRef,
    displayedConversationWorkdirRef,
    draftClientRequestsRef,
    getDisplayedConversationId,
    getPendingUploadsForConversation,
    isAgentMode,
    isDisplayedConversation,
    isImportingPastedTextRef,
    isLocalDraftConversationId,
    pendingUploadedFiles,
    prepareChatRuntime,
    protectedConversationRef,
    queuedChatEditSessionRef,
    refreshChatQueueSnapshot,
    resolveActiveAgentID,
    selectedHistoryIdRef,
    selectionForConversation,
    sendChatRef,
    setChatError,
    setConversationId,
    setPendingUploadsForConversation,
    setSelectedHistoryId,
    setUploadingFiles,
    settings,
    sidebarStore,
    token,
    transcriptFollow,
    transcriptStoreRegistry,
  });

  const canShareHistory = Boolean(
    api &&
      settings.remote.enabled &&
      settings.remote.gatewayUrl.trim() &&
      settings.remote.token.trim(),
  );
  // Sidebar rows, running dots, and project activity all render inside
  // <GatewaySidebarContainer/> from the sidebar store — no app-root memos.
  const currentConversationPersistedCwd =
    sidebarConversationsById.get(displayedConversationId)?.cwd?.trim() || "";
  const currentConversationRuntimeWorkdir =
    conversationWorkdirsRef.current.get(displayedConversationId)?.trim() || "";
  const displayedConversationWorkdir =
    currentConversationPersistedCwd ||
    currentConversationRuntimeWorkdir ||
    (searchConversationWorkdir === ""
      ? ""
      : isAgentMode
        ? activeWorkspaceProjectPath || settings.system.workdir.trim()
        : "");
  const searchMentionableConversations = useCallback(
    (query: string) =>
      searchMentionConversations({
        query,
        currentConversationId: displayedConversationId,
        currentWorkdir: displayedConversationWorkdir,
      }),
    [displayedConversationId, displayedConversationWorkdir],
  );
  displayedConversationWorkdirRef.current = displayedConversationWorkdir;
  // Switching conversations keeps every conversation's uploads, but a workdir
  // change within the same conversation (a draft switching projects)
  // invalidates them (staged uploads stay readable, workspace picks do not),
  // and a mode flip away from tools invalidates all of them — mirroring the
  // GUI-side rule in usePendingUploads.
  useEffect(() => {
    const executionMode = settings.system.executionMode;
    const previous = pendingUploadContextRef.current;
    pendingUploadContextRef.current = {
      conversationId: displayedConversationId,
      workdir: displayedConversationWorkdir,
      executionMode,
    };
    if (!previous) return;
    if (previous.executionMode !== executionMode) {
      clearPendingUploads();
      return;
    }
    if (previous.conversationId !== displayedConversationId) return;
    if (previous.workdir === displayedConversationWorkdir) return;
    setPendingUploadsForConversation(displayedConversationId, []);
  }, [
    clearPendingUploads,
    displayedConversationId,
    displayedConversationWorkdir,
    settings.system.executionMode,
    setPendingUploadsForConversation,
  ]);
  useEffect(() => {
    if (!api || !displayedConversationId) {
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = "";
      chatQueueRevisionRef.current = 0;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
      return;
    }
    if (chatQueueConversationIdRef.current !== displayedConversationId) {
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = displayedConversationId;
      chatQueueRevisionRef.current = 0;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
    }
    let cancelled = false;
    void api
      .chatQueueGet(displayedConversationId)
      .then((response) => {
        if (!cancelled) applyChatQueueSnapshot(response.snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, applyChatQueueSnapshot, displayedConversationId]);
  const queuedChatTurnsForDisplayedConversation = useMemo<ChatQueueTurnPreview[]>(
    () =>
      queuedChatTurns.map((item) => ({
        id: item.id,
        previewText: item.previewText,
        fileCount: item.fileCount,
      })),
    [queuedChatTurns],
  );
  const {
    associatedSshHostIds,
    changedFilesActions,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleGitReviewFocusRequestHandled,
    handleEmptyStateSuggestion,
    handleChatTranscriptWidthChange,
    handleInsertCodeMention,
    handleOpenChatFileLink,
    handleOpenSftpFile,
    handleOpenSshTerminal,
    handleOpenWorkspaceFile,
    handleProjectTerminalSessionsChange,
    updateProjectTerminalSessions,
    handleRightDockClose,
    handleRightDockFileTreeStateChange,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockInsertCommitMention,
    handleRightDockInsertFileMention,
    handleRightDockInsertGitFileMention,
    handleRightDockProjectStateChange,
    handleRightDockWidthChange,
    handleSshProjectHostIdsChange,
    handleWorkspaceEditorClosed,
    handleWorkspaceEditorHide,
    handleWorkspaceFilePreviewClosed,
    hideWorkspaceSshTerminalOverlay,
    isSuggestionTyping,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    projectTerminalSessions,
    projectToolsDisabledMessage,
    requestWorkspaceFilePreviewClose,
    rightDockFileTreeState,
    rightDockProjectState,
    terminalDisabledMessage,
    terminalProjectPath,
    terminalProjectPathKey,
    terminalSessions,
    terminalSessionsLoaded,
    terminalSessionsVersionRef,
    setTerminalSessions,
    tunnelDisabledMessage,
    tunnelEnabled,
    workspaceActivityClient,
    workspaceEditorCleanupPending,
    workspaceEditorCloseRequestId,
    workspaceEditorMounted,
    workspaceEditorOpen,
    workspaceEditorOpenRequest,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
  } = useGatewayProjectTools({
    activeWorkspaceProjectPath,
    addNotify,
    api,
    codeReviewSkill,
    composerRef,
    displayedConversationId,
    displayedConversationWorkdir,
    isAgentMode,
    resetProjectToolsRuntimeRef,
    setRightDockOpen,
    setSettings,
    settings,
    settingsSyncReady,
    status,
    terminalClient,
  });

  const verifyTerminalSessionAlive = useCallback(
    async (_sessionId: string) => {
      if (!terminalClient) return;
      try {
        const sessions = await terminalClient.list();
        terminalSessionsVersionRef.current += 1;
        setTerminalSessions(sortTerminalSessions(sessions));
      } catch {
        // A transient gateway error should not misclassify a still-live terminal as a ghost
        // conversation.
      }
    },
    [setTerminalSessions, terminalClient, terminalSessionsVersionRef],
  );

  // --- Session Workbench (multi-board split view) ----------------------------
  // Layout and focus semantics reuse the shared reducer; the focused Pane's conversation === the
  // page's current conversation (the same invariant as the desktop). Every conversation Pane
  // renders the same complete host, and focus changes only swap bindings without tearing down the
  // DOM; sidebar selection goes through syncCurrentConversation (focus an existing Pane, otherwise
  // rebind the focused Pane). The drag system is shared with the desktop.
  const workbenchController = useGatewayWorkbench({
    enabled: sessionWorkbench.enabled,
    displayedConversationId,
    sidebarStore,
    workspaceProjects,
    archivedProjectPathKeys: archivedWorkspaceProjectPathKeys,
    missingProjectPathKeys: missingWorkspaceProjectPathKeys,
    activateWorkspaceProject,
    terminalClient,
    terminalSessions,
    terminalProjectPath,
    newTerminalTitle: translate("projectTools.newTerminal", settings.locale),
    projectToolTitle: (tool) => translate(projectToolSurfaceTitleKey(tool), settings.locale),
    selectConversation: handleSidebarSelectConversation,
    startConversationForProject: handleNewConversationForProject,
    conversationWorkdirFor: (conversationId) =>
      conversationWorkdirsRef.current.get(conversationId)?.trim() ||
      sidebarStore.peek(conversationId)?.cwd?.trim() ||
      null,
    onNoSpaceForSplit: () =>
      addNotify("error", translate("workbench.noSpaceForSplit", settings.locale)),
    onDropStateChanged: () =>
      addNotify("error", translate("workbench.dropStateChanged", settings.locale)),
    onWorkspaceDropFailed: (error) =>
      addNotify(
        "error",
        asErrorMessage(error, translate("workbench.workspaceDropFailed", settings.locale)),
      ),
    onConversationAlreadyOpen: () =>
      addNotify("success", translate("workbench.conversationAlreadyOpen", settings.locale)),
    onProjectToolPaneClosed: (tool, projectPathKey) =>
      setSettings((prev) => releaseProjectToolFromDock(prev, tool, projectPathKey)),
    onTerminalCloseFailed: (message) => addNotify("error", message),
  });
  workbenchRenameConversationRef.current = workbenchController.workbench.renameConversation;
  workbenchClearRef.current = workbenchController.clearWorkbench;

  // A conversation disappears from the authoritative index (bulk delete, etc.): collapse the
  // corresponding Pane first, then go through the existing removal path; after the selection
  // migration when displayed is deleted completes, syncCurrentConversation rebinds the focused
  // Pane to the new current conversation. Draft ids must be skipped -- promoting a draft moves the
  // draft id out of the authoritative index via removeLocal, and by then the Pane has already been
  // rebound in place by the rename path, so collapsing the Pane would wrongly close the focused
  // panel; this matches the underlying handler's policy of skipping drafts. A user manually
  // deleting a draft goes through the onLocalDraftDeleted path.
  const handleSidebarConversationsRemovedWithWorkbench = (ids: readonly string[]) => {
    workbenchController.closePanesForRemovedConversations(
      ids.filter((id) => !isLocalDraftConversationId(id)),
    );
    handleSidebarConversationsRemoved(ids);
  };
  const handleSidebarLocalDraftDeletedWithWorkbench = (id: string) => {
    workbenchController.closePanesForRemovedConversations([id]);
    handleSidebarLocalDraftDeleted(id);
  };
  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    const targetConversationId = displayedConversationId.trim();
    if (!targetConversationId) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      // Once Workbench is enabled, drafts are always managed by a stable Pane host, including the
      // frame where the layout converges from multiple Panes back to a single Pane; page-level
      // restore may only serve the legacy composer when Workbench is off, otherwise it would
      // overwrite the not-yet-written-back input in the host with stale cache.
      if (sessionWorkbench.enabled) {
        composerDraftOwnerRef.current = targetConversationId;
        return;
      }
      const composer = composerRef.current;
      if (!composer) return;
      if (
        !shouldRestorePageComposerDraft({
          workbenchEnabled: false,
          targetConversationId,
          ownerConversationId: composerDraftOwnerRef.current,
          composerHasContent: composer.hasContent(),
        })
      )
        return;
      restoreCachedComposerDraft(targetConversationId);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeView, displayedConversationId, restoreCachedComposerDraft]);

  const {
    approvalBar,
    approvalConversationIds,
    canDropUpload,
    chatProtocolIncompatibleMessage,
    composerCompactionBlocked,
    composerInputDisabled,
    composerIsSending,
    composerPlaceholder,
    contextUsageTokensSource,
    displayedTranscriptRowCount,
    fileDropDescription,
    fileDropLimitHint,
    fileDropTitle,
    handleFileDragOver,
    handleFileDrop,
    handleLoadEarlierHistory,
    handleManualCompact,
    historyDetailLoadingTitle,
    loadingOlderHistory,
    selectedHistoryHasMore,
    sidebarSectionsDisabled,
    taskProgressSnapshot,
    transcriptBusy,
    transcriptError,
    transcriptFloors,
    transcriptHistoryLoading,
    transcriptLiveStartIndex,
    transcriptRows,
    transcriptToolStatus,
    transcriptToolStatusIsCompaction,
  } = useGatewayChatPresentation({
    activeView,
    activeWorkspaceProject,
    api,
    chatCommandHasPending: (conversationId) => chatCommandPipeline.hasPending(conversationId),
    chatError,
    clearManualCompactPendingRequest,
    displayedConversationBusy,
    displayedConversationId,
    displayedConversationWorkdir,
    displayedTranscript,
    enabledComposerSkills,
    fullHistoryLoading,
    gatewayConnectionLost,
    handlePendingFileDragOver,
    handlePendingFileDrop,
    historyDetailLoading,
    historyShareToken,
    isAgentMode,
    isDisplayedConversation,
    isLocalDraftConversationId,
    isUploadingFiles,
    manualCompactPendingRef,
    refreshDisplayedConversationHistorySnapshot,
    selectedHistory,
    selectedHistoryId,
    setChatError,
    setFullHistoryLoading,
    setManualCompactPendingRequest,
    settings,
    sidebarAgentStatusFresh,
    sidebarConversationsById,
    status,
    token,
    transcriptStoreRegistry,
  });

  useEffect(() => {
    const nextDisplayedConversationId = displayedConversationId.trim();
    const previousDisplayedConversationId = previousDisplayedConversationIdRef.current.trim();
    previousDisplayedConversationIdRef.current = nextDisplayedConversationId;
    if (
      !nextDisplayedConversationId ||
      !previousDisplayedConversationId ||
      previousDisplayedConversationId === nextDisplayedConversationId
    ) {
      return;
    }
    // Switching away folds the settled turns so revisits start clean.
    transcriptStoreRegistry.peek(previousDisplayedConversationId)?.foldSettledTurns();
    pendingDisplayedConversationAutoBottomRef.current = nextDisplayedConversationId;
  }, [displayedConversationId, transcriptStoreRegistry]);

  useLayoutEffect(() => {
    const targetConversationId = pendingDisplayedConversationAutoBottomRef.current?.trim() ?? "";
    if (
      !targetConversationId ||
      historyDetailLoading ||
      displayedConversationId.trim() !== targetConversationId ||
      displayedTranscriptRowCount === 0
    ) {
      return;
    }

    transcriptFollow.stickToBottom();
    pendingDisplayedConversationAutoBottomRef.current = null;
  }, [
    displayedConversationId,
    displayedTranscriptRowCount,
    historyDetailLoading,
    transcriptFollow,
  ]);

  if (historyShareToken) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <SharedHistoryPage token={historyShareToken} />
      </LocaleContext.Provider>
    );
  }

  if (!token) {
    return (
      <LoginPage
        token={loginToken}
        error={authError}
        isSubmitting={authSubmitting}
        onTokenChange={(nextToken) => {
          setLoginToken(nextToken);
          if (authError) {
            setAuthError(null);
          }
        }}
        onSubmit={handleLoginSubmit}
      />
    );
  }

  if (!api) {
    return null;
  }

  if (!settingsSyncReady) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <div className="gateway-shell">
          <main className="gateway-main-shell">
            <div className="gateway-main-backdrop" />
            <div className="gateway-chat-frame flex items-center justify-center">
              <SettingsSyncLoading locale={settings.locale} />
            </div>
          </main>
        </div>
      </LocaleContext.Provider>
    );
  }
  // --- Per-conversation binding for multi-board background Panes (replicating the data plane of
  // the desktop's buildBackgroundPaneBinding): workspace, draft cache, and attachment import are
  // all routed by explicit conversationId. ---
  const getCachedComposerDraft = (targetConversationId: string) =>
    composerDraftCacheRef.current.get(resolveComposerDraftKey(targetConversationId));
  const setCachedComposerDraft = (targetConversationId: string, draft: MentionComposerDraft) => {
    composerDraftCacheRef.current.set(resolveComposerDraftKey(targetConversationId), draft);
  };
  const importFilesForConversation = (
    targetConversationId: string,
    workdir: string,
    files: File[],
  ) => handleImportReadableFiles(files, { conversationId: targetConversationId, workdir });

  const viewModel = {
    activeFloorKey,
    activeSelectedModel,
    activeView,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    addNotify,
    api,
    approvalBar,
    approvalConversationIds,
    archivedWorkspaceProjectPathKeys,
    associatedSshHostIds,
    availableSkills,
    branchPendingMessageId,
    canDropUpload,
    canShareHistory,
    cancelChat,
    changedFilesActions,
    chatError,
    chatProtocolIncompatibleMessage,
    chatRuntimeControlsForCurrentProvider,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    closeSettings,
    codeReviewSkill,
    commitQueuedChatEdit,
    composerCompactionBlocked,
    composerInputDisabled,
    composerIsSending,
    composerPlaceholder,
    composerRef,
    confirmDialog,
    contextUsageTokensSource,
    conversationId,
    conversationOpenState,
    currentChatProvider,
    currentModelContextWindow,
    currentModelLabel,
    dismissNotify,
    displayedConversationBusyRef,
    displayedConversationId,
    displayedConversationWorkdir,
    displayedTranscript,
    displayedTranscriptRowCount,
    editQueuedTurn,
    effectiveTheme,
    enabledComposerSkills,
    fileDropDescription,
    fileDropLimitHint,
    fileDropTitle,
    fileInputRef,
    folderInputRef,
    gatewayConnectionLost,
    getCachedComposerDraft,
    getDisplayedConversationId,
    getPendingUploadsForConversation,
    subscribePendingUploads,
    gitClient,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleActiveAgentChange,
    handleArchiveWorkspaceProject,
    handleBranchConversation,
    handleBrowseWorkspaceProjectInFileTree,
    handleCancelWorkspaceCloneTask,
    handleChatRuntimeControlsChange,
    handleChatTranscriptWidthChange,
    handleCloneWorkspaceProject,
    handleCloseShareModal,
    handleCommitWorkspaceProjectRename,
    handleComposerBusyChange,
    handleCreateWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleDisableSharedHistory,
    handleDismissWorkspaceCloneTask,
    handleEmptyStateSuggestion,
    handleFileDragEnter,
    handleFileDragLeave,
    handleFileDragOver,
    handleFileDrop,
    handleFloorJump,
    handleGitReviewFocusRequestHandled,
    handleImportReadableFiles,
    handleImportSelectedDirectoryFiles,
    handleInsertCodeMention,
    handleLoadEarlierHistory,
    handleLoadSharedHistoryStatus,
    handleLoadUploadedImagePreview,
    handleLoadWorkspaceRemoteBranches,
    handleLogout,
    handleManualCompact,
    handleMoveWorkspaceProjectToGroup,
    handleNewConversationForProject,
    handleOpenChatFileLink,
    handleOpenClonedWorkspace,
    handleOpenCreateWorkspaceProject,
    handleOpenShareModal,
    handleOpenSharedHistoryManager,
    handleOpenSftpFile,
    handleOpenSshTerminal,
    handleOpenWorkspaceFile,
    handleOpenWorkspaceFolder,
    handleOpenWorktree,
    handleProjectTerminalSessionsChange,
    updateProjectTerminalSessions,
    handleRefreshSharedHistoryStatuses,
    handleRemoveWorkspaceProject,
    handleRenameWorkspaceGroup,
    handleResendFromEdit,
    handleRightDockClose,
    handleRightDockFileTreeStateChange,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockInsertCommitMention,
    handleRightDockInsertFileMention,
    handleRightDockInsertGitFileMention,
    handleRightDockProjectStateChange,
    handleRightDockWidthChange,
    handleSelectModel,
    handleSelectWorkspaceProject,
    handleSetShareRedactToolContent,
    handleSetSharedHistoryRedactToolContent,
    handleSetWorkspaceProjectPinned,
    handleSettingsTransitionEnd,
    handleSidebarConversationsRemoved: handleSidebarConversationsRemovedWithWorkbench,
    handleSidebarLocalDraftDeleted: handleSidebarLocalDraftDeletedWithWorkbench,
    handleSidebarNewConversation,
    handleSidebarOpenResourceHub,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
    handleSidebarSelectConversation,
    handleSshProjectHostIdsChange,
    handleToggleHistoryShare,
    handleToggleWorkspaceGroupCollapsed,
    handleUnarchiveWorkspaceProject,
    handleWorkdirPickerSelect,
    handleWorkspaceEditorClosed,
    handleWorkspaceEditorHide,
    handleWorkspaceFilePreviewClosed,
    handleWorktreeRemoved,
    hideWorkspaceSshTerminalOverlay,
    historyDetailLoadingTitle,
    historyShareToken,
    importFilesForConversation,
    isAgentDevExecutionMode,
    isAgentMode,
    isConversationBusy,
    isFileDropActive,
    isImportingPastedTextRef,
    isSuggestionTyping,
    isUploadingFiles,
    uploadingConversationId,
    loadComposerHistoryPrompts,
    loadingOlderHistory,
    localeContextValue,
    manualCompactPending,
    manualCompactTransientConversations,
    mentionableConversations,
    searchMentionableConversations,
    materializeComposerDraftForSend,
    mentionApps,
    missingWorkspaceProjectPathKeys,
    modelOptions,
    moveQueuedTurnUp,
    notifyItems,
    openSettings,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    overlay,
    pendingUploadedFiles,
    prepareChatRuntime,
    projectPickerOpen,
    projectTerminalSessions,
    projectToolsDisabledMessage,
    queuedChatEditSessionRef,
    queuedChatTurnsForDisplayedConversation,
    removeQueuedTurn,
    requestWorkspaceFilePreviewClose,
    projectSettingsProject,
    rightDockFileTreeState,
    rightDockOpen,
    rightDockProjectState,
    runQueuedTurnNow,
    selectedHistoryHasMore,
    selectedValue,
    selectionForConversation,
    sendChat,
    setActiveFloorKey,
    setCachedComposerDraft,
    setPendingUploadsForConversation,
    setProjectPickerOpen,
    setProjectSettingsProject,
    setRightDockOpen,
    setSettings,
    setSharedManagerOpen,
    setSidebarOpen,
    setTranscriptScrollAreaRoot,
    setTranscriptViewport,
    setUserMenuOpen,
    setWorkspaceCreateModalOpen,
    settings,
    settingsOpen,
    settingsProviderId,
    settingsSaveState,
    settingsSection,
    settingsSyncError,
    sftpClient,
    shareConversation,
    shareError,
    shareLoading,
    shareStatus,
    shareUpdating,
    sharedHistoryItems,
    sharedHistoryListError,
    sharedManagerErrors,
    sharedManagerLoadingIds,
    sharedManagerOpen,
    sharedManagerStatuses,
    sharedManagerUpdatingIds,
    sidebarActionError,
    sidebarOpen,
    sidebarSectionsDisabled,
    sidebarStore,
    skillsRootDir,
    status,
    statusError,
    submitCurrentComposerToGuiQueue,
    submitInFlightRef,
    taskProgressSnapshot,
    terminalClient,
    terminalDisabledMessage,
    terminalProjectPath,
    terminalProjectPathKey,
    terminalSessions,
    terminalSessionsLoaded,
    transcriptBusy,
    transcriptError,
    transcriptFloors,
    transcriptFollow,
    transcriptFollowing,
    transcriptHistoryLoading,
    transcriptLiveStartIndex,
    transcriptNavRef,
    transcriptRows,
    transcriptStageRef,
    transcriptStoreRegistry,
    transcriptToolStatus,
    transcriptToolStatusIsCompaction,
    transcriptViewport,
    tunnelDisabledMessage,
    tunnelEnabled,
    updatePendingUploadsForConversation,
    verifyTerminalSessionAlive,
    userAvatarLabel,
    userMenuLabel,
    userMenuOpen,
    workbenchController,
    workdirForConversation,
    workspaceActivityClient,
    workspaceCloneTasks,
    workspaceCreateModalOpen,
    workspaceEditorCleanupPending,
    workspaceEditorCloseRequestId,
    workspaceEditorMounted,
    workspaceEditorOpen,
    workspaceEditorOpenRequest,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceFolderDropActive,
    workspaceFolderDropHandlers,
    workspaceProjects,
    workspaceProjectRootClient,
    workspaceRootRevision,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
  };
  return viewModel;
}

export type GatewayAppViewModel = Extract<
  ReturnType<typeof useGatewayAppController>,
  { activeFloorKey: string | null }
>;

export default function GatewayApp() {
  const result = useGatewayAppController();
  if (!result || !("activeFloorKey" in result)) {
    return result;
  }
  return <GatewayAppView viewModel={result} />;
}
