/**
 * Tray menu model: assembles settings/locale/sidebar snapshot/cron/gateway status into the
 * Rust `TrayMenuModel` (services/tray.rs) and pushes it via `app_tray_menu_sync`.
 *
 * Constraints:
 * - The single source of truth for copy is `i18n/config.ts`: all localization happens here, and
 *   Rust only displays.
 * - Full push every time + JSON signature debounce (mirroring hasChanged in `lib/settings/storage.ts`).
 * - Lists are truncated on the frontend (recent 8 / workspaces 8 / running 10 / cron 10);
 *   the Rust side has its own defensive caps. Title sanitization (& escaping/width truncation)
 *   is centralized in Rust.
 * - In non-Tauri environments (vite dev / WebUI has no such module) invoke failures are silent.
 */

import type { CronTask } from "@liveagent/ui/lib/automation/types";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import { invoke } from "@tauri-apps/api/core";
import { type Locale, t } from "../../i18n/config";
import type { AppSettings, Theme, WorkspaceProject } from "../settings";
import { workspaceProjectPathKey } from "../settings";
import { readGlobalShortcutBindings } from "../shortcuts/globalShortcuts";
import type { TrayPrefs } from "./trayPrefs";

const TRAY_RECENT_LIMIT = 8;
const TRAY_WORKSPACE_LIMIT = 8;
const TRAY_RUNS_LIMIT = 10;
const TRAY_CRON_LIMIT = 10;

export type TrayMenuEntry = {
  id: string;
  label: string;
  checked?: boolean;
};

/** One-to-one with the fields of Rust `services::tray::TrayMenuModel` (serde camelCase). */
export type TrayMenuModel = {
  labels: {
    show: string;
    newChat: string;
    pin: string;
    recent: string;
    recentViewAll: string;
    workspaces: string;
    runs: string;
    stopAll: string;
    cron: string;
    gateway: string;
    appearance: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    settings: string;
    checkUpdates: string;
    openDataDir: string;
    quit: string;
  };
  statusSuffix: string | null;
  recent: TrayMenuEntry[];
  recentTruncated: boolean;
  workspaces: TrayMenuEntry[];
  runs: TrayMenuEntry[];
  cron: TrayMenuEntry[];
  theme: Theme;
  gatewayEnabled: boolean;
  showAccelerator: string | null;
  newChatAccelerator: string | null;
  tooltip: string | null;
  badgeText: string | null;
};

export type BuildTrayMenuModelInput = {
  locale: Locale;
  theme: Theme;
  conversations: readonly SidebarConversation[];
  runningConversationIds: ReadonlySet<string>;
  workspaceProjects: readonly WorkspaceProject[];
  activeWorkspaceProjectId: string | undefined;
  archivedWorkspaceProjectPaths: readonly string[];
  cronTasks: readonly CronTask[];
  remote: AppSettings["remote"];
  gatewayOnline: boolean;
  prefs: TrayPrefs;
};

function withCount(template: string, count: number): string {
  return template.replace("{count}", String(count));
}

/** Shortcut echo: only bindings that are enabled; the format is compatible with muda accelerator parsing. */
function enabledAccelerator(action: "summon" | "newChat"): string | null {
  const binding = readGlobalShortcutBindings()[action];
  if (!binding || binding.enabled === false || binding.scope === "app") return null;
  const accelerator = binding.accelerator.trim();
  return accelerator ? accelerator : null;
}

function conversationLabel(
  conversation: SidebarConversation,
  index: number,
  locale: Locale,
  prefs: TrayPrefs,
): string {
  if (!prefs.showConversationTitles) {
    return withCount(t("tray.conversationPlaceholder", locale), index + 1);
  }
  const title = conversation.title.trim();
  return title ? title : t("tray.untitledConversation", locale);
}

