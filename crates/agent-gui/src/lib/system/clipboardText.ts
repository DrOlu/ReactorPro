import { invoke } from "@tauri-apps/api/core";

/**
 * The sole clipboard-read entry point for the desktop's custom "Paste" menu item.
 *
 * In WKWebView, navigator.clipboard.readText() only passes silently when the clipboard content was
 * written by this page itself; when the content comes from another app, WebKit shows a native "Paste"
 * confirmation bubble (DOM paste access), so clicking the custom Paste button would pop up another native
 * Paste button. Therefore the Rust side always reads the native clipboard first (bypassing the webview
 * authorization UI), with the webview API only as a fallback when the native read fails (e.g. the Windows
 * clipboard is held exclusively).
 *
 * Return value contract: a string (possibly empty) = read succeeded; null = both channels are unavailable,
 * and the caller may decide whether to fall back to the browser's native paste behavior.
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    return await invoke<string>("system_clipboard_read_text");
  } catch {
    // Fall through to the webview clipboard API.
  }
  try {
    return (await navigator.clipboard?.readText?.()) ?? "";
  } catch {
    return null;
  }
}
