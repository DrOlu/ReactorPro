// Local UI preference: preserved across sessions and restarts, not synced with remote Agent settings.
const STORAGE_KEY = "liveagent:skip-external-link-confirmation:v1";
let skipForSession = false;

export function shouldSkipExternalLinkConfirmation(): boolean {
  try {
    return skipForSession || globalThis.localStorage?.getItem(STORAGE_KEY) === "true";
  } catch {
    return skipForSession;
  }
}

export function rememberExternalLinkConfirmation(): void {
  skipForSession = true;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, "true");
  } catch {
    // Links still open when storage is unavailable; the preference degrades to being effective for this run only.
  }
}
