import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Regression guard: xterm 6's css.toColor does not support the keyword "transparent"
// (the canvas fallback path throws outright for alpha<255), so any "transparent" in a
// theme silently falls back to the default color #ffffff. The overview ruler draws a
// 1px vertical line each frame with overviewRulerBorder, and after falling back to
// white it becomes a white line along the terminal's right edge (visible to the naked
// eye in dark themes). Transparency must be written as 8-digit hex (the #RRGGBBAA
// branch does not validate alpha).

const source = readFileSync(
  new URL("../../../agent-ui/src/components/project-tools/XTermViewport.tsx", import.meta.url),
  "utf8",
);

test("xterm theme never uses the 'transparent' keyword", () => {
  assert.equal(
    source.includes(': "transparent"'),
    false,
    "xterm css.toColor throws on non-opaque colors and falls back to #ffffff — use #RRGGBBAA",
  );
});

test("overview ruler border stays fully transparent via 8-digit hex", () => {
  const hits = source.match(/overviewRulerBorder: "#00000000"/g) ?? [];
  assert.equal(hits.length, 2, "both dark and light themes must zero out the ruler border");
});
