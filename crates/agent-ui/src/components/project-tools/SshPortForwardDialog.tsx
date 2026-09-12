import { Cable, Loader2 } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useRef, useState } from "react";
import type {
  SshLocalForwardAction,
  SshLocalForwardClient,
} from "../../lib/terminal/sshLocalForwardTypes";
import {
  isSshLocalForwardPortDraft,
  validateSshLocalForwardTarget,
} from "../../lib/terminal/sshLocalForwardTypes";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export type SshPortForwardDialogProps = {
  sessionId: string;
  projectPathKey?: string;
  /** Session identifier (title · user@host:port), computed and passed in by the panel. */
  subtitle: string;
  /** Platform transport client (Tauri IPC / gateway WS), injected by the panel to keep this file mirrorable. */
  client: SshLocalForwardClient;
  onClose: () => void;
  /** Forwarding was established; the panel takes the action snapshot and closes this dialog. */
  onStarted: (action: SshLocalForwardAction) => void;
};

// The modal portals to body, escaping the dock's --zone-font-scale scope,
// so a fixed font size is used here just like in confirm-dialog.
const FIELD_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-border/70 bg-background/80 px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-indigo-500/50 focus-visible:ring-1 focus-visible:ring-indigo-500/20 disabled:opacity-50";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * "Add port mapping" modal: local port (empty = auto), remote host (empty = 127.0.0.1),
 * remote port. Before submitting, `checkLocalPort` detects whether the local port is in
 * use and aborts with an error if so; the authoritative bind failure in `start` falls
 * back to displaying the backend's original error.
 */
export function SshPortForwardDialog(props: SshPortForwardDialogProps) {
  const { sessionId, projectPathKey, subtitle, client, onClose, onStarted } = props;
  const { t } = useLocale();
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submittingRef = useRef(false);
  // The blur check is asynchronous: by the time the result returns the draft may have
  // changed, so a ref is used to discard stale results.
  const localPortRef = useRef("");
  localPortRef.current = localPort;

  const portInUseMessage = (port: number) =>
    t("projectTools.sshLocalForwardPortInUse").replace("{port}", String(port));

  const handleLocalPortBlur = () => {
    const port = Number(localPort);
    if (!localPort || !Number.isInteger(port) || port < 1 || port > 65535) return;
    void client
      .checkLocalPort(port)
      .then((available) => {
        if (available || localPortRef.current !== String(port)) return;
        setError(portInUseMessage(port));
      })
      .catch(() => {
        // A failed early hint does not matter; it is checked again on submit.
      });
  };

  const handleSubmit = () => {
    if (submittingRef.current) return;
    const target = validateSshLocalForwardTarget(remoteHost, remotePort, localPort);
    if (!target) {
      setError(t("projectTools.sshLocalForwardInvalidTarget"));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    void (async () => {
      try {
        if (target.localPort > 0) {
          // A failed check (command error) does not block: the bind in start is the authoritative verdict.
          const available = await client.checkLocalPort(target.localPort).catch(() => true);
          if (!available) {
            setError(portInUseMessage(target.localPort));
            return;
          }
        }
        const action = await client.start({
          sessionId,
          projectPathKey,
          remoteHost: target.remoteHost,
          remotePort: target.remotePort,
          localPort: target.localPort,
        });
        onStarted(action);
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    })();
  };

  const previewLocal = localPort || t("projectTools.sshLocalForwardAutoPort");
  const previewHost = remoteHost.trim() || "127.0.0.1";
  const previewPort = remotePort || "?";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-w-md p-0"
        closeDisabled={submitting}
        closeLabel={t("projectTools.sshLocalForwardCancel")}
        showCloseButton
      >
        <DialogHeader className="flex-row items-start gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-indigo-500/25 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
              <Cable className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="break-words">
                {t("projectTools.sshLocalForwardModalTitle")}
              </DialogTitle>
              <DialogDescription className="mt-1 break-words font-mono text-xs leading-5">
                {subtitle}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <DialogBody className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="ssh-forward-local-port"
                  className="text-xs font-medium text-foreground"
                >
                  {t("projectTools.sshLocalForwardLocalPortLabel")}
                </label>
                <input
                  id="ssh-forward-local-port"
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  value={localPort}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (!isSshLocalForwardPortDraft(value)) return;
                    setLocalPort(value);
                    setError("");
                  }}
                  onBlur={handleLocalPortBlur}
                  className={cn(FIELD_CLASS, "font-mono")}
                  placeholder={t("projectTools.sshLocalForwardAutoPort")}
                  disabled={submitting}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="ssh-forward-remote-port"
                  className="text-xs font-medium text-foreground"
                >
                  {t("projectTools.sshLocalForwardRemotePortLabel")}
                </label>
                <input
                  id="ssh-forward-remote-port"
                  type="text"
                  inputMode="numeric"
                  value={remotePort}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (!isSshLocalForwardPortDraft(value)) return;
                    setRemotePort(value);
                    setError("");
                  }}
                  className={cn(FIELD_CLASS, "font-mono")}
                  placeholder={t("projectTools.sshLocalForwardRemotePortLabel")}
                  disabled={submitting}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label
                htmlFor="ssh-forward-remote-host"
                className="text-xs font-medium text-foreground"
              >
                {t("projectTools.sshLocalForwardRemoteHostLabel")}
              </label>
              <input
                id="ssh-forward-remote-host"
                type="text"
                value={remoteHost}
                onChange={(event) => {
                  setRemoteHost(event.currentTarget.value);
                  setError("");
                }}
                className={FIELD_CLASS}
                placeholder={t("projectTools.sshLocalForwardHostPlaceholder")}
                disabled={submitting}
              />
            </div>

            <div className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 font-mono text-xs text-muted-foreground">
              127.0.0.1:{previewLocal}
              <span className="mx-1.5 text-muted-foreground/60">→</span>
              {previewHost}:{previewPort}
            </div>

            <div className="text-xs leading-5 text-muted-foreground">
              {t("projectTools.sshLocalForwardHelp")}
            </div>

            {error ? (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
          </DialogBody>

          <DialogFooter className="bg-muted/20">
            <DialogActions>
              <DialogClose render={<Button type="button" variant="outline" />}>
                {t("projectTools.sshLocalForwardCancel")}
              </DialogClose>
              <Button type="submit" disabled={submitting}>
                {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {t("projectTools.sshLocalForwardSubmit")}
              </Button>
            </DialogActions>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
