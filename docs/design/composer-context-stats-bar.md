# Composer Context Stats Bar (Conversation Stats Bar) Implementation Plan

> Status: design draft (not implemented)
> Reference: the conversation stats bar below the DSH input box, in the form
> `51 turns · 672 steps | LLM 306m34s · Tool calls 395m8s | Avg first token 20.9s · 170 tok/s | Cache hit 85% | In 111M tok · …`

## 1. Goal

Add a single-line status bar showing **whole-conversation cumulative stats** below the chat input box (the composer glass card), so users can take in the scale and cost of the current conversation at a glance:

- Conversation scale: turns, steps (step, i.e. the number of provider requests)
- Time cost: cumulative LLM duration, cumulative tool-call duration
- Response performance: average time to first token (TTFT), decode throughput (tok/s)
- Token cost: cache hit rate, cumulative input/output tokens

Non-goals (out of scope for this iteration):

- Merging the duration/tokens of subagents (subagent runs spawned by the Agent tool) into main-conversation stats
- Cross-conversation/global usage dashboards (a Settings-level stats page is a separate feature)
- Cost (monetary) estimation — depends on per-provider price tables; to be scoped separately

## 2. Current state: the data foundation is already in place

Conclusion first: **this feature requires no new instrumentation or wire-format fields.** The trajectory system already records every raw fact the stats bar needs.

### 2.1 Trajectory events (single source of truth)

The wire format `TrajectoryEvent` in `crates/agent-ui/src/lib/trajectory/types.ts` already includes:

| Event | Key fields | Derivable metrics |
| --- | --- | --- |
| `user` / `turn_end` | `t` (turn number), `at` | Turns |
| `step_start` | `s` (step number), `at` | Steps, start of the LLM duration |
| `first_token` | `at` | TTFT |
| `step_end` | `at`, `u` (`TrajectoryUsage`: input/output/cacheRead/cacheWrite/reasoning) | End of the LLM duration, token totals, cache hits, tok/s |
| `tool_start` / `tool_end` | `at`, `id` | Tool-call duration, tool-call count |
| `compaction_start` / `compaction_end` | `before` / `after` | Compaction count (optional display) |

### 2.2 Dual-platform data channels (already exist; reuse directly)

| Channel | Desktop (agent-gui) | WebUI (agent-gateway/web) |
| --- | --- | --- |
| Live events | The recorder writes into the local live store via `recorderRegistry` (`lib/trajectory/liveTrajectory.ts`, 100ms coalesced notifications) | `transcriptStore.ts` unconditionally calls `absorbTrajectoryChatEvent` before the seq gate (250ms coalesced notifications) — **it keeps receiving even when the trajectory view is not open** |
| Persisted reads | Tauri command `trajectory_get_window` (`trajectory_window.rs`, 8 segments per page by default, max 64, returns `hasMoreBefore`) | `trajectory.fetch` is answered by the desktop through the Gateway relay (`shims/tauriCore.ts` forwards it in the same shape) |
| Idempotent convergence | `buildTrajectoryLedger` in `eventLog.ts`: dedupes by event semantic identity, robust against out-of-order, duplicate, and truncated input | The same shared implementation |

### 2.3 UI mount point (slot pattern already exists)

`crates/agent-ui/src/pages/chat/ChatComposerBar.tsx` already accepts host-injected auxiliary bars (`taskProgressBar`, `approvalBar`) through ReactNode slots; the stats bar follows the same pattern without breaking the shared-layer boundary enforced by `check-ui-boundaries` (agent-ui does not import host code; all data is injected via props).

## 3. Metric definitions

All metrics are derived from the converged `TrajectoryLedger` (turns → steps → tools). Notation: `Σ` iterates over every step/tool of every loaded turn.

