import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { ApplicationView } from "@liveagent/ui/application/ApplicationView";
import { AppWorkbenchChrome } from "@liveagent/ui/application/AppWorkbenchChrome";
import { useApplicationViewState } from "@liveagent/ui/application/useApplicationViewState";
import { ConversationViewTabs } from "@liveagent/ui/components/chat/ConversationViewTabs";
import type { RunClarifyTurn } from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { HistoryShareModal } from "@liveagent/ui/components/chat/HistoryShareModal";
import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposer";
import { NotifyToast } from "@liveagent/ui/components/chat/NotifyToast";
import { SharedHistoryManagerModal } from "@liveagent/ui/components/chat/SharedHistoryManagerModal";
import { WorkspaceCloneModal } from "@liveagent/ui/components/chat/WorkspaceCloneModal";
import { WorkspaceProjectSettingsModal } from "@liveagent/ui/components/chat/WorkspaceProjectSettingsModal";
import { ProjectToolsPanelToggle } from "@liveagent/ui/components/project-tools/ProjectToolsPanelToggle";
import { RightDockPanel } from "@liveagent/ui/components/project-tools/RightDockPanel";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { PaneChrome } from "@liveagent/ui/components/workbench/PaneChrome";
import {
  type ProjectToolPaneEnvironment,
  ProjectToolPaneHost,
} from "@liveagent/ui/components/workbench/ProjectToolPaneHost";
import { UnsupportedPaneSurface } from "@liveagent/ui/components/workbench/surfaces/UnsupportedPaneSurface";
import {
  WORKBENCH_CANVAS_DIVIDER_SIZE,
  WorkbenchCanvas,
} from "@liveagent/ui/components/workbench/WorkbenchCanvas";
import { WorkbenchEmptyState } from "@liveagent/ui/components/workbench/WorkbenchEmptyState";
import { useWorkspaceOverlays } from "@liveagent/ui/components/workspace-editor/useWorkspaceOverlays";
import { WorkspaceOverlayHost } from "@liveagent/ui/components/workspace-editor/WorkspaceOverlayHost";
import { isWorkspacePreviewPath } from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import { useLocale } from "@liveagent/ui/i18n/index";
import { getAutomationState, useAutomation } from "@liveagent/ui/lib/automation/index";
import { formatCheckpointRewoundNotification } from "@liveagent/ui/lib/chat/checkpointRewind";
import { searchMentionConversations } from "@liveagent/ui/lib/chat/conversationSearch";
import { useChangedFilesActions } from "@liveagent/ui/lib/chat/useChangedFilesActions";
import { useChatFileLinkNavigation } from "@liveagent/ui/lib/chat/useChatFileLinkNavigation";
import {
  useComposerActions,
  useComposerSkillSelection,
  useInsertCodeReviewSkill,
} from "@liveagent/ui/lib/chat/useComposerActions";
import { useMentionApps } from "@liveagent/ui/lib/chat/useMentionApps";
import { setPreferredMonacoNlsLocale } from "@liveagent/ui/lib/monacoNls";
import { releaseProjectToolFromDock } from "@liveagent/ui/lib/projectTools/releaseProjectToolFromDock";
import { useRightDockSettings } from "@liveagent/ui/lib/projectTools/useRightDockSettings";
import type {
  ConversationOpenOptions,
  ConversationOpenRequest,
} from "@liveagent/ui/lib/sidebar/openController";
import {
  type ConversationOpenState,
  createConversationOpenController,
} from "@liveagent/ui/lib/sidebar/openController";
import { conversationMatchesScope } from "@liveagent/ui/lib/sidebar/scope";
import {
  selectConversations,
  selectRunningConversationIds,
} from "@liveagent/ui/lib/sidebar/selectors";
import { createSidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import { buildSkillsSystemPrompt, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import { useChatSkills } from "@liveagent/ui/lib/skills/useChatSkills";
import {
  mergeTerminalSession,
  reconcileSshTerminalSessions,
  removeTerminalSession,
  terminalSessionBelongsToProject,
} from "@liveagent/ui/lib/terminal/sessionStore";
import type { TerminalSession } from "@liveagent/ui/lib/terminal/types";
import {
  toTrajectoryLiveAssistantMessage,
  toTrajectoryMessages,
} from "@liveagent/ui/lib/trajectory/transcriptMessages";
import { useConversationViewState } from "@liveagent/ui/lib/trajectory/useConversationViewState";
import type { LocalTunnelClient } from "@liveagent/ui/lib/tunnels/constants";
import {
  commitProjectToolDrop,
  commitWorkspaceDropConversation,
  findAdjacentPaneId,
  findParentSplitId,
  hitTestWorkbenchDrop,
  leasedProjectToolKinds,
  openProjectToolInSplit,
  type PendingWorkspaceDropOperation,
  projectToolSurfaceTitleKey,
  shouldDeferWorkspaceDropConversationSync,
  type WorkbenchCommandError,
  type WorkbenchGeometry,
} from "@liveagent/ui/lib/workbench/index";
import { useTerminalPaneCloseFlow } from "@liveagent/ui/lib/workbench/terminalPaneClose";
import {
  type ConversationWorkbenchSurface,
  isProjectToolSurface,
  type PaneRecord,
  PROJECT_TOOL_SURFACE_KINDS,
  type ProjectRef,
  type ProjectToolSurfaceKind,
  surfaceIdentityKey,
  surfaceProjectRef,
} from "@liveagent/ui/lib/workbench/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { loadComposerUploadedImagePreview } from "../agent-ui-adapters/composerImagePreview";
import { createTauriTrajectoryHost } from "../agent-ui-adapters/trajectory";
import { WorkspaceCloneTaskOverlayAdapter } from "../agent-ui-adapters/workspaceCloneTasks";
import { desktopWorkspaceProjectRootClient } from "../agent-ui-adapters/workspaceProjectRoots";
import { PaneLoadingSkeleton } from "../components/app/PaneLoadingSkeleton";
import { MacOsTitleBarToggle } from "../components/MacOsTitleBarSpacer";
import type { CompactionStatus } from "../lib/chat/compaction/types";
import {
  buildRequestContext,
  type ConversationViewState,
  createConversationStateFromContext,
  type RenderTimelineItem,
} from "../lib/chat/conversation/conversationState";
import type { ChatHistorySummary } from "../lib/chat/history/chatHistory";
import { memoryExtraction } from "../lib/chat/memory/extractionController";
import { memoryTurnInjection } from "../lib/chat/memory/injectionController";
import {
  buildFallbackConversationTitle,
  createConversationIdentity,
  createPendingHistoryItem,
  getFirstUserMessageText,
} from "../lib/chat/page/chatPageHelpers";
import { skillMentionInjection } from "../lib/chat/skills/mentionInjection";
import { tauriGitClient } from "../lib/git/tauriGitClient";
import { buildMemoryOverviewSection } from "../lib/memory/prompts/injection";
import { createProviderRuntimeConfig, toModelValue } from "../lib/providers/llm";
import {
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  getRightDockFileTreeState,
  getSshProjectHostIds,
  isAgentDevMode,
  isAgentExecutionMode,
  isThinkingAlwaysOnForModel,
  normalizeChatRuntimeControlsForProvider,
  normalizeSelectedModelForProviders,
  parseSelectedModelJson,
  resolveEffectivePromptSettings,
  resolveEffectiveTheme,
  resolveWorkspaceResources,
  updateExecutionModeFromChatSelection,
  updateRightDockFileTreeState,
  updateSshProjectHostIds,
  updateSystem,
  updateWorkspaceResourceSettings,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "../lib/settings";
import { tauriSftpClient } from "../lib/sftp/tauriSftpClient";
import { createGuiSidebarBackend } from "../lib/sidebar/guiSidebarBackend";
import { createSubagentStoreManager } from "../lib/subagents";
import { tauriTerminalClient } from "../lib/terminal/tauriTerminalClient";
import { cancelPendingAskUserQuestionsForConversation } from "../lib/tools/askUserQuestionTools";
import {
  answerPlanDecision,
  cancelPendingPlanDecisionsForConversation,
  getPendingPlanForConversation,
  isPlanApprovalMessage,
  registerPlanDecisionHandlers,
} from "../lib/tools/planModeTools";
import { cancelPendingToolApprovalsForConversation } from "../lib/tools/toolApproval";
import { clearMcpToolActivation } from "../lib/tools/toolSearchTools";
import { buildTrayMenuModel, syncTrayMenu } from "../lib/tray/trayMenu";
import { useTrayPrefs } from "../lib/tray/trayPrefs";
import { createTauriTunnelClient } from "../lib/tunnels/tauriTunnelClient";
import { tauriWorkspaceActivityClient } from "../lib/workspace-activity/tauriWorkspaceActivityClient";
import type { ChatPageProps } from "./chat/chatPageTypes";
import { asErrorMessage } from "./chat/chatPageUtils";
import { useComposerHistoryPrompts } from "./chat/composer/useComposerHistoryPrompts";
import type {
  ConversationControllerActions,
  ConversationSurfaceController,
} from "./chat/conversations/conversationControllerTypes";
import { createConversationSurfaceController } from "./chat/conversations/createConversationSurfaceController";
import { useConversationHydrationPhase } from "./chat/conversations/useConversationHydrationPhase";
import { useConversationPaneHostBridge } from "./chat/conversations/useConversationPaneHostBridge";
import { useConversationRuntimeEntrySnapshot } from "./chat/conversations/useConversationRuntimeEntrySnapshot";
import type {
  EnsureGatewayBridgeConversationReadyOptions,
  SendChatAction,
} from "./chat/gateway/gatewayBridgeTypes";
import { useGatewayBridgeListeners } from "./chat/gateway/useGatewayBridgeListeners";
import { useGatewayBridgeReadiness } from "./chat/gateway/useGatewayBridgeReadiness";
import { useGatewayRunMirrorCoordinator } from "./chat/gateway/useGatewayRunMirrorCoordinator";
import { useGatewayStatus } from "./chat/gateway/useGatewayStatus";
import { useBranchConversation } from "./chat/history/useBranchConversation";
import { useConversationHistoryActions } from "./chat/history/useConversationHistoryActions";
import { useSharedHistory } from "./chat/history/useSharedHistory";
import { useChatPageRuntimeStore } from "./chat/hooks/useChatPageRuntimeStore";
import {
  createContextUsageTokensSource,
  useContextUsageTokensSource,
} from "./chat/hooks/useContextUsageTokensSource";
import { useEditResend } from "./chat/hooks/useEditResend";
import { useLiveTranscriptController } from "./chat/hooks/useLiveTranscriptController";
import { useNotifyToasts } from "./chat/hooks/useNotifyToasts";
import { MAX_UPLOAD_FILES, usePendingUploads } from "./chat/hooks/usePendingUploads";
import { useTauriFileDrop } from "./chat/hooks/useTauriFileDrop";
import { useUploadZoneDrop } from "./chat/hooks/useUploadZoneDrop";
import {
  getQueuedConversationIds,
  removeQueuedChatTurnsForConversation,
} from "./chat/queue/chatTurnQueue";
import { useChatTurnQueue } from "./chat/queue/useChatTurnQueue";
import { createChatRuntimeHost } from "./chat/runtime/ChatRuntimeHost";
import {
  pruneIdleConversationRuntimeCaches,
  syncMovedConversationRuntimeWorkdir,
} from "./chat/runtime/chatPageRuntime";
import { createGuiClarifyRunner } from "./chat/runtime/clarifyRunner";
import {
  resolveActiveModelSelection,
  resolveEffectiveChatModelSelection,
} from "./chat/runtime/modelSelection";
import { resolvePromptClarifyModelSelection } from "./chat/runtime/providerRuntimeConfig";
import { useChatModelSelection } from "./chat/runtime/useChatModelSelection";
import {
  type ManualCompactionRequest,
  type ManualCompactionResult,
  useManualCompaction,
} from "./chat/runtime/useManualCompaction";
import { useProjectToolTextGenerationClient } from "./chat/runtime/useProjectToolTextGenerationClient";
import { useSendChatTurn } from "./chat/runtime/useSendChatTurn";
import { ChatSidebarContainer } from "./chat/sidebar/ChatSidebarContainer";
import {
  type ConversationPaneBinding,
  ConversationPaneHostEnvironmentProvider,
  type ConversationPaneRegistration,
  createConversationPaneHostEnvironment,
} from "./chat/surfaces/ConversationPaneHostEnvironment";
import { ConversationTrajectorySurface } from "./chat/surfaces/ConversationTrajectorySurface";
import { TerminalPaneHost } from "./chat/surfaces/TerminalPaneHost";
import { resolveWorkbenchPaneProject } from "./chat/workbench/paneProjectContext";
import { sessionWorkbench } from "./chat/workbench/sessionWorkbench";
import { commitTerminalDrop } from "./chat/workbench/terminalDropCommit";
import { releaseOrphanTerminalPaneLeases } from "./chat/workbench/terminalPaneLeaseStore";
import {
  createTerminalSurfaceId,
  findTerminalPaneForSession,
  terminalAppExitGuard,
  terminalPaneAutoLaunch,
  terminalPaneBindings,
  terminalPaneLease,
} from "./chat/workbench/terminalPaneRuntime";
import { useWindowWorkbench } from "./chat/workbench/useWindowWorkbench";
import {
  canSplitRectAtEdge,
  useWorkbenchDragSession,
  type WorkbenchDragUnavailableReason,
  type WorkbenchDropCommit,
} from "./chat/workbench/useWorkbenchDragSession";
import { useProjectTerminals } from "./chat/workspace/useProjectTerminals";
import { useWorkspaceProjectRemoval } from "./chat/workspace/useWorkspaceProjectRemoval";
import { useWorkspaceProjects } from "./chat/workspace/useWorkspaceProjects";

const ConversationPaneHost = lazy(async () => ({
  default: (await import("./chat/surfaces/ConversationPaneHost")).ConversationPaneHost,
}));
const RestorableConversationPaneHost = lazy(async () => ({
  default: (await import("./chat/surfaces/ConversationPaneHost")).RestorableConversationPaneHost,
}));

export function ChatPage(props: ChatPageProps) {
  const {
    settings,
    setSettings,
    getMcpSettings,
    getToolPolicies,
    context,
    setContext,
    onOpenSettings,
    onToggleTheme,
    appUpdate,
    onRunningConversationCountChange,
  } = props;
  // Monaco reads NLS globals while the lazy editor module imports monaco-editor.
  setPreferredMonacoNlsLocale(settings.locale);
  const effectiveTheme = resolveEffectiveTheme(settings.theme);
  const { t, locale } = useLocale();
  const initialConversationRef = useRef(createConversationIdentity());
  const initialConversationStateRef = useRef(createConversationStateFromContext(context));

  const [conversationState, setConversationState] = useState<ConversationViewState>(
    () => initialConversationStateRef.current,
  );
  const [compactionStatus, setCompactionStatus] = useState<CompactionStatus>({ phase: "idle" });
  const [isSending, setIsSending] = useState(false);
  const [isImportingPastedText, setIsImportingPastedText] = useState(false);
  const isImportingPastedTextRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hookWarning, setHookWarning] = useState<string | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string>(
    () => initialConversationRef.current.conversationId,
  );
  // sessionId / createdAt / selectedModel are no longer page-level mirror state: they are derived
  // from the registry entry (see useConversationRuntimeEntrySnapshot after the
  // useChatPageRuntimeStore call), and the registry is the sole writer.
  const [runningConversationIds, setRunningConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [conversationOpenState, setConversationOpenState] = useState<ConversationOpenState>({
    conversationId: "",
    phase: "idle",
    showOverlay: false,
    errorCode: null,
  });
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();

  const isAgentMode = isAgentExecutionMode(settings.system.executionMode);
  const isAgentDevExecutionMode = isAgentDevMode(settings.system.executionMode);
  const workdir = settings.system.workdir.trim();
  const activeAgentPrompt = useMemo(() => {
    return resolveEffectivePromptSettings(settings, "").globalPrompt;
  }, [settings]);
  // The sidebar store owns all sidebar domain state (conversation list,
  // workdirs, running set); ChatPage only issues imperative calls and keeps a
  // few narrow selector subscriptions.
  const sidebarStore = useMemo(() => createSidebarStore(createGuiSidebarBackend()), []);
  const startNewConversationActionRef = useRef<(options?: { workdir?: string }) => string>(
    () => "",
  );
  const prepareComposerForConversationChangeActionRef = useRef<() => void>(() => undefined);
  const {
    activeView,
    setActiveView,
    projectSettingsProject,
    setProjectSettingsProject,
    rightDockOpen,
    setRightDockOpen,
  } = useApplicationViewState<WorkspaceProject>();
  const {
    workspaceProjects,
    setActiveWorkspaceProjectId,
    missingWorkspaceProjectPathKeys,
    archivedWorkspaceProjectPathKeys,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    sidebarScope,
    historyScopeKey,
    activateWorkspaceProject,
    activateSearchConversationWorkspace,
    clearSearchConversationWorkspace,
    searchConversationWorkdir,
    handleSelectWorkspaceProject,
    handleNewConversationForProject,
    handleBrowseWorkspaceProjectInFileTree,
    ensureTunnelToolTab,
    ensureSshTunnelToolTab,
    handleBrowseWorkspaceProjectInSystemFileManager,
    handleOpenCreateWorkspaceProject,
    workspaceCreateModalOpen,
    setWorkspaceCreateModalOpen,
    handleOpenWorkspaceFolder,
    handleDropWorkspaceFolders,
    handleCloneWorkspaceProject,
    handleOpenClonedWorkspace,
    handleOpenWorktree,
    workspaceProjectGroups,
    handleCreateWorkspaceGroup,
    handleRenameWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleMoveWorkspaceProjectToGroup,
    handleToggleWorkspaceGroupCollapsed,
    handleLoadWorkspaceRemoteBranches,
    commitWorkspaceProjectRename,
    handleSetWorkspaceProjectPinned,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
  } = useWorkspaceProjects({
    settings,
    setSettings,
    sidebarStore,
    isAgentMode,
    workdir,
    t,
    setErrorMessage,
    setActiveView,
    setRightDockOpen,
    startNewConversationActionRef,
    prepareComposerForConversationChangeActionRef,
  });
  const [workspaceRootRevision, setWorkspaceRootRevision] = useState(0);
  const handleWorkspaceDirectoriesMounted = useCallback(() => {
    setWorkspaceRootRevision((revision) => revision + 1);
  }, []);
  useEffect(() => {
    sidebarStore.start();
    return () => {
      sidebarStore.stop();
    };
  }, [sidebarStore]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [conversationSearchRequestKey, setConversationSearchRequestKey] = useState(0);
  const { remoteRuntimeStatus, setRemoteRuntimeStatus } = useGatewayStatus({
    remote: settings.remote,
  });
  const tauriTunnelClient = useMemo<LocalTunnelClient>(() => createTauriTunnelClient(), []);

  // The only page-level subscription to the sidebar list: ChatPage's own
  // render needs (draft detection, pending-item effect, workspace root).
  const historyItems = useSidebarSelector(sidebarStore, selectConversations);
  const mentionableConversations = useMemo(
    () =>
      historyItems
        .filter((item) => !item.isPending)
        .map(({ id, title, cwd, updatedAt, messageCount }) => ({
          id,
          title,
          cwd,
          updatedAt,
          messageCount,
        })),
    [historyItems],
  );
  const sidebarConversationsById = useSidebarSelector(sidebarStore, (s) => s.byId);
  const {
    canShareHistory,
    shareConversation,
    shareStatus,
    shareLoading,
    shareUpdating,
    shareError,
    sharedManagerOpen,
    setSharedManagerOpen,
    sharedManagerStatuses,
    sharedManagerLoadingIds,
    sharedManagerUpdatingIds,
    sharedManagerErrors,
    sharedManagerGatewayUrlLoading,
    sharedManagerShareOrigin,
    sharedManagerShareOriginPort,
    sharedHistoryItems,
    removeSharedHistoryItems,
    handleLoadSharedHistoryStatus,
    handleOpenShareModal,
    handleCloseShareModal,
    handleToggleHistoryShare,
    handleSetShareRedactToolContent,
    handleRefreshSharedHistoryStatuses,
    handleOpenSharedHistoryManager,
    handleDisableSharedHistory,
    handleSetSharedHistoryRedactToolContent,
  } = useSharedHistory({
    remoteSettings: settings.remote,
    remoteRuntimeStatus,
    setRemoteRuntimeStatus,
    sidebarStore,
    setErrorMessage,
  });

  const { availableSkills, skillsRootDir, refreshSkills } = useChatSkills({
    skillsEnabled: settings.skills.enabled && isAgentMode,
    selectedSkillNames: settings.skills.selected,
    setSettings,
  });

  const transcriptItems = useMemo<RenderTimelineItem[]>(
    () => conversationState.transcript.items,
    [conversationState],
  );
  const loadComposerHistoryPrompts = useComposerHistoryPrompts(transcriptItems);
  const {
    activeConversationView,
    setActiveConversationView,
    viewForConversation,
    setConversationView,
  } = useConversationViewState(currentConversationId);
  const currentRequestContext = useMemo(
    () => buildRequestContext(conversationState),
    [conversationState],
  );
  const chatRuntimeHost = useMemo(() => createChatRuntimeHost(), []);

  const {
    hostRef: conversationPaneHostRef,
    composerRef,
    scrollFollowRef,
  } = useConversationPaneHostBridge();
  const composerBusyRef = useRef(false);
  const conversationLoadSequenceRef = useRef(0);
  const subagentStoresRef = useRef(createSubagentStoreManager());
  const previousSubagentRuntimeConversationRef = useRef(currentConversationId);
  const subagentWarmupSignatureRef = useRef("");
  const titleJobRef = useRef<{
    conversationId: string;
    promise: Promise<string | null>;
  } | null>(null);
  const previousHistoryIdsRef = useRef<Set<string>>(new Set());
  const previousHistoryScopeKeyRef = useRef(historyScopeKey);
  const currentConversationHistoryUpdatedAtRef = useRef<number | null>(null);
  const locallySyncedHistoryUpdatedAtRef = useRef(new Map<string, number>());
  const gatewayBridgeHistorySummaryRef = useRef(new Map<string, ChatHistorySummary>());
  const openInitialActionRef = useRef<
    (id: string, request?: ConversationOpenRequest) => Promise<"cache-hit" | "painted">
  >(async () => "painted");
  const hydrateConversationActionRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const loadEarlierHistoryActionRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const cleanupDeletedConversationActionRef = useRef<(id: string) => void>(() => undefined);
  const openController = useMemo(
    () =>
      createConversationOpenController({
        openInitial: (conversationId, request) =>
          openInitialActionRef.current(conversationId, request),
        onStateChange: setConversationOpenState,
      }),
    [],
  );
  const sendActionRef = useRef<SendChatAction>(async () => false);
  // Manual compaction entry relayed from the WebUI via chat_queue compact_now (consumed by
  // useChatTurnQueue).
  const manualCompactActionRef = useRef<
    (request?: ManualCompactionRequest) => Promise<ManualCompactionResult>
  >(async () => ({ status: "skipped" }));
  const ensureGatewayBridgeConversationReadyRef = useRef<
    (id: string, options?: EnsureGatewayBridgeConversationReadyOptions) => Promise<string>
  >(async (id) => id.trim());
  const stopSendingActionRef = useRef<() => void>(() => undefined);
  const stopConversationActionRef = useRef<(conversationId: string) => void>(() => undefined);
  const {
    liveTranscriptStore,
    getConversationLiveTranscriptStore,
    getCompactionController,
    deleteConversationArtifacts,
    clearAbortSnapshot,
    captureAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    settleLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
  } = useLiveTranscriptController({
    currentConversationId,
  });
  // Persisted transcript rows provide stable historical content; the synthetic live assistant
  // supplies current streaming text/thinking/tool payloads until the final history write lands.
  const trajectoryPersistedMessages = useMemo(
    () => toTrajectoryMessages(transcriptItems),
    [transcriptItems],
  );
  const trajectoryLiveTranscriptSnapshot = useSyncExternalStore(
    (listener) => liveTranscriptStore.subscribe(listener),
    () => liveTranscriptStore.getSnapshot(),
  );
  const trajectoryLiveAssistantMessage = useMemo(
    () =>
      toTrajectoryLiveAssistantMessage(
        trajectoryLiveTranscriptSnapshot,
        `trajectory-live-${currentConversationId}`,
      ),
    [currentConversationId, trajectoryLiveTranscriptSnapshot],
  );
  const trajectoryMessages = useMemo(
    () =>
      trajectoryLiveAssistantMessage === undefined
        ? trajectoryPersistedMessages
        : [...trajectoryPersistedMessages, trajectoryLiveAssistantMessage],
    [trajectoryLiveAssistantMessage, trajectoryPersistedMessages],
  );
  const isDraftConversation = !historyItems.some((item) => item.id === currentConversationId);
  const hasConversationReply =
    !isDraftConversation && trajectoryMessages.some((message) => message.role === "assistant");
  const renderedConversationView = hasConversationReply ? activeConversationView : "conversation";
  const {
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    registerGatewayRunMirror,
    finishGatewayRunMirror,
  } = useGatewayRunMirrorCoordinator();

  // Usage ring reading: while running, read TokenLedger directly (updated as soon as a message
  // settles, without per-frame estimation of streaming text; see the comments inside
  // useContextUsageTokensSource for priority and rationale); when the ledger has no reading or is
  // idle, use deriveContextUsageTokens, shared with the WebUI, to scan history items backwards
  // (appending the live tail while running). It reaches the ring component directly through the
  // subscription source, so a reading change re-renders only the ring itself without flowing back
  // ChatPage。
  const contextUsageRingRunning = isSending || compactionStatus.phase === "running";
  const contextUsageTokensSource = useContextUsageTokensSource({
    isRunning: contextUsageRingRunning,
    conversationId: currentConversationId,
    transcriptItems,
    liveTranscriptStore,
    getCompactionController,
  });
  const {
    currentConversationIdRef,
    conversationRuntimeRegistry,
    conversationRuntimeCacheRef,
    conversationPersistenceCursorRef,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    updateConversationRuntimeEntry,
    isConversationRunning,
    setConversationAbortController,
    getConversationAbortController,
    requestConversationStop,
    getConversationStopRequestVersion,
    isConversationStopRequested,
    consumeConversationStop,
    setConversationRunningState,
    setConversationStopHandler,
    clearConversationStopHandler,
    requestActiveConversationStop,
    setConversationSendingState,
  } = useChatPageRuntimeStore({
    initialConversation: initialConversationRef.current,
    initialConversationState: initialConversationStateRef.current,
    currentConversationId,
    conversationState,
    compactionStatus,
    isSending,
    errorMessage,
    hookWarning,
    setConversationState,
    setCompactionStatus,
    setIsSending,
    setErrorMessage,
    setHookWarning,
    setRunningConversationIds,
  });
  // Registry-derived "current conversation" metadata: the runtime entry is
  // the single writer target, so these follow per-conversation updates (model
  // selection, gateway installs) without a mirrored page-level slot.
  const currentConversationRuntimeEntrySnapshot = useConversationRuntimeEntrySnapshot(
    conversationRuntimeRegistry,
    currentConversationId,
  );
  const currentConversationSessionId =
    currentConversationRuntimeEntrySnapshot?.sessionId ?? currentConversationId;
  const currentConversationCreatedAt =
    currentConversationRuntimeEntrySnapshot?.createdAt ?? initialConversationRef.current.createdAt;
  const currentConversationSelectedModel = currentConversationRuntimeEntrySnapshot?.selectedModel;
  // Reactive read of the *current* conversation's hydration phase. Hydration
  // itself is bucketed per conversation in the registry (two panes hydrating
  // at once never clobber each other); this is only the page-level view.
  const currentConversationHydrationPhase = useConversationHydrationPhase(
    conversationRuntimeRegistry.hydration,
    currentConversationId,
  );
  const handleLoadEarlierHistory = useCallback(
    () => loadEarlierHistoryActionRef.current(currentConversationIdRef.current),
    [currentConversationIdRef],
  );

  const {
    modelOptions,
    activeSelectedModel,
    selectedValue,
    hasModels,
    currentModelLabel,
    currentModelContextWindow,
    handleSelectModel,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    chatRuntimeControlsForCurrentProvider,
    handleChatRuntimeControlsChange,
  } = useChatModelSelection({
    settings,
    setSettings,
    t,
    sidebarStore,
    sidebarConversationsById,
    currentConversationId,
    currentConversationSelectedModel,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    updateConversationRuntimeEntry,
  });

  const projectToolTextGenerationClient = useProjectToolTextGenerationClient({
    settings,
    conversationRuntimeCacheRef,
    currentConversationIdRef,
    currentConversationSessionId,
  });

  function cancelConversationLoad() {
    conversationLoadSequenceRef.current += 1;
    // The sequence bump invalidated every in-flight load, so no bucket may
    // stay "hydrating". Failure marks stay: they describe a conversation that
    // truly failed and are cleared per-id by that conversation's retry.
    conversationRuntimeRegistry.hydration.clearAllHydrating();
  }

  const currentConversationPersistedCwd =
    historyItems.find((item) => item.id === currentConversationId)?.cwd?.trim() || "";
  const currentConversationRuntimeWorkdir =
    conversationRuntimeCacheRef.current.get(currentConversationId)?.workdir?.trim() || "";
  const displayedConversationWorkdir =
    currentConversationPersistedCwd ||
    currentConversationRuntimeWorkdir ||
    (searchConversationWorkdir === ""
      ? ""
      : isAgentMode
        ? activeWorkspaceProjectPath || workdir
        : "");
  const searchMentionableConversations = useCallback(
    (query: string) =>
      searchMentionConversations({
        query,
        currentConversationId,
        currentWorkdir: displayedConversationWorkdir,
      }),
    [currentConversationId, displayedConversationWorkdir],
  );
  const activeWorkspaceResources = useMemo(
    () => resolveWorkspaceResources(settings, displayedConversationWorkdir),
    [displayedConversationWorkdir, settings],
  );
  const skillsEnabled = activeWorkspaceResources.skillsEnabled && isAgentMode;
  const selectedSkillNames = useMemo(
    () => (skillsEnabled ? activeWorkspaceResources.skillNames : []),
    [activeWorkspaceResources.skillNames, skillsEnabled],
  );
  const { enabledComposerSkills, codeReviewSkill } = useComposerSkillSelection(
    availableSkills,
    selectedSkillNames,
    skillsEnabled,
  );
  const mentionApps = useMentionApps(activeWorkspaceResources.mcpServers, isAgentMode);
  const terminalProjectPath = isAgentMode ? activeWorkspaceProjectPath.trim() : "";
  const terminalProjectPathKey = terminalProjectPath
    ? workspaceProjectPathKey(terminalProjectPath)
    : "";
  const {
    terminalSessions,
    setTerminalSessions,
    terminalSessionsLoaded,
    handleRightDockSessionsChange,
    verifyTerminalSessionAlive,
  } = useProjectTerminals({
    terminalProjectPathKey,
    requestConfirmDialog,
    t,
    setErrorMessage,
  });
  // Sessions leased by a workbench Pane are hidden from the Right Dock's terminal tab (a terminal
  // appears in only one host at a time); after the Pane closes (Detach) and releases the lease, it
  // automatically returns to the dock. The SSH overlay's shell tab still uses this set for viewport
  // placeholder mutual exclusion.
  const leasedTerminalSessionIds = useSyncExternalStore(
    terminalPaneLease.subscribe,
    terminalPaneLease.leasedSessionIds,
  );
  const leasedDockSessionIds = useMemo(
    () => (leasedTerminalSessionIds.length > 0 ? new Set(leasedTerminalSessionIds) : undefined),
    [leasedTerminalSessionIds],
  );
  // Count badge on the top bar's dock collapse button: counts only sessions still in the dock.
  // Terminals dragged onto the canvas are already visible there, so including them in the badge would
  // make it disagree with the number of dock tabs.
  const projectTerminalSessions = useMemo(
    () =>
      terminalProjectPathKey
        ? terminalSessions.filter(
            (session) =>
              terminalSessionBelongsToProject(session, terminalProjectPathKey) &&
              !leasedDockSessionIds?.has(session.id),
          )
        : [],
    [leasedDockSessionIds, terminalProjectPathKey, terminalSessions],
  );
  const terminalSessionsRef = useRef(terminalSessions);
  terminalSessionsRef.current = terminalSessions;
  const {
    rightDockProjectState,
    rightDockFileTreeState,
    rightDockFileTreeOpen,
    associatedSshHostIds,
    handleChatTranscriptWidthChange,
    handleRightDockWidthChange,
    handleRightDockProjectStateChange,
    handleRightDockFileTreeStateChange,
    handleSshProjectHostIdsChange,
  } = useRightDockSettings({ settings, setSettings, terminalProjectPathKey });
  const terminalDisabledMessage = !isAgentMode
    ? "Project tools require Agent project mode."
    : !terminalProjectPath
      ? "Select a project to use project tools."
      : undefined;
  const tunnelEnabled = settings.remote.enableWebTunnels === true;
  const tunnelDisabledMessage = !settings.remote.enableWebTunnels
    ? t("projectTools.tunnelWebDisabled")
    : undefined;
  const {
    isSuggestionTyping,
    handleRightDockInsertFileMention,
    handleRightDockInsertCommitMention,
    handleRightDockInsertGitFileMention,
    handleInsertCodeMention,
    handleEmptyStateSuggestion,
  } = useComposerActions(composerRef);
  const handleRightDockInsertCodeReviewSkill = useInsertCodeReviewSkill({
    composerRef,
    codeReviewSkill,
    setSettings,
  });
  const workspaceOverlays = useWorkspaceOverlays({
    terminalProjectPath,
    terminalProjectPathKey,
    rightDockFileTreeOpen,
  });
  const {
    handleOpenWorkspaceFile,
    handleOpenSshTerminal,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
  } = workspaceOverlays;
  const {
    gitReviewFocusRequest,
    handleGitReviewFocusRequestHandled,
    handleChangedFileReveal,
    changedFilesActions,
  } = useChangedFilesActions({
    terminalProjectPathKey,
    setRightDockOpen,
    setSettings,
    onOpenFile: handleOpenWorkspaceFile,
  });
  // Local runner running-state → sidebar store: diff transitions so sidebar
  // dots (and running workdir keys) include local runs immediately; remote
  // runs arrive through the store's own event subscription.
  const previousSidebarRunningPatchIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const previous = previousSidebarRunningPatchIdsRef.current;
    previousSidebarRunningPatchIdsRef.current = runningConversationIds;
    for (const conversationId of runningConversationIds) {
      if (!previous.has(conversationId)) {
        sidebarStore.applyRunningPatch({
          conversationId,
          running: true,
          workdir: conversationRuntimeCacheRef.current.get(conversationId)?.workdir,
        });
      }
    }
    for (const conversationId of previous) {
      if (!runningConversationIds.has(conversationId)) {
        sidebarStore.applyRunningPatch({ conversationId, running: false });
      }
    }
  }, [conversationRuntimeCacheRef, runningConversationIds, sidebarStore]);

  const { notifyItems, addNotify, dismissNotify } = useNotifyToasts({
    errorMessage,
    hookWarning,
    compactionStatus,
  });

  const notifyChatFileLinkError = useCallback(
    (message: string) => addNotify("error", message),
    [addNotify],
  );
  const handleOpenChatFileLink = useChatFileLinkNavigation({
    conversationId: currentConversationId,
    conversationWorkdir: displayedConversationWorkdir,
    terminalProjectPathKey,
    notifyError: notifyChatFileLinkError,
    onRevealInFileTree: handleChangedFileReveal,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
  });
  const trajectoryHost = useMemo(
    () => createTauriTrajectoryHost(handleOpenChatFileLink),
    [handleOpenChatFileLink],
  );

  const {
    isUploadingFiles,
    pendingUploadedFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    pickReadableFiles,
    importReadableFilePaths,
    importReadableFiles,
    removePendingUpload,
  } = usePendingUploads({
    isAgentMode,
    workdir: displayedConversationWorkdir,
    conversationId: currentConversationId,
    uploadStore: conversationRuntimeRegistry.uploads,
    currentConversationIdRef,
    composerRef,
    setErrorMessage,
    addNotify,
  });
  function resetVisibleTransientState(targetConversationId = currentConversationIdRef.current) {
    if (currentConversationIdRef.current !== targetConversationId) {
      return;
    }
    composerRef.current?.clear();
    setPendingUploadsForConversation(targetConversationId, []);
    setErrorMessage(null);
    setHookWarning(null);
    scrollFollowRef.current?.stickToBottom();
  }

  const composerDraftCacheRef = useRef(conversationRuntimeRegistry.drafts);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The optional conversation defaults to the latest id stored in the stable ref.
  const cacheActiveComposerDraft = useCallback(
    (conversationId = currentConversationIdRef.current) => {
      const key = conversationId.trim();
      const draft = composerRef.current?.getDraft();
      if (!key || !draft || draft.isEmpty || !draft.text.trim()) {
        conversationRuntimeRegistry.drafts.delete(key);
        return;
      }
      conversationRuntimeRegistry.drafts.set(key, draft);
    },
    [composerRef, conversationRuntimeRegistry],
  );
  const prepareComposerForConversationChange = useCallback(() => {
    cacheActiveComposerDraft();
  }, [cacheActiveComposerDraft]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The optional conversation defaults to the latest id stored in the stable ref.
  const clearCachedComposerDraft = useCallback(
    (conversationId = currentConversationIdRef.current) => {
      conversationRuntimeRegistry.drafts.delete(conversationId);
    },
    [conversationRuntimeRegistry],
  );
  const deleteCachedComposerDraftState = clearCachedComposerDraft;

  prepareComposerForConversationChangeActionRef.current = prepareComposerForConversationChange;

  const {
    queuedChatTurnsRef,
    queuedChatTurnEditSlotRef,
    setQueuedChatTurnsState,
    publishChatQueueSnapshots,
    collectChatQueueSnapshotConversationIds,
    stopSending,
    stopConversation,
    enqueueCurrentComposerTurn,
    enqueueComposerTurnForConversation,
    requestQueuedChatTurnProcessing,
    runQueuedTurnNow,
    moveQueuedTurnUp,
    editQueuedTurn,
    removeQueuedTurn,
    shouldQueueGatewayChatRequest,
    enqueueGatewayChatRequest,
  } = useChatTurnQueue({
    settings,
    currentConversationId,
    queueStore: conversationRuntimeRegistry.queue,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    buildRuntimeEntryFromVisibleState,
    isConversationRunning,
    runningConversationIds,
    getConversationAbortController,
    setConversationAbortController,
    setConversationSendingState,
    requestConversationStop,
    getConversationStopRequestVersion,
    isConversationStopRequested,
    consumeConversationStop,
    requestActiveConversationStop,
    getConversationLiveTranscriptStore,
    captureAbortSnapshot,
    updateToolStatus,
    composerRef,
    pendingUploadedFiles,
    setPendingUploadsForConversation,
    clearCachedComposerDraft,
    displayedConversationWorkdir,
    sendActionRef,
    manualCompactActionRef,
  });
  stopConversationActionRef.current = stopConversation;

  // Conversational plan approval (aligned with Codex): submitting a plan terminates the planning
  // run, and the user responds with a message or a button. Approve = turn off the plan switch +
  // stage an execution continuation; reject = stage the feedback as a normal user message. Both go
  // through the "stage -> flush after the run disappears" path: send refuses when the conversation
  // is currently sending/loading (returns false), and sending directly would silently drop the
  // message -- the flush re-stages based on the result until it truly sends. The card button, the
  // composer approval phrase, and the WebUI plan_decision entry points all share these two paths.
  const pendingPlanContinuationsRef = useRef(new Map<string, string>());
  const pendingPlanFeedbackRef = useRef(new Map<string, string>());
  const planDecisionSendsInFlightRef = useRef(new Set<string>());
  const planDecisionRetryCountsRef = useRef(new Map<string, number>());
  // Sampled when handleSend is clicked (this callback deliberately does not depend on settings):
  // phrase approval only takes effect while the plan switch is still on, preventing an abandoned,
  // stale pending plan from being unexpectedly revived later by a casual "sure/ok".
  const planModeEnabledRef = useRef(false);
  planModeEnabledRef.current = settings.chatRuntimeControls.planModeEnabled === true;
  const [planContinuationVersion, setPlanContinuationVersion] = useState(0);
  useEffect(() => {
    registerPlanDecisionHandlers({
      onApprove: ({ conversationId }) => {
        setSettings((prev) =>
          prev.chatRuntimeControls.planModeEnabled
            ? {
                ...prev,
                chatRuntimeControls: { ...prev.chatRuntimeControls, planModeEnabled: false },
              }
            : prev,
        );
        pendingPlanContinuationsRef.current.set(conversationId, t("chat.planMode.executePrompt"));
        planDecisionRetryCountsRef.current.delete(conversationId);
        setPlanContinuationVersion((version) => version + 1);
      },
      onReject: ({ conversationId, feedback }) => {
        pendingPlanFeedbackRef.current.set(conversationId, feedback);
        planDecisionRetryCountsRef.current.delete(conversationId);
        setPlanContinuationVersion((version) => version + 1);
      },
    });
    return () => registerPlanDecisionHandlers(null);
  }, [setSettings, t]);
  // Flush the staged plan-response messages (the planning run "terminates on submit", but in
  // interrupt/queue scenarios the conversation may still be sending):
  // - Reject feedback: sent as soon as the conversation is idle (the model stays in plan mode to
  //   revise);
  // - Execution continuation: additionally requires that the plan switch is off (settings already
  //   flushed, so the continuation is not merged back into read-only by "tighten-only").
  // When send returns false / throws, re-stage; a run-set change (run ending) is the main retry
  // signal, plus one short-delay fallback bump (covering rejections unrelated to the run set, such
  // as hydrating). The fallback is count-limited: a permanent failure (e.g. conversation load
  // failure) must not degrade into a per-second retry loop -- past the limit the message stays in
  // the staging map and is retried when the run set next changes or a new response arrives. The
  // in-flight set prevents concurrent duplicate sends.
  // biome-ignore lint/correctness/useExhaustiveDependencies: planContinuationVersion is a deliberate re-run trigger (bumped after the response is written to the ref)
  useEffect(() => {
    const scheduleFlushRetry = (conversationId: string) => {
      const attempts = planDecisionRetryCountsRef.current.get(conversationId) ?? 0;
      if (attempts >= 5) return;
      planDecisionRetryCountsRef.current.set(conversationId, attempts + 1);
      window.setTimeout(() => setPlanContinuationVersion((version) => version + 1), 1_000);
    };
    const flushPlanSends = (
      store: Map<string, string>,
      buildOverrides: (conversationId: string, text: string) => Parameters<SendChatAction>[0],
    ) => {
      for (const [conversationId, text] of store) {
        if (runningConversationIds.has(conversationId)) continue;
        if (planDecisionSendsInFlightRef.current.has(conversationId)) continue;
        planDecisionSendsInFlightRef.current.add(conversationId);
        store.delete(conversationId);
        void sendActionRef
          .current(buildOverrides(conversationId, text))
          .then((accepted) => {
            // On a race failure (conversation currently sending/loading), re-stage and schedule one
            // fallback retry; if a newer response for the same conversation entered the map meanwhile,
            // keep the new value.
            if (accepted) {
              planDecisionRetryCountsRef.current.delete(conversationId);
            } else if (!store.has(conversationId)) {
              store.set(conversationId, text);
              scheduleFlushRetry(conversationId);
            }
          })
          .catch((error) => {
            console.warn("plan decision message send failed", error);
            if (!store.has(conversationId)) {
              store.set(conversationId, text);
              scheduleFlushRetry(conversationId);
            }
          })
          .finally(() => {
            planDecisionSendsInFlightRef.current.delete(conversationId);
          });
      }
    };
    flushPlanSends(pendingPlanFeedbackRef.current, (conversationId, feedback) => ({
      conversationIdOverride: conversationId,
      textOverride: feedback,
      preserveComposerOnStart: true,
    }));
    if (settings.chatRuntimeControls.planModeEnabled) return;
    flushPlanSends(pendingPlanContinuationsRef.current, (conversationId, prompt) => ({
      conversationIdOverride: conversationId,
      textOverride: prompt,
      preserveComposerOnStart: true,
      runtimeControlsOverride: {
        ...settings.chatRuntimeControls,
        planModeEnabled: false,
      },
    }));
  }, [planContinuationVersion, runningConversationIds, settings.chatRuntimeControls]);

  // Queue snapshots publish on queue mutation only; after a gateway
  // reconnect (new session) the gateway's in-memory queue view is empty, so
  // republish the current queue for every conversation that has one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection identity intentionally drives the republish
  useEffect(() => {
    if (!canShareHistory) {
      return;
    }
    publishChatQueueSnapshots(
      collectChatQueueSnapshotConversationIds(queuedChatTurnsRef.current, [
        currentConversationIdRef.current,
      ]),
    );
  }, [canShareHistory, remoteRuntimeStatus.connectedSince, remoteRuntimeStatus.sessionId]);

  const deleteConversationLocalCaches = useCallback(
    (conversationId: string) => {
      const key = conversationId.trim();
      if (!key) return;
      deleteCachedComposerDraftState(key);
      locallySyncedHistoryUpdatedAtRef.current.delete(key);
      gatewayBridgeHistorySummaryRef.current.delete(key);
      setPendingUploadsForConversation(key, []);
      memoryExtraction.dispose(key);
      memoryTurnInjection.dispose(key);
      skillMentionInjection.dispose(key);
      deleteConversationArtifacts(key);
      setQueuedChatTurnsState((current) => removeQueuedChatTurnsForConversation(current, key));
    },
    [
      deleteCachedComposerDraftState,
      deleteConversationArtifacts,
      setPendingUploadsForConversation,
      setQueuedChatTurnsState,
    ],
  );

  // Unified prune cleanup for transient conversation interactions: shared by the two prune paths,
  // this page and useConversationHistoryActions, ensuring consistent lifecycle decisions. Plan
  // approval is deliberately excluded -- a pending plan is designed to survive across runs (the
  // planning run terminates on submit), and evicting an idle runtime cache does not equal destroying
  // the conversation, so the card must still be approvable after returning to it; only a genuine
  // conversation deletion clears the approval state too (see handleConversationDeleted). Clearing the
  // MCP activation set only costs one re-retrieval, so it may be cleared.
  const cancelConversationTransientInteractions = useCallback((conversationId: string) => {
    cancelPendingAskUserQuestionsForConversation(conversationId);
    cancelPendingToolApprovalsForConversation(conversationId);
    clearMcpToolActivation(conversationId);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Queue and runtime maps are mutable registries intentionally sampled at prune time through refs.
  const pruneIdleConversationCaches = useCallback(
    (extraKeepIds: Iterable<string> = []) => {
      const queuedConversationIds = getQueuedConversationIds(queuedChatTurnsRef.current);
      pruneIdleConversationRuntimeCaches({
        runtimeCache: conversationRuntimeCacheRef.current,
        persistenceCursors: conversationPersistenceCursorRef.current,
        keepConversationIds: [
          currentConversationIdRef.current,
          ...extraKeepIds,
          ...queuedConversationIds,
        ],
        isConversationRunning,
        onPruneConversation: (conversationId) => {
          deleteConversationLocalCaches(conversationId);
          subagentStoresRef.current.dispose(conversationId);
          cancelConversationTransientInteractions(conversationId);
          clarifyRunnersRef.current.delete(conversationId);
        },
      });
    },
    [
      conversationRuntimeCacheRef,
      currentConversationIdRef,
      deleteConversationLocalCaches,
      isConversationRunning,
      conversationPersistenceCursorRef,
      cancelConversationTransientInteractions,
    ],
  );

  const markLocalHistorySnapshotSynced = useCallback(
    (conversationId: string, updatedAt: number) => {
      const key = conversationId.trim();
      if (!key) {
        return;
      }
      if (updatedAt < 0) {
        locallySyncedHistoryUpdatedAtRef.current.delete(key);
        if (currentConversationIdRef.current === key) {
          const currentItem = sidebarStore.peek(key);
          currentConversationHistoryUpdatedAtRef.current =
            currentItem && !currentItem.isPending ? currentItem.updatedAt : null;
        }
        return;
      }
      const previous = locallySyncedHistoryUpdatedAtRef.current.get(key);
      if (previous === undefined || previous === Number.MAX_SAFE_INTEGER || updatedAt > previous) {
        locallySyncedHistoryUpdatedAtRef.current.set(key, updatedAt);
      }
      if (currentConversationIdRef.current === key) {
        const currentSyncedAt = currentConversationHistoryUpdatedAtRef.current ?? 0;
        currentConversationHistoryUpdatedAtRef.current =
          currentSyncedAt === Number.MAX_SAFE_INTEGER || updatedAt === Number.MAX_SAFE_INTEGER
            ? updatedAt
            : Math.max(currentSyncedAt, updatedAt);
      }
    },
    [currentConversationIdRef, sidebarStore],
  );

  const {
    startNewConversation,
    openInitial: openConversationInitial,
    hydrateInBackground: hydrateConversationInBackground,
    loadEarlier: loadEarlierConversationHistory,
    replaceConversationAtMessage,
    cleanupDeletedConversation,
    persistConversation,
  } = useConversationHistoryActions({
    conversationState,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    conversationPersistenceCursorRef,
    markLocalHistorySnapshotSynced,
    isConversationRunning,
    conversationLoadSequenceRef,
    sidebarStore,
    titleJobRef,
    t,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    updateConversationRuntimeEntry,
    cancelConversationLoad,
    resetVisibleTransientState,
    deleteConversationArtifacts: deleteConversationLocalCaches,
    disposeSubagentsForConversation: (conversationId) => {
      subagentStoresRef.current.dispose(conversationId);
    },
    cancelConversationTransientInteractions,
    cancelPlanDecisionsForConversation: (conversationId) => {
      pendingPlanContinuationsRef.current.delete(conversationId);
      pendingPlanFeedbackRef.current.delete(conversationId);
      planDecisionRetryCountsRef.current.delete(conversationId);
      cancelPendingPlanDecisionsForConversation(conversationId);
    },
    getDefaultNewConversationWorkdir: () =>
      isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
    resolveConversationSelectedModel: (json) =>
      normalizeSelectedModelForProviders(parseSelectedModelJson(json), settings.customProviders),
    setCurrentConversationId,
    setErrorMessage,
    hydration: conversationRuntimeRegistry.hydration,
  });

  startNewConversationActionRef.current = startNewConversation;
  openInitialActionRef.current = openConversationInitial;
  hydrateConversationActionRef.current = hydrateConversationInBackground;
  loadEarlierHistoryActionRef.current = loadEarlierConversationHistory;
  cleanupDeletedConversationActionRef.current = cleanupDeletedConversation;

  const {
    handleRemoveWorkspaceProject,
    handleArchiveWorkspaceProject,
    handleUnarchiveWorkspaceProject,
    handleWorktreeRemoved,
  } = useWorkspaceProjectRemoval({
    settings,
    setSettings,
    t,
    requestConfirmDialog,
    setErrorMessage,
    sidebarStore,
    workspaceProjects,
    archivedWorkspaceProjectPathKeys,
    activeWorkspaceProject,
    activateWorkspaceProject,
    setActiveWorkspaceProjectId,
    terminalProjectPathKey,
    setTerminalSessions,
    setRightDockOpen,
    displayedConversationWorkdir,
    startNewConversationActionRef,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: Runtime and persistence registries are intentionally sampled through refs when the visible workspace inputs change.
  useEffect(() => {
    const nextWorkdir = activeWorkspaceProjectPath.trim();
    if (!isAgentMode || !nextWorkdir) {
      return;
    }
    const conversationId = currentConversationIdRef.current.trim();
    if (!conversationId || isSending || isConversationRunning(conversationId)) {
      return;
    }
    if (conversationState.meta.totalMessageCount > 0 || pendingUploadedFiles.length > 0) {
      return;
    }
    if (conversationPersistenceCursorRef.current.has(conversationId)) {
      return;
    }
    const historyItem = sidebarStore.peek(conversationId);
    if (historyItem && !historyItem.isPending) {
      return;
    }
    const currentWorkdir =
      conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
    if (currentWorkdir === nextWorkdir) {
      return;
    }
    updateConversationRuntimeEntry(conversationId, (prev) => ({
      ...prev,
      workdir: nextWorkdir,
    }));
  }, [
    activeWorkspaceProjectPath,
    conversationState.meta.totalMessageCount,
    isAgentMode,
    isConversationRunning,
    isSending,
    pendingUploadedFiles.length,
    sidebarStore,
    updateConversationRuntimeEntry,
  ]);

  const handleConversationCwdChanged = useCallback(
    (conversationId: string, cwd: string) => {
      syncMovedConversationRuntimeWorkdir({
        conversationId,
        cwd,
        runtimeCache: conversationRuntimeCacheRef.current,
        isConversationRunning,
        updateConversationRuntimeEntry,
      });
    },
    [conversationRuntimeCacheRef, isConversationRunning, updateConversationRuntimeEntry],
  );

  useEffect(() => {
    const previous = previousSubagentRuntimeConversationRef.current;
    if (previous && previous !== currentConversationId) {
      subagentStoresRef.current.dispose(previous);
    }
    previousSubagentRuntimeConversationRef.current = currentConversationId;

    const currentHistoryItem = historyItems.find(
      (item) => item.id === currentConversationId && !item.isPending,
    );
    if (!currentConversationId || !currentHistoryItem) return;

    const agentSignature = settings.agents
      .map((template) => `${template.id}:${template.name}:${template.prompt.length}`)
      .join("|");
    const warmupSignature = `${currentConversationId}:${currentHistoryItem.updatedAt}:${agentSignature}`;
    if (subagentWarmupSignatureRef.current === warmupSignature) return;
    subagentWarmupSignatureRef.current = warmupSignature;
    subagentStoresRef.current.warmup(currentConversationId);
  }, [currentConversationId, historyItems, settings.agents]);

  useEffect(
    () => () => {
      subagentStoresRef.current.disposeAll();
    },
    [],
  );

  const { ensureGatewayBridgeConversationReady } = useGatewayBridgeReadiness({
    settings,
    conversationState,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    conversationPersistenceCursorRef,
    syncVisibleConversationRuntime,
    isConversationRunning,
    sidebarStore,
    gatewayBridgeHistorySummaryRef,
    hydration: conversationRuntimeRegistry.hydration,
  });

  ensureGatewayBridgeConversationReadyRef.current = ensureGatewayBridgeConversationReady;

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
    // Per-conversation pending uploads are restored inside usePendingUploads
    // when its conversationId param changes.
  }, [currentConversationId, currentConversationIdRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The runtime cache is a mutable registry sampled when the visible conversation summary inputs change.
  useEffect(() => {
    const currentItem = historyItems.find((item) => item.id === currentConversationId);
    if (currentItem) {
      return;
    }

    if (!currentConversationId || (!isSending && !isConversationRunning(currentConversationId))) {
      return;
    }

    const runtimeEntry = conversationRuntimeCacheRef.current.get(currentConversationId);
    const currentState = runtimeEntry?.state ?? conversationState;
    const fallbackTitle = buildFallbackConversationTitle(
      getFirstUserMessageText(buildRequestContext(currentState)),
    );
    const providerId =
      activeSelectedModel?.customProviderId ??
      sidebarStore.peek(currentConversationId)?.providerId ??
      "pending";
    const model =
      activeSelectedModel?.model ?? sidebarStore.peek(currentConversationId)?.model ?? "pending";

    const pendingConversationTitle = t("chat.pendingTitle");
    const pendingItem = createPendingHistoryItem({
      conversationId: currentConversationId,
      title:
        fallbackTitle && fallbackTitle !== pendingConversationTitle
          ? fallbackTitle
          : pendingConversationTitle,
      providerId,
      model,
      sessionId: currentConversationSessionId,
      cwd: displayedConversationWorkdir || undefined,
      createdAt: currentConversationCreatedAt,
      updatedAt: Date.now(),
    });
    // When the conversation does not belong to the current workspace scope (e.g. the workspace was
    // switched mid-stream), do not force a pending row into the sidebar: it should never appear in
    // the new workspace's list, and repeatedly reinserting it would fight with the scope filter,
    // forming an infinite update loop that crashes the page.
    if (!conversationMatchesScope(pendingItem, sidebarScope)) {
      return;
    }
    sidebarStore.upsertLocal(pendingItem);
  }, [
    conversationState,
    currentConversationCreatedAt,
    currentConversationId,
    currentConversationSessionId,
    historyItems,
    isConversationRunning,
    isSending,
    activeSelectedModel,
    displayedConversationWorkdir,
    sidebarScope,
    sidebarStore,
    t,
  ]);

  useEffect(() => {
    const currentItem = sidebarStore.peek(currentConversationId);
    currentConversationHistoryUpdatedAtRef.current =
      currentItem && !currentItem.isPending ? currentItem.updatedAt : null;
  }, [currentConversationId, sidebarStore]);

  useEffect(() => {
    const previousIds = previousHistoryIdsRef.current;
    const nextIds = new Set(historyItems.map((item) => item.id));
    if (previousHistoryScopeKeyRef.current !== historyScopeKey) {
      previousHistoryIdsRef.current = nextIds;
      previousHistoryScopeKeyRef.current = historyScopeKey;
      return;
    }
    const currentConversationWasPersisted = previousIds.has(currentConversationId);
    const currentConversationExists = nextIds.has(currentConversationId);

    if (
      currentConversationId &&
      currentConversationWasPersisted &&
      !currentConversationExists &&
      !isSending
    ) {
      startNewConversationActionRef.current();
    }

    previousHistoryIdsRef.current = nextIds;
  }, [currentConversationId, historyItems, historyScopeKey, isSending]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Composer content is sampled through its ref; the effect is driven by persisted snapshot changes and run state.
  useEffect(() => {
    const currentItem = historyItems.find((item) => item.id === currentConversationId);
    if (!currentItem || currentItem.isPending) {
      return;
    }

    const lastSyncedUpdatedAt = currentConversationHistoryUpdatedAtRef.current;
    const isFirstPersistedSnapshot = lastSyncedUpdatedAt === null;
    if (!isFirstPersistedSnapshot && currentItem.updatedAt <= lastSyncedUpdatedAt) {
      return;
    }

    if (
      isSending ||
      isConversationRunning(currentConversationId) ||
      currentConversationHydrationPhase !== null ||
      composerBusyRef.current ||
      pendingUploadedFiles.length > 0
    ) {
      return;
    }

    if (composerRef.current?.hasContent()) {
      return;
    }

    currentConversationHistoryUpdatedAtRef.current = currentItem.updatedAt;
    openController.open(currentConversationId);
  }, [
    currentConversationId,
    currentConversationHydrationPhase,
    historyItems,
    isConversationRunning,
    isSending,
    openController,
    pendingUploadedFiles,
  ]);

  useEffect(() => {
    setContext(currentRequestContext);
  }, [currentRequestContext, setContext]);

  useGatewayBridgeListeners({
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    ensureGatewayBridgeConversationReadyRef,
    sendActionRef,
    queueGatewayBridgeEventForRequest,
    shouldQueueGatewayChatRequest,
    enqueueGatewayChatRequest,
    isConversationRunning,
    getConversationAbortController,
    requestConversationStop,
    requestActiveConversationStop,
    consumeConversationStop,
    runGatewayClarifyTurn: async (messages, selection, runtimeControls, onTextDelta) => {
      const provider = settings.customProviders.find((p) => p.id === selection.providerId);
      if (!provider) {
        throw new Error(`clarify provider not found: ${selection.providerId}`);
      }
      // Shares createGuiClarifyRunner with local clarify: the call parameters (cacheRetention/
      // nativeWebSearch/context assembly) have a single source, so the bridge path no longer hand-
      // writes a duplicate.
      const guiSelection = {
        selectedModel: { customProviderId: provider.id, model: selection.model },
        provider,
        providerId: provider.type,
        model: selection.model,
      };
      return createGuiClarifyRunner(
        () => guiSelection,
        () => createProviderRuntimeConfig(provider, selection.model, runtimeControls),
      )(messages, new AbortController().signal, onTextDelta);
    },
  });

  const { send } = useSendChatTurn({
    settings,
    workspaceProjects,
    setSettings,
    getMcpSettings,
    getToolPolicies,
    t,
    setErrorMessage,
    sidebarStore,
    titleJobRef,
    chatRuntimeHost,
    subagentStoresRef,
    scrollFollowRef,
    composerRef,
    composerDraftCacheRef,
    clearCachedComposerDraft,
    resetVisibleTransientState,
    isImportingPastedTextRef,
    setIsImportingPastedText,
    hydration: conversationRuntimeRegistry.hydration,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    buildRuntimeEntryFromVisibleState,
    updateConversationRuntimeEntry,
    setConversationAbortController,
    getConversationStopRequestVersion,
    isConversationStopRequested,
    consumeConversationStop,
    setConversationStopHandler,
    clearConversationStopHandler,
    setConversationSendingState,
    pendingUploadedFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    getConversationLiveTranscriptStore,
    getCompactionController,
    clearAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    settleLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    registerGatewayRunMirror,
    finishGatewayRunMirror,
    gatewayBridgeHistorySummaryRef,
    availableSkills,
    skillsRootDir,
    refreshSkills,
    ensureTunnelToolTab,
    ensureSshTunnelToolTab,
    persistConversation,
    replaceConversationAtMessage,
    pruneIdleConversationCaches,
    requestQueuedChatTurnProcessing,
  });

  sendActionRef.current = send;
  stopSendingActionRef.current = stopSending;

  // Same-source prompt construction for manual compaction: the current conversation resolves its
  // skills/memory prompts from its workspace, sharing a source with the send path's
  // buildPreparedContext (activeAgentPrompt is passed through separately). Manual compaction has no
  // triggering message, so skills' explicit mentions are empty. A background conversation relayed
  // cross-session cannot get workspace context at this layer, so it returns an empty prompt (the
  // current conversation must be same-source; background stays as-is).
  const resolveManualCompactionPromptInputs = useCallback(
    async (input: { isCurrentConversation: boolean; workdir?: string }) => {
      if (!input.isCurrentConversation) {
        return { activeAgentPrompt, skillsPrompt: "", memoryPrompt: "" };
      }
      const promptWorkdir = input.workdir?.trim() ?? "";
      const effectivePrompt = resolveEffectivePromptSettings(settings, promptWorkdir).prompt;
      const resources = resolveWorkspaceResources(settings, promptWorkdir);
      let skillsPrompt = "";
      if (resources.skillsEnabled && isAgentMode && resources.skillNames.length > 0) {
        const byName = new Map(availableSkills.map((skill) => [skill.name, skill]));
        const selectedSkills = resources.skillNames
          .map((name) => byName.get(name))
          .filter((skill): skill is SkillSummary => Boolean(skill));
        if (selectedSkills.length > 0) {
          skillsPrompt = buildSkillsSystemPrompt({
            rootDir: skillsRootDir,
            selected: selectedSkills,
          });
        }
      }
      let memoryPrompt = "";
      if (promptWorkdir) {
        try {
          memoryPrompt = await buildMemoryOverviewSection(promptWorkdir);
        } catch (error) {
          console.warn("Failed to build manual compaction memory prompt", error);
          memoryPrompt = "";
        }
      }
      return { activeAgentPrompt: effectivePrompt, skillsPrompt, memoryPrompt };
    },
    [activeAgentPrompt, availableSkills, isAgentMode, settings, skillsRootDir],
  );

  const handleManualCompact = useManualCompaction({
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
    ensureConversationReady: ensureGatewayBridgeConversationReady,
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
  });
  manualCompactActionRef.current = handleManualCompact;
  const conversationSurfaceProject = useMemo(
    () => ({
      projectId: activeWorkspaceProject?.id ?? `conversation:${currentConversationId}`,
      projectPathKey: displayedConversationWorkdir || `conversation:${currentConversationId}`,
    }),
    [activeWorkspaceProject?.id, currentConversationId, displayedConversationWorkdir],
  );
  // Shared by the current-conversation controller and every background pane
  // controller: all actions route by explicit conversationId through refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Controller methods deliberately route through latest-action refs; the runtime registry itself is stable for the page lifetime.
  const conversationControllerActions = useMemo<ConversationControllerActions>(
    () => ({
      async hydrate({ conversationId }) {
        if (conversationId === currentConversationIdRef.current) {
          await openInitialActionRef.current(conversationId);
        } else {
          await hydrateConversationActionRef.current(conversationId);
        }
      },
      async send({ conversationId, draft }) {
        // Uploads must come from the target conversation's own store — the
        // page-level pending list belongs to the focused conversation and
        // would cross-attach on a background send.
        const uploads = conversationRuntimeRegistry.uploads.getSnapshot(conversationId).slice();
        const accepted = await sendActionRef.current({
          conversationIdOverride: conversationId,
          composerDraftOverride: draft,
          uploadedFilesOverride: uploads,
        });
        if (accepted) {
          conversationRuntimeRegistry.uploads.set(conversationId, []);
        }
      },
      stop({ conversationId }) {
        stopConversationActionRef.current(conversationId);
      },
      async compact({ conversationId }) {
        await manualCompactActionRef.current({ conversationId });
      },
      async retry({ conversationId }) {
        if (conversationId === currentConversationIdRef.current) {
          await openInitialActionRef.current(conversationId);
        } else {
          await hydrateConversationActionRef.current(conversationId);
        }
      },
    }),
    [],
  );
  const conversationSurfaceController = useMemo(
    () =>
      createConversationSurfaceController({
        conversationId: currentConversationId,
        project: conversationSurfaceProject,
        registry: conversationRuntimeRegistry,
        actions: conversationControllerActions,
      }),
    [
      conversationControllerActions,
      conversationRuntimeRegistry,
      conversationSurfaceProject,
      currentConversationId,
    ],
  );
  useEffect(
    () => () => {
      conversationSurfaceController.dispose();
    },
    [conversationSurfaceController],
  );

  const handleSelectExecutionMode = useCallback(
    (mode: "text" | "tools") =>
      setSettings((prev) => updateExecutionModeFromChatSelection(prev, mode)),
    [setSettings],
  );

  const handleOpenSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleNewConversation = useCallback(() => {
    if (!isAgentMode || activeWorkspaceProjectPath) clearSearchConversationWorkspace();
    openController.cancel();
    prepareComposerForConversationChange();
    startNewConversationActionRef.current({
      workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
    });
  }, [
    activeWorkspaceProjectPath,
    clearSearchConversationWorkspace,
    isAgentMode,
    openController,
    prepareComposerForConversationChange,
  ]);

  // Actions owned by ChatPage on the action bus (Rust `app:action`) are listened to uniformly below
  // (after handleSelectConversation is defined); the ref mirror is prepared here first.
  const handleNewConversationRef = useRef(handleNewConversation);
  handleNewConversationRef.current = handleNewConversation;
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const isDraftConversationRef = useRef(isDraftConversation);
  isDraftConversationRef.current = isDraftConversation;

  const handleSelectConversation = useCallback(
    (id: string, options?: ConversationOpenOptions) => {
      const targetConversationId = id.trim();
      if (!targetConversationId) {
        return;
      }
      if (options?.source === "search") {
        openController.open(targetConversationId, {
          source: "search",
          afterCommit: options.afterCommit,
          beforeCommit: (conversation) => {
            activateSearchConversationWorkspace(conversation.cwd);
            sidebarStore.upsertLocal(conversation, { reveal: true });
            prepareComposerForConversationChange();
          },
        });
      } else {
        prepareComposerForConversationChange();
        openController.open(targetConversationId);
      }
    },
    [
      activateSearchConversationWorkspace,
      openController,
      prepareComposerForConversationChange,
      sidebarStore,
    ],
  );

  // Ref mirror of tray/shortcut action parameters: the listen effect has []-deps, so closures always
  // read the latest value through the ref (handleSelectWorkspaceProject and others depend on
  // settings and are unstable).
  const sidebarRunningConversationIds = useSidebarSelector(
    sidebarStore,
    selectRunningConversationIds,
  );
  useEffect(() => {
    onRunningConversationCountChange?.(sidebarRunningConversationIds.size);
  }, [onRunningConversationCountChange, sidebarRunningConversationIds.size]);
  useEffect(
    () => () => {
      onRunningConversationCountChange?.(0);
    },
    [onRunningConversationCountChange],
  );
  const appActionParamsRef = useRef({
    handleSelectConversation,
    handleSelectWorkspaceProject,
    stopConversation,
    consumeConversationStop,
    isConversationRunning,
    workspaceProjects,
    sidebarRunningConversationIds,
    addNotify,
    t,
  });
  appActionParamsRef.current = {
    handleSelectConversation,
    handleSelectWorkspaceProject,
    stopConversation,
    consumeConversationStop,
    isConversationRunning,
    workspaceProjects,
    sidebarRunningConversationIds,
    addNotify,
    t,
  };

  useEffect(() => {
    // Stopping a single conversation: the full sequence lives in stopConversation (stop intent +
    // queue cancellation + abort + force cleanup). When nothing was stopped and the conversation is
    // not running, the stop intent must be consumed, otherwise that conversation's next send would
    // be silently swallowed (same guard as gateway:chat-cancel).
    const stopConversationRun = (conversationId: string) => {
      const params = appActionParamsRef.current;
      const stopped = params.stopConversation(conversationId);
      if (!stopped && !params.isConversationRunning(conversationId)) {
        params.consumeConversationStop(conversationId);
      }
    };

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let unlistenFeedback: (() => void) | null = null;

    // Result feedback for direct Rust actions (currently only the tray cron enable toggle):
    // presented as a toast; the task name is looked up live from the automation store (it may have
    // been deleted, in which case fall back to showing the id). The checked state itself refreshes
    // via automation:cron-changed -> store -> tray sync effect.
    listen<{ action: string; id?: string; ok: boolean; error?: string; value?: string }>(
      "app:action-feedback",
      (event) => {
        const params = appActionParamsRef.current;
        if (event.payload.action !== "toggle-cron-task") {
          return;
        }
        const taskId = event.payload.id ?? "";
        const task = getAutomationState().cron.tasks.find((entry) => entry.id === taskId);
        const name = task?.name.trim() || taskId;
        if (event.payload.ok) {
          const messageKey =
            event.payload.value === "enabled" ? "tray.cronEnabled" : "tray.cronDisabled";
          params.addNotify("success", params.t(messageKey).replace("{name}", name));
        } else {
          params.addNotify(
            "error",
            params
              .t("tray.cronToggleFailed")
              .replace("{name}", name)
              .replace("{error}", event.payload.error ?? ""),
          );
        }
      },
    )
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlistenFeedback = nextUnlisten;
      })
      .catch(() => {
        // Ignored in a non-Tauri environment.
      });

    listen<{ action: string; id?: string; value?: string }>("app:action", (event) => {
      const params = appActionParamsRef.current;
      switch (event.payload.action) {
        case "new-chat": {
          const wasInHub = activeViewRef.current !== "chat";
          setActiveView("chat");
          // Consistent with the sidebar's "New chat": when returning from the Hub and the current
          // conversation is already an empty draft, reuse it directly.
          if (!wasInHub || !isDraftConversationRef.current) {
            handleNewConversationRef.current();
          }
          // Focus the input only after the view and conversation switch have finished rendering.
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              composerRef.current?.focus();
            });
          });
          break;
        }
        case "search-conversations": {
          setActiveView("chat");
          setConversationSearchRequestKey((requestKey) => requestKey + 1);
          break;
        }
        case "open-conversation": {
          const conversationId = event.payload.id?.trim();
          if (!conversationId) break;
          setActiveView("chat");
          params.handleSelectConversation(conversationId);
          break;
        }
        case "view-all-conversations": {
          setActiveView("chat");
          setSidebarOpen(true);
          break;
        }
        case "switch-workspace": {
          const projectId = event.payload.id?.trim();
          if (!projectId) break;
          const project = params.workspaceProjects.find((entry) => entry.id === projectId);
          // The menu may lag behind the project list; silently ignore when not found.
          if (project) {
            setActiveView("chat");
            void params.handleSelectWorkspaceProject(project);
          }
          break;
        }
        case "stop-run": {
          const conversationId = event.payload.id?.trim();
          if (conversationId) {
            stopConversationRun(conversationId);
          }
          break;
        }
        case "stop-all-runs": {
          for (const conversationId of params.sidebarRunningConversationIds) {
            stopConversationRun(conversationId);
          }
          break;
        }
        default:
          break;
      }
    })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => {
        // Ignored in a non-Tauri environment.
      });
    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
      if (unlistenFeedback) {
        unlistenFeedback();
      }
    };
  }, [composerRef, setActiveView]);

  // Tray menu sync: any input change rebuilds the model push (syncTrayMenu debounces internally by
  // JSON signature); the 300ms trailing debounce absorbs high-frequency changes caused by sidebar
  // upserts during streaming.
  // Note: global shortcut bindings are stored in localStorage with no subscription and read live at
  // model-build time -- after rebinding, the echo catches up on the next model-level change.
  const trayPrefs = useTrayPrefs();
  const automationState = useAutomation();
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void syncTrayMenu(
        buildTrayMenuModel({
          locale: settings.locale,
          theme: settings.theme,
          conversations: historyItems,
          runningConversationIds: sidebarRunningConversationIds,
          workspaceProjects,
          activeWorkspaceProjectId: activeWorkspaceProject?.id,
          archivedWorkspaceProjectPaths: settings.system.archivedWorkspaceProjectPaths,
          cronTasks: automationState.cron.tasks,
          remote: settings.remote,
          gatewayOnline: remoteRuntimeStatus.online,
          prefs: trayPrefs,
        }),
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    settings.locale,
    settings.theme,
    historyItems,
    sidebarRunningConversationIds,
    workspaceProjects,
    activeWorkspaceProject,
    settings.system.archivedWorkspaceProjectPaths,
    automationState.cron.tasks,
    settings.remote,
    remoteRuntimeStatus.online,
    trayPrefs,
  ]);

  // Called by the sidebar container after the store confirmed a deletion:
  // evict local caches, replace the visible conversation when it was the
  // deleted one, and drop the row from the shared-history list.
  const handleConversationDeleted = useCallback(
    (id: string) => {
      cleanupDeletedConversationActionRef.current(id);
      removeSharedHistoryItems([id]);
    },
    [removeSharedHistoryItems],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Runtime/edit state is intentionally sampled through refs at click time.
  const handleSend = useCallback(() => {
    const conversationId = currentConversationIdRef.current.trim();
    const runtimeEntry = conversationRuntimeCacheRef.current.get(conversationId);
    if (queuedChatTurnEditSlotRef.current?.conversationId === conversationId) {
      if (enqueueCurrentComposerTurn("edit")) {
        requestQueuedChatTurnProcessing(conversationId);
      }
      return;
    }
    // Conversational plan approval: when the conversation has a pending plan, a pure approval
    // phrase ("agree/start/ok", etc.) approves it (equivalent to clicking the card button); any
    // other input is a normal message (revision feedback) sent as usual -- the planning run has
    // ended, so the message directly opens a new round of plan mode revision without going through
    // the queue.
    // Phrase approval requires the plan switch to still be on: in the normal flow the switch stays on
    // after submission (it only turns off on approval); if the user manually turns off the pill, the
    // current plan is considered abandoned, and a later "sure/ok" is a normal message that must not
    // revive a stale plan into an execution continuation. Explicit approval can still use the card
    // button (not subject to the switch).
    if (conversationId && planModeEnabledRef.current) {
      const pendingPlan = getPendingPlanForConversation(conversationId);
      if (pendingPlan) {
        const text = composerRef.current?.getText().trim() ?? "";
        if (text && isPlanApprovalMessage(text)) {
          const outcome = answerPlanDecision(
            pendingPlan.toolCallId,
            { decision: "approve" },
            { conversationId },
          );
          if (outcome.ok) {
            composerRef.current?.clear();
            return;
          }
        }
      }
    }
    if (conversationId && (isConversationRunning(conversationId) || runtimeEntry?.isSending)) {
      enqueueCurrentComposerTurn("end");
      return;
    }
    void sendActionRef.current();
  }, [
    composerRef,
    enqueueCurrentComposerTurn,
    isConversationRunning,
    requestQueuedChatTurnProcessing,
  ]);

  const handleComposerBusyChange = useCallback((isBusy: boolean) => {
    composerBusyRef.current = isBusy;
  }, []);

  const currentConversationWorkspaceRoot = (() => {
    const currentItem = historyItems.find((item) => item.id === currentConversationId);
    const persistedCwd = currentItem?.cwd?.trim();
    if (persistedCwd) return persistedCwd;
    return displayedConversationWorkdir || undefined;
  })();
  const isCompactionRunning = compactionStatus.phase === "running";
  const isConversationHydrating = currentConversationHydrationPhase === "hydrating";
  const isConversationHydrationFailed = currentConversationHydrationPhase === "failed";
  const composerPlaceholder = isCompactionRunning
    ? t("chat.compactingContextWait")
    : isConversationHydrating
      ? "Loading conversation, please wait..."
      : isConversationHydrationFailed
        ? "Failed to load the current conversation, please reopen the conversation..."
        : enabledComposerSkills.length > 0
          ? t("chat.inputHintWithSkills")
          : t("chat.inputHint");
  const isComposerInputDisabled =
    isCompactionRunning ||
    isConversationHydrating ||
    isConversationHydrationFailed ||
    isImportingPastedText ||
    isUploadingFiles;
  const canDropUpload =
    isAgentMode && Boolean(displayedConversationWorkdir.trim()) && !isComposerInputDisabled;
  const fileDropTitle = canDropUpload
    ? t("chat.upload.dropReady")
    : !isAgentMode
      ? t("chat.upload.onlyInTools")
      : !displayedConversationWorkdir.trim()
        ? t("chat.upload.requireWorkdir")
        : t("chat.upload.dropBusy");
  const fileDropDescription = canDropUpload
    ? t("chat.upload.dropHint")
    : t("chat.upload.dropDisabledHint");
  const fileDropLimitHint = t("chat.upload.dropLimit").replace("{max}", String(MAX_UPLOAD_FILES));
  const resolveNativeUploadConversationTarget = useCallback(
    (conversationId: string) => {
      const key = conversationId.trim();
      if (!key) return null;
      const persistedWorkdir = sidebarConversationsById.get(key)?.cwd?.trim() || "";
      const runtimeWorkdir = conversationRuntimeCacheRef.current.get(key)?.workdir?.trim() || "";
      const targetWorkdir =
        persistedWorkdir ||
        runtimeWorkdir ||
        (key === currentConversationIdRef.current ? displayedConversationWorkdir.trim() : "");
      if (!targetWorkdir) return null;
      const targetProjectPathKey = workspaceProjectPathKey(targetWorkdir);
      const project = workspaceProjects.find(
        (entry) => workspaceProjectPathKey(entry.path) === targetProjectPathKey,
      );
      return { conversationId: key, workdir: targetWorkdir, project };
    },
    [
      conversationRuntimeCacheRef,
      currentConversationIdRef,
      displayedConversationWorkdir,
      sidebarConversationsById,
      workspaceProjects,
    ],
  );
  const { importUploadZonePaths } = useUploadZoneDrop({
    isAgentMode,
    canDropUpload,
    fileDropTitle,
    activeWorkspaceProject,
    importReadableFilePaths,
    resolveConversationTarget: resolveNativeUploadConversationTarget,
    addNotify,
    setErrorMessage,
    t,
    onWorkspaceDirectoriesMounted: handleWorkspaceDirectoriesMounted,
  });
  const pickWorkspaceFolder = useCallback(
    async (targetConversationId?: string, initialWorkdir?: string) => {
      try {
        const selected = await invoke<string | null>("system_pick_folder", {
          initial_workdir:
            initialWorkdir?.trim() || displayedConversationWorkdir.trim() || undefined,
        });
        const folderPath = selected?.trim();
        if (!folderPath) return;
        await importUploadZonePaths([folderPath], targetConversationId);
      } catch (error) {
        setErrorMessage(asErrorMessage(error, t("chat.workspaceMountDropFailed")));
      }
    },
    [displayedConversationWorkdir, importUploadZonePaths, t],
  );
  // Late-bound hover focus keeps visual feedback and keyboard context aligned.
  // The final upload owner is read directly from the composer under the drop
  // point, so routing never depends on this asynchronous focus transition.
  const workbenchNativeDropHoverRef = useRef<(point: { x: number; y: number } | null) => void>(
    () => undefined,
  );
  const { isFileDropActive, isWorkspaceFolderDropActive } = useTauriFileDrop({
    importUploadZonePaths,
    importWorkspaceFolderPaths: handleDropWorkspaceFolders,
    onDropPositionChange: useCallback(
      (point: { x: number; y: number } | null) => workbenchNativeDropHoverRef.current(point),
      [],
    ),
  });

  const { handleResendFromEdit } = useEditResend({
    isSending,
    isConversationHydrating,
    isConversationHydrationFailed,
    currentConversationIdRef,
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    },
    sendActionRef,
  });

  const { branchPendingMessageId, handleBranchConversation } = useBranchConversation({
    currentConversationIdRef,
    isSending,
    isConversationHydrating,
    isConversationHydrationFailed,
    sidebarStore,
    handleSelectConversation,
    setErrorMessage,
    t,
  });

  // Prompt clarify runners (cached per conversation): ChatComposerBar is a memo component, so a
  // runner's identity must be stable across renders. A background Pane's binding is built per Pane
  // in a normal function (the Pane count varies with layout), where useMemo cannot be used, so a ref
  // cache + lazy getter is used: settings and the conversation model are resolved only when a
  // clarify call happens, so switching models mid-way takes effect on the next turn.
  const clarifySettingsRef = useRef(settings);
  clarifySettingsRef.current = settings;
  const clarifyRunnersRef = useRef(new Map<string, RunClarifyTurn>());
  const getConversationClarifyRunner = useCallback(
    (conversationId: string): RunClarifyTurn => {
      let runner = clarifyRunnersRef.current.get(conversationId);
      if (!runner) {
        // The "clarify conversation model" from settings takes priority; when unset or invalid, fall
        // back to this conversation's current model.
        const resolveClarifySelection = () =>
          resolvePromptClarifyModelSelection(clarifySettingsRef.current) ??
          resolveEffectiveChatModelSelection({
            settings: clarifySettingsRef.current,
            conversationSelectedModel:
              conversationRuntimeRegistry.getSnapshot(conversationId)?.selectedModel ?? undefined,
          });
        runner = createGuiClarifyRunner(resolveClarifySelection, () => {
          const selection = resolveClarifySelection();
          return createProviderRuntimeConfig(
            selection.provider,
            selection.model,
            clarifySettingsRef.current.chatRuntimeControls,
          );
        });
        clarifyRunnersRef.current.set(conversationId, runner);
      }
      return runner;
    },
    [conversationRuntimeRegistry],
  );

  // Full-featured binding for the pane hosting the page's current
  // conversation; it is the only pane wired to page-level composer bridging,
  // uploads, native drop and usage telemetry.
  const primaryPaneBinding: ConversationPaneBinding = {
    controller: conversationSurfaceController,
    changedFilesActions,
    checkpointRewind: {
      project: activeWorkspaceProject ?? null,
      disabled: !currentConversationId || isSending,
      onRewound: (info) => {
        // Explicit revert notification: let the user clearly know the workspace was just reverted.
        // File tool caches need no manual invalidation -- the registry and fileState are rebuilt on
        // every user turn.
        //
        // Known residual: the fileLedger in the compaction summary is persisted in history and is not
        // rebuilt per turn, so those paths are still listed after a revert. The ledger's semantics are
        // "paths that were once touched" and do not assert current content, so this is not
        // distortion; what truly goes stale is the completion status written by the model in the
        // summary body, and fixing that would require rewriting the already-persisted summary, which
        // is outside this feature's scope.
        const notice = formatCheckpointRewoundNotification(info, locale === "zh-CN");
        addNotify(notice.level, notice.message);
      },
    },
    isConversationRunning: isConversationRunning(currentConversationId),
    fileDrop: {
      active: isFileDropActive,
      canDropUpload,
      title: fileDropTitle,
      description: fileDropDescription,
      limitHint: fileDropLimitHint,
    },
    // Each conversation saves its view independently; the current Pane renders its own trajectory
    // using page-level live data.
    trajectory: {
      active: renderedConversationView === "trajectory",
      renderContent: () => (
        <ConversationTrajectorySurface
          conversationId={currentConversationId}
          host={trajectoryHost}
          transcriptItems={transcriptItems}
          liveTranscriptStore={liveTranscriptStore}
          workdir={displayedConversationWorkdir}
          hasMoreMessages={conversationState.transcript.hasMoreBefore}
          loadEarlierMessages={handleLoadEarlierHistory}
        />
      ),
    },
    transcript: {
      workspaceRoot: currentConversationWorkspaceRoot,
      gitClient: tauriGitClient,
      hasModels,
      onLoadEarlierHistory: handleLoadEarlierHistory,
      isHistorySwitching: conversationOpenState.showOverlay,
      showUsage: isAgentDevExecutionMode,
      usageContextWindow: currentModelContextWindow,
      liveTranscriptStore,
      contentWidth: settings.customSettings.chatTranscript.width,
      onContentWidthChange: handleChatTranscriptWidthChange,
      onOpenFileLink: handleOpenChatFileLink,
      onResendFromEdit: handleResendFromEdit,
      onBranchConversation:
        isConversationHydrating || isConversationHydrationFailed
          ? undefined
          : handleBranchConversation,
      branchPendingMessageId,
      onOpenSettings,
      onSuggestionSelect: handleEmptyStateSuggestion,
      suggestionsDisabled: isSuggestionTyping,
    },
    composer: {
      surface: "desktop",
      conversationId: currentConversationId,
      isUploadingFiles,
      isInputDisabled: isComposerInputDisabled,
      inputPlaceholder: composerPlaceholder,
      workdir: displayedConversationWorkdir,
      enabledSkills: enabledComposerSkills,
      mentionableConversations,
      searchMentionableConversations,
      mentionApps,
      executionMode: settings.system.executionMode,
      hasModels,
      currentModelLabel,
      modelOptions,
      selectedValue,
      chatRuntimeControls: chatRuntimeControlsForCurrentProvider,
      commandSafetyMode: settings.system.commandSafetyMode,
      onCommandSafetyModeChange: (mode) =>
        setSettings((prev) =>
          prev.system.commandSafetyMode === mode
            ? prev
            : updateSystem(prev, { commandSafetyMode: mode }),
        ),
      reasoningOptions: chatRuntimeReasoningOptions,
      thinkingAlwaysOn: chatRuntimeThinkingAlwaysOn,
      contextUsageTokensSource,
      contextWindow: currentModelContextWindow,
      contextDisplayMode: settings.customSettings.composerContextDisplay,
      gitClient: tauriGitClient,
      workspaceActivityClient: tauriWorkspaceActivityClient,
      onOpenWorktree: handleOpenWorktree,
      onWorktreeRemoved: handleWorktreeRemoved,
      onSend: handleSend,
      onComposerBusyChange: handleComposerBusyChange,
      onSelectModel: handleSelectModel,
      onSelectExecutionMode: handleSelectExecutionMode,
      onOpenSettings,
      onChatRuntimeControlsChange: handleChatRuntimeControlsChange,
      onPickReadableFiles: pickReadableFiles,
      onPickWorkspaceFolder: pickWorkspaceFolder,
      onPasteFiles: importReadableFiles,
      onLoadUploadedImagePreview: loadComposerUploadedImagePreview,
      loadHistoryPrompts: loadComposerHistoryPrompts,
      // Prompt clarify: the current conversation model runs a plain-text completion; clarifyContext
      // feeds only lightweight workspace info (branch has no ready state, so it is left empty rather
      // than pulling git for this). When the master switch is off, no runner is passed, and
      // ChatComposerBar hides the clarify button accordingly.
      runClarifyTurn: settings.customSettings.promptClarifyEnabled
        ? getConversationClarifyRunner(currentConversationId)
        : undefined,
      clarifyContext: { workdir: displayedConversationWorkdir },
      onRemovePendingUpload: removePendingUpload,
      onRunQueuedTurnNow: runQueuedTurnNow,
      onMoveQueuedTurnUp: moveQueuedTurnUp,
      onEditQueuedTurn: editQueuedTurn,
      onRemoveQueuedTurn: removeQueuedTurn,
    },
  };

  // ---- Session workbench (flag-gated) ----
  // The window-level pane tree. Invariant: the focused pane's conversation is
  // the page's current conversation; focusing another pane routes through the
  // existing conversation-select pipeline, so hydration, drafts and model
  // state keep their legacy semantics. Unfocused panes render from the
  // per-conversation runtime cache and live transcript stores.
  const initialWorkbenchProjectRef = useRef<ProjectRef>({
    projectId: `conversation:${initialConversationRef.current.conversationId}`,
    projectPathKey: `conversation:${initialConversationRef.current.conversationId}`,
  });
  const workbenchGeometryRef = useRef<WorkbenchGeometry | null>(null);
  const handleWorkbenchGeometryChange = useCallback((geometry: WorkbenchGeometry) => {
    workbenchGeometryRef.current = geometry;
  }, []);
  // Every rejected command that failed purely for lack of room gets one
  // toast, wherever it came from — drag drop, auto-dock menu, or keyboard.
  // Other codes (stale revision, duplicate surface) are internal races the
  // user never asked for and stay silent.
  const handleWorkbenchCommandError = useCallback(
    (error: WorkbenchCommandError) => {
      if (error.code === "insufficient-space") {
        addNotify("error", t("workbench.noSpaceForSplit"));
      }
    },
    [addNotify, t],
  );
  const workbench = useWindowWorkbench({
    initialConversationId: initialConversationRef.current.conversationId,
    initialProject: initialWorkbenchProjectRef.current,
    geometryRef: workbenchGeometryRef,
    // The canvas renders 6px dividers; the geometry library's default is 8.
    dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE,
    onCommandError: handleWorkbenchCommandError,
  });

  // A pane focus/drop selects its conversation asynchronously; until the
  // selection lands, syncCurrentConversation must not rebind the focused pane
  // back to the outgoing conversation.
  const workbenchPendingSelectRef = useRef<string | null>(null);

  // Right Dock follows the focused pane's project context when the pane maps
  // to a known, non-archived, non-missing workspace project. A stale
  // ProjectRef never falls back to a different project. Resolution lives in
  // resolveWorkbenchPaneProject so the invariant is model-testable.
  const activateWorkbenchPaneProject = useCallback(
    (projectPathKey?: string) => {
      const project = resolveWorkbenchPaneProject(projectPathKey, {
        workspaceProjects,
        archivedWorkspaceProjectPathKeys,
        missingWorkspaceProjectPathKeys,
      });
      if (project) activateWorkspaceProject(project);
    },
    [
      activateWorkspaceProject,
      archivedWorkspaceProjectPathKeys,
      missingWorkspaceProjectPathKeys,
      workspaceProjects,
    ],
  );

  const selectWorkbenchConversation = useCallback(
    (conversationId: string, projectPathKey?: string) => {
      if (conversationId !== currentConversationIdRef.current) {
        workbenchPendingSelectRef.current = conversationId;
        handleSelectConversation(conversationId);
      }
      activateWorkbenchPaneProject(projectPathKey);
    },
    [activateWorkbenchPaneProject, currentConversationIdRef, handleSelectConversation],
  );

  const handleWorkbenchFocusPane = useCallback(
    (paneId: string) => {
      const pane = workbench.focusPane(paneId);
      if (!pane) return;
      // Only conversation surfaces drive the page's current conversation;
      // terminal panes still steer the Right Dock's project context.
      if (pane.surface.kind !== "conversation") {
        activateWorkbenchPaneProject(surfaceProjectRef(pane.surface)?.projectPathKey);
        return;
      }
      selectWorkbenchConversation(pane.surface.conversationId, pane.surface.project.projectPathKey);
    },
    [activateWorkbenchPaneProject, selectWorkbenchConversation, workbench],
  );

  const focusWorkbenchConversationPane = useCallback(
    (conversationId: string) => {
      const paneId = workbench.paneIdForConversation(conversationId);
      if (paneId) handleWorkbenchFocusPane(paneId);
    },
    [handleWorkbenchFocusPane, workbench],
  );

  const handleWorkbenchClosePane = useCallback(
    (paneId: string) => {
      const pane = workbench.layoutRef.current.panes[paneId];
      const result = workbench.closePane(paneId);
      // Closing a Pane ends this conversation-view projection. Cleanup happens only after the layout
      // confirms removal succeeded, so a failed close does not force the trajectory view still on the
      // canvas back to the conversation.
      if (pane?.surface.kind === "conversation" && !workbench.layoutRef.current.panes[paneId]) {
        setConversationView(pane.surface.conversationId, "conversation");
      }
      // Closing a terminal Pane = terminating the terminal (no longer Detach back to the Right Dock):
      // the process is closed first by terminalPaneClose, and here the binding is reclaimed after the
      // layout removes it; dragging it in again uses a brand-new surface identity. The Pane is closed
      // before the binding is deleted, so within the same event batch the host is already unmounted
      // and an empty binding is not misjudged as pending creation.
      if (pane?.surface.kind === "localTerminal" || pane?.surface.kind === "sshTerminal") {
        terminalPaneBindings.delete(pane.surface.surfaceId);
      }
      // Closing a project-tool Pane also closes that tool in the dock: after the lease is released,
      // the dock no longer bounces the tab back. Settings are written only after the layout confirms
      // removal; a failed close does not touch dock state.
      if (
        pane &&
        isProjectToolSurface(pane.surface) &&
        !workbench.layoutRef.current.panes[paneId]
      ) {
        const { kind, project } = pane.surface;
        setSettings((prev) => releaseProjectToolFromDock(prev, kind, project.projectPathKey));
      }
      if (result.closedFocused && result.nextConversationId) {
        const nextPaneId = workbench.paneIdForConversation(result.nextConversationId);
        const nextPane = nextPaneId ? workbench.layoutRef.current.panes[nextPaneId] : null;
        selectWorkbenchConversation(
          result.nextConversationId,
          nextPane ? surfaceProjectRef(nextPane.surface)?.projectPathKey : undefined,
        );
      }
    },
    [selectWorkbenchConversation, setConversationView, setSettings, workbench],
  );

  // Pane's × / Meta+Alt+W: a terminal Pane first terminates the terminal (a running conversation
  // shows a red-bar confirmation inside the Pane), and the closed event collapses the Pane; other
  // Panes close directly.
  const terminalPaneClose = useTerminalPaneCloseFlow({
    client: tauriTerminalClient,
    sessions: terminalSessions,
    bindings: terminalPaneBindings,
    layout: workbench.layout,
    closePane: handleWorkbenchClosePane,
    onError: (message) => addNotify("error", message),
  });
  const requestWorkbenchClosePane = terminalPaneClose.requestClosePane;

  const workbenchProjectForConversation = useCallback(
    (item: SidebarConversation): ProjectRef => {
      const cwd = item.cwd?.trim() || "";
      const project = cwd
        ? workspaceProjects.find(
            (entry) => workspaceProjectPathKey(entry.path) === workspaceProjectPathKey(cwd),
          )
        : undefined;
      return {
        projectId: project?.id ?? `conversation:${item.id}`,
        projectPathKey: cwd ? workspaceProjectPathKey(cwd) : `conversation:${item.id}`,
      };
    },
    [workspaceProjects],
  );

  // Workspace drops await the exact draft id returned by the legacy creation
  // path. The sync effect only pauses for that identified draft, so it cannot
  // consume the target on an unrelated current-conversation update.
  const workspaceDropSequenceRef = useRef(0);
  const pendingWorkspaceDropRef = useRef<PendingWorkspaceDropOperation | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The mutable runtime cache ref intentionally supplies the latest draft workdir without changing the drag handler identity.
  const handleWorkbenchDropCommit = useCallback(
    (commit: WorkbenchDropCommit) => {
      // Stale layout revision (focus/structure changed mid-drag): cancel the
      // transaction instead of replaying stale geometry.
      if (commit.revision !== workbench.layoutRef.current.revision) {
        addNotify("error", t("workbench.dropStateChanged"));
        return;
      }
      const { payload, target } = commit;
      if (payload.kind === "workspace") {
        if (target.kind === "pane-center") return;
        const pathKey = workspaceProjectPathKey(payload.projectPath);
        if (archivedWorkspaceProjectPathKeys.has(pathKey)) return;
        const project = workspaceProjects.find(
          (entry) => workspaceProjectPathKey(entry.path) === pathKey,
        );
        if (!project) return;
        const operationId = workspaceDropSequenceRef.current + 1;
        workspaceDropSequenceRef.current = operationId;
        pendingWorkspaceDropRef.current = {
          operationId,
          projectPathKey: pathKey,
          conversationId: null,
        };
        void commitWorkspaceDropConversation({
          revision: commit.revision,
          target,
          project: { projectId: project.id, projectPathKey: pathKey },
          startConversation: () => handleNewConversationForProject(project),
          onConversationCreated: (conversationId) => {
            const pending = pendingWorkspaceDropRef.current;
            if (pending?.operationId === operationId) {
              pendingWorkspaceDropRef.current = { ...pending, conversationId };
            }
          },
          currentRevision: () => workbench.layoutRef.current.revision,
          conversationMatchesProject: (conversationId) => {
            const draftWorkdir =
              conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
            return Boolean(draftWorkdir) && workspaceProjectPathKey(draftWorkdir) === pathKey;
          },
          paneIdForConversation: workbench.paneIdForConversation,
          openConversation: workbench.openConversation,
        })
          .then((result) => {
            if (pendingWorkspaceDropRef.current?.operationId === operationId) {
              pendingWorkspaceDropRef.current = null;
            }
            if (result.kind === "opened") return;
            if (result.kind === "already-open") {
              const paneId = workbench.paneIdForConversation(result.conversationId);
              if (paneId) handleWorkbenchFocusPane(paneId);
              return;
            }
            // not-created/stale/identity-mismatch/rejected: a conversation switch deferred during
            // the pause window must be resynced once, and the project identity uses the current
            // conversation's own resolution -- identity-mismatch is defined as the draft workdir not
            // belonging to the dragged-in project, and the dragged-in project's ProjectRef must never
            // be force-bound to the focused Pane (the checkpoint authorization root and file drop
            // scope would both become misaligned).
            workbench.syncCurrentConversation(
              currentConversationIdRef.current,
              conversationSurfaceProject,
            );
            if (result.kind === "stale" || result.kind === "identity-mismatch") {
              addNotify("error", t("workbench.dropStateChanged"));
            }
          })
          .catch((error) => {
            if (pendingWorkspaceDropRef.current?.operationId === operationId) {
              pendingWorkspaceDropRef.current = null;
            }
            workbench.syncCurrentConversation(
              currentConversationIdRef.current,
              conversationSurfaceProject,
            );
            addNotify("error", asErrorMessage(error, t("workbench.workspaceDropFailed")));
          });
        return;
      }
      if (payload.kind === "conversation") {
        const existingPaneId = workbench.paneIdForConversation(payload.conversationId);
        if (target.kind === "pane-center") {
          // Normalized by the drag session: pane-center only survives for the
          // conversation's own pane, meaning "focus me".
          if (existingPaneId && target.paneId === existingPaneId) {
            handleWorkbenchFocusPane(existingPaneId);
            addNotify("success", t("workbench.conversationAlreadyOpen"));
          }
          return;
        }
        if (existingPaneId) {
          if (target.kind === "canvas-empty") return;
          if (workbench.movePane(existingPaneId, target)) {
            selectWorkbenchConversation(payload.conversationId, payload.project.projectPathKey);
          }
          return;
        }
        const opened = workbench.openConversation(
          { conversationId: payload.conversationId, project: payload.project },
          target,
        );
        if (opened) {
          selectWorkbenchConversation(payload.conversationId, payload.project.projectPathKey);
        }
        return;
      }
      if (payload.kind === "terminalSession" || payload.kind === "newTerminal") {
        commitTerminalDrop(payload, target, {
          layout: workbench.layoutRef.current,
          sessions: terminalSessionsRef.current,
          lease: terminalPaneLease,
          bindings: terminalPaneBindings,
          resolveProjectPath: (project) =>
            workspaceProjects.find((entry) => entry.id === project.projectId)?.path ??
            workspaceProjects.find(
              (entry) => workspaceProjectPathKey(entry.path) === project.projectPathKey,
            )?.path ??
            null,
          createSurfaceId: createTerminalSurfaceId,
          authorizeAutoLaunch: terminalPaneAutoLaunch.authorize,
          openTerminalSurface: workbench.openTerminalSurface,
          movePane: workbench.movePane,
          focusPane: handleWorkbenchFocusPane,
        });
        return;
      }
      if (payload.kind === "projectTool") {
        commitProjectToolDrop(payload, target, {
          layout: workbench.layoutRef.current,
          openProjectToolSurface: workbench.openProjectToolSurface,
          movePane: workbench.movePane,
          focusPane: handleWorkbenchFocusPane,
        });
        return;
      }
      // Moving an existing pane by its chrome drag handle.
      if (target.kind === "canvas-empty") return;
      if (target.kind === "pane-center" && target.paneId === payload.paneId) return;
      if (workbench.movePane(payload.paneId, target)) {
        const pane = workbench.layoutRef.current.panes[payload.paneId];
        // Only conversation panes drive the page's current conversation.
        if (pane?.surface.kind === "conversation") {
          selectWorkbenchConversation(
            pane.surface.conversationId,
            pane.surface.project.projectPathKey,
          );
        }
      }
    },
    [
      archivedWorkspaceProjectPathKeys,
      addNotify,
      conversationSurfaceProject,
      handleNewConversationForProject,
      handleWorkbenchFocusPane,
      selectWorkbenchConversation,
      t,
      workbench,
      workspaceProjects,
    ],
  );

  const {
    dragState: workbenchDragState,
    beginDrag: beginWorkbenchDrag,
    dragGhostRef: workbenchDragGhostRef,
  } = useWorkbenchDragSession({
    enabled: sessionWorkbench.enabled,
    layoutRef: workbench.layoutRef,
    geometryRef: workbenchGeometryRef,
    onCommit: handleWorkbenchDropCommit,
    onUnavailable: (reason: WorkbenchDragUnavailableReason) => {
      addNotify(
        "error",
        t(
          reason === "geometry-unavailable"
            ? "workbench.dropStateChanged"
            : "workbench.noSpaceForSplit",
        ),
      );
    },
  });

  const handleConversationWorkbenchDragIntent = useCallback(
    (
      item: SidebarConversation,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      beginWorkbenchDrag(
        {
          kind: "conversation",
          conversationId: item.id,
          project: workbenchProjectForConversation(item),
          title: item.title,
          cwd: item.cwd,
          updatedAt: item.updatedAt,
        },
        event,
      );
    },
    [beginWorkbenchDrag, workbenchProjectForConversation],
  );

  // Dragging a Right Dock terminal tab out: an existing conversation enters the canvas. The dock's
  // tabs list only local conversations; SSH conversations are dragged out from the workspace
  // overlay's shell tab (handleSshTerminalTabDragIntent).
  const handleTerminalTabWorkbenchDragIntent = useCallback(
    (
      session: TerminalSession,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      const projectPathKey = session.projectPathKey || workspaceProjectPathKey(session.cwd);
      const project = workspaceProjects.find(
        (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
      );
      beginWorkbenchDrag(
        {
          kind: "terminalSession",
          sessionId: session.id,
          project: {
            projectId: project?.id ?? `terminal:${session.id}`,
            projectPathKey,
          },
          title: session.title || session.shell || "Terminal",
        },
        event,
      );
    },
    [beginWorkbenchDrag, workspaceProjects],
  );

  // Dragging out the SSH overlay's shell tab uses the same payload path as the dock tab; on drop,
  // terminalSurfaceForSession builds an sshTerminal surface from session.ssh.hostId, and once the
  // lease is established the overlay automatically shows an "already open on the canvas" placeholder.
  const handleSshTerminalTabDragIntent = handleTerminalTabWorkbenchDragIntent;

  // Dragging out the empty-state "New terminal" button: the drop target creates a terminal Pane
  // (geometry first; the PTY is created asynchronously by the host).
  const handleNewTerminalWorkbenchDragIntent = useCallback(
    (event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    }) => {
      if (!terminalProjectPath) return;
      const project = workspaceProjects.find(
        (entry) => workspaceProjectPathKey(entry.path) === terminalProjectPathKey,
      );
      beginWorkbenchDrag(
        {
          kind: "newTerminal",
          project: {
            projectId: project?.id ?? `project:${terminalProjectPathKey}`,
            projectPathKey: terminalProjectPathKey,
          },
          title: t("projectTools.newTerminal"),
        },
        event,
      );
    },
    [beginWorkbenchDrag, t, terminalProjectPath, terminalProjectPathKey, workspaceProjects],
  );

  // The Right Dock's current project: when a project tool (file tree/review/tunneling/SSH/background
  // tasks) is dragged out or "opened in split view", the Pane binds to this ProjectRef.
  const dockToolProjectRef = useCallback((): ProjectRef | null => {
    if (!terminalProjectPathKey) return null;
    const project = workspaceProjects.find(
      (entry) => workspaceProjectPathKey(entry.path) === terminalProjectPathKey,
    );
    return {
      projectId: project?.id ?? `project:${terminalProjectPathKey}`,
      projectPathKey: terminalProjectPathKey,
    };
  }, [terminalProjectPathKey, workspaceProjects]);

  const handleToolWorkbenchDragIntent = useCallback(
    (
      tool: ProjectToolSurfaceKind,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      const project = dockToolProjectRef();
      if (!project) return;
      beginWorkbenchDrag(
        { kind: "projectTool", tool, project, title: t(projectToolSurfaceTitleKey(tool)) },
        event,
      );
    },
    [beginWorkbenchDrag, dockToolProjectRef, t],
  );

  // Sessions leased by a canvas Pane: the "go to Pane" focus path from the overlay/placeholder.
  const focusWorkbenchTerminalPane = useCallback(
    (sessionId: string) => {
      const paneId = terminalPaneLease.paneIdFor(sessionId);
      if (paneId && workbench.layoutRef.current.panes[paneId]) {
        handleWorkbenchFocusPane(paneId);
      }
    },
    [handleWorkbenchFocusPane, workbench],
  );

  // When a conversation is closed (`closed` event: Pane × termination, dock close, or
  // close_project), the Pane holding it closes too. Without this link, the host would treat "the
  // bound conversation disappeared" as a stale binding during recovery and revive a new PTY per
  // launchSpec, which shows up as a dock terminal that "can't be closed". Lookup is by binding
  // rather than lease, covering the connecting window before the host acquires the lease.
  useEffect(() => {
    if (!sessionWorkbench.enabled) return;
    return tauriTerminalClient.subscribe((event) => {
      if (event.kind !== "closed") return;
      // The app-exit close_all is not the user closing a single terminal: keep the terminal Panes in
      // the layout, to be restored per launchSpec after restart.
      if (terminalAppExitGuard.isExiting()) return;
      const closedSessionId = event.sessionId?.trim() || event.session?.id || "";
      if (!closedSessionId) return;
      const paneId = findTerminalPaneForSession(closedSessionId, {
        bindings: terminalPaneBindings,
        layout: workbench.layoutRef.current,
      });
      if (paneId) handleWorkbenchClosePane(paneId);
    });
  }, [handleWorkbenchClosePane, workbench]);

  const handleProjectWorkbenchDragIntent = useCallback(
    (
      project: WorkspaceProject,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      beginWorkbenchDrag(
        {
          kind: "workspace",
          projectId: project.id,
          projectPath: project.path,
          title: project.name,
        },
        event,
      );
    },
    [beginWorkbenchDrag],
  );

  // Menu alternative to dragging: dock beside the focused pane. Deterministic
  // auto-dock with the same hard minimum-size checks as drops: right first
  // (bottom first on narrow canvases), then the other axis, explicit rejection
  // when no legal space remains.
  const resolveWorkbenchAutoDockTarget = useCallback(() => {
    const layout = workbench.layoutRef.current;
    if (!layout.focusedPaneId) return { kind: "canvas-empty" } as const;
    const geometry = workbenchGeometryRef.current;
    const focusedRect = geometry?.panes.find((pane) => pane.paneId === layout.focusedPaneId)?.rect;
    if (!geometry || !focusedRect) return null;
    const preferVertical = geometry.canvas.width < 680;
    const edges = preferVertical ? (["bottom", "right"] as const) : (["right", "bottom"] as const);
    for (const edge of edges) {
      if (canSplitRectAtEdge(focusedRect, edge)) {
        return { kind: "pane-edge", paneId: layout.focusedPaneId, edge } as const;
      }
    }
    return null;
  }, [workbench]);

  const handleOpenConversationInSplit = useCallback(
    (item: SidebarConversation) => {
      const existingPaneId = workbench.paneIdForConversation(item.id);
      if (existingPaneId) {
        handleWorkbenchFocusPane(existingPaneId);
        return;
      }
      const target = resolveWorkbenchAutoDockTarget();
      if (!target) {
        addNotify("error", t("workbench.noSpaceForSplit"));
        return;
      }
      const project = workbenchProjectForConversation(item);
      const opened = workbench.openConversation({ conversationId: item.id, project }, target);
      if (opened) {
        selectWorkbenchConversation(item.id, project.projectPathKey);
      }
    },
    [
      addNotify,
      handleWorkbenchFocusPane,
      resolveWorkbenchAutoDockTarget,
      selectWorkbenchConversation,
      t,
      workbench,
      workbenchProjectForConversation,
    ],
  );

  // Keyboard/menu entry for the same commit path: a terminal tab can enter the workbench without
  // dragging. An already-leased conversation goes through commitTerminalDrop's own "move existing
  // Pane" path and does not open a second Pane.
  const handleOpenTerminalInWorkbenchSplit = useCallback(
    (session: TerminalSession) => {
      const target = resolveWorkbenchAutoDockTarget();
      if (!target) {
        addNotify("error", t("workbench.noSpaceForSplit"));
        return;
      }
      const projectPathKey = session.projectPathKey || workspaceProjectPathKey(session.cwd);
      const project = workspaceProjects.find(
        (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
      );
      commitTerminalDrop(
        {
          kind: "terminalSession",
          sessionId: session.id,
          project: {
            projectId: project?.id ?? `terminal:${session.id}`,
            projectPathKey,
          },
          title: session.title || session.shell || "Terminal",
        },
        target,
        {
          layout: workbench.layoutRef.current,
          sessions: terminalSessionsRef.current,
          lease: terminalPaneLease,
          bindings: terminalPaneBindings,
          resolveProjectPath: (ref) =>
            workspaceProjects.find((entry) => entry.id === ref.projectId)?.path ??
            workspaceProjects.find(
              (entry) => workspaceProjectPathKey(entry.path) === ref.projectPathKey,
            )?.path ??
            null,
          createSurfaceId: createTerminalSurfaceId,
          authorizeAutoLaunch: terminalPaneAutoLaunch.authorize,
          openTerminalSurface: workbench.openTerminalSurface,
          movePane: workbench.movePane,
          focusPane: handleWorkbenchFocusPane,
        },
      );
    },
    [
      addNotify,
      handleWorkbenchFocusPane,
      resolveWorkbenchAutoDockTarget,
      t,
      workbench,
      workspaceProjects,
    ],
  );

  const handleOpenToolInWorkbenchSplit = useCallback(
    (tool: ProjectToolSurfaceKind) => {
      const project = dockToolProjectRef();
      if (!project) return;
      openProjectToolInSplit(tool, project, {
        layout: workbench.layoutRef.current,
        openProjectToolSurface: workbench.openProjectToolSurface,
        focusPane: handleWorkbenchFocusPane,
        resolveAutoDockTarget: resolveWorkbenchAutoDockTarget,
        onNoSpace: () => addNotify("error", t("workbench.noSpaceForSplit")),
      });
    },
    [
      addNotify,
      dockToolProjectRef,
      handleWorkbenchFocusPane,
      resolveWorkbenchAutoDockTarget,
      t,
      workbench,
    ],
  );

  const handleOpenNewTerminalInWorkbenchSplit = useCallback(() => {
    const target = resolveWorkbenchAutoDockTarget();
    if (!target) {
      addNotify("error", t("workbench.noSpaceForSplit"));
      return;
    }
    if (!terminalProjectPath) return;
    const project = workspaceProjects.find(
      (entry) => workspaceProjectPathKey(entry.path) === terminalProjectPathKey,
    );
    commitTerminalDrop(
      {
        kind: "newTerminal",
        project: {
          projectId: project?.id ?? `project:${terminalProjectPathKey}`,
          projectPathKey: terminalProjectPathKey,
        },
        title: t("projectTools.newTerminal"),
      },
      target,
      {
        layout: workbench.layoutRef.current,
        sessions: terminalSessionsRef.current,
        lease: terminalPaneLease,
        bindings: terminalPaneBindings,
        resolveProjectPath: (ref) =>
          workspaceProjects.find((entry) => entry.id === ref.projectId)?.path ??
          workspaceProjects.find(
            (entry) => workspaceProjectPathKey(entry.path) === ref.projectPathKey,
          )?.path ??
          null,
        createSurfaceId: createTerminalSurfaceId,
        authorizeAutoLaunch: terminalPaneAutoLaunch.authorize,
        openTerminalSurface: workbench.openTerminalSurface,
        movePane: workbench.movePane,
        focusPane: handleWorkbenchFocusPane,
      },
    );
  }, [
    addNotify,
    handleWorkbenchFocusPane,
    resolveWorkbenchAutoDockTarget,
    t,
    terminalProjectPath,
    terminalProjectPathKey,
    workbench,
    workspaceProjects,
  ]);

  // Native file drag hover: focus the conversation pane under the cursor for
  // visual and keyboard continuity. Final attachment ownership is carried by
  // the composer's data-file-upload-conversation-id marker at drop time.
  const lastNativeDropHoverPaneRef = useRef<string | null>(null);
  workbenchNativeDropHoverRef.current = (point) => {
    if (!sessionWorkbench.enabled || !point) {
      lastNativeDropHoverPaneRef.current = null;
      return;
    }
    const geometry = workbenchGeometryRef.current;
    const canvasElement = document.querySelector("[data-workbench-canvas]");
    if (!geometry || !canvasElement) return;
    const canvasRect = canvasElement.getBoundingClientRect();
    const target = hitTestWorkbenchDrop(
      geometry,
      point.x - canvasRect.left,
      point.y - canvasRect.top,
    );
    const paneId =
      target && (target.kind === "pane-center" || target.kind === "pane-edge")
        ? target.paneId
        : null;
    if (!paneId || paneId === lastNativeDropHoverPaneRef.current) return;
    lastNativeDropHoverPaneRef.current = paneId;
    if (workbench.layoutRef.current.focusedPaneId !== paneId) {
      handleWorkbenchFocusPane(paneId);
    }
  };

  // Keep the focused pane bound to the page's current conversation (the
  // legacy "conversation swaps beneath the stable pane" behaviour), unless a
  // pane-initiated selection is still in flight.
  const lastWorkbenchSyncedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionWorkbench.enabled) return;
    const pending = workbenchPendingSelectRef.current;
    if (
      pending &&
      pending !== currentConversationId &&
      lastWorkbenchSyncedConversationRef.current === currentConversationId
    ) {
      return;
    }
    workbenchPendingSelectRef.current = null;
    // Workspace drop: keep normal sync paused for the whole operation, not
    // merely its first render. Once startConversation resolves, the exact
    // draft id replaces the temporary project-key match.
    const pendingWorkspaceDrop = pendingWorkspaceDropRef.current;
    const draftWorkdir =
      conversationRuntimeCacheRef.current.get(currentConversationId)?.workdir?.trim() || "";
    if (
      shouldDeferWorkspaceDropConversationSync(
        pendingWorkspaceDrop,
        currentConversationId,
        workspaceProjectPathKey(draftWorkdir),
      )
    ) {
      return;
    }
    lastWorkbenchSyncedConversationRef.current = currentConversationId;
    workbench.syncCurrentConversation(currentConversationId, conversationSurfaceProject);
  }, [currentConversationId, conversationSurfaceProject, conversationRuntimeCacheRef, workbench]);

  // Close panes whose conversation was deleted from history (the focused
  // pane already falls back through the legacy new-conversation path).
  useEffect(() => {
    if (!sessionWorkbench.enabled) return;
    const layout = workbench.layoutRef.current;
    for (const pane of Object.values(layout.panes)) {
      if (pane.surface.kind !== "conversation") continue;
      const conversationId = pane.surface.conversationId;
      if (conversationId === currentConversationId) continue;
      const item = sidebarConversationsById.get(conversationId);
      if (!item && conversationPersistenceCursorRef.current.has(conversationId)) {
        handleWorkbenchClosePane(pane.paneId);
      }
    }
  }, [
    conversationPersistenceCursorRef,
    currentConversationId,
    handleWorkbenchClosePane,
    sidebarConversationsById,
    workbench,
  ]);

  // Keyboard equivalents for workbench pane commands, all on Meta/Ctrl+Alt:
  // Arrow focuses the adjacent pane, Shift+Arrow moves the focused pane there,
  // W closes it, and =/+ equalizes its parent split. Every command needs at
  // least two panes; with one pane the workbench has nothing to navigate.
  useEffect(() => {
    if (!sessionWorkbench.enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const layout = workbench.layoutRef.current;
      const focusedPaneId = layout.focusedPaneId;
      if (!focusedPaneId || Object.keys(layout.panes).length < 2) return;

      const direction =
        event.key === "ArrowLeft"
          ? ("left" as const)
          : event.key === "ArrowRight"
            ? ("right" as const)
            : event.key === "ArrowUp"
              ? ("top" as const)
              : event.key === "ArrowDown"
                ? ("bottom" as const)
                : null;
      if (direction) {
        const geometry = workbenchGeometryRef.current;
        if (!geometry) return;
        const nextPaneId = findAdjacentPaneId(geometry, focusedPaneId, direction);
        if (!nextPaneId) return;
        event.preventDefault();
        // Shift grafts the focused pane onto the neighbour's far edge, so the
        // pane ends up exactly where a plain focus move would have gone.
        if (event.shiftKey) {
          workbench.movePane(focusedPaneId, {
            kind: "pane-edge",
            paneId: nextPaneId,
            edge: direction,
          });
          return;
        }
        handleWorkbenchFocusPane(nextPaneId);
        return;
      }

      if (event.shiftKey) return;
      if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        requestWorkbenchClosePane(focusedPaneId);
        return;
      }
      if (event.key === "=" || event.key === "+") {
        const splitId = findParentSplitId(layout, focusedPaneId);
        if (!splitId) return;
        event.preventDefault();
        workbench.equalizeSplit(splitId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleWorkbenchFocusPane, requestWorkbenchClosePane, workbench]);

  // Background pane controllers (conversations visible in unfocused panes).
  const backgroundControllersRef = useRef(new Map<string, ConversationSurfaceController>());
  const getBackgroundConversationController = useCallback(
    (conversationId: string, project: ProjectRef): ConversationSurfaceController => {
      const existing = backgroundControllersRef.current.get(conversationId);
      if (existing) return existing;
      const controller = createConversationSurfaceController({
        conversationId,
        project,
        registry: conversationRuntimeRegistry,
        actions: conversationControllerActions,
      });
      backgroundControllersRef.current.set(conversationId, controller);
      return controller;
    },
    [conversationControllerActions, conversationRuntimeRegistry],
  );
  useEffect(() => {
    if (!sessionWorkbench.enabled) return;
    const keep = new Set(
      Object.values(workbench.layout.panes).flatMap((pane) =>
        pane.surface.kind === "conversation" ? [pane.surface.conversationId] : [],
      ),
    );
    for (const [conversationId, controller] of backgroundControllersRef.current) {
      if (!keep.has(conversationId)) {
        controller.dispose();
        backgroundControllersRef.current.delete(conversationId);
      }
    }
  }, [workbench.layout]);
  // Layout reconciliation: the terminal drop transaction reserves the lease synchronously before the
  // host mounts; if the Pane is closed before the host takes over release, the lease would hang
  // forever (hiding that terminal in the dock permanently). A lease held by the host is released in
  // its unmount cleanup before this effect and is unaffected.
  useEffect(() => {
    releaseOrphanTerminalPaneLeases(terminalPaneLease, workbench.layout);
  }, [workbench.layout]);
  useEffect(
    () => () => {
      for (const controller of backgroundControllersRef.current.values()) {
        controller.dispose();
      }
      backgroundControllersRef.current.clear();
    },
    [],
  );

  // Read-and-interact binding for panes not hosting the current conversation.
  // Attach/send/stop/chip-remove route by this pane's conversationId. Other
  // interactions that still go through page-level current-conversation
  // machinery focus the pane first.
  const buildBackgroundPaneBinding = (
    surface: ConversationWorkbenchSurface,
  ): ConversationPaneBinding => {
    const conversationId = surface.conversationId;
    const controller = getBackgroundConversationController(conversationId, surface.project);
    const runtimeEntry = conversationRuntimeRegistry.getSnapshot(conversationId);
    const historyItem = sidebarConversationsById.get(conversationId);
    const workspaceRoot = historyItem?.cwd?.trim() || runtimeEntry?.workdir?.trim() || undefined;
    const paneSelectedModel = resolveActiveModelSelection(
      settings,
      runtimeEntry?.selectedModel ?? undefined,
    );
    const paneSelectedValue = paneSelectedModel
      ? toModelValue(paneSelectedModel.customProviderId, paneSelectedModel.model)
      : undefined;
    const paneProvider = paneSelectedModel
      ? settings.customProviders.find((entry) => entry.id === paneSelectedModel.customProviderId)
      : undefined;
    const paneRuntimeControls = normalizeChatRuntimeControlsForProvider(
      settings.chatRuntimeControls,
      {
        providerId: paneProvider?.type,
        requestFormat: paneProvider?.requestFormat,
        modelId: paneSelectedModel?.model,
      },
    );
    const paneReasoningOptions = getChatRuntimeReasoningLevelsForProvider({
      providerId: paneProvider?.type,
      requestFormat: paneProvider?.requestFormat,
      modelId: paneSelectedModel?.model,
    });
    const paneThinkingAlwaysOn = isThinkingAlwaysOnForModel(
      paneProvider?.type ?? "claude_code",
      paneSelectedModel?.model,
    );
    const paneModelLabel = (() => {
      if (!paneSelectedModel) return t("chat.selectModel");
      const option = modelOptions.find((entry) => entry.value === paneSelectedValue);
      return option ? `${option.providerName} / ${option.model}` : paneSelectedModel.model;
    })();
    const paneContextWindow = (() => {
      if (!paneSelectedModel) return undefined;
      const provider = settings.customProviders.find(
        (entry) => entry.id === paneSelectedModel.customProviderId,
      );
      if (!provider) return undefined;
      return findProviderModelConfig(provider, paneSelectedModel.model).contextWindow;
    })();
    const paneIsRunning = isConversationRunning(conversationId) || runtimeEntry?.isSending === true;
    const paneContextUsageTokensSource = createContextUsageTokensSource({
      isRunning: paneIsRunning || runtimeEntry?.compactionStatus?.phase === "running",
      conversationId,
      transcriptItems: runtimeEntry?.state.transcript.items ?? [],
      liveTranscriptStore: getConversationLiveTranscriptStore(conversationId),
      getCompactionController,
    });
    const paneTrajectoryActive = viewForConversation(conversationId) === "trajectory";
    const focusGuard = <Args extends unknown[]>(fn: (...args: Args) => void) => {
      return (...args: Args) => {
        if (currentConversationIdRef.current !== conversationId) {
          focusWorkbenchConversationPane(conversationId);
          return;
        }
        fn(...args);
      };
    };
    // Send routes by this pane's conversationId (mirroring Stop), never by the
    // page's focused conversation: a busy conversation enqueues the turn, an
    // idle one sends immediately. Uploads come from the pane conversation's
    // own store — the focused pane's pending files must never ride along.
    const paneSendDraft = async (draft: MentionComposerDraft) => {
      const uploads = conversationRuntimeRegistry.uploads.getSnapshot(conversationId).slice();
      const runtime = conversationRuntimeRegistry.getSnapshot(conversationId);
      if (isConversationRunning(conversationId) || runtime?.isSending) {
        return enqueueComposerTurnForConversation({
          conversationId,
          draft,
          uploadedFiles: uploads,
        });
      }
      const accepted = await sendActionRef.current({
        conversationIdOverride: conversationId,
        composerDraftOverride: draft,
        uploadedFilesOverride: uploads,
      });
      if (accepted) {
        conversationRuntimeRegistry.uploads.set(conversationId, []);
      }
      return accepted;
    };
    return {
      controller,
      changedFilesActions,
      // Revert is a destructive workspace write and may only be initiated from the focused Pane
      // (once focused, it goes through primaryPaneBinding's full authorization chain); background
      // Panes are always disabled.
      checkpointRewind: {
        project: null,
        disabled: true,
        onRewound: () => undefined,
      },
      isConversationRunning: isConversationRunning(conversationId),
      // Native file drop routes only to the focused pane's composer.
      fileDrop: {
        active: false,
        canDropUpload: false,
        title: "",
        description: "",
        limitHint: "",
      },
      trajectory: {
        active: paneTrajectoryActive,
        renderContent: (snapshot) => (
          <ConversationTrajectorySurface
            conversationId={conversationId}
            host={trajectoryHost}
            transcriptItems={snapshot.runtime?.state.transcript.items ?? []}
            liveTranscriptStore={getConversationLiveTranscriptStore(conversationId)}
            workdir={workspaceRoot}
            hasMoreMessages={snapshot.runtime?.state.transcript.hasMoreBefore ?? false}
            loadEarlierMessages={() => loadEarlierHistoryActionRef.current(conversationId)}
          />
        ),
      },
      transcript: {
        workspaceRoot,
        gitClient: tauriGitClient,
        hasModels,
        onLoadEarlierHistory: () => loadEarlierHistoryActionRef.current(conversationId),
        isHistorySwitching: false,
        showUsage: isAgentDevExecutionMode,
        usageContextWindow: paneContextWindow,
        liveTranscriptStore: getConversationLiveTranscriptStore(conversationId),
        contentWidth: settings.customSettings.chatTranscript.width,
        onContentWidthChange: handleChatTranscriptWidthChange,
        onOpenFileLink: handleOpenChatFileLink,
        onResendFromEdit: focusGuard(handleResendFromEdit),
        onBranchConversation: undefined,
        branchPendingMessageId: undefined,
        onOpenSettings,
        onSuggestionSelect: focusGuard(handleEmptyStateSuggestion),
        suggestionsDisabled: isSuggestionTyping,
      },
      composer: {
        surface: "desktop",
        conversationId,
        isUploadingFiles: false,
        isInputDisabled: false,
        inputPlaceholder: t("chat.inputHint"),
        workdir: workspaceRoot ?? "",
        enabledSkills: enabledComposerSkills,
        mentionableConversations,
        searchMentionableConversations: (query) =>
          searchMentionConversations({
            query,
            currentConversationId: conversationId,
            currentWorkdir: workspaceRoot ?? "",
          }),
        mentionApps,
        executionMode: settings.system.executionMode,
        hasModels,
        currentModelLabel: paneModelLabel,
        modelOptions,
        selectedValue: paneSelectedValue,
        chatRuntimeControls: paneRuntimeControls,
        commandSafetyMode: settings.system.commandSafetyMode,
        onCommandSafetyModeChange: (mode) =>
          setSettings((prev) =>
            prev.system.commandSafetyMode === mode
              ? prev
              : updateSystem(prev, { commandSafetyMode: mode }),
          ),
        reasoningOptions: paneReasoningOptions,
        thinkingAlwaysOn: paneThinkingAlwaysOn,
        contextUsageTokensSource: paneContextUsageTokensSource,
        contextWindow: paneContextWindow,
        contextDisplayMode: settings.customSettings.composerContextDisplay,
        gitClient: tauriGitClient,
        workspaceActivityClient: tauriWorkspaceActivityClient,
        onOpenWorktree: handleOpenWorktree,
        onWorktreeRemoved: handleWorktreeRemoved,
        // Overridden by ConversationPaneHost with a pane-scoped handler built
        // from sendDraft (below); only the host holds this pane's composer.
        onSend: () => undefined,
        onComposerBusyChange: () => undefined,
        onSelectModel: focusGuard(handleSelectModel),
        onSelectExecutionMode: handleSelectExecutionMode,
        onOpenSettings,
        onChatRuntimeControlsChange: focusGuard(handleChatRuntimeControlsChange),
        onPickReadableFiles: focusGuard(pickReadableFiles),
        onPickWorkspaceFolder: focusGuard(() => {
          void pickWorkspaceFolder(conversationId, workspaceRoot ?? "");
        }),
        // Paste must not wait for pane focus: Cmd+Alt+Arrow / Tab can leave
        // the caret in this composer while currentConversationIdRef is still
        // the focused pane. Same explicit target as native drop.
        onPasteFiles: (files) => {
          void importReadableFiles(files, {
            conversationId,
            workdir: workspaceRoot ?? "",
          });
        },
        onLoadUploadedImagePreview: loadComposerUploadedImagePreview,
        loadHistoryPrompts: loadComposerHistoryPrompts,
        // A background Pane's clarify runner likewise resolves the model from this Pane's conversation
        // (see getConversationClarifyRunner's lazy getter); the master switch shares a source with the
        // main Pane.
        runClarifyTurn: settings.customSettings.promptClarifyEnabled
          ? getConversationClarifyRunner(conversationId)
          : undefined,
        // Consistent with the main Pane: clarifyContext feeds only this Pane conversation's
        // lightweight workspace info; when the conversation has no cwd/workdir, an empty string is not
        // passed, avoiding noise in the system prompt.
        clarifyContext: workspaceRoot ? { workdir: workspaceRoot } : undefined,
        onRemovePendingUpload: (relativePath) => removePendingUpload(relativePath, conversationId),
        onRunQueuedTurnNow: runQueuedTurnNow,
        onMoveQueuedTurnUp: moveQueuedTurnUp,
        onEditQueuedTurn: focusGuard(editQueuedTurn),
        onRemoveQueuedTurn: removeQueuedTurn,
      },
      sendDraft: paneSendDraft,
    };
  };

  const workbenchRegistrations: ConversationPaneRegistration[] = sessionWorkbench.enabled
    ? Object.values(workbench.layout.panes).flatMap((pane) => {
        // Only conversation panes register a host binding; terminal and
        // unsupported panes render self-contained surfaces.
        const surface = pane.surface;
        if (surface.kind !== "conversation") return [];
        return [
          {
            identity: {
              paneId: pane.paneId,
              conversationId: surface.conversationId,
              project: surface.project,
            },
            binding:
              surface.conversationId === currentConversationId
                ? {
                    ...primaryPaneBinding,
                    composer: {
                      ...primaryPaneBinding.composer,
                      // Keep Desktop aligned with Web: history hydration is a
                      // real disabled state even when the workbench has more
                      // than one pane, so typing cannot race stale history.
                      isInputDisabled:
                        isCompactionRunning ||
                        isConversationHydrationFailed ||
                        isImportingPastedText ||
                        isUploadingFiles ||
                        isConversationHydrating,
                    },
                  }
                : buildBackgroundPaneBinding(surface),
          },
        ];
      })
    : [
        {
          identity: {
            paneId: "root-conversation-pane",
            conversationId: currentConversationId,
            project: conversationSurfaceProject,
          },
          binding: primaryPaneBinding,
        },
      ];
  const conversationPaneHostEnvironment =
    createConversationPaneHostEnvironment(workbenchRegistrations);

  // Human-readable pane title, shared by the chrome tooltip/drag payload and
  // the pane's accessible region label.
  const workbenchPaneTitle = (surface: PaneRecord["surface"]): string => {
    switch (surface.kind) {
      case "conversation":
        return sidebarConversationsById.get(surface.conversationId)?.title?.trim() || "";
      case "fileTree":
      case "gitReview":
      case "tunnel":
      case "sshTunnel":
      case "backgroundTasks":
        return t(projectToolSurfaceTitleKey(surface.kind));
      case "localTerminal":
        return surface.launchSpec.title?.trim() || surface.launchSpec.shell?.trim() || "Terminal";
      case "sshTerminal":
        return surface.launchSpec.title?.trim() || surface.launchSpec.sshHostId.trim() || "SSH";
      case "unsupported":
        return surface.originalKind;
    }
  };

  // Per-pane region label: screen readers must be able to tell panes apart, so
  // terminals never read as "Conversation pane" and conversations carry their
  // title (plus the workspace name when the pane resolves to a known project).
  const workbenchPaneRegionLabel = (pane: PaneRecord): string => {
    const surface = pane.surface;
    if (surface.kind === "unsupported") return t("workbench.paneRegionUnsupported");
    const title = workbenchPaneTitle(surface);
    if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
      return t("workbench.paneRegionTerminal").replace("{title}", title);
    }
    if (isProjectToolSurface(surface)) {
      return t("workbench.paneRegionTool").replace("{title}", title);
    }
    if (!title) return t("workbench.paneRegion");
    const workspaceName = workspaceProjects
      .find((entry) => workspaceProjectPathKey(entry.path) === surface.project.projectPathKey)
      ?.name.trim();
    if (!workspaceName) {
      return t("workbench.paneRegionConversation").replace("{title}", title);
    }
    return t("workbench.paneRegionConversationInWorkspace")
      .replace("{title}", title)
      .replace("{workspace}", workspaceName);
  };

  // Same criterion as PaneSurfaceLayer's paneCount < 2 (chromeless) check: as long as the canvas has
  // >=2 Panes, Pane chrome renders and the switch point sinks accordingly.
  const workbenchHasMultiplePanes =
    sessionWorkbench.enabled && Object.keys(workbench.layout.panes).length >= 2;

  const renderWorkbenchPaneChrome = (
    pane: PaneRecord,
    context: { isFocused: boolean; paneCount: number; isCompact: boolean },
  ) => {
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
        dragHandleLabel={t("workbench.dragPane")}
        closeLabel={t("workbench.closePane")}
        onClose={() => requestWorkbenchClosePane(pane.paneId)}
        trajectoryToggle={
          surface.kind === "conversation"
            ? {
                isTrajectory: paneConversationView === "trajectory",
                label:
                  paneConversationView === "trajectory"
                    ? t("workbench.showConversation")
                    : t("workbench.showTrajectory"),
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
          beginWorkbenchDrag(
            { kind: "pane", paneId: pane.paneId, surfaceKey: surfaceIdentityKey(surface), title },
            {
              pointerId: event.pointerId,
              clientX: event.clientX,
              clientY: event.clientY,
              currentTarget: event.currentTarget,
            },
          );
        }}
      />
    );
  };

  // Runtime environment for a project-tool Pane: the same batch of clients/callbacks that
  // RightDockPanel gets, except the project is resolved by the Pane's own ProjectRef (see
  // ProjectToolPaneHost).
  const projectToolPaneEnvironment = useMemo<ProjectToolPaneEnvironment>(
    () => ({
      theme: effectiveTheme,
      fontScale: settings.customSettings.fontScale.rightDock,
      workspaceProjects,
      activeProjectPathKey: terminalProjectPathKey,
      clients: {
        terminal: tauriTerminalClient,
        git: tauriGitClient,
        textGeneration: projectToolTextGenerationClient,
        tunnel: isAgentMode ? tauriTunnelClient : null,
        workspaceActivity: tauriWorkspaceActivityClient,
      },
      capabilities: {
        disabledMessage: terminalDisabledMessage,
        terminalDisabledMessage,
        gitWriteEnabled: true,
        tunnelEnabled,
        tunnelDisabledMessage,
        tunnelPublicBaseUrl: settings.remote.gatewayUrl.trim(),
      },
      workspaceProjectRootClient: desktopWorkspaceProjectRootClient,
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
          if (projectPathKey === terminalProjectPathKey) handleChangedFileReveal(path);
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
        onSessionSnapshot: (snapshot) =>
          setTerminalSessions((current) => mergeTerminalSession(current, snapshot.session)),
        onSessionClosed: (sessionId) =>
          setTerminalSessions((current) => removeTerminalSession(current, sessionId)),
        onSessionsReconcile: (sessions) =>
          setTerminalSessions((current) => reconcileSshTerminalSessions(current, sessions)),
        onOpenSession: handleOpenSshTerminal,
      },
      openExternal: (url) => {
        void openUrl(url);
      },
    }),
    [
      codeReviewSkill,
      effectiveTheme,
      gitReviewFocusRequest,
      handleChangedFileReveal,
      handleGitReviewFocusRequestHandled,
      handleOpenSshTerminal,
      handleRightDockInsertCodeReviewSkill,
      handleRightDockInsertCommitMention,
      handleRightDockInsertFileMention,
      handleRightDockInsertGitFileMention,
      isAgentMode,
      openWorkspaceEditorFile,
      openWorkspaceFilePreview,
      projectToolTextGenerationClient,
      setSettings,
      setTerminalSessions,
      settings.customSettings,
      settings.remote.gatewayUrl,
      settings.ssh,
      tauriTunnelClient,
      terminalDisabledMessage,
      terminalProjectPathKey,
      terminalSessions,
      tunnelDisabledMessage,
      tunnelEnabled,
      workspaceProjects,
      workspaceRootRevision,
    ],
  );

  // Project tools leased by a canvas Pane: the dock hides the corresponding tab/content/entry
  // (same criterion as terminal leases).
  const leasedDockTools = useMemo(
    () =>
      leasedProjectToolKinds(workbench.layout, terminalProjectPathKey, PROJECT_TOOL_SURFACE_KINDS),
    [terminalProjectPathKey, workbench.layout],
  );

  const chatContent = sessionWorkbench.enabled ? (
    <ConversationPaneHostEnvironmentProvider value={conversationPaneHostEnvironment}>
      <WorkbenchCanvas
        layout={workbench.layout}
        labels={{
          paneRegion: (pane) => workbenchPaneRegionLabel(pane),
          separator: t("workbench.resizeDivider"),
        }}
        renderPaneContent={(pane, paneContext) => {
          const surface = pane.surface;
          if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
            return (
              <TerminalPaneHost
                paneId={pane.paneId}
                surface={surface}
                isFocused={paneContext.isFocused}
                isCompact={paneContext.isCompact}
                theme={effectiveTheme}
                sessions={terminalSessions}
                sessionsLoaded={terminalSessionsLoaded}
                onSessionGhost={verifyTerminalSessionAlive}
                closeRequest={
                  terminalPaneClose.pendingClose?.paneId === pane.paneId
                    ? {
                        busy: terminalPaneClose.pendingClose.busy,
                        onConfirm: terminalPaneClose.confirmClose,
                        onCancel: terminalPaneClose.cancelClose,
                      }
                    : undefined
                }
              />
            );
          }
          if (isProjectToolSurface(surface)) {
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
          const isCurrent = conversationId === currentConversationId;
          const panePathKey = surface.project.projectPathKey;
          // Archived/missing workspaces: the conversation stays viewable but
          // the pane is clearly marked blocked; it never rebinds elsewhere.
          const blockedMessage = archivedWorkspaceProjectPathKeys.has(panePathKey)
            ? t("workbench.projectArchived")
            : missingWorkspaceProjectPathKeys.has(panePathKey)
              ? t("workbench.projectMissing")
              : null;
          const blockedBanner = blockedMessage ? (
            <div
              data-workbench-pane-blocked=""
              className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400"
            >
              {blockedMessage}
            </div>
          ) : null;
          const host = (
            <Suspense fallback={<PaneLoadingSkeleton label={t("app.loading")} />}>
              <RestorableConversationPaneHost
                ref={
                  isCurrent
                    ? (handle) => {
                        // Callback ref assigns on attach and ignores the null
                        // detach. Swapping an object ref between two mounted
                        // hosts is order-dependent: the outgoing pane's detach
                        // can run after the incoming attach and leave
                        // composerRef permanently null, so Enter in the newly
                        // focused pane sends an empty draft.
                        if (handle) conversationPaneHostRef.current = handle;
                      }
                    : undefined
                }
                paneId={pane.paneId}
                title={sidebarConversationsById.get(conversationId)?.title}
                deferHydration={!paneContext.isFocused}
              />
            </Suspense>
          );
          if (!blockedBanner) return host;
          return (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {blockedBanner}
              {host}
            </div>
          );
        }}
        renderPaneChrome={renderWorkbenchPaneChrome}
        onResizeSplit={workbench.resizeSplit}
        onEqualizeSplit={workbench.equalizeSplit}
        onFocusPane={handleWorkbenchFocusPane}
        onGeometryChange={handleWorkbenchGeometryChange}
        dropPreview={
          workbenchDragState?.previewRect
            ? { rect: workbenchDragState.previewRect, label: workbenchDragState.payload.title }
            : null
        }
        emptyState={
          <WorkbenchEmptyState
            title={t("workbench.emptyTitle")}
            description={t("workbench.emptyDescription")}
          />
        }
      />
    </ConversationPaneHostEnvironmentProvider>
  ) : (
    <ConversationPaneHostEnvironmentProvider value={conversationPaneHostEnvironment}>
      <Suspense fallback={<PaneLoadingSkeleton label={t("app.loading")} />}>
        <ConversationPaneHost ref={conversationPaneHostRef} paneId="root-conversation-pane" />
      </Suspense>
    </ConversationPaneHostEnvironmentProvider>
  );

  const workbenchDragGhost =
    sessionWorkbench.enabled && workbenchDragState ? (
      <div
        ref={workbenchDragGhostRef}
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
        {workbenchDragState.payload.title || t("chat.pendingTitle")}
      </div>
    ) : null;

  return (
    <div
      data-app-frame="three-column"
      className="relative flex h-full min-h-0 w-full overflow-hidden"
    >
      <MacOsTitleBarToggle
        sidebarOpen={sidebarOpen}
        onToggle={handleToggleSidebar}
        onOpenSettings={() => onOpenSettings()}
        appUpdate={appUpdate}
      />
      {workbenchDragGhost}
      {/* ---- Left column: navigation/sidebar ---- */}
      <ChatSidebarContainer
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
        approvalStore={conversationRuntimeRegistry.approvals}
        questionStore={conversationRuntimeRegistry.questions}
        currentConversationId={currentConversationId}
        isOpen={sidebarOpen}
        fontScale={settings.customSettings.fontScale.sidebar}
        conversationSearchRequestKey={conversationSearchRequestKey}
        activeView={activeView}
        showProjects={isAgentMode}
        projects={workspaceProjects}
        workspaceProjectGroups={workspaceProjectGroups}
        activeProjectId={activeWorkspaceProject?.id ?? ""}
        missingProjectPathKeys={missingWorkspaceProjectPathKeys}
        projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
        workspaceFolderDropActive={isWorkspaceFolderDropActive}
        recentCollapsed={settings.customSettings.chatSidebar.recentCollapsed}
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
        onBrowseProjectInSystemFileManager={handleBrowseWorkspaceProjectInSystemFileManager}
        onConfigureProject={setProjectSettingsProject}
        onSetProjectPinned={handleSetWorkspaceProjectPinned}
        onRemoveProject={handleRemoveWorkspaceProject}
        onArchiveProject={handleArchiveWorkspaceProject}
        onUnarchiveProject={handleUnarchiveWorkspaceProject}
        archivedProjectPathKeys={archivedWorkspaceProjectPathKeys}
        onNewConversation={() => {
          setActiveView("chat");
          if (activeView !== "chat" && isDraftConversation) {
            return;
          }
          handleNewConversation();
        }}
        onSelectConversation={(id, options) => {
          setActiveView("chat");
          handleSelectConversation(id, options);
        }}
        onConversationDeleted={handleConversationDeleted}
        onConversationCwdChanged={handleConversationCwdChanged}
        onConversationWorkbenchDragIntent={
          sessionWorkbench.enabled ? handleConversationWorkbenchDragIntent : undefined
        }
        onConversationOpenInWorkbenchSplit={
          sessionWorkbench.enabled ? handleOpenConversationInSplit : undefined
        }
        onProjectWorkbenchDragIntent={
          sessionWorkbench.enabled ? handleProjectWorkbenchDragIntent : undefined
        }
        canShareConversations={canShareHistory}
        sharedConversationCount={sharedHistoryItems.length}
        onShareConversation={handleOpenShareModal}
        onOpenSharedConversations={handleOpenSharedHistoryManager}
        onCloseSidebar={handleCloseSidebar}
        sidebarShortcuts={settings.customSettings.sidebarShortcuts}
        onOpenSettings={onOpenSettings}
        appUpdate={appUpdate}
        onOpenResourceHub={(resource) => {
          cacheActiveComposerDraft();
          setRightDockOpen(false);
          setActiveView(`${resource}-hub`);
        }}
      />

      {/* ---- Center column: workbench chrome + conversation surfaces ---- */}
      <div
        data-app-frame-column="main"
        className="relative flex flex-col min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <AppWorkbenchChrome
          settings={settings}
          sidebarOpen={sidebarOpen}
          onOpenSettings={onOpenSettings}
          onToggleTheme={onToggleTheme}
          onOpenSidebar={handleOpenSidebar}
          leadingActions={
            // With multiple Panes the switch point is embedded in the focused Pane's top-left corner
            // (PaneChrome) and is not repeated in the top bar; a single Pane has no Pane chrome, so
            // the top bar Tabs are kept.
            activeView === "chat" && hasConversationReply && !workbenchHasMultiplePanes ? (
              <ConversationViewTabs
                active={renderedConversationView}
                onChange={setActiveConversationView}
              />
            ) : null
          }
          trailingActions={
            <ProjectToolsPanelToggle
              isOpen={rightDockOpen}
              sessionCount={projectTerminalSessions.length}
              disabledMessage={terminalDisabledMessage}
              onToggle={() => setRightDockOpen((open) => !open)}
            />
          }
          overlay={<NotifyToast items={notifyItems} onDismiss={dismissNotify} />}
        />

        {workspaceCreateModalOpen ? (
          <WorkspaceCloneModal
            initialParent={activeWorkspaceProjectPath || workdir}
            onOpenFolder={handleOpenWorkspaceFolder}
            onClone={handleCloneWorkspaceProject}
            onClose={() => setWorkspaceCreateModalOpen(false)}
            onLoadBranches={handleLoadWorkspaceRemoteBranches}
          />
        ) : null}
        <WorkspaceCloneTaskOverlayAdapter onOpenWorkspace={handleOpenClonedWorkspace} />

        {shareConversation ? (
          <HistoryShareModal
            conversation={shareConversation}
            share={shareStatus}
            isLoading={shareLoading}
            isUpdating={shareUpdating}
            errorMessage={shareError}
            shareOrigin={sharedManagerShareOrigin}
            shareOriginPort={sharedManagerShareOriginPort}
            shareOriginLoading={sharedManagerGatewayUrlLoading}
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
            shareOrigin={sharedManagerShareOrigin}
            shareOriginPort={sharedManagerShareOriginPort}
            shareOriginLoading={sharedManagerGatewayUrlLoading}
            onRefresh={handleRefreshSharedHistoryStatuses}
            onLoadStatus={handleLoadSharedHistoryStatus}
            onDisableShare={handleDisableSharedHistory}
            onSetRedactToolContent={handleSetSharedHistoryRedactToolContent}
            onClose={() => setSharedManagerOpen(false)}
          />
        ) : null}

        {confirmDialog}

        {/* ---- Main content ----
            Font scaling applies only to the chat view: Skills/MCP Hub pages contain many
            un-migrated fixed pixel font sizes, and scaling the whole column would cause mixed
            typesetting (chat-area settings should also only affect the chat area). */}
        <ApplicationView
          activeView={activeView}
          settings={settings}
          setSettings={setSettings}
          isAgentMode={isAgentMode}
          initialSkills={availableSkills}
          initialSkillsRootDir={skillsRootDir}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
          chatClassName="zone-font-scale"
          chatStyle={
            {
              "--zone-font-scale": settings.customSettings.fontScale.chat,
            } as CSSProperties
          }
          chat={{ content: chatContent }}
          workspaceOverlays={
            <WorkspaceOverlayHost
              locale={settings.locale}
              theme={effectiveTheme}
              workspaceEditorMounted={workspaceOverlays.workspaceEditorMounted}
              workspaceEditorOpenRequest={workspaceOverlays.workspaceEditorOpenRequest}
              workspaceEditorCloseRequestId={workspaceOverlays.workspaceEditorCloseRequestId}
              workspaceEditorOpen={workspaceOverlays.workspaceEditorOpen}
              workspaceEditorCleanupPending={workspaceOverlays.workspaceEditorCleanupPending}
              onWorkspaceEditorPreviewFile={workspaceOverlays.openWorkspaceFilePreview}
              onWorkspaceEditorInsertCodeMention={handleInsertCodeMention}
              onWorkspaceEditorHide={workspaceOverlays.handleWorkspaceEditorHide}
              onWorkspaceEditorClose={workspaceOverlays.handleWorkspaceEditorClosed}
              workspaceFilePreviewMounted={workspaceOverlays.workspaceFilePreviewMounted}
              workspaceFilePreviewOpenRequest={workspaceOverlays.workspaceFilePreviewOpenRequest}
              workspaceFilePreviewOpen={workspaceOverlays.workspaceFilePreviewOpen}
              onWorkspaceFilePreviewOpenEditor={workspaceOverlays.openWorkspaceEditorFile}
              onWorkspaceFilePreviewRequestClose={
                workspaceOverlays.requestWorkspaceFilePreviewClose
              }
              onWorkspaceFilePreviewClose={workspaceOverlays.handleWorkspaceFilePreviewClosed}
              workspaceSshTerminalMounted={workspaceOverlays.workspaceSshTerminalMounted}
              workspaceSshTerminalOpenRequest={workspaceOverlays.workspaceSshTerminalOpenRequest}
              workspaceSshTerminalOpen={workspaceOverlays.workspaceSshTerminalOpen}
              terminalProjectPathKey={terminalProjectPathKey}
              terminalClient={tauriTerminalClient}
              sftpClient={tauriSftpClient}
              terminalSessions={terminalSessions}
              onWorkspaceSshTerminalHide={() =>
                workspaceOverlays.setWorkspaceSshTerminalOpen(false)
              }
              onSshTerminalOpenFile={workspaceOverlays.handleOpenSftpFile}
              sshTerminalPaneLeasedSessionIds={leasedDockSessionIds}
              onSshTerminalFocusLeasedSession={
                sessionWorkbench.enabled ? focusWorkbenchTerminalPane : undefined
              }
              onSshTerminalSessionTabDragStart={
                sessionWorkbench.enabled ? handleSshTerminalTabDragIntent : undefined
              }
            />
          }
        />
      </div>
      <RightDockPanel
        isOpen={activeView === "chat" && rightDockOpen}
        collapseImmediately={activeView !== "chat"}
        fontScale={settings.customSettings.fontScale.rightDock}
        projectPathKey={terminalProjectPathKey}
        cwd={terminalProjectPath}
        workspaceProject={activeWorkspaceProject}
        workspaceProjectRootClient={desktopWorkspaceProjectRootClient}
        workspaceRootRevision={workspaceRootRevision}
        sessions={terminalSessions}
        sessionsLoaded={terminalSessionsLoaded}
        leasedSessionIds={leasedDockSessionIds}
        leasedTools={leasedDockTools}
        width={settings.customSettings.rightDock.width}
        theme={effectiveTheme}
        disabledMessage={terminalDisabledMessage}
        projectState={rightDockProjectState}
        fileTreeState={rightDockFileTreeState}
        sshHosts={settings.ssh.hosts}
        associatedSshHostIds={associatedSshHostIds}
        client={tauriTerminalClient}
        gitClient={tauriGitClient}
        gitWriteEnabled
        textGenerationClient={projectToolTextGenerationClient}
        tunnelClient={isAgentMode ? tauriTunnelClient : null}
        tunnelEnabled={tunnelEnabled}
        tunnelDisabledMessage={tunnelDisabledMessage}
        tunnelPublicBaseUrl={settings.remote.gatewayUrl.trim()}
        workspaceActivityClient={tauriWorkspaceActivityClient}
        onWidthChange={handleRightDockWidthChange}
        onProjectStateChange={handleRightDockProjectStateChange}
        onFileTreeStateChange={handleRightDockFileTreeStateChange}
        onSshProjectHostIdsChange={handleSshProjectHostIdsChange}
        onOpenSshSession={handleOpenSshTerminal}
        onSessionsChange={handleRightDockSessionsChange}
        onTerminalTabDragStart={
          sessionWorkbench.enabled ? handleTerminalTabWorkbenchDragIntent : undefined
        }
        onNewTerminalDragStart={
          sessionWorkbench.enabled ? handleNewTerminalWorkbenchDragIntent : undefined
        }
        onOpenTerminalInWorkbench={
          sessionWorkbench.enabled ? handleOpenTerminalInWorkbenchSplit : undefined
        }
        onToolDragStart={
          sessionWorkbench.enabled && terminalProjectPathKey
            ? handleToolWorkbenchDragIntent
            : undefined
        }
        onOpenToolInWorkbench={
          sessionWorkbench.enabled && terminalProjectPathKey
            ? handleOpenToolInWorkbenchSplit
            : undefined
        }
        onOpenNewTerminalInWorkbench={
          sessionWorkbench.enabled ? handleOpenNewTerminalInWorkbenchSplit : undefined
        }
        onSessionGhost={verifyTerminalSessionAlive}
        onInsertFileMention={handleRightDockInsertFileMention}
        onOpenFile={handleOpenWorkspaceFile}
        gitReviewFocusRequest={gitReviewFocusRequest}
        onGitReviewFocusRequestHandled={handleGitReviewFocusRequestHandled}
        onInsertCodeReviewSkill={codeReviewSkill ? handleRightDockInsertCodeReviewSkill : undefined}
        onInsertCommitMention={handleRightDockInsertCommitMention}
        onInsertGitFileMention={handleRightDockInsertGitFileMention}
      />
      {projectSettingsProject ? (
        <WorkspaceProjectSettingsModal
          project={projectSettingsProject}
          settings={settings}
          skills={availableSkills}
          rootClient={desktopWorkspaceProjectRootClient}
          onClose={() => setProjectSettingsProject(null)}
          onRenameProject={(name) => {
            commitWorkspaceProjectRename(projectSettingsProject, name);
          }}
          onSave={(draft) => {
            setSettings((prev) =>
              updateWorkspaceResourceSettings(prev, projectSettingsProject.path, draft),
            );
          }}
        />
      ) : null}
    </div>
  );
}