export function buildTrayMenuModel(input: BuildTrayMenuModelInput): TrayMenuModel {
  const { locale, prefs } = input;

  // Recent conversations: selectConversations already sorts pinned first, so just take the first N (skipping local draft rows).
  const persisted = input.conversations.filter((conversation) => !conversation.isPending);
  const recent = persisted.slice(0, TRAY_RECENT_LIMIT).map((conversation, index) => ({
    id: conversation.id,
    label: conversationLabel(conversation, index, locale, prefs),
  }));
  const recentTruncated = persisted.length > TRAY_RECENT_LIMIT;

  // Workspaces: archived entries do not go into the tray (activation semantics unarchive them, and the tray does not offer such an implicit action).
  const archivedKeys = new Set(
    input.archivedWorkspaceProjectPaths.map((path) => workspaceProjectPathKey(path)),
  );
  const workspaces = input.workspaceProjects
    .filter((project) => !archivedKeys.has(workspaceProjectPathKey(project.path)))
    .slice(0, TRAY_WORKSPACE_LIMIT)
    .map((project) => ({
      id: project.id,
      label: project.name,
      checked: project.id === input.activeWorkspaceProjectId,
    }));

  // Running: the sidebar snapshot's running set (local + remote runs already merged).
  const runningIds = input.runningConversationIds;
  const runs: TrayMenuEntry[] = [];
  let runIndex = 0;
  for (const conversation of persisted) {
    if (runs.length >= TRAY_RUNS_LIMIT) break;
    if (!runningIds.has(conversation.id)) continue;
    runs.push({
      id: conversation.id,
      label: conversationLabel(conversation, runIndex, locale, prefs),
    });
    runIndex += 1;
  }
  const runningCount = runningIds.size;

  // Cron tasks: all listed with an enabled checkmark (clicking = toggle, not execute).
  const cron = input.cronTasks.slice(0, TRAY_CRON_LIMIT).map((task) => ({
    id: task.id,
    label: task.name.trim() || t("tray.untitledCronTask", locale),
    checked: task.enabled,
  }));

  const remoteConfigured =
    input.remote.gatewayUrl.trim() !== "" && input.remote.token.trim() !== "";
  const gatewayStatusText = !remoteConfigured
    ? null
    : input.gatewayOnline
      ? t("tray.gatewayConnected", locale)
      : input.remote.enabled
        ? t("tray.gatewayConnecting", locale)
        : t("tray.gatewayDisconnected", locale);

  const tooltipParts = [
    "ReactorPro",
    runningCount > 0 ? withCount(t("tray.tooltipRunning", locale), runningCount) : null,
    gatewayStatusText,
  ].filter((part): part is string => Boolean(part));

  return {
    labels: {
      show: t("tray.show", locale),
      newChat: t("tray.newChat", locale),
      pin: t("tray.pin", locale),
      recent: t("tray.recent", locale),
      recentViewAll: t("tray.recentViewAll", locale),
      workspaces: t("tray.workspaces", locale),
      runs:
        runningCount > 0
          ? withCount(t("tray.runsActive", locale), runningCount)
          : t("tray.runsIdle", locale),
      stopAll: t("tray.stopAll", locale),
      cron: t("tray.cron", locale),
      gateway: remoteConfigured
        ? `${t("tray.gateway", locale)} · ${gatewayStatusText ?? ""}`
        : t("tray.gatewayNotConfigured", locale),
      appearance: `${t("tray.appearance", locale)} · ${t(
        input.theme === "light"
          ? "tray.themeLight"
          : input.theme === "dark"
            ? "tray.themeDark"
            : "tray.themeSystem",
        locale,
      )}`,
      themeLight: t("tray.themeLight", locale),
      themeDark: t("tray.themeDark", locale),
      themeSystem: t("tray.themeSystem", locale),
      settings: t("tray.settings", locale),
      checkUpdates: t("tray.checkUpdates", locale),
      openDataDir: t("tray.openDataDir", locale),
      quit: t("tray.quit", locale),
    },
    statusSuffix: gatewayStatusText,
    recent,
    recentTruncated,
    workspaces,
    runs,
    cron,
    theme: input.theme,
    gatewayEnabled: remoteConfigured,
    showAccelerator: enabledAccelerator("summon"),
    newChatAccelerator: enabledAccelerator("newChat"),
    tooltip: tooltipParts.join(" · "),
    badgeText: prefs.showRunningBadge && runningCount > 0 ? String(runningCount) : null,
  };
}

let lastSyncedSignature: string | null = null;

/** Signature-debounced full push; silent in non-Tauri environments. */
export async function syncTrayMenu(model: TrayMenuModel): Promise<void> {
  const signature = JSON.stringify(model);
  if (signature === lastSyncedSignature) {
    return;
  }
  try {
    await invoke("app_tray_menu_sync", { model } as never);
    lastSyncedSignature = signature;
  } catch {
    // Non-Tauri environment or an older desktop shell: ignore.
  }
}
