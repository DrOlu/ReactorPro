import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// WebUI-side sync for #749: `.gateway-history-switch-overlay` sits above the shared
// width handle (z-10) at --layer-panel (20). Rather than changing the layer here,
// GatewayAppView suspends the handle while the overlay is mounted, and restores it in
// the same commit that the overlay leaves. This file locks down that pairing.

const appViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const overlaySource = readFileSync(
  new URL("../src/app/HistorySwitchLoadingOverlay.tsx", import.meta.url),
  "utf8",
);
const chatStyles = readFileSync(new URL("../src/styles/base-chat.css", import.meta.url), "utf8");
const controlsSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/transcript/TranscriptWidthControls.tsx", import.meta.url),
  "utf8",
);

test("web suspends the width handles for exactly as long as the history overlay is mounted", () => {
  const usages = appViewSource.match(/<TranscriptWidthControls[\s\S]*?\/>/g) ?? [];
  assert.equal(usages.length, 2, "workbench pane host and legacy stage both mount the controls");
  for (const usage of usages) {
    assert.match(usage, /suspended=\{conversationOpenState\.showOverlay\}/);
  }
  const overlayMounts =
    appViewSource.match(/conversationOpenState\.showOverlay \? \(\s*<HistorySwitchLoadingOverlay/g) ??
    [];
  assert.equal(overlayMounts.length, 2, "the overlay is gated by the same state in both paths");
});

test("web history overlay stays a blocking panel layer above the handles", () => {
  assert.match(
    chatStyles,
    /\.gateway-history-switch-overlay \{[^}]*z-index: var\(--layer-panel\);/,
  );
  assert.doesNotMatch(overlaySource, /pointer-events-none/);
  assert.match(
    controlsSource,
    /"transcript-width-controls pointer-events-none absolute inset-y-0 left-1\/2 z-10/,
  );
});

test("the shared controls keep a readable root while hidden", () => {
  assert.match(controlsSource, /data-transcript-width-state=\{controlsState\}/);
  assert.match(controlsSource, /hidden=\{!handlesVisible\}/);
  assert.match(controlsSource, /suspended\?: boolean;/);
});
