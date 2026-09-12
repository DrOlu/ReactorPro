// Web-side Session Workbench orchestration: reuses the shared useWindowWorkbench layout reducer
// to keep "the focused Pane's conversation" consistent with the page's displayedConversationId (same
// semantics as the desktop ChatPage's selectWorkbenchConversation / syncCurrentConversation).
// The drag-and-drop system shares the same state machine / drag session hook with the desktop: sidebar conversations and projects, Right Dock
// terminal tabs and "New terminal" can all be dragged into the canvas, and Pane headers can be dragged to reorder.

import { WORKBENCH_CANVAS_DIVIDER_SIZE } from "@liveagent/ui/components/workbench/WorkbenchCanvas";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import type { TerminalClient, TerminalSession } from "@liveagent/ui/lib/terminal/types";
import {
  commitProjectToolDrop,
  commitWorkspaceDropConversation,
  findAdjacentPaneId,
  findParentSplitId,
  MIN_CONVERSATION_PANE_HEIGHT,
  MIN_CONVERSATION_PANE_WIDTH,
  openProjectToolInSplit,
  type PendingWorkspaceDropOperation,
  shouldDeferWorkspaceDropConversationSync,
  type WorkbenchEdge,
  type WorkbenchGeometry,
  type WorkbenchOpenTarget,
  type WorkbenchRect,
} from "@liveagent/ui/lib/workbench/index";
import { commitTerminalDrop } from "@liveagent/ui/lib/workbench/terminalDropCommit";
import {
  type TerminalPaneCloseRequest,
  useTerminalPaneCloseFlow,
} from "@liveagent/ui/lib/workbench/terminalPaneClose";
import { releaseOrphanTerminalPaneLeases } from "@liveagent/ui/lib/workbench/terminalPaneLeaseStore";
import {
  createTerminalSurfaceId,
  findTerminalPaneForSession,
} from "@liveagent/ui/lib/workbench/terminalPaneRuntime";
import {
  isProjectToolSurface,
  type PaneRecord,
  type ProjectRef,
  type ProjectToolSurfaceKind,
  surfaceIdentityKey,
  surfaceProjectRef,
} from "@liveagent/ui/lib/workbench/types";
import {
  useWindowWorkbench,
  type WindowWorkbench,
} from "@liveagent/ui/lib/workbench/useWindowWorkbench";
import {
  useWorkbenchDragSession,
  type WorkbenchDragRenderState,
  type WorkbenchDragUnavailableReason,
  type WorkbenchDropCommit,
} from "@liveagent/ui/lib/workbench/useWorkbenchDragSession";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { type WorkspaceProject, workspaceProjectPathKey } from "@/lib/settings";
import {
  gatewayTerminalPaneAutoLaunch,
  gatewayTerminalPaneBindings,
  gatewayTerminalPaneLease,
} from "./terminalPaneRuntime";

/** Same definition as the desktop canSplitRectAtEdge: both halves must preserve the hard minimum size of a conversation Pane. */
function canSplitRectAtEdge(rect: WorkbenchRect, edge: WorkbenchEdge): boolean {
  const horizontal = edge === "left" || edge === "right";
  const min = horizontal ? MIN_CONVERSATION_PANE_WIDTH : MIN_CONVERSATION_PANE_HEIGHT;
  const span = horizontal ? rect.width : rect.height;
  return span - WORKBENCH_CANVAS_DIVIDER_SIZE >= min * 2;
}

/** Threshold at which the desktop switches auto-docking to vertical on a narrow canvas (doc §22). */
const NARROW_CANVAS_WIDTH_FOR_AUTO_DOCK = 680;

function resolveWorkbenchPaneProject(
  projectPathKey: string | undefined,
  input: {
    workspaceProjects: readonly WorkspaceProject[];
    archivedProjectPathKeys: ReadonlySet<string>;
    missingProjectPathKeys: ReadonlySet<string>;
  },
): WorkspaceProject | null {
  if (!projectPathKey) return null;
  if (input.archivedProjectPathKeys.has(projectPathKey)) return null;
  if (input.missingProjectPathKeys.has(projectPathKey)) return null;
  return (
    input.workspaceProjects.find(
      (project) => workspaceProjectPathKey(project.path) === projectPathKey,
    ) ?? null
  );
}

