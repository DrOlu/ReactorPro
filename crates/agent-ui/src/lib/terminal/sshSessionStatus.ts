import type { TerminalSession } from "./types";

export type SshSessionStatus = "connected" | "reconnecting" | "disconnected";

/**
 * Unified derivation of SSH session connection status: the backend `ssh.status` is authoritative,
 * but once the session process has stopped it is always treated as disconnected (a status event may
 * arrive after the process exits). Unknown statuses are conservatively treated as disconnected.
 * Shared by WorkspaceSshTerminalOverlay and SshTerminalPaneSurface.
 */
export function sshSessionStatus(session: TerminalSession): SshSessionStatus {
  const status = session.ssh?.status ?? (session.running ? "connected" : "disconnected");
  if (status === "connected" && !session.running) return "disconnected";
  if (status === "connected" || status === "reconnecting") return status;
  return "disconnected";
}

/** Target endpoint label of an SSH session (user@host:port); non-SSH sessions fall back to cwd. */
export function sshSessionEndpointLabel(session: TerminalSession): string {
  const ssh = session.ssh;
  if (!ssh) return session.cwd || session.projectPathKey;
  const userPrefix = ssh.username.trim() ? `${ssh.username.trim()}@` : "";
  return `${userPrefix}${ssh.host}:${ssh.port}`;
}
