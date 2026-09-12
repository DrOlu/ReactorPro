import { invoke } from "@tauri-apps/api/core";

/**
 * IPC wrapper for configuration backup.
 *
 * The five snapshot domains (providers / mcp / system portable preferences /
 * agents / modelFailover) are all stored in SQLite, and both collection and
 * application are done in the backend; dirty marking for auto-sync is also
 * triggered in the backend by each domain's `save_*`, with no frontend involvement.
 */

/** Entry counts per domain, used only to show a summary in the confirmation dialog. */
export type BackupDomainCounts = {
  providers: number;
  mcp: number;
  system: number;
  agents: number;
  modelFailover: number;
};

export type BackupManifest = {
  protocolVersion: number;
  schemaVersion: number;
  snapshotId: string;
  /** RFC3339 UTC. */
  createdAt: string;
  deviceName: string;
  appVersion: string;
  /** Always "none" in the first version, reserved for future end-to-end encryption. */
  encryption: string;
  domains: BackupDomainCounts;
};

export type BackupImportPreview = {
  path: string;
  manifest: BackupManifest;
};

export type BackupApplyOutcome = {
  applied: BackupDomainCounts;
  /** Path of the local backup file generated before applying. */
  backupPath: string | null;
};

/**
 * Export the configuration to a user-chosen file. Returns the written path; returns
 * null if the user cancels.
 *
 * Backend error messages are already display-ready text, so we do not wrap another
 * error type around them.
 */
export async function exportBackup(): Promise<string | null> {
  return await invoke<string | null>("settings_backup_export");
}

/** Choose and parse a backup file, validating only without writing to the database. Returns null if the user cancels. */
export async function peekBackupImport(): Promise<BackupImportPreview | null> {
  return await invoke<BackupImportPreview | null>("settings_backup_peek_import", { path: null });
}

/** Apply the backup. The backend automatically backs up the current config before writing. */
export async function applyBackupImport(path: string): Promise<BackupApplyOutcome> {
  return await invoke<BackupApplyOutcome>("settings_backup_apply_import", { path });
}

// ===== WebDAV sync =====

/** Sync config view returned by the backend: **does not include the password**, only whether one is set. */
export type BackupSyncConfigView = {
  url: string;
  username: string;
  hasPassword: boolean;
  remoteDir: string;
  profile: string;
  autoSync: boolean;
  /** Millisecond timestamp. */
  lastSyncAt: number | null;
  /**
   * Reason the most recent **automatic** sync failed, persisted to the database.
   *
   * Manual sync errors are not written here — that kind of failure is reported to the
   * user on the spot. Automatic sync happens in the background, when the user is
   * usually not on the settings page, so it must be persisted; otherwise the error
   * disappears as soon as the page unmounts, while the config has long stopped syncing
   * and the user has no idea.
   */
  lastError: string | null;
};

/**
 * Save request.
 *
 * When `passwordTouched` is false the backend keeps the old password from the database
 * — the UI fills the password box with a masked placeholder, and submitting it as-is
 * would write the placeholder as the real password.
 */
export type BackupSyncConfigRequest = {
  url: string;
  username: string;
  password: string;
  passwordTouched: boolean;
  remoteDir: string;
  profile: string;
  autoSync: boolean;
};

export type BackupRemoteInfo = {
  manifest: BackupManifest;
  size: number;
  sha256: string;
};

export async function loadSyncConfig(): Promise<BackupSyncConfigView> {
  return await invoke<BackupSyncConfigView>("settings_backup_load_sync_config");
}

export async function saveSyncConfig(
  config: BackupSyncConfigRequest,
): Promise<BackupSyncConfigView> {
  return await invoke<BackupSyncConfigView>("settings_backup_save_sync_config", { config });
}

/** Test the connection. It uses the config saved in the database, so save first, then test. */
export async function testSyncConnection(): Promise<void> {
  await invoke("settings_backup_test_sync_connection");
}

/** Fetch the remote summary. Returns null when the remote has no backup yet. */
export async function fetchRemoteInfo(): Promise<BackupRemoteInfo | null> {
  return await invoke<BackupRemoteInfo | null>("settings_backup_fetch_remote_info");
}

/** Upload the current config. Returns the millisecond timestamp of this sync. */
export async function uploadBackup(): Promise<number> {
  return await invoke<number>("settings_backup_upload");
}

/** Download and apply the remote config. */
export async function downloadBackup(): Promise<BackupApplyOutcome> {
  return await invoke<BackupApplyOutcome>("settings_backup_download");
}

/** Payload of the background auto-sync result event. Manual sync success/failure is reported directly by the command return value and does not use this event. */
export type BackupSyncStatusEvent = {
  lastSyncAt: number | null;
  lastError: string | null;
};

export const BACKUP_SYNC_STATUS_EVENT = "backup-sync-status-updated";
