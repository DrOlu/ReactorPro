import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type CheckpointTurnSummary = {
  turnSeq: number;
  turnId: string;
  fileCount: number;
  dirCount: number;
  /** This turn has capture-failure records (incomplete pre-image), so a rewind may miss some files. */
  incomplete: boolean;
  firstCapturedAt: number;
};

export type CheckpointDiffStats = {
  turnSeq: number;
  restoreFiles: number;
  deleteFiles: number;
  cleanFiles: number;
  skippedDirs: number;
  missingBlobs: number;
  /** Entries whose root is no longer in the current authorized workspace set, or with a symlink along the path chain: never rewound. */
  unresolvableFiles: number;
  captureErrors: number;
  entries: { path: string; key: string; action: string; currentHash?: string }[];
};

export type CheckpointRewindResult = {
  turnSeq: number;
  restoredFiles: number;
  deletedFiles: number;
  cleanFiles: number;
  skippedDirs: number;
  /** Number of records that already failed during capture within the target range: these files have no pre-image, and the rewind did not touch them. */
  captureErrors: number;
  /** Files modified externally after the preview and skipped without overwrite (conflict detection). */
  conflicts: string[];
  failed: string[];
};

/** Transport layer implemented separately by each end: the desktop goes through Tauri invoke, the WebUI through the gateway's checkpoint passthrough arm. */
export type CheckpointRewindClient = {
  list: (conversationId: string) => Promise<CheckpointTurnSummary[]>;
  preview: (params: {
    conversationId: string;
    turnSeq: number;
    authorizedRoots: string[];
  }) => Promise<CheckpointDiffStats>;
  rewind: (params: {
    conversationId: string;
    turnSeq: number;
    authorizedRoots: string[];
    expected: { key: string; currentHash: string }[];
  }) => Promise<CheckpointRewindResult>;
};

export type CheckpointRewoundInfo = {
  turnSeq: number;
  restoredFiles: number;
  deletedFiles: number;
  conflicts: number;
  failed: number;
  /** Number of files that failed already during capture: no pre-image, and the rewind did not touch them. */
  captureErrors: number;
};

/**
 * Shared copy for the rewind-completion notification: both ends' onRewound use it to
 * avoid template drift.
 * - Zero counts are never shown; when there are no file changes at all, say plainly
 *   "no file changes were needed".
 * - Numbers and quantifiers are pinned with a non-breaking space (U+00A0) so that
 *   "1 file" does not wrap onto two lines in a narrow toast.
 * - Problem items (conflicts/failures/no pre-image) are collected into a parenthetical
 *   trailing note, layered separately from the main result.
 */
export function formatCheckpointRewoundNotification(
  info: CheckpointRewoundInfo,
  zh: boolean,
): { level: "success" | "error"; message: string } {
  const nb = (value: number) => `\u00A0${value}\u00A0`;
  const files = (value: number) => `${value} ${value === 1 ? "file" : "files"}`;
  const changes: string[] = [];
  const issues: string[] = [];
  if (zh) {
    if (info.restoredFiles > 0) changes.push(`restored${nb(info.restoredFiles)}files`);
    if (info.deletedFiles > 0) changes.push(`deleted${nb(info.deletedFiles)}files`);
    if (info.conflicts > 0) issues.push(`${nb(info.conflicts)}conflicts skipped`);
    if (info.failed > 0) issues.push(`${nb(info.failed)}failed`);
    if (info.captureErrors > 0) issues.push(`${info.captureErrors}\u00A0without pre-image`);
  } else {
    if (info.restoredFiles > 0) changes.push(`restored ${files(info.restoredFiles)}`);
    if (info.deletedFiles > 0) changes.push(`deleted ${files(info.deletedFiles)}`);
    if (info.conflicts > 0)
      issues.push(`${info.conflicts} conflict${info.conflicts === 1 ? "" : "s"} skipped`);
    if (info.failed > 0) issues.push(`${info.failed} failed`);
    if (info.captureErrors > 0) issues.push(`${info.captureErrors} without pre-image`);
  }
  const head = zh
    ? changes.length > 0
      ? `Code rewound: ${changes.join(", ")}`
      : "Code rewound: no file changes were needed"
    : changes.length > 0
      ? `Code rewound: ${changes.join(", ")}`
      : "Code rewound: no file changes were needed";
  const message =
    issues.length > 0
      ? zh
        ? `${head} (${issues.join(", ")})`
        : `${head} (${issues.join(", ")})`
      : head;
  return {
    level: info.failed > 0 || info.conflicts > 0 || info.captureErrors > 0 ? "error" : "success",
    message,
  };
}

