import { Loader2, Terminal } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "../../../lib/shared/utils";
import type { TerminalClient, TerminalSession } from "../../../lib/terminal/types";
import { XTermViewport } from "../../project-tools/XTermViewport";
import { Button } from "../../ui/button";

export type TerminalPaneSurfacePhase = "dormant" | "connecting" | "ready" | "exited" | "error";

export type LocalTerminalPaneSurfaceProps = {
  paneId: string;
  client: TerminalClient;
  /** null when no session is established (connecting/failed); when non-null the viewport stays mounted to preserve output. */
  session: TerminalSession | null;
  phase: TerminalPaneSurfacePhase;
  theme: "light" | "dark";
  isActive: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
  onError: (sessionId: string, message: string | null) => void;
};

/**
 * Pure controlled presentation layer for a terminal pane: shared by local and
 * SSH initially. When a session exists it always renders XTermViewport
 * (exited/error only overlays a hint bar without clearing the screen), and only
 * when there is no displayable session does it use a centered placeholder,
 * ensuring phase switches do not remount the viewport.
 */
export function LocalTerminalPaneSurface(props: LocalTerminalPaneSurfaceProps) {
  const { paneId, client, session, phase, theme, isActive, errorMessage, onRetry, onError } = props;
  const { t } = useLocale();

  const banner =
    session && phase === "error" ? (
      <div
        data-terminal-pane-banner="error"
        className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
      >
        <span className="min-w-0 flex-1 truncate">
          {errorMessage || t("workbench.terminalError")}
        </span>
        {onRetry ? (
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRetry}>
            {t("workbench.terminalRetry")}
          </Button>
        ) : null}
      </div>
    ) : session && phase === "exited" ? (
      <div
        data-terminal-pane-banner="exited"
        className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <span className="min-w-0 flex-1 truncate">
          {t("workbench.terminalExited")}
          {session.exitCode != null ? (
            <span className="ml-1.5 font-mono">({session.exitCode})</span>
          ) : null}
        </span>
        {onRetry ? (
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRetry}>
            {t("workbench.terminalRestart")}
          </Button>
        ) : null}
      </div>
    ) : null;

  return (
    <div
      data-workbench-pane-id={paneId}
      data-workbench-surface="terminal"
      data-workbench-surface-id={session ? `terminal-session:${session.id}` : undefined}
      data-terminal-phase={phase}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {banner}
      {session ? (
        <div className="relative min-h-0 flex-1">
          <XTermViewport
            client={client}
            session={session}
            theme={theme}
            isActive={isActive}
            onError={onError}
          />
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/70">
            {phase === "connecting" ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Terminal className="h-5 w-5" />
            )}
          </div>
          <div className={cn(phase === "error" && "text-destructive")}>
            {phase === "connecting"
              ? t("workbench.terminalConnecting")
              : phase === "dormant"
                ? t("workbench.terminalRestoreRequired")
                : phase === "exited"
                  ? t("workbench.terminalExited")
                  : errorMessage || t("workbench.terminalError")}
          </div>
          {phase !== "connecting" && onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {phase === "dormant"
                ? t("workbench.terminalRestore")
                : phase === "exited"
                  ? t("workbench.terminalRestart")
                  : t("workbench.terminalRetry")}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
