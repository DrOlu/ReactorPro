import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocale } from "../../i18n/index";
import type { TerminalClient, TerminalSession } from "../../lib/terminal/types";
import type { TerminalPaneBindingStore } from "../../lib/workbench/terminalPaneBindingStore";
import type { TerminalPaneLeaseStore } from "../../lib/workbench/terminalPaneLeaseStore";
import {
  ensureTerminalPaneSession,
  isTerminalPaneAutoLaunchAuthorized,
  type TerminalPaneAutoLaunchRegistry,
  TerminalPaneSshPromptError,
} from "../../lib/workbench/terminalPaneRuntime";
import type { TerminalWorkbenchSurface } from "../../lib/workbench/types";
import { formatTerminalSessionTitle } from "../project-tools/rightDockModel";
import { Button } from "../ui/button";
import {
  LocalTerminalPaneSurface,
  type TerminalPaneSurfacePhase,
} from "./surfaces/LocalTerminalPaneSurface";
import { SshTerminalPaneSurface } from "./surfaces/SshTerminalPaneSurface";

export type TerminalPaneHostProps = {
  paneId: string;
  surface: TerminalWorkbenchSurface;
  isFocused: boolean;
  /** Very narrow Pane: the SSH status line switches to compact rendering (derived from rect, not written back to layout). */
  isCompact?: boolean;
  theme: "light" | "dark";
  /** Terminal runtime: a Tauri client on desktop, a gateway client on Web. */
  client: TerminalClient;
  /** Window-level binding table (surfaceId→sessionId); hosts must share the same instance. */
  bindings: TerminalPaneBindingStore;
  /** Window-level view leases, ensuring a conversation's output stream has a single consumer. */
  lease: TerminalPaneLeaseStore;
  /** Explicit-create/restart authorization; restored surfaces start dormant. */
  autoLaunch: TerminalPaneAutoLaunchRegistry;
  /** Window-wide session list (not filtered by project): a Pane can host a terminal from any project. */
  sessions: readonly TerminalSession[];
  sessionsLoaded: boolean;
  /**
   * When the viewport errors it bubbles up the sessionId, and the page validates it against the
   * backend's authoritative list: if the conversation is confirmed gone (a ghost record) the
   * whole list refreshes, this Pane enters the parked session-closed state, and the retry button
   * becomes a restart by launchSpec instead of infinitely reconnecting to a dead session.
   */
  onSessionGhost?: (sessionId: string) => void;
  /**
   * In-pane close confirmation for a running session (the pane × terminates
   * the terminal; it never detaches back to the dock). Rendered as a red bar
   * above the viewport so the prompt appears where the user clicked.
   */
  closeRequest?: {
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  };
};

type TerminalPaneErrorState =
  | { kind: "ssh-prompt" }
  | { kind: "create-failed"; message: string }
  | { kind: "session-closed" }
  | { kind: "lease"; message: string };

const SSH_LATENCY_POLL_MS = 15_000;

/**
 * The page-side host for terminal Panes: connects the layout layer's launchSpec identity to the
 * runtime — a binding (surfaceId→sessionId) resolves an existing session; only after explicit
 * creation or user-confirmed recovery is a new PTY/SSH session established by launchSpec. A
 * full application restart cannot revive old processes, so a restored Pane first parks in a
 * dormant placeholder, avoiding silently starting a local process or SSH connection. Before
 * rendering it must hold that session's view lease, ensuring a single consumer for output and a
 * single writer for input.
 */
