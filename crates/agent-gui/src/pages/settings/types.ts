import type { AppUpdateController } from "../../lib/appUpdates";
import type { AppSettings } from "../../lib/settings";
import type { SettingsSaveState } from "../../lib/settings/storage";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "system"
  | "shortcuts"
  | "skills"
  | "mcp"
  | "systemTools"
  | "providers"
  | "agents"
  | "ssh"
  | "memory"
  | "hooks"
  | "cron"
  | "remote"
  | "cua"
  | "about";

export type SettingsPageProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState: SettingsSaveState;
  onBack: () => void;
  initialSection?: SectionId;
  initialProviderId?: string;
  hiddenSections?: SectionId[];
  appUpdate: AppUpdateController;
  /** Reload from SQLite bypassing setSettings (used after backup restore; see SettingsSectionProps). */
  reloadSettings?: () => Promise<void>;
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState?: SettingsSaveState;
  /**
   * Reload settings from SQLite, **without triggering persistence**.
   *
   * Backup restore (import / WebDAV download) modifies the DB directly on the backend, and the
   * frontend store is entirely unaware. Without reloading, when the user later edits any domain,
   * `persistSettings` would diff against the pre-restore in-memory values, write the old config
   * back into the DB as-is, and then mark-dirty push it to the remote -- silently rolling the
   * restore back.
   *
   * This path must be used rather than `setSettings`: the latter calls `queueSettingsSave` every
   * time, rewriting the just-persisted data and triggering an automatic upload.
   */
  reloadSettings?: () => Promise<void>;
};
