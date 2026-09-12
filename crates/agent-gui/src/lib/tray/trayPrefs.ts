/**
 * Tray local preferences (desktop GUI only; not synced into settings / gateway):
 * - showConversationTitles: whether the tray shows conversation titles (screen-sharing privacy; when off, shows "Conversation N")
 * - showRunningBadge: whether the macOS status bar shows a text badge with the running count
 *
 * Stored in localStorage; together with global shortcut bindings
 * (`lib/shortcuts/globalShortcuts.ts`) it belongs to the "device preferences" category. It
 * carries a subscription so the tray sync effect re-pushes immediately after a settings change.
 */

import { useSyncExternalStore } from "react";

export type TrayPrefs = {
  showConversationTitles: boolean;
  showRunningBadge: boolean;
};

const STORAGE_KEY = "liveagent.trayPrefs.v1";

export const DEFAULT_TRAY_PREFS: TrayPrefs = {
  showConversationTitles: true,
  showRunningBadge: false,
};

const listeners = new Set<() => void>();
let cached: TrayPrefs | null = null;

function normalizeTrayPrefs(input: unknown): TrayPrefs {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    showConversationTitles: obj.showConversationTitles !== false,
    showRunningBadge: obj.showRunningBadge === true,
  };
}

export function readTrayPrefs(): TrayPrefs {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cached = raw ? normalizeTrayPrefs(JSON.parse(raw)) : DEFAULT_TRAY_PREFS;
  } catch {
    cached = DEFAULT_TRAY_PREFS;
  }
  return cached;
}

export function writeTrayPrefs(patch: Partial<TrayPrefs>): TrayPrefs {
  const next = { ...readTrayPrefs(), ...patch };
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // When storage is unavailable, this takes effect in memory only.
  }
  for (const listener of listeners) {
    listener();
  }
  return next;
}

export function subscribeTrayPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTrayPrefs(): TrayPrefs {
  return useSyncExternalStore(subscribeTrayPrefs, readTrayPrefs, readTrayPrefs);
}
