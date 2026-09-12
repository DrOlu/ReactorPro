import { ApplicationView } from "@liveagent/ui/application/ApplicationView";
import { AppWorkbenchChrome } from "@liveagent/ui/application/AppWorkbenchChrome";
import { AppErrorBoundary } from "@liveagent/ui/components/AppErrorBoundary";
import { ChangedFilesActionsProvider } from "@liveagent/ui/components/chat/ChangedFilesCard";
import { ConversationViewTabs } from "@liveagent/ui/components/chat/ConversationViewTabs";
import type {
  ClarifyContext,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { FileDropOverlay } from "@liveagent/ui/components/chat/FileDropOverlay";
import { HistoryShareModal } from "@liveagent/ui/components/chat/HistoryShareModal";
import { NotifyToast } from "@liveagent/ui/components/chat/NotifyToast";
import { SharedHistoryManagerModal } from "@liveagent/ui/components/chat/SharedHistoryManagerModal";
import { TaskProgressBar } from "@liveagent/ui/components/chat/TaskProgressBar";
import { WorkspaceCloneModal } from "@liveagent/ui/components/chat/WorkspaceCloneModal";
import { WorkspaceCloneTaskOverlay } from "@liveagent/ui/components/chat/WorkspaceCloneTaskOverlay";
import { WorkspaceProjectSettingsModal } from "@liveagent/ui/components/chat/WorkspaceProjectSettingsModal";
import { ChevronDown } from "@liveagent/ui/components/IconSet";
import { ProjectToolsPanelToggle } from "@liveagent/ui/components/project-tools/ProjectToolsPanelToggle";
import { RightDockPanel } from "@liveagent/ui/components/project-tools/RightDockPanel";
import { TrajectoryView } from "@liveagent/ui/components/trajectory/TrajectoryView";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { PaneChrome } from "@liveagent/ui/components/workbench/PaneChrome";
import {
  type ProjectToolPaneEnvironment,
  ProjectToolPaneHost,
} from "@liveagent/ui/components/workbench/ProjectToolPaneHost";
import { UnsupportedPaneSurface } from "@liveagent/ui/components/workbench/surfaces/UnsupportedPaneSurface";
import { WorkbenchCanvas } from "@liveagent/ui/components/workbench/WorkbenchCanvas";
import { WorkbenchEmptyState } from "@liveagent/ui/components/workbench/WorkbenchEmptyState";
import { WorkspaceOverlayHost } from "@liveagent/ui/components/workspace-editor/WorkspaceOverlayHost";
import { isWorkspacePreviewPath } from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import { LocaleContext, t as translate } from "@liveagent/ui/i18n/index";
import {
  type CheckpointRewindClient,
  CheckpointRewindProvider,
  type CheckpointRewoundInfo,
  formatCheckpointRewoundNotification,
} from "@liveagent/ui/lib/chat/checkpointRewind";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { mergePendingUploadedFiles } from "@liveagent/ui/lib/chat/uploadedFiles";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import {
  mergeTerminalSession,
  reconcileSshTerminalSessions,
  removeTerminalSession,
} from "@liveagent/ui/lib/terminal/sessionStore";
import { toTrajectoryMessages } from "@liveagent/ui/lib/trajectory/transcriptMessages";
import { useConversationViewState } from "@liveagent/ui/lib/trajectory/useConversationViewState";
import {
  hitTestWorkbenchDrop,
  leasedProjectToolKinds,
  projectToolSurfaceTitleKey,
} from "@liveagent/ui/lib/workbench/index";
import {
  isProjectToolSurface,
  type PaneRecord,
  PROJECT_TOOL_SURFACE_KINDS,
} from "@liveagent/ui/lib/workbench/types";
import { ChatComposerBar } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { FloorNavRail } from "@liveagent/ui/pages/chat/transcript/FloorNavRail";
import {
  CHAT_TRANSCRIPT_WIDTH_CSS_VAR,
  TranscriptWidthControls,
} from "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls";
import { SettingsPage } from "@liveagent/ui/pages/settings/SettingsPage";
import {
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { createGatewayTrajectoryHost } from "@/agent-ui-adapters/trajectory";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import { executeClarifyPromptTurn } from "@/lib/chat/clarifyPromptTurn";
import {
  getNextTheme,
  getRightDockFileTreeState,
  getSshProjectHostIds,
  updateExecutionModeFromChatSelection,
  updateRightDockFileTreeState,
  updateSshProjectHostIds,
  updateSystem,
  updateWorkspaceResourceSettings,
  workspaceProjectPathKey,
} from "@/lib/settings";
import {
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
  subscribeLiveTrajectory,
} from "@/lib/trajectory/liveTrajectory";
import { WorkdirPickerModal } from "@/pages/settings/WorkdirPickerModal";
import { openUrl } from "@/shims/tauriOpener";
import { AgentSelector } from "./AgentSelector";
import { ConversationStatsBarHost } from "./ConversationStatsBarHost";
import { asErrorMessage } from "./chatEventUtils";
import { CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS } from "./constants";
import type { GatewayAppViewModel } from "./GatewayApp";
import { isLocalDraftConversationId } from "./gatewayLocalDraft";
import { HistorySwitchLoadingOverlay } from "./HistorySwitchLoadingOverlay";
import { useWindowFileDropGuard } from "./hooks/useWindowFileDropGuard";
import { GatewaySidebarContainer } from "./sidebar/GatewaySidebarContainer";
import { UserMenu } from "./UserMenu";
import {
  GatewayConversationPaneHost,
  type GatewayConversationPaneHostContext,
  type GatewayConversationPrimarySurface,
} from "./workbench/GatewayConversationPaneHost";
import { GatewayTerminalPaneHost } from "./workbench/GatewayTerminalPaneHost";
import { sessionWorkbench } from "./workbench/sessionWorkbench";

export function GatewayAppView({ viewModel }: { viewModel: GatewayAppViewModel }) {
  useWindowFileDropGuard();
  const {
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
    handleSidebarConversationsRemoved,
    handleSidebarLocalDraftDeleted,
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
  } = viewModel;

  const {
    activeConversationView,
    setActiveConversationView,
    viewForConversation,
    setConversationView,
  } = useConversationViewState(displayedConversationId);
  const trajectoryHost = useMemo(
    () => createGatewayTrajectoryHost(api, handleOpenChatFileLink),
    [api, handleOpenChatFileLink],
  );
  // The body is only needed when switching to the trajectory page; the
  // conversion itself is cheap, so following the transcript rows memo is fine.
  const trajectoryMessages = useMemo(() => toTrajectoryMessages(transcriptRows), [transcriptRows]);
  const hasConversationReply =
    displayedConversationId !== "" &&
    !isLocalDraftConversationId(displayedConversationId) &&
    trajectoryMessages.some((message) => message.role === "assistant");
  const renderedConversationView = hasConversationReply ? activeConversationView : "conversation";
  // The live skeleton comes from the ChatEvent stream; the ledger layer
  // deduplicates by event identity, so merging it with the persisted copy is
  // safe.
  const liveTrajectory = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryEvents(displayedConversationId),
  );
  const trajectoryAuthoritativeRevision = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryAuthoritativeRevision(displayedConversationId),
  );
  const handleSelectExecutionMode = useCallback(
    (mode: "text" | "tools") =>
      setSettings((prev) => updateExecutionModeFromChatSelection(prev, mode)),
    [setSettings],
  );
  const resolveCheckpointAuthorizedRoots = useCallback(async () => {
    const roots: string[] = [];
    const push = (value?: string | null) => {
      const normalized = value?.trim();
      if (normalized && !roots.includes(normalized)) roots.push(normalized);
    };
    push(displayedConversationWorkdir);
    if (
      activeWorkspaceProject &&
      activeWorkspaceProjectPath &&
      activeWorkspaceProjectPath === displayedConversationWorkdir
    ) {
      try {
        const grants = await api.listWorkspaceRootGrants(
          activeWorkspaceProject.id,
          activeWorkspaceProject.path,
        );
        for (const grant of grants) {
          if (grant.state === "active" && grant.access === "write") push(grant.canonicalPath);
        }
      } catch {
        // Keep the primary root when additional grant lookup fails.
      }
    }
    return roots;
  }, [activeWorkspaceProject, activeWorkspaceProjectPath, api, displayedConversationWorkdir]);
  const checkpointClient = useMemo<CheckpointRewindClient>(
    () => ({
      list: (conversationId) => api.listCheckpointTurns(conversationId),
      preview: (params) => api.previewCheckpointRewind(params),
      rewind: (params) => api.rewindCheckpoint(params),
    }),
    [api],
  );

  const handleCheckpointRewound = useCallback(
    (info: CheckpointRewoundInfo) => {
      const notice = formatCheckpointRewoundNotification(info, settings.locale === "zh-CN");
      addNotify(notice.level, notice.message);
    },
    [addNotify, settings.locale],
  );
  // Prompt clarification executor: relays through the gateway to the desktop
  // host and runs one plain-text completion with the current conversation model;
  // model override/fallback/error flattening lives in executeClarifyPromptTurn
  // (shared by both hosts).
  const runClarifyTurn = useCallback<RunClarifyTurn>(
    (messages, _signal, onTextDelta) =>
      executeClarifyPromptTurn(
        api,
        settings,
        {
          provider: currentChatProvider,
          model: activeSelectedModel?.model,
          runtimeControls: chatRuntimeControlsForCurrentProvider,
        },
        messages,
        onTextDelta,
      ),
    [
      settings,
      activeSelectedModel,
      currentChatProvider,
      chatRuntimeControlsForCurrentProvider,
      api,
    ],
  );

  const clarifyContext = useMemo<ClarifyContext | undefined>(
    () => (displayedConversationWorkdir ? { workdir: displayedConversationWorkdir } : undefined),
    [displayedConversationWorkdir],
  );

  // --- Session Workbench (multi-pane split view) -----------------------------
  // Pane titles/ARIA labels come from the sidebar's authoritative index; title
  // changes must trigger a re-render, so use useSidebarSelector rather than
  // store.peek.
  const sidebarConversationsById = useSidebarSelector(sidebarStore, (snapshot) => snapshot.byId);
  // Same semantics as the desktop workbenchPaneTitle: shared by chrome hints,
  // drag ghosts and ARIA labels.
  const workbenchPaneTitle = useCallback(
    (surface: PaneRecord["surface"]): string => {
      switch (surface.kind) {
        case "conversation":
          return sidebarConversationsById.get(surface.conversationId)?.title?.trim() || "";
        case "fileTree":
        case "gitReview":
        case "tunnel":
        case "sshTunnel":
        case "backgroundTasks":
          return translate(projectToolSurfaceTitleKey(surface.kind), settings.locale);
        case "localTerminal":
          return surface.launchSpec.title?.trim() || surface.launchSpec.shell?.trim() || "Terminal";
        case "sshTerminal":
          return surface.launchSpec.title?.trim() || surface.launchSpec.sshHostId.trim() || "SSH";
        case "unsupported":
          return surface.originalKind;
      }
    },
    [settings.locale, sidebarConversationsById],
  );

  const workbenchHasMultiplePanes =
    sessionWorkbench.enabled && Object.keys(workbenchController.workbench.layout.panes).length >= 2;
  const primarySendInFlightConversationRef = useRef<string | null>(null);

  const handlePrimaryComposerSend = useCallback(() => {
    const sendConversationId = getDisplayedConversationId();
    if (primarySendInFlightConversationRef.current === sendConversationId) return;
    // An in-flight upload blocks only the owning conversation: a background
    // Pane's import should not swallow the main Pane's send. When ownership is
    // unknown (null), block conservatively, matching the old global mutex
    // semantics.
    const uploadBlocksSend =
      isUploadingFiles &&
      (!uploadingConversationId || uploadingConversationId === sendConversationId);
    if (uploadBlocksSend || isImportingPastedTextRef.current) return;
    if (composerInputDisabled) return;
    if (queuedChatEditSessionRef.current) {
      primarySendInFlightConversationRef.current = sendConversationId;
      void (async () => {
        try {
          await commitQueuedChatEdit();
        } finally {
          if (primarySendInFlightConversationRef.current === sendConversationId) {
            primarySendInFlightConversationRef.current = null;
          }
        }
      })();
      return;
    }
    if (
      displayedConversationBusyRef.current ||
      queuedChatTurnsForDisplayedConversation.length > 0
    ) {
      primarySendInFlightConversationRef.current = sendConversationId;
      void (async () => {
        try {
          await submitCurrentComposerToGuiQueue("append");
        } finally {
          if (primarySendInFlightConversationRef.current === sendConversationId) {
            primarySendInFlightConversationRef.current = null;
          }
        }
      })();
      return;
    }
    primarySendInFlightConversationRef.current = sendConversationId;
    void (async () => {
      try {
        const draft = composerRef.current?.getDraft() ?? null;
        let text: string;
        let files: PendingUploadedFile[];
        let referencedConversations = draft?.conversationMentions ?? [];
        try {
          const materialized = draft
            ? await materializeComposerDraftForSend(
                draft,
                pendingUploadedFiles,
                displayedConversationWorkdir,
                sendConversationId,
              )
            : { text: "", uploadedFiles: pendingUploadedFiles, referencedConversations: [] };
          text = materialized.text;
          files = materialized.uploadedFiles;
          referencedConversations = materialized.referencedConversations;
        } catch (error) {
          addNotify("error", asErrorMessage(error, "Failed to import large pasted content"));
          return;
        }
        if (!text && files.length === 0) return;
        if (getDisplayedConversationId() === sendConversationId) {
          composerRef.current?.clear();
        }
        setPendingUploadsForConversation(sendConversationId, []);
        void sendChat(text, {
          conversationId: sendConversationId,
          uploadedFiles: files,
          referencedConversations,
          runtimeControls: chatRuntimeControlsForCurrentProvider,
        }).catch(() => {
          updatePendingUploadsForConversation(sendConversationId, (current) =>
            mergePendingUploadedFiles(current, files),
          );
        });
      } finally {
        if (primarySendInFlightConversationRef.current === sendConversationId) {
          primarySendInFlightConversationRef.current = null;
        }
      }
    })();
  }, [
    addNotify,
    chatRuntimeControlsForCurrentProvider,
    commitQueuedChatEdit,
    composerInputDisabled,
    composerRef,
    displayedConversationBusyRef,
    displayedConversationWorkdir,
    getDisplayedConversationId,
    isImportingPastedTextRef,
    isUploadingFiles,
    uploadingConversationId,
    materializeComposerDraftForSend,
    pendingUploadedFiles,
    queuedChatEditSessionRef,
    queuedChatTurnsForDisplayedConversation.length,
    sendChat,
    setPendingUploadsForConversation,
    submitCurrentComposerToGuiQueue,
    updatePendingUploadsForConversation,
  ]);

  const handlePrimaryComposerStop = useCallback(() => {
    const nextQueuedTurn = queuedChatTurnsForDisplayedConversation[0];
    if (nextQueuedTurn) {
      runQueuedTurnNow(nextQueuedTurn.id);
      return;
    }
    void cancelChat(displayedConversationId);
  }, [
    cancelChat,
    displayedConversationId,
    queuedChatTurnsForDisplayedConversation,
    runQueuedTurnNow,
  ]);

  // Shared context for background conversation Panes (mirrors the desktop
  // buildBackgroundPaneBinding): all conversation-level actions are explicitly
  // routed by the Pane's own conversationId; page-level mechanisms (model
  // selection, queue item editing, etc.) focus this Pane first inside the host
  // (focusGuard semantics).
  const conversationPaneHostContext: GatewayConversationPaneHostContext = {
    api,
    registry: transcriptStoreRegistry,
    settings,
    hasModels: modelOptions.length > 0,
    showUsage: isAgentDevExecutionMode,
    isInputDisabled: composerInputDisabled,
    transportInputDisabled: !status?.online || Boolean(chatProtocolIncompatibleMessage),
    uploadingConversationId,
    inputPlaceholder: composerPlaceholder,
    modelOptions,
    enabledSkills: enabledComposerSkills,
    mentionableConversations,
    searchMentionableConversations,
    mentionApps,
    contextDisplayMode: settings.customSettings.composerContextDisplay,
    commandSafetyMode: settings.system.commandSafetyMode,
    onCommandSafetyModeChange: (mode) =>
      setSettings((prev) =>
        prev.system.commandSafetyMode === mode
          ? prev
          : updateSystem(prev, { commandSafetyMode: mode }),
      ),
    gitClient,
    gitWriteEnabled: settings.remote.enableWebGit,
    gitDisabledMessage,
    workspaceActivityClient,
    onOpenWorktree: handleOpenWorktree,
    onWorktreeRemoved: handleWorktreeRemoved,
    openSettings,
    onOpenFileLink: handleOpenChatFileLink,
    onLoadUploadedImagePreview: handleLoadUploadedImagePreview,
    transcriptContentWidth: settings.customSettings.chatTranscript.width,
    selectionForConversation,
    workdirForConversation,
    isConversationBusy,
    sendChat,
    cancelChat,
    materializeComposerDraftForSend,
    getPendingUploads: getPendingUploadsForConversation,
    subscribePendingUploads,
    updatePendingUploads: updatePendingUploadsForConversation,
    importFilesForConversation,
    getCachedComposerDraft,
    setCachedComposerDraft,
    notifyError: (message) => addNotify("error", message),
    trajectoryHost,
  };

  // On file drop, hit-test by pointer to focus the conversation Pane so the
  // overlay lands on the focused input (same semantics as the desktop
  // workbenchNativeDropHoverRef; Web uses HTML5 DnD).
  const lastFileDropHoverPaneRef = useRef<string | null>(null);
  const focusWorkbenchPaneUnderPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!sessionWorkbench.enabled) return;
      const geometry = workbenchController.geometryRef.current;
      const canvasElement = document.querySelector("[data-workbench-canvas]");
      if (!geometry || !canvasElement) return;
      const canvasRect = canvasElement.getBoundingClientRect();
      const target = hitTestWorkbenchDrop(
        geometry,
        clientX - canvasRect.left,
        clientY - canvasRect.top,
      );
      const paneId =
        target && (target.kind === "pane-center" || target.kind === "pane-edge")
          ? target.paneId
          : null;
      if (!paneId || paneId === lastFileDropHoverPaneRef.current) return;
      lastFileDropHoverPaneRef.current = paneId;
      if (workbenchController.workbench.layoutRef.current.focusedPaneId !== paneId) {
        workbenchController.handleFocusPane(paneId);
      }
    },
    [workbenchController],
  );
  const handleChatFileDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handleFileDragEnter(event);
      focusWorkbenchPaneUnderPoint(event.clientX, event.clientY);
    },
    [focusWorkbenchPaneUnderPoint, handleFileDragEnter],
  );
  const handleChatFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handleFileDragOver(event);
      focusWorkbenchPaneUnderPoint(event.clientX, event.clientY);
    },
    [focusWorkbenchPaneUnderPoint, handleFileDragOver],
  );
  const handleChatFileDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handleFileDragLeave(event);
      lastFileDropHoverPaneRef.current = null;
    },
    [handleFileDragLeave],
  );
  const handleChatFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      lastFileDropHoverPaneRef.current = null;
      handleFileDrop(event);
    },
    [handleFileDrop],
  );

  const primaryConversationSurface: GatewayConversationPrimarySurface = {
    isSending: composerIsSending,
    // Upload state belongs only to the target conversation: a background
    // Pane's import does not show "uploading" on the main Pane.
    isUploadingFiles:
      isUploadingFiles &&
      (!uploadingConversationId || uploadingConversationId === displayedConversationId),
    isInputDisabled: composerInputDisabled,
    onSend: handlePrimaryComposerSend,
    onStop: handlePrimaryComposerStop,
    onSelectModel: handleSelectModel,
    onSelectExecutionMode: handleSelectExecutionMode,
    onChatRuntimeControlsChange: handleChatRuntimeControlsChange,
    onPrepareChatRuntime: () => {
      if (!api || historyShareToken) return;
      void prepareChatRuntime(
        "composer-focus",
        api,
        CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
      ).catch(() => undefined);
    },
    onComposerBusyChange: handleComposerBusyChange,
    onPickReadableFiles: () => fileInputRef.current?.click(),
    onPickWorkspaceFolder: () => folderInputRef.current?.click(),
    onPasteFiles: handleImportReadableFiles,
    loadHistoryPrompts: loadComposerHistoryPrompts,
    pendingUploadedFiles,
    onRemovePendingUpload: (relativePath) => {
      updatePendingUploadsForConversation(getDisplayedConversationId(), (current) =>
        current.filter((file) => file.relativePath !== relativePath),
      );
    },
    queuedTurns: queuedChatTurnsForDisplayedConversation,
    onRunQueuedTurnNow: runQueuedTurnNow,
    onMoveQueuedTurnUp: moveQueuedTurnUp,
    onEditQueuedTurn: editQueuedTurn,
    onRemoveQueuedTurn: removeQueuedTurn,
    onManualCompactConfirm: handleManualCompact,
    manualCompactBlocked: manualCompactPending || composerCompactionBlocked,
    approvalBar,
    taskProgressBar: (
      <TaskProgressBar
        key={displayedConversationId}
        snapshot={taskProgressSnapshot}
        isConversationRunning={transcriptBusy}
      />
    ),
    statsBar: (
      <ConversationStatsBarHost
        key={`stats-${displayedConversationId}`}
        conversationId={displayedConversationId}
        host={trajectoryHost}
        enabled={renderedConversationView !== "trajectory"}
        contextUsageTokensSource={contextUsageTokensSource}
        contextWindow={currentModelContextWindow}
        onManualCompactConfirm={handleManualCompact}
        manualCompactBlocked={manualCompactPending || composerCompactionBlocked}
      />
    ),
    fileDropOverlay: isFileDropActive ? (
      <FileDropOverlay
        variant="composer"
        canDropUpload={canDropUpload}
        title={fileDropTitle}
        description={fileDropDescription}
        limitHint={fileDropLimitHint}
      />
    ) : null,
    transcriptExtras: (
      <>
        <TranscriptWidthControls
          hostRef={transcriptStageRef}
          width={settings.customSettings.chatTranscript.width}
          onWidthChange={handleChatTranscriptWidthChange}
          resizeLabel={
            settings.locale === "en-US"
              ? "Resize conversation content"
              : "Resize conversation content"
          }
          resetLabel={
            settings.locale === "en-US" ? "Double-click to reset" : "Double-click to reset"
          }
          // The history overlay below is a blocking panel layer above the
          // handles; suspend them for exactly as long as it is mounted (#749).
          suspended={conversationOpenState.showOverlay}
        />
        {displayedTranscriptRowCount > 0 && !conversationOpenState.showOverlay ? (
          <FloorNavRail
            conversationId={displayedConversationId}
            floors={transcriptFloors}
            activeRowKey={activeFloorKey}
            bottomOffset="calc(var(--gateway-chat-composer-overlay-height, 176px) + 12px)"
            scrollViewport={transcriptViewport}
            onJump={handleFloorJump}
          />
        ) : null}
        {conversationOpenState.showOverlay ? (
          <HistorySwitchLoadingOverlay locale={settings.locale} />
        ) : null}
      </>
    ),
    stageRef: transcriptStageRef,
    setTranscriptScrollAreaRoot,
    setTranscriptViewport,
    isViewportFollowing: transcriptFollow.isFollowing,
    viewportFollowing: transcriptFollowing,
    onJumpToBottom: transcriptFollow.jumpToBottom,
    navRef: transcriptNavRef,
    onAnchorUserRowChange: setActiveFloorKey,
    onResendFromEdit: handleResendFromEdit,
    onBranchConversation: handleBranchConversation,
    branchPendingMessageId,
    onSuggestionSelect: handleEmptyStateSuggestion,
    suggestionsDisabled: isSuggestionTyping,
    hasMoreHistory: selectedHistoryHasMore,
    isLoadingMoreHistory: loadingOlderHistory,
    onLoadEarlierHistory: selectedHistoryHasMore ? handleLoadEarlierHistory : undefined,
    isLoading: transcriptHistoryLoading,
    loadingTitle: historyDetailLoadingTitle,
    transcriptError,
    changedFilesActions,
    checkpoint: {
      client: checkpointClient,
      disabled: !displayedConversationId || transcriptBusy,
      resolveAuthorizedRoots: resolveCheckpointAuthorizedRoots,
      onRewound: handleCheckpointRewound,
    },
  };

  // Every conversation Pane always renders the same host (same semantics as the
  // desktop RestorableConversationPaneHost): focus only switches the primary
  // binding, the page stage is never injected into the focused Pane, and no key
  // is derived from conversationId (which would tear down the host on focus
  // change). Terminal / unsupported use their own self-contained surfaces.
  // Runtime environment for project tool Panes: the same batch of gateway
  // clients/callbacks as RightDockPanel, resolving projects by the Pane's own
  // ProjectRef (see ProjectToolPaneHost). When the terminal client is not
  // connected (gateway offline), tool Panes do not render, just like terminal
  // Panes.
  const projectToolPaneEnvironment = useMemo<ProjectToolPaneEnvironment | null>(() => {
    if (!terminalClient) return null;
    return {
      theme: effectiveTheme,
      fontScale: settings.customSettings.fontScale.rightDock,
      workspaceProjects,
      activeProjectPathKey: terminalProjectPathKey,
      clients: {
        terminal: terminalClient,
        git: gitClient,
        tunnel: isAgentMode ? api : null,
        workspaceActivity: workspaceActivityClient,
      },
      capabilities: {
        disabledMessage: projectToolsDisabledMessage,
        terminalDisabledMessage,
        gitWriteEnabled: settings.remote.enableWebGit,
        gitDisabledMessage,
        tunnelEnabled,
        tunnelDisabledMessage,
        tunnelPublicBaseUrl: window.location.origin,
      },
      workspaceProjectRootClient,
      workspaceRootRevision,
      fileTree: {
        getState: (projectPathKey) =>
          getRightDockFileTreeState(settings.customSettings, projectPathKey),
        onStateChange: (projectPathKey, patch) =>
          setSettings((current) => updateRightDockFileTreeState(current, projectPathKey, patch)),
        onInsertFileMention: handleRightDockInsertFileMention,
        onOpenFile: (request) => {
          if (isWorkspacePreviewPath(request.path)) {
            openWorkspaceFilePreview(request);
          } else {
            openWorkspaceEditorFile(request);
          }
        },
        onRevealInFileTree: (projectPathKey, path) => {
          if (projectPathKey === terminalProjectPathKey) {
            changedFilesActions.onRevealInFileTree?.(path);
          }
        },
      },
      git: {
        onInsertCodeReviewSkill: codeReviewSkill ? handleRightDockInsertCodeReviewSkill : undefined,
        onInsertCommitMention: handleRightDockInsertCommitMention,
        onInsertGitFileMention: handleRightDockInsertGitFileMention,
        focusRequest: gitReviewFocusRequest,
        onFocusRequestHandled: handleGitReviewFocusRequestHandled,
      },
      ssh: {
        hosts: settings.ssh.hosts,
        getAssociatedHostIds: (projectPathKey) =>
          getSshProjectHostIds(settings.ssh, projectPathKey),
        onAssociatedHostIdsChange: (projectPathKey, hostIds) =>
          setSettings((prev) => updateSshProjectHostIds(prev, projectPathKey, hostIds)),
        sessions: terminalSessions,
        // Functionally merge with React's current value (same semantics as the
        // dock-side sessionsRef.current), so snapshots/reconciles arriving in
        // succession between re-renders do not overwrite each other.
        onSessionSnapshot: (snapshot) =>
          updateProjectTerminalSessions((current) =>
            mergeTerminalSession(current, snapshot.session),
          ),
        onSessionClosed: (sessionId) =>
          updateProjectTerminalSessions((current) => removeTerminalSession(current, sessionId)),
        onSessionsReconcile: (sessions) =>
          updateProjectTerminalSessions((current) =>
            reconcileSshTerminalSessions(current, sessions),
          ),
        onOpenSession: handleOpenSshTerminal,
      },
      openExternal: (url) => {
        void openUrl(url);
      },
    };
  }, [
    api,
    changedFilesActions,
    codeReviewSkill,
    effectiveTheme,
    gitClient,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleGitReviewFocusRequestHandled,
    handleOpenSshTerminal,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockInsertCommitMention,
    handleRightDockInsertFileMention,
    handleRightDockInsertGitFileMention,
    isAgentMode,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    projectToolsDisabledMessage,
    setSettings,
    settings.customSettings,
    settings.remote.enableWebGit,
    settings.ssh,
    terminalClient,
    terminalDisabledMessage,
    terminalProjectPathKey,
    terminalSessions,
    tunnelDisabledMessage,
    tunnelEnabled,
    updateProjectTerminalSessions,
    workspaceActivityClient,
    workspaceProjectRootClient,
    workspaceProjects,
    workspaceRootRevision,
  ]);

  // Project tools leased by a board Pane: the dock hides the corresponding
  // tab/content/entry (same semantics as terminal leases).
  const leasedDockTools = useMemo(
    () =>
      leasedProjectToolKinds(
        workbenchController.workbench.layout,
        terminalProjectPathKey,
        PROJECT_TOOL_SURFACE_KINDS,
      ),
    [terminalProjectPathKey, workbenchController.workbench.layout],
  );

  const renderConversationWorkbench = (): ReactNode => {
    const { workbench, dragState } = workbenchController;
    return (
      <WorkbenchCanvas
        layout={workbench.layout}
        labels={{
          paneRegion: (pane) => {
            const surface = pane.surface;
            if (surface.kind === "unsupported") {
              return translate("workbench.paneRegionUnsupported", settings.locale);
            }
            const title = workbenchPaneTitle(surface);
            if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
              return translate("workbench.paneRegionTerminal", settings.locale).replace(
                "{title}",
                title,
              );
            }
            if (isProjectToolSurface(surface)) {
              return translate("workbench.paneRegionTool", settings.locale).replace(
                "{title}",
                title,
              );
            }
            if (!title) return translate("workbench.paneRegion", settings.locale);
            const workspaceName =
              surface.kind === "conversation"
                ? workspaceProjects
                    .find(
                      (entry) =>
                        workspaceProjectPathKey(entry.path) === surface.project.projectPathKey,
                    )
                    ?.name.trim()
                : undefined;
            if (!workspaceName) {
              return translate("workbench.paneRegionConversation", settings.locale).replace(
                "{title}",
                title,
              );
            }
            return translate("workbench.paneRegionConversationInWorkspace", settings.locale)
              .replace("{title}", title)
              .replace("{workspace}", workspaceName);
          },
          separator: translate("workbench.resizeDivider", settings.locale),
        }}
        renderPaneContent={(pane, paneContext) => {
          const surface = pane.surface;
          if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
            if (!terminalClient) return null;
            return (
              <GatewayTerminalPaneHost
                paneId={pane.paneId}
                surface={surface}
                isFocused={paneContext.isFocused}
                isCompact={paneContext.isCompact}
                theme={effectiveTheme}
                client={terminalClient}
                sessions={terminalSessions}
                sessionsLoaded={terminalSessionsLoaded}
                onSessionGhost={verifyTerminalSessionAlive}
                closeRequest={
                  workbenchController.terminalPaneCloseRequest?.paneId === pane.paneId
                    ? {
                        busy: workbenchController.terminalPaneCloseRequest.busy,
                        onConfirm: workbenchController.confirmTerminalPaneClose,
                        onCancel: workbenchController.cancelTerminalPaneClose,
                      }
                    : undefined
                }
              />
            );
          }
          if (isProjectToolSurface(surface)) {
            if (!projectToolPaneEnvironment) return null;
            return (
              <ProjectToolPaneHost
                paneId={pane.paneId}
                surface={surface}
                environment={projectToolPaneEnvironment}
              />
            );
          }
          if (surface.kind === "unsupported") {
            return (
              <UnsupportedPaneSurface paneId={pane.paneId} originalKind={surface.originalKind} />
            );
          }
          const conversationId = surface.conversationId;
          const isPrimary = conversationId === displayedConversationId;
          const panePathKey = surface.project.projectPathKey;
          const blockedMessage = archivedWorkspaceProjectPathKeys.has(panePathKey)
            ? translate("workbench.projectArchived", settings.locale)
            : missingWorkspaceProjectPathKeys.has(panePathKey)
              ? translate("workbench.projectMissing", settings.locale)
              : null;
          return (
            <GatewayConversationPaneHost
              paneId={pane.paneId}
              conversationId={conversationId}
              context={conversationPaneHostContext}
              isPrimary={isPrimary}
              onFocusPane={() => workbenchController.handleFocusPane(pane.paneId)}
              pageComposerRef={isPrimary ? composerRef : undefined}
              primary={isPrimary ? primaryConversationSurface : undefined}
              blockedMessage={blockedMessage}
              trajectoryActive={viewForConversation(conversationId) === "trajectory"}
            />
          );
        }}
        renderPaneChrome={(pane, context) => {
          if (context.paneCount < 2) return null;
          const surface = pane.surface;
          const title = workbenchPaneTitle(surface);
          const paneConversationView =
            surface.kind === "conversation"
              ? viewForConversation(surface.conversationId)
              : "conversation";
          return (
            <PaneChrome
              paneId={pane.paneId}
              title={title}
              isFocused={context.isFocused}
              isCompact={context.isCompact}
              dragHandleLabel={translate("workbench.dragPane", settings.locale)}
              closeLabel={translate("workbench.closePane", settings.locale)}
              onClose={() => workbenchController.requestClosePane(pane.paneId)}
              trajectoryToggle={
                surface.kind === "conversation"
                  ? {
                      isTrajectory: paneConversationView === "trajectory",
                      label:
                        paneConversationView === "trajectory"
                          ? translate("workbench.showConversation", settings.locale)
                          : translate("workbench.showTrajectory", settings.locale),
                      onToggle: () => {
                        if (surface.kind !== "conversation") return;
                        setConversationView(
                          surface.conversationId,
                          paneConversationView === "trajectory" ? "conversation" : "trajectory",
                        );
                      },
                    }
                  : undefined
              }
              onDragHandlePointerDown={(event) => {
                workbenchController.beginPaneDrag(pane, title, {
                  pointerId: event.pointerId,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  currentTarget: event.currentTarget,
                });
              }}
            />
          );
        }}
        onResizeSplit={workbench.resizeSplit}
        onEqualizeSplit={workbench.equalizeSplit}
        onFocusPane={workbenchController.handleFocusPane}
        onGeometryChange={workbenchController.handleGeometryChange}
        dropPreview={
          dragState?.previewRect
            ? { rect: dragState.previewRect, label: dragState.payload.title }
            : null
        }
        emptyState={
          <WorkbenchEmptyState
            title={translate("workbench.emptyTitle", settings.locale)}
            description={translate("workbench.emptyDescription", settings.locale)}
          />
        }
      />
    );
  };

  // Conversations leased by a canvas Pane are hidden from the Right Dock's
  // terminal tab (a terminal appears in only one host at a time); once the Pane
  // is closed (Detach) and the lease released, it returns to the dock
  // automatically.
  const workbenchLeasedDockSessionIds = useMemo(
    () =>
      workbenchController.leasedDockSessionIds.length > 0
        ? new Set(workbenchController.leasedDockSessionIds)
        : undefined,
    [workbenchController.leasedDockSessionIds],
  );

  // Drag ghost: the payload title following the pointer, cleared with dragState
  // after commit/cancel.
  const workbenchDragGhost =
    sessionWorkbench.enabled && workbenchController.dragState ? (
      <div
        ref={workbenchController.dragGhostRef}
        data-workbench-drag-ghost=""
        className="layer-popover pointer-events-none fixed max-w-[220px] truncate rounded-md border border-border bg-background/95 px-2.5 py-1 text-xs text-foreground shadow-md"
        style={{
          left: 0,
          top: 0,
          transform:
            "translate3d(var(--workbench-drag-ghost-x, -9999px), var(--workbench-drag-ghost-y, -9999px), 0)",
          willChange: "transform",
        }}
      >
        {workbenchController.dragState.payload.title ||
          translate("chat.pendingTitle", settings.locale)}
      </div>
    ) : null;
  return (
    <LocaleContext.Provider value={localeContextValue}>
      <AppErrorBoundary>
        <div className="gateway-shell">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            aria-label={translate("chat.upload.selectFiles", settings.locale)}
            className="gateway-hidden-file-input"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              void handleImportReadableFiles(files);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={(element) => {
              folderInputRef.current = element;
              element?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            aria-label={translate("chat.upload.selectFolder", settings.locale)}
            className="gateway-hidden-file-input"
            onChange={(event) => {
              handleImportSelectedDirectoryFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          {workbenchDragGhost}

          <div className="gateway-editor-host">
            <GatewaySidebarContainer
              pinnedOrder={settings.system.sidebarPinnedOrder}
              onReorderPinned={(sidebarPinnedOrder) =>
                setSettings((previous) => ({
                  ...previous,
                  system: { ...previous.system, sidebarPinnedOrder },
                }))
              }
              projectOrder={settings.system.workspaceProjectOrder}
              onReorderProjects={(workspaceProjectOrder) =>
                setSettings((previous) => ({
                  ...previous,
                  system: { ...previous.system, workspaceProjectOrder },
                }))
              }
              store={sidebarStore}
              approvalConversationIds={approvalConversationIds}
              transientRunningConversations={manualCompactTransientConversations}
              currentConversationId={displayedConversationId}
              isOpen={sidebarOpen}
              fontScale={settings.customSettings.fontScale.sidebar}
              activeView={activeView}
              showProjects={isAgentMode && status?.online === true}
              projects={workspaceProjects}
              workspaceProjectGroups={settings.system.workspaceProjectGroups}
              activeProjectId={activeWorkspaceProject?.id ?? ""}
              missingProjectPathKeys={missingWorkspaceProjectPathKeys}
              projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
              workspaceFolderDropActive={workspaceFolderDropActive}
              workspaceFolderDropHandlers={workspaceFolderDropHandlers}
              recentCollapsed={settings.customSettings.chatSidebar.recentCollapsed}
              canShareConversations={canShareHistory}
              sharedConversationCount={sharedHistoryItems.length}
              externalErrorMessage={sidebarActionError}
              connectionLost={gatewayConnectionLost}
              sectionsDisabled={sidebarSectionsDisabled}
              isLocalDraftConversationId={isLocalDraftConversationId}
              onProjectsCollapsedChange={handleSidebarProjectsCollapsedChange}
              onRecentCollapsedChange={handleSidebarRecentCollapsedChange}
              onCreateProject={handleOpenCreateWorkspaceProject}
              onCreateWorkspaceGroup={handleCreateWorkspaceGroup}
              onRenameWorkspaceGroup={handleRenameWorkspaceGroup}
              onDeleteWorkspaceGroup={handleDeleteWorkspaceGroup}
              onMoveProjectToGroup={handleMoveWorkspaceProjectToGroup}
              onToggleWorkspaceGroupCollapsed={handleToggleWorkspaceGroupCollapsed}
              onSelectProject={handleSelectWorkspaceProject}
              onNewConversationForProject={handleNewConversationForProject}
              onBrowseProjectInFileTree={handleBrowseWorkspaceProjectInFileTree}
              onConfigureProject={setProjectSettingsProject}
              onSetProjectPinned={handleSetWorkspaceProjectPinned}
              onRemoveProject={handleRemoveWorkspaceProject}
              onArchiveProject={handleArchiveWorkspaceProject}
              onUnarchiveProject={handleUnarchiveWorkspaceProject}
              archivedProjectPathKeys={archivedWorkspaceProjectPathKeys}
              onNewConversation={handleSidebarNewConversation}
              onSelectConversation={handleSidebarSelectConversation}
              onConversationOpenInWorkbenchSplit={
                sessionWorkbench.enabled
                  ? workbenchController.handleOpenConversationInSplit
                  : undefined
              }
              onConversationWorkbenchDragIntent={
                sessionWorkbench.enabled
                  ? workbenchController.handleConversationDragIntent
                  : undefined
              }
              onProjectWorkbenchDragIntent={
                sessionWorkbench.enabled ? workbenchController.handleProjectDragIntent : undefined
              }
              onShareConversation={handleOpenShareModal}
              onOpenSharedConversations={handleOpenSharedHistoryManager}
              onLocalDraftDeleted={handleSidebarLocalDraftDeleted}
              onConversationsRemoved={handleSidebarConversationsRemoved}
              onCloseSidebar={() => setSidebarOpen(false)}
              sidebarShortcuts={settings.customSettings.sidebarShortcuts}
              onOpenSettings={openSettings}
              onOpenResourceHub={handleSidebarOpenResourceHub}
            />

            {shareConversation ? (
              <HistoryShareModal
                conversation={shareConversation}
                share={shareStatus}
                isLoading={shareLoading}
                isUpdating={shareUpdating}
                errorMessage={shareError}
                onToggle={handleToggleHistoryShare}
                onRedactToolContentChange={handleSetShareRedactToolContent}
                onClose={handleCloseShareModal}
              />
            ) : null}

            {sharedManagerOpen ? (
              <SharedHistoryManagerModal
                conversations={sharedHistoryItems}
                statuses={sharedManagerStatuses}
                loadingIds={sharedManagerLoadingIds}
                updatingIds={sharedManagerUpdatingIds}
                errors={sharedManagerErrors}
                listError={sharedHistoryListError}
                onRefresh={handleRefreshSharedHistoryStatuses}
                onLoadStatus={handleLoadSharedHistoryStatus}
                onDisableShare={handleDisableSharedHistory}
                onSetRedactToolContent={handleSetSharedHistoryRedactToolContent}
                onClose={() => setSharedManagerOpen(false)}
              />
            ) : null}

            {projectPickerOpen ? (
              <WorkdirPickerModal
                initialWorkdir={activeWorkspaceProjectPath || settings.system.workdir.trim()}
                onClose={() => setProjectPickerOpen(false)}
                onSelect={handleWorkdirPickerSelect}
              />
            ) : null}

            {workspaceCreateModalOpen ? (
              <WorkspaceCloneModal
                initialParent={activeWorkspaceProjectPath || settings.system.workdir.trim()}
                canClone={settings.remote.enableWebGit}
                cloneDisabledMessage={translate("chat.workspaceCloneWebDisabled", settings.locale)}
                onOpenFolder={handleOpenWorkspaceFolder}
                onClone={handleCloneWorkspaceProject}
                onLoadBranches={handleLoadWorkspaceRemoteBranches}
                onClose={() => setWorkspaceCreateModalOpen(false)}
              />
            ) : null}
            <WorkspaceCloneTaskOverlay
              tasks={workspaceCloneTasks}
              onCancel={handleCancelWorkspaceCloneTask}
              onDismiss={handleDismissWorkspaceCloneTask}
              onOpenWorkspace={handleOpenClonedWorkspace}
            />

            {confirmDialog}

            <main className="gateway-main-shell">
              <div className="gateway-main-backdrop" />
              <AppWorkbenchChrome
                settings={settings}
                sidebarOpen={sidebarOpen}
                onOpenSettings={openSettings}
                onToggleTheme={() =>
                  setSettings((prev) => ({
                    ...prev,
                    theme: getNextTheme(prev.theme),
                  }))
                }
                onOpenSidebar={() => setSidebarOpen(true)}
                leadingActions={
                  activeView === "chat" && hasConversationReply && !workbenchHasMultiplePanes ? (
                    <ConversationViewTabs
                      active={renderedConversationView}
                      onChange={setActiveConversationView}
                    />
                  ) : null
                }
                trailingActions={
                  <>
                    <ProjectToolsPanelToggle
                      isOpen={rightDockOpen}
                      sessionCount={projectTerminalSessions.length}
                      disabledMessage={projectToolsDisabledMessage}
                      className="gateway-project-tools-panel-toggle"
                      onToggle={() => setRightDockOpen((open) => !open)}
                    />
                    <UserMenu
                      open={userMenuOpen}
                      onOpenChange={setUserMenuOpen}
                      userMenuLabel={userMenuLabel}
                      userAvatarLabel={userAvatarLabel}
                      agentStatus={
                        status === null ? "unknown" : status.online ? "online" : "offline"
                      }
                      agentSelector={
                        <AgentSelector api={api} onAgentChange={handleActiveAgentChange} />
                      }
                      onLogout={handleLogout}
                    />
                  </>
                }
                overlay={
                  <div className="relative z-50">
                    <NotifyToast items={notifyItems} onDismiss={dismissNotify} />
                  </div>
                }
              />
              <ApplicationView
                activeView={activeView}
                settings={settings}
                setSettings={setSettings}
                isAgentMode={isAgentMode}
                initialSkills={availableSkills}
                initialSkillsRootDir={skillsRootDir}
                className="contents"
                chat={{
                  containerProps: {
                    className: "gateway-chat-frame zone-font-scale",
                    style: {
                      "--zone-font-scale": settings.customSettings.fontScale.chat,
                    } as CSSProperties,
                    onDragEnter: handleChatFileDragEnter,
                    onDragOver: handleChatFileDragOver,
                    onDragLeave: handleChatFileDragLeave,
                    onDrop: handleChatFileDrop,
                  },
                  content: (
                    <>
                      {statusError ? (
                        <div className="gateway-banner-error">{statusError}</div>
                      ) : null}
                      {chatProtocolIncompatibleMessage && !statusError ? (
                        <div className="gateway-banner-error">
                          {chatProtocolIncompatibleMessage}
                        </div>
                      ) : null}
                      {settingsSyncError ? (
                        <div className="gateway-banner-error">{settingsSyncError}</div>
                      ) : null}
                      {chatError && displayedTranscriptRowCount === 0 ? (
                        <div className="gateway-banner-error">{chatError}</div>
                      ) : null}

                      {sessionWorkbench.enabled ? (
                        renderConversationWorkbench()
                      ) : (
                        <section
                          ref={transcriptStageRef}
                          className="gateway-transcript-stage"
                          // Preferred (persisted) width, so a fresh mount paints at
                          // the user's width instead of the default.
                          // TranscriptWidthControls narrows this same variable to
                          // the stage in a layout effect — see its header.
                          style={
                            {
                              [CHAT_TRANSCRIPT_WIDTH_CSS_VAR]: `${settings.customSettings.chatTranscript.width}px`,
                            } as CSSProperties
                          }
                        >
                          {renderedConversationView === "trajectory" ? (
                            <TrajectoryView
                              conversationId={displayedConversationId}
                              host={trajectoryHost}
                              messages={trajectoryMessages}
                              workdir={displayedConversationWorkdir}
                              hasMoreMessages={selectedHistoryHasMore}
                              loadEarlierMessages={
                                selectedHistoryHasMore ? handleLoadEarlierHistory : undefined
                              }
                              liveEvents={liveTrajectory}
                              authoritativeRevision={trajectoryAuthoritativeRevision}
                            />
                          ) : (
                            <div className="gateway-transcript-scroll-shell">
                              <ScrollArea
                                ref={setTranscriptScrollAreaRoot}
                                viewportRef={setTranscriptViewport}
                                className="gateway-transcript-scroll"
                              >
                                <ChangedFilesActionsProvider value={changedFilesActions}>
                                  <CheckpointRewindProvider
                                    client={checkpointClient}
                                    conversationId={displayedConversationId}
                                    disabled={!displayedConversationId || transcriptBusy}
                                    resolveAuthorizedRoots={resolveCheckpointAuthorizedRoots}
                                    onRewound={handleCheckpointRewound}
                                  >
                                    <GatewayTranscript
                                      conversationId={displayedConversationId}
                                      rows={transcriptRows}
                                      liveStartIndex={transcriptLiveStartIndex}
                                      activeTurnKey={displayedTranscript.activeTurnKey}
                                      contentWidth={settings.customSettings.chatTranscript.width}
                                      isViewportFollowing={transcriptFollow.isFollowing}
                                      viewportFollowing={transcriptFollowing}
                                      navRef={transcriptNavRef}
                                      onAnchorUserRowChange={setActiveFloorKey}
                                      error={transcriptError}
                                      toolStatus={transcriptToolStatus}
                                      toolStatusIsCompaction={transcriptToolStatusIsCompaction}
                                      retryAttempts={displayedTranscript.retryAttempts}
                                      isStreaming={transcriptBusy}
                                      isLoading={transcriptHistoryLoading}
                                      loadingTitle={historyDetailLoadingTitle}
                                      hasModels={modelOptions.length > 0}
                                      onOpenSettings={openSettings}
                                      hasMoreHistory={selectedHistoryHasMore}
                                      isLoadingMoreHistory={loadingOlderHistory}
                                      onLoadEarlierHistory={
                                        selectedHistoryHasMore
                                          ? handleLoadEarlierHistory
                                          : undefined
                                      }
                                      showUsage={isAgentDevExecutionMode}
                                      usageContextWindow={currentModelContextWindow}
                                      workspaceRoot={displayedConversationWorkdir}
                                      onOpenFileLink={handleOpenChatFileLink}
                                      gitClient={gitClient}
                                      onLoadUploadedImagePreview={handleLoadUploadedImagePreview}
                                      onResendFromEdit={handleResendFromEdit}
                                      onBranchConversation={handleBranchConversation}
                                      branchPendingMessageId={branchPendingMessageId}
                                      onSuggestionSelect={handleEmptyStateSuggestion}
                                      suggestionsDisabled={isSuggestionTyping}
                                    />
                                  </CheckpointRewindProvider>
                                </ChangedFilesActionsProvider>
                              </ScrollArea>
                              <TranscriptWidthControls
                                hostRef={transcriptStageRef}
                                width={settings.customSettings.chatTranscript.width}
                                onWidthChange={handleChatTranscriptWidthChange}
                                resizeLabel={
                                  settings.locale === "en-US"
                                    ? "Resize conversation content"
                                    : "Resize conversation content"
                                }
                                resetLabel={
                                  settings.locale === "en-US"
                                    ? "Double-click to reset"
                                    : "Double-click to reset"
                                }
                                suspended={conversationOpenState.showOverlay}
                              />
                              {displayedTranscriptRowCount > 0 &&
                              !conversationOpenState.showOverlay ? (
                                <FloorNavRail
                                  conversationId={displayedConversationId}
                                  floors={transcriptFloors}
                                  activeRowKey={activeFloorKey}
                                  bottomOffset="calc(var(--gateway-chat-composer-overlay-height, 176px) + 12px)"
                                  scrollViewport={transcriptViewport}
                                  onJump={handleFloorJump}
                                />
                              ) : null}
                              {conversationOpenState.showOverlay ? (
                                <HistorySwitchLoadingOverlay locale={settings.locale} />
                              ) : null}
                            </div>
                          )}
                          {renderedConversationView === "conversation" && !transcriptFollowing ? (
                            <button
                              type="button"
                              className="gateway-scroll-to-bottom"
                              onClick={transcriptFollow.jumpToBottom}
                              aria-label="Scroll to bottom"
                              title="Scroll to bottom"
                            >
                              <ChevronDown className="h-4 w-4" />
                            </button>
                          ) : null}
                          <ChatComposerBar
                            surface="web"
                            runClarifyTurn={
                              settings.customSettings.promptClarifyEnabled
                                ? runClarifyTurn
                                : undefined
                            }
                            clarifyContext={clarifyContext}
                            conversationId={displayedConversationId}
                            // The trajectory page is a read-only analysis view:
                            // suspend the input area (stay mounted so the draft is not lost).
                            hidden={renderedConversationView === "trajectory"}
                            composerRef={composerRef}
                            isSending={composerIsSending}
                            isUploadingFiles={isUploadingFiles}
                            isInputDisabled={composerInputDisabled}
                            inputPlaceholder={composerPlaceholder}
                            workdir={displayedConversationWorkdir}
                            enabledSkills={enabledComposerSkills}
                            mentionableConversations={mentionableConversations}
                            searchMentionableConversations={searchMentionableConversations}
                            mentionApps={mentionApps}
                            executionMode={settings.system.executionMode}
                            hasModels={modelOptions.length > 0}
                            currentModelLabel={currentModelLabel}
                            modelOptions={modelOptions}
                            selectedValue={selectedValue}
                            chatRuntimeControls={chatRuntimeControlsForCurrentProvider}
                            commandSafetyMode={settings.system.commandSafetyMode}
                            onCommandSafetyModeChange={(mode) =>
                              setSettings((prev) =>
                                prev.system.commandSafetyMode === mode
                                  ? prev
                                  : updateSystem(prev, { commandSafetyMode: mode }),
                              )
                            }
                            reasoningOptions={chatRuntimeReasoningOptions}
                            thinkingAlwaysOn={chatRuntimeThinkingAlwaysOn}
                            contextUsageTokensSource={contextUsageTokensSource}
                            contextWindow={currentModelContextWindow}
                            contextDisplayMode={settings.customSettings.composerContextDisplay}
                            onManualCompactConfirm={handleManualCompact}
                            manualCompactBlocked={manualCompactPending || composerCompactionBlocked}
                            gitClient={gitClient}
                            onOpenWorktree={handleOpenWorktree}
                            onWorktreeRemoved={handleWorktreeRemoved}
                            gitWriteEnabled={settings.remote.enableWebGit}
                            gitDisabledMessage={gitDisabledMessage}
                            workspaceActivityClient={workspaceActivityClient}
                            onSelectModel={handleSelectModel}
                            onSelectExecutionMode={handleSelectExecutionMode}
                            onOpenSettings={openSettings}
                            onSend={() => {
                              if (
                                submitInFlightRef.current ||
                                isUploadingFiles ||
                                isImportingPastedTextRef.current ||
                                composerInputDisabled
                              ) {
                                return;
                              }
                              if (queuedChatEditSessionRef.current) {
                                submitInFlightRef.current = true;
                                void (async () => {
                                  try {
                                    await commitQueuedChatEdit();
                                  } finally {
                                    submitInFlightRef.current = false;
                                  }
                                })();
                                return;
                              }
                              if (
                                displayedConversationBusyRef.current ||
                                queuedChatTurnsForDisplayedConversation.length > 0
                              ) {
                                submitInFlightRef.current = true;
                                void (async () => {
                                  try {
                                    await submitCurrentComposerToGuiQueue("append");
                                  } finally {
                                    submitInFlightRef.current = false;
                                  }
                                })();
                                return;
                              }
                              submitInFlightRef.current = true;
                              void (async () => {
                                try {
                                  const draft = composerRef.current?.getDraft() ?? null;
                                  // Capture the send target before the paste import
                                  // awaits: switching conversations mid-import must
                                  // not reroute the message or clear the composer of
                                  // the newly displayed conversation.
                                  const sendConversationId = getDisplayedConversationId();
                                  let text: string;
                                  let files: PendingUploadedFile[];
                                  let referencedConversations = draft?.conversationMentions ?? [];
                                  try {
                                    const materialized = draft
                                      ? await materializeComposerDraftForSend(
                                          draft,
                                          pendingUploadedFiles,
                                          displayedConversationWorkdir,
                                          sendConversationId,
                                        )
                                      : {
                                          text: "",
                                          uploadedFiles: pendingUploadedFiles,
                                          referencedConversations: [],
                                        };
                                    text = materialized.text;
                                    files = materialized.uploadedFiles;
                                    referencedConversations = materialized.referencedConversations;
                                  } catch (error) {
                                    addNotify(
                                      "error",
                                      asErrorMessage(
                                        error,
                                        "Failed to import large pasted content",
                                      ),
                                    );
                                    return;
                                  }

                                  if (!text && files.length === 0) {
                                    return;
                                  }
                                  if (getDisplayedConversationId() === sendConversationId) {
                                    composerRef.current?.clear();
                                  }
                                  setPendingUploadsForConversation(sendConversationId, []);
                                  void sendChat(text, {
                                    conversationId: sendConversationId,
                                    uploadedFiles: files,
                                    referencedConversations,
                                    runtimeControls: chatRuntimeControlsForCurrentProvider,
                                  }).catch(() => {
                                    updatePendingUploadsForConversation(
                                      sendConversationId,
                                      (current) => mergePendingUploadedFiles(current, files),
                                    );
                                  });
                                } finally {
                                  submitInFlightRef.current = false;
                                }
                              })();
                            }}
                            onStop={() => {
                              const nextQueuedTurn = queuedChatTurnsForDisplayedConversation[0];
                              if (nextQueuedTurn) {
                                // Keep WebUI's stop button aligned with the desktop
                                // composer: stop the active run, then drain the queue.
                                runQueuedTurnNow(nextQueuedTurn.id);
                                return;
                              }
                              void cancelChat(displayedConversationId);
                            }}
                            onPrepareChatRuntime={() => {
                              if (!api || historyShareToken) {
                                return;
                              }
                              void prepareChatRuntime(
                                "composer-focus",
                                api,
                                CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
                              ).catch(() => undefined);
                            }}
                            onComposerBusyChange={handleComposerBusyChange}
                            onChatRuntimeControlsChange={handleChatRuntimeControlsChange}
                            onPickReadableFiles={() => fileInputRef.current?.click()}
                            onPickWorkspaceFolder={() => folderInputRef.current?.click()}
                            onPasteFiles={handleImportReadableFiles}
                            onLoadUploadedImagePreview={handleLoadUploadedImagePreview}
                            loadHistoryPrompts={loadComposerHistoryPrompts}
                            pendingUploadedFiles={pendingUploadedFiles}
                            onRemovePendingUpload={(relativePath) => {
                              updatePendingUploadsForConversation(
                                getDisplayedConversationId(),
                                (current) =>
                                  current.filter((file) => file.relativePath !== relativePath),
                              );
                            }}
                            queuedTurns={queuedChatTurnsForDisplayedConversation}
                            onRunQueuedTurnNow={runQueuedTurnNow}
                            onMoveQueuedTurnUp={moveQueuedTurnUp}
                            onEditQueuedTurn={editQueuedTurn}
                            onRemoveQueuedTurn={removeQueuedTurn}
                            taskProgressBar={
                              <TaskProgressBar
                                key={displayedConversationId}
                                snapshot={taskProgressSnapshot}
                                isConversationRunning={transcriptBusy}
                              />
                            }
                            approvalBar={approvalBar}
                            statsBar={
                              <ConversationStatsBarHost
                                // The prefix prevents a key collision with the
                                // sibling taskProgressBar (bare conversation id):
                                // React's keyed diff for same-key siblings lets
                                // the old fiber escape deletion, accumulating DOM
                                // leftovers over time.
                                key={`stats-${displayedConversationId}`}
                                conversationId={displayedConversationId}
                                host={trajectoryHost}
                                // Under the trajectory view the input area is
                                // hidden, so the status bar need not fetch.
                                enabled={renderedConversationView !== "trajectory"}
                                contextUsageTokensSource={contextUsageTokensSource}
                                contextWindow={currentModelContextWindow}
                                onManualCompactConfirm={handleManualCompact}
                                manualCompactBlocked={
                                  manualCompactPending || composerCompactionBlocked
                                }
                              />
                            }
                            fileDropOverlay={
                              isFileDropActive ? (
                                <FileDropOverlay
                                  variant="composer"
                                  canDropUpload={canDropUpload}
                                  title={fileDropTitle}
                                  description={fileDropDescription}
                                  limitHint={fileDropLimitHint}
                                />
                              ) : null
                            }
                          />
                        </section>
                      )}
                    </>
                  ),
                }}
                workspaceOverlays={
                  <WorkspaceOverlayHost
                    locale={settings.locale}
                    theme={effectiveTheme}
                    workspaceEditorMounted={workspaceEditorMounted}
                    workspaceEditorOpenRequest={workspaceEditorOpenRequest}
                    workspaceEditorCloseRequestId={workspaceEditorCloseRequestId}
                    workspaceEditorOpen={workspaceEditorOpen}
                    workspaceEditorCleanupPending={workspaceEditorCleanupPending}
                    onWorkspaceEditorPreviewFile={openWorkspaceFilePreview}
                    onWorkspaceEditorInsertCodeMention={handleInsertCodeMention}
                    onWorkspaceEditorHide={handleWorkspaceEditorHide}
                    onWorkspaceEditorClose={handleWorkspaceEditorClosed}
                    workspaceFilePreviewMounted={workspaceFilePreviewMounted}
                    workspaceFilePreviewOpenRequest={workspaceFilePreviewOpenRequest}
                    workspaceFilePreviewOpen={workspaceFilePreviewOpen}
                    onWorkspaceFilePreviewOpenEditor={openWorkspaceEditorFile}
                    onWorkspaceFilePreviewRequestClose={requestWorkspaceFilePreviewClose}
                    onWorkspaceFilePreviewClose={handleWorkspaceFilePreviewClosed}
                    workspaceSshTerminalMounted={workspaceSshTerminalMounted}
                    workspaceSshTerminalOpenRequest={workspaceSshTerminalOpenRequest}
                    workspaceSshTerminalOpen={workspaceSshTerminalOpen}
                    terminalProjectPathKey={terminalProjectPathKey}
                    terminalClient={terminalClient}
                    sftpClient={sftpClient}
                    terminalSessions={terminalSessions}
                    onWorkspaceSshTerminalHide={hideWorkspaceSshTerminalOverlay}
                    onSshTerminalOpenFile={handleOpenSftpFile}
                    sshTerminalPaneLeasedSessionIds={workbenchLeasedDockSessionIds}
                    onSshTerminalFocusLeasedSession={
                      sessionWorkbench.enabled
                        ? workbenchController.focusTerminalPaneForSession
                        : undefined
                    }
                    onSshTerminalSessionTabDragStart={
                      sessionWorkbench.enabled
                        ? workbenchController.handleTerminalTabDragIntent
                        : undefined
                    }
                  />
                }
              />
            </main>
          </div>

          {terminalClient ? (
            <RightDockPanel
              isOpen={activeView === "chat" && rightDockOpen}
              collapseImmediately={activeView !== "chat"}
              fontScale={settings.customSettings.fontScale.rightDock}
              projectPathKey={terminalProjectPathKey}
              cwd={terminalProjectPath}
              workspaceProject={activeWorkspaceProject}
              workspaceProjectRootClient={workspaceProjectRootClient}
              workspaceRootRevision={workspaceRootRevision}
              sessions={terminalSessions}
              sessionsLoaded={terminalSessionsLoaded}
              leasedSessionIds={workbenchLeasedDockSessionIds}
              leasedTools={leasedDockTools}
              width={settings.customSettings.rightDock.width}
              theme={effectiveTheme}
              disabledMessage={projectToolsDisabledMessage}
              terminalDisabledMessage={terminalDisabledMessage}
              projectState={rightDockProjectState}
              fileTreeState={rightDockFileTreeState}
              sshHosts={settings.ssh.hosts}
              associatedSshHostIds={associatedSshHostIds}
              client={terminalClient}
              gitClient={gitClient}
              gitWriteEnabled={settings.remote.enableWebGit}
              gitDisabledMessage={gitDisabledMessage}
              tunnelClient={isAgentMode ? api : null}
              tunnelEnabled={tunnelEnabled}
              tunnelDisabledMessage={tunnelDisabledMessage}
              tunnelPublicBaseUrl={window.location.origin}
              workspaceActivityClient={workspaceActivityClient}
              onWidthChange={handleRightDockWidthChange}
              onProjectStateChange={handleRightDockProjectStateChange}
              onFileTreeStateChange={handleRightDockFileTreeStateChange}
              onSshProjectHostIdsChange={handleSshProjectHostIdsChange}
              onOpenSshSession={handleOpenSshTerminal}
              onSessionsChange={handleProjectTerminalSessionsChange}
              onTerminalTabDragStart={
                sessionWorkbench.enabled
                  ? workbenchController.handleTerminalTabDragIntent
                  : undefined
              }
              onNewTerminalDragStart={
                sessionWorkbench.enabled
                  ? workbenchController.handleNewTerminalDragIntent
                  : undefined
              }
              onOpenTerminalInWorkbench={
                sessionWorkbench.enabled ? workbenchController.handleOpenTerminalInSplit : undefined
              }
              onToolDragStart={
                sessionWorkbench.enabled && terminalProjectPath.trim()
                  ? workbenchController.handleToolDragIntent
                  : undefined
              }
              onOpenToolInWorkbench={
                sessionWorkbench.enabled && terminalProjectPath.trim()
                  ? workbenchController.handleOpenToolInSplit
                  : undefined
              }
              onOpenNewTerminalInWorkbench={
                sessionWorkbench.enabled
                  ? workbenchController.handleOpenNewTerminalInSplit
                  : undefined
              }
              onSessionGhost={verifyTerminalSessionAlive}
              onInsertFileMention={handleRightDockInsertFileMention}
              onOpenFile={handleOpenWorkspaceFile}
              gitReviewFocusRequest={gitReviewFocusRequest}
              onGitReviewFocusRequestHandled={handleGitReviewFocusRequestHandled}
              onInsertCodeReviewSkill={
                codeReviewSkill ? handleRightDockInsertCodeReviewSkill : undefined
              }
              onInsertCommitMention={handleRightDockInsertCommitMention}
              onInsertGitFileMention={handleRightDockInsertGitFileMention}
              onClose={handleRightDockClose}
            />
          ) : null}

          {projectSettingsProject ? (
            <WorkspaceProjectSettingsModal
              project={projectSettingsProject}
              settings={settings}
              skills={availableSkills}
              rootClient={workspaceProjectRootClient}
              rootClientUnavailableDescription={
                workspaceProjectRootClient
                  ? undefined
                  : translate(
                      "chat.workspaceSettingsDirectoriesGatewayDescription",
                      settings.locale,
                    )
              }
              onClose={() => setProjectSettingsProject(null)}
              onRenameProject={(name) => {
                handleCommitWorkspaceProjectRename(projectSettingsProject, name);
              }}
              onSave={(draft) => {
                setSettings((prev) =>
                  updateWorkspaceResourceSettings(prev, projectSettingsProject.path, draft),
                );
              }}
            />
          ) : null}

          {settingsOpen ? (
            <div
              className={cn(
                "gateway-settings-overlay",
                overlay === "open" ? "gateway-settings-overlay-open" : "",
              )}
              onTransitionEnd={handleSettingsTransitionEnd}
            >
              <SettingsPage
                settings={settings}
                setSettings={setSettings}
                saveState={settingsSaveState}
                onBack={closeSettings}
                initialSection={settingsSection}
                initialProviderId={settingsProviderId}
                hiddenSections={["remote"]}
                onAgentDirectoryChanged={async () => {
                  if (!api) return;
                  await api.listAgents();
                  handleActiveAgentChange(api.getActiveAgent());
                }}
              />
            </div>
          ) : null}
        </div>
      </AppErrorBoundary>
    </LocaleContext.Provider>
  );
}
