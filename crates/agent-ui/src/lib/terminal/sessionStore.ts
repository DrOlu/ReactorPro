import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import type { TerminalEvent, TerminalSession } from "@liveagent/ui/lib/terminal/types";

export function sortTerminalSessions(sessions: readonly TerminalSession[]) {
  return [...sessions].sort((a, b) => {
    const leftProject = workspaceProjectPathKey(a.projectPathKey || a.cwd);
    const rightProject = workspaceProjectPathKey(b.projectPathKey || b.cwd);
    return leftProject.localeCompare(rightProject) || a.createdAt - b.createdAt;
  });
}

export function terminalSessionBelongsToProject(session: TerminalSession, projectPathKey: string) {
  const wantedProjectKey = workspaceProjectPathKey(projectPathKey);
  if (!wantedProjectKey) return false;
  const sessionProjectKey = workspaceProjectPathKey(session.projectPathKey || session.cwd);
  return sessionProjectKey === wantedProjectKey;
}

export function replaceTerminalSessionsForProject(
  current: readonly TerminalSession[],
  projectPathKey: string,
  projectSessions: readonly TerminalSession[],
) {
  const key = workspaceProjectPathKey(projectPathKey);
  if (!key) {
    return sortTerminalSessions(current);
  }
  return sortTerminalSessions([
    ...current.filter((session) => !terminalSessionBelongsToProject(session, key)),
    ...projectSessions.filter((session) => terminalSessionBelongsToProject(session, key)),
  ]);
}

export function applyTerminalEventToSessions(
  current: readonly TerminalSession[],
  event: TerminalEvent,
) {
  if (event.kind === "closed") {
    return sortTerminalSessions(current.filter((session) => session.id !== event.sessionId));
  }

  const session = event.session;
  if (!session?.id) {
    return sortTerminalSessions(current);
  }

  const index = current.findIndex((item) => item.id === session.id);
  if (index >= 0) {
    const next = [...current];
    next[index] = session;
    return sortTerminalSessions(next);
  }

  // Only created adds an unknown session to the list. Other kinds (exit/resized/renamed/
  // reconnecting...) always ignore unknown ids: there is a race between close and the PTY reader
  // thread, so a late exit may arrive after closed; appending it blindly would resurrect a
  // just-closed session as a ghost (a tab appearing in the dock whose attach is doomed to fail).
  if (event.kind === "created") {
    return sortTerminalSessions([...current, session]);
  }

  return sortTerminalSessions(current);
}

/** Upsert one authoritative session record (create/attach snapshot). */
export function mergeTerminalSession(
  current: readonly TerminalSession[],
  session: TerminalSession,
) {
  return sortTerminalSessions([...current.filter((item) => item.id !== session.id), session]);
}

export function removeTerminalSession(current: readonly TerminalSession[], sessionId: string) {
  return sortTerminalSessions(current.filter((session) => session.id !== sessionId));
}

/**
 * Replace the SSH subset with an authoritative SSH list while leaving local
 * sessions untouched (the SSH panel reconciles only its own kind).
 */
export function reconcileSshTerminalSessions(
  current: readonly TerminalSession[],
  sshSessions: readonly TerminalSession[],
) {
  const normalized = sshSessions.filter((session) => session.kind === "ssh" && session.id);
  return sortTerminalSessions([
    ...current.filter((session) => session.kind !== "ssh"),
    ...normalized,
  ]);
}
