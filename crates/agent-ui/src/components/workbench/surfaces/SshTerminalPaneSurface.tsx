import { RefreshCw } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "../../../lib/shared/utils";
import { sshSessionEndpointLabel, sshSessionStatus } from "../../../lib/terminal/sshSessionStatus";
import type { TerminalClient, TerminalSession } from "../../../lib/terminal/types";
import { Button } from "../../ui/button";
import {
  LocalTerminalPaneSurface,
  type TerminalPaneSurfacePhase,
} from "./LocalTerminalPaneSurface";

export type SshTerminalPaneSurfaceProps = {
  paneId: string;
  client: TerminalClient;
  session: TerminalSession | null;
  phase: TerminalPaneSurfacePhase;
  theme: "light" | "dark";
  isActive: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
  onError: (sessionId: string, message: string | null) => void;
  /** Trigger an ssh reconnect; injected by the host (the component never touches Tauri). When omitted, no reconnect button is shown. */
  onReconnect?: () => void;
  /** The host's reconnect call is in progress (displayed on top of the session's own reconnecting state). */
  isReconnecting?: boolean;
  /** Round-trip latency polled by the host; null/omitted shows "--" (unknown). */
  latencyMs?: number | null;
  /** Very narrow Pane: the status row hides the endpoint label, keeping only the status dot + latency + reconnect. */
  isCompact?: boolean;
};

/**
 * SSH terminal Pane: overlays LocalTerminalPaneSurface with a compact connection status row
 * (status dot / endpoint label / latency / reconnect button). exited/error/placeholder semantics are fully inherited
 * from Local; SFTP stays in the workspace overlay, and the Pane carries only the shell viewport.
 */
export function SshTerminalPaneSurface(props: SshTerminalPaneSurfaceProps) {
  const {
    paneId,
    client,
    session,
    phase,
    theme,
    isActive,
    errorMessage,
    onRetry,
    onError,
    onReconnect,
    isReconnecting,
    latencyMs,
    isCompact,
  } = props;
  const { t } = useLocale();

  const status = session ? sshSessionStatus(session) : null;
  const reconnecting = Boolean(isReconnecting) || status === "reconnecting";
  const statusLabel =
    status === "connected"
      ? t("workbench.sshStatusConnected")
      : status === "reconnecting"
        ? t("workbench.sshStatusReconnecting")
        : t("workbench.sshStatusDisconnected");
  // Latency coloring reuses the status dot's three colors: <100ms green / <300ms yellow / otherwise red; unknown gray.
  const latencyKnown = typeof latencyMs === "number" && Number.isFinite(latencyMs);
  const latencyClass = !latencyKnown
    ? "text-muted-foreground/70"
    : latencyMs < 100
      ? "text-emerald-500"
      : latencyMs < 300
        ? "text-amber-500"
        : "text-destructive";

  return (
    <div
      data-workbench-ssh-pane={paneId}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {session ? (
        <div
          data-terminal-pane-ssh-status={status ?? "unknown"}
          className="flex h-7 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-3 text-[11px] text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              status === "connected"
                ? "bg-emerald-500"
                : status === "reconnecting"
                  ? "bg-amber-500"
                  : "bg-destructive",
            )}
          />
          <span className="sr-only">{statusLabel}</span>
          {isCompact ? (
            <span aria-hidden="true" className="min-w-0 flex-1" />
          ) : (
            <span
              className="min-w-0 flex-1 truncate font-mono"
              title={sshSessionEndpointLabel(session)}
            >
              {sshSessionEndpointLabel(session)}
            </span>
          )}
          <span
            data-terminal-pane-ssh-latency={
              latencyKnown ? String(Math.round(latencyMs)) : "unknown"
            }
            title={t("workbench.sshLatency")}
            className={cn("shrink-0 font-mono tabular-nums", latencyClass)}
          >
            {latencyKnown ? `${Math.round(latencyMs)}ms` : "--"}
          </span>
          {onReconnect ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 gap-1 px-1.5 text-[11px]"
              title={t("workbench.sshReconnect")}
              aria-label={t("workbench.sshReconnect")}
              disabled={reconnecting}
              onClick={onReconnect}
            >
              <RefreshCw className={cn("h-3 w-3", reconnecting && "animate-spin")} />
              {t("workbench.sshReconnect")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <LocalTerminalPaneSurface
        paneId={paneId}
        client={client}
        session={session}
        phase={phase}
        theme={theme}
        isActive={isActive}
        errorMessage={errorMessage}
        onRetry={onRetry}
        onError={onError}
      />
    </div>
  );
}
