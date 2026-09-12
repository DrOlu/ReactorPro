import type { TerminalStreamChunk } from "./types";

/**
 * Registry of terminal output stream handles: dispatch is bucketed by
 * sessionId.
 *
 * The old implementation kept all handles in one Set and iterated every handle
 * for each output event before filtering by sessionId (O(N)). With multiple
 * terminal panes side by side on the canvas, more handles are alive at once, so
 * under high-frequency output this was changed to Map<sessionId, Set> for O(1)
 * in-bucket dispatch.
 *
 * A single session is theoretically limited to one handle by the view lease,
 * but the data structure still allows multiple handles to coexist (defensive:
 * old and new handles may briefly overlap at the moment the lease transfers).
 */
export type TerminalStreamDispatchTarget = {
  accept(chunk: TerminalStreamChunk): void;
};

export function createTerminalStreamHandleRegistry<Handle extends TerminalStreamDispatchTarget>() {
  const handlesBySession = new Map<string, Set<Handle>>();

  return {
    add(sessionId: string, handle: Handle) {
      const key = sessionId.trim();
      if (!key) return;
      let bucket = handlesBySession.get(key);
      if (!bucket) {
        bucket = new Set();
        handlesBySession.set(key, bucket);
      }
      bucket.add(handle);
    },
    remove(sessionId: string, handle: Handle) {
      const key = sessionId.trim();
      const bucket = handlesBySession.get(key);
      if (!bucket) return;
      bucket.delete(handle);
      if (bucket.size === 0) {
        handlesBySession.delete(key);
      }
    },
    dispatch(chunk: TerminalStreamChunk) {
      const bucket = handlesBySession.get(chunk.sessionId);
      if (!bucket) return;
      // Snapshot the iteration: accept may internally trigger dispose -> remove, so
      // avoid mutating the set during iteration.
      for (const handle of Array.from(bucket)) {
        handle.accept(chunk);
      }
    },
    handleCount(sessionId: string) {
      return handlesBySession.get(sessionId.trim())?.size ?? 0;
    },
    sessionCount() {
      return handlesBySession.size;
    },
  };
}

export type TerminalStreamHandleRegistry<Handle extends TerminalStreamDispatchTarget> = ReturnType<
  typeof createTerminalStreamHandleRegistry<Handle>
>;
