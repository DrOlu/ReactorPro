import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Regression guard: #355 -- the gateway web terminal (Local/SSH Pane) reuses agent-ui's
// XTermViewport, and the behavioral constraints on copy/paste shortcuts match the GUI side:
// Ctrl+Shift+C / Cmd+C write the selection to the clipboard, Ctrl+Shift+V / Cmd+V inject it via
// term.paste, and the matching branches must call preventDefault (in a browser environment the
// native paste event genuinely exists, and failing to intercept it would paste twice); in an
// insecure context (direct http) the fallback paths must remain reachable.

const source = readFileSync(
  new URL("../../../agent-ui/src/components/project-tools/XTermViewport.tsx", import.meta.url),
  "utf8",
);

test("XTermViewport wires attachCustomKeyEventHandler for copy/paste", () => {
  assert.match(
    source,
    /term\.attachCustomKeyEventHandler\(/,
    "xterm does not automatically intercept copy/paste shortcuts; custom keyboard handling must be attached explicitly",
  );
});

test("copy and paste shortcuts cover ctrl+shift and meta modifiers", () => {
  assert.match(
    source,
    /writeTextToClipboard\(selection\)/,
    "On a Ctrl+Shift+C / Cmd+C match, the selection must be written to the clipboard",
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
  assert.match(
    source,
    /term\.paste\(/,
    "Clipboard text must be injected via term.paste to ensure bracketed paste wrapping is correct",
  );
});

test("intercepted shortcuts call preventDefault to suppress native copy/paste", () => {
  // attachCustomKeyEventHandler returning false only skips xterm's own handling; it does not
  // cancel the browser default behavior. Chromium's Ctrl+Shift+V and macOS's Cmd+V separately
  // dispatch a native paste event (xterm has a native listener on the textarea), so without
  // preventDefault the same keypress pastes twice.
  assert.match(
    source,
    /event\.preventDefault\(\)/,
    "A matching copy/paste branch must call preventDefault, otherwise the native paste event causes a double paste",
  );
});

test("clipboard fallbacks stay reachable in insecure contexts", () => {
  // When http connects directly to gateway web, navigator.clipboard does not exist at all: copy
  // must fall back to execCommand (rather than only hanging off writeText's catch), and paste must
  // let the keypress through so the native paste event path serves as the fallback (rather than
  // swallowing the keypress).
  assert.match(
    source,
    /fallbackCopyTextToClipboard\(text\)/,
    "When the clipboard API is missing, copy must go through the execCommand fallback",
  );
  assert.match(
    source,
    /if\s*\(!clipboard\?\.readText\)\s*return true;/,
    "When readText is unavailable, the keypress must be let through so the native paste event becomes the fallback paste channel",
  );
});
