import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../i18n/index";
import {
  absoluteWorkspacePath,
  clearActiveWorkspacePathDrag,
  getActiveWorkspacePathDrag,
  hasWorkspacePathDragPayload,
  quoteWorkspacePathForShell,
  readNativeWorkspacePathDragOver,
  readNativeWorkspacePathDrop,
  readWorkspacePathDragPayload,
  WORKSPACE_PATH_NATIVE_DRAG_LEAVE_EVENT,
  WORKSPACE_PATH_NATIVE_DRAG_OVER_EVENT,
  WORKSPACE_PATH_NATIVE_DROP_EVENT,
  type WorkspacePathDragPayload,
  workspacePathDragMatchesProject,
} from "../../lib/chat/workspacePathDrag";
import { CODE_FONT_FAMILY_CHANGE_EVENT, getCodeFontFamily } from "../../lib/shared/fontFamily";
import { cn } from "../../lib/shared/utils";
import type {
  TerminalClient,
  TerminalSession,
  TerminalSnapshot,
  TerminalStreamChunk,
  TerminalStreamHandle,
  TerminalStreamInputState,
} from "../../lib/terminal/types";

type XTermViewportProps = {
  client: TerminalClient;
  session: TerminalSession;
  theme: "light" | "dark";
  isActive: boolean;
  initialSnapshot?: TerminalSnapshot;
  className?: string;
  onError: (sessionId: string, message: string | null) => void;
  onInitialSnapshotConsumed?: (sessionId: string) => void;
};

const SNAPSHOT_ATTACH_RETRY_MIN_MS = 500;
const SNAPSHOT_ATTACH_RETRY_MAX_MS = 5_000;
// Two-level throttling while the container changes continuously (divider
// drag): visual fit runs periodically to stay responsive, and PTY resize is
// committed once after the size stabilizes (trailing edge), avoiding a flood
// of resizes to the backend during the drag.
const FIT_THROTTLE_MS = 80;
const PTY_RESIZE_DEBOUNCE_MS = 100;

function terminalTheme(theme: "light" | "dark") {
  if (theme === "dark") {
    return {
      background: "#0b0f14",
      foreground: "#4ade80",
      cursor: "#f8fafc",
      cursorAccent: "#0b0f14",
      selectionBackground: "#2c3e57",
      selectionInactiveBackground: "#22304a",
      scrollbarSliderBackground: "rgba(148, 163, 184, 0.18)",
      scrollbarSliderHoverBackground: "rgba(148, 163, 184, 0.3)",
      scrollbarSliderActiveBackground: "rgba(148, 163, 184, 0.42)",
      // xterm's css.toColor does not recognize the keyword "transparent" (the
      // canvas fallback path throws outright on alpha<255), and a parse failure
      // silently falls back to the default color #ffffff -- the overview ruler
      // draws a 1px vertical line with that color every frame
      // (_renderRulerOutline), i.e. the white line at the terminal's right edge.
      // An 8-digit hex goes through a separate branch that does not validate
      // alpha and is the true transparent form.
      overviewRulerBorder: "#00000000",
      black: "#1b2733",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#eab308",
      blue: "#38bdf8",
      magenta: "#c084fc",
      cyan: "#2dd4bf",
      white: "#cbd5e1",
      brightBlack: "#64748b",
      brightRed: "#f87171",
      brightGreen: "#4ade80",
      brightYellow: "#fde047",
      brightBlue: "#7dd3fc",
      brightMagenta: "#d8b4fe",
      brightCyan: "#5eead4",
      brightWhite: "#f8fafc",
    };
  }
  return {
    background: "#fcfcfd",
    foreground: "#1f2933",
    cursor: "#111827",
    cursorAccent: "#fcfcfd",
    selectionBackground: "#bfdbfe",
    selectionInactiveBackground: "#dbeafe",
    scrollbarSliderBackground: "rgba(100, 116, 139, 0.16)",
    scrollbarSliderHoverBackground: "rgba(100, 116, 139, 0.26)",
    scrollbarSliderActiveBackground: "rgba(100, 116, 139, 0.36)",
    // Same as the dark theme: 8-digit hex transparent; do not change back to
    // "transparent" (see above).
    overviewRulerBorder: "#00000000",
    black: "#1f2933",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#b45309",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#e2e8f0",
    brightBlack: "#64748b",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#d97706",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#f8fafc",
  };
}

