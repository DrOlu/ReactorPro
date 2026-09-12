// crates/agent-gui/src/pages/chat/gateway/clarifyDeltaForwarder.ts
//
// Serialized, frame-coalescing forwarding of clarification streaming deltas: firing a fire-and-forget invoke per
// token would land concurrently on the Tauri async runtime, possibly out of order under bursts (briefly garbling the
// preview), and produce one IPC + gateway WS message per token. This guarantees at most one invoke in flight at any
// time; deltas arriving while one is in flight merge into a buffer and the next flush coalesces them into one --
// preserving order while naturally rate-limiting.

/** Wraps a serial flush loop; a failed send only warns and does not interrupt (Rust silently drops non-pending requests). */
export function createClarifyDeltaForwarder(
  send: (text: string) => Promise<unknown>,
  onError: (error: unknown) => void = () => {},
): (delta: string) => void {
  let buffer = "";
  let flushing = false;

  const flush = async () => {
    flushing = true;
    try {
      while (buffer) {
        const text = buffer;
        buffer = "";
        try {
          await send(text);
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      flushing = false;
    }
  };

  return (delta) => {
    if (!delta) return;
    buffer += delta;
    if (!flushing) {
      void flush();
    }
  };
}
