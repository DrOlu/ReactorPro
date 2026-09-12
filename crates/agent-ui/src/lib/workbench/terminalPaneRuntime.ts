import type { TerminalClient, TerminalSession } from "../terminal/types";
import type { TerminalPaneBindingStore } from "./terminalPaneBindingStore";
import type { TerminalWorkbenchSurface, WorkbenchLayout } from "./types";

let terminalSurfaceIdCounter = 0;

/** Stable terminal Surface identity within the layout; consistent with useWindowWorkbench's paneId generation style. */
export function createTerminalSurfaceId(): string {
  terminalSurfaceIdCounter += 1;
  return `term-${Date.now().toString(36)}-${terminalSurfaceIdCounter.toString(36)}`;
}

/** Thrown when SSH connection setup returns an interactive prompt (host key/auth); the Pane cannot answer it, so it must be completed in the project tools panel. */
export class TerminalPaneSshPromptError extends Error {
  constructor() {
    super("SSH session requires an interactive prompt.");
    this.name = "TerminalPaneSshPromptError";
  }
}

/**
 * Auto-create-session authorization set (window-level memory): records surfaceIds
 * this window has already explicitly created or restarted. Surfaces restored from
 * the layout are not in the set, so the host must stay in the dormant placeholder
 * until the user explicitly clicks to restore; this also prevents silently
 * establishing SSH connections at app startup.
 */
export function createTerminalPaneAutoLaunchRegistry() {
  const authorized = new Set<string>();
  return {
    authorize(surfaceId: string): void {
      const key = surfaceId.trim();
      if (key) authorized.add(key);
    },
    isAuthorized(surfaceId: string): boolean {
      return authorized.has(surfaceId.trim());
    },
  };
}

export type TerminalPaneAutoLaunchRegistry = ReturnType<
  typeof createTerminalPaneAutoLaunchRegistry
>;

export function isTerminalPaneAutoLaunchAuthorized(
  surfaceId: string,
  registry: Pick<TerminalPaneAutoLaunchRegistry, "isAuthorized">,
): boolean {
  return registry.isAuthorized(surfaceId.trim());
}

/**
 * App exit guard: the exit flow closes all terminals before quitting the process,
 * so the `closed` events broadcast during it do not mean the user closed an
 * individual terminal. If the Pane-closing linkage ran as usual, the layout
 * persist before exit would remove all terminal Panes and they could not be
 * restored from launchSpec after restart. It is set after exit confirmation, which
 * stalls the closed -> close-Pane linkage; on failure it resets and the app stays
 * usable.
 */
export function createTerminalAppExitGuard() {
  let exiting = false;
  return {
    mark(): void {
      exiting = true;
    },
    reset(): void {
      exiting = false;
    },
    isExiting(): boolean {
      return exiting;
    },
  };
}

export type EnsureTerminalPaneSessionDeps = {
  client: TerminalClient;
  bindings: Pick<TerminalPaneBindingStore, "set">;
  /** Injected by tests; uses the module-level shared table when omitted. */
  inflight?: Map<string, Promise<TerminalSession>>;
};

const sharedEnsureInflight = new Map<string, Promise<TerminalSession>>();

/**
 * Create a terminal session from launchSpec and write the binding, returning the
 * created session record (the caller can render it directly before
 * `terminal:event` arrives). Concurrent calls for the same surfaceId (StrictMode
 * double mount, fast retry) reuse the same in-flight Promise, guaranteeing two
 * PTYs are never created. A failed Promise is removed from the table once settled,
 * so a later retry can start again.
 */
export function ensureTerminalPaneSession(
  surface: TerminalWorkbenchSurface,
  deps: EnsureTerminalPaneSessionDeps,
): Promise<TerminalSession> {
  const inflight = deps.inflight ?? sharedEnsureInflight;
  const surfaceId = surface.surfaceId.trim();
  const existing = inflight.get(surfaceId);
  if (existing) return existing;

  const run = (async (): Promise<TerminalSession> => {
    if (surface.kind === "localTerminal") {
      const snapshot = await deps.client.create({
        cwd: surface.launchSpec.cwd,
        projectPathKey: surface.project.projectPathKey,
        shell: surface.launchSpec.shell,
        title: surface.launchSpec.title,
      });
      deps.bindings.set(surfaceId, snapshot.session.id);
      return snapshot.session;
    }
    const result = await deps.client.createSsh({
      cwd: surface.launchSpec.cwd,
      projectPathKey: surface.project.projectPathKey,
      hostId: surface.launchSpec.sshHostId,
      title: surface.launchSpec.title,
      sftpEnabled: surface.launchSpec.sftpEnabled,
    });
    if (!result.snapshot) {
      throw new TerminalPaneSshPromptError();
    }
    deps.bindings.set(surfaceId, result.snapshot.session.id);
    return result.snapshot.session;
  })();

  const tracked = run.finally(() => {
    if (inflight.get(surfaceId) === tracked) {
      inflight.delete(surfaceId);
    }
  });
  inflight.set(surfaceId, tracked);
  return tracked;
}

export type FindTerminalPaneForSessionDeps = {
  bindings: Pick<TerminalPaneBindingStore, "get">;
  layout: Pick<WorkbenchLayout, "panes">;
};

/**
 * Locate the terminal Pane holding a session when it is explicitly closed (the
 * registry's `closed` event). Look up by binding rather than lease: a drag-in
 * transaction writes the binding before opening the Pane, and the "connecting"
 * window before the host acquires the lease must also match; otherwise a close in
 * that window leaves an orphan Pane that revives a new PTY from launchSpec.
 */
export function findTerminalPaneForSession(
  sessionId: string,
  deps: FindTerminalPaneForSessionDeps,
): string | null {
  const key = sessionId.trim();
  if (!key) return null;
  for (const pane of Object.values(deps.layout.panes)) {
    const surface = pane.surface;
    if (surface.kind !== "localTerminal" && surface.kind !== "sshTerminal") continue;
    if (deps.bindings.get(surface.surfaceId) === key) return pane.paneId;
  }
  return null;
}

export type ResolveLiveTerminalSurfaceIdsDeps = {
  client: Pick<TerminalClient, "list">;
  bindings: Pick<TerminalPaneBindingStore, "reconcile" | "surfaceIds">;
};

/**
 * Reconciliation during restore: clean up dead bindings using sessions alive in
 * the backend, and return the set of surfaceIds still alive. On webview reload the
 * backend terminal registry is still there, so these surfaceIds' Panes remount
 * their sessions directly; Panes whose binding was cleared are rebuilt
 * automatically from launchSpec. On list failure, return null and keep bindings
 * as-is -- the host will clean up stale bindings pointing at vanished sessions
 * once the session list is ready and rebuild automatically, without blocking the
 * restore flow.
 */
export async function resolveLiveTerminalSurfaceIds(
  deps: ResolveLiveTerminalSurfaceIdsDeps,
): Promise<ReadonlySet<string> | null> {
  try {
    const sessions = await deps.client.list();
    const liveSessionIds = new Set(sessions.map((session) => session.id));
    deps.bindings.reconcile(liveSessionIds);
    return new Set(deps.bindings.surfaceIds());
  } catch {
    return null;
  }
}
