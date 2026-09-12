import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// ConversationStatsBar component behaviour acceptance
// (docs/design/composer-context-stats-bar.md §4.2, §9 component layer):
// empty-state placeholder (keeps height, not null), four-tier container shrink, ≈ prefix, full
// role="status" aria-label, running-center heartbeat conversion, approvalBar mutual exclusion
// (slot source assertion).

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const doc = env.dom.window.document;

const { ConversationStatsBar } = env.loadModule(
  "@liveagent/ui/components/chat/ConversationStatsBar.tsx",
);
const { LocaleContext } = env.loadModule("@liveagent/ui/i18n/LocaleContext.tsx");
const { t: translate } = env.loadModule("@liveagent/app/i18n/config.ts");
const { EMPTY_CONVERSATION_STATS } = env.loadModule("@liveagent/ui/lib/trajectory/stats.ts");

const enLocale = { locale: "en-US", t: (key) => translate(key, "en-US") };

function sampleStats(overrides = {}) {
  return {
    ...EMPTY_CONVERSATION_STATS,
    turns: 51,
    steps: 672,
    llmMs: 754_000,
    toolMs: 42_000,
    ttftAvgMs: 20_900,
    ttftSamples: 300,
    decodeTokPerSec: 170.4,
    cacheHitRatio: 0.85,
    inputTokens: 111_000_000,
    outputTokens: 2_300_000,
    ...overrides,
  };
}

async function render(statsValue, extraProps = {}) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        LocaleContext.Provider,
        { value: enLocale },
        React.createElement(ConversationStatsBar, { stats: statsValue, ...extraProps }),
      ),
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("empty state and all-zero readings render as a placeholder container (keep height to avoid layout shift when stats appear)", async () => {
  for (const statsValue of [null, EMPTY_CONVERSATION_STATS]) {
    const { container, unmount } = await render(statsValue);
    const placeholder = container.firstElementChild;
    assert.ok(placeholder, `stats=${JSON.stringify(statsValue)} should render a placeholder container`);
    assert.equal(placeholder.getAttribute("role"), null, "placeholder state has no role=status");
    assert.match(placeholder.className, /h-5/, "placeholder container height must match the with-data state");
    await unmount();
  }
});

test("full readings: role=status + aria-label compose all groups", async () => {
  const { container, unmount } = await render(sampleStats());
  const bar = container.querySelector('[role="status"]');
  assert.ok(bar, "must have a role=status container");
  assert.equal(bar.getAttribute("aria-live"), "off", "number changes are not announced via aria-live");

  const label = bar.getAttribute("aria-label");
  assert.equal(
    label,
    "51 turns · 672 steps ｜ LLM 12m34s · Tools 42s ｜ In 111M tok · Out 2.3M tok ｜ Avg TTFT 20.9s · 170 tok/s · Cache hit 85%",
  );
  await unmount();
});

test("container tiers: time/token/perf groups attach 28/40/52rem breakpoints respectively", async () => {
  const { container, unmount } = await render(sampleStats());
  // Locate by data-stats-group, not DOM hierarchy: when the whole row is clickable it is wrapped in an extra button.
  const classesOf = (group) =>
    container.querySelector(`[data-stats-group="${group}"]`)?.className ?? "";

  assert.match(classesOf("scale"), /flex/);
  assert.doesNotMatch(classesOf("scale"), /@min-/, "turns·steps always visible, no breakpoint");
  assert.match(classesOf("time"), /hidden @min-\[28rem\]:flex/);
  assert.match(classesOf("tokens"), /hidden @min-\[40rem\]:flex/);
  assert.match(classesOf("perf"), /hidden @min-\[52rem\]:flex/);
  await unmount();
});

test("when contextWindow is provided the context group is always visible at the same level as scale with no breakpoint", async () => {
  const { container, unmount } = await render(sampleStats(), {
    contextUsageTokens: 50_000,
    contextWindow: 200_000,
  });
  const label = container.querySelector('[role="status"]').getAttribute("aria-label");
  assert.equal(
    label,
    "51 turns · 672 steps ｜ Context 25% ｜ LLM 12m34s · Tools 42s ｜ In 111M tok · Out 2.3M tok ｜ Avg TTFT 20.9s · 170 tok/s · Cache hit 85%",
  );
  const contextEl = container.querySelector('[data-stats-group="context"]');
  assert.ok(contextEl, "should render the context group");
  assert.match(contextEl.className, /flex/);
  assert.doesNotMatch(contextEl.className, /@min-/, "context usage always visible, no breakpoint, so it shows on mobile");
  await unmount();
});

