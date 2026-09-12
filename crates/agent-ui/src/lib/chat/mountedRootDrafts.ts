import { rootAliasFromPath } from "../../components/chat/workspace-project-settings/workspaceProjectSettingsUtils";
import type {
  WorkspaceProjectRootDraft,
  WorkspaceProjectRootGrant,
} from "../../contracts/workspaceProjectRoots";

export type MountedRootDraftsResult = {
  /** The full merged draft list of existing grants + newly added folders (save
   * requires a full submission). */
  drafts: WorkspaceProjectRootDraft[];
  addedPaths: string[];
  skippedInsideWorkspace: string[];
  skippedOverlapping: string[];
};

function normalizeDirPath(path: string) {
  const trimmed = path.trim().replace(/\\/g, "/");
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

function pathsOverlap(a: string, b: string) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Merge folders dropped into the upload area into the existing attached-root
 * drafts. Directories inside the workspace are already accessible, and
 * directories overlapping existing grants are transactionally rejected by the
 * backend; both kinds are skipped up front and reported separately, ensuring a
 * mixed drop does not fail as a whole because of an individual directory.
 */
export function buildMountedRootDrafts(params: {
  projectPath: string;
  existingGrants: readonly WorkspaceProjectRootGrant[];
  folderPaths: readonly string[];
  now?: number;
}): MountedRootDraftsResult {
  const { projectPath, existingGrants, folderPaths } = params;
  const now = params.now ?? Date.now();
  const workspacePath = normalizeDirPath(projectPath);
  const drafts: WorkspaceProjectRootDraft[] = existingGrants.map((grant) => ({
    id: grant.id,
    alias: grant.alias,
    displayPath: grant.displayPath,
    access: grant.access,
  }));
  const aliases = new Set(existingGrants.map((grant) => grant.alias));
  const mountedPaths = existingGrants.map((grant) => normalizeDirPath(grant.displayPath));
  const addedPaths: string[] = [];
  const skippedInsideWorkspace: string[] = [];
  const skippedOverlapping: string[] = [];

  for (const folderPath of folderPaths) {
    const normalized = normalizeDirPath(folderPath);
    if (!normalized) continue;
    if (
      workspacePath &&
      (normalized === workspacePath || normalized.startsWith(`${workspacePath}/`))
    ) {
      skippedInsideWorkspace.push(normalized);
      continue;
    }
    if (mountedPaths.some((mounted) => pathsOverlap(mounted, normalized))) {
      skippedOverlapping.push(normalized);
      continue;
    }
    const alias = rootAliasFromPath(normalized, aliases);
    aliases.add(alias);
    mountedPaths.push(normalized);
    drafts.push({
      id: `draft-${now}-${drafts.length}`,
      alias,
      displayPath: normalized,
      access: "read",
    });
    addedPaths.push(normalized);
  }

  return { drafts, addedPaths, skippedInsideWorkspace, skippedOverlapping };
}
