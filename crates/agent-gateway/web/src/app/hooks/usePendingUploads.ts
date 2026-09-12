import type { ApplicationViewId } from "@liveagent/ui/application/ApplicationView";
import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import type { NotifyItem } from "@liveagent/ui/components/chat/NotifyToast";
import { t as translate } from "@liveagent/ui/i18n/index";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { mergePendingUploadedFilesWithStats } from "@liveagent/ui/lib/chat/uploadedFiles";
import { registerLocalUploadedImagePreviews } from "@liveagent/ui/lib/chat/uploadedImagePreview";
import { type DragEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  clipboardHasFileSignal,
  extractClipboardFiles,
  readClipboardFiles,
} from "@/lib/clipboardFiles";
import {
  collectDroppedPayload,
  collectSelectedDirectoryFiles,
  type DroppedDirectory,
  hasDirectoryEntry,
  MAX_DIRECTORY_UPLOAD_BYTES,
  MAX_DIRECTORY_UPLOAD_FILES,
  snapshotDroppedEntries,
} from "@/lib/directoryDrop";
import type { AppSettings } from "@/lib/settings";
import { importReadableFiles } from "@/lib/uploadReadableFiles";

import { asErrorMessage } from "../chatEventUtils";
import { MAX_UPLOAD_FILES } from "../constants";
import { dragEventHasFiles } from "../domUtils";
import { formatTranslation } from "../historyUtils";
import {
  resolveFileUploadConversationId,
  resolveFileUploadDropZone,
} from "./fileUploadDropRouting";
import { createPendingUploadsRegistry } from "./pendingUploadsRegistry";

type UsePendingUploadsParams = {
  token: string;
  resolveAgentID: () => Promise<string>;
  historyShareToken: string | null;
  settingsSyncReady: boolean;
  settingsOpen: boolean;
  activeView: ApplicationViewId;
  locale: AppSettings["locale"];
  executionMode: AppSettings["system"]["executionMode"];
  conversationId: string;
  selectedHistoryId: string;
  displayedConversationWorkdirRef: RefObject<string>;
  composerRef: RefObject<MentionComposerHandle | null>;
  // Upload feedback goes to the top-right toast stack, never into the
  // transcript area — a failed upload is not conversation output.
  addNotify: (type: NotifyItem["type"], message: string) => void;
  /** Callback that takes over when a folder is dragged into the transcript area (mounted as an attached directory); folders are ignored when not provided. */
  onDropDirectories?: (directories: DroppedDirectory[]) => void;
  /**
   * No-conversation fallback: when upload starts just after the page opens and no
   * conversation id exists yet, the host creates a local draft conversation and
   * returns its id (equivalent to clicking "New chat" once); attachments hang off
   * that draft and, after the first message is sent, migrate to the real
   * conversation through the existing moveConversationUploads.
   */
  ensureUploadConversation?: () => string;
  /** Resolve the workspace owned by an explicitly targeted workbench Pane. */
  workdirForConversation: (conversationId: string) => string;
};

