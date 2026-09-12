export type TurnCancellationScope = {
  controller: AbortController;
  release: () => void;
};

export type TurnCancellation = {
  // The whole-turn user stop intent. The conversation registers it on the abort controller once,
  // never replacing it, so a stop request can no longer fall into the window "after abort, before
  // a new controller is registered".
  userStop: AbortController;
  deriveScope: () => TurnCancellationScope;
};

/**
 * Two-level cancellation: userStop is the turn-level signal; each LLM request (main request,
 * compaction summary, title task) calls deriveScope() to get its own child controller. A local
 * abort (e.g. mid-stream compaction interrupting the main request) affects only its own scope;
 * when userStop fires it propagates in a chain to all live scopes.
 * AbortSignal.any is not used: avoid assumptions about the Tauri webview WebKit version.
 */
// Bridges an externally provided AbortSignal (e.g. a subagent's run signal) into userStop.
export function createTurnCancellationFromSignal(signal?: AbortSignal): TurnCancellation {
  const cancellation = createTurnCancellation();
  if (signal) {
    if (signal.aborted) {
      cancellation.userStop.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => cancellation.userStop.abort(signal.reason), {
        once: true,
      });
    }
  }
  return cancellation;
}

export function createTurnCancellation(): TurnCancellation {
  const userStop = new AbortController();

  function deriveScope(): TurnCancellationScope {
    const controller = new AbortController();
    if (userStop.signal.aborted) {
      controller.abort(userStop.signal.reason);
      return { controller, release: () => {} };
    }

    const onUserStop = () => {
      controller.abort(userStop.signal.reason);
    };
    userStop.signal.addEventListener("abort", onUserStop, { once: true });
    const release = () => {
      userStop.signal.removeEventListener("abort", onUserStop);
    };
    // Release the listener once the scope itself ends, so long turns do not accumulate listeners.
    controller.signal.addEventListener("abort", release, { once: true });
    return { controller, release };
  }

  return { userStop, deriveScope };
}