export function TerminalPaneHost(props: TerminalPaneHostProps) {
  const {
    paneId,
    surface,
    isFocused,
    isCompact,
    theme,
    client,
    bindings,
    lease,
    autoLaunch,
    sessions,
    sessionsLoaded,
    onSessionGhost,
    closeRequest,
  } = props;
  const { t } = useLocale();

  const boundSessionId = useSyncExternalStore(bindings.subscribe, () =>
    bindings.get(surface.surfaceId),
  );
  // Fallback for direct rendering when the create response arrives before terminal:event; once the event arrives the list version takes priority.
  const [createdSession, setCreatedSession] = useState<TerminalSession | null>(null);
  const [errorState, setErrorState] = useState<TerminalPaneErrorState | null>(null);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [leasedSessionId, setLeasedSessionId] = useState<string | null>(null);
  // create() writes bindings before settling the Promise. The synchronous re-render triggered
  // by the binding notification may happen before terminal:event enters sessions; keeping this
  // creation Promise lets the next effect continue awaiting the same result instead of mistaking
  // the just-written binding for a stale recovery-period binding.
  const ensureSessionPromiseRef = useRef<Promise<TerminalSession> | null>(null);
  const [launchRequestedSurfaceId, setLaunchRequestedSurfaceId] = useState<string | null>(null);
  const launchAuthorized =
    launchRequestedSurfaceId === surface.surfaceId ||
    isTerminalPaneAutoLaunchAuthorized(surface.surfaceId, autoLaunch);

  const liveSession = boundSessionId
    ? (sessions.find((entry) => entry.id === boundSessionId) ?? null)
    : null;
  const session =
    liveSession ?? (createdSession && createdSession.id === boundSessionId ? createdSession : null);
  const sessionId = session?.id ?? null;

  // sessionIds that have appeared in the session list during this mount: used to distinguish a
  // "stale binding after restart" (never seen, can be rebuilt by launchSpec) from "explicitly
  // closed during runtime" (seen and then gone; must never automatically revive a new PTY).
  const seenLiveSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (liveSession) seenLiveSessionIdRef.current = liveSession.id;
  }, [liveSession]);

  useEffect(() => {
    if (liveSession && createdSession) setCreatedSession(null);
  }, [createdSession, liveSession]);

  // When a session "disappears" and then returns to the authoritative list (the gateway switches
  // to another desktop instance and back, or a failed list() is corrected by later events): the
  // parked "session no longer exists" placeholder clears by itself, without the user clicking
  // "retry" (which would terminate and create a new PTY by launchSpec).
  useEffect(() => {
    if (liveSession && errorState?.kind === "session-closed") setErrorState(null);
  }, [errorState, liveSession]);

  useEffect(() => {
    if (session || errorState) return;
    const pendingEnsure = ensureSessionPromiseRef.current;
    if (boundSessionId && !pendingEnsure) {
      // Only "a binding exists but the session is temporarily missing from the list" needs to
      // wait for the authoritative list(): before the list is ready, slow loading cannot be
      // distinguished from a stale binding, and it must not be wrongly deleted and rebuilt.
      if (!sessionsLoaded) return;
      if (seenLiveSessionIdRef.current === boundSessionId) {
        // The session existed during this mount: this is an explicit close from the Right Dock
        // (or close_project/close_all), not a recovery-period leftover. Park in the closed state
        // and let the user decide whether to restart or close the Pane; usually the page's
        // closed-event coordination removes the Pane first, so this is only a fallback for lost
        // events/races.
        setErrorState({ kind: "session-closed" });
        return;
      }
      // After a full application restart the backend registry is empty, but some environments may
      // still leave persisted bindings. Clear the stale sessionId and hand the surface back to
      // the startup gate below: one explicitly created in this window (launchAuthorized) is
      // rebuilt automatically by launchSpec; an unauthorized surface restored from layout parks
      // in the dormant placeholder and waits for an explicit user restart, never silently
      // spawning a process.
      bindings.delete(surface.surfaceId);
      setCreatedSession(null);
      return;
    }
    // Layout restoration deliberately does not authorize process creation.
    // Existing live bindings may reattach, but an unbound restored surface
    // remains dormant until restartFromLaunchSpec records explicit consent.
    if (!launchAuthorized && !pendingEnsure) return;
    // A brand-new surface has no old binding to reconcile, so create the PTY directly. Writing
    // the binding in create() triggers this effect to rerun; pendingEnsure keeps the rerun
    // subscribed to the same Promise until either the create response or terminal:event provides
    // a renderable session.
    const ensurePromise =
      pendingEnsure ??
      ensureTerminalPaneSession(surface, {
        client,
        bindings,
      });
    ensureSessionPromiseRef.current = ensurePromise;
    let cancelled = false;
    void ensurePromise
      .then((created) => {
        if (cancelled) return;
        if (ensureSessionPromiseRef.current === ensurePromise) {
          ensureSessionPromiseRef.current = null;
        }
        setCreatedSession(created);
      })
      .catch((error) => {
        if (cancelled) return;
        if (ensureSessionPromiseRef.current === ensurePromise) {
          ensureSessionPromiseRef.current = null;
        }
        setErrorState(
          error instanceof TerminalPaneSshPromptError
            ? { kind: "ssh-prompt" }
            : {
                kind: "create-failed",
                message: error instanceof Error ? error.message : String(error),
              },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    bindings,
    boundSessionId,
    client,
    errorState,
    launchAuthorized,
    session,
    sessionsLoaded,
    surface,
  ]);

  useEffect(() => {
    if (!sessionId) return;
    try {
      const release = lease.acquire(sessionId, paneId);
      setLeasedSessionId(sessionId);
      return () => {
        release();
        setLeasedSessionId((current) => (current === sessionId ? null : current));
      };
    } catch (error) {
      // The reducer's surface uniqueness already prevents double Panes; this is only a defensive
      // degradation.
      setErrorState({
        kind: "lease",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }, [lease, paneId, sessionId]);

  const handleViewportError = useCallback(
    (errorSessionId: string, message: string | null) => {
      setViewportError(message);
      // The most common cause of persistent attach failures is a ghost session (lost on the
      // backend while still in the frontend list). Bubble it up for the page to authoritatively
      // verify; a transient error will be recognized as still alive during verification and
      // leave the list untouched.
      if (message) onSessionGhost?.(errorSessionId);
    },
    [onSessionGhost],
  );

  // SSH reconnect: errors are shown as a banner; "already in progress" means the automatic
  // reconnect loop has taken over.
  const [reconnectPending, setReconnectPending] = useState(false);
  const reconnectSsh = useCallback(() => {
    const targetSessionId = bindings.get(surface.surfaceId);
    if (!targetSessionId || reconnectPending) return;
    setReconnectPending(true);
    void client
      .sshReconnect(targetSessionId)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("already in progress")) {
          setViewportError(message);
        }
      })
      .finally(() => setReconnectPending(false));
  }, [bindings, client, reconnectPending, surface.surfaceId]);

  // SSH latency: probed at a fixed interval only when focused and the viewport is ready; on
  // failure it is silently set to unknown ("--").
  const isSshPane = surface.kind === "sshTerminal";
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const latencyEligible =
    isSshPane && isFocused && sessionId !== null && session?.running === true && !errorState;
  useEffect(() => {
    if (!latencyEligible || !sessionId) {
      setLatencyMs(null);
      return;
    }
    let cancelled = false;
    const probe = () => {
      void client
        .sshLatency(sessionId)
        .then((result) => {
          if (!cancelled) setLatencyMs(result.latencyMs);
        })
        .catch(() => {
          if (!cancelled) setLatencyMs(null);
        });
    };
    probe();
    const timer = window.setInterval(probe, SSH_LATENCY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, latencyEligible, sessionId]);

  const restartFromLaunchSpec = useCallback(() => {
    const staleSessionId = bindings.get(surface.surfaceId);
    if (staleSessionId) {
      // When a stale session restarts, reclaim its registry entry along the way; failure does
      // not block the rebuild.
      void client.close(staleSessionId).catch(() => {});
    }
    autoLaunch.authorize(surface.surfaceId);
    setLaunchRequestedSurfaceId(surface.surfaceId);
    bindings.delete(surface.surfaceId);
    setCreatedSession(null);
    setViewportError(null);
    setErrorState(null);
  }, [autoLaunch, bindings, client, surface.surfaceId]);

  const errorMessageFor = (state: TerminalPaneErrorState): string => {
    switch (state.kind) {
      case "ssh-prompt":
        return t("workbench.terminalSshPrompt");
      case "session-closed":
        return t("workbench.terminalSessionMissing");
      case "create-failed":
      case "lease":
        return state.message || t("workbench.terminalError");
      default:
        return t("workbench.terminalError");
    }
  };

  const leased = session !== null && leasedSessionId === session.id;
  let phase: TerminalPaneSurfacePhase;
  let renderSession: TerminalSession | null = null;
  let errorMessage: string | null = null;
  let onRetry: (() => void) | undefined = restartFromLaunchSpec;
  if (errorState) {
    phase = "error";
    errorMessage = errorMessageFor(errorState);
  } else if (leased && session) {
    renderSession = session;
    if (viewportError) {
      // The viewport itself retries attach with backoff; the banner only reflects transient
      // errors, and retrying merely clears the banner.
      phase = "error";
      errorMessage = viewportError;
      onRetry = () => setViewportError(null);
    } else {
      phase = session.running ? "ready" : "exited";
    }
  } else if (!launchAuthorized && !boundSessionId) {
    phase = "dormant";
  } else {
    phase = "connecting";
    onRetry = undefined;
  }

  const commonProps = {
    paneId,
    client,
    session: renderSession,
    phase,
    theme,
    isActive: isFocused,
    errorMessage,
    onRetry,
    onError: handleViewportError,
  };
  const closeConfirmBar =
    closeRequest && session ? (
      <div
        data-terminal-pane-close-confirm={paneId}
        className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      >
        <span className="min-w-0 flex-1 truncate">
          {t("projectTools.closeRunningTerminal").replace(
            "{title}",
            formatTerminalSessionTitle(session.title, t("projectTools.terminalTitle")),
          )}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={closeRequest.busy}
          onClick={closeRequest.onCancel}
        >
          {t("settings.cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={closeRequest.busy}
          onClick={closeRequest.onConfirm}
        >
          {t("projectTools.close")}
        </Button>
      </div>
    ) : null;
  // The wrapper is always present so toggling the confirm bar never remounts
  // the viewport (xterm keeps its buffer and attach stream).
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {closeConfirmBar}
      {surface.kind === "sshTerminal" ? (
        <SshTerminalPaneSurface
          {...commonProps}
          onReconnect={renderSession ? reconnectSsh : undefined}
          isReconnecting={reconnectPending}
          latencyMs={latencyMs}
          isCompact={isCompact}
        />
      ) : (
        <LocalTerminalPaneSurface {...commonProps} />
      )}
    </div>
  );
}
