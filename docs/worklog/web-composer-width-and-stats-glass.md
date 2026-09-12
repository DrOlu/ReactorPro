# WebUI verification feedback: composer width does not follow, context usage readout is show-through

## Background

Verification of the #749 fix (the `fix/transcript-width-controls-after-history-switch` branch) on the web side surfaced two new issues:

1. When dragging the transcript width handle, only the transcript column widens; the composer stays at 768px, whereas on desktop the two move together.
2. When the transcript scrolls below the input area, the conversation stats readout at the bottom edge of the input card (turns·steps | context usage | tokens, etc.) overlaps the transcript text beneath it and is nearly unreadable.

## Issue 1: composer column width

The root cause is a deliberate legacy decision in `base-chat.css`: `.gateway-chat-frame` defines two independent column-width variables. The composer layer grid reads the fixed `--gateway-chat-column-width: 768px`, while only the transcript column reads the adjustable `--chat-transcript-content-width` (the original comment explicitly said "widening the conversation never drags the input box along"). The desktop side has no such separation—the card column `max-w` in `ChatComposerBar`'s desktop branch reads the transcript width variable directly.

Per the user's request, that decision is reversed:

- In the `.gateway-composer-layer` grid, the middle column now reads `min(var(--chat-transcript-content-width, 768px), 100%)`, the same formula as `.gateway-transcript-shell`, so the composer column and transcript column are pixel-for-pixel the same width.
- The `--gateway-chat-column-width` definition was removed, and the comment was rewritten to explain the shared column width.
- No TSX change is needed: in both paths (the traditional `GatewayAppView` stage and the `GatewayConversationPaneHost` workbench Pane), `ChatComposerBar` is rendered inside `.gateway-transcript-stage`, and the inline variable written on the stage by `TranscriptWidthControls` (updated frame-by-frame during a drag) reaches the composer layer directly through CSS inheritance.

## Issue 2: frosted glass for the stats readout

`ConversationStatsBar` (a shared component used by both desktop and web) was previously just a bare line of text floating over the scrolling transcript with no backing; on desktop only the bottom of the layer had a 1rem solid strip, which also did not cover the readout line itself.

Change: the non-empty-state readout is wrapped in a shell—`rounded-full bg-background/90 backdrop-blur-md` (90% opaque background + 12px Gaussian blur), matching the user's requested "frosted glass, around 90% opacity." The empty-state placeholder branch does not carry this shell, so no empty pill is shown when there is no data. The clickable (manual compaction) branch's hover highlight is inside the shell and remains visible. Both clients benefit.

## Change list

- `crates/agent-gateway/web/src/styles/base-chat.css`: unified the column-width variables (see above).
- `crates/agent-ui/src/components/chat/ConversationStatsBar.tsx`: frosted glass shell.
- `crates/agent-gateway/web/test/composer-width-follows-transcript.test.mjs` (new): locks in that the composer column reads the transcript variable, that the old variable must not regress, and that both paths' composers are inside the stage.
- `crates/agent-gui/test/chat/conversation-stats-bar.test.mjs`: added frosted glass shell assertions (including that the empty state does not show an empty pill).

## Verification

- WebUI: open a conversation and drag the transcript width handle—the input card should widen/narrow in sync with the transcript (following frame-by-frame during the drag); scroll the transcript below the input area and the stats readout should float clearly on the frosted glass pill.
- Desktop: the stats readout likewise has a frosted glass backing; the width-linking behavior is unchanged.

## Follow-up adjustment: pill → full-width skirt (2026-09-05)

Desktop verification feedback: the pill only wraps the readout text, leaving the areas beside the readout and the arc-shaped gaps outside the input card's rounded corners still exposing the transcript. Changed to a full-width frosted glass "skirt": the same width as the input card, extending up 2rem with `-top-8` (equal to the card's `rounded-4xl` radius) to hide behind the card and cover the arc-shaped gaps along with it, with the bottom edge finished by `rounded-b-2xl`; `-z-10` ensures it sits below the card (on desktop the card has `z-10` and the column has a transform; on web the card is z-auto, so the stacking order holds on both clients) and above the transcript. The readout line itself no longer carries a background, and the manual compaction hover highlight remains visible on the skirt; the empty-state placeholder branch does not carry the skirt. The frosted glass assertions in `conversation-stats-bar.test.mjs` were updated in sync to lock in the skirt (full width, upward extension, -z-10; assertions use includes to avoid regex-escaping pitfalls).

2026-09-05 addendum: per verification feedback, the skirt opacity was lowered from 90% to 80% (`bg-background/80`); the blur radius is unchanged.

2026-09-05 addendum: lowered again to 70% (`bg-background/70`) to test the effect.

2026-09-05 addendum: the skirt's own `rounded-b-2xl` also leaked text at the two bottom corners, so it was removed—the skirt is now a square-cornered rectangle, and only the input card's own rounding remains.

2026-09-05 addendum: text still leaked below the web skirt—the composer layer has 16px of floating bottom padding (`--gateway-chat-composer-bottom`), which desktop covers with a desktop-only full-width solid strip, and web had no counterpart. That solid strip was made shared by both clients (`ChatComposerBar.tsx`), and an assertion was added in `composer-width-follows-transcript.test.mjs` to prevent regression.

2026-09-05 addendum: note for web-side verification—the WebUI is compiled into the gateway binary via `go:embed all:web/dist` (`crates/agent-gateway/embed.go`) with no disk fallback; after changing the frontend you must re-run `start-gateway.bat` (which rebuilds dist and recompiles the gateway), or refreshing the browser will always get the old embedded assets. This is the reason for the "solid strip changed but refresh had no effect" observed this time.