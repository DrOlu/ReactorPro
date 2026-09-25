// Unit test: the neuralOS-facing chat surfaces must keep rhyming with the
// ReactorPro R logo (#ED220C family — the favicon's brand red). If someone
// recolours the user-bubble gradient or the in-focus thread wash away from
// the brand hue, or drops the aria-current hook entirely, this fails.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cssPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/styles/facelift.css",
);
const css = readFileSync(cssPath, "utf8");

describe("brand gradient contract (R logo red)", () => {
  it("user bubbles carry the #ED220C-family gradient in both themes", () => {
    const bubble = css.slice(
      css.indexOf(".chat-user-bubble {"),
      css.indexOf("html.dark .chat-user-bubble"),
    );
    const darkBubble = css.slice(
      css.indexOf("html.dark .chat-user-bubble {"),
      css.indexOf("/* ── The thread in focus"),
    );
    // Brand hue stops: the R logo sits at hue ~4, saturation 85-92%.
    // Light: hsl(4 85% 46%) deep red; dark: hsl(4 90% 52%) lifted for black.
    assert.match(bubble, /hsl\(4 85% 46% \/ 0\.96\)/, "light-mode brand stop missing");
    assert.match(darkBubble, /hsl\(4 90% 52% \/ 0\.96\)/, "dark-mode brand stop missing");
    // Bold style: white text over the saturated gradient (v1.6.7 prominence).
    assert.match(bubble, /color: #fff/);
    assert.match(darkBubble, /color: #fff/);
  });

  it("the in-focus sidebar thread is marked by the brand wash + accent bar", () => {
    assert.match(
      css,
      /\.chat-history-sidebar \.chat-history-row-title-button\[aria-current="page"\]/,
      "active-thread selector missing",
    );
    assert.match(css, /inset 2\.5px 0 0 hsl\(4 85% 48% \/ 0\.85\)/, "light accent bar missing");
    assert.match(css, /inset 2\.5px 0 0 hsl\(6 90% 56% \/ 0\.9\)/, "dark accent bar missing");
  });

  it("targets the create menu globally (dropdowns render in a portal)", () => {
    // Regression: scoping under .project-tools-panel missed the portaled
    // menu — the selector must be global.
    assert.doesNotMatch(css, /\.project-tools-panel \[role="menu"\]/);
    assert.match(css, /\[role="menu\"] \.project-tools-create-item \{/);
  });

  it("keeps the logo hue stops inside the favicon's colour family", () => {
    // favicon.svg fills: #ED220C / #EE220C / #ED0A08 → hue 2-5, sat 87-100%.
    // Gradients must stay within that red-orange family (hue 0-20).
    const hues = [...css.matchAll(/hsl\((\d+) 8[5-9]% 4[4-8]%/g)].map((m) => Number(m[1]));
    for (const hue of hues) {
      assert.ok(hue >= 0 && hue <= 20, `gradient hue ${hue} left the R-logo red family`);
    }
    assert.ok(hues.length > 0, "no brand-hue stops found at all");
  });
});
