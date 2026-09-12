export type DroppedDirectoryFile = {
  /** Path relative to the directory (excluding the top-level folder name), separated by forward slashes. */
  relativePath: string;
  file: File;
};

export type DroppedDirectory = {
  name: string;
  files: DroppedDirectoryFile[];
};

export type CollectedDropPayload = {
  files: File[];
  directories: DroppedDirectory[];
};

/** Aligned with the desktop gateway's limit of 2000; exceeding it fails outright rather than silently truncating. */
export const MAX_DIRECTORY_UPLOAD_FILES = 2000;
export const MAX_DIRECTORY_UPLOAD_BYTES = 200 * 1024 * 1024;

/** When an entire project is dropped in, these directories are both large and worthless to import, so they are pruned during collection. */
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules", "__pycache__"]);

const EXCLUDED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

export function isExcludedDirectoryName(name: string) {
  return EXCLUDED_DIRECTORY_NAMES.has(name);
}

export function isExcludedFileName(name: string) {
  return EXCLUDED_FILE_NAMES.has(name);
}

/**
 * DataTransferItem is only valid during the synchronous phase of the drop event,
 * so all entries must be taken synchronously before any asynchronous traversal.
 */
export function snapshotDroppedEntries(dataTransfer: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  return entries;
}

export function hasDirectoryEntry(entries: readonly FileSystemEntry[]) {
  return entries.some((entry) => entry.isDirectory);
}

/**
 * Reconstruct directories selected through an `<input webkitdirectory>`.
 * `webkitRelativePath` includes the selected top-level folder, while the
 * directory import API expects file paths relative to that folder.
 */
export function collectSelectedDirectoryFiles(files: readonly File[]): DroppedDirectory[] {
  const directories = new Map<string, { files: DroppedDirectoryFile[]; totalBytes: number }>();

  for (const file of files) {
    const segments = file.webkitRelativePath
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length < 2) continue;

    const [name, ...relativeSegments] = segments;
    const fileName = relativeSegments.at(-1);
    const parentDirectories = relativeSegments.slice(0, -1);
    if (
      !name ||
      !fileName ||
      isExcludedFileName(fileName) ||
      parentDirectories.some(isExcludedDirectoryName)
    ) {
      continue;
    }

    const directory = directories.get(name) ?? { files: [], totalBytes: 0 };
    if (directory.files.length >= MAX_DIRECTORY_UPLOAD_FILES) {
      throw new Error(`TOO_MANY_FILES:${MAX_DIRECTORY_UPLOAD_FILES}`);
    }
    directory.totalBytes += file.size;
    if (directory.totalBytes > MAX_DIRECTORY_UPLOAD_BYTES) {
      throw new Error(`TOO_LARGE:${MAX_DIRECTORY_UPLOAD_BYTES}`);
    }
    directory.files.push({ relativePath: relativeSegments.join("/"), file });
    directories.set(name, directory);
  }

  return Array.from(directories, ([name, directory]) => ({ name, files: directory.files }));
}

function readAllDirectoryEntries(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  return new Promise((resolve, reject) => {
    const collected: FileSystemEntry[] = [];
    const readBatch = () => {
      // readEntries returns at most 100 entries per call, so it must be looped until an empty batch.
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(collected);
          return;
        }
        collected.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function collectDirectoryFiles(
  directory: FileSystemDirectoryEntry,
  prefix: string,
  sink: DroppedDirectoryFile[],
  totalBytes: { value: number },
) {
  const children = await readAllDirectoryEntries(directory);
  for (const child of children) {
    if (child.isDirectory) {
      if (isExcludedDirectoryName(child.name)) continue;
      await collectDirectoryFiles(
        child as FileSystemDirectoryEntry,
        `${prefix}${child.name}/`,
        sink,
        totalBytes,
      );
      continue;
    }
    if (!child.isFile || isExcludedFileName(child.name)) continue;
    if (sink.length >= MAX_DIRECTORY_UPLOAD_FILES) {
      throw new Error(`TOO_MANY_FILES:${MAX_DIRECTORY_UPLOAD_FILES}`);
    }
    const file = await entryFile(child as FileSystemFileEntry);
    totalBytes.value += file.size;
    if (totalBytes.value > MAX_DIRECTORY_UPLOAD_BYTES) {
      throw new Error(`TOO_LARGE:${MAX_DIRECTORY_UPLOAD_BYTES}`);
    }
    sink.push({
      relativePath: `${prefix}${child.name}`,
      file,
    });
  }
}

/**
 * Expands a drop snapshot into top-level files and a folder tree. Throws a
 * `TOO_MANY_FILES:<max>` error when a folder contains more than
 * MAX_DIRECTORY_UPLOAD_FILES files.
 */
export async function collectDroppedPayload(
  entries: readonly FileSystemEntry[],
): Promise<CollectedDropPayload> {
  const files: File[] = [];
  const directories: DroppedDirectory[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      const collected: DroppedDirectoryFile[] = [];
      await collectDirectoryFiles(entry as FileSystemDirectoryEntry, "", collected, { value: 0 });
      directories.push({ name: entry.name, files: collected });
      continue;
    }
    if (entry.isFile && !isExcludedFileName(entry.name)) {
      files.push(await entryFile(entry as FileSystemFileEntry));
    }
  }
  return { files, directories };
}
