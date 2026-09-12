# Width handles stop working after opening a historical conversation (#749)

## Symptoms

Issue #749: on desktop, when the left conversation sidebar is expanded, opening a historical conversation from recent conversations makes the transcript's left/right boundary hover and drag unresponsive; collapsing the left sidebar restores the handle. The report is missing two pieces of runtime data: the conversation Pane's actual width at the time of failure, and whether the history loading overlay is still in the DOM.

## Branch

Branch: `fix/transcript-width-controls-after-history-switch`, baseline `main@be86449f` (v1.3.1). The changes are concentrated in the shared width handle component and its two integration points; the state machine for opening conversations was not touched.

## Source conclusions

Both branches can produce the same symptom, and both have been confirmed at the source level:

1. Overlay branch. `HistorySwitchLoadingOverlay` is `absolute inset-0 z-30`, does not pass pointer events through, and is placed in the DOM after the `z-10` `TranscriptWidthControls`. While the overlay is mounted, the handle can never be hit. WebUI's `.gateway-history-switch-overlay` (`--layer-panel` = 20) and the handle (10) have the same structure. The overlay itself is an opaque `bg-background` skeleton screen; if it stayed mounted, the user would see the skeleton rather than the transcript, so it explains "cannot click while the overlay is visible" but not the persistent failure after the overlay disappears.
2. Threshold branch. `resolveStageMaxWidth` first subtracts a 64px safe gutter with a floor of 560, and `areWidthControlsUsable` is true only when the upper bound is greater than 560, so when the host is ≤ 624px the component returns `null` and there is no trace in the DOM. "2560 × 1528 maximized" is very likely the physical size: a 2560×1600 panel under Windows 150% / 200% scaling has a CSS viewport of only 1707 / 1280px, and after subtracting a 272px sidebar and a right dock (320–720px) or split screen, the conversation Pane lands right around the 624 threshold. Collapsing the sidebar adds back 272px and crosses the threshold, matching "restored after collapsing."

No path was found where `maxWidth` gets stuck at an old value: the ResizeObserver is attached to the stable transcript root; switching historical conversations does not remount `ChatTranscript` (only `TranscriptList` remounts by conversation key); the CSS variable has only one owner; and `controlsHidden` re-reads `matchMedia` on every render.

## Decision

The issue's open question: should the width be adjustable while the overlay is visible. The answer is no. There is no grabbable boundary beneath an opaque skeleton, and a focusable `role="separator"` should not be hidden under an intercepting layer either. Therefore, rather than raising the handle's z-index, the handle is suspended while the overlay is mounted, and the handle is required to return in the same commit in which the overlay leaves.

## Changes

- `crates/agent-ui/src/lib/transcript-width/transcriptWidthModel.ts`: added `resolveTranscriptWidthControlsState`, which reports the gate currently disabling the handle in the order suspended → media-hidden → stage-narrow → ready.
- `crates/agent-ui/src/pages/chat/transcript/TranscriptWidthControls.tsx`:
  - Added a `suspended` prop. When suspended, the handle is not rendered, and an in-progress drag is committed at the current width; the observer keeps running and the CSS variable keeps clamping.
  - On mount and on every reveal, remeasure the host synchronously in a layout effect, so a Pane size change during the overlay still yields the correct upper bound on the restoring frame, no longer relying on an unrelated later layout change to wake the observer.
  - The root node is permanently present in all states, carrying `data-transcript-width-state` and `data-transcript-width-max`; the hidden state uses `hidden` to remove it from layout, hit-testing, and the accessibility tree.
- `crates/agent-gui/src/pages/chat/transcript/ChatTranscript.tsx`: `isTranscriptBusy = isHistorySwitching || isTranscriptSettling`, driving both the overlay and `suspended`.
- `crates/agent-gateway/web/src/app/GatewayAppView.tsx`: both `TranscriptWidthControls` pass `suspended={conversationOpenState.showOverlay}`; a comment was added in `base-chat.css`.
- Tests: `crates/agent-gui/test/chat/transcript-width-controls-history-switch.test.mjs` (jsdom + real react-dom), `crates/agent-gateway/web/test/transcript-width-history-overlay.test.mjs` (static assertions on source and CSS).

## Debug client verification

1. Keep the left sidebar expanded, open a historical conversation from recent conversations, and wait for the skeleton screen to disappear.
2. Open DevTools and run in the Console:

```js
const controls = document.querySelector(".transcript-width-controls");
({
  state: controls?.dataset.transcriptWidthState,
  stageMax: controls?.dataset.transcriptWidthMax,
  hostWidth: controls?.parentElement.getBoundingClientRect().width,
  overlayMounted: !!document.querySelector("[data-pane-loading-skeleton]"),
  separatorMax: document.querySelector('[role="separator"]')?.getAttribute("aria-valuemax"),
  dpr: window.devicePixelRatio,
  viewport: window.innerWidth,
});
```

3. How to read it:
   - `state === "ready"`: the handle is in the DOM. Move the mouse to any height along the transcript column's left/right boundary (the hit area is full height and 17px wide); a col-resize cursor and indicator bar should appear, and it should be draggable.
   - `state === "stage-narrow"`: the host CSS width is ≤ 624px and the handle is hidden by design. Compare against `hostWidth`, `dpr`, the right dock, and split screen; after collapsing the sidebar it should become `ready`.
   - `state === "suspended"` with `overlayMounted` false: the overlay state and handle state are out of sync, which is a new issue; please report it along with `hostWidth`.
   - `state === "media-hidden"`: `(max-width: 820px), (pointer: coarse)` matched; check `viewport` and the primary pointer type.
4. Collapse and expand the left sidebar once more; `state` and `separatorMax` should change only with `hostWidth`.

## Not done

- The 624px threshold and the 64px safe gutter were not lowered. If verification reports `stage-narrow`, that is the established behavior for a narrow Pane, and whether to adjust the threshold is a separate discussion.
- `openController` and the first-screen settle logic were not changed; static analysis found no path where the overlay gets stuck.

## Follow-up adjustment: enlarge the handle trigger area (2026-09-05)

Feedback after the debug client verification passed: the handle's 96px-tall, 12px-wide hit area is too small and hard to trigger. As requested, the transparent hit area was changed to full height, with width from 12px → 17px (`inset-y-0` + `w-[17px]`, structurally identical to the two full-height col-resize handles `DetailsResizeHandle` and `RightDockPanel`). The visible small vertical bar's appearance and the hover/drag highlight spec are unchanged; only the hit area grew.

Cost: a roughly 8.5px full-height strip at each of the transcript column's left and right edges is taken over by the handle for pointer events, so text selection starting from the outermost pixels is blocked—an inherent trade-off of a full-height hit area. The tests in `measurements-lru.test.mjs` that originally locked in "localized hit area" were inverted to lock in full height + 17px.