function terminalContainerHasSize(container: HTMLElement) {
  const rect = container.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// execCommand("copy") fallback: textarea.select() steals focus, so after
// copying, return focus to the original element (the terminal) to avoid losing
// keyboard input after the user copies once.
function fallbackCopyTextToClipboard(text: string) {
  const active = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
  if (active instanceof HTMLElement) active.focus();
}

// In a non-secure context (http direct to gateway web), navigator.clipboard
// does not exist at all, so both "API missing" and "writeText rejected" must
// fall back to execCommand -- attaching the fallback only to catch would
// silently fail in exactly the environment that needs it most.
function writeTextToClipboard(text: string) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => fallbackCopyTextToClipboard(text));
    return;
  }
  fallbackCopyTextToClipboard(text);
}

export function XTermViewport({
  client,
  session,
  theme,
  isActive,
  initialSnapshot,
  className,
  onError,
  onInitialSnapshotConsumed,
}: XTermViewportProps) {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const [workspacePathDropState, setWorkspacePathDropState] = useState<"accept" | "blocked" | null>(
    null,
  );
  const resizeTimerRef = useRef<number | null>(null);
  const sessionRef = useRef(session);
  const themeRef = useRef(theme);
  const onErrorRef = useRef(onError);
  const initialSnapshotRef = useRef(initialSnapshot);
  const onInitialSnapshotConsumedRef = useRef(onInitialSnapshotConsumed);
  sessionRef.current = session;
  themeRef.current = theme;
  onErrorRef.current = onError;
  onInitialSnapshotConsumedRef.current = onInitialSnapshotConsumed;

  const termRef = useRef<XTerm | null>(null);
  const fitAndResizeRef = useRef<(() => void) | null>(null);
  const viewportStyle = {
    "--project-terminal-background": terminalTheme(theme).background,
  } as CSSProperties;

  const canAcceptWorkspacePath = useCallback(
    (payload = getActiveWorkspacePathDrag()) =>
      Boolean(
        payload &&
          session.kind === "local" &&
          workspacePathDragMatchesProject(payload, session.cwd) &&
          !termRef.current?.options.disableStdin,
      ),
    [session.cwd, session.kind],
  );

  const handleWorkspacePathDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasWorkspacePathDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const state = canAcceptWorkspacePath() ? "accept" : "blocked";
      event.dataTransfer.dropEffect = state === "accept" ? "copy" : "none";
      setWorkspacePathDropState(state);
    },
    [canAcceptWorkspacePath],
  );

  const insertWorkspacePathInTerminal = useCallback(
    (payload: WorkspacePathDragPayload) => {
      setWorkspacePathDropState(null);
      if (!canAcceptWorkspacePath(payload)) return false;
      const absolutePath = absoluteWorkspacePath(payload);
      const quotedPath = absolutePath
        ? quoteWorkspacePathForShell(absolutePath, session.shell)
        : null;
      if (!quotedPath) return false;
      termRef.current?.paste(quotedPath);
      termRef.current?.focus();
      return true;
    },
    [canAcceptWorkspacePath, session.shell],
  );

  const handleWorkspacePathDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasWorkspacePathDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const payload = readWorkspacePathDragPayload(event.dataTransfer);
      clearActiveWorkspacePathDrag();
      if (payload) insertWorkspacePathInTerminal(payload);
    },
    [insertWorkspacePathInTerminal],
  );

  useEffect(() => {
    const target = dropTargetRef.current;
    if (!target) return;
    const handleNativeWorkspacePathDragOver = (event: Event) => {
      const payload = readNativeWorkspacePathDragOver(event);
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      setWorkspacePathDropState(canAcceptWorkspacePath(payload) ? "accept" : "blocked");
    };
    const handleNativeWorkspacePathDragLeave = (event: Event) => {
      if (event.type !== WORKSPACE_PATH_NATIVE_DRAG_LEAVE_EVENT) return;
      setWorkspacePathDropState(null);
    };
    const handleNativeWorkspacePathDrop = (event: Event) => {
      const payload = readNativeWorkspacePathDrop(event);
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      insertWorkspacePathInTerminal(payload);
    };
    target.addEventListener(
      WORKSPACE_PATH_NATIVE_DRAG_OVER_EVENT,
      handleNativeWorkspacePathDragOver,
    );
    target.addEventListener(
      WORKSPACE_PATH_NATIVE_DRAG_LEAVE_EVENT,
      handleNativeWorkspacePathDragLeave,
    );
    target.addEventListener(WORKSPACE_PATH_NATIVE_DROP_EVENT, handleNativeWorkspacePathDrop);
    return () => {
      target.removeEventListener(
        WORKSPACE_PATH_NATIVE_DRAG_OVER_EVENT,
        handleNativeWorkspacePathDragOver,
      );
      target.removeEventListener(
        WORKSPACE_PATH_NATIVE_DRAG_LEAVE_EVENT,
        handleNativeWorkspacePathDragLeave,
      );
      target.removeEventListener(WORKSPACE_PATH_NATIVE_DROP_EVENT, handleNativeWorkspacePathDrop);
    };
  }, [canAcceptWorkspacePath, insertWorkspacePathInTerminal]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!isActive) {
      termRef.current?.blur();
      return;
    }
    termRef.current?.focus();
    window.setTimeout(() => {
      fitAndResizeRef.current?.();
    }, 0);
  }, [isActive]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: project identity intentionally recreates the terminal session viewport
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let snapshotLoaded = false;
    let loadingSnapshot = false;
    let renderedOutput = false;
    let lastOutputOffset = 0;
    let streamHandle: TerminalStreamHandle | null = null;
    let inputPausedByStream = false;
    let inputBackpressureMessageActive = false;
    let snapshotRetryTimer: number | null = null;
    let snapshotRetryDelayMs = SNAPSHOT_ATTACH_RETRY_MIN_MS;
    const bufferedChunks: TerminalStreamChunk[] = [];
    const encoder = new TextEncoder();
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      disableStdin: true,
      fontFamily: getCodeFontFamily(),
      fontSize: 13,
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1.3,
      letterSpacing: 0,
      scrollback: 5000,
      overviewRuler: {
        width: 8,
      },
      theme: terminalTheme(themeRef.current),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // Terminal copy/paste shortcuts: xterm's key map does not handle
    // Ctrl+Shift+letter (the ^C control-character branch requires no shift) or
    // Cmd combos, so after selecting, pressing Ctrl+Shift+C/Cmd+C does nothing
    // (#355). Attach custom key handling: Ctrl+Shift+C/V (Linux/Windows) and
    // Cmd+C/V (macOS) go through the clipboard, and all other keys pass through
    // to xterm. A handled branch must call event.preventDefault(): returning
    // false only skips xterm's own handling while the browser default still
    // runs -- Chromium's Ctrl+Shift+V and macOS's Cmd+V separately dispatch a
    // native paste event (xterm has a native paste listener on the textarea),
    // so not intercepting would paste twice for the same keystroke.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const isMod =
        (event.ctrlKey && event.shiftKey) || (event.metaKey && !event.ctrlKey && !event.altKey);
      if (isMod && key === "c") {
        const selection = term.getSelection();
        if (!selection) return true;
        event.preventDefault();
        writeTextToClipboard(selection);
        term.focus();
        return false;
      }
      if (isMod && key === "v") {
        const clipboard = navigator.clipboard;
        // In a non-secure context readText does not exist, so pass through and let
        // the native paste event path (macOS Cmd+V / Chromium Ctrl+Shift+V) be
        // the only remaining paste channel.
        if (!clipboard?.readText) return true;
        event.preventDefault();
        void clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      return true;
    });
    // WebGL renderer: with multiple panes rendering at once, the DOM renderer's
    // main-thread pressure adds up linearly, while WebGL uses the GPU. Fall
    // back to the default renderer if context creation fails (WebGL2
    // unavailable) or the context is lost at runtime.
    let webglAddon: WebglAddon | null = null;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (webglAddon === addon) webglAddon = null;
      });
      term.loadAddon(addon);
      webglAddon = addon;
    } catch {
      webglAddon = null;
    }
    let touchScrollActive = false;
    let touchScrollCancelled = false;
    let lastTouchX = 0;
    let lastTouchY = 0;
    let touchScrollRemainder = 0;

    const reportError = (message: string | null) => {
      onErrorRef.current(sessionRef.current.id, message);
    };

    const focusTerminal = () => {
      if (disposed || !sessionRef.current.running) return;
      term.focus();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      focusTerminal();
    };

    let ptyResizeTimer: number | null = null;
    let lastVisualFitAt = 0;

    // Visual fit: only re-layouts the xterm grid (term.cols/rows update
    // accordingly) and does not touch the backend.
    const fitVisual = () => {
      if (disposed) return;
      if (!terminalContainerHasSize(container)) return;
      lastVisualFitAt = Date.now();
      try {
        fit.fit();
      } catch {
        // xterm fit can throw while the panel is hidden or measuring at zero size.
      }
    };

    // PTY resize commit: trailing-edge debounce, always committing the final
    // value once the size stabilizes (streamBuffer internally coalesces for
    // another 16ms, so with both layers the backend only receives stable sizes
    // during a drag).
    const schedulePtyResizeCommit = () => {
      if (ptyResizeTimer !== null) {
        window.clearTimeout(ptyResizeTimer);
      }
      ptyResizeTimer = window.setTimeout(() => {
        ptyResizeTimer = null;
        if (disposed) return;
        streamHandle?.resize(term.cols, term.rows);
      }, PTY_RESIZE_DEBOUNCE_MS);
    };

    const fitAndResize = () => {
      if (disposed) return;
      if (!terminalContainerHasSize(container)) return;
      fitVisual();
      schedulePtyResizeCommit();
    };
    fitAndResizeRef.current = fitAndResize;

    const handleCodeFontFamilyChange = (event: Event) => {
      const codeFontFamily = (event as CustomEvent<string>).detail;
      if (typeof codeFontFamily !== "string") return;
      term.options.fontFamily = codeFontFamily;
      window.setTimeout(fitAndResize, 0);
    };
    window.addEventListener(CODE_FONT_FAMILY_CHANGE_EVENT, handleCodeFontFamilyChange);

    const resizeObserver = new ResizeObserver(() => {
      // Periodically do a visual fit during the drag to stay responsive (throttled
      // by FIT_THROTTLE_MS)...
      if (Date.now() - lastVisualFitAt >= FIT_THROTTLE_MS) {
        fitVisual();
      }
      // ...and on the trailing edge do one final fit + PTY resize commit so the
      // final size always takes effect.
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(fitAndResize, 40);
    });
    resizeObserver.observe(container);
    window.setTimeout(fitAndResize, 0);

    const applyStdinState = () => {
      term.options.disableStdin = !sessionRef.current.running || inputPausedByStream;
    };

    const applyInputState = (state: TerminalStreamInputState) => {
      inputPausedByStream = state.paused;
      applyStdinState();
      if (state.paused) {
        inputBackpressureMessageActive = true;
        reportError(terminalInputPausedMessage(state));
      } else if (inputBackpressureMessageActive) {
        inputBackpressureMessageActive = false;
        reportError(null);
      }
    };

    const dataDisposable = term.onData((data) => {
      if (!streamHandle || term.options.disableStdin) return;
      const accepted = streamHandle.write(encoder.encode(data));
      if (!accepted && !inputPausedByStream) {
        applyInputState({
          paused: true,
          queuedBytes: 0,
          highWaterBytes: 256 * 1024,
          reason: "slow",
        });
      }
    });

    const getTouchScrollRowHeight = () =>
      Math.max(8, Math.floor(container.clientHeight / Math.max(1, term.rows)));

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        touchScrollCancelled = true;
        touchScrollActive = false;
        touchScrollRemainder = 0;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      touchScrollCancelled = false;
      touchScrollActive = false;
      touchScrollRemainder = 0;
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (touchScrollCancelled || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;

      const deltaX = touch.clientX - lastTouchX;
      const deltaY = touch.clientY - lastTouchY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (!touchScrollActive) {
        if (absX > absY && absX > 8) {
          touchScrollCancelled = true;
          return;
        }
        if (absY < 8) return;
        touchScrollActive = true;
      }

      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
      touchScrollRemainder += -deltaY;
      const rowHeight = getTouchScrollRowHeight();
      const rows = Math.trunc(touchScrollRemainder / rowHeight);
      if (rows !== 0) {
        term.scrollLines(rows);
        touchScrollRemainder -= rows * rowHeight;
      }
      event.preventDefault();
    };

    const resetTouchScroll = () => {
      touchScrollActive = false;
      touchScrollCancelled = false;
      touchScrollRemainder = 0;
    };

    const handleTouchEnd = () => {
      const shouldFocus = !touchScrollActive && !touchScrollCancelled;
      resetTouchScroll();
      if (shouldFocus) {
        focusTerminal();
      }
    };

    const handleTouchCancel = () => {
      resetTouchScroll();
    };

    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", handleTouchCancel);

    const snapshotBytes = (snapshot: TerminalSnapshot) => {
      if (snapshot.outputBytes) return snapshot.outputBytes;
      return encoder.encode(snapshot.output);
    };

    const writeChunk = (chunk: TerminalStreamChunk) => {
      const result = writeTerminalChunk(
        term,
        chunk,
        (nextOffset) => {
          lastOutputOffset = nextOffset;
        },
        lastOutputOffset,
      );
      if (result !== "skipped") {
        renderedOutput = true;
      }
    };

    const applySnapshot = (snapshot: TerminalSnapshot) => {
      const bytes = snapshotBytes(snapshot);
      const startOffset = terminalSnapshotStartOffset(snapshot);
      const endOffset = terminalSnapshotEndOffset(snapshot);
      if (!renderedOutput) {
        if (bytes.byteLength > 0) {
          term.write(bytes);
          renderedOutput = true;
        }
        lastOutputOffset = endOffset;
      } else if (startOffset > lastOutputOffset || snapshot.truncated) {
        // The snapshot no longer lines up with what is already on screen
        // (output was dropped while detached, or the agent ring truncated):
        // replay from scratch instead of appending duplicated/garbled bytes.
        term.reset();
        if (bytes.byteLength > 0) {
          term.write(bytes);
        }
        lastOutputOffset = endOffset;
      } else if (endOffset > lastOutputOffset) {
        const alreadyWritten = lastOutputOffset - startOffset;
        const pending = alreadyWritten > 0 ? bytes.subarray(alreadyWritten) : bytes;
        if (pending.byteLength > 0) {
          term.write(pending);
        }
        lastOutputOffset = endOffset;
      }
      snapshotLoaded = true;
      loadingSnapshot = false;
      applyStdinState();
      replayBufferedChunks();
      window.setTimeout(fitAndResize, 0);
    };

    const replayBufferedChunks = () => {
      const chunks = bufferedChunks.splice(0);
      for (const chunk of chunks) {
        writeChunk(chunk);
      }
    };

    const clearSnapshotRetryTimer = () => {
      if (snapshotRetryTimer !== null) {
        window.clearTimeout(snapshotRetryTimer);
        snapshotRetryTimer = null;
      }
    };

    const scheduleSnapshotRetry = () => {
      if (disposed || streamHandle || snapshotRetryTimer !== null) return;
      const delay = snapshotRetryDelayMs;
      snapshotRetryDelayMs = Math.min(snapshotRetryDelayMs * 2, SNAPSHOT_ATTACH_RETRY_MAX_MS);
      snapshotRetryTimer = window.setTimeout(() => {
        snapshotRetryTimer = null;
        loadSnapshot();
      }, delay);
    };

    const loadSnapshot = () => {
      if (disposed || loadingSnapshot) return;
      loadingSnapshot = true;
      const s = sessionRef.current;
      void client.stream
        .attach(s)
        .then((handle) => {
          if (disposed) {
            handle.dispose();
            return;
          }
          streamHandle = handle;
          clearSnapshotRetryTimer();
          snapshotRetryDelayMs = SNAPSHOT_ATTACH_RETRY_MIN_MS;
          reportError(null);
          streamOutputUnsubscribe = handle.subscribeOutput((chunk) => {
            if (disposed || chunk.sessionId !== sessionRef.current.id) return;
            if (snapshotLoaded && !loadingSnapshot) {
              writeChunk(chunk);
            } else {
              bufferedChunks.push(chunk);
            }
          });
          streamInputUnsubscribe = handle.subscribeInputState((state) => {
            if (disposed) return;
            applyInputState(state);
          });
          const snapshot: TerminalSnapshot = {
            session: handle.snapshot.session,
            output: "",
            outputBytes: handle.snapshot.bytes,
            truncated: handle.snapshot.truncated,
            outputStartOffset: handle.snapshot.outputStartOffset,
            outputEndOffset: handle.snapshot.outputEndOffset,
          };
          const initial = initialSnapshotRef.current;
          if (initial?.session.id === sessionRef.current.id) {
            initialSnapshotRef.current = undefined;
            onInitialSnapshotConsumedRef.current?.(initial.session.id);
          }
          applySnapshot(snapshot);
        })
        .catch((error) => {
          loadingSnapshot = false;
          if (!disposed) {
            reportError(error instanceof Error ? error.message : String(error));
            snapshotLoaded = false;
            applyStdinState();
            scheduleSnapshotRetry();
          }
        });
    };

    let streamOutputUnsubscribe: (() => void) | null = null;
    let streamInputUnsubscribe: (() => void) | null = null;
    const unsubscribe = client.subscribe((event) => {
      if (disposed || event.sessionId !== session.id) return;
      if (event.kind === "exit" || event.kind === "closed" || event.kind === "reconnecting") {
        term.options.disableStdin = true;
      }
      if (event.kind === "reconnected") {
        applyStdinState();
        window.setTimeout(fitAndResize, 0);
      }
    });

    // Offline-first: paint the cached snapshot immediately so the terminal has
    // content while attach is pending or retrying; a successful attach then
    // trims by offset (or resets on gap/truncation). The snapshot is only
    // consumed — and its owner notified — once attach succeeds.
    const initial = initialSnapshotRef.current;
    if (initial && initial.session.id === sessionRef.current.id) {
      applySnapshot(initial);
    }

    loadSnapshot();

    return () => {
      disposed = true;
      termRef.current = null;
      fitAndResizeRef.current = null;
      unsubscribe();
      dataDisposable.dispose();
      resizeObserver.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (ptyResizeTimer !== null) {
        window.clearTimeout(ptyResizeTimer);
        ptyResizeTimer = null;
      }
      clearSnapshotRetryTimer();
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchCancel);
      streamOutputUnsubscribe?.();
      streamInputUnsubscribe?.();
      streamHandle?.dispose();
      // Release the WebGL context before destroying the terminal to avoid dispose
      // ordering issues.
      try {
        webglAddon?.dispose();
      } catch {
        // When the context is already lost, dispose may throw; ignore it.
      }
      webglAddon = null;
      term.dispose();
      window.removeEventListener(CODE_FONT_FAMILY_CHANGE_EVENT, handleCodeFontFamilyChange);
    };
  }, [client, session.id, session.projectPathKey]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the xterm viewport is a pointer drop target; keyboard users paste or use the file-tree context menu.
    <div
      ref={dropTargetRef}
      style={viewportStyle}
      className={cn(
        "project-terminal-viewport relative h-full min-h-0 w-full overflow-hidden",
        className,
      )}
      data-workspace-path-drop-zone={workspacePathDropState ?? "idle"}
      onDragEnter={handleWorkspacePathDragOver}
      onDragOver={handleWorkspacePathDragOver}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setWorkspacePathDropState(null);
      }}
      onDrop={handleWorkspacePathDrop}
    >
      <div ref={containerRef} className="h-full min-h-0 w-full" />
      {workspacePathDropState ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed bg-background/90 text-xs font-medium backdrop-blur-sm",
            workspacePathDropState === "accept"
              ? "border-emerald-500/70 text-emerald-600 dark:text-emerald-300"
              : "border-destructive/60 text-destructive",
          )}
        >
          {workspacePathDropState === "accept"
            ? t("projectTools.workspacePathDrop.insert")
            : session.kind === "ssh"
              ? t("projectTools.workspacePathDrop.sshBlocked")
              : t("projectTools.workspacePathDrop.crossProject")}
        </div>
      ) : null}
    </div>
  );
}

