// Frontend persistence for @-mention app "recently used": a single versioned localStorage key (consistent
// with the JSON blob convention in lib/chat-floor-nav/floorBookmarks.ts), structured as
// { version, keys: string[] }, with keys ordered most-recently-used first. Identity keys directly reuse
// appMentionIcons' identityKeys decision (bundle id > path > name), maintaining no separate priority list.
// When localStorage is unavailable it silently degrades to being valid only for the current run.

import { type AppMentionIconIdentity, identityKeys } from "./appMentionIcons";

const STORAGE_KEY = "liveagent.app-mention-recents.v1";
const STORAGE_VERSION = 1;
// Stores more than the popover displays: uninstalled or gated-out apps should not empty the list.
const MAX_RECENT_KEYS = 20;

export type AppMentionRecencyIdentity = AppMentionIconIdentity;

/** The recent-use list key for an app -- takes the most stable of the identity-key decisions as the canonical key. */
export function appMentionRecencyKey(identity: AppMentionRecencyIdentity): string {
  return identityKeys(identity)[0] ?? "";
}

/**
 * Sorts by recent use: listed ones come first in list order, and unlisted ones keep the input order
 * (the alphabetical order given by the host; Array.prototype.sort is a stable sort).
 */
export function sortAppsByMentionRecency<T extends AppMentionRecencyIdentity>(
  apps: readonly T[],
  recentKeys: readonly string[],
): T[] {
  const rank = new Map(recentKeys.map((key, index) => [key, index]));
  const rankOf = (app: T) => rank.get(appMentionRecencyKey(app)) ?? Number.MAX_SAFE_INTEGER;
  return [...apps].sort((a, b) => rankOf(a) - rankOf(b));
}

let cache: string[] | null = null;

function readStoredKeys(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== STORAGE_VERSION
    ) {
      return [];
    }
    const keys = (parsed as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) return [];
    return keys.filter((key): key is string => typeof key === "string" && key.length > 0);
  } catch {
    return [];
  }
}

function persist(keys: string[]) {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, keys }),
    );
  } catch {
    // Storage unavailable (private mode / quota): the list is only valid for the current run.
  }
}

/** Recently used app identity keys, most recent first. */
export function readAppMentionRecents(): readonly string[] {
  if (cache === null) cache = readStoredKeys();
  return cache;
}

/** Records one @-app use: the identity key is moved to the top and persisted. */
export function recordAppMentionUse(identity: AppMentionRecencyIdentity): void {
  const key = appMentionRecencyKey(identity);
  if (!key) return;
  const next = [key, ...readAppMentionRecents().filter((existing) => existing !== key)].slice(
    0,
    MAX_RECENT_KEYS,
  );
  cache = next;
  persist(next);
}

/** Test-only: clears the in-memory cache, forcing the next access to re-read localStorage. */
export function resetAppMentionRecentsCacheForTest(): void {
  cache = null;
}
