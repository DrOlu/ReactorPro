import { type WorkspaceProject, workspaceProjectPathKey } from "../../../lib/settings";

/**
 * Core of focusedPane -> activeProject resolution: the projectPathKey carried by the focused Pane (or its fallback
 * target) maps to the workspace project the Right Dock should follow.
 *
 * Invariants (docs/design/session-workbench-pane-architecture.md §30.2):
 * - archived / missing projects are not activated -- the Pane enters the blocked state and the dock keeps its original project;
 * - a stale ProjectRef (synthetic key, deleted project) never falls back to another project;
 * - matching is by normalized path key, using the same key space as the blocked determination.
 */
export function resolveWorkbenchPaneProject(
  projectPathKey: string | undefined,
  input: {
    workspaceProjects: readonly WorkspaceProject[];
    archivedWorkspaceProjectPathKeys: ReadonlySet<string>;
    missingWorkspaceProjectPathKeys: ReadonlySet<string>;
  },
): WorkspaceProject | null {
  if (!projectPathKey) return null;
  if (input.archivedWorkspaceProjectPathKeys.has(projectPathKey)) return null;
  if (input.missingWorkspaceProjectPathKeys.has(projectPathKey)) return null;
  return (
    input.workspaceProjects.find(
      (project) => workspaceProjectPathKey(project.path) === projectPathKey,
    ) ?? null
  );
}