test("when no valid contextWindow is provided the context group is absent (without affecting the other groups' aria-label)", async () => {
  for (const contextWindow of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { container, unmount } = await render(sampleStats(), {
      contextUsageTokens: 50_000,
      contextWindow,
    });
    const label = container.querySelector('[role="status"]').getAttribute("aria-label");
    assert.doesNotMatch(
      label,
      /Context/,
      `with contextWindow=${contextWindow} no context group should appear; actual: ${label}`,
    );
    assert.equal(container.querySelector('[data-stats-group="context"]'), null);
    await unmount();
  }
});

test("when contextWindow is valid but contextUsageTokens is omitted the context group shows 0%", async () => {
  const { container, unmount } = await render(sampleStats(), { contextWindow: 200_000 });
  const label = container.querySelector('[role="status"]').getAttribute("aria-label");
  assert.match(label, /Context 0%/, `with tokens omitted it should show 0%: ${label}`);
  await unmount();
});

test("approximate readings carry the ≈ prefix; exact readings do not", async () => {
  const approx = await render(sampleStats({ approximate: true }));
  const label = approx.container.querySelector('[role="status"]').getAttribute("aria-label");
  assert.ok(label.startsWith("≈ "), `an approximate reading should carry the prefix; actual: ${label}`);
  await approx.unmount();

  const exact = await render(sampleStats());
  const exactLabel = exact.container.querySelector('[role="status"]').getAttribute("aria-label");
  assert.equal(exactLabel.startsWith("≈"), false);
  await exact.unmount();
});

test("when the provider returns no usage the token and perf groups are hidden entirely", async () => {
  const { container, unmount } = await render(
    sampleStats({
      ttftAvgMs: null,
      decodeTokPerSec: null,
      cacheHitRatio: null,
      inputTokens: 0,
      outputTokens: 0,
    }),
  );
  const label = container.querySelector('[role="status"]').getAttribute("aria-label");
  assert.equal(label, "51 turns · 672 steps ｜ LLM 12m34s · Tools 42s");
  await unmount();
});