export type UseGatewayWorkbenchParams = {
  enabled: boolean;
  displayedConversationId: string;
  sidebarStore: SidebarStore;
  workspaceProjects: readonly WorkspaceProject[];
  /** Archived projects do not accept workspace drop targets (same definition as the desktop). */
  archivedProjectPathKeys: ReadonlySet<string>;
  /** Missing projects do not activate Right Dock following (same key space as the desktop's blocked check). */
  missingProjectPathKeys: ReadonlySet<string>;
  /** The focused Pane's project context drives the Right Dock (no switch for archived/missing). */
  activateWorkspaceProject: (project: WorkspaceProject) => void;
  /** Gateway terminal client; when not connected the terminal drag entry is not rendered and the closed linkage halts. */
  terminalClient: TerminalClient | null;
  /** Window-wide terminal session list (the Right Dock's authoritative state). */
  terminalSessions: readonly TerminalSession[];
  /** Current project path of the Right Dock; the cwd source for the "New terminal" drag. */
  terminalProjectPath: string;
  /** Title text for "New terminal" on the drag ghost (localized). */
  newTerminalTitle: string;
  /** Project tool (file tree / review / tunnel / SSH / background tasks) drag ghost title (localized). */
  projectToolTitle: (tool: ProjectToolSurfaceKind) => string;
  /** Switch the page's current conversation to the given conversation (using the existing sidebar selection path). */
  selectConversation: (conversationId: string) => void;
  /** Workspace drop target: goes through the existing "new conversation in project" path (directory check + new draft). */
  startConversationForProject: (project: WorkspaceProject) => Promise<string | null>;
  /** Authoritative draft workdir lookup: validates the drop target's identity before the workspace drag opens a Pane. */
  conversationWorkdirFor: (conversationId: string) => string | null;
  /** User prompt when auto-docking has no legal space. */
  onNoSpaceForSplit: () => void;
  /** The layout/geometry changed during the drag, so the transaction cannot be safely replayed. */
  onDropStateChanged: () => void;
  /** The workspace draft creation transaction threw an error. */
  onWorkspaceDropFailed: (error: unknown) => void;
  /** Clarifies the focus semantics when a conversation already in a Pane is dragged in from the sidebar again. */
  onConversationAlreadyOpen: () => void;
  /** Project tool Pane close: also closes that tool in the dock (it no longer pops back to a tab after the lease is released). */
  onProjectToolPaneClosed?: (tool: ProjectToolSurfaceKind, projectPathKey: string) => void;
  /** Backend close failed while closing the terminal Pane (the session is still alive). */
  onTerminalCloseFailed?: (message: string) => void;
};

