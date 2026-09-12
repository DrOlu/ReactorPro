import { useEffect, useState } from "react";

/**
 * Whether the document is hidden.
 *
 * Both signals count as hidden: `document.hidden` and `document.visibilityState` should stay in
 * sync, but under Tauri/WKWebView's background-startup state a combination has appeared where
 * `hidden=true` while `visibilityState` is still `"visible"` (the original implementation is the
 * section-enter fallback in the settings page).
 *
 * Leaving the background fires `visibilitychange` only once, so timers that ran during hiding are
 * always restored by "resubscribe + recompute" rather than "pause then resume accumulating".
 */
export function isDocumentHidden(): boolean {
  if (typeof document === "undefined") return false;
  return document.hidden || document.visibilityState === "hidden";
}

/**
 * Subscribes to document visibility. When the window is not visible, the renderer process should not
 * keep running per-second heartbeats, rebuilding ledgers, or redrawing long lists -- the frames these
 * produce are invisible to the user yet still burn CPU (in long conversations this shows up as the
 * renderer process staying above 80% and the whole machine thermally throttling).
 */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(isDocumentHidden);

  useEffect(() => {
    const sync = () => setHidden(isDocumentHidden());
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return hidden;
}
