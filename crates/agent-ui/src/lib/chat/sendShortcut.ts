/** The send key is a local input preference, read only in the message composer and not registered as a system shortcut. */
export type SendShortcut = "enter" | "ctrlEnter";
export const SEND_SHORTCUT_STORAGE_KEY = "liveagent.sendShortcut.v1";

export function readSendShortcut(): SendShortcut {
  try {
    return window.localStorage.getItem(SEND_SHORTCUT_STORAGE_KEY) === "ctrlEnter"
      ? "ctrlEnter"
      : "enter";
  } catch {
    return "enter";
  }
}

export function writeSendShortcut(shortcut: SendShortcut): void {
  window.localStorage.setItem(SEND_SHORTCUT_STORAGE_KEY, shortcut);
}

export function shouldSendOnEnter(
  event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  shortcut: SendShortcut,
): boolean {
  if (event.shiftKey || event.altKey) return false;
  return shortcut === "enter" || event.ctrlKey || event.metaKey;
}
