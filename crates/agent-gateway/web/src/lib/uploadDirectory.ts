import { type DroppedDirectoryFile, MAX_DIRECTORY_UPLOAD_BYTES } from "./directoryDrop";
import { readFetchError } from "./uploadReadableFiles";

export type ImportDirectoryTarget = "workspace" | "project-root";

export type ImportDirectoryResult = {
  /** Absolute path of the directory created on the Agent host. */
  rootPath: string;
  fileCount: number;
  skipped: string[];
};

/**
 * Uploads the folder contents gathered by the browser to the Agent host (forwarded
 * and written to disk via the gateway's /api/files/import-directory). The server
 * trims the multipart filename down to its last segment; relative paths are passed
 * through the paths field, which stays aligned with files by order.
 */
export async function importDirectory(
  token: string,
  agentId: string,
  params: {
    name: string;
    target: ImportDirectoryTarget;
    files: readonly DroppedDirectoryFile[];
  },
): Promise<ImportDirectoryResult> {
  const normalizedToken = token.trim();
  const normalizedAgentId = agentId.trim();
  const normalizedName = params.name.trim();
  if (!normalizedToken) {
    throw new Error("Gateway token is required");
  }
  if (!normalizedAgentId) {
    throw new Error("agent_id is required");
  }
  if (!normalizedName) {
    throw new Error("Folder name cannot be empty.");
  }
  if (params.files.length === 0) {
    throw new Error("The folder is empty and cannot be imported.");
  }
  const totalBytes = params.files.reduce((sum, entry) => sum + entry.file.size, 0);
  if (totalBytes > MAX_DIRECTORY_UPLOAD_BYTES) {
    throw new Error(`TOO_LARGE:${MAX_DIRECTORY_UPLOAD_BYTES}`);
  }

  const formData = new FormData();
  formData.set("name", normalizedName);
  formData.set("target", params.target);
  for (const entry of params.files) {
    formData.append("files", entry.file, entry.file.name);
    formData.append("paths", entry.relativePath);
  }

  const url = new URL(`${window.location.origin}/api/files/import-directory`);
  url.searchParams.set("agent_id", normalizedAgentId);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await readFetchError(response, "Failed to import folder"));
  }

  const payload = (await response.json()) as {
    rootPath?: unknown;
    fileCount?: unknown;
    skipped?: unknown[];
  };
  const rootPath = typeof payload.rootPath === "string" ? payload.rootPath.trim() : "";
  if (!rootPath) {
    throw new Error("Failed to import folder: the server did not return a directory path");
  }

  return {
    rootPath,
    fileCount: typeof payload.fileCount === "number" ? payload.fileCount : 0,
    skipped: Array.isArray(payload.skipped)
      ? payload.skipped.filter((item): item is string => typeof item === "string")
      : [],
  };
}
