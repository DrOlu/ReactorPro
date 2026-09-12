import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Invariant: under a narrow Pane the transcript region degrades with the Pane
// (container), not with the viewport
// (docs/design/session-workbench-pane-architecture.md §22). In a split view a
// 360px Pane on a 2560px window must make the floor navigation and width handles
// behave like a 360px window.
//
// Three gates:
// 1. The desktop transcript root is @container, giving the Pane-internal overlay
//    container queries an anchor point;
// 2. FloorNavRail clamps its expanded panel by cqw (not 100vw) and hides the whole
//    rail in extremely narrow containers;
// 3. The gateway's transcript stage declares container-type so the shared component
//    has consistent semantics on both ends.
// (TranscriptWidthControls needs no container query: its maxWidth is already
//  computed from the transcript root's measured width, and areWidthControlsUsable
//  already hides the handles naturally under a narrow Pane.)

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("desktop transcript root is a container for pane-relative degradation", () => {
  const source = read("../../src/pages/chat/transcript/ChatTranscript.tsx");
  const rootClass = source.match(/ref=\{transcriptRootRef\}[\s\S]{0,400}?className="([^"]+)"/);
  assert.ok(rootClass, "transcript root className not found");
  assert.match(rootClass[1], /(^| )@container( |$)/);
});

test("composer derives its body-aligned width from the live transcript width", () => {
  const surfaceSource = read("../../src/pages/chat/surfaces/ConversationSurface.tsx");
  const paneHostSource = read("../../src/pages/chat/surfaces/ConversationPaneHost.tsx");
  const widthControlsSource = read(
    "../../../agent-ui/src/pages/chat/transcript/TranscriptWidthControls.tsx",
  );
  const composerSource = read("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx");

  assert.match(surfaceSource, /data-chat-width-owner=""/);
  assert.match(surfaceSource, /\[CHAT_TRANSCRIPT_WIDTH_CSS_VAR\]: `\$\{contentWidth\}px`/);
  assert.match(paneHostSource, /contentWidth=\{transcript\.contentWidth\}/);
  assert.match(widthControlsSource, /closest<HTMLElement>\("\[data-chat-width-owner\]"\)/);
  assert.match(
    composerSource,
    /max-w-\[calc\(var\(--chat-transcript-content-width,768px\)-4\.75rem\)\]/,
  );
  assert.match(composerSource, /w-\[calc\(100%-2\.25rem\)\]/);
  // With the avatar column retired, the input box no longer needs a compensating
  // right shift: that shift used to offset the asymmetry from the body being
  // squeezed by a 28px avatar + 12px gap, and the body is now centered by itself.
  assert.doesNotMatch(composerSource, /translate-x-\[18px\]/);
});

test("width handles sit on the transcript column, not on the unreduced variable", () => {
  const transcriptSource = read("../../src/pages/chat/transcript/ChatTranscript.tsx");
  const widthControlsSource = read(
    "../../../agent-ui/src/pages/chat/transcript/TranscriptWidthControls.tsx",
  );
  // The body column subtracts the retired 40px avatar rail from the variable; the
  // handle track must subtract the same amount, or the handles on both sides hang
  // 20px outside the body column and the drag reading is 40 larger than the actual
  // column width.
  assert.match(
    transcriptSource,
    /max-w-\[calc\(var\(--chat-transcript-content-width,768px\)-2\.5rem\)\]/,
  );
  assert.match(widthControlsSource, /const RETIRED_AVATAR_RAIL_PX = 40;/);
  assert.match(
    widthControlsSource,
    /width: `calc\(var\(\$\{CHAT_TRANSCRIPT_WIDTH_CSS_VAR\}, \$\{DEFAULT_CHAT_TRANSCRIPT_WIDTH\}px\) - \$\{RETIRED_AVATAR_RAIL_PX\}px\)`/,
  );
});

test("FloorNavRail clamps its panel to the container, not the viewport", () => {
  const source = read("../../../agent-ui/src/pages/chat/transcript/FloorNavRail.tsx");
  assert.match(source, /max-w-\[calc\(100cqw-2rem\)\]/);
  assert.equal(
    source.includes("max-w-[calc(100vw"),
    false,
    "viewport-based clamp must not return",
  );
  // Extremely narrow Panes hide the whole rail rather than pressing the marker column onto the body.
  assert.match(source, /@max-\[280px\]:hidden/);
});

test("gateway transcript stage declares containment for the shared rail", () => {
  const source = read("../../../agent-gateway/web/src/styles/base-chat.css");
  const stageRule = source.match(/\.gateway-transcript-stage \{[\s\S]*?\}/);
  assert.ok(stageRule, ".gateway-transcript-stage rule not found");
  assert.match(stageRule[0], /container-type: inline-size/);
});