| Metric | Formula | Notes |
| --- | --- | --- |
| Turns | `ledger.turns.length` | Includes the currently running turn |
| Steps | `Σ turn.steps.length` | One step = one provider request |
| LLM duration | `Σ (step.endedAt − step.startedAt)`; for a running step use `now − startedAt` | Includes the TTFT wait segment |
| Tool-call duration | `Σ (tool.endedAt − tool.startedAt)`; same for running ones | Parallel tool calls are summed by their individual wall time, so **the total may exceed the physical elapsed time** (DSH behaves the same way); the copy does not need to sidestep this |
| Average first token | `mean(step.firstTokenAt − step.startedAt)`, counting only steps that have `firstTokenAt` | After a retry, `step_start` is already the start of the last attempt, so no special-casing is needed |
| tok/s | `Σ usage.output ÷ Σ (step.endedAt − step.firstTokenAt)` | Steps whose denominator lacks `firstTokenAt` fall back to `endedAt − startedAt`; when the denominator is ≤ 0, that step is excluded |
| Cache hits | `Σ cacheRead ÷ Σ (input + cacheRead + cacheWrite)` | Definition = "how much of the prompt tokens came from cache reads". cacheWrite is included in the denominator: on the request that writes the cache, those tokens genuinely did not hit |
| Input tok | `Σ (input + cacheRead + cacheWrite)` | Total prompt volume consistent with billing semantics |
| Output tok | `Σ (output)` | If `reasoning` is already included in each provider's output, do not add it again; follow the existing semantics of `TrajectoryUsage` |

Additional rules:

- Steps missing `usage` (the provider did not return it) count only toward steps and duration and do not pollute token metrics.
- All metrics count only **main-conversation** events; `tool_end.run` (subagent runId) is not expanded.
- Number formatting:
  - Tokens use `Intl.NumberFormat(locale, { notation: "compact" })` → `111M`, `2.3K`;
  - Durations uniformly use `formatStatDuration(ms)`: `< 60s → "42s"`, `< 60min → "12m34s"`, `≥ 60min → "5h06m"` (unlike DSH's `306m34s`, since minute counts above three digits read poorly);
  - TTFT keeps one decimal place (`20.9s`), tok/s is rounded to an integer.

## 4. Overall architecture

Three layers, all in the shared agent-ui layer, with hosts only doing the wiring:

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Host wiring layer                                                                                │
│  desktop: ConversationPaneHost → statsBar={<…/>}                                                 │
│  web:     GatewayAppView       → statsBar={<…/>}                                                 │
│  Injection: TrajectoryHost.loadWindow + live events source                                       │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Component layer  agent-ui/components/chat/ConversationStatsBar.tsx                               │
│  Display + responsive collapse + 1s running heartbeat + click-to-open trajectory view (optional) │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Aggregation layer  agent-ui/lib/trajectory/stats.ts                                              │
│  aggregateTrajectoryStats(ledger, now) → ConversationStats                                       │
│  useConversationStats(host, conversationId, liveEvents…)                                         │
│  Module-level cache: conversationId → {persisted events, aggregation snapshot}                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Aggregation layer `lib/trajectory/stats.ts`

```ts
export type ConversationStats = {
  turns: number;
  steps: number;
  llmMs: number;            // completed portion
  llmRunningSinceAt: number | null;   // start of the running step; the display layer tops it up with now
  toolMs: number;
  toolRunningSinceAt: number | null;
  ttftAvgMs: number | null; // null when there are no samples
  ttftSamples: number;
  decodeTokPerSec: number | null;
  cacheHitRatio: number | null;
  inputTokens: number;      // input + cacheRead + cacheWrite
  outputTokens: number;
  compactions: number;
  /** true when events are truncated or not fully loaded; the display layer adds an "≈" prefix */
  approximate: boolean;
};

export function aggregateTrajectoryStats(ledger: TrajectoryLedger): ConversationStats;
```

A pure function with no IO, consuming the output of `buildTrajectoryLedger` directly — **all the dirty work of deduplication, out-of-order handling, and duplicate replay is reused from the existing ledger layer**; the aggregation layer does not reinvent convergence logic.

Supporting hook (same file or `useConversationStats.ts`):

```ts
export function useConversationStats(options: {
  conversationId: string;
  host: Pick<TrajectoryHost, "loadWindow">;
  liveEvents: readonly TrajectoryEvent[];      // output of useSyncExternalStore, passed in by the host
  authoritativeRevision?: number;               // full reload after edit-resend/rebase
  enabled: boolean;                             // do not load when the bar is empty/hidden
}): { stats: ConversationStats | null; loading: boolean };
```

Behavior:

1. **Initial load**: `loadWindow(conversationId)` fetches the most recent window; if `hasMoreBefore`, use `requestIdleCallback` (falling back to `setTimeout`) to page backward in the background until fully read (each page uses the backend limit, at most 64 segments per call). During paging `approximate = true`; once done it flips to false.
2. **Live merge**: `persisted ∪ liveEvents` → `buildTrajectoryLedger(events, { liveIdentities })` → `aggregateTrajectoryStats`. Rebuilds are throttled to **1s** (synced with the heartbeat for running durations); nothing is rebuilt while idle (not isSending and no new events).
3. **Module-level cache**: `Map<conversationId, { events, oldestSegmentIndex, statsSnapshot }>`, LRU cap of 8 conversations. Multiple panes opening the same conversation share one copy; switching away and back does not re-page.
4. **Authoritative reload**: when `authoritativeRevision` changes (edit-resend, disconnect rebase, manual compaction truncating history), discard the cache and reload entirely — semantics match `TrajectoryView.reconcileAuthoritativeWindow`.
5. **Memory guard**: when the cumulative event count exceeds 50k (roughly several MB of JSON), stop paging backward and keep `approximate = true`. This is a fuse for extremely long conversations; normal conversations (hundreds of steps) are nowhere near it.

### 4.2 Component layer `components/chat/ConversationStatsBar.tsx`

- Single line, horizontally centered, `text-[calc(11px*var(--zone-font-scale,1))]`, `text-muted-foreground/70`, with `|` between groups (`text-muted-foreground/40`) and `·` within groups — consistent with the existing visual language of `UsagePanel`.
- Rendered **below** the composer glass card, inside a container the same width as the card (see 4.3), about 20px tall, and not part of the card's expand/collapse animation.
- **Responsive collapse**: the composer card is already an `@container`; low-priority groups are hidden in tiers based on container width:
  1. Always shown: `turns · steps` `+ context usage %` (mobile cannot reach the next tier; see the revision note at the end of 4.5 for why)
  2. ≥ 28rem: `+ LLM duration · Tool duration`
  3. ≥ 40rem: `+ Input/output tok`
  4. ≥ 52rem: `+ First token · tok/s · Cache hit`
- **Running heartbeat**: while `isSending`, trigger a re-render every 1s to fold `llmRunningSinceAt`/`toolRunningSinceAt` into the displayed values; zero timers while idle.
- **Empty state**: when `stats === null` (no trajectory events at all), render an equal-height placeholder container (`h-5`, no content, `aria-hidden`) instead of returning `null` — without the placeholder, the moment the first assistant reply lands and the stats appear, the composer/transcript would shift once as a whole; a permanent placeholder trades that for zero jumping and is visually invisible in steady state. Legacy conversations and text mode take this same placeholder branch.
- **Interaction**: hover shows a `LabelTooltip` with the complete metrics that were not collapsed away plus the compaction count; when usage reaches the manual-compaction threshold (`canManualCompact`, ≥50%) and the host has provided a compaction callback, the whole bar becomes clickable → a confirmation pops up and then triggers manual compaction, with the threshold expression sourced from the same place as `ContextUsageRing` (`canManualCompact(ratio) && !manualCompactBlocked && Boolean(onManualCompactConfirm)`), reusing the same `ConfirmActionPopover` interaction; when the conditions are not met it is display-only with no click behavior.

  **Revision**: the original design of "whole bar clickable → switch to the trajectory view" has been overturned in favor of click triggering a manual-compaction confirmation. Reason: the trajectory view already has its own entry point (`ConversationViewTabs`, wired on both desktop and WebUI), so reusing a click gesture in the stats bar for navigation would be a duplicate entry point; meanwhile manual compaction could previously only be triggered from the ring entry point of `ContextUsageRing`, and the ring goes invisible on narrow screens/low usage (`hideBelowWarn`), taking the compaction entry point with it — the stats bar, being permanently visible (see the confirmation of the always-visible context-usage group in 4.5), fills exactly that gap when reused as the compaction entry point. A click only calls `open()` to show the `ConfirmActionPopover`; the compaction callback is attached only to the popover's internal `onConfirm`, so the confirmation step cannot be bypassed by clicking the row.
- Accessibility: container `role="status"` + `aria-label` assembling the full text; numeric changes do not use `aria-live` (it would flood during streaming).

### 4.3 Changes to ChatComposerBar (minimally invasive)

```tsx
// add one slot to props, same pattern as taskProgressBar / approvalBar
statsBar?: ReactNode;
```

Render position: after the glass card's `</div>` (currently L1240) and inside the outer width container, so it stays aligned with the card's left/right edges:

```tsx
  {fileDropOverlay}
</div>
{statsBar /* ← new: below the card, placeholder decided by the component itself */}
```

Note: `onHeightChange` (the reserved height at the bottom of the transcript) measures the entire composer overlay, and the stats bar appearing/disappearing changes the height — the existing ResizeObserver logic already covers this, so no extra handling is needed; only regression verification is required.

### 4.4 Host wiring

**Desktop** `crates/agent-gui/src/pages/chat/surfaces/ConversationPaneHost.tsx`:

```tsx
statsBar={
  <ConversationStatsBarHost   // thin wrapper on the agent-gui side
    conversationId={snapshot.conversationId}
    isSending={isSending}
  />
}
```

Inside the thin wrapper: `useSyncExternalStore(subscribeDesktopLiveTrajectory, () => desktopLiveTrajectoryEvents(id))` + `createInvokeTrajectoryHost(invoke)` (`ConversationTrajectorySurface.tsx` already has the same data-fetching code, which can be extracted directly).

**WebUI** `crates/agent-gateway/web/src/app/GatewayAppView.tsx`: isomorphic — `subscribeLiveTrajectory` + `liveTrajectoryEvents` + the `trajectory.fetch` adapter (`agent-ui-adapters/trajectory.ts`, ready-made). `liveOwnership` semantics follow the trajectory view: `authoritative` on desktop, `observed` on Web.

### 4.5 Layout impact: shrink the card and pill by one step to reserve height budget for the stats bar (shipped)

Product decision (confirmed): make the input card and task pill one size smaller overall, giving the saved height to the stats bar, so that the total bottom footprint after the stats bar ships stays roughly on par with before the redesign. The following size adjustments are **already implemented**:

| Element | Adjustment | Saving |
| --- | --- | --- |
| Editor min height | `min-h-[70px]` → `min-h-[60px]` (3 lines of text; overridden via ChatComposerBar's className, where the later class wins after twMerge, without affecting other MentionComposer consumers) | −10px |
| Editor area top padding | `pt-3.5` → `pt-2.5` | −4px |
| Toolbar row padding | `pb-2 pt-1` → `pb-1.5 pt-0.5` | −4px |
| Task pill | `h-10` → `h-9`, `px-3.5` → `px-3`, font size 13px → `text-xs` | −4px |
| Pill-to-card spacing | `mb-4` → `mb-3` | −4px |

Height budget: collapsed card ~128px → 110px (−18px), pill stack −8px; the stats bar adds about +20px, a net increase of ≈ +2px, visually on par with before the redesign.

Also shipped is the **`statsBar` slot**: ChatComposerBar gains `statsBar?: ReactNode`, rendered directly below the glass card inside a container the same width as the card, and with built-in mutual exclusion with `approvalBar` — when the approval panel is visible the stats bar automatically yields (approval actions take priority over stats readouts). When the host does not wire it, it takes no space, and the transcript's bottom reservation adapts automatically via the existing ResizeObserver.

- **The context usage ring (ContextUsageRing) is changed to hide at low usage** (a confirmed product decision, implemented alongside the stats bar): the ring is not rendered while usage is `< CONTEXT_USAGE_WARN_RATIO` (50%, i.e. when manual compaction is unavailable); it appears at ≥ 50%, coinciding exactly with the window in which the manual compaction entry point is available. Division of semantics: the ring handles "current context usage" (instantaneous, falling back after compaction), and the stats bar handles "whole-conversation cumulative" (monotonically increasing). Implemented as a new `hideBelowWarn?: boolean` on `ContextUsageRing` (default false, passed as true here), returning null when `ratio < CONTEXT_USAGE_WARN_RATIO`; the ring is absolutely positioned, so hiding it does not affect the layout of the right-hand control column.

  **Revision (mobile feedback)**: the above decision that "the stats bar does not include a context-usage group" has been overturned. Reason: on mobile, the composer container width never reaches the stats bar's first breakpoint (28rem), so narrow screens only show "turns · steps"; and the usage ring goes invisible below 50% usage (`hideBelowWarn`) — together, low-usage conversations on narrow screens show no context information at all. Fix: the stats bar gains an always-visible "context usage" group (at the same level as `turns · steps`, with no `@min-` breakpoint), whose readout comes from the same source as the usage ring (`contextUsageTokensSource` + `contextWindow` → `contextUsageRatio()`), but **does not reuse the `hideBelowWarn` threshold** — it displays whenever there is a valid `contextWindow` (`> 0` and finite), showing 0% when `contextUsageTokens` is absent rather than hiding the whole group. The ring and the stats bar are therefore no longer mutually exclusive: the ring continues to serve as "the compaction entry point that appears only at ≥ 50%", while the stats bar serves as "an always-visible usage readout"; they share the same data source but have independent visibility thresholds.

### 4.6 Revision (2026-08-26): stats bar and usage ring become strictly mutually exclusive, switched via settings (shipped)

Product decision (confirmed, **strictly binary**): the "ring and stats bar coexist" established by the §4.5 revision is no longer retained — the two become mutually exclusive display styles, switched by the user in the advanced settings drawer of the provider settings page, defaulting to the stats bar. There is no third state (coexist/auto), and therefore no duplicate-compaction-entry problem from the ring and stats bar showing two entries in a coexisting form.

- **Settings field**: `settings.customSettings.composerContextDisplay: "statsBar" | "ring"` (`ComposerContextDisplayMode`). `normalizeCustomSettings` falls back to `"statsBar"` — old configurations without this field and dirty values (including the previously imagined `"auto"`) all fall back to the default. As a global product preference it syncs with gateway settings: it does **not** go into the local-reset list of `syncableCustomSettings` (unlike device-local preferences such as font/width); it takes effect on desktop and WebUI alike.
- **Mutual exclusion is enforced inside the component**: `ChatComposerBar` gains `contextDisplayMode?: ComposerContextDisplayMode` (defaulting to `"statsBar"`); the two hosts only pass through the settings value, and the component arbitrates the ring/stats-bar choice uniformly, so hosts cannot configure a coexisting form:
  - `"statsBar"`: render the `statsBar` slot; the ring is not rendered at all. The compaction entry point is carried by clicking the whole stats bar (§4.2 revision).
  - `"ring"`: render the usage ring and **always show it** (the composer no longer passes `hideBelowWarn`) — the ring is then the only usage readout, and hiding at low usage would reintroduce the "no usage information at all" gap that the §4.5 revision fixed; the `statsBar` slot is not mounted even if the host passes it in. Below 50% the ring is not clickable (the `canManualCompact` threshold is unchanged); from ≥50% it serves as the compaction entry point.
- **`ContextUsageRing.hideBelowWarn` is retained** as a general display option of the shared ring (real-DOM acceptance tests continue to cover it); it is just no longer used at this composer mount point.
- **Toggle UI**: the `ProvidersSection` advanced settings drawer (`CustomSettingsDrawer`) gains a Switch — on = usage ring, off = stats bar; i18n keys `settings.composerContextDisplay` / `settings.composerContextDisplayDesc` (zhCNSettings/enUSSettings).
- **Wiring**: add one `contextDisplayMode` line each to the two composer bindings in desktop `ChatPage.tsx` and to WebUI `GatewayAppView.tsx`; `ConversationPaneHost` and the `ConversationStatsBarHost` on both ends are unchanged (the statsBar slot is constructed as usual; whether it mounts is decided by the component, and when unmounted the data hook does not mount, so there is no fetch overhead).
- **Tests**: `normalization.test.mjs` covers binary normalization and gateway sync pass-through; `context-usage.test.mjs`'s composer source assertions change to the mutual-exclusion semantics (the ring renders per mode, the statsBar slot is not mounted in ring mode, and `hideBelowWarn` no longer appears in the composer).

### 4.7 Revision (2026-08-27): the binary toggle becomes a three-position slider with a new "show both" position (shipped)

Product decision: the strict binary of §4.6 is relaxed to three positions. The Switch in the settings drawer becomes a three-position slider, left to right: **stats bar → both → usage ring**; the new middle "both" position lets the stats bar and an always-shown usage ring coexist, and the left/right positions behave exactly as the off/on of §4.6, with the stats bar still the default. In the both position, the ring and the stats bar each keep their ≥50% manual-compaction entry point (the dual-entry form that §4.6 eliminated returns with this position, deliberately so).

- **Settings field**: `ComposerContextDisplayMode` expands to `"statsBar" | "both" | "ring"`. Both normalization sites (`normalizeCustomSettings` and the local copy in agent-gui `storage.ts`) accept the three valid values; the default/dirty values (including the previously imagined `"auto"`) still fall back to `"statsBar"`; gateway sync pass-through is unchanged (`Partial` + `??` holds naturally for the new value), and when an old peer payload lacks the field the local value is kept as before.
- **The choice still lives inside the component**: the ring render condition in `ChatComposerBar` widens to `"ring" || "both"`, and the statsBar slot keeps mounting when `!== "ring"` — `"both"` naturally falls into both branches; the `"statsBar"` / `"ring"` positions behave exactly as in §4.6, and hosts still only pass through the settings value.
- **Slider UI**: a new generic component `SegmentedSlider` (`components/ui/segmented-slider.tsx`) — equal-width segments plus a sliding indicator, backed by native radios of the same name, with arrow-key switching and Tab in/out of the group handled natively by the browser; the `ProvidersSection` drawer uses it in place of the Switch. The i18n title becomes "Context usage display", and three position label keys are added: `settings.composerContextDisplayStatsBar` / `...Both` / `...Ring` (zhCN/enUS).
- **Tests**: `normalization.test.mjs` changes to cover three-state normalization and gateway sync carrying `"both"`; the source assertions in `context-usage.test.mjs` and `conversation-stats-bar.test.mjs` change to three-position semantics.

### 4.8 Revision (2026-08-31): layout refactor and copy simplification for this section of the settings drawer (shipped)

Purely UI/copy adjustments; the settings field and component arbitration logic are unchanged. The previous "bare label + slider + a four-line paragraph listing the three positions" becomes the same shape as other drawer sections: `DrawerSectionHeader` (Activity icon + title + hint bubble) + full-width `SegmentedSlider` + a single line below the slider describing only the **currently selected position**. General information such as "keeps a manual compaction entry point at ≥50%" moves into the section header's hint bubble. i18n: delete the long-paragraph key `settings.composerContextDisplayDesc`, add `...Hint` (bubble) and `...StatsBarDesc` / `...BothDesc` / `...RingDesc` (single-line position descriptions, zhCN/enUS).

## 5. Trade-offs: why not do backend aggregation first

| | A. Pure frontend (this plan) | B. Backend aggregation command |
| --- | --- | --- |
| New backend surface | None | Tauri command + Gateway relay method + WebUI shim, three places |
| Dedup/convergence | Reuse `buildTrajectoryLedger`, one set of logic | A new dedup boundary is needed between persisted aggregation and the live tail (segments are not aligned to turns, making a clean cut hard) |
| Cost for large conversations | Background paging on first open + resident event memory (several MB, with a 50k guard) | One backend SQL scan, zero frontend memory |
| Consistency risk | Naturally consistent with the trajectory view readout (same ledger) | The two aggregation definitions may drift |

**Conclusion: start with A.** B is reserved as a phase-two optimization — if real-world testing finds the paging time/memory on first open of huge conversations unacceptable, add `trajectory_stats_get` (aggregating only **closed segments**, while open segments still go through frontend event convergence, naturally sidestepping the dedup boundary problem). The aggregation layer's `ConversationStats` structure stays neutral toward both sources, so switching sources does not touch the component layer.

## 6. i18n

Additions to `crates/agent-ui/src/i18n/translations/{zhCNCommon,enUSCommon}.ts`:

| key | zh-CN | en-US |
| --- | --- | --- |
| `chat.stats.turns` | `{n} turns` | `{n} turns` |
| `chat.stats.steps` | `{n} steps` | `{n} steps` |
| `chat.stats.contextUsage` | `Context {p}%` | `Context {p}%` |
| `chat.stats.llmTime` | `LLM {t}` | `LLM {t}` |
| `chat.stats.toolTime` | `Tools {t}` | `Tools {t}` |
| `chat.stats.ttftAvg` | `Avg TTFT {t}` | `Avg TTFT {t}` |
| `chat.stats.throughput` | `{n} tok/s` | `{n} tok/s` |
| `chat.stats.cacheHit` | `Cache hit {p}%` | `Cache hit {p}%` |
| `chat.stats.inputTokens` | `In {n} tok` | `In {n} tok` |
| `chat.stats.outputTokens` | `Out {n} tok` | `Out {n} tok` |
| `chat.stats.compactions` | `{n} compactions` (tooltip only) | `{n} compactions` |
| `chat.stats.approximate` | `≈` (prefix, with a tooltip explanation) | `≈` |
| `chat.manualCompactTitle` | `Compact context manually?` | `Compact context manually?` (also used as the trigger button's `aria-label`) |
| `chat.manualCompactDescription` | `Folds earlier messages into a summary checkpoint to free context space.` | `Folds earlier messages into a summary checkpoint to free context space.` |
| `chat.manualCompactConfirm` | `Compact` | `Compact` |

## 7. Boundaries and degradation

| Scenario | Behavior |
| --- | --- |
| Legacy conversations / text mode, no trajectory events | Render an equal-height placeholder container (do not hide, do not return `null`), avoiding layout jumping when the stats appear |
| A `trajectory_truncated` segment, or paging incomplete / the 50k guard triggered | Shown with an `≈` prefix |
| Manual/automatic compaction | Stats are **cumulative over events** and are unaffected by context truncation (complementary to, not in conflict with, the usage ring's "current context usage" definition); the compaction count goes into the tooltip |
| edit-resend drops old turns | `authoritativeRevision` triggers a full reload, converging the readout to the new history |
| Reconnect replays events | Ledger identity dedup keeps the readout from jumping |
| The provider does not return usage | Token metrics count only steps that have usage; when none do, the corresponding group is hidden |
| Trajectory view is open | The composer is suspended (`hidden`) and the stats bar hides along with it; the data cache is shared, so there is no duplicate fetching |
| Multiple panes on the same conversation | The module-level cache shares events and aggregation, adding only one more subscription |
| `approvalBar` visible | The stats bar is temporarily hidden; approval actions take priority |
| Context usage < 50% | statsBar mode (default): no ring, and the stats bar's usage group is always visible (see the 4.5 revision); ring/both modes: the ring is always shown but not clickable, and serves as the manual compaction entry point from ≥ 50% (see 4.6/4.7) |
| No `contextWindow` (legacy conversations / text mode) | The stats bar's "context usage" group does not exist at all (no fake 0% is shown); the other groups are unaffected |

## 8. File change list

| File | Action |
| --- | --- |
| `crates/agent-ui/src/lib/trajectory/stats.ts` | Added: types + `aggregateTrajectoryStats` + formatting functions |
| `crates/agent-ui/src/lib/trajectory/useConversationStats.ts` | Added: load/paging/cache/throttle hook |
| `crates/agent-ui/src/components/chat/ConversationStatsBar.tsx` | Added: display component |
| `crates/agent-ui/src/pages/chat/ChatComposerBar.tsx` | ✅ Shipped: `statsBar` slot (with approvalBar mutual exclusion) + card shrink (4.5) + `contextDisplayMode` display arbitration (4.6 strict mutual exclusion → 4.7 three positions, replacing the original "pass `hideBelowWarn` to the ring" approach) |
| `crates/agent-ui/src/components/chat/TaskProgressIndicator.tsx` | ✅ Shipped: pill shrink (4.5, tests updated on both ends) |
| `crates/agent-ui/src/components/chat/ContextUsageRing.tsx` | ✅ Shipped: `hideBelowWarn` prop (now a general display option of the shared ring; no longer passed by the composer mount point, see 4.6) |
| `crates/agent-ui/src/lib/settings/types.ts` / `index.ts` | ✅ Shipped (4.6/4.7): `ComposerContextDisplayMode` + the `composerContextDisplay` field and three-state normalization |
| `crates/agent-ui/src/pages/settings/ProvidersSection.tsx` + `zhCNSettings.ts` / `enUSSettings.ts` | ✅ Shipped (4.6/4.7): the advanced settings drawer's three-position display-style slider (`SegmentedSlider`) + copy |
| `crates/agent-gui/src/pages/ChatPage.tsx` | ✅ Shipped (4.6): both composer bindings pass through `contextDisplayMode` |
| `crates/agent-ui/src/i18n/translations/zhCNCommon.ts` / `enUSCommon.ts` | Modified: add keys |
| `crates/agent-gui/src/pages/chat/surfaces/ConversationPaneHost.tsx` (+ thin wrapper component) | Modified: desktop wiring |
| `crates/agent-gateway/web/src/app/GatewayAppView.tsx` (+ thin wrapper component) | Modified: Web wiring |
| `crates/agent-gui/test/trajectory/stats.test.mjs` | Added: aggregation unit tests |
| `crates/agent-gui/test/chat/conversation-stats-bar.test.mjs` | Added: component behavior tests |

Zero backend (Rust) changes.

## 9. Test plan

Aggregation layer (pure functions, key coverage):

- A complete turn event stream → each metric's value is correct (hand-computed golden samples)
- Out-of-order + duplicate replay → same result as sequential input (idempotent)
- Running step/tool → `*RunningSinceAt` is correct and the completed portion excludes the running segment
- Missing usage on a step, missing `firstTokenAt`, denominator 0 → no NaN, and the corresponding metric is null
- Cache hit / input token definitions: cacheWrite counts toward the denominator and input
- Truncation/guard → `approximate` is set

Hook layer:

- First window + background paging stitching, `hasMoreBefore` boundary
- Live events overlapping persisted → no double counting after dedup
- `authoritativeRevision` change → cache invalidation and reload
- 1s throttle: consecutive live notifications trigger only one rebuild

Component layer:

- Empty state renders an equal-height placeholder container (does not return null); container tiered collapse (in the style of the existing workbench-dom-boundaries tests)
- `≈` prefix, `role="status"` aria-label completeness
- Duration/token formatting boundaries (59s, 60s, 999K, 1M…)
- The stats bar hides when `approvalBar` is visible
- Ring `hideBelowWarn`: hidden at 49%, shown at 50%, hidden again after compaction lowers usage (`context-usage.test.mjs` DOM acceptance for the shared ring; the prop is retained but the composer no longer passes it, see 4.6)
- Three-position display (4.6→4.7): ChatComposerBar renders the ring/stats bar per `contextDisplayMode` (statsBar/both/ring, source assertions in `context-usage.test.mjs`); `composerContextDisplay` three-state normalization + gateway sync carrying `"both"` (`normalization.test.mjs`)
- Context usage group: always shown with a valid `contextWindow` and with no breakpoint attached; when `contextWindow` is absent/invalid (0, negative, NaN, Infinity) the group does not exist at all; when `contextUsageTokens` is absent but `contextWindow` is valid, it displays as 0% (`conversation-stats-bar.test.mjs`)

Regression: composer height reporting (`onHeightChange`) updates correctly when the stats bar appears/disappears; `pnpm check` (biome + ui-boundaries) passes.

## 10. Implementation steps

1. **Aggregation layer + unit tests** (stats.ts, pure functions, half a day) — nail down the definitions first
2. **Hook layer** (load/cache/throttle, 1 day)
3. **Component + i18n + ChatComposerBar slot + ring low-usage hiding** (1 day)
4. **Dual-platform wiring + regression** (desktop first, Web reusing, 1 day)
5. **Optional enhancements**: click to open the trajectory view, tooltip details (half a day)
6. **Phase-two watch item**: first-open performance data for huge conversations → decide whether to add backend aggregation (plan B)

About 3–4 person-days in total, with the risk concentrated in the cache/dedup correctness of the hook layer — but it all reuses convergence primitives already validated by the trajectory view, making it composition rather than invention.