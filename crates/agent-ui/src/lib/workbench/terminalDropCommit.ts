import { terminalSessionBelongsToProject } from "../terminal/sessionStore";
import type { TerminalSession } from "../terminal/types";
import type { WorkbenchDropTarget, WorkbenchMoveTarget, WorkbenchOpenTarget } from "./index";
import type { TerminalPaneBindingStore } from "./terminalPaneBindingStore";
import type { TerminalPaneLeaseStore } from "./terminalPaneLeaseStore";
import type { ProjectRef, TerminalWorkbenchSurface, WorkbenchLayout } from "./types";
import type { WorkbenchDragPayload } from "./useWorkbenchDragSession";

export type TerminalDropPayload = Extract<
  WorkbenchDragPayload,
  { kind: "terminalSession" } | { kind: "newTerminal" }
>;

export type TerminalDropDeps = {
  layout: WorkbenchLayout;
  sessions: readonly TerminalSession[];
  lease: Pick<TerminalPaneLeaseStore, "paneIdFor" | "acquire">;
  bindings: Pick<TerminalPaneBindingStore, "set" | "delete">;
  /** newTerminal needs a real cwd; ProjectRef only has a pathKey, which the caller resolves back to a project path. */
  resolveProjectPath(project: ProjectRef): string | null;
  createSurfaceId(): string;
  /** A surface explicitly created by this window permits auto session creation; a restored Pane has no such allowance and uses a dormant placeholder. */
  authorizeAutoLaunch(surfaceId: string): void;
  openTerminalSurface(
    surface: TerminalWorkbenchSurface,
    target: WorkbenchOpenTarget,
  ): { paneId: string } | null;
  movePane(paneId: string, target: WorkbenchMoveTarget): boolean;
  focusPane(paneId: string): unknown;
};

export type TerminalDropResult =
  | { action: "moved" | "focused"; paneId: string }
  | { action: "opened"; paneId: string; surfaceId: string }
  | { action: "ignored" };

/** Build a persistable launch spec from an existing session record; the sessionId itself never enters the Surface. */
export function terminalSurfaceForSession(
  session: TerminalSession,
  surfaceId: string,
  project: ProjectRef,
): TerminalWorkbenchSurface {
  if (session.kind === "ssh" && session.ssh?.hostId) {
    return {
      kind: "sshTerminal",
      surfaceId,
      project,
      launchSpec: {
        cwd: session.cwd,
        sshHostId: session.ssh.hostId,
        title: session.title || undefined,
        sftpEnabled: session.ssh.sftpEnabled || undefined,
      },
    };
  }
  return {
    kind: "localTerminal",
    surfaceId,
    project,
    launchSpec: {
      cwd: session.cwd,
      shell: session.shell || undefined,
      title: session.title || undefined,
    },
  };
}

/**
 * The drop transaction for terminal dragging (design doc: "geometry first"): the layout commits immediately, and
 * the PTY is guaranteed asynchronously after TerminalPaneHost mounts. When an existing session is dragged in, the
 * binding is written before the Pane opens so the host reuses the session directly instead of creating one; a
 * session already on the canvas is only moved/focused.
 */
export function commitTerminalDrop(
  payload: TerminalDropPayload,
  target: WorkbenchDropTarget,
  deps: TerminalDropDeps,
): TerminalDropResult {
  // Non-pane drags are already auto-snapped during hit normalization, so a pane-center reaching here can only be a stale hit.
  if (target.kind === "pane-center") return { action: "ignored" };

  if (payload.kind === "terminalSession") {
    const leasedPaneId = deps.lease.paneIdFor(payload.sessionId);
    if (leasedPaneId && deps.layout.panes[leasedPaneId]) {
      if (target.kind === "canvas-empty") {
        deps.focusPane(leasedPaneId);
        return { action: "focused", paneId: leasedPaneId };
      }
      return deps.movePane(leasedPaneId, target)
        ? { action: "moved", paneId: leasedPaneId }
        : { action: "ignored" };
    }
    const session = deps.sessions.find((entry) => entry.id === payload.sessionId);
    if (!session) return { action: "ignored" };
    // Cross-project drop: reject when the session's project and the target window's project differ, otherwise it
    // would create a surface where "the project claims A but cwd is actually B". The backend independently rechecks
    // when creating the session; this just makes the out-of-bounds case silently fail at the drop stage instead of
    // leaving a bad Pane behind.
    if (!terminalSessionBelongsToProject(session, payload.project.projectPathKey)) {
      return { action: "ignored" };
    }
    const surfaceId = deps.createSurfaceId();
    const surface = terminalSurfaceForSession(session, surfaceId, payload.project);
    // Bind before opening the Pane: the host hits the existing session on mount and does not trigger an ensure create.
    deps.bindings.set(surfaceId, session.id);
    const opened = deps.openTerminalSurface(surface, target);
    if (!opened) {
      deps.bindings.delete(surfaceId);
      return { action: "ignored" };
    }
    // Claim the lease synchronously so the Right Dock unmounts its viewport in the same render, avoiding the canvas
    // host and the dock's XTermViewport double-attaching when the host mounts. The host's subsequent acquire is idempotent.
    try {
      deps.lease.acquire(payload.sessionId, opened.paneId);
    } catch {
      // When already occupied by another Pane, still open the layout; the host enters the lease error state.
    }
    return { action: "opened", paneId: opened.paneId, surfaceId };
  }

  const cwd = deps.resolveProjectPath(payload.project);
  if (!cwd) return { action: "ignored" };
  const surfaceId = deps.createSurfaceId();
  // User explicitly dragged in "new terminal": allow the host to auto-create the PTY after mount (geometry first, creation async).
  deps.authorizeAutoLaunch(surfaceId);
  const opened = deps.openTerminalSurface(
    {
      kind: "localTerminal",
      surfaceId,
      project: payload.project,
      launchSpec: { cwd },
    },
    target,
  );
  return opened ? { action: "opened", paneId: opened.paneId, surfaceId } : { action: "ignored" };
}
