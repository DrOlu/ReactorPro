import { invoke } from "@tauri-apps/api/core";
import { wasBrowserKeyDefaultBlocked } from "../system/webviewNavigationGuard";

/**
 * Desktop shortcuts: system-global registration and in-app-only keyboard listening share the same
 * bindings. Bindings are stored only in the local localStorage -- shortcuts are device preferences
 * and do not enter settings sync/gateway.
 * Accelerators use the form `Ctrl+Shift+KeyA`: modifiers are Ctrl/Shift/Alt/Super, and the main key
 * uses the W3C KeyboardEvent.code name, naturally consistent between both ends (frontend recording &
 * Rust global_hotkey parsing).
 */

export type GlobalShortcutAction = "summon" | "toggle" | "newChat" | "searchConversations" | "pin";

export const GLOBAL_SHORTCUT_ACTIONS: readonly GlobalShortcutAction[] = [
  "summon",
  "toggle",
  "newChat",
  "pin",
  "searchConversations",
];

export type ShortcutScope = "global" | "app";

export interface GlobalShortcutBinding {
  /** Defaults to global, compatible with existing local configs. */
  scope?: ShortcutScope;
  accelerator: string;
  enabled: boolean;
}

export type GlobalShortcutBindings = Partial<Record<GlobalShortcutAction, GlobalShortcutBinding>>;

export interface GlobalShortcutFailure {
  action: string;
  accelerator: string;
  error: string;
}

const GLOBAL_SHORTCUT_STORAGE_KEY = "liveagent.globalShortcuts.v1";

export const SHORTCUT_MODIFIER_ORDER = ["Ctrl", "Shift", "Alt", "Super"] as const;
export type ShortcutModifier = (typeof SHORTCUT_MODIFIER_ORDER)[number];

const MODIFIER_SET = new Set<string>(SHORTCUT_MODIFIER_ORDER);

const SHORTCUT_CODE_DISPLAY: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  CapsLock: "Caps",
  Backspace: "⌫",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Insert: "Ins",
  Delete: "Del",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  PrintScreen: "PrtSc",
  ScrollLock: "ScrLk",
  Pause: "Pause",
  ContextMenu: "Menu",
  NumLock: "NumLock",
  NumpadDivide: "Num /",
  NumpadMultiply: "Num *",
  NumpadSubtract: "Num -",
  NumpadAdd: "Num +",
  NumpadDecimal: "Num .",
  Numpad0: "Num 0",
  Numpad1: "Num 1",
  Numpad2: "Num 2",
  Numpad3: "Num 3",
  Numpad4: "Num 4",
  Numpad5: "Num 5",
  Numpad6: "Num 6",
  Numpad7: "Num 7",
  Numpad8: "Num 8",
  Numpad9: "Num 9",
};

const MAC_MODIFIER_DISPLAY: Record<ShortcutModifier, string> = {
  Ctrl: "⌃",
  Shift: "⇧",
  Alt: "⌥",
  Super: "⌘",
};

export function isShortcutModifierToken(token: string): token is ShortcutModifier {
  return MODIFIER_SET.has(token);
}

export function globalShortcutKeyDisplayLabel(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return SHORTCUT_CODE_DISPLAY[code] ?? code;
}

export function globalShortcutDisplayToken(token: string, isMac: boolean): string {
  if (isShortcutModifierToken(token)) {
    if (isMac) return MAC_MODIFIER_DISPLAY[token];
    return token === "Super" ? "Win" : token;
  }
  return globalShortcutKeyDisplayLabel(token);
}

/** KeyboardEvent.code -> modifier token; returns null for non-modifier keys. */
export function modifierFromEventCode(code: string): ShortcutModifier | null {
  switch (code) {
    case "ControlLeft":
    case "ControlRight":
      return "Ctrl";
    case "ShiftLeft":
    case "ShiftRight":
      return "Shift";
    case "AltLeft":
    case "AltRight":
      return "Alt";
    case "MetaLeft":
    case "MetaRight":
      return "Super";
    default:
      return null;
  }
}

