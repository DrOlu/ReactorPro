// Frontend persistence for floor bookmarks: a single versioned localStorage key (consistent with
// the JSON blob convention in lib/settings/storage.ts), shaped
// { version, conversations: { [conversationId]: messageId[] } }. Bookmarks are recorded by stable
// message id (`user-${uuid}`, stored alongside the conversation in SQLite), so they still line up
// after a restart. When localStorage is unavailable, bookmarks silently degrade to
// current-run-only.

const STORAGE_KEY = "liveagent.floor-bookmarks.v1";
/** Prevent unbounded growth: keep bookmarks for only this many most recently written conversations. */
const MAX_CONVERSATIONS = 200;

const EMPTY_BOOKMARKS: ReadonlySet<string> = new Set();

let cache: Map<string, ReadonlySet<string>> | null = null;
const listeners = new Set<() => void>();

function readStoredConversations(): Record<string, string[]> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const conversations = (parsed as { conversations?: unknown }).conversations;
    if (!conversations || typeof conversations !== "object") return {};
    const result: Record<string, string[]> = {};
    for (const [conversationId, ids] of Object.entries(conversations as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      const clean = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
      if (clean.length > 0) result[conversationId] = clean;
    }
    return result;
  } catch {
    return {};
  }
}

function ensureCache(): Map<string, ReadonlySet<string>> {
  if (!cache) {
    cache = new Map(
      Object.entries(readStoredConversations()).map(([conversationId, ids]) => [
        conversationId,
        new Set(ids) as ReadonlySet<string>,
      ]),
    );
  }
  return cache;
}

function persist(map: Map<string, ReadonlySet<string>>) {
  // Trim capacity directly on the in-memory Map (Map iteration order = insertion order, oldest
  // first), then persist the whole thing — memory and localStorage always agree, with no fork
  // where "this run still sees bookmarks for an evicted conversation that vanish after a
  // restart".
  while (map.size > MAX_CONVERSATIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  try {
    const payload = {
      version: 1,
      conversations: Object.fromEntries([...map.entries()].map(([id, ids]) => [id, [...ids]])),
    };
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage unavailable (private mode / quota): bookmarks are effective only for this run.
  }
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/** Return a conversation's bookmark set; the reference is stable while unchanged, so it can be used directly with useSyncExternalStore. */
export function getFloorBookmarks(conversationId: string): ReadonlySet<string> {
  return ensureCache().get(conversationId) ?? EMPTY_BOOKMARKS;
}

export function toggleFloorBookmark(conversationId: string, messageId: string): void {
  if (!conversationId || !messageId) return;
  const map = ensureCache();
  const next = new Set(map.get(conversationId) ?? []);
  if (next.has(messageId)) {
    next.delete(messageId);
  } else {
    next.add(messageId);
  }
  if (next.size === 0) {
    map.delete(conversationId);
  } else {
    // Re-inserting moves the conversation back to the tail of the Map (persist's capacity trim
    // keeps the most recently used).
    map.delete(conversationId);
    map.set(conversationId, next);
  }
  persist(map);
  emit();
}

export function subscribeFloorBookmarks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: clear the in-memory cache, forcing the next access to re-read localStorage. */
export function resetFloorBookmarksCacheForTest(): void {
  cache = null;
}
