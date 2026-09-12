export type TerminalPaneBindingListener = () => void;

export type TerminalPaneBindingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type TerminalPaneBindingStoreOptions = {
  /** Passing null explicitly uses pure in-memory bindings; omitting it uses sessionStorage. */
  storage?: TerminalPaneBindingStorage | null;
  storageKey?: string;
};

/**
 * Terminal runtime binding (Runtime Binding) layer: surfaceId -> sessionId.
 * The layout JSON persists only launchSpec + surfaceId, while sessionId lives in sessionStorage:
 * after a webview reload the Rust terminal registry is still alive and the binding can be reconciled and
 * recovered; after an app restart sessionStorage is cleared, which exactly corresponds to the terminal
 * session being dead. Degrades to pure in-memory when there is no window / on storage errors.
 */
export type TerminalPaneBindingStore = {
  get(surfaceId: string): string | null;
  set(surfaceId: string, sessionId: string): void;
  delete(surfaceId: string): void;
  /** All currently bound surfaceIds; the reference stays stable while bindings are unchanged (for recovery reconciliation / snapshot subscription). */
  surfaceIds(): readonly string[];
  /** Reconcile: keep only bindings whose sessionId is still in liveSessionIds, and return the list of cleared surfaceIds. */
  reconcile(liveSessionIds: ReadonlySet<string>): string[];
  subscribe(listener: TerminalPaneBindingListener): () => void;
};

export const TERMINAL_PANE_BINDING_STORAGE_KEY = "liveagent.terminalPaneBindings.v1";

function resolveDefaultStorage(): TerminalPaneBindingStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readPersistedBindings(
  storage: TerminalPaneBindingStorage | null,
  storageKey: string,
): Map<string, string> {
  const bindings = new Map<string, string>();
  if (!storage) return bindings;
  let raw: string | null = null;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return bindings;
  }
  if (!raw) return bindings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Bad JSON: ignore it and rebuild from an empty state; the next write overwrites the dirty data.
    return bindings;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return bindings;
  }
  for (const [surfaceId, sessionId] of Object.entries(parsed)) {
    const surfaceKey = surfaceId.trim();
    if (!surfaceKey || typeof sessionId !== "string" || !sessionId.trim()) continue;
    bindings.set(surfaceKey, sessionId.trim());
  }
  return bindings;
}

export function createTerminalPaneBindingStore(
  options?: TerminalPaneBindingStoreOptions,
): TerminalPaneBindingStore {
  const storageKey = options?.storageKey?.trim() || TERMINAL_PANE_BINDING_STORAGE_KEY;
  const storage =
    options && "storage" in options ? (options.storage ?? null) : resolveDefaultStorage();
  const bindings = readPersistedBindings(storage, storageKey);
  const listeners = new Set<TerminalPaneBindingListener>();
  let surfaceIdsSnapshot: readonly string[] = Array.from(bindings.keys());

  const emit = () => {
    surfaceIdsSnapshot = Array.from(bindings.keys());
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  const persist = () => {
    if (!storage) return;
    try {
      if (bindings.size === 0) {
        storage.removeItem(storageKey);
      } else {
        storage.setItem(storageKey, JSON.stringify(Object.fromEntries(bindings)));
      }
    } catch {
      // A storage write failure (quota/private mode) degrades only to in-memory state and does not affect the caller.
    }
  };

  return {
    get(surfaceId) {
      const key = surfaceId.trim();
      if (!key) return null;
      const hit = bindings.get(key);
      if (hit) return hit;
      // Fall back to adopting from storage on an in-memory miss: under dev HMR the writer and reader may
      // hold different module instances, and storage is their only shared layer. Without this step, a Pane
      // with a dragged-in existing session would misjudge it as "no binding" and create a new PTY from
      // launchSpec --- observable as a wait for the shell cold start (seconds) after drag-in, with the
      // original session left in the dock. Adopt silently without notifying listeners: get is called by
      // useSyncExternalStore as getSnapshot during render, so the first read returns the correct value and
      // render must not trigger other component updates.
      const persisted = readPersistedBindings(storage, storageKey).get(key);
      if (persisted) {
        bindings.set(key, persisted);
        surfaceIdsSnapshot = Array.from(bindings.keys());
        return persisted;
      }
      return null;
    },
    set(surfaceId, sessionId) {
      const surfaceKey = surfaceId.trim();
      const sessionKey = sessionId.trim();
      if (!surfaceKey || !sessionKey) return;
      if (bindings.get(surfaceKey) === sessionKey) return;
      bindings.set(surfaceKey, sessionKey);
      persist();
      emit();
    },
    delete(surfaceId) {
      const key = surfaceId.trim();
      if (!key) return;
      if (!bindings.delete(key)) return;
      persist();
      emit();
    },
    surfaceIds() {
      return surfaceIdsSnapshot;
    },
    reconcile(liveSessionIds) {
      const removed: string[] = [];
      for (const [surfaceId, sessionId] of bindings) {
        if (!liveSessionIds.has(sessionId)) {
          bindings.delete(surfaceId);
          removed.push(surfaceId);
        }
      }
      if (removed.length > 0) {
        persist();
        emit();
      }
      return removed;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
