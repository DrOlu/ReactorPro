import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const UI = "../../../agent-ui/src/components/ui/";

test("dialogs publish their font-scale zone and portaled popups pick it up", () => {
  // --zone-font-scale is a CSS custom property that breaks at the portal boundary: a Select/Dropdown opened inside a dialog
  // renders under body and falls back to 1.0, while the trigger is drawn at the dialog's 0.9.
  // React context can cross the portal: the dialog publishes the scale via context, and the popover Positioner writes it
  // back to an inline variable, with .layer-popover responsible for re-declaring the font-size variable from it.
  for (const file of ["dialog.tsx", "alert-dialog.tsx"]) {
    const source = read(UI + file);
    assert.match(source, /resolveZoneFontScale\(style, (ALERT_)?DIALOG_FONT_SCALE\)/, file);
    assert.match(source, /<ZoneFontScaleContext\.Provider value=\{zoneFontScale\}>/, file);
  }
  for (const file of ["select.tsx", "dropdown-menu.tsx", "popover.tsx", "tooltip.tsx"]) {
    const source = read(UI + file);
    const positioners = source.match(/className="layer-popover( isolate)?"/g) ?? [];
    const zoned = source.match(/className="layer-popover( isolate)?"\s+style=\{zoneStyle\}/g) ?? [];
    assert.ok(positioners.length > 0, `${file} has a popover positioner`);
    assert.equal(zoned.length, positioners.length, `${file}: every positioner carries the zone`);
  }
  const css = read("../../../agent-ui/src/styles/common-components.css");
  assert.match(css, /\.zone-font-scale,\n\s*\.layer-popover \{/);
});

test("scroll-fade hides the native scrollbar only where the fade is applied", () => {
  const css = read("../../../agent-ui/src/styles/base.css");
  const block = css.match(/@utility scroll-fade \{[\s\S]*?\n\}\n/);
  assert.ok(block, "scroll-fade utility exists");
  const supports = block[0].match(
    /@supports \(animation-timeline: scroll\(self y\)\) \{[\s\S]*?\n  \}/,
  );
  assert.ok(supports, "@supports block exists");
  // An engine without scroll-driven animation should neither fade nor hide the scrollbar, otherwise overflow gives no indication at all.
  assert.match(supports[0], /scrollbar-width: none;/);
  assert.doesNotMatch(block[0].replace(supports[0], ""), /scrollbar-width: none;/);
  assert.doesNotMatch(css, /@utility no-scrollbar/);

  const sidebar = read("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx");
  assert.doesNotMatch(sidebar, /no-scrollbar/);
  assert.ok((sidebar.match(/\bscroll-fade\b/g) ?? []).length >= 2);
});