function terminalInputPausedMessage(state: TerminalStreamInputState) {
  if (state.reason === "offline") {
    return "The terminal connection is recovering; input is paused to avoid stale keystrokes.";
  }
  if (state.reason === "closed") {
    return "Terminal input is closed.";
  }
  return "The terminal connection is slow; input is paused to avoid an oversized input queue.";
}

function terminalSnapshotStartOffset(snapshot: TerminalSnapshot) {
  if (
    typeof snapshot.outputStartOffset === "number" &&
    Number.isFinite(snapshot.outputStartOffset) &&
    snapshot.outputStartOffset >= 0
  ) {
    return snapshot.outputStartOffset;
  }
  return 0;
}

function terminalSnapshotEndOffset(snapshot: TerminalSnapshot) {
  if (
    typeof snapshot.outputEndOffset === "number" &&
    Number.isFinite(snapshot.outputEndOffset) &&
    snapshot.outputEndOffset >= 0
  ) {
    return snapshot.outputEndOffset;
  }
  return (
    terminalSnapshotStartOffset(snapshot) +
    (snapshot.outputBytes?.byteLength ?? new TextEncoder().encode(snapshot.output).byteLength)
  );
}

// Exported for tests: offset bookkeeping for live terminal chunks, including
// the reconnect-gap reset path.
export function writeTerminalChunk(
  term: Pick<XTerm, "write" | "reset">,
  chunk: TerminalStreamChunk,
  setLastOutputOffset: (offset: number) => void,
  lastOutputOffset: number,
): "written" | "skipped" | "reset" {
  const data = chunk.bytes;
  if (data.byteLength === 0) return "skipped";
  const startOffset = chunk.startOffset;
  const endOffset = chunk.endOffset;
  if (
    typeof startOffset === "number" &&
    Number.isFinite(startOffset) &&
    typeof endOffset === "number" &&
    Number.isFinite(endOffset) &&
    endOffset >= startOffset
  ) {
    if (endOffset <= lastOutputOffset) return "skipped";
    if (startOffset > lastOutputOffset) {
      // A hole in the byte stream: the transport replayed a snapshot after a
      // reconnect (the stream client injects the full buffered content as one
      // chunk) or the agent ring dropped bytes. Appending would duplicate or
      // garble the screen, so redraw from the authoritative chunk instead.
      term.reset();
      term.write(data);
      setLastOutputOffset(endOffset);
      return "reset";
    }
    const alreadyWritten = lastOutputOffset - startOffset;
    term.write(alreadyWritten > 0 ? data.subarray(alreadyWritten) : data);
    setLastOutputOffset(endOffset);
    return "written";
  }
  term.write(data);
  setLastOutputOffset(lastOutputOffset + data.byteLength);
  return "written";
}
