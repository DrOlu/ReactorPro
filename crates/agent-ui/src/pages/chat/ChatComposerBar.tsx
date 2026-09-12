import {
  type ChatRuntimeControls,
  type CommandSafetyMode,
  type ComposerContextDisplayMode,
  type ExecutionMode,
  isAgentExecutionMode,
  type ProviderId,
  type ReasoningLevel,
  type SelectedModel,
} from "@liveagent/app/lib/settings";
import { CommandSafetyModeSelector } from "@liveagent/ui/components/chat/CommandSafetyModeSelector";
import { ComposerAttachmentCard } from "@liveagent/ui/components/chat/ComposerAttachmentCard";
import { ComposerModelControls } from "@liveagent/ui/components/chat/ComposerModelControls";
import { ContextUsageRing } from "@liveagent/ui/components/chat/ContextUsageRing";
import { ClarifyPanel } from "@liveagent/ui/components/chat/clarify/ClarifyPanel";
import type {
  ClarifyContext,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { useClarifySession } from "@liveagent/ui/components/chat/clarify/useClarifySession";
import { getUploadedFileTypeIcon } from "@liveagent/ui/components/chat/fileTypeIcons";
import {
  MentionComposer,
  type MentionComposerApp,
  type MentionComposerConversation,
  type MentionComposerHandle,
  type MentionComposerSkill,
} from "@liveagent/ui/components/chat/MentionComposer";
import { GitBranchSelector } from "@liveagent/ui/components/git/GitBranchSelector";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Clock3,
  FolderOpen,
  Lightbulb,
  Loader2,
  Maximize2,
  Minimize2,
  Paperclip,
  Play,
  Plus,
  Square,
  SquarePen,
  Trash2,
  WandSparkles,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { LabelTooltip as RuntimeControlTooltip } from "@liveagent/ui/components/ui/label-tooltip";
import { useLocale } from "@liveagent/ui/i18n/index";
import { measureComposerOverlay } from "@liveagent/ui/lib/chat/composerOverlayMetrics";
import {
  type ConversationReferenceInsertResult,
  getActiveConversationReferenceDrag,
  hasConversationReferenceDragPayload,
  readConversationReferenceDragPayload,
  registerConversationReferenceDropZone,
} from "@liveagent/ui/lib/chat/conversationReferenceDrag";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import {
  clearActiveWorkspacePathDrag,
  getActiveWorkspacePathDrag,
  hasWorkspacePathDragPayload,
  readNativeWorkspacePathDragOver,
  readNativeWorkspacePathDrop,
  readWorkspacePathDragPayload,
  WORKSPACE_PATH_NATIVE_DRAG_LEAVE_EVENT,
  WORKSPACE_PATH_NATIVE_DRAG_OVER_EVENT,
  WORKSPACE_PATH_NATIVE_DROP_EVENT,
  type WorkspacePathDragPayload,
  workspacePathDragMatchesProject,
} from "@liveagent/ui/lib/chat/workspacePathDrag";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { WorkspaceActivityClient } from "@liveagent/ui/lib/workspace-activity/types";
import {
  type MutableRefObject,
  memo,
  type DragEvent as ReactDragEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getUploadedImagePreviewCacheKey,
  loadUploadedImagePreview,
  readUploadedImagePreviewCache,
  type UploadedImagePreviewLoader,
} from "../../lib/chat/uploadedImagePreview";
import type { PendingUploadedFile } from "../../lib/chat/uploadTypes";

function useComposerUploadedImagePreview(
  file: PendingUploadedFile,
  workdir: string,
  loader?: UploadedImagePreviewLoader,
) {
  const shouldPreviewImage =
    file.kind === "image" && typeof file.absolutePath === "string" && file.absolutePath.trim();
  const cacheKey = shouldPreviewImage ? getUploadedImagePreviewCacheKey(workdir, file) : "";
  const [imageSrc, setImageSrc] = useState<string | null | undefined>(() => {
    if (!cacheKey) return null;
    return readUploadedImagePreviewCache(workdir, file);
  });

  useEffect(() => {
    if (!cacheKey) {
      setImageSrc(null);
      return;
    }

    const cached = readUploadedImagePreviewCache(workdir, file);
    if (cached !== undefined) {
      setImageSrc(cached);
      return;
    }
    if (!loader) {
      setImageSrc(null);
      return;
    }

    let cancelled = false;
    setImageSrc(undefined);
    void loadUploadedImagePreview({ workspaceRoot: workdir, file, loader }).then((value) => {
      if (!cancelled) setImageSrc(value);
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, file, loader, workdir]);

  return {
    imageSrc: imageSrc ?? null,
    isLoading: Boolean(cacheKey && loader) && imageSrc === undefined,
  };
}

function PendingComposerAttachment(props: {
  file: PendingUploadedFile;
  workdir: string;
  disabled: boolean;
  removeLabel: string;
  previewLabel: string;
  closePreviewLabel: string;
  imagePreviewLoader?: UploadedImagePreviewLoader;
  onRemove: (relativePath: string) => void;
}) {
  const {
    file,
    workdir,
    disabled,
    removeLabel,
    previewLabel,
    closePreviewLabel,
    imagePreviewLoader,
    onRemove,
  } = props;
  const { imageSrc, isLoading } = useComposerUploadedImagePreview(
    file,
    workdir,
    imagePreviewLoader,
  );
  const TypeIcon = getUploadedFileTypeIcon(file);

  return (
    <ComposerAttachmentCard
      file={file}
      workspaceRoot={workdir}
      fileName={file.fileName}
      pathTitle={file.relativePath}
      imageSrc={imageSrc}
      isImageLoading={isLoading}
      fallbackIcon={<TypeIcon className="h-4 w-4" />}
      disabled={disabled}
      removeLabel={removeLabel}
      previewLabel={previewLabel}
      closePreviewLabel={closePreviewLabel}
      onRemove={() => onRemove(file.relativePath)}
    />
  );
}

export type ChatQueueTurnPreview = {
  id: string;
  previewText: string;
  fileCount: number;
};

type QueueScrollbarState = {
  visible: boolean;
  thumbHeight: number;
  thumbTop: number;
};

const QUEUE_SCROLLBAR_MIN_THUMB_HEIGHT = 24;
const DEFAULT_QUEUE_SCROLLBAR_STATE: QueueScrollbarState = {
  visible: false,
  thumbHeight: QUEUE_SCROLLBAR_MIN_THUMB_HEIGHT,
  thumbTop: 0,
};

const COMPOSER_EXPAND_ANIMATION_MS = 280;
const COMPOSER_EXPAND_EASING = "cubic-bezier(0.32, 0.72, 0.22, 1)";
const CONVERSATION_DROP_NOTICE_MS = 800;

// Placeholder for when the host has not injected a clarify executor: clarifyEnabled=false already
// hides all entry points, so this function is never actually called; it only satisfies
// useClarifySession's non-null signature.
const unavailableClarifyTurn: RunClarifyTurn = () =>
  Promise.reject(new Error("runClarifyTurn is not provided"));

/** Clarifiable text = a non-blank plain-text segment exists in the draft. Mention/attachment tokens
 * and large pastes do not count: clarify's input is prompt text the user wrote, so with only
 * chips/attachments the button should be disabled rather than idling on click.
 * Called only inside event handlers (reads the DOM); zero calls on the render path. */
function draftHasClarifiableText(composer: MentionComposerHandle | null): boolean {
  return (
    composer
      ?.getDraft()
      .segments.some((segment) => segment.type === "text" && segment.text.trim().length > 0) ??
    false
  );
}

/** Live reading subscription source for the usage ring (getContextUsageTokens must return a stable value for the same underlying state). */
export type ContextUsageTokensSource = {
  subscribe: (listener: () => void) => () => void;
  getContextUsageTokens: () => number | undefined;
};

const noopSubscribe = () => () => {};

// The ring's live reading is subscribed in a separate small component: per-frame reading changes
// during streaming re-render only this SVG ring, without triggering a ChatComposerBar/full-page reflow.
function ComposerContextUsageRing(props: {
  source?: ContextUsageTokensSource;
  totalTokens?: number;
  contextWindow?: number;
  disabled?: boolean;
  onConfirm?: (() => void) | (() => Promise<unknown>);
}) {
  const { source, totalTokens, contextWindow, disabled, onConfirm } = props;
  const readStatic = useCallback(() => totalTokens, [totalTokens]);
  const liveTokens = useSyncExternalStore(
    source?.subscribe ?? noopSubscribe,
    source?.getContextUsageTokens ?? readStatic,
    source?.getContextUsageTokens ?? readStatic,
  );
  return (
    <ContextUsageRing
      totalTokens={source ? liveTokens : totalTokens}
      contextWindow={contextWindow}
      disabled={disabled}
      onConfirm={onConfirm}
      // The ring renders in the "ring" / "both" display modes (see contextDisplayMode) and must be
      // always visible starting from 0% -- in "ring" mode it is the only occupancy reading, so the
      // low-occupancy hide threshold no longer applies.
    />
  );
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export type ChatComposerBarProps = {
  surface: "desktop" | "web";
  conversationId: string;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  isSending: boolean;
  isUploadingFiles: boolean;
  isInputDisabled: boolean;
  /**
   * A read-only view (such as the trajectory page) suspends the composer: display:none overall but
   * still mounted, so half-finished drafts and queue state are restored as-is when switching back to
   * the chat page.
   */
  hidden?: boolean;
  inputPlaceholder: string;
  workdir: string;
  enabledSkills: MentionComposerSkill[];
  /** Earlier conversations available to the structured @ reference picker. */
  mentionableConversations?: MentionComposerConversation[];
  /** Searches all persisted conversations beyond the sidebar's loaded page. */
  searchMentionableConversations?: (query: string) => Promise<MentionComposerConversation[]>;
  /** App candidates for the @ popover (computer use targets); gated by the host, hidden by default. */
  mentionApps?: MentionComposerApp[];
  executionMode: ExecutionMode;
  hasModels: boolean;
  currentModelLabel: string;
  modelOptions: SharedModelOption<ProviderId>[];
  selectedValue?: string;
  chatRuntimeControls: ChatRuntimeControls;
  /** Command execution mode (ask/auto/sandbox/sandboxOffline); the selector is not rendered by default. */
  commandSafetyMode?: CommandSafetyMode;
  onCommandSafetyModeChange?: (mode: CommandSafetyMode) => void;
  reasoningOptions: ReasoningLevel[];
  thinkingAlwaysOn: boolean;
  gitClient?: GitClient | null;
  gitWriteEnabled?: boolean;
  gitDisabledMessage?: string;
  /** Current conversation context occupancy tokens; the usage ring shows when both this and contextWindow are present. */
  contextUsageTokens?: number;
  /**
   * Optional live subscription source for the usage ring: the reading changes every frame during
   * streaming, so subscribing here re-renders only the ring itself without reflowing the whole page
   * (used by the GUI; the WebUI can pass a static contextUsageTokens). Takes precedence over
   * contextUsageTokens when provided.
   */
  contextUsageTokensSource?: ContextUsageTokensSource;
  contextWindow?: number;
  /** Triggers manual compaction after ring confirmation; without it the ring is display-only. */
  onManualCompactConfirm?: (() => void) | (() => Promise<unknown>);
  /** Disables clicking the usage ring while compaction is in progress / a request is in flight. */
  manualCompactBlocked?: boolean;
  workspaceActivityClient?: WorkspaceActivityClient | null;
  /** After a worktree is created successfully, adds the backend-returned path and repository identity to the sidebar. */
  onOpenWorktree?: (worktree: { path: string; repositoryPath: string; branch: string }) => void;
  onWorktreeRemoved?: (worktree: { path: string; repositoryPath: string; branch: string }) => void;
  onSend: () => void;
  onStop: () => void;
  onPrepareChatRuntime?: () => void;
  onComposerBusyChange: (isBusy: boolean) => void;
  onSelectModel: (selection: SelectedModel) => void;
  onSelectExecutionMode: (mode: "text" | "tools") => void;
  onOpenSettings: (section?: "providers", providerId?: string) => void;
  onChatRuntimeControlsChange: (patch: Partial<ChatRuntimeControls>) => void;
  onPickReadableFiles: () => void;
  /** Select a folder to mount as a read-only project root. */
  onPickWorkspaceFolder: () => void;
  onPasteFiles: (files: File[]) => void;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  /** Prompts previously sent in this conversation for ↑/↓ recall. */
  loadHistoryPrompts?: () => readonly string[];
  pendingUploadedFiles: PendingUploadedFile[];
  onRemovePendingUpload: (relativePath: string) => void;
  queuedTurns: ChatQueueTurnPreview[];
  onRunQueuedTurnNow: (id: string) => void;
  onMoveQueuedTurnUp: (id: string) => void;
  onEditQueuedTurn: (id: string) => void;
  onRemoveQueuedTurn: (id: string) => void;
  /** Prompt clarify executor: once injected, a "Clarify" button renders in the tool row (wired up in the GUI; see plan 2 for Web). */
  runClarifyTurn?: RunClarifyTurn;
  /** Lightweight workspace info attached to the clarify system prompt. */
  clarifyContext?: ClarifyContext;
  onHeightChange?: (height: number) => void;
  /**
   * The height above the reservation line additionally occupied by the queue panel and task progress
   * pill (see composerOverlayMetrics). They are not counted in onHeightChange, but controls floating
   * above the composer (the back-to-bottom button) must yield this distance to avoid being covered.
   * Reported by desktop only.
   */
  onFloatingOverhangChange?: (height: number) => void;
  /**
   * The horizontal offset of the card column's center relative to the composer layer's center
   * (positive to the right). The card column and the body are both centered, so normally 0; in
   * split-screen and similar scenarios it still shifts by the measured value, so controls centered
   * above the composer align with the cards and pills. Reported by desktop only.
   */
  onCenterOffsetChange?: (offsetPx: number) => void;
  /** Current conversation task progress (rendered above the approval bar and queue panel when present). */
  taskProgressBar?: ReactNode;
  /** Centralized approval panel that replaces the input card while awaiting approval. */
  approvalBar?: ReactNode;
  /** Local feedback layer shown when dragged files land on the input box. */
  fileDropOverlay?: ReactNode;
  /**
   * Conversation stats status-bar slot directly below the card (docs/design/composer-context-stats-bar.md).
   * The card and pill already compress their height budget for it; it takes no space when the host
   * has not wired it up.
   */
  statsBar?: ReactNode;
  /**
   * Three display styles for context occupancy (settings.customSettings.composerContextDisplay,
   * docs/design/composer-context-stats-bar.md §4.7). The trade-off is decided uniformly in this
   * component: "statsBar" (default) renders the statsBar slot and no usage ring; "both" renders the
   * status bar and the always-visible usage ring together; "ring" renders the always-visible usage
   * ring (from 0%, the ring being the only reading) and does not mount the statsBar slot even if
   * provided.
   */
  contextDisplayMode?: ComposerContextDisplayMode;
};

export const ChatComposerBar = memo(function ChatComposerBar(props: ChatComposerBarProps) {
  const {
    surface,
    conversationId,
    composerRef,
    isSending,
    isUploadingFiles,
    isInputDisabled,
    hidden = false,
    inputPlaceholder,
    workdir,
    enabledSkills,
    mentionableConversations = [],
    searchMentionableConversations,
    mentionApps,
    executionMode,
    hasModels,
    currentModelLabel,
    modelOptions,
    selectedValue,
    chatRuntimeControls,
    commandSafetyMode,
    onCommandSafetyModeChange,
    reasoningOptions,
    thinkingAlwaysOn,
    gitClient,
    gitWriteEnabled = true,
    gitDisabledMessage,
    contextUsageTokens,
    contextUsageTokensSource,
    contextWindow,
    onManualCompactConfirm,
    manualCompactBlocked,
    workspaceActivityClient,
    onOpenWorktree,
    onWorktreeRemoved,
    onSend,
    onStop,
    onPrepareChatRuntime,
    onComposerBusyChange,
    onSelectModel,
    onSelectExecutionMode,
    onOpenSettings,
    onChatRuntimeControlsChange,
    onPickReadableFiles,
    onPickWorkspaceFolder,
    onPasteFiles,
    onLoadUploadedImagePreview,
    loadHistoryPrompts,
    pendingUploadedFiles,
    onRemovePendingUpload,
    queuedTurns,
    onRunQueuedTurnNow,
    onMoveQueuedTurnUp,
    onEditQueuedTurn,
    onRemoveQueuedTurn,
    runClarifyTurn,
    clarifyContext,
    onHeightChange,
    onFloatingOverhangChange,
    onCenterOffsetChange,
    taskProgressBar,
    approvalBar,
    fileDropOverlay,
    statsBar,
    contextDisplayMode,
  } = props;
  const { t } = useLocale();
  const [composerIsEmpty, setComposerIsEmpty] = useState(true);
  // Clarifiable-text presence: tracked separately from composerIsEmpty -- emptiness looks only at the
  // editor as a whole (chip text counts as non-empty), whereas clarify needs a plain-text segment.
  // The draft is read only inside events: updated at three points -- editor input (user typing /
  // inserting or deleting chips), emptiness flipping (a fallback for programmatic edits), and the
  // clarify button click; the render path does not read the DOM.
  const [composerHasClarifiableText, setComposerHasClarifiableText] = useState(false);
  const handleComposerEmptyChange = useCallback(
    (isEmpty: boolean) => {
      setComposerIsEmpty(isEmpty);
      setComposerHasClarifiableText(isEmpty ? false : draftHasClarifiableText(composerRef.current));
    },
    [composerRef],
  );
  const handleComposerInput = useCallback(() => {
    setComposerHasClarifiableText(draftHasClarifiableText(composerRef.current));
  }, [composerRef]);
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const [composerHasOverflow, setComposerHasOverflow] = useState(false);
  const isComposerExpandedRef = useRef(false);
  const glassCardRef = useRef<HTMLDivElement | null>(null);
  const conversationDragDepthRef = useRef(0);
  const [conversationDropReference, setConversationDropReference] =
    useState<ConversationMentionReference | null>(null);
  const conversationDropNoticeCounterRef = useRef(0);
  const [conversationDropNotice, setConversationDropNotice] = useState<{
    result: Exclude<ConversationReferenceInsertResult, "inserted">;
    key: number;
  } | null>(null);
  const attachmentListRef = useRef<HTMLDivElement | null>(null);
  const previousPendingUploadCountRef = useRef(0);
  /** The card's old height recorded at the instant of toggling, used by the FLIP animation; cleared immediately after consumption. */
  const expandFromHeightRef = useRef<number | null>(null);
  const expandAnimationRef = useRef<Animation | null>(null);
  const scheduleHeightMeasureRef = useRef<(() => void) | null>(null);
  const scheduleComposerOverflowMeasureRef = useRef<(() => void) | null>(null);
  const composerLayerRef = useRef<HTMLDivElement | null>(null);
  const composerColumnRef = useRef<HTMLDivElement | null>(null);
  const queuePanelRef = useRef<HTMLDivElement | null>(null);
  // Uses state rather than a ref: the container mounts/unmounts with the taskProgressBar slot, so the
  // measurement effect must re-observe it.
  const [taskProgressBarElement, setTaskProgressBarElement] = useState<HTMLDivElement | null>(null);
  const queueListRef = useRef<HTMLUListElement | null>(null);
  const queueScrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const queueScrollbarDragRef = useRef<{
    pointerId: number;
    startScrollTop: number;
    startY: number;
  } | null>(null);
  const queueHadTurnsRef = useRef(false);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [workspacePathDropState, setWorkspacePathDropState] = useState<"accept" | "blocked" | null>(
    null,
  );
  const [queueScrollbar, setQueueScrollbar] = useState<QueueScrollbarState>(
    DEFAULT_QUEUE_SCROLLBAR_STATE,
  );
  const isAgentMode = isAgentExecutionMode(executionMode);
  const uploadDisabled = isInputDisabled || isUploadingFiles || !isAgentMode || !workdir;
  const controlsDisabled = isInputDisabled;
  const canDropConversationReference = isAgentMode && !controlsDisabled && !hidden;
  // The "+" menu is not only about uploads: the plan toggle does not depend on workdir/upload state,
  // so the menu trigger is disabled only by the loosest availability, and each menu item is disabled
  // separately by its own prerequisites.
  const composerAddMenuDisabled = isAgentMode ? controlsDisabled : uploadDisabled;
  const hasSendableDraft = !composerIsEmpty || pendingUploadedFiles.length > 0;
  const sendDisabled = isInputDisabled || isUploadingFiles || !hasSendableDraft;
  const canQueueDraftWhileSending = isSending && !sendDisabled;
  const primaryActionTitle = canQueueDraftWhileSending
    ? t("chat.queue.addToQueue")
    : isSending
      ? t("chat.stopGeneration")
      : t("chat.sendMessage");
  const uploadTooltip = isUploadingFiles
    ? t("chat.upload.uploading")
    : !isAgentMode
      ? t("chat.upload.onlyInTools")
      : !workdir
        ? t("chat.upload.requireWorkdir")
        : t("chat.upload.button");
  // Hint for the menu trigger: when the menu is available but upload is not, use the generic "Add"
  // copy; upload-specific restrictions (needing a workdir, etc.) appear only in the disabled state of
  // the upload menu items themselves.
  const addMenuTooltip =
    !composerAddMenuDisabled && uploadDisabled ? t("chat.upload.addSection") : uploadTooltip;
  const toggleQueueTooltip = queueCollapsed ? t("chat.queue.expand") : t("chat.queue.collapse");
  const toggleComposerExpandTooltip = isComposerExpanded
    ? t("chat.composer.collapse")
    : t("chat.composer.expand");

  const resolveWorkspacePathDropState = useCallback((): "accept" | "blocked" => {
    const payload = getActiveWorkspacePathDrag();
    return payload && !isInputDisabled && workspacePathDragMatchesProject(payload, workdir)
      ? "accept"
      : "blocked";
  }, [isInputDisabled, workdir]);

  const insertWorkspacePathMention = useCallback(
    (payload: WorkspacePathDragPayload) => {
      setWorkspacePathDropState(null);
      if (isInputDisabled || !workspacePathDragMatchesProject(payload, workdir)) return false;
      composerRef.current?.insertFileMention(payload.relativePath, payload.entryKind);
      composerRef.current?.focus();
      return true;
    },
    [composerRef, isInputDisabled, workdir],
  );

  const handleWorkspacePathDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasWorkspacePathDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const state = resolveWorkspacePathDropState();
      event.dataTransfer.dropEffect = state === "accept" ? "copy" : "none";
      setWorkspacePathDropState(state);
    },
    [resolveWorkspacePathDropState],
  );

  const handleWorkspacePathDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasWorkspacePathDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const payload = readWorkspacePathDragPayload(event.dataTransfer);
      clearActiveWorkspacePathDrag();
      if (payload) insertWorkspacePathMention(payload);
    },
    [insertWorkspacePathMention],
  );

  useEffect(() => {
    const target = glassCardRef.current;
    if (!target) return;
    const handleNativeWorkspacePathDragOver = (event: Event) => {
      const payload = readNativeWorkspacePathDragOver(event);
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      setWorkspacePathDropState(
        !isInputDisabled && workspacePathDragMatchesProject(payload, workdir)
          ? "accept"
          : "blocked",
      );
    };
    const handleNativeWorkspacePathDragLeave = (event: Event) => {
      if (event.type !== WORKSPACE_PATH_NATIVE_DRAG_LEAVE_EVENT) return;
      setWorkspacePathDropState(null);
    };
    const handleNativeWorkspacePathDrop = (event: Event) => {
      const payload = readNativeWorkspacePathDrop(event);
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      insertWorkspacePathMention(payload);
    };
    target.addEventListener(
      WORKSPACE_PATH_NATIVE_DRAG_OVER_EVENT,
      handleNativeWorkspacePathDragOver,
    );
    target.addEventListener(
      WORKSPACE_PATH_NATIVE_DRAG_LEAVE_EVENT,
      handleNativeWorkspacePathDragLeave,
    );
    target.addEventListener(WORKSPACE_PATH_NATIVE_DROP_EVENT, handleNativeWorkspacePathDrop);
    return () => {
      target.removeEventListener(
        WORKSPACE_PATH_NATIVE_DRAG_OVER_EVENT,
        handleNativeWorkspacePathDragOver,
      );
      target.removeEventListener(
        WORKSPACE_PATH_NATIVE_DRAG_LEAVE_EVENT,
        handleNativeWorkspacePathDragLeave,
      );
      target.removeEventListener(WORKSPACE_PATH_NATIVE_DROP_EVENT, handleNativeWorkspacePathDrop);
    };
  }, [insertWorkspacePathMention, isInputDisabled, workdir]);

  const showConversationDropNotice = useCallback((result: ConversationReferenceInsertResult) => {
    if (result === "inserted") {
      setConversationDropNotice(null);
      return;
    }
    conversationDropNoticeCounterRef.current += 1;
    setConversationDropNotice({ result, key: conversationDropNoticeCounterRef.current });
  }, []);

  const insertConversationReference = useCallback(
    (reference: ConversationMentionReference) => {
      const result: ConversationReferenceInsertResult = !canDropConversationReference
        ? "disabled"
        : reference.id.trim() === conversationId.trim()
          ? "self"
          : (composerRef.current?.insertConversationMention(reference) ?? "disabled");
      showConversationDropNotice(result);
      return result;
    },
    [canDropConversationReference, composerRef, conversationId, showConversationDropNotice],
  );

  const clearConversationDropState = useCallback(() => {
    conversationDragDepthRef.current = 0;
    setConversationDropReference(null);
  }, []);

  useEffect(() => {
    const card = glassCardRef.current;
    if (!card) return;
    return registerConversationReferenceDropZone(card, {
      conversationId,
      enabled: canDropConversationReference,
      onHover(reference, active) {
        if (active) setConversationDropNotice(null);
        setConversationDropReference(
          active && canDropConversationReference && reference.id !== conversationId
            ? reference
            : null,
        );
      },
      onDrop(reference) {
        const result = insertConversationReference(reference);
        clearConversationDropState();
        return result;
      },
    });
  }, [
    canDropConversationReference,
    clearConversationDropState,
    conversationId,
    insertConversationReference,
  ]);

  useEffect(() => {
    if (!conversationDropNotice) return;
    const timeout = window.setTimeout(
      () => setConversationDropNotice(null),
      CONVERSATION_DROP_NOTICE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [conversationDropNotice]);

  const conversationDropNoticeText = conversationDropNotice
    ? conversationDropNotice.result === "self"
      ? t("chat.conversationReference.self")
      : conversationDropNotice.result === "duplicate"
        ? t("chat.conversationReference.duplicate")
        : conversationDropNotice.result === "limit"
          ? t("chat.conversationReference.limit")
          : conversationDropNotice.result === "invalid"
            ? t("chat.conversationReference.invalid")
            : t("chat.conversationReference.disabled")
    : null;

  const handleConversationDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasConversationReferenceDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      conversationDragDepthRef.current += 1;
      const reference =
        readConversationReferenceDragPayload(event.dataTransfer) ??
        getActiveConversationReferenceDrag();
      if (canDropConversationReference && reference?.id !== conversationId) {
        setConversationDropReference(reference);
      }
    },
    [canDropConversationReference, conversationId],
  );

  const handleConversationDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasConversationReferenceDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleConversationDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasConversationReferenceDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    conversationDragDepthRef.current = Math.max(0, conversationDragDepthRef.current - 1);
    if (conversationDragDepthRef.current === 0) setConversationDropReference(null);
  }, []);

  const handleConversationDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasConversationReferenceDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const reference = readConversationReferenceDragPayload(event.dataTransfer);
      if (reference) {
        insertConversationReference(reference);
      } else {
        showConversationDropNotice("invalid");
      }
      clearConversationDropState();
    },
    [clearConversationDropState, insertConversationReference, showConversationDropNotice],
  );

  const handleComposerDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (hasWorkspacePathDragPayload(event.dataTransfer)) {
        handleWorkspacePathDragOver(event);
        return;
      }
      handleConversationDragEnter(event);
    },
    [handleConversationDragEnter, handleWorkspacePathDragOver],
  );

  const handleComposerDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (hasWorkspacePathDragPayload(event.dataTransfer)) {
        handleWorkspacePathDragOver(event);
        return;
      }
      handleConversationDragOver(event);
    },
    [handleConversationDragOver, handleWorkspacePathDragOver],
  );

  const handleComposerDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (hasWorkspacePathDragPayload(event.dataTransfer)) {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setWorkspacePathDropState(null);
        return;
      }
      handleConversationDragLeave(event);
    },
    [handleConversationDragLeave],
  );

  const handleComposerDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (hasWorkspacePathDragPayload(event.dataTransfer)) {
        handleWorkspacePathDrop(event);
        return;
      }
      handleConversationDrop(event);
    },
    [handleConversationDrop, handleWorkspacePathDrop],
  );

  const toggleQueueCollapsed = useCallback(() => {
    setQueueCollapsed((current) => !current);
  }, []);

  useLayoutEffect(() => {
    const previousCount = previousPendingUploadCountRef.current;
    previousPendingUploadCountRef.current = pendingUploadedFiles.length;
    if (pendingUploadedFiles.length <= previousCount) return;

    const attachmentList = attachmentListRef.current;
    if (attachmentList) attachmentList.scrollLeft = attachmentList.scrollWidth;
  }, [pendingUploadedFiles.length]);

  // The ref and state are updated together: the RO callback for height reporting may run before the
  // effect, so the latest expanded state must be readable before the layout changes. The card's
  // current height is recorded before toggling, and after the layout flips the FLIP effect smoothly
  // transitions from the old height to the new one.
  const setComposerExpanded = useCallback((next: boolean) => {
    if (next === isComposerExpandedRef.current) return;
    expandFromHeightRef.current = glassCardRef.current?.getBoundingClientRect().height ?? null;
    isComposerExpandedRef.current = next;
    setIsComposerExpanded(next);
  }, []);

  // FLIP: the layout has settled at the target state; pin the card height to the animated value with
  // a min/max double clamp, smoothly transitioning from the old height to the new one. You cannot
  // animate `height` directly -- in the expanded state the card is flex-1 (basis 0), so flex ignores
  // `height`; min/max constraints are respected by both layouts.
  // biome-ignore lint/correctness/useExhaustiveDependencies(isComposerExpanded): the function body does not read it, but it is exactly the "layout has flipped" trigger signal.
  useLayoutEffect(() => {
    const card = glassCardRef.current;
    const fromHeight = expandFromHeightRef.current;
    expandFromHeightRef.current = null;
    if (!card || fromHeight === null || typeof card.animate !== "function") return;
    if (prefersReducedMotion()) return;

    expandAnimationRef.current?.cancel();
    const toHeight = card.getBoundingClientRect().height;
    if (Math.abs(toHeight - fromHeight) < 1) return;

    const animation = card.animate(
      [
        { minHeight: `${fromHeight}px`, maxHeight: `${fromHeight}px` },
        { minHeight: `${toHeight}px`, maxHeight: `${toHeight}px` },
      ],
      { duration: COMPOSER_EXPAND_ANIMATION_MS, easing: COMPOSER_EXPAND_EASING },
    );
    expandAnimationRef.current = animation;
    const clear = () => {
      if (expandAnimationRef.current === animation) {
        expandAnimationRef.current = null;
      }
      // Height reporting in the restore direction is frozen during the animation, so measure once more after it settles.
      scheduleHeightMeasureRef.current?.();
      scheduleComposerOverflowMeasureRef.current?.();
    };
    animation.onfinish = clear;
    animation.oncancel = clear;
  }, [isComposerExpanded]);

  useEffect(() => () => expandAnimationRef.current?.cancel(), []);

  const toggleComposerExpanded = useCallback(() => {
    setComposerExpanded(!isComposerExpandedRef.current);
    composerRef.current?.focus();
  }, [composerRef, setComposerExpanded]);

  // Clarify session: the panel is usable as soon as it opens and discarded on close (design doc: not persisted).
  const [clarifyOpen, setClarifyOpen] = useState(false);
  const applyClarifyFinal = useCallback(
    (finalText: string) => {
      const composer = composerRef.current;
      if (!composer) return;
      // Only the text segment is replaced: attachment/mention chips are preserved as-is (design doc
      // "final draft into the box"). setDraft rebuilds the DOM from segments, so stale derived fields
      // are ignored.
      const draft = composer.getDraft();
      const preserved = draft.segments.filter((segment) => segment.type !== "text");
      // The final draft may be empty: in that case do not insert an empty text segment, only keep the original attachments/mentions.
      composer.setDraft({
        ...draft,
        segments:
          finalText.trim().length > 0
            ? [{ type: "text", text: finalText }, ...preserved]
            : preserved,
      });
      setClarifyOpen(false);
      composer.focus();
    },
    [composerRef],
  );
  const clarifySession = useClarifySession(
    runClarifyTurn ?? unavailableClarifyTurn,
    clarifyContext,
    { onFinal: applyClarifyFinal },
  );
  const clarifyEnabled = Boolean(runClarifyTurn) && hasModels;
  // composerHasClarifiableText is already set to false synchronously when emptiness flips, so there is no need to also combine composerIsEmpty.
  const clarifyButtonDisabled = !clarifyEnabled || !composerHasClarifiableText;
  const handleClarifyToggle = useCallback(() => {
    if (!clarifyEnabled) return;
    if (clarifyOpen) {
      clarifySession.close();
      setClarifyOpen(false);
      return;
    }
    const composer = composerRef.current;
    const draftText = composer?.getDraft().textWithoutLargePastes.trim() || "";
    if (!draftText) {
      // Fallback for an inaccurate predicate (programmatic edits do not fire input events): if no
      // clarifiable text is found at click time, flip the button to disabled and expose its disabled
      // title, rather than silently swallowing the click.
      setComposerHasClarifiableText(false);
      return;
    }
    setClarifyOpen(true);
    clarifySession.start(draftText);
  }, [clarifyEnabled, clarifyOpen, composerRef, clarifySession.start, clarifySession.close]);

  // Discard an in-progress clarification when switching conversations (the component remounts by
  // conversationId, but close it explicitly to be safe).
  // biome-ignore lint/correctness/useExhaustiveDependencies(conversationId): conversationId is the trigger signal: the effect body does not read it, but the conversation switch relies on it to re-run and discard the in-progress clarification.
  useEffect(() => {
    clarifySession.close();
    setClarifyOpen(false);
  }, [conversationId, clarifySession.close]);

  /** Exits the full-height editing state after sending (including queueing), making way for the reply content. */
  const handleComposerSend = useCallback(() => {
    // Sending is disabled while clarifying: avoid sending a half-finished draft (design doc "interaction").
    if (clarifyOpen) return;
    setComposerExpanded(false);
    onSend();
  }, [clarifyOpen, onSend, setComposerExpanded]);

  useEffect(() => {
    const editor = glassCardRef.current?.querySelector<HTMLElement>(".mention-composer");
    if (!editor) return;

    let animationFrame: number | null = null;
    const measureOverflow = () => {
      animationFrame = null;
      // The expanded editor area has a larger viewport, and must not overwrite the normal-state
      // overflow result; otherwise the button would vanish immediately after expanding and the user
      // would be unable to restore it.
      if (isComposerExpandedRef.current || expandAnimationRef.current) return;
      const nextHasOverflow = editor.scrollHeight - editor.clientHeight > 1;
      setComposerHasOverflow((current) =>
        current === nextHasOverflow ? current : nextHasOverflow,
      );
    };
    const scheduleMeasure = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(measureOverflow);
    };

    scheduleComposerOverflowMeasureRef.current = scheduleMeasure;
    scheduleMeasure();
    editor.addEventListener("input", scheduleMeasure);
    window.addEventListener("resize", scheduleMeasure);

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(editor);
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(scheduleMeasure);
    mutationObserver?.observe(editor, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      if (scheduleComposerOverflowMeasureRef.current === scheduleMeasure) {
        scheduleComposerOverflowMeasureRef.current = null;
      }
      editor.removeEventListener("input", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, []);

  const showComposerExpandToggle = isComposerExpanded || composerHasOverflow;

  const shouldShowQueueScrollbar = !queueCollapsed && queuedTurns.length > 2;

  const updateQueueScrollbar = useCallback(() => {
    const list = queueListRef.current;
    if (!list || !shouldShowQueueScrollbar) {
      setQueueScrollbar((current) => (current.visible ? DEFAULT_QUEUE_SCROLLBAR_STATE : current));
      return;
    }

    const { clientHeight, scrollHeight, scrollTop } = list;
    const trackHeight = Math.max(clientHeight, QUEUE_SCROLLBAR_MIN_THUMB_HEIGHT);
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const thumbHeight =
      maxScrollTop <= 1
        ? trackHeight
        : Math.min(
            trackHeight,
            Math.max(
              QUEUE_SCROLLBAR_MIN_THUMB_HEIGHT,
              Math.round((clientHeight / scrollHeight) * trackHeight),
            ),
          );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxScrollTop <= 1 ? 0 : Math.round((scrollTop / maxScrollTop) * maxThumbTop);

    setQueueScrollbar((current) => {
      if (current.visible && current.thumbHeight === thumbHeight && current.thumbTop === thumbTop) {
        return current;
      }
      return { visible: true, thumbHeight, thumbTop };
    });
  }, [shouldShowQueueScrollbar]);

  const scrollQueueToThumbPosition = useCallback(
    (clientY: number) => {
      const list = queueListRef.current;
      const track = queueScrollbarTrackRef.current;
      if (!list || !track || !shouldShowQueueScrollbar) return;

      const rect = track.getBoundingClientRect();
      const maxThumbTop = Math.max(1, rect.height - queueScrollbar.thumbHeight);
      const nextThumbTop = Math.min(
        Math.max(clientY - rect.top - queueScrollbar.thumbHeight / 2, 0),
        maxThumbTop,
      );
      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      list.scrollTop = (nextThumbTop / maxThumbTop) * maxScrollTop;
      updateQueueScrollbar();
    },
    [queueScrollbar.thumbHeight, shouldShowQueueScrollbar, updateQueueScrollbar],
  );

  const handleQueueScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!shouldShowQueueScrollbar || event.button !== 0) return;
      const list = queueListRef.current;
      const track = queueScrollbarTrackRef.current;
      if (!list || !track) return;

      event.preventDefault();
      const target = event.target as HTMLElement;
      if (!target.closest(".chat-queue-scrollbar-thumb")) {
        scrollQueueToThumbPosition(event.clientY);
      }

      queueScrollbarDragRef.current = {
        pointerId: event.pointerId,
        startScrollTop: list.scrollTop,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [shouldShowQueueScrollbar, scrollQueueToThumbPosition],
  );

  const handleQueueScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = queueScrollbarDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const list = queueListRef.current;
      const track = queueScrollbarTrackRef.current;
      if (!list || !track) return;

      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      const maxThumbTop = Math.max(1, track.clientHeight - queueScrollbar.thumbHeight);
      list.scrollTop =
        drag.startScrollTop + ((event.clientY - drag.startY) / maxThumbTop) * maxScrollTop;
      updateQueueScrollbar();
    },
    [queueScrollbar.thumbHeight, updateQueueScrollbar],
  );

  const handleQueueScrollbarPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = queueScrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    queueScrollbarDragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  useEffect(() => {
    const hasQueuedTurns = queuedTurns.length > 0;
    if (hasQueuedTurns && !queueHadTurnsRef.current) {
      setQueueCollapsed(false);
    }
    queueHadTurnsRef.current = hasQueuedTurns;
  }, [queuedTurns.length]);

  useEffect(() => {
    const list = queueListRef.current;
    if (!list) {
      updateQueueScrollbar();
      return;
    }

    updateQueueScrollbar();
    list.addEventListener("scroll", updateQueueScrollbar, { passive: true });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateQueueScrollbar);
    resizeObserver?.observe(list);
    window.addEventListener("resize", updateQueueScrollbar);

    return () => {
      list.removeEventListener("scroll", updateQueueScrollbar);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateQueueScrollbar);
    };
  }, [updateQueueScrollbar]);

  useEffect(() => {
    const composerLayer = composerLayerRef.current;
    if (!composerLayer) return;

    if (surface === "desktop") {
      if (!onHeightChange && !onFloatingOverhangChange && !onCenterOffsetChange) return;

      let animationFrame: number | null = null;
      const measure = () => {
        animationFrame = null;
        if (isComposerExpandedRef.current || expandAnimationRef.current) return;
        const metrics = measureComposerOverlay({
          layer: composerLayer.getBoundingClientRect(),
          queueHeight: queuePanelRef.current?.getBoundingClientRect().height ?? 0,
          floating: taskProgressBarElement?.getBoundingClientRect(),
          column: composerColumnRef.current?.getBoundingClientRect(),
        });
        onHeightChange?.(metrics.heightPx);
        onFloatingOverhangChange?.(metrics.floatingOverhangPx);
        onCenterOffsetChange?.(metrics.centerOffsetPx);
      };
      const scheduleMeasure = () => {
        if (animationFrame !== null) return;
        animationFrame = window.requestAnimationFrame(measure);
      };
      scheduleHeightMeasureRef.current = scheduleMeasure;
      scheduleMeasure();

      const resizeObserver =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
      resizeObserver?.observe(composerLayer);
      // The card column width follows the body width setting and can change independently while the composerLayer size stays the same.
      if (composerColumnRef.current) resizeObserver?.observe(composerColumnRef.current);
      // The pill container is absolutely positioned outside the card column, so appearing/disappearing does not change the composerLayer size.
      if (taskProgressBarElement) resizeObserver?.observe(taskProgressBarElement);
      window.addEventListener("resize", scheduleMeasure);

      return () => {
        if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
        if (scheduleHeightMeasureRef.current === scheduleMeasure) {
          scheduleHeightMeasureRef.current = null;
        }
        resizeObserver?.disconnect();
        window.removeEventListener("resize", scheduleMeasure);
        onHeightChange?.(0);
        onFloatingOverhangChange?.(0);
        onCenterOffsetChange?.(0);
      };
    }

    const chatFrame = composerLayer.closest(".gateway-chat-frame");
    if (!(chatFrame instanceof HTMLElement)) return;

    const updateComposerOverlayHeight = () => {
      // The expanded state fills the chat area; keep the most recent normal height so the bottom
      // reservation does not jump. During the expand/restore animation the height is an intermediate
      // value, so it is also not reported; measure once more after the animation ends.
      if (isComposerExpandedRef.current || expandAnimationRef.current) return;
      const composerLayerHeight = composerLayer.getBoundingClientRect().height;
      const queueHeight = queuePanelRef.current?.getBoundingClientRect().height ?? 0;
      chatFrame.style.setProperty(
        "--gateway-chat-composer-overlay-height",
        `${Math.ceil(Math.max(0, composerLayerHeight - queueHeight))}px`,
      );
    };
    scheduleHeightMeasureRef.current = updateComposerOverlayHeight;

    updateComposerOverlayHeight();

    if (typeof ResizeObserver === "undefined") {
      return () => {
        scheduleHeightMeasureRef.current = null;
        chatFrame.style.removeProperty("--gateway-chat-composer-overlay-height");
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      updateComposerOverlayHeight();
    });
    resizeObserver.observe(composerLayer);

    return () => {
      scheduleHeightMeasureRef.current = null;
      resizeObserver.disconnect();
      chatFrame.style.removeProperty("--gateway-chat-composer-overlay-height");
    };
  }, [
    onHeightChange,
    onFloatingOverhangChange,
    onCenterOffsetChange,
    surface,
    taskProgressBarElement,
  ]);

  return (
    <div
      ref={composerLayerRef}
      className={cn(
        surface === "desktop"
          ? "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-5 pb-4"
          : "gateway-composer-layer pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center",
        isComposerExpanded && (surface === "desktop" ? "top-14" : "top-0 pt-3"),
        hidden && "hidden",
      )}
    >
      {/* Fallback opaque strip for the layer's bottom 16px floating padding (desktop pb-4 / web
          --gateway-chat-composer-bottom): the reading skirt only covers down to the bottom edge of
          the reading row, and scrolling body content would peek through this gap. Shared by both
          ends, with no surface branch. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-background"
        style={{ height: "1rem" }}
      />
      {/* Desktop aligns to the assistant message body: transcript px-5 + px-5
          = 40px removed from the column, and the column itself already gives
          back the retired 40px avatar rail. The card extends 2px past each
          edge of the body so scrolling content cannot peek around its rounded
          lower corners. */}
      <div
        ref={composerColumnRef}
        className={cn(
          surface === "desktop"
            ? "pointer-events-auto relative w-[calc(100%-2.25rem)] max-w-[calc(var(--chat-transcript-content-width,768px)-4.75rem)]"
            : "gateway-chat-column pointer-events-auto relative",
          // justify-end: while the expand animation pins the card at an intermediate height, stay flush to the bottom and grow upward.
          isComposerExpanded && "flex min-h-0 flex-col justify-end",
        )}
      >
        {taskProgressBar ? (
          <div
            ref={setTaskProgressBarElement}
            className="pointer-events-none absolute inset-x-0 bottom-full z-40 mb-3 flex justify-center px-3"
          >
            {taskProgressBar}
          </div>
        ) : null}
        {queuedTurns.length > 0 ? (
          <div
            ref={queuePanelRef}
            className="relative z-30 mx-auto mb-[-1px] w-[calc(100%-1.5rem)]"
          >
            <div
              aria-hidden={queueCollapsed}
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                queueCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="rounded-t-lg border border-b-0 border-black/[0.055] bg-white/70 px-1 pb-1 pt-2 shadow-[0_8px_24px_-18px_rgba(15,23,42,0.24),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-2xl backdrop-saturate-[165%] dark:border-white/[0.10] dark:bg-white/[0.06] dark:shadow-[0_8px_24px_-18px_rgba(0,0,0,0.72),inset_0_1px_0_rgba(255,255,255,0.08)]">
                  <div className="relative min-h-0">
                    <ul
                      ref={queueListRef}
                      data-scrollable={queuedTurns.length > 2 ? "true" : "false"}
                      className={cn(
                        "chat-queue-scroll flex min-w-0 flex-col gap-1 overflow-x-hidden",
                        queuedTurns.length > 2
                          ? "h-[76px] overflow-y-scroll pr-3"
                          : "max-h-[76px] overflow-y-hidden pr-1",
                      )}
                    >
                      {queuedTurns.map((item, index) => (
                        <li
                          key={item.id}
                          className="relative grid h-9 min-h-9 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border border-black/[0.035] bg-white/42 px-2 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.56)] backdrop-blur-xl backdrop-saturate-[150%] transition-[border-color,background-color] dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                        >
                          <div className="flex shrink-0 items-center gap-0.5">
                            {index > 0 ? (
                              <button
                                type="button"
                                disabled={queueCollapsed}
                                onClick={() => onMoveQueuedTurnUp(item.id)}
                                aria-label={t("chat.queue.moveUp")}
                                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
                              >
                                <ChevronUp className="h-3 w-3" />
                              </button>
                            ) : (
                              <span aria-hidden className="h-6 w-6" />
                            )}
                            <Clock3 className="h-3 w-3 shrink-0 text-muted-foreground/65" />
                          </div>
                          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                            <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[calc(11px*var(--zone-font-scale,1))] leading-4 text-foreground/88">
                              {item.previewText || t("chat.queue.emptyMessage")}
                            </span>
                            {item.fileCount > 0 ? (
                              <span className="max-w-[4.5rem] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[calc(9px*var(--zone-font-scale,1))] leading-4 text-muted-foreground">
                                {t("chat.queue.fileCount").replace(
                                  "{count}",
                                  String(item.fileCount),
                                )}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <RuntimeControlTooltip label={t("chat.queue.edit")}>
                              <button
                                type="button"
                                disabled={queueCollapsed}
                                onClick={() => onEditQueuedTurn(item.id)}
                                aria-label={t("chat.queue.edit")}
                                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                              >
                                <SquarePen className="h-3 w-3" />
                              </button>
                            </RuntimeControlTooltip>
                            <RuntimeControlTooltip label={t("chat.queue.runNow")}>
                              <button
                                type="button"
                                disabled={queueCollapsed}
                                onClick={() => onRunQueuedTurnNow(item.id)}
                                aria-label={t("chat.queue.runNow")}
                                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                              >
                                <Play className="h-3 w-3" />
                              </button>
                            </RuntimeControlTooltip>
                            <RuntimeControlTooltip label={t("chat.queue.delete")}>
                              <button
                                type="button"
                                disabled={queueCollapsed}
                                onClick={() => onRemoveQueuedTurn(item.id)}
                                aria-label={t("chat.queue.delete")}
                                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </RuntimeControlTooltip>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {shouldShowQueueScrollbar ? (
                      <div
                        ref={queueScrollbarTrackRef}
                        aria-hidden
                        className="chat-queue-scrollbar"
                        onPointerCancel={handleQueueScrollbarPointerUp}
                        onPointerDown={handleQueueScrollbarPointerDown}
                        onPointerMove={handleQueueScrollbarPointerMove}
                        onPointerUp={handleQueueScrollbarPointerUp}
                      >
                        <div
                          className="chat-queue-scrollbar-thumb"
                          style={{
                            height: `${queueScrollbar.thumbHeight}px`,
                            transform: `translateY(${queueScrollbar.thumbTop}px)`,
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={toggleQueueCollapsed}
              title={toggleQueueTooltip}
              aria-label={toggleQueueTooltip}
              aria-expanded={!queueCollapsed}
              className="absolute left-1/2 top-0 z-40 inline-flex h-[18px] -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-black/[0.07] bg-white/90 pl-1.5 pr-2 text-muted-foreground shadow-[0_2px_10px_-4px_rgba(15,23,42,0.45),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-xl backdrop-saturate-150 transition-[background-color,color,scale] hover:bg-white hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:border-white/[0.12] dark:bg-zinc-900/90 dark:shadow-[0_2px_10px_-4px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.10)] dark:hover:bg-zinc-900"
            >
              {queueCollapsed ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronUp className="h-3 w-3" />
              )}
              <span className="text-[calc(10px*var(--zone-font-scale,1))] font-medium leading-none tabular-nums">
                {queuedTurns.length}
              </span>
            </button>
          </div>
        ) : null}

        {approvalBar}
        {/* The clarify panel floats directly above the input card (previously an inline card
            section): at the same level as the queue panel, sitting right on the card's top edge. It
            likewise yields when the approval panel takes over the input area. */}
        {clarifyOpen && runClarifyTurn && approvalBar == null ? (
          <ClarifyPanel
            state={clarifySession.state}
            busy={clarifySession.state.status === "asking"}
            onSubmitAnswers={clarifySession.submitAnswers}
            onGenerateNow={clarifySession.generateNow}
            onRetry={clarifySession.retry}
            onClose={() => {
              clarifySession.close();
              setClarifyOpen(false);
            }}
          />
        ) : null}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape capture is active only in the expanded state, focus stays on the inner textbox, and the wrapper does not participate in the Tab order. */}
        <div
          hidden={approvalBar != null}
          ref={glassCardRef}
          data-file-upload-drop-zone=""
          data-file-upload-conversation-id={conversationId}
          data-workspace-path-drop-zone={workspacePathDropState ?? "idle"}
          data-conversation-reference-drop-zone={
            canDropConversationReference ? "enabled" : "disabled"
          }
          data-conversation-reference-drop-conversation-id={conversationId}
          onDragEnter={handleComposerDragEnter}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={handleComposerDrop}
          onKeyDown={
            isComposerExpanded
              ? (event) => {
                  // The mention popover calls preventDefault when it consumes Escape, so yield here.
                  if (event.key === "Escape" && !event.defaultPrevented) {
                    setComposerExpanded(false);
                  }
                }
              : undefined
          }
          className={cn(
            // The transition covers only focus-within color/shadow; transition-all cannot be used --
            // toggling flex-grow in the expanded state would be animated too, causing the card to jump
            // to the top and then fill out in a flicker. Always flex-col: when the FLIP animation pins
            // the card at an intermediate height, the flex-1 editor area absorbs the extra space, so
            // the toolbar can stay flush with the card's bottom edge throughout.
            "composer-glass-card @container relative flex flex-col overflow-hidden rounded-4xl border border-border/65 bg-muted shadow-[0_18px_44px_-34px_color-mix(in_oklch,var(--foreground)_42%,transparent)] transition-[border-color,box-shadow] focus-within:border-border focus-within:shadow-[0_20px_48px_-34px_color-mix(in_oklch,var(--foreground)_48%,transparent)]",
            surface === "desktop" && "z-10",
            isComposerExpanded && "min-h-0 flex-1",
          )}
        >
          {workspacePathDropState ? (
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed bg-background/90 text-sm font-medium backdrop-blur-sm",
                workspacePathDropState === "accept"
                  ? "border-sky-500/70 text-sky-600 dark:text-sky-300"
                  : "border-destructive/60 text-destructive",
              )}
            >
              {workspacePathDropState === "accept"
                ? t("chat.workspacePathDrop.reference")
                : t("chat.workspacePathDrop.crossProject")}
            </div>
          ) : conversationDropReference ? (
            <div className="pointer-events-none absolute inset-1 z-50 flex items-center justify-center rounded-3xl border border-dashed border-primary/45 bg-background/88 px-6 text-center shadow-inner backdrop-blur-sm">
              <span className="max-w-full truncate rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
                {t("chat.conversationReference.drop").replace(
                  "{title}",
                  conversationDropReference.title,
                )}
              </span>
            </div>
          ) : conversationDropNoticeText ? (
            <div className="pointer-events-none absolute inset-1 z-50 flex items-center justify-center rounded-3xl border border-dashed border-amber-500/45 bg-background/90 px-6 text-center shadow-inner backdrop-blur-sm">
              <span className="max-w-full rounded-full bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                {conversationDropNoticeText}
              </span>
            </div>
          ) : null}
          <div
            className={cn(
              "composer-input-surface relative z-10 flex flex-col overflow-hidden rounded-4xl bg-background",
              isComposerExpanded && "min-h-0 flex-1",
            )}
          >
            {pendingUploadedFiles.length > 0 ? (
              <div
                ref={attachmentListRef}
                className="upload-file-list relative z-10 flex shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden pb-1 pl-4 pr-12 pt-2"
              >
                {pendingUploadedFiles.map((file) => (
                  <PendingComposerAttachment
                    key={`${file.relativePath}-${file.absolutePath ?? file.fileName}`}
                    file={file}
                    workdir={workdir}
                    disabled={controlsDisabled}
                    removeLabel={t("chat.upload.removeFile")}
                    previewLabel={t("chat.upload.previewImage")}
                    closePreviewLabel={t("chat.upload.closePreview")}
                    imagePreviewLoader={onLoadUploadedImagePreview}
                    onRemove={onRemovePendingUpload}
                  />
                ))}
              </div>
            ) : null}

            {showComposerExpandToggle ? (
              <button
                type="button"
                onClick={toggleComposerExpanded}
                title={toggleComposerExpandTooltip}
                aria-label={toggleComposerExpandTooltip}
                aria-expanded={isComposerExpanded}
                className="absolute right-3 top-2 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full bg-clip-content p-0.5 text-muted-foreground/70 outline-hidden transition-[background-color,color,scale] hover:bg-muted/60 hover:text-foreground active:scale-90 focus-visible:bg-muted/60"
              >
                {isComposerExpanded ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </button>
            ) : null}

            {/* Always flex-1: when the animation pins the card at an intermediate height, this area
              absorbs the flexing, so the toolbar stays flush with the card's bottom edge throughout.
              min-h-0 is added only in the expanded state -- the collapsed state relies on the automatic
              minimum height (= the editor's clamped height) to support the card's intrinsic height, and
              adding it would collapse it.

              pr-12 makes room for the expand button in the top-right. The allowance must be made on
              this container, **not by giving the editor pr-8 alone** -- padding does not change the
              scrollbar position (the scrollbar is always flush with the border box's right edge), so it
              would block text but not the scrollbar, and when overflowing that 6px track would sit
              directly on the expand icon. Narrowing the editor's border box is what pushes the
              scrollbar left of the button. */}
            <div
              className={cn(
                "relative flex flex-1 pl-4 pr-12",
                pendingUploadedFiles.length > 0 ? "pt-1.5" : "pt-3",
                isComposerExpanded && "min-h-0",
              )}
              onFocusCapture={onPrepareChatRuntime}
              onInput={handleComposerInput}
            >
              <MentionComposer
                ref={composerRef}
                onSend={handleComposerSend}
                onEmptyChange={handleComposerEmptyChange}
                onBusyChange={onComposerBusyChange}
                onPasteFiles={onPasteFiles}
                loadHistoryPrompts={loadHistoryPrompts}
                placeholder={inputPlaceholder}
                disabled={isInputDisabled}
                workdir={workdir}
                enabledSkills={enabledSkills}
                conversationMentionsEnabled={isAgentExecutionMode(executionMode)}
                conversations={
                  isAgentExecutionMode(executionMode)
                    ? mentionableConversations.filter((item) => item.id !== conversationId)
                    : []
                }
                searchConversations={
                  isAgentExecutionMode(executionMode) ? searchMentionableConversations : undefined
                }
                currentConversationId={conversationId}
                mentionApps={mentionApps}
                className={cn(
                  // The right allowance is handled uniformly by the outer container's pr-12 (see above),
                  // so no pr is added here -- the editor's own right padding would only push text aside
                  // and leave the scrollbar pressing on the control column. min-h overrides the editor's
                  // default 70px, reserving height budget for the conversation stats bar below the card.
                  "min-h-[60px] px-0 py-0",
                  isComposerExpanded &&
                    (surface === "desktop" ? "h-full max-h-none" : "h-full! max-h-none!"),
                )}
              />
            </div>

            <div className="relative flex items-center justify-between gap-2 px-3 pb-2 pt-0.5">
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        disabled={composerAddMenuDisabled}
                        aria-label={addMenuTooltip}
                        title={addMenuTooltip}
                        className={cn(
                          "composer-toolbar-action relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 data-[popup-open]:bg-muted/60",
                          "disabled:pointer-events-none disabled:opacity-40",
                          pendingUploadedFiles.length > 0
                            ? "text-sky-600 hover:text-sky-700 dark:text-sky-300 dark:hover:text-sky-200"
                            : "text-muted-foreground hover:text-foreground dark:hover:text-white",
                        )}
                      />
                    }
                  >
                    {isUploadingFiles ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    {pendingUploadedFiles.length > 0 ? (
                      <span
                        aria-hidden
                        className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-sky-500 px-[3px] text-[calc(9px*var(--zone-font-scale,1))] font-semibold leading-none text-white shadow-[0_0_0_1.5px_rgba(255,255,255,0.95)] dark:bg-sky-400 dark:text-slate-900 dark:shadow-[0_0_0_1.5px_rgba(20,22,28,0.9)]"
                      >
                        {pendingUploadedFiles.length}
                      </span>
                    ) : null}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="composer-add-dropdown flex w-60 flex-col overflow-hidden p-1"
                    side="top"
                    align="start"
                  >
                    <DropdownMenuLabel className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
                      {t("chat.upload.addSection")}
                    </DropdownMenuLabel>
                    <DropdownMenuItem
                      onSelect={onPickReadableFiles}
                      disabled={uploadDisabled}
                      className="composer-safety-item items-center gap-2 rounded-md py-1.5 text-xs"
                    >
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium leading-5">{t("chat.upload.files")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={onPickWorkspaceFolder}
                      disabled={uploadDisabled}
                      className="composer-safety-item items-center gap-2 rounded-md py-1.5 text-xs"
                    >
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium leading-5">{t("chat.upload.folder")}</span>
                    </DropdownMenuItem>
                    {isAgentMode ? (
                      // Plan mode toggle row: the whole row is the toggle, with a mini switch on the
                      // right showing state. closeOnClick=false lets the toggle take effect in place -- the
                      // switch animation is visible and the menu does not bounce; the behavior note is
                      // demoted to a hover tooltip and no longer crowds the small inline text.
                      <DropdownMenuItem
                        closeOnClick={false}
                        role="menuitemcheckbox"
                        aria-checked={chatRuntimeControls.planModeEnabled}
                        title={t("chat.runtime.planModeHint")}
                        onSelect={() =>
                          onChatRuntimeControlsChange({
                            planModeEnabled: !chatRuntimeControls.planModeEnabled,
                          })
                        }
                        className="composer-safety-item items-center gap-2 rounded-md py-1.5 text-xs"
                      >
                        <Lightbulb
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 transition-colors",
                            chatRuntimeControls.planModeEnabled
                              ? "text-sky-600 dark:text-sky-300"
                              : "text-muted-foreground",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate font-medium leading-5">
                          {t("chat.runtime.planModeTitle")}
                        </span>
                        {/* Visual switch (aria is handled by the row's menuitemcheckbox): uses the same
                          sky color scheme as the plan pill, so the state is instantly readable. */}
                        <span
                          aria-hidden
                          className={cn(
                            "ml-auto inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors",
                            chatRuntimeControls.planModeEnabled
                              ? "bg-sky-500 dark:bg-sky-400"
                              : "bg-muted-foreground/25",
                          )}
                        >
                          <span
                            className={cn(
                              "block h-3.5 w-3.5 translate-x-[2px] rounded-full bg-white shadow-sm transition-transform dark:bg-slate-100",
                              chatRuntimeControls.planModeEnabled && "translate-x-4",
                            )}
                          />
                        </span>
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Plan-mode-on indicator (Codex-style pill): instantly visible, click to turn off. */}
                {isAgentMode && chatRuntimeControls.planModeEnabled ? (
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={() => onChatRuntimeControlsChange({ planModeEnabled: false })}
                    title={t("chat.runtime.planModeSlashOff")}
                    aria-label={t("chat.runtime.planModeSlashOff")}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 text-[11px] font-medium text-sky-700 outline-hidden transition-colors hover:bg-sky-500/15 focus-visible:ring-2 focus-visible:ring-primary/35 disabled:pointer-events-none disabled:opacity-40 dark:text-sky-300"
                  >
                    <Lightbulb className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{t("chat.runtime.planMode")}</span>
                  </button>
                ) : null}

                {clarifyEnabled ? (
                  <RuntimeControlTooltip label={t("chat.clarify.title")}>
                    <button
                      type="button"
                      disabled={clarifyButtonDisabled}
                      onClick={handleClarifyToggle}
                      aria-label={t("chat.clarify.title")}
                      aria-pressed={clarifyOpen}
                      title={clarifyButtonDisabled ? t("chat.clarify.buttonDisabled") : undefined}
                      className={cn(
                        "composer-toolbar-action inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
                        "disabled:pointer-events-none disabled:opacity-40",
                        clarifyOpen && "bg-muted/60 text-foreground",
                      )}
                    >
                      <WandSparkles className="h-4 w-4" />
                    </button>
                  </RuntimeControlTooltip>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <Button
                  disabled={isSending ? false : sendDisabled}
                  onClick={() => {
                    if (canQueueDraftWhileSending) {
                      handleComposerSend();
                      return;
                    }
                    if (isSending) {
                      onStop();
                      return;
                    }
                    if (sendDisabled) return;
                    handleComposerSend();
                  }}
                  size="sm"
                  title={primaryActionTitle}
                  aria-label={primaryActionTitle}
                  style={
                    canQueueDraftWhileSending
                      ? {
                          backgroundColor: "hsl(160 84% 39%)",
                          backgroundImage: "none",
                          color: "white",
                        }
                      : isSending
                        ? {
                            backgroundColor: "hsl(var(--destructive))",
                            backgroundImage: "none",
                            color: "hsl(var(--destructive-foreground))",
                          }
                        : undefined
                  }
                  className={cn(
                    // The click area stays 32px; via p-0.5 + bg-clip-content the background paints only a
                    // 28px inner circle, the same size as the usage ring's outer diameter and the expand
                    // button's hover circle, so the solid disc does not look oversized.
                    "h-8 w-8 shrink-0 rounded-full border-0 bg-clip-content p-0.5 shadow-none transition-all [&_svg]:stroke-[2.25]",
                    canQueueDraftWhileSending
                      ? "hover:brightness-105 active:scale-95"
                      : isSending
                        ? "hover:opacity-90 active:scale-95"
                        : "disabled:opacity-100 [&:not(:disabled)]:bg-foreground [&:not(:disabled)]:text-background [&:not(:disabled)]:hover:bg-foreground/85 [&:not(:disabled)]:active:scale-95 disabled:bg-muted/60 disabled:text-muted-foreground",
                  )}
                >
                  {canQueueDraftWhileSending ? (
                    <ArrowUp className="h-4 w-4" />
                  ) : isSending ? (
                    <Square className="h-3 w-3 fill-current" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>

          <div className="composer-control-deck relative z-0 flex min-h-9 shrink-0 items-center justify-between gap-2 bg-muted px-3 py-1">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {isAgentMode && commandSafetyMode && onCommandSafetyModeChange ? (
                <CommandSafetyModeSelector
                  value={commandSafetyMode}
                  disabled={controlsDisabled}
                  onChange={onCommandSafetyModeChange}
                />
              ) : null}

              <ComposerModelControls
                executionMode={executionMode}
                hasModels={hasModels}
                currentModelLabel={currentModelLabel}
                modelOptions={modelOptions}
                selectedValue={selectedValue}
                chatRuntimeControls={chatRuntimeControls}
                reasoningOptions={reasoningOptions}
                thinkingAlwaysOn={thinkingAlwaysOn}
                disabled={controlsDisabled}
                onSelectModel={onSelectModel}
                onSelectExecutionMode={onSelectExecutionMode}
                onOpenSettings={onOpenSettings}
                onChatRuntimeControlsChange={onChatRuntimeControlsChange}
              />

              <GitBranchSelector
                workdir={workdir}
                gitClient={gitClient}
                workspaceActivityClient={workspaceActivityClient}
                disabled={controlsDisabled}
                canWrite={gitWriteEnabled}
                disabledMessage={gitDisabledMessage}
                onOpenWorktree={onOpenWorktree}
                onWorktreeRemoved={onWorktreeRemoved}
              />
            </div>

            {contextDisplayMode === "ring" || contextDisplayMode === "both" ? (
              <ComposerContextUsageRing
                source={contextUsageTokensSource}
                totalTokens={contextUsageTokens}
                contextWindow={contextWindow}
                disabled={controlsDisabled || isSending || manualCompactBlocked}
                onConfirm={onManualCompactConfirm}
              />
            ) : null}
          </div>
          {fileDropOverlay}
        </div>
        {/* Conversation stats status-bar slot: flush with the card's bottom edge and the same width
            as the card; yields when the approval panel is visible; not mounted only in "ring" display
            mode -- both "statsBar" and "both" render it (§4.7). */}
        {statsBar && approvalBar == null && contextDisplayMode !== "ring" ? statsBar : null}
      </div>
    </div>
  );
});
