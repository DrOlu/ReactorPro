import { useCallback, useEffect, useRef, useState } from "react";

export type SettingsOverlayState = "closed" | "entering" | "open" | "leaving";

/**
 * Fallback duration for entering / leaving.
 *
 * A fallback is needed because neither advance path happens while the document is hidden:
 * `requestAnimationFrame` callbacks are suspended, and `transitionend` is suppressed by WebKit.
 * If the settings page is opened while backgrounded or minimized, entering would stay at opacity-0
 * forever (the whole page looks blank) and leaving would stay at leaving forever (the panel never
 * unmounts).
 *
 * 350ms is slightly longer than the 300ms CSS transition: in the foreground the normal path always
 * arrives first, so the fallback only takes effect in abnormal cases.
 */
const OVERLAY_FALLBACK_MS = 350;

/**
 * Open/close state machine for the settings overlay.
 *
 * There is only one state: `settingsOpen` is derived from `overlay` (anything not closed is open).
 * It used to be two useState values maintained in parallel, which required a ref to read the latest
 * overlay and careful handling of duplicate setter calls under StrictMode -- all the burden of
 * storing the same fact twice.
 */
export function useSettingsOverlay() {
  const [overlay, setOverlay] = useState<SettingsOverlayState>("closed");
  const fallbackTimerRef = useRef<number | null>(null);

  const clearFallback = useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  /**
   * Advance the state from `from` to `to`. It uses a functional update, so arrival order does not
   * matter: the rAF chain, the 350ms fallback, and visibilitychange are idempotent with respect to
   * one another.
   */
  const promote = useCallback((from: SettingsOverlayState, to: SettingsOverlayState) => {
    setOverlay((current) => (current === from ? to : current));
  }, []);

  const armFallback = useCallback(
    (from: SettingsOverlayState, to: SettingsOverlayState) => {
      clearFallback();
      fallbackTimerRef.current = window.setTimeout(() => {
        fallbackTimerRef.current = null;
        promote(from, to);
      }, OVERLAY_FALLBACK_MS);
    },
    [clearFallback, promote],
  );

  const openSettingsOverlay = useCallback(() => {
    setOverlay("entering");
    armFallback("entering", "open");

    if (typeof document === "undefined" || document.visibilityState !== "visible") {
      // rAF does not call back while hidden. Advance directly, so by the time the user switches the
      // window to the foreground the overlay is already visible rather than stuck at opacity-0.
      promote("entering", "open");
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => promote("entering", "open")));
  }, [armFallback, promote]);

  const closeSettingsOverlay = useCallback(() => {
    setOverlay("leaving");
    armFallback("leaving", "closed");
  }, [armFallback]);

  const handleSettingsOverlayTransitionEnd = useCallback(() => {
    promote("leaving", "closed");
  }, [promote]);

  const resetSettingsOverlay = useCallback(() => {
    clearFallback();
    setOverlay("closed");
  }, [clearFallback]);

  // Advance immediately when the document becomes visible again, without waiting for the fallback
  // timer -- background timers are throttled by the browser, and the user switching back could land
  // right inside that stretch.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      promote("entering", "open");
      promote("leaving", "closed");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [promote]);

  // No timer should fire after unmount.
  useEffect(() => clearFallback, [clearFallback]);

  return {
    settingsOpen: overlay !== "closed",
    overlay,
    openSettingsOverlay,
    closeSettingsOverlay,
    handleSettingsOverlayTransitionEnd,
    resetSettingsOverlay,
  };
}
