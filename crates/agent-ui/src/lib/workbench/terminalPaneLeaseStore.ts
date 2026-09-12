export type TerminalPaneLeaseListener = () => void;

/**
 * Terminal view lease layer: a terminal sessionId is held by at most one pane on the canvas.
 * While a Pane holds the lease, other hosts such as the Right Dock must not mount that session's XTermViewport,
 * or the output stream would be double-consumed and input double-written. Leases are purely in-memory and not persisted.
 */
export type TerminalPaneLeaseStore = {
  /**
   * Acquires a lease and returns a release function. Throws when the sessionId is already held by another pane
   * (the caller must query paneIdFor first); a repeated acquire of the same session by the same pane idempotently
   * returns the existing release. release is idempotent and will not mistakenly release a lease created later.
   */
  acquire(sessionId: string, paneId: string): () => void;
  /**
   * Releases the lease held by the given pane (idempotent). A drop transaction claims the lease synchronously
   * before the host mounts; if the Pane is closed before the host ever acquires the lease, the release has no
   * holder and must be reclaimed by reconciling paneId, or that session is permanently hidden in the Right Dock.
   */
  releaseForPane(paneId: string): void;
  paneIdFor(sessionId: string): string | null;
  sessionIdFor(paneId: string): string | null;
  /** All sessionIds currently held by panes; the reference stays stable while leases are unchanged (a useSyncExternalStore snapshot). */
  leasedSessionIds(): readonly string[];
  subscribe(listener: TerminalPaneLeaseListener): () => void;
};

type LeaseRecord = {
  sessionId: string;
  paneId: string;
  release: () => void;
};

export function createTerminalPaneLeaseStore(): TerminalPaneLeaseStore {
  const leasesBySessionId = new Map<string, LeaseRecord>();
  const leasesByPaneId = new Map<string, LeaseRecord>();
  const listeners = new Set<TerminalPaneLeaseListener>();
  let leasedSessionIdsSnapshot: readonly string[] = [];

  const emit = () => {
    leasedSessionIdsSnapshot = Array.from(leasesBySessionId.keys());
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  const drop = (record: LeaseRecord) => {
    // Clears only the index still pointing at that record, preventing a stale release from mistakenly deleting a lease created later.
    if (leasesBySessionId.get(record.sessionId) === record) {
      leasesBySessionId.delete(record.sessionId);
    }
    if (leasesByPaneId.get(record.paneId) === record) {
      leasesByPaneId.delete(record.paneId);
    }
  };

  return {
    acquire(sessionId, paneId) {
      const sessionKey = sessionId.trim();
      const paneKey = paneId.trim();
      if (!sessionKey || !paneKey) {
        throw new Error("Terminal pane lease requires a sessionId and a paneId.");
      }
      const existing = leasesBySessionId.get(sessionKey);
      if (existing) {
        if (existing.paneId !== paneKey) {
          throw new Error(
            `Terminal session '${sessionKey}' is already leased by pane '${existing.paneId}'.`,
          );
        }
        return existing.release;
      }
      // When the same pane rebinds to a new session (rebuilding the terminal), first release the old lease it
      // holds, maintaining the bidirectional invariant "at most one terminal view per pane".
      const previous = leasesByPaneId.get(paneKey);
      if (previous) {
        drop(previous);
      }
      let released = false;
      const record: LeaseRecord = {
        sessionId: sessionKey,
        paneId: paneKey,
        release: () => {
          if (released) return;
          released = true;
          drop(record);
          emit();
        },
      };
      leasesBySessionId.set(sessionKey, record);
      leasesByPaneId.set(paneKey, record);
      emit();
      return record.release;
    },
    releaseForPane(paneId) {
      const key = paneId.trim();
      if (!key) return;
      leasesByPaneId.get(key)?.release();
    },
    paneIdFor(sessionId) {
      const key = sessionId.trim();
      if (!key) return null;
      return leasesBySessionId.get(key)?.paneId ?? null;
    },
    sessionIdFor(paneId) {
      const key = paneId.trim();
      if (!key) return null;
      return leasesByPaneId.get(key)?.sessionId ?? null;
    },
    leasedSessionIds() {
      return leasedSessionIdsSnapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Reclaims orphan leases by reconciling against the layout: if a Pane is closed before the host mounts (and
 * takes over release) after a drop transaction synchronously claims the lease, the lease would have no one to
 * release it. Both ends call this function on layout changes to release leases whose holder is no longer in the
 * layout; leases normally held by the host are released in its unmount cleanup before this reconciliation, so
 * they are unaffected.
 */
export function releaseOrphanTerminalPaneLeases(
  lease: Pick<TerminalPaneLeaseStore, "leasedSessionIds" | "paneIdFor" | "releaseForPane">,
  layout: { panes: Record<string, unknown> },
): void {
  for (const sessionId of lease.leasedSessionIds()) {
    const paneId = lease.paneIdFor(sessionId);
    if (paneId && layout.panes[paneId] === undefined) {
      lease.releaseForPane(paneId);
    }
  }
}