test("while running, RunningSinceAt is folded into the displayed value and a heartbeat starts", async () => {
  const originalSetInterval = globalThis.setInterval;
  let intervalCount = 0;
  globalThis.setInterval = (...args) => {
    intervalCount += 1;
    return originalSetInterval(...args);
  };
  try {
    const startedAt = Date.now() - 90_000;
    const { container, unmount } = await render(
      sampleStats({
        llmMs: 60_000,
        llmRunningSinceAt: startedAt,
        toolMs: 0,
        toolRunningSinceAt: null,
      }),
    );
    const label = container.querySelector('[role="status"]').getAttribute("aria-label");
    // 60s completed + ~90s running ≈ 2m30s; second-level error tolerated.
    assert.match(label, /LLM 2m(29|30|31)s/, `converted LLM duration is wrong: ${label}`);
    assert.equal(intervalCount, 1, "a running state must register a 1s heartbeat");
    await unmount();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("zero timers when idle: with no running segment no heartbeat interval is registered", async () => {
  const originalSetInterval = globalThis.setInterval;
  let intervalCount = 0;
  globalThis.setInterval = (...args) => {
    intervalCount += 1;
    return originalSetInterval(...args);
  };
  try {
    const { unmount } = await render(sampleStats());
    assert.equal(intervalCount, 0, "with no RunningSinceAt no interval should be registered");
    await unmount();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("when usage ≥50% and onManualCompactConfirm is provided, the whole row renders as a confirm-popover trigger button", async () => {
  const { container, unmount } = await render(sampleStats(), {
    contextUsageTokens: 150_000,
    contextWindow: 200_000, // 75%, past the 50% canManualCompact threshold
    onManualCompactConfirm: () => {},
  });

  const button = container.querySelector("button");
  assert.ok(button, "should render as a clickable button");
  assert.equal(button.getAttribute("aria-label"), "Compact context manually?");
  // Readings are announced by the outer role=status; the inner row is hidden from assistive tech
  // so the same numbers are not read twice.
  assert.equal(button.querySelector("[aria-hidden]")?.getAttribute("aria-hidden"), "true");
  // Expanding the Base UI Popover on click throws in this jsdom test environment (ContextUsageRing
  // reproduces the same crash with the same ConfirmActionPopover, unrelated to this change, which
  // is also why context-usage.test.mjs never actually opened that layer), so we do not drive a real
  // click here; the source assertions below substitute for it, verifying that compaction can only
  // be triggered by confirming inside the popover and cannot be bypassed by clicking the whole row.
  const source = readFileSync(
    new URL("../../../agent-ui/src/components/chat/ConversationStatsBar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /onConfirm=\{\(\) => void onManualCompactConfirm\?\.\(\)\}/,
    "compaction must be triggered via ConfirmActionPopover's onConfirm, not called directly from the button's onClick",
  );
  assert.match(
    source,
    /<button[\s\S]*?onClick=\{open\}/,
    "the trigger button's onClick should only open the confirm popover (open), and must not call the compaction callback directly",
  );

  await unmount();
});

test("when usage <50% it is pure display and renders no button (even if onManualCompactConfirm is provided)", async () => {
  const { container, unmount } = await render(sampleStats(), {
    contextUsageTokens: 50_000,
    contextWindow: 200_000, // 25%, below the 50% canManualCompact threshold
    onManualCompactConfirm: () => {},
  });
  assert.equal(container.querySelector("button"), null, "no button when usage is below the threshold");
  // The group is still there, just not clickable.
  assert.ok(container.querySelector('[data-stats-group="scale"]'));
  await unmount();
});

test("when onManualCompactConfirm is not provided it is pure display and renders no button (even if usage qualifies)", async () => {
  const { container, unmount } = await render(sampleStats(), {
    contextUsageTokens: 150_000,
    contextWindow: 200_000,
  });
  assert.equal(container.querySelector("button"), null, "no button when the callback is not provided");
  await unmount();
});

test("when manualCompactBlocked is true it is not clickable even if usage qualifies", async () => {
  const { container, unmount } = await render(sampleStats(), {
    contextUsageTokens: 150_000,
    contextWindow: 200_000,
    onManualCompactConfirm: () => {},
    manualCompactBlocked: true,
  });
  assert.equal(container.querySelector("button"), null, "no button when compaction is blocked");
  await unmount();
});

test("the compaction count is exposed only in the tooltip and does not consume single-row width", async () => {
  const withCompactions = await render(sampleStats({ compactions: 3 }));
  const label = withCompactions.container
    .querySelector('[role="status"]')
    .getAttribute("aria-label");
  assert.doesNotMatch(label, /compactions/, "the single row does not display the compaction count");
  // The tooltip content is mounted on demand by Base UI; here we assert its data source: it is not
  // in the DOM before hover.
  assert.equal(
    withCompactions.container.textContent.includes("3 compactions"),
    false,
    "tooltip content should not be rendered before hover",
  );
  await withCompactions.unmount();
});

test("the stats bar yields when approvalBar is visible (ChatComposerBar slot mutual exclusion)", () => {
  const composerSource = readFileSync(
    new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    composerSource,
    /\{statsBar && approvalBar == null && contextDisplayMode !== "ring" \? statsBar : null\}/,
    "the statsBar slot must keep approvalBar mutual exclusion and mount only when not in ring display mode (§4.7 three tiers)",
  );
});

test("under the readings is a full-width frosted-glass skirt: it covers the whole row and reaches up to fill the gap outside the card's rounded corners", async () => {
  // Verification feedback: when body text scrolls under the input area, the readings overlap the
  // text beneath until it is unreadable, and the arc-shaped gap outside the card's rounded corners
  // lets body text leak through. The skirt is as wide as the card, with -top-8 (= rounded-4xl
  // radius 2rem) tucked behind the card, and -z-10 keeps it below the card and above the body text.
  const { container, unmount } = await render(sampleStats());
  const skirt = container.querySelector('[role="status"] > div[aria-hidden="true"]');
  assert.ok(skirt, "there should be a frosted-glass skirt under the readings");
  for (const cls of [
    "pointer-events-none",
    "absolute inset-x-0 -top-8 bottom-0 -z-10",
    "bg-background/70",
    "backdrop-blur-md",
  ]) {
    assert.ok(skirt.className.includes(cls), `skirt is missing ${cls}: ${skirt.className}`);
  }
  // User feedback: the skirt's own bottom rounding leaked text at both corners — the skirt uses
  // no rounding and square corners cover everything.
  assert.equal(skirt.className.includes("rounded"), false, "the skirt must not have rounded corners");
  await unmount();

  // The empty-state placeholder has no skirt: with no data it does not show an empty strip of frosted glass.
  const empty = await render(null);
  assert.equal(empty.container.querySelector('[role="status"]'), null);
  assert.equal(empty.container.firstElementChild.children.length, 0);
  await empty.unmount();
});