export function usePendingUploads(params: UsePendingUploadsParams) {
  const {
    token,
    resolveAgentID,
    historyShareToken,
    settingsSyncReady,
    settingsOpen,
    activeView,
    locale,
    executionMode,
    conversationId,
    selectedHistoryId,
    displayedConversationWorkdirRef,
    composerRef,
    addNotify,
    onDropDirectories,
    ensureUploadConversation,
    workdirForConversation,
  } = params;

  const [pendingUploadedFiles, setPendingUploadedFiles] = useState<PendingUploadedFile[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  // Conversation id that owns the in-flight import: in a multi-pane layout, the
  // "uploading" disable/animation should only apply to the target conversation's
  // pane; other panes must not be wrongly disabled or shown an upload state by a
  // global mutex.
  const [uploadingConversationId, setUploadingConversationId] = useState<string | null>(null);
  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadedFilesRef = useRef(pendingUploadedFiles);
  const pendingUploadsRegistryRef = useRef(createPendingUploadsRegistry());
  const isUploadingFilesRef = useRef(isUploadingFiles);
  const uploadDragDepthRef = useRef(0);
  const displayedConversationIdRef = useRef("");
  // Render-assigned mirror: an in-flight import settling between a render and
  // its effects must still see the latest mode when it decides whether its
  // result is stale.
  const executionModeRef = useRef(executionMode);
  executionModeRef.current = executionMode;

  const displayedConversationId = (selectedHistoryId || conversationId).trim();
  displayedConversationIdRef.current = displayedConversationId;

  const setUploadingFiles = useCallback((active: boolean, targetConversationId = "") => {
    isUploadingFilesRef.current = active;
    setIsUploadingFiles(active);
    setUploadingConversationId(active ? targetConversationId.trim() || null : null);
  }, []);

  const handleImportSelectedDirectoryFiles = useCallback(
    (files: File[]) => {
      try {
        const directories = collectSelectedDirectoryFiles(files);
        if (directories.length > 0) {
          onDropDirectories?.(directories);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.startsWith("TOO_MANY_FILES:")) {
          addNotify(
            "error",
            formatTranslation(translate("chat.workspaceDropTooManyFiles", locale), {
              max: MAX_DIRECTORY_UPLOAD_FILES,
            }),
          );
          return;
        }
        if (message.startsWith("TOO_LARGE:")) {
          addNotify(
            "error",
            formatTranslation(translate("chat.workspaceDropTooLarge", locale), {
              max: Math.floor(MAX_DIRECTORY_UPLOAD_BYTES / 1024 / 1024),
            }),
          );
          return;
        }
        addNotify("error", asErrorMessage(error, translate("chat.workspaceDropFailed", locale)));
      }
    },
    [addNotify, locale, onDropDirectories],
  );

  const isDisplayedConversation = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    return conversationIdValue !== "" && displayedConversationIdRef.current === conversationIdValue;
  }, []);

  const subscribePendingUploads = useCallback((listener: () => void) => {
    return pendingUploadsRegistryRef.current.subscribe(listener);
  }, []);

  const getPendingUploadsForConversation = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue) return pendingUploadedFilesRef.current;
    return pendingUploadsRegistryRef.current.get(conversationIdValue);
  }, []);

  const setPendingUploadsForConversation = useCallback(
    (targetConversationId: string, nextFiles: PendingUploadedFile[]) => {
      const conversationIdValue = targetConversationId.trim();
      const normalizedFiles = nextFiles.slice();
      if (conversationIdValue) {
        pendingUploadsRegistryRef.current.set(conversationIdValue, normalizedFiles);
      }
      if (!conversationIdValue || isDisplayedConversation(conversationIdValue)) {
        pendingUploadedFilesRef.current = normalizedFiles;
        setPendingUploadedFiles(normalizedFiles);
      }
    },
    [isDisplayedConversation],
  );

  const updatePendingUploadsForConversation = useCallback(
    (
      targetConversationId: string,
      updater: (current: PendingUploadedFile[]) => PendingUploadedFile[],
    ) => {
      const conversationIdValue = targetConversationId.trim();
      const currentFiles = getPendingUploadsForConversation(conversationIdValue);
      const nextFiles = updater(currentFiles);
      setPendingUploadsForConversation(conversationIdValue, nextFiles);
      return nextFiles;
    },
    [getPendingUploadsForConversation, setPendingUploadsForConversation],
  );

  // A draft conversation got its real id: re-key its stored uploads without
  // touching the rendered state — the displayed id flips to `nextId` in the
  // same commit, so the switch effect below re-reads the moved entry.
  const moveConversationUploads = useCallback((previousId: string, nextId: string) => {
    const previous = previousId.trim();
    const next = nextId.trim();
    if (!previous || !next || previous === next) {
      return;
    }
    pendingUploadsRegistryRef.current.move(previous, next);
  }, []);

  const clearPendingUploads = useCallback(() => {
    pendingUploadedFilesRef.current = [];
    pendingUploadsRegistryRef.current.clear();
    isUploadingFilesRef.current = false;
    uploadDragDepthRef.current = 0;
    setPendingUploadedFiles([]);
    setIsUploadingFiles(false);
    setUploadingConversationId(null);
    setIsFileDropActive(false);
  }, []);

  useEffect(() => {
    const nextFiles = displayedConversationId
      ? pendingUploadsRegistryRef.current.get(displayedConversationId)
      : [];
    pendingUploadedFilesRef.current = nextFiles;
    setPendingUploadedFiles(nextFiles);
  }, [displayedConversationId]);

  const handleImportReadableFiles = useCallback(
    async (
      filesToImport: File[],
      // A multi-pane background Pane explicitly specifies its target conversation and
      // its workspace; by default the import still goes to the currently displayed conversation.
      target?: { conversationId: string; workdir: string },
    ) => {
      if (filesToImport.length === 0) {
        return;
      }
      if (isUploadingFilesRef.current) {
        addNotify("warning", translate("chat.upload.uploading", locale));
        return;
      }
      if (executionMode === "text") {
        addNotify("warning", translate("chat.upload.onlyInTools", locale));
        return;
      }
      // An empty workdir on an explicit target is the guard result from
      // resolveConversationUploadWorkdir (a background conversation has no workspace of
      // its own); never fall back to the focused conversation's workspace --
      // otherwise the files would be uploaded into someone else's workspace while
      // being attached to the target conversation.
      const workdir = target
        ? target.workdir.trim()
        : displayedConversationWorkdirRef.current.trim();
      if (!workdir) {
        addNotify("warning", translate("chat.upload.requireWorkdir", locale));
        return;
      }
      let targetConversationId =
        target?.conversationId.trim() || displayedConversationIdRef.current;
      if (!targetConversationId && ensureUploadConversation) {
        targetConversationId = ensureUploadConversation().trim();
        if (targetConversationId) {
          // Before the re-render the displayed id is still the old value; manually
          // sync the ref so this import and its isDisplayedConversation check point
          // at the new draft immediately.
          displayedConversationIdRef.current = targetConversationId;
        }
      }
      if (!targetConversationId) {
        addNotify("warning", "Please select or create a conversation before uploading files.");
        return;
      }

      const currentUploads = getPendingUploadsForConversation(targetConversationId);
      setPendingUploadsForConversation(targetConversationId, currentUploads);
      const importBatch = filesToImport.slice(0, MAX_UPLOAD_FILES);
      const ignoredForLimit = filesToImport.length - importBatch.length;
      setUploadingFiles(true, targetConversationId);
      try {
        const agentID = await resolveAgentID();
        const result = await importReadableFiles(token, agentID, workdir, importBatch);
        // An import that settles after its upload context was invalidated
        // must not resurrect cleared attachments: files picked inside the
        // old workspace are not readable from the new one.
        if (
          (await resolveAgentID()) !== agentID ||
          executionModeRef.current === "text" ||
          (isDisplayedConversation(targetConversationId) &&
            displayedConversationWorkdirRef.current.trim() !== workdir)
        ) {
          addNotify(
            "warning",
            "The upload target is no longer valid; the files from this import were ignored",
          );
          return;
        }
        registerLocalUploadedImagePreviews({
          workspaceRoot: workdir,
          uploadedFiles: result.files,
          sourceFiles: importBatch,
        });

        if (result.files.length > 0) {
          let duplicateCount = 0;
          let overflowCount = 0;
          updatePendingUploadsForConversation(targetConversationId, (current) => {
            const merged = mergePendingUploadedFilesWithStats(current, result.files);
            duplicateCount = merged.duplicateCount;
            overflowCount = Math.max(0, merged.files.length - MAX_UPLOAD_FILES);
            return merged.files.slice(0, MAX_UPLOAD_FILES);
          });
          if (duplicateCount > 0) {
            addNotify(
              "warning",
              formatTranslation(translate("chat.upload.duplicatesMerged", locale), {
                count: duplicateCount,
              }),
            );
          }
          if (overflowCount > 0) {
            addNotify(
              "warning",
              formatTranslation(translate("chat.upload.maxFilesIgnored", locale), {
                max: MAX_UPLOAD_FILES,
                count: overflowCount,
              }),
            );
          }
          if (isDisplayedConversation(targetConversationId)) {
            composerRef.current?.focus();
          }
        }

        if (result.files.length === 0 && result.skipped.length > 0) {
          addNotify(
            "error",
            `None of the selected files could be imported:\n${result.skipped.join("\n")}`,
          );
        } else if (result.skipped.length > 0) {
          addNotify("warning", `The following files were skipped:\n${result.skipped.join("\n")}`);
        }
        if (ignoredForLimit > 0) {
          addNotify(
            "warning",
            formatTranslation(translate("chat.upload.maxFilesIgnored", locale), {
              max: MAX_UPLOAD_FILES,
              count: ignoredForLimit,
            }),
          );
        }
      } catch (error) {
        addNotify("error", asErrorMessage(error, "Failed to import files"));
      } finally {
        setUploadingFiles(false);
      }
    },
    [
      addNotify,
      composerRef,
      displayedConversationWorkdirRef,
      ensureUploadConversation,
      executionMode,
      getPendingUploadsForConversation,
      isDisplayedConversation,
      locale,
      resolveAgentID,
      setPendingUploadsForConversation,
      setUploadingFiles,
      token,
      updatePendingUploadsForConversation,
    ],
  );

  const resolveEventUploadTarget = useCallback(
    (eventTarget: EventTarget | null) => {
      const targetConversationId = resolveFileUploadConversationId(eventTarget);
      if (!targetConversationId) return undefined;
      return {
        conversationId: targetConversationId,
        workdir: workdirForConversation(targetConversationId),
      };
    },
    [workdirForConversation],
  );

  useEffect(() => {
    if (
      !token ||
      historyShareToken ||
      !settingsSyncReady ||
      settingsOpen ||
      activeView !== "chat"
    ) {
      return;
    }

    const handleDocumentPaste = (event: globalThis.ClipboardEvent) => {
      if (event.defaultPrevented) return;
      // Capture ownership synchronously. Clipboard fallback is asynchronous,
      // and focus may move to another Pane before it resolves.
      const uploadTarget = resolveEventUploadTarget(event.target);
      const clipboardFiles = extractClipboardFiles(event.clipboardData);
      if (clipboardFiles.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        void handleImportReadableFiles(clipboardFiles, uploadTarget);
        return;
      }
      if (!clipboardHasFileSignal(event.clipboardData)) return;

      event.preventDefault();
      event.stopPropagation();
      void readClipboardFiles()
        .then((files) => {
          if (files.length === 0) {
            addNotify(
              "warning",
              "Could not read files from the clipboard; try dragging them in or clicking to upload.",
            );
            return;
          }
          return handleImportReadableFiles(files, uploadTarget);
        })
        .catch((error) => {
          addNotify("error", asErrorMessage(error, "Failed to read clipboard files"));
        });
    };

    document.addEventListener("paste", handleDocumentPaste, true);
    return () => {
      document.removeEventListener("paste", handleDocumentPaste, true);
    };
  }, [
    activeView,
    addNotify,
    handleImportReadableFiles,
    historyShareToken,
    resolveEventUploadTarget,
    settingsOpen,
    settingsSyncReady,
    token,
  ]);

  // The upload hit zone matches the desktop side: only drops landing inside the
  // marked composer dialog count as uploads; other areas such as the conversation
  // transcript and chat header are ignored.
  const dropLandsInUploadZone = useCallback((event: DragEvent<HTMLDivElement>) => {
    return resolveFileUploadDropZone(event.target) !== null;
  }, []);

  const handleFileDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    uploadDragDepthRef.current += 1;
  }, []);

  const handleFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>, canDropUpload: boolean) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const overZone = dropLandsInUploadZone(event);
      event.dataTransfer.dropEffect = overZone && canDropUpload ? "copy" : "none";
      setIsFileDropActive(overZone);
    },
    [dropLandsInUploadZone],
  );

  const handleFileDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    uploadDragDepthRef.current = Math.max(0, uploadDragDepthRef.current - 1);
    if (uploadDragDepthRef.current === 0) {
      setIsFileDropActive(false);
    }
  }, []);

  const handleFileDrop = useCallback(
    (
      event: DragEvent<HTMLDivElement>,
      options: {
        canDropUpload: boolean;
        disabledMessage: string;
      },
    ) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      uploadDragDepthRef.current = 0;
      setIsFileDropActive(false);
      if (!dropLandsInUploadZone(event)) return;

      // DataTransferItem and the landing Pane are both event-scoped. Snapshot
      // them before directory traversal or any other asynchronous operation.
      const uploadTarget = resolveEventUploadTarget(event.target);

      // DataTransferItem is only valid during the synchronous phase; directory detection must precede any await.
      const entries = snapshotDroppedEntries(event.dataTransfer);
      if (hasDirectoryEntry(entries)) {
        void collectDroppedPayload(entries)
          .then((payload) => {
            if (payload.directories.length > 0) {
              onDropDirectories?.(payload.directories);
            }
            if (payload.files.length === 0) return;
            if (!options.canDropUpload) {
              addNotify("warning", options.disabledMessage);
              return;
            }
            return handleImportReadableFiles(payload.files, uploadTarget);
          })
          .catch((error) => {
            addNotify(
              "error",
              asErrorMessage(error, translate("chat.workspaceDropFailed", locale)),
            );
          });
        return;
      }

      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length === 0) return;
      if (!options.canDropUpload) {
        addNotify("warning", options.disabledMessage);
        return;
      }
      void handleImportReadableFiles(files, uploadTarget);
    },
    [
      addNotify,
      dropLandsInUploadZone,
      handleImportReadableFiles,
      locale,
      onDropDirectories,
      resolveEventUploadTarget,
    ],
  );

  return {
    pendingUploadedFiles,
    isUploadingFiles,
    uploadingConversationId,
    isFileDropActive,
    fileInputRef,
    folderInputRef,
    setUploadingFiles,
    getPendingUploadsForConversation,
    subscribePendingUploads,
    setPendingUploadsForConversation,
    updatePendingUploadsForConversation,
    moveConversationUploads,
    clearPendingUploads,
    handleImportReadableFiles,
    handleImportSelectedDirectoryFiles,
    handleFileDragEnter,
    handleFileDragOver,
    handleFileDragLeave,
    handleFileDrop,
  };
}
