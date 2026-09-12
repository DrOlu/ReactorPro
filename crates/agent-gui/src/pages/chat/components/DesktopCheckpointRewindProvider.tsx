import {
  type CheckpointRewindClient,
  CheckpointRewindProvider,
  type CheckpointRewoundInfo,
} from "@liveagent/ui/lib/chat/checkpointRewind";
import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useCallback } from "react";
import type { WorkspaceProject } from "../../../lib/settings";
import { listWorkspaceRootGrants } from "../../../lib/workspaceRootGrants";

// Desktop transport layer: checkpoint data exists only on the desktop machine, so go directly
// through Tauri invoke. The WebUI counterpart lives in GatewayAppView (relayed to the same set of
// commands through the gateway checkpoint passthrough arm).
const desktopCheckpointRewindClient: CheckpointRewindClient = {
  list: (conversationId) => invoke("checkpoint_list", { conversation_id: conversationId }),
  preview: ({ conversationId, turnSeq, authorizedRoots }) =>
    invoke("checkpoint_diff_stats", {
      conversation_id: conversationId,
      turn_seq: turnSeq,
      authorized_roots: authorizedRoots,
    }),
  rewind: ({ conversationId, turnSeq, authorizedRoots, expected }) =>
    invoke("checkpoint_rewind_code", {
      conversation_id: conversationId,
      turn_seq: turnSeq,
      authorized_roots: authorizedRoots,
      expected,
    }),
};

export function DesktopCheckpointRewindProvider(props: {
  children: ReactNode;
  conversationId: string;
  /** Workspace root of the current conversation: the baseline entry of the authorization set. */
  workspaceRoot?: string;
  /** Currently active project: used to obtain additional authorization roots (workspace root grants). */
  project?: Pick<WorkspaceProject, "id" | "path"> | null;
  disabled?: boolean;
  /** Callback after the rewind completes (notifications/transcript records are handled by the host page). */
  onRewound?: (info: CheckpointRewoundInfo) => void;
}) {
  const { children, conversationId, workspaceRoot, project, disabled, onRewound } = props;

  // The only source of rewind authorization: the current conversation workspace root plus
  // additional authorization roots that are still active and writable. The backend only recognizes
  // roots in this set; an absolute path stored in a record does not by itself constitute authorization.
  //
  // access must be filtered as well: rewind is a write operation (overwrite/delete), and read-only
  // roots must not be written. Ordinary file tools carry access all the way to pathUtils'
  // canMutate gate, but here only the path is passed to the backend and access is lost immediately,
  // so this gate can only be supplied at this step.
  const resolveAuthorizedRoots = useCallback(async () => {
    const roots: string[] = [];
    const push = (raw?: string | null) => {
      const value = raw?.trim();
      if (value && !roots.includes(value)) roots.push(value);
    };
    push(workspaceRoot);
    if (project) {
      try {
        const grants = await listWorkspaceRootGrants(project);
        for (const grant of grants) {
          if (grant.state === "active" && grant.access === "write") push(grant.canonicalPath);
        }
      } catch {
        // When additional authorization roots cannot be fetched, keep only the workspace root: better to rewind less than to write without authorization.
      }
    }
    return roots;
  }, [project, workspaceRoot]);

  return (
    <CheckpointRewindProvider
      client={desktopCheckpointRewindClient}
      conversationId={conversationId}
      disabled={disabled}
      resolveAuthorizedRoots={resolveAuthorizedRoots}
      onRewound={onRewound}
    >
      {children}
    </CheckpointRewindProvider>
  );
}