export type GatewayWorkbenchController = {
  workbench: WindowWorkbench;
  geometryRef: React.MutableRefObject<WorkbenchGeometry | null>;
  handleGeometryChange: (geometry: WorkbenchGeometry) => void;
  handleFocusPane: (paneId: string) => void;
  handleClosePane: (paneId: string) => void;
  /**
   * Pane's × / Meta+Alt+W entry: a terminal Pane terminates the terminal first (when running, a red bar inside the Pane
   * confirms, and the closed event closes the Pane); other Panes call handleClosePane directly.
   */
  requestClosePane: (paneId: string) => void;
  terminalPaneCloseRequest: TerminalPaneCloseRequest | null;
  confirmTerminalPaneClose: () => void;
  cancelTerminalPaneClose: () => void;
  /** Sidebar menu "Open in split": focus the existing Pane, otherwise auto-dock next to the focused Pane. */
  handleOpenConversationInSplit: (item: SidebarConversation) => boolean;
  /** Right Dock menu "Open in split": the drag-free entry for the same drop transaction. */
  handleOpenTerminalInSplit: (session: TerminalSession) => void;
  /** Right Dock tool tab menu "Open in split": focus the existing Pane, otherwise auto-dock. */
  handleOpenToolInSplit: (tool: ProjectToolSurfaceKind) => void;
  /** Right Dock new menu "New terminal in split". */
  handleOpenNewTerminalInSplit: () => void;
  /** The "Go to Pane" focus path for the SSH overlay's "already open on the canvas" placeholder. */
  focusTerminalPaneForSession: (sessionId: string) => void;
  /** The conversation disappeared from the authoritative index (deletion, etc.): close the corresponding Pane without migrating the selection. */
  closePanesForRemovedConversations: (ids: readonly string[]) => void;
  /** Login/agent scope switch: clear the layout and terminal surface bindings. */
  clearWorkbench: () => void;
  projectRefForConversation: (item: { id: string; cwd?: string | null }) => ProjectRef;
  /** Drag overlay model (ghost + drop preview); null when idle. */
  dragState: WorkbenchDragRenderState | null;
  /** Imperative compositor-only pointer tracking for the drag ghost. */
  dragGhostRef: (element: HTMLDivElement | null) => void;
  /** Pane header drag handle (initiated by pointer-down). */
  beginPaneDrag: (
    pane: PaneRecord,
    title: string,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** Sidebar conversation row drag initiation. */
  handleConversationDragIntent: (
    item: SidebarConversation,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** Sidebar project row drag initiation (drop target creates a new conversation). */
  handleProjectDragIntent: (
    project: WorkspaceProject,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** Right Dock terminal tab drag initiation (an existing conversation into the canvas). */
  handleTerminalTabDragIntent: (
    session: TerminalSession,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** Right Dock "New terminal" button drag initiation (drop target creates a terminal Pane). */
  handleNewTerminalDragIntent: (event: {
    pointerId: number;
    clientX: number;
    clientY: number;
    currentTarget?: EventTarget | null;
  }) => void;
  /** Right Dock tool tab / empty-state entry drag initiation (drop target opens that tool's Pane). */
  handleToolDragIntent: (
    tool: ProjectToolSurfaceKind,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** Conversations leased by canvas Panes (used to mutually hide Right Dock terminal tabs). */
  leasedDockSessionIds: readonly string[];
};

export function useGatewayWorkbench(params: UseGatewayWorkbenchParams): GatewayWorkbenchController {
  const {
    enabled,
    displayedConversationId,
    sidebarStore,
    workspaceProjects,
    archivedProjectPathKeys,
    missingProjectPathKeys,
    activateWorkspaceProject,
    terminalClient,
    terminalSessions,
    terminalProjectPath,
    newTerminalTitle,
    projectToolTitle,
    onProjectToolPaneClosed,
    onTerminalCloseFailed,
    selectConversation,
    startConversationForProject,
    conversationWorkdirFor,
    onNoSpaceForSplit,
    onDropStateChanged,
    onWorkspaceDropFailed,
    onConversationAlreadyOpen,
  } = params;

  const projectRefForConversation = useCallback(
    (item: { id: string; cwd?: string | null }): ProjectRef => {
      const cwd = item.cwd?.trim() || "";
      const pathKey = cwd ? workspaceProjectPathKey(cwd) : "";
      const project = pathKey
        ? workspaceProjects.find((entry) => workspaceProjectPathKey(entry.path) === pathKey)
        : undefined;
      return {
        projectId: project?.id ?? `conversation:${item.id}`,
        projectPathKey: pathKey || `conversation:${item.id}`,
      };
    },
    [workspaceProjects],
  );

  const projectRefForConversationRef = useRef(projectRefForConversation);
  projectRefForConversationRef.current = projectRefForConversation;

  const sidebarProjectRef = useCallback(
    (conversationId: string): ProjectRef =>
      projectRefForConversationRef.current({
        id: conversationId,
        cwd: sidebarStore.peek(conversationId)?.cwd ?? null,
      }),
    [sidebarStore],
  );

  const geometryRef = useRef<WorkbenchGeometry | null>(null);
  const handleGeometryChange = useCallback((geometry: WorkbenchGeometry) => {
    geometryRef.current = geometry;
  }, []);

  // Web cold start always begins from a single Root Pane and does not persist the layout (persistence: false);
  // the desktop differs and uses the shared Hook's default localStorage layout restore.
  const initialRef = useRef<{ conversationId: string; project: ProjectRef } | null>(null);
  if (initialRef.current === null) {
    initialRef.current = {
      conversationId: displayedConversationId,
      project: sidebarProjectRef(displayedConversationId),
    };
  }

  const workbench = useWindowWorkbench({
    initialConversationId: initialRef.current.conversationId,
    initialProject: initialRef.current.project,
    geometryRef,
    dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE,
    // Web always starts from a single-Pane home for the current conversation each time it opens. Desktop still uses the shared
    // Hook's default persistence to keep its window layout restore capability.
    persistence: false,
    onCommandError: (error) => {
      if (error.code === "insufficient-space") onNoSpaceForSplit();
    },
  });

  const selectConversationRef = useRef(selectConversation);
  selectConversationRef.current = selectConversation;
  // A Pane click goes through the page selection pipeline asynchronously; before displayedConversationId lands,
  // syncCurrentConversation must not rebind the focused Pane back to the old conversation (same definition as the desktop
  // workbenchPendingSelectRef).
  const pendingSelectRef = useRef<string | null>(null);
  const selectWorkbenchConversation = useCallback((conversationId: string) => {
    const key = conversationId.trim();
    if (!key) return;
    pendingSelectRef.current = key;
    selectConversationRef.current(key);
  }, []);
  const startConversationForProjectRef = useRef(startConversationForProject);
  startConversationForProjectRef.current = startConversationForProject;
  const conversationWorkdirForRef = useRef(conversationWorkdirFor);
  conversationWorkdirForRef.current = conversationWorkdirFor;
  const terminalSessionsRef = useRef(terminalSessions);
  terminalSessionsRef.current = terminalSessions;
  const workspaceProjectsRef = useRef(workspaceProjects);
  workspaceProjectsRef.current = workspaceProjects;

  // Workspace drop awaits the exact draft id. While directory validation and
  // draft creation are in flight, the current-conversation sync must not
  // rebind the focused pane underneath the explicit drop transaction.
  const workspaceDropSequenceRef = useRef(0);
  const pendingWorkspaceDropRef = useRef<PendingWorkspaceDropOperation | null>(null);

  const activatePaneProject = useCallback(
    (projectPathKey?: string) => {
      const project = resolveWorkbenchPaneProject(projectPathKey, {
        workspaceProjects,
        archivedProjectPathKeys,
        missingProjectPathKeys,
      });
      if (project) activateWorkspaceProject(project);
    },
    [activateWorkspaceProject, archivedProjectPathKeys, missingProjectPathKeys, workspaceProjects],
  );

  // Page's current conversation changes (sidebar selection, new conversation, draft promoted) -> the focused Pane follows;
  // when the conversation is already in another Pane, focus moves there, maintaining "at most one Pane per conversation".
  const lastSyncedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const key = displayedConversationId.trim();
    if (!key) return;
    const pending = pendingSelectRef.current;
    if (pending && pending !== key && lastSyncedConversationRef.current === key) {
      return;
    }
    pendingSelectRef.current = null;
    const pendingDrop = pendingWorkspaceDropRef.current;
    const workdir = conversationWorkdirForRef.current(key)?.trim() || "";
    if (
      shouldDeferWorkspaceDropConversationSync(pendingDrop, key, workspaceProjectPathKey(workdir))
    ) {
      return;
    }
    lastSyncedConversationRef.current = key;
    workbench.syncCurrentConversation(key, sidebarProjectRef(key));
  }, [enabled, displayedConversationId, sidebarProjectRef, workbench]);

  const handleFocusPane = useCallback(
    (paneId: string) => {
      const pane = workbench.focusPane(paneId);
      if (!pane) return;
      // Terminal/unsupported surfaces do not drive the page's current conversation; they only make the Right Dock follow that
      // Pane's project (no switch for archived/missing).
      if (pane.surface.kind !== "conversation") {
        activatePaneProject(surfaceProjectRef(pane.surface)?.projectPathKey);
        return;
      }
      const conversationId = pane.surface.conversationId;
      if (conversationId && conversationId !== displayedConversationId) {
        selectWorkbenchConversation(conversationId);
      }
      activatePaneProject(pane.surface.project.projectPathKey);
    },
    [activatePaneProject, displayedConversationId, selectWorkbenchConversation, workbench],
  );

  const handleClosePane = useCallback(
    (paneId: string) => {
      const pane = workbench.layoutRef.current.panes[paneId];
      const result = workbench.closePane(paneId);
      // Closing a terminal Pane = terminating the terminal: terminalPaneClose closes the session first, and here the binding is
      // reclaimed after the closed event confirms, so dragging in again uses a brand-new surface identity.
      if (pane?.surface.kind === "localTerminal" || pane?.surface.kind === "sshTerminal") {
        gatewayTerminalPaneBindings.delete(pane.surface.surfaceId);
      }
      // Closing a project tool Pane = closing the tool entirely: after the layout confirms removal, the page is notified to clear the dock state.
      if (
        pane &&
        isProjectToolSurface(pane.surface) &&
        !workbench.layoutRef.current.panes[paneId]
      ) {
        onProjectToolPaneClosed?.(pane.surface.kind, pane.surface.project.projectPathKey);
      }
      if (
        result.closedFocused &&
        result.nextConversationId &&
        result.nextConversationId !== displayedConversationId
      ) {
        selectWorkbenchConversation(result.nextConversationId);
      }
    },
    [displayedConversationId, onProjectToolPaneClosed, selectWorkbenchConversation, workbench],
  );

  const handleClosePaneRef = useRef(handleClosePane);
  handleClosePaneRef.current = handleClosePane;

  const terminalPaneClose = useTerminalPaneCloseFlow({
    client: terminalClient,
    sessions: terminalSessions,
    bindings: gatewayTerminalPaneBindings,
    layout: workbench.layout,
    closePane: handleClosePane,
    onError: onTerminalCloseFailed,
  });
  const requestClosePane = terminalPaneClose.requestClosePane;

  // When a conversation is closed (`closed` event: Pane's × termination, dock close, etc.), the
  // Pane holding it is closed too. Lookup is by binding rather than lease, covering the connecting window before the host acquires the lease.
  useEffect(() => {
    if (!enabled || !terminalClient) return;
    return terminalClient.subscribe((event) => {
      if (event.kind !== "closed") return;
      const closedSessionId = event.sessionId?.trim() || event.session?.id || "";
      if (!closedSessionId) return;
      const paneId = findTerminalPaneForSession(closedSessionId, {
        bindings: gatewayTerminalPaneBindings,
        layout: workbench.layoutRef.current,
      });
      if (paneId) handleClosePaneRef.current(paneId);
    });
  }, [enabled, terminalClient, workbench]);

  // Keyboard commands matching the desktop, all bound to Meta/Ctrl+Alt:
  // arrow keys focus the adjacent Pane, Shift+arrow moves the focused Pane there, W closes, and =/+ splits evenly.
  useEffect(() => {
    if (!enabled) return;
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
        const geometry = geometryRef.current;
        if (!geometry) return;
        const nextPaneId = findAdjacentPaneId(geometry, focusedPaneId, direction);
        if (!nextPaneId) return;
        event.preventDefault();
        if (event.shiftKey) {
          workbench.movePane(focusedPaneId, {
            kind: "pane-edge",
            paneId: nextPaneId,
            edge: direction,
          });
          return;
        }
        handleFocusPane(nextPaneId);
        return;
      }

      if (event.shiftKey) return;
      if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        requestClosePane(focusedPaneId);
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
  }, [enabled, handleFocusPane, requestClosePane, workbench]);

  // Same definition as the desktop resolveWorkbenchAutoDockTarget: prefer the right side (on a narrow canvas, prefer
  // below), and explicitly reject when neither direction fits.
  const resolveAutoDockTarget = useCallback((): WorkbenchOpenTarget | null => {
    const layout = workbench.layoutRef.current;
    if (!layout.focusedPaneId) return { kind: "canvas-empty" };
    const geometry = geometryRef.current;
    const focusedRect = geometry?.panes.find((pane) => pane.paneId === layout.focusedPaneId)?.rect;
    if (!geometry || !focusedRect) return null;
    const preferVertical = geometry.canvas.width < NARROW_CANVAS_WIDTH_FOR_AUTO_DOCK;
    const edges = preferVertical ? (["bottom", "right"] as const) : (["right", "bottom"] as const);
    for (const edge of edges) {
      if (canSplitRectAtEdge(focusedRect, edge)) {
        return { kind: "pane-edge", paneId: layout.focusedPaneId, edge };
      }
    }
    return null;
  }, [workbench]);

  const handleOpenConversationInSplit = useCallback(
    (item: SidebarConversation): boolean => {
      const existingPaneId = workbench.paneIdForConversation(item.id);
      if (existingPaneId) {
        handleFocusPane(existingPaneId);
        return true;
      }
      const target = resolveAutoDockTarget();
      if (!target) {
        onNoSpaceForSplit();
        return false;
      }
      const project = projectRefForConversationRef.current(item);
      const opened = workbench.openConversation({ conversationId: item.id, project }, target);
      if (opened && item.id !== displayedConversationId) {
        selectWorkbenchConversation(item.id);
      }
      return opened !== null;
    },
    [
      displayedConversationId,
      handleFocusPane,
      onNoSpaceForSplit,
      resolveAutoDockTarget,
      selectWorkbenchConversation,
      workbench,
    ],
  );

  /** Shared dependencies of the terminal drop transaction (used by both drag commit and the menu entry). */
  const terminalDropDeps = useCallback(
    () => ({
      layout: workbench.layoutRef.current,
      sessions: terminalSessionsRef.current,
      lease: gatewayTerminalPaneLease,
      bindings: gatewayTerminalPaneBindings,
      resolveProjectPath: (project: ProjectRef) =>
        workspaceProjectsRef.current.find((entry) => entry.id === project.projectId)?.path ??
        workspaceProjectsRef.current.find(
          (entry) => workspaceProjectPathKey(entry.path) === project.projectPathKey,
        )?.path ??
        null,
      createSurfaceId: createTerminalSurfaceId,
      authorizeAutoLaunch: gatewayTerminalPaneAutoLaunch.authorize,
      openTerminalSurface: workbench.openTerminalSurface,
      movePane: workbench.movePane,
      focusPane: handleFocusPane,
    }),
    [handleFocusPane, workbench],
  );

  const handleDropCommit = useCallback(
    (commit: WorkbenchDropCommit) => {
      // The layout revision changed during the drag (focus/structural change): cancel the transaction instead of replaying
      // against stale geometry.
      if (commit.revision !== workbench.layoutRef.current.revision) {
        onDropStateChanged();
        return;
      }
      const { payload, target } = commit;
      if (payload.kind === "workspace") {
        if (target.kind === "pane-center") return;
        const pathKey = workspaceProjectPathKey(payload.projectPath);
        if (archivedProjectPathKeys.has(pathKey)) return;
        const project = workspaceProjectsRef.current.find(
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
          startConversation: () => startConversationForProjectRef.current(project),
          onConversationCreated: (conversationId) => {
            const pending = pendingWorkspaceDropRef.current;
            if (pending?.operationId === operationId) {
              pendingWorkspaceDropRef.current = { ...pending, conversationId };
            }
          },
          currentRevision: () => workbench.layoutRef.current.revision,
          conversationMatchesProject: (conversationId) => {
            const workdir = conversationWorkdirForRef.current(conversationId)?.trim() || "";
            return Boolean(workdir) && workspaceProjectPathKey(workdir) === pathKey;
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
              if (paneId) handleFocusPane(paneId);
              return;
            }
            // not-created/stale/identity-mismatch/rejected: a conversation switch deferred during the pause
            // window must be synced once more, and the project identity uses the current conversation's own resolution --
            // identity-mismatch means the draft workdir does not belong to the dragged-in project, so the
            // dragged-in project's ProjectRef must not be forced onto the focused Pane.
            const currentId = displayedConversationId.trim();
            if (currentId) {
              workbench.syncCurrentConversation(currentId, sidebarProjectRef(currentId));
            }
            if (result.kind === "stale" || result.kind === "identity-mismatch") {
              onDropStateChanged();
            }
          })
          .catch((error) => {
            if (pendingWorkspaceDropRef.current?.operationId === operationId) {
              pendingWorkspaceDropRef.current = null;
            }
            const currentId = displayedConversationId.trim();
            if (currentId) {
              workbench.syncCurrentConversation(currentId, sidebarProjectRef(currentId));
            }
            onWorkspaceDropFailed(error);
          });
        return;
      }
      if (payload.kind === "conversation") {
        const existingPaneId = workbench.paneIdForConversation(payload.conversationId);
        if (target.kind === "pane-center") {
          // The dragged conversation has been normalized: pane-center can only be the conversation's own Pane, and the semantics are focus.
          if (existingPaneId && target.paneId === existingPaneId) {
            handleFocusPane(existingPaneId);
            onConversationAlreadyOpen();
          }
          return;
        }
        if (existingPaneId) {
          if (target.kind === "canvas-empty") return;
          if (
            workbench.movePane(existingPaneId, target) &&
            payload.conversationId !== displayedConversationId
          ) {
            selectWorkbenchConversation(payload.conversationId);
          }
          return;
        }
        const opened = workbench.openConversation(
          { conversationId: payload.conversationId, project: payload.project },
          target,
        );
        if (opened && payload.conversationId !== displayedConversationId) {
          selectWorkbenchConversation(payload.conversationId);
        }
        return;
      }
      if (payload.kind === "terminalSession" || payload.kind === "newTerminal") {
        commitTerminalDrop(payload, target, terminalDropDeps());
        return;
      }
      if (payload.kind === "projectTool") {
        commitProjectToolDrop(payload, target, {
          layout: workbench.layoutRef.current,
          openProjectToolSurface: workbench.openProjectToolSurface,
          movePane: workbench.movePane,
          focusPane: handleFocusPane,
        });
        return;
      }
      // Pane header drag reorder.
      if (target.kind === "canvas-empty") return;
      if (target.kind === "pane-center" && target.paneId === payload.paneId) return;
      if (workbench.movePane(payload.paneId, target)) {
        const pane = workbench.layoutRef.current.panes[payload.paneId];
        // Only conversation Panes drive the page's current conversation; moving a terminal Pane does not change the selection.
        if (
          pane?.surface.kind === "conversation" &&
          pane.surface.conversationId !== displayedConversationId
        ) {
          selectWorkbenchConversation(pane.surface.conversationId);
        }
      }
    },
    [
      archivedProjectPathKeys,
      displayedConversationId,
      handleFocusPane,
      onConversationAlreadyOpen,
      onDropStateChanged,
      onWorkspaceDropFailed,
      sidebarProjectRef,
      selectWorkbenchConversation,
      terminalDropDeps,
      workbench,
    ],
  );

  const { dragState, beginDrag, dragGhostRef } = useWorkbenchDragSession({
    enabled,
    layoutRef: workbench.layoutRef,
    geometryRef,
    onCommit: handleDropCommit,
    onUnavailable: (reason: WorkbenchDragUnavailableReason) => {
      if (reason === "geometry-unavailable") onDropStateChanged();
      else onNoSpaceForSplit();
    },
  });

  const beginPaneDrag = useCallback(
    (
      pane: PaneRecord,
      title: string,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      beginDrag(
        {
          kind: "pane",
          paneId: pane.paneId,
          surfaceKey: surfaceIdentityKey(pane.surface),
          title,
        },
        event,
      );
    },
    [beginDrag],
  );

  const handleConversationDragIntent = useCallback(
    (
      item: SidebarConversation,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      beginDrag(
        {
          kind: "conversation",
          conversationId: item.id,
          project: projectRefForConversationRef.current(item),
          title: item.title,
          cwd: item.cwd,
          updatedAt: item.updatedAt,
        },
        event,
      );
    },
    [beginDrag],
  );

  const handleProjectDragIntent = useCallback(
    (
      project: WorkspaceProject,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      beginDrag(
        {
          kind: "workspace",
          projectId: project.id,
          projectPath: project.path,
          title: project.name,
        },
        event,
      );
    },
    [beginDrag],
  );

  // Right Dock terminal tab dragged out: an existing conversation enters the canvas.
  const handleTerminalTabDragIntent = useCallback(
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
      const project = workspaceProjectsRef.current.find(
        (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
      );
      beginDrag(
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
    [beginDrag],
  );

  // "New terminal" button dragged out: the drop target creates a terminal Pane (geometry first; the PTY is created asynchronously by the host).
  const handleNewTerminalDragIntent = useCallback(
    (event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    }) => {
      const path = terminalProjectPath.trim();
      if (!path) return;
      const pathKey = workspaceProjectPathKey(path);
      const project = workspaceProjectsRef.current.find(
        (entry) => workspaceProjectPathKey(entry.path) === pathKey,
      );
      beginDrag(
        {
          kind: "newTerminal",
          project: {
            projectId: project?.id ?? `project:${pathKey}`,
            projectPathKey: pathKey,
          },
          title: newTerminalTitle,
        },
        event,
      );
    },
    [beginDrag, newTerminalTitle, terminalProjectPath],
  );

  // The Right Dock's current project: the ProjectRef a Pane binds to when a project tool is dragged out / opened in split.
  const dockToolProjectRef = useCallback((): ProjectRef | null => {
    const path = terminalProjectPath.trim();
    if (!path) return null;
    const projectPathKey = workspaceProjectPathKey(path);
    const project = workspaceProjectsRef.current.find(
      (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
    );
    return {
      projectId: project?.id ?? `project:${projectPathKey}`,
      projectPathKey,
    };
  }, [terminalProjectPath]);

  const handleToolDragIntent = useCallback(
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
      beginDrag({ kind: "projectTool", tool, project, title: projectToolTitle(tool) }, event);
    },
    [beginDrag, dockToolProjectRef, projectToolTitle],
  );

  // The menu entry for the same commit path: terminal tabs can enter the workbench without dragging. An already-leased
  // conversation goes through "move existing Pane" inside commitTerminalDrop itself, and no second Pane is opened.
  const handleOpenTerminalInSplit = useCallback(
    (session: TerminalSession) => {
      const target = resolveAutoDockTarget();
      if (!target) {
        onNoSpaceForSplit();
        return;
      }
      const projectPathKey = session.projectPathKey || workspaceProjectPathKey(session.cwd);
      const project = workspaceProjectsRef.current.find(
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
        terminalDropDeps(),
      );
    },
    [onNoSpaceForSplit, resolveAutoDockTarget, terminalDropDeps],
  );

  const handleOpenToolInSplit = useCallback(
    (tool: ProjectToolSurfaceKind) => {
      const project = dockToolProjectRef();
      if (!project) return;
      openProjectToolInSplit(tool, project, {
        layout: workbench.layoutRef.current,
        openProjectToolSurface: workbench.openProjectToolSurface,
        focusPane: handleFocusPane,
        resolveAutoDockTarget,
        onNoSpace: onNoSpaceForSplit,
      });
    },
    [dockToolProjectRef, handleFocusPane, onNoSpaceForSplit, resolveAutoDockTarget, workbench],
  );

  const handleOpenNewTerminalInSplit = useCallback(() => {
    const target = resolveAutoDockTarget();
    if (!target) {
      onNoSpaceForSplit();
      return;
    }
    const path = terminalProjectPath.trim();
    if (!path) return;
    const projectPathKey = workspaceProjectPathKey(path);
    const project = workspaceProjectsRef.current.find(
      (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
    );
    commitTerminalDrop(
      {
        kind: "newTerminal",
        project: {
          projectId: project?.id ?? `project:${projectPathKey}`,
          projectPathKey,
        },
        title: newTerminalTitle,
      },
      target,
      terminalDropDeps(),
    );
  }, [
    newTerminalTitle,
    onNoSpaceForSplit,
    resolveAutoDockTarget,
    terminalDropDeps,
    terminalProjectPath,
  ]);

  // Conversations leased by canvas Panes: the "Go to Pane" focus path for the overlay/placeholder.
  const focusTerminalPaneForSession = useCallback(
    (sessionId: string) => {
      const paneId = gatewayTerminalPaneLease.paneIdFor(sessionId);
      if (paneId && workbench.layoutRef.current.panes[paneId]) {
        handleFocusPane(paneId);
      }
    },
    [handleFocusPane, workbench],
  );

  // Conversations leased by canvas Panes are hidden from the Right Dock's terminal tabs (a terminal appears in
  // only one host at a time); after a Pane close (Detach) releases the lease, it automatically returns to the dock.
  const leasedDockSessionIds = useSyncExternalStore(
    gatewayTerminalPaneLease.subscribe,
    gatewayTerminalPaneLease.leasedSessionIds,
  );

  // Layout reconciliation: the drop transaction claims the lease synchronously before the host mounts; if the Pane is
  // closed before the host takes over release, the lease would hang forever (the terminal permanently hidden in the dock). Leases held by the host
  // are released in its unmount cleanup before this effect, so they are unaffected.
  useEffect(() => {
    releaseOrphanTerminalPaneLeases(gatewayTerminalPaneLease, workbench.layout);
  }, [workbench.layout]);

  // Conversation deleted: only the layout is closed, without migrating the selection (the displayed selection migration is handled by the existing removal path,
  // after which syncCurrentConversation rebinds the focused Pane to the new current conversation).
  const closePanesForRemovedConversations = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) {
        const paneId = workbench.paneIdForConversation(id);
        if (paneId) workbench.closePane(paneId);
      }
    },
    [workbench],
  );

  const clearWorkbench = useCallback(() => {
    for (const pane of Object.values(workbench.layoutRef.current.panes)) {
      if (pane.surface.kind === "localTerminal" || pane.surface.kind === "sshTerminal") {
        gatewayTerminalPaneBindings.delete(pane.surface.surfaceId);
      }
    }
    workbench.clear();
  }, [workbench]);

  return useMemo(
    () => ({
      workbench,
      geometryRef,
      handleGeometryChange,
      handleFocusPane,
      handleClosePane,
      requestClosePane,
      terminalPaneCloseRequest: terminalPaneClose.pendingClose,
      confirmTerminalPaneClose: terminalPaneClose.confirmClose,
      cancelTerminalPaneClose: terminalPaneClose.cancelClose,
      handleOpenConversationInSplit,
      handleOpenTerminalInSplit,
      handleOpenToolInSplit,
      handleOpenNewTerminalInSplit,
      focusTerminalPaneForSession,
      closePanesForRemovedConversations,
      clearWorkbench,
      projectRefForConversation,
      dragState,
      dragGhostRef,
      beginPaneDrag,
      handleConversationDragIntent,
      handleProjectDragIntent,
      handleTerminalTabDragIntent,
      handleNewTerminalDragIntent,
      handleToolDragIntent,
      leasedDockSessionIds,
    }),
    [
      workbench,
      handleGeometryChange,
      handleFocusPane,
      handleClosePane,
      requestClosePane,
      terminalPaneClose.pendingClose,
      terminalPaneClose.confirmClose,
      terminalPaneClose.cancelClose,
      handleOpenConversationInSplit,
      handleOpenTerminalInSplit,
      handleOpenToolInSplit,
      handleOpenNewTerminalInSplit,
      focusTerminalPaneForSession,
      closePanesForRemovedConversations,
      clearWorkbench,
      projectRefForConversation,
      dragState,
      dragGhostRef,
      beginPaneDrag,
      handleConversationDragIntent,
      handleProjectDragIntent,
      handleTerminalTabDragIntent,
      handleNewTerminalDragIntent,
      handleToolDragIntent,
      leasedDockSessionIds,
    ],
  );
}
