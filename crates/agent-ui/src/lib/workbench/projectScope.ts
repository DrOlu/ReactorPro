import { workspaceProjectPathKey } from "@liveagent/ui/lib/settings/workspaceProjects";

function hasParentTraversalSegment(pathKey: string): boolean {
  return pathKey.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * Frontend guardrail: determines whether a cwd falls within a project's scope.
 *
 * It only checks normalized string shape — no symlink resolution and no
 * filesystem access, so it will miss symlink escapes. The real authorization
 * boundary is the Rust-side `canonicalize_workdir_within` (canonicalize on both
 * sides + containment check); this exists to block out-of-bounds panes already
 * at drop/restore time instead of exposing the problem only when the backend
 * errors. Layout JSON is not an authorization credential: even if the frontend
 * lets it through, the backend still re-verifies independently.
 */
export function pathIsInsideProject(path: unknown, projectPathKey: unknown): boolean {
  const projectKey = workspaceProjectPathKey(projectPathKey);
  if (!projectKey) return false;
  const pathKey = workspaceProjectPathKey(path);
  if (!pathKey) return false;
  // `..` cannot be resolved safely without touching the filesystem, so it is always treated as out of bounds.
  if (hasParentTraversalSegment(pathKey) || hasParentTraversalSegment(projectKey)) return false;
  if (pathKey === projectKey) return true;
  const prefix = projectKey.endsWith("/") ? projectKey : `${projectKey}/`;
  return pathKey.startsWith(prefix);
}

/**
 * Whether a terminal surface's launchSpec.cwd shares the same origin as its
 * ProjectRef.
 *
 * `localTerminal` and `sshTerminal` are treated the same: for both surface kinds
 * the cwd is a **local project anchor** — `create_ssh` also canonicalizes it
 * locally (it is the local root for SFTP) rather than a remote working
 * directory. So the containment check has identical semantics for both kinds,
 * and out-of-bounds panes are blocked at drop/restore time.
 */
export function terminalLaunchSpecIsInProject(surface: {
  kind: "localTerminal" | "sshTerminal";
  project: { projectPathKey: string };
  launchSpec: { cwd: string };
}): boolean {
  return pathIsInsideProject(surface.launchSpec.cwd, surface.project.projectPathKey);
}