/** All state needed by the inline rewind button: null means the current turn has no checkpoint (button shown disabled). */
export type CheckpointRewindAction = {
  available: boolean;
  pending: boolean;
  disabled: boolean;
  onRewind?: () => void;
};

type CheckpointRewindContextValue = {
  turns: Map<string, CheckpointTurnSummary>;
  loading: boolean;
  disabled: boolean;
  busyTurn: number | null;
  rewind: (turn: CheckpointTurnSummary) => void;
};

const CheckpointRewindContext = createContext<CheckpointRewindContextValue | null>(null);

// Covers only changes from the three file tools Write/Edit/Delete; shell writes such as
// Bash are outside the checkpoint. Rewind point = user message: turnId is the user
// message ID, and the inline button matches this turn by messageId via
// useCheckpointRewindAction (matching Claude Code's per-message rewind).
export function CheckpointRewindProvider(props: {
  children: ReactNode;
  conversationId?: string;
  /** True while sending/streaming: all inline buttons are disabled and list refresh is paused. */
  disabled?: boolean;
  client: CheckpointRewindClient;
  /**
   * The sole source of rewind authorization: the current conversation's workspace root
   * plus additional authorized roots that are still active and writable. The backend
   * only recognizes roots in this set; an absolute path stored in a record is not itself
   * authorization. access must be filtered by the caller (rewind is a write operation,
   * so read-only roots must not be written).
   */
  resolveAuthorizedRoots: () => Promise<string[]>;
  onRewound?: (info: CheckpointRewoundInfo) => void;
}) {
  const {
    children,
    conversationId,
    disabled = false,
    client,
    resolveAuthorizedRoots,
    onRewound,
  } = props;
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const { confirm, dialog } = useConfirmDialog();
  const [turns, setTurns] = useState<CheckpointTurnSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyTurn, setBusyTurn] = useState<number | null>(null);

  // latest-ref: hosts usually pass these two callbacks inline (new identity every
  // render). If used as dependencies, rewind and the context value would be rebuilt
  // every host frame, amplified during streaming into re-rendering all user rows.
  const resolveRootsRef = useRef(resolveAuthorizedRoots);
  const onRewoundRef = useRef(onRewound);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    resolveRootsRef.current = resolveAuthorizedRoots;
    onRewoundRef.current = onRewound;
    disabledRef.current = disabled;
  });

  // List-load generation: slow responses (issued before a conversation switch) are always discarded, preventing out-of-order overwrite.
  const loadEpochRef = useRef(0);
  const loadTurns = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    if (!conversationId) {
      setTurns([]);
      return;
    }
    setLoading(true);
    try {
      const list = await client.list(conversationId);
      if (loadEpochRef.current === epoch) setTurns(list);
    } catch {
      if (loadEpochRef.current === epoch) setTurns([]);
    } finally {
      if (loadEpochRef.current === epoch) setLoading(false);
    }
  }, [client, conversationId]);

  // Switching conversations immediately clears the old list: branch copies preserve
  // message IDs, so a stale turn from the old conversation could be mismatched onto a
  // same-ID bubble in the new conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation identity intentionally clears stale rewind state
  useEffect(() => {
    loadEpochRef.current += 1;
    setTurns([]);
  }, [conversationId]);

  // Refresh when idle (mount/conversation switch/turn end); do not fetch while sending — a half-formed timeline has no display value.
  useEffect(() => {
    if (!disabled) void loadTurns();
  }, [disabled, loadTurns]);

  // The busy guard goes through a ref: rewind does not depend on busyTurn state, so its identity stays stable.
  const busyTurnRef = useRef<number | null>(null);
  const rewind = useCallback(
    async (turn: CheckpointTurnSummary) => {
      if (!conversationId || disabledRef.current || busyTurnRef.current !== null) return;
      busyTurnRef.current = turn.turnSeq;
      setBusyTurn(turn.turnSeq);
      try {
        const authorizedRoots = await resolveRootsRef.current();
        const stats = await client.preview({
          conversationId,
          turnSeq: turn.turnSeq,
          authorizedRoots,
        });
        const parts: string[] = [];
        if (stats.restoreFiles > 0)
          parts.push(
            zh ? `Restore ${stats.restoreFiles} file(s)` : `Restore ${stats.restoreFiles} file(s)`,
          );
        if (stats.deleteFiles > 0)
          parts.push(
            zh ? `Delete ${stats.deleteFiles} file(s)` : `Delete ${stats.deleteFiles} file(s)`,
          );
        if (stats.cleanFiles > 0)
          parts.push(
            zh ? `${stats.cleanFiles} file(s) unchanged` : `${stats.cleanFiles} file(s) unchanged`,
          );
        if (stats.skippedDirs > 0)
          parts.push(
            zh
              ? `${stats.skippedDirs} deleted director(ies) cannot be restored`
              : `${stats.skippedDirs} deleted director(ies) cannot be restored`,
          );
        if (stats.missingBlobs > 0)
          parts.push(
            zh
              ? `${stats.missingBlobs} file(s) missing their pre-edit snapshot`
              : `${stats.missingBlobs} file(s) missing their pre-edit snapshot`,
          );
        if (stats.unresolvableFiles > 0)
          parts.push(
            zh
              ? `${stats.unresolvableFiles} path(s) cannot be rewound (directory unauthorized, or path contains a symlink)`
              : `${stats.unresolvableFiles} path(s) cannot be rewound (directory unauthorized, or path contains a symlink)`,
          );
        if (stats.captureErrors > 0 || turn.incomplete)
          parts.push(
            zh
              ? `${Math.max(stats.captureErrors, 1)} snapshot(s) failed to record this turn; the rewind may be incomplete`
              : `${Math.max(stats.captureErrors, 1)} snapshot(s) failed to record this turn; the rewind may be incomplete`,
          );
        const actionable = stats.entries.filter(
          (entry) => entry.action === "restore" || entry.action === "delete",
        );
        // Checkpoints record only the pre-images of agent tool writes; manual edits in
        // the editor/file tree are neither recorded nor distinguishable from tool
        // writes. A rewind overwrites wholesale from the pre-images, so manual edits are
        // wiped along with them — state this up front.
        if (actionable.length > 0)
          parts.push(
            zh
              ? "Manual edits made in the editor or file tree are not checkpointed and will be overwritten"
              : "Manual edits made in the editor or file tree are not checkpointed and will be overwritten",
          );
        const confirmed = await confirm({
          title: zh ? "Rewind to before this turn" : "Rewind to before this turn",
          subtitle: new Date(turn.firstCapturedAt).toLocaleString(),
          description:
            parts.length > 0
              ? parts.join(zh ? ", " : ", ")
              : zh
                ? "No file changes to rewind in this turn"
                : "No file changes to rewind in this turn",
          detail:
            actionable.length > 0 ? actionable.map((entry) => entry.path).join("\n") : undefined,
          confirmLabel: zh ? "Rewind" : "Rewind",
          cancelLabel: zh ? "Cancel" : "Cancel",
        });
        if (!confirmed) return;
        // Pass the current-state hashes from the preview back to the backend and
        // re-verify each one before rewinding: a file modified externally between
        // preview and execution is skipped and reported as a conflict, never overwritten
        // (TOCTOU protection). All resolvable entries (including clean) must be sent
        // back — the backend judges any entry missing a hash as a conflict, and sending
        // only restore/delete would let a clean file hand-edited during confirmation be
        // silently overwritten.
        const expected = stats.entries.flatMap((entry) =>
          entry.currentHash == null ? [] : [{ key: entry.key, currentHash: entry.currentHash }],
        );
        const result = await client.rewind({
          conversationId,
          turnSeq: turn.turnSeq,
          authorizedRoots,
          expected,
        });
        onRewoundRef.current?.({
          turnSeq: turn.turnSeq,
          restoredFiles: result.restoredFiles,
          deletedFiles: result.deletedFiles,
          conflicts: result.conflicts.length,
          failed: result.failed.length,
          captureErrors: result.captureErrors,
        });
        // A full rewind trims turnSeq and later turns in the backend; re-fetch so the button state catches up.
        await loadTurns();
        if (
          result.failed.length > 0 ||
          result.conflicts.length > 0 ||
          result.captureErrors > 0 ||
          result.skippedDirs > 0
        ) {
          const issueLines = [
            ...result.conflicts.map((path) =>
              zh ? `conflict (skipped): ${path}` : `conflict (skipped): ${path}`,
            ),
            ...result.failed.map((path) => (zh ? `failed: ${path}` : `failed: ${path}`)),
          ];
          // Capture gaps/unrestorable directories have no specific path list, so explain them on a separate line.
          if (result.captureErrors > 0)
            issueLines.push(
              zh
                ? `${result.captureErrors} file(s) had no pre-image (capture failed) and were not rewound`
                : `${result.captureErrors} file(s) had no pre-image (capture failed) and were not rewound`,
            );
          if (result.skippedDirs > 0)
            issueLines.push(
              zh
                ? `${result.skippedDirs} deleted dir(s) could not be restored`
                : `${result.skippedDirs} deleted dir(s) could not be restored`,
            );
          await confirm({
            title: zh ? "Rewind partially completed" : "Rewind partially completed",
            description: zh
              ? `Restored ${result.restoredFiles}, deleted ${result.deletedFiles}; ${result.conflicts.length} conflict(s) skipped, ${result.failed.length} failed`
              : `Restored ${result.restoredFiles}, deleted ${result.deletedFiles}; ${result.conflicts.length} conflict(s) skipped, ${result.failed.length} failed`,
            detail: issueLines.join("\n"),
            confirmLabel: zh ? "OK" : "OK",
            cancelLabel: "",
            hideCancel: true,
          });
        }
      } catch (error) {
        await confirm({
          title: zh ? "Rewind failed" : "Rewind failed",
          description: String(error),
          confirmLabel: zh ? "OK" : "OK",
          cancelLabel: "",
          hideCancel: true,
        });
      } finally {
        busyTurnRef.current = null;
        setBusyTurn(null);
      }
    },
    [client, confirm, conversationId, loadTurns, zh],
  );

  const value = useMemo<CheckpointRewindContextValue>(
    () => ({
      turns: new Map(turns.map((turn) => [turn.turnId, turn])),
      loading,
      disabled,
      busyTurn,
      rewind: (turn) => void rewind(turn),
    }),
    [busyTurn, disabled, loading, rewind, turns],
  );

  return (
    <CheckpointRewindContext.Provider value={value}>
      {children}
      {dialog}
    </CheckpointRewindContext.Provider>
  );
}

/**
 * Get this row's rewind action by user message ID. Returns null outside the Provider
 * (the button is shown disabled, so scenarios that do not render the action area, such
 * as read-only pages, are unaffected).
 */
export function useCheckpointRewindAction(turnId?: string): CheckpointRewindAction | null {
  const context = useContext(CheckpointRewindContext);
  if (!context) return null;
  const turn = turnId ? context.turns.get(turnId) : undefined;
  return {
    available: !!turn,
    pending: !!turn && context.busyTurn === turn.turnSeq,
    disabled: context.disabled || context.loading || context.busyTurn !== null || !turn,
    onRewind: turn ? () => context.rewind(turn) : undefined,
  };
}
