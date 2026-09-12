import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Regression guard: #355 -- after selecting content in the terminal, Ctrl+Shift+C (Linux/Windows)
// and Cmd+C (macOS) must write the selection to the clipboard (xterm's key map does not handle
// these two combos at all, so by default nothing happens). Likewise Cmd+V / Ctrl+Shift+V go
// through the clipboard read path, and the matching branch must call preventDefault, otherwise the
// browser's native paste event causes a double paste.

const source = readFileSync(
  new URL("../../../agent-ui/src/components/project-tools/XTermViewport.tsx", import.meta.url),
  "utf8",
);

test("XTermViewport wires attachCustomKeyEventHandler for copy/paste", () => {
  assert.match(
    source,
    /term\.attachCustomKeyEventHandler\(/,
    "xterm does not intercept copy/paste shortcuts automatically; a custom key handler must be attached explicitly",
  );
});

test("Ctrl+Shift+C and Cmd+C both route selection to the clipboard", () => {
  // The combination of term.getSelection() + writeTextToClipboard must appear, recognizing both
  // the ctrl+shift and meta (macOS Cmd) modifier combos.
  assert.match(
    source,
    /term\.getSelection\(\)/,
    "xterm's selection API must be used to read the selected content",
  );
  assert.match(
    source,
    /writeTextToClipboard\(selection\)/,
    "Ctrl+Shift+C / Cmd+C must write the selection to the clipboard when matched",
  );
  assert.match(
    source,
    /event\.ctrlKey\s*&&\s*event\.shiftKey/,
    "The Ctrl+Shift modifier branch must exist, otherwise Linux/Windows users have no path",
  );
  assert.match(
    source,
    /event\.metaKey/,
    "The Cmd modifier branch must exist, otherwise macOS users have no path",
  );
});

test("Ctrl+Shift+V and Cmd+V both read from the clipboard", () => {
  assert.match(
    source,
    /clipboard\.readText/,
    "Paste must read text from the clipboard, not rely on the PTY's bracketed paste event",
  );
  assert.match(
    source,
    /term\.paste\(/,
    "Clipboard text must be injected via term.paste, ensuring correct bracketed paste wrapping",
  );
});

test("intercepted shortcuts call preventDefault to suppress native copy/paste", () => {
  // attachCustomKeyEventHandler returning false only skips xterm's own handling; it does not
  // cancel the browser's default behavior: Chromium's Ctrl+Shift+V and macOS's Cmd+V dispatch a
  // separate native paste event (xterm has a native listener on the textarea), so without
  // preventDefault the same keypress pastes twice.
  assert.match(
    source,
    /event\.preventDefault\(\)/,
    "A matched copy/paste branch must preventDefault, otherwise the native paste event causes a double paste",
  );
});

test("clipboard fallbacks stay reachable in insecure contexts", () => {
  // When connecting directly to gateway web over http, navigator.clipboard does not exist at all:
  // copy must fall back to execCommand (not merely hang off writeText's catch), and paste must let
  // the keypress through so the native paste event path serves as the fallback (rather than
  // swallowing the keypress).
  assert.match(
    source,
    /fallbackCopyTextToClipboard\(text\)/,
    "Copy must fall back to execCommand when the clipboard API is missing",
  );
  assert.match(
    source,
    /if\s*\(!clipboard\?\.readText\)\s*return true;/,
    "When readText is unavailable, the keypress must be allowed through so the native paste event becomes the fallback paste path",
  );
});
