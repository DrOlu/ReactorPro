/**
 * Sidebar project grouping. Members are stored with their raw paths (normalized via
 * `workspaceProjectPathKey` on match), consistent with hidden/missing/archived.
 *
 * `sourceProjectPath` marks an automatic group (git worktree aggregation): the path of
 * the original repository project, which can still be used to reuse the group after it
 * is renamed, avoiding duplicate groups.
 */
export type WorkspaceProjectGroup = {
  id: string;
  name: string;
  projectPaths: string[];
  sourceProjectPath?: string;
  collapsed?: boolean;
  createdAt: number;
  updatedAt: number;
};
