import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Feedback from web verification: when the transcript is dragged wider on desktop
// the composer follows (the card column in ChatComposerBar's desktop branch reads
// --chat-transcript-content-width directly), but on web it stayed pinned at a fixed
// 768px -- .gateway-composer-layer's grid column previously read a separate
// --gateway-chat-column-width on purpose. Now both sides agree: the composer column
// and the transcript column share the same variable. The composer layer is mounted
// inside .gateway-transcript-stage, so the inline value written on the stage by
// TranscriptWidthControls (including per-frame drag updates) reaches it through CSS
// inheritance. This file locks down that coupling.

const chatStyles = readFileSync(new URL("../src/styles/base-chat.css", import.meta.url), "utf8");
const appViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const paneHostSource = readFileSync(
  new URL("../src/app/workbench/GatewayConversationPaneHost.tsx", import.meta.url),
  "utf8",
);
const composerSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
);

test("composer column and transcript column read the same width variable", () => {
  const layer = chatStyles.match(/\.gateway-composer-layer \{[\s\S]*?\n\}/);
  assert.ok(layer, ".gateway-composer-layer rule exists");
  // Same variable as the transcript shell — that is what this guard is for.
  // The calc() wraps it because both columns give back the retired 40px avatar
  // rail; see measurements-lru.test.mjs for that half of the invariant.
  assert.match(
    layer[0],
    /min\(calc\(var\(--chat-transcript-content-width, 768px\) - 40px\), 100%\)/,
  );
  assert.doesNotMatch(
    chatStyles,
    /--gateway-chat-column-width/,
    "the fixed column-width variable is retired; a second width source must not be reintroduced",
  );
});

test("ChatComposerBar renders inside the stage on both paths so the width variable can be inherited", () => {
  for (const [name, source] of [
    ["GatewayAppView", appViewSource],
    ["GatewayConversationPaneHost", paneHostSource],
  ]) {
    const stageIndex = source.indexOf('className="gateway-transcript-stage"');
    assert.ok(stageIndex >= 0, `${name} should have gateway-transcript-stage`);
    const composerIndex = source.indexOf("<ChatComposerBar", stageIndex);
    assert.ok(composerIndex > stageIndex, `${name}'s ChatComposerBar should be inside the stage section`);
  }
  // Desktop-branch reference: the card column's max-width reads the same variable;
  // web behavior is benchmarked against this.
  assert.match(
    composerSource,
    /max-w-\[calc\(var\(--chat-transcript-content-width,768px\)-4\.75rem\)\]/,
  );
});

test("the solid bottom strip at the layer's base is shared by both sides: it covers the 16px floating gap so text cannot leak below the skirt", () => {
  const start = composerSource.indexOf("ref={composerLayerRef}");
  const end = composerSource.indexOf("ref={composerColumnRef}");
  assert.ok(start > 0 && end > start, "anchors for the composer layer and card column exist");
  const region = composerSource.slice(start, end);
  assert.ok(
    region.includes('className="pointer-events-none absolute inset-x-0 bottom-0 bg-background"'),
    "the layer's base should have a full-width solid strip",
  );
  assert.ok(!region.includes('surface === "desktop" ? ('), "the solid strip must not regress to desktop-only");
});