export function readGlobalShortcutBindings(): GlobalShortcutBindings {
  try {
    const raw = window.localStorage.getItem(GLOBAL_SHORTCUT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const bindings: GlobalShortcutBindings = {};
    for (const action of GLOBAL_SHORTCUT_ACTIONS) {
      const value = (parsed as Record<string, unknown>)[action];
      // Early versions stored the accelerator as a raw string; on read it is migrated to
      // {accelerator, enabled}.
      if (typeof value === "string" && value.trim()) {
        bindings[action] = { accelerator: value.trim(), enabled: true };
        continue;
      }
      if (value && typeof value === "object") {
        const accelerator = (value as Record<string, unknown>).accelerator;
        const enabled = (value as Record<string, unknown>).enabled;
        if (typeof accelerator === "string" && accelerator.trim()) {
          const scope = (value as Record<string, unknown>).scope;
          bindings[action] = {
            accelerator: accelerator.trim(),
            enabled: enabled !== false,
            ...(scope === "app" || scope === "global" ? { scope } : {}),
          };
        }
      }
    }
    return bindings;
  } catch {
    return {};
  }
}

export function writeGlobalShortcutBindings(bindings: GlobalShortcutBindings): void {
  try {
    window.localStorage.setItem(GLOBAL_SHORTCUT_STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // Silently ignore when localStorage is unavailable (e.g. private mode).
  }
}

/**
 * Applies bindings to the Tauri side (full-replacement registration, registering only enabled
 * bindings). Returns the entries that failed to register; returns an empty array in a non-Tauri
 * environment (pure browser dev).
 */
async function replaceGlobalShortcuts(
  bindings: GlobalShortcutBindings,
): Promise<GlobalShortcutFailure[]> {
  const payload = GLOBAL_SHORTCUT_ACTIONS.flatMap((action) => {
    const binding = bindings[action];
    const accelerator = binding?.accelerator.trim();
    return binding?.enabled && binding.scope !== "app" && accelerator
      ? [{ action, accelerator }]
      : [];
  });
  try {
    const failures = await invoke<GlobalShortcutFailure[]>("app_set_global_shortcuts", {
      bindings: payload,
    });
    return Array.isArray(failures) ? failures : [];
  } catch {
    // Non-Tauri environment or an old desktop shell: ignore.
    return [];
  }
}

// Full replacement must be executed serially, to avoid an old request re-registering system hotkeys
// after a rapid scope switch.
let registrationQueue: Promise<unknown> = Promise.resolve();
export function applyGlobalShortcuts(
  bindings: GlobalShortcutBindings,
): Promise<GlobalShortcutFailure[]> {
  const next = registrationQueue.then(() => replaceGlobalShortcuts(bindings));
  registrationQueue = next.catch(() => {});
  return next;
}

/** Restores locally saved global shortcuts at app startup. */
export async function applyStoredGlobalShortcuts(): Promise<void> {
  const bindings = readGlobalShortcutBindings();
  if (GLOBAL_SHORTCUT_ACTIONS.every((action) => !bindings[action])) return;
  await applyGlobalShortcuts(bindings);
}

let shortcutsSuspended = false;

/** Suspends both system registration and in-app listening during recording. */
export function setShortcutsSuspended(suspended: boolean): void {
  shortcutsSuspended = suspended;
}

export function matchesShortcutEvent(event: KeyboardEvent, accelerator: string): boolean {
  const tokens = accelerator.split("+").map((token) => token.trim());
  const main = tokens.filter((token) => !isShortcutModifierToken(token));
  return (
    main.length === 1 &&
    main[0] === event.code &&
    tokens.includes("Ctrl") === event.ctrlKey &&
    tokens.includes("Shift") === event.shiftKey &&
    tokens.includes("Alt") === event.altKey &&
    tokens.includes("Super") === event.metaKey
  );
}

/** Dispatches app bindings only while the window has focus, without reserving the key combination
 * from the OS. */
export function installAppShortcutListener(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      shortcutsSuspended ||
      (event.defaultPrevented && !wasBrowserKeyDefaultBlocked(event)) ||
      event.isComposing ||
      event.keyCode === 229 ||
      !document.hasFocus()
    )
      return;
    const bindings = readGlobalShortcutBindings();
    const action = GLOBAL_SHORTCUT_ACTIONS.find((action) => {
      const binding = bindings[action];
      return (
        binding?.enabled &&
        binding.scope === "app" &&
        matchesShortcutEvent(event, binding.accelerator)
      );
    });
    if (!action) return;
    // An unmodified character key must not steal text input; modified combinations and function keys
    // remain usable.
    const target = event.target instanceof Element ? event.target : null;
    if (
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') &&
      !/^F\d{1,2}$/.test(event.code)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      void invoke("app_run_shortcut", { action }).catch(() => {});
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
