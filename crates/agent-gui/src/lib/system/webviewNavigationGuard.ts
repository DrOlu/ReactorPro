/**
 * Desktop webview navigation guard (GUI-only; do not mirror into the WebUI --
 * in a browser, F5 to refresh is what users expect).
 *
 * Host webviews such as WebView2 (Windows) ship a set of "browser accelerator
 * keys": F5/Ctrl+R/Ctrl+F5 to reload, Ctrl+F/F3 for the native find bar, Ctrl+P
 * to print, Ctrl+S to save the page, Ctrl+O to open a file, Ctrl+U to view
 * source, F7 for caret browsing, Alt+Left/Right/Home for history navigation;
 * mouse side buttons (button 3/4) and in-page drag-and-drop likewise trigger
 * history navigation or page jumps. These defaults would treat the whole app as
 * a web page to reload/navigate, showing up as "the entire app refreshing".
 *
 * Chromium-family accelerator keys stop executing once the page calls
 * preventDefault on keydown, so we cancel the default behavior uniformly in the
 * window capture phase. We only preventDefault, never stopPropagation:
 * xterm/Monaco/in-app shortcut handlers still receive the events as usual.
 */

export interface GuardKeyInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface GuardKeyOptions {
  /** On macOS, Option+arrow is the default word-wise cursor movement, so history navigation interception applies only to non-mac. */
  isMac: boolean;
  /** In dev, let reload chords through (F5/Ctrl+R/Cmd+R) to ease local full-page reload debugging. */
  allowReloadChords: boolean;
}

/** Keyboard media navigation keys (UI Events standard key values); always cancel their default behavior. */
const BROWSER_NAV_KEYS = new Set([
  "BrowserBack",
  "BrowserForward",
  "BrowserHome",
  "BrowserSearch",
  "BrowserFavorites",
  "BrowserStop",
]);

// Physical keys to intercept under the primary modifier (Ctrl/Cmd): print/find/
// save page/open file/view source. Match on both code and key -- under non-Latin
// layouts (e.g. Cyrillic) key is a local character, while webview accelerator
// keys act on the physical key position (code).
const PRIMARY_BLOCKED_CODES = new Set(["KeyP", "KeyF", "KeyS", "KeyO", "KeyU"]);
const PRIMARY_BLOCKED_KEYS = new Set(["p", "f", "s", "o", "u"]);

/**
 * Decide whether a keydown should cancel the webview's browser default behavior.
 * Pure function, easy to exhaustively test; it does not judge in-app shortcuts
 * (those go through their own component handlers).
 */
export function shouldBlockBrowserKeyDefault(
  event: GuardKeyInput,
  options: GuardKeyOptions,
): boolean {
  const primary = event.ctrlKey || event.metaKey;

  // The whole reload family: F5 / Ctrl+F5 / Shift+F5 / the BrowserRefresh media key.
  if (event.key === "F5" || event.key === "BrowserRefresh") {
    return !options.allowReloadChords;
  }
  // F3 find-next and F7 caret browsing confirmation dialog (both WebView2 accelerator keys).
  if (event.key === "F3" || event.key === "F7") return true;
  if (BROWSER_NAV_KEYS.has(event.key)) return true;

  // On Windows AltGr is reported as ctrl+alt; let it through so special-character input is not swallowed.
  if (primary && !event.altKey) {
    if (event.code === "KeyR" || event.key.toLowerCase() === "r") {
      return !options.allowReloadChords;
    }
    if (
      PRIMARY_BLOCKED_CODES.has(event.code) ||
      PRIMARY_BLOCKED_KEYS.has(event.key.toLowerCase())
    ) {
      return true;
    }
  }

  // Alt+Left/Right history navigation and Alt+Home back to home (Windows/Linux webview).
  if (!options.isMac && event.altKey && !primary) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home") {
      return true;
    }
  }

  return false;
}

/** Dragging text into an input box or rich text is a valid edit operation, so the drag-and-drop guard lets editable targets through. */
function isEditableDragTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  return el.isContentEditable === true;
}

export interface WebviewNavigationGuardOptions {
  isMac: boolean;
  allowReloadChords?: boolean;
}

/** Minimal structured event-source type: production passes window, tests pass a recording fake. */
export interface GuardEventSource {
  addEventListener(
    type: string,
    listener: (event: never) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: never) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

// Record only the defaults cancelled by the navigation guard, so app shortcuts
// can still handle these events. A WeakSet does not modify native events and
// does not retain event references after key handling ends.
const browserDefaultBlockedEvents = new WeakSet<Event>();

export function wasBrowserKeyDefaultBlocked(event: Event): boolean {
  return browserDefaultBlockedEvents.has(event);
}

let uninstallCurrent: (() => void) | null = null;

/**
 * Install the webview navigation guard and return an uninstall function.
 * Repeated installation uninstalls the previous one first (idempotent, HMR-friendly).
 * Called before React mounts so every stage other than the UI crash fallback
 * page is protected.
 */
export function installWebviewNavigationGuard(
  options: WebviewNavigationGuardOptions,
  target?: GuardEventSource,
): () => void {
  const win = target ?? (typeof window === "undefined" ? null : window);
  if (!win) return () => {};
  uninstallCurrent?.();

  const keyOptions: GuardKeyOptions = {
    isMac: options.isMac,
    allowReloadChords: options.allowReloadChords ?? false,
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.defaultPrevented && shouldBlockBrowserKeyDefault(event, keyOptions)) {
      event.preventDefault();
      browserDefaultBlockedEvents.add(event);
    }
  };

  // Mouse side buttons (button 3/4) trigger history forward/back on
  // Chromium/WebView2; cancel both mousedown and mouseup to cover the trigger
  // timing of different engines.
  const onNavMouseButton = (event: MouseEvent) => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  };

  // In-page drag-and-drop into non-editable areas (a link/image/selected text) by
  // default makes the webview navigate to the dragged payload. Let through
  // anything a component already handled (defaultPrevented) and editable
  // targets; register in the bubble phase so we run after React root container
  // delegated handlers. External file drops are taken over by Tauri's native
  // dragDrop, producing no HTML5 drag events, so they are unaffected by this guard.
  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented || isEditableDragTarget(event.target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  const onDrop = (event: DragEvent) => {
    if (event.defaultPrevented || isEditableDragTarget(event.target)) return;
    event.preventDefault();
  };

  // Forms that forget to preventDefault in onSubmit otherwise do a full-page
// navigation (equivalent to a refresh) -- cancel as a fallback.
  const onSubmit = (event: Event) => {
    if (!event.defaultPrevented) event.preventDefault();
  };

  win.addEventListener("keydown", onKeyDown, { capture: true });
  win.addEventListener("mousedown", onNavMouseButton, { capture: true });
  win.addEventListener("mouseup", onNavMouseButton, { capture: true });
  win.addEventListener("dragover", onDragOver);
  win.addEventListener("drop", onDrop);
  win.addEventListener("submit", onSubmit);

  const uninstall = () => {
    win.removeEventListener("keydown", onKeyDown, { capture: true });
    win.removeEventListener("mousedown", onNavMouseButton, { capture: true });
    win.removeEventListener("mouseup", onNavMouseButton, { capture: true });
    win.removeEventListener("dragover", onDragOver);
    win.removeEventListener("drop", onDrop);
    win.removeEventListener("submit", onSubmit);
    if (uninstallCurrent === uninstall) uninstallCurrent = null;
  };
  uninstallCurrent = uninstall;
  return uninstall;
}
