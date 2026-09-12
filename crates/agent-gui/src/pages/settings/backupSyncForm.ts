// Pure logic for WebDAV sync settings: form state derivation and sync status event reduction.
//
// It is kept separate from `BackupSyncSection.tsx` so these decisions can be tested directly
// without React - they determine "whether the button is clickable" and "whether the error banner
// stays up", which are exactly the places users only notice when something goes wrong.

import type { BackupSyncConfigView, BackupSyncStatusEvent } from "../../lib/backup";

/** Form state. The password is tracked separately via `passwordTouched` to avoid submitting the placeholder as a real password. */
export type SyncForm = {
  url: string;
  username: string;
  password: string;
  passwordTouched: boolean;
  remoteDir: string;
  profile: string;
  autoSync: boolean;
};

export type PresetId = "jianguoyun" | "nextcloud" | "synology" | "custom";

/** Presets only fill in the URL template; the remaining fields still need to be entered by the user. */
export const SYNC_PRESETS: { id: Exclude<PresetId, "custom">; url: string }[] = [
  { id: "jianguoyun", url: "https://dav.jianguoyun.com/dav/" },
  { id: "nextcloud", url: "https://server/remote.php/dav/files/USER/" },
  { id: "synology", url: "http://nas-ip:5005/" },
];

/**
 * Infer the preset from the saved URL, so the dropdown does not stay stuck on "Custom" when
 * re-entering the settings page.
 *
 * Jianguoyun is determined by host (not `includes`); otherwise `dav.jianguoyun.com.evil.test`
 * would also be recognized as Jianguoyun.
 */
export function detectPreset(url: string): PresetId {
  const trimmed = url.trim();
  if (!trimmed) return "custom";
  let host = "";
  let port = "";
  try {
    const parsed = new URL(trimmed);
    host = parsed.hostname.toLowerCase();
    port = parsed.port;
  } catch {
    return "custom";
  }
  if (host === "dav.jianguoyun.com") return "jianguoyun";
  if (/\/remote\.php\/dav\//i.test(trimmed)) return "nextcloud";
  if (port === "5005" || port === "5006") return "synology";
  return "custom";
}

export function emptyForm(): SyncForm {
  return {
    url: "",
    username: "",
    password: "",
    passwordTouched: false,
    remoteDir: "",
    profile: "",
    autoSync: false,
  };
}

export function formFromView(view: BackupSyncConfigView): SyncForm {
  return {
    url: view.url,
    username: view.username,
    // The backend never returns the password, so the form always starts from an empty string and relies on the placeholder to signal "saved".
    password: "",
    passwordTouched: false,
    remoteDir: view.remoteDir,
    profile: view.profile,
    autoSync: view.autoSync,
  };
}

/** Whether the form has unsaved changes. Upload/download use the stored config, so a dirty form must be saved first. */
export function isDirty(form: SyncForm, view: BackupSyncConfigView | null): boolean {
  if (!view) return true;
  return (
    form.passwordTouched ||
    form.url !== view.url ||
    form.username !== view.username ||
    form.remoteDir !== view.remoteDir ||
    form.profile !== view.profile ||
    form.autoSync !== view.autoSync
  );
}

/**
 * Whether the credentials are complete enough to initiate a connection test.
 *
 * Saving automatically runs a connection test, but the user may well save a version with only
 * the address filled in. In that case the test necessarily fails with "please enter a
 * username", rendering a normal save as a red error.
 */
export function canTestSyncConnection(view: BackupSyncConfigView): boolean {
  return Boolean(view.url && view.username && view.hasPassword);
}

/** Whether the event represents a successful background auto-sync. */
export function isAutoSyncSuccess(payload: BackupSyncStatusEvent): boolean {
  return !payload.lastError && payload.lastSyncAt !== null;
}

/**
 * Merge a background auto-sync result event into the view.
 *
 * The backend has already persisted the result; updating the in-memory view here just makes the
 * persistent banner reflect the latest state immediately - otherwise it would only be visible the
 * next time the settings page is opened. When there is nothing to do, return `prev` unchanged so
 * React skips this re-render.
 */
export function applySyncStatusEvent(
  prev: BackupSyncConfigView | null,
  payload: BackupSyncStatusEvent,
): BackupSyncConfigView | null {
  if (!prev) return prev;
  if (payload.lastError) return { ...prev, lastError: payload.lastError };
  if (payload.lastSyncAt !== null) {
    // Success clears the error: the path is working now, and the old banner is stale.
    return { ...prev, lastSyncAt: payload.lastSyncAt, lastError: null };
  }
  return prev;
}
