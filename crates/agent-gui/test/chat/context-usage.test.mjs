import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const contextUsage = loader.loadModule("@liveagent/ui/lib/chat/contextUsage.ts");
const { formatTokenCount } = loader.loadModule("@liveagent/ui/lib/chat/formatTokenCount.ts");
const tokenLedger = loader.loadModule("src/lib/chat/compaction/tokenLedger.ts");
const chatComposerBarSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
);
const mentionComposerSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/MentionComposer.tsx", import.meta.url),
  "utf8",
);
const chatTurnQueueSource = readFileSync(
  new URL("../../src/pages/chat/queue/useChatTurnQueue.ts", import.meta.url),
  "utf8",
);
const gatewayAppSource = readFileSync(
  new URL(
    "../../../agent-gateway/web/src/app/hooks/useGatewayConversationRuntime.ts",
    import.meta.url,
  ),
  "utf8",
);
const contextUsageRingSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ContextUsageRing.tsx", import.meta.url),
  "utf8",
);

const {
  CONTEXT_USAGE_WARN_RATIO,
  CONTEXT_USAGE_DANGER_RATIO,
  assistantAnchorTokens,
  buildContextUsageScanItems,
  contextUsageLevel,
  canManualCompact,
  contextUsageRatio,
  deriveContextUsageTokens,
  estimateJsonTokens,
  estimateTextTokens,
  estimateTextTokenUnits,
  estimateThinkingReplayTokenUnits,
  hasContextUsageUsageAnchor,
  hostedSearchFollowUpTokens,
  isResponsesReasoningSignature,
  isStrippedHostedSearchUsage,
} = contextUsage;

test("token counts use K for thousands while keeping smaller values intact", () => {
  assert.equal(formatTokenCount(0, "zh-CN"), "0");
  assert.equal(formatTokenCount(420, "zh-CN"), "420");
  assert.equal(formatTokenCount(999, "zh-CN"), "999");
  assert.equal(formatTokenCount(1_000, "zh-CN"), "1K");
  assert.equal(formatTokenCount(1_840, "zh-CN"), "1.84K");
  assert.equal(formatTokenCount(2_260, "zh-CN"), "2.26K");
  assert.equal(formatTokenCount(128_000, "zh-CN"), "128K");
});

test("threshold boundaries: <50% ok, 50-80% warn, >=80% danger", () => {
  assert.equal(CONTEXT_USAGE_WARN_RATIO, 0.5);
  assert.equal(CONTEXT_USAGE_DANGER_RATIO, 0.8);
  assert.equal(contextUsageLevel(0), "ok");
  assert.equal(contextUsageLevel(0.49), "ok");
  assert.equal(contextUsageLevel(0.5), "warn");
  assert.equal(contextUsageLevel(0.79), "warn");
  assert.equal(contextUsageLevel(0.8), "danger");
  assert.equal(contextUsageLevel(1.5), "danger");
});

test("manual compaction unlocks exactly at the warn ratio", () => {
  assert.equal(canManualCompact(0.49), false);
  assert.equal(canManualCompact(0.5), true);
  assert.equal(canManualCompact(0.99), true);
});

test("WebUI manual compaction targets the requested conversation and only accepts on proceed", () => {
  assert.doesNotMatch(chatTurnQueueSource, /conversation is not active on desktop/);
  // Strict operationId: reject when absent, never fall back to requestId (a
  // fallback produces an operationId the WebUI never registered, so the terminal
  // state never matches and fills up with timeouts).
  assert.match(chatTurnQueueSource, /manual compaction requires operationId/);
  // Acceptance is reported synchronously via onAccepted only when the probe
  // passes and compaction actually begins.
  assert.match(
    chatTurnQueueSource,
    /manualCompactActionRef\s*\.current\(\{\s*conversationId,\s*operationId,\s*onAccepted: respondAccepted,?\s*\}\)/,
  );
  // A probe rejection is answered synchronously from the return value as
  // accepted:false + message (no more "accepted then reply").
  assert.match(
    chatTurnQueueSource,
    /fail\(result\.message \|\| "manual compaction declined", codeFor\(result\.status\)\)/,
  );
});

test("WebUI manual compaction converges from the transcript store and a bounded timeout", () => {
  assert.match(gatewayAppSource, /store\.getSnapshot\(\)\.manualCompactionResult/);
  assert.match(gatewayAppSource, /MANUAL_COMPACTION_TIMEOUT_MS/);
  assert.match(gatewayAppSource, /chat\.manualCompactTimedOut/);
});

test("context usage ring lives in the stacked runtime control deck", () => {
  assert.match(chatComposerBarSource, /composer-control-deck/);
  assert.ok(
    chatComposerBarSource.indexOf("composer-control-deck") <
      chatComposerBarSource.indexOf("<ComposerContextUsageRing"),
  );
  assert.doesNotMatch(chatComposerBarSource, /absolute right-3 top-1\/2/);
});

test("composer editor row reserves the right rail so the scrollbar clears expand", () => {
  // The clearance must be applied to the editor's outer container: padding does
  // not move the scrollbar, and with the editor's own pr-8 that 6px scroll track
  // would still sit on top of the top-right expand button.
  assert.match(chatComposerBarSource, /"relative flex flex-1 pl-4 pr-12"/);
  assert.doesNotMatch(chatComposerBarSource, /"relative flex flex-1 px-4"/);
  assert.doesNotMatch(chatComposerBarSource, /"px-0 py-0 pr-8"/);
});

test("composer uses the opaque Tessera surface and a compact idle height", () => {
  assert.match(
    chatComposerBarSource,
    /composer-glass-card[^\n]+rounded-4xl[^\n]+border-border\/65 bg-muted/,
  );
  assert.match(
    chatComposerBarSource,
    /composer-input-surface[^\n]+rounded-4xl bg-background/,
  );
  assert.match(chatComposerBarSource, /composer-control-deck[^\n]+min-h-9[^\n]+bg-muted/);
  assert.doesNotMatch(chatComposerBarSource, /composer-input-surface[^\n]+bg-white\/76/);
  assert.doesNotMatch(chatComposerBarSource, /composer-glass-card[^\n]+bg-black\/\[0\.035\]/);
  assert.match(mentionComposerSource, /mention-composer min-h-10 max-h-\[160px\]/);
});

test("composer expand toggle appears only after the editor overflows", () => {
  assert.match(
    chatComposerBarSource,
    /const \[composerHasOverflow, setComposerHasOverflow\] = useState\(false\)/,
  );
  assert.match(
    chatComposerBarSource,
    /editor\.scrollHeight - editor\.clientHeight > 1/,
  );
  assert.match(chatComposerBarSource, /new MutationObserver\(scheduleMeasure\)/);
  assert.match(
    chatComposerBarSource,
    /const showComposerExpandToggle = isComposerExpanded \|\| composerHasOverflow/,
  );
  assert.match(chatComposerBarSource, /\{showComposerExpandToggle \? \(\s*<button/);
});

test("context usage ring resets a stale confirm popover when compaction flips unavailable", () => {
  // When the compact-available branch flips back to display-only (another client
  // compacting/sending sets disabled, or usage falls back below the threshold
  // after compaction), confirmOpen must be reset during render: otherwise the
  // confirm popover auto-opens with no action once compaction becomes available
  // again, and while it lingers the mutual-exclusion guard keeps swallowing the
  // tooltip's open requests.
  assert.match(
    contextUsageRingSource,
    /if \(!compactAvailable && confirmOpen\) \{\s*setConfirmOpen\(false\);/,
  );
});

test("context usage ring tracks pointer form-factor changes via matchMedia subscription", () => {
  // Hot-switching between touch form factors (plugging a mouse/keyboard into an
  // iPad, flipping a convertible laptop) must take effect immediately; evaluation
  // must not be frozen at mount time.
  assert.match(
    contextUsageRingSource,
    /useSyncExternalStore\(\s*subscribeCoarsePointer,\s*isCoarsePointerNow/,
  );
  assert.match(contextUsageRingSource, /addEventListener\("change", onChange\)/);
});

test("contextUsageRatio guards degenerate inputs", () => {
  assert.equal(contextUsageRatio(100_000, 200_000), 0.5);
  assert.equal(contextUsageRatio(undefined, 200_000), 0);
  assert.equal(contextUsageRatio(100_000, undefined), 0);
  assert.equal(contextUsageRatio(100_000, 0), 0);
  assert.equal(contextUsageRatio(-1, 200_000), 0);
  assert.equal(contextUsageRatio(Number.NaN, 200_000), 0);
});

test("assistantAnchorTokens is the single anchor semantic: usage arithmetic only", () => {
  // stop + reasoning reported: exact arithmetic (prompt side + output - reasoning).
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 4_000, cacheRead: 500, output: 43_000, reasoning: 40_000 },
      stopReason: "stop",
    }),
    7_500,
  );
  // reasoning reported as 0: no deduction.
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 1_000, output: 200, reasoning: 0 },
      stopReason: "stop",
    }),
    1_200,
  );
  // reasoning missing: deduct estimated units from the caller-provided thinking body, with visible output floored at 0.
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 2_000, output: 400 },
      stopReason: "stop",
      thinkingTokenUnits: 250,
    }),
    2_150,
  );
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 1_000, output: 100 },
      stopReason: "stop",
      thinkingTokenUnits: 250.4,
    }),
    1_000,
  );
  // toolUse: reasoning/thinking is billed with the tool-round replay, output counts in full with no double counting.
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 2_000, output: 400, reasoning: 300 },
      stopReason: "toolUse",
      thinkingTokenUnits: 250,
    }),
    2_400,
  );
  // OpenAI Responses / signed thinking: still replayed after stop, so reasoning must not be deducted.
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 18_000, output: 2_366, reasoning: 1_543 },
      stopReason: "stop",
      replayReasoning: true,
    }),
    20_366,
  );
  // Prompt side entirely missing (relay reports only the total): totalTokens gets the same deduction, floored at 1.
  assert.equal(
    assistantAnchorTokens({ usage: { totalTokens: 5_000, reasoning: 2_000 } }),
    3_000,
  );
  assert.equal(
    assistantAnchorTokens({ usage: { totalTokens: 1_000 }, thinkingTokenUnits: 2_000 }),
    1,
  );
  // No usable usage at all: no anchoring.
  assert.equal(assistantAnchorTokens({ usage: undefined }), undefined);
  assert.equal(
    assistantAnchorTokens({ usage: { input: 0, output: 0, totalTokens: 0 } }),
    undefined,
  );
});

test("deriveContextUsageTokens reads the newest assistant round usage", () => {
  const items = [
    { kind: "user" },
    {
      kind: "assistant",
      rounds: [
        { meta: { usage: { totalTokens: 10_000 } } },
        { meta: { usage: { totalTokens: 12_000 } } },
      ],
    },
    { kind: "user" },
    {
      kind: "assistant",
      rounds: [{ meta: {} }, { meta: { usage: { totalTokens: 34_000 } } }, { meta: {} }],
    },
  ];
  assert.equal(deriveContextUsageTokens(items), 34_000);
});

test("deriveContextUsageTokens computes round anchors from usage arithmetic at read time", () => {
  // The anchor no longer carries a derived value in meta: the backward scan computes it live from usage + stopReason + the round's thinking blocks.
  const usage = { input: 100_000, cacheRead: 20_000, output: 5_000, reasoning: 4_000 };
  assert.equal(
    deriveContextUsageTokens([
      { kind: "assistant", rounds: [{ meta: { usage, stopReason: "stop" }, blocks: [] }] },
    ]),
    121_000,
  );
  assert.equal(
    deriveContextUsageTokens([
      { kind: "assistant", rounds: [{ meta: { usage, stopReason: "toolUse" }, blocks: [] }] },
    ]),
    125_000,
  );
  // No reasoning breakdown: deduct from an estimate of the round's thinking block body ("a" x 2000 = 500 units).
  assert.equal(
    deriveContextUsageTokens([
      {
        kind: "assistant",
        rounds: [
          {
            meta: { usage: { input: 50_000, output: 1_000 }, stopReason: "stop" },
            blocks: [{ kind: "thinking", text: "a".repeat(2_000) }],
          },
        ],
      },
    ]),
    50_500,
  );
});

test("deriveContextUsageTokens ignores render-only assistant rounds", () => {
  const items = [
    { kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 150_000 } }, blocks: [] }] },
    {
      kind: "assistant",
      rounds: [
        {
          meta: {
            contextRelevant: false,
            usage: { totalTokens: 10_000 },
          },
          blocks: [{ kind: "text", text: "memory extraction status" }],
        },
      ],
    },
  ];
  assert.equal(deriveContextUsageTokens(items), 150_000);
});

test("deriveContextUsageTokens adds messages and tool results after the newest usage", () => {
  const trailingUser = "x".repeat(80_000);
  const toolResultContent = [{ type: "text", text: "y".repeat(4_000) }];
  const items = [
    {
      kind: "assistant",
      rounds: [
        {
          meta: { usage: { totalTokens: 100_000 } },
          blocks: [
            {
              kind: "tool",
              item: {
                toolCall: { name: "Read", arguments: { path: "src/app.ts" } },
                toolResult: { content: toolResultContent },
              },
            },
          ],
        },
      ],
    },
    { kind: "user", text: trailingUser },
  ];
  // Tool results count only model-visible text (no longer the whole block JSON-serialized and estimated per character).
  const toolResultTokens = Math.ceil(contextUsage.estimateTextTokenUnits("y".repeat(4_000))) + 8;
  assert.equal(deriveContextUsageTokens(items), 120_008 + toolResultTokens);
});

test("deriveContextUsageTokens prices binary tool payloads flat and ignores details", () => {
  const items = [
    {
      kind: "assistant",
      rounds: [
        {
          meta: { usage: { totalTokens: 10_000 } },
          blocks: [
            {
              kind: "tool",
              item: {
                toolCall: { name: "Read", arguments: { path: "shot.png" } },
                toolResult: {
                  content: [{ type: "image", data: "A".repeat(1_000_000), mimeType: "image/png" }],
                  details: { stdout: "C".repeat(400_000) },
                },
              },
            },
          ],
        },
      ],
    },
  ];
  // The anchor round's own tool results are added in: images use a pricing
  // constant rather than base64/4 (the latter over-reports 250k tokens and makes
  // the ring jump), and details are not sent to the model and not counted.
  assert.equal(deriveContextUsageTokens(items), 10_000 + contextUsage.BINARY_BLOCK_TOKENS + 8);
});

test("deriveContextUsageTokens falls back to checkpoint estimate after compaction", () => {
  const summaryText = "Summary body text ".repeat(50);
  // GUI checkpoints (kind:"summary") and WebUI checkpoints (kind:"checkpoint") use the same basis.
  for (const kind of ["summary", "checkpoint"]) {
    const items = [
      { kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 190_000 } } }] },
      { kind, content: summaryText },
    ];
    const derived = deriveContextUsageTokens(items);
    assert.equal(derived, estimateTextTokens(summaryText));
    assert.ok(derived > 0, "checkpoint estimate must keep the ring alive");
    assert.ok(derived < 190_000, "estimate must reflect the freed context");
  }
});

test("deriveContextUsageTokens prefers checkpoint fixed overhead and adds its trailing messages", () => {
  const items = [
    { kind: "checkpoint", content: "short summary", contextUsageTokens: 40_000 },
    { kind: "user", text: "x".repeat(4_000) },
  ];
  assert.equal(deriveContextUsageTokens(items), 41_008);
});

test("deriveContextUsageTokens counts user attachment metadata after the anchor", () => {
  const attachment = {
    relativePath: "uploads/diagram.png",
    fileName: "diagram.png",
    kind: "image",
    sizeBytes: 123_456,
  };
  const anchor = { kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 50_000 } } }] };
  const text = "take a look at this image";
  const textOnly = deriveContextUsageTokens([anchor, { kind: "user", text }]);
  const withAttachment = deriveContextUsageTokens([
    anchor,
    { kind: "user", text, attachments: [attachment] },
  ]);
  assert.ok(withAttachment > textOnly, "attachment metadata must count in the trailing estimate");
  assert.equal(
    withAttachment,
    50_000 +
      Math.ceil(
        contextUsage.estimateTextTokenUnits(text) +
          contextUsage.stringifiedTokenUnits(attachment),
      ) +
      8,
  );
});

test("deriveContextUsageTokens counts attachment-only user messages", () => {
  // Attachment-only messages (empty body) used to count as zero entirely.
  const attachment = {
    relativePath: "uploads/error.log",
    fileName: "error.log",
    kind: "text",
    sizeBytes: 2_048,
  };
  assert.equal(
    deriveContextUsageTokens([
      { kind: "checkpoint", content: "short summary", contextUsageTokens: 40_000 },
      { kind: "user", text: "", attachments: [attachment] },
    ]),
    40_000 + Math.ceil(contextUsage.stringifiedTokenUnits(attachment)) + 8,
  );
});

test("deriveContextUsageTokens returns undefined without any usage", () => {
  assert.equal(deriveContextUsageTokens([]), undefined);
  assert.equal(deriveContextUsageTokens([{ kind: "user" }]), undefined);
  assert.equal(
    deriveContextUsageTokens([{ kind: "assistant", rounds: [{ meta: {} }] }]),
    undefined,
  );
  // All-zero usage (relay anomaly) likewise does not anchor.
  assert.equal(
    deriveContextUsageTokens([
      {
        kind: "assistant",
        rounds: [{ meta: { usage: { input: 0, output: 0, totalTokens: 0 } } }],
      },
    ]),
    undefined,
  );
});

test("deriveContextUsageTokens never anchors on hosted-search rounds", () => {
  // Measured data: the search turn reports usage 117,996 (an aggregate of several
  // server-side internal calls), while the next turn's persisted context is only
  // 52k. Rounds containing hostedSearch blocks must skip anchoring and accumulate
  // content by estimate, and the hostedSearch block itself (stripped on the
  // request side) contributes no estimate at all.
  const searchRound = {
    meta: { usage: { input: 110_008, cacheRead: 5_184, output: 2_804, totalTokens: 117_996 } },
    blocks: [
      { kind: "text", text: "combined search results..." },
      { kind: "hostedSearch", hostedSearch: { queries: ["news"], sources: [{ url: "u".repeat(4_000) }] } },
    ],
  };
  const plainRound = {
    blocks: [{ kind: "text", text: "combined search results..." }],
  };

  // Search round at the end: skip its aggregate anchor and fall back to an earlier trusted anchor + an estimate of the search round's body.
  const withEarlierAnchor = deriveContextUsageTokens([
    { kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 30_000 } }, blocks: [] }] },
    { kind: "assistant", rounds: [searchRound] },
  ]);
  const searchRoundEstimate = deriveContextUsageTokens([
    { kind: "assistant", rounds: [{ blocks: searchRound.blocks }] },
  ]);
  assert.equal(withEarlierAnchor, 30_000 + searchRoundEstimate);
  // The hostedSearch block contributes no estimate: identical to the estimate for a plain-text round.
  assert.equal(
    searchRoundEstimate,
    deriveContextUsageTokens([{ kind: "assistant", rounds: [{ blocks: plainRound.blocks }] }]),
  );

  // Entire conversation is only the search round: no anchor, fall back to an estimate (never display the 117,996 aggregate).
  assert.notEqual(
    deriveContextUsageTokens([{ kind: "assistant", rounds: [searchRound] }]),
    117_996,
  );

  // A normal round after the search round anchors as usual (the user conversation's second request is what corrects the reading).
  assert.equal(
    deriveContextUsageTokens([
      { kind: "assistant", rounds: [searchRound] },
      {
        kind: "assistant",
        rounds: [{ meta: { usage: { totalTokens: 52_730 } }, blocks: [] }],
      },
    ]),
    52_730,
  );
});

test("Responses thinking signatures are replayed, not the UI summary", () => {
  const signature = JSON.stringify({
    id: "rs_1",
    type: "reasoning",
    content: [],
    encrypted_content: "A".repeat(1_612),
    summary: [{ type: "summary_text", text: "plan" }],
  });
  assert.equal(isResponsesReasoningSignature(signature), true);
  assert.equal(isResponsesReasoningSignature("reasoning_content"), false);
  const summary = "short summary";
  const replay = estimateThinkingReplayTokenUnits({
    thinking: summary,
    thinkingSignature: signature,
  });
  assert.ok(replay > estimateTextTokenUnits(signature));
  assert.ok(replay > estimateTextTokenUnits(summary) * 5);
});

test("hosted-search idle scan counts Responses replay and does not jump 19k→30k", () => {
  // Measured conversation 02fb1f14: idle is ~19k after the search round ends
  // (counting only the summary), while the next short reply's real usage is
  // 32_286. The backward scan must include the thinkingSignature replay amount.
  const replayTokenUnits = Math.ceil(
    estimateTextTokenUnits(
      JSON.stringify({
        id: "rs",
        type: "reasoning",
        encrypted_content: "A".repeat(17_140),
      }),
    ),
  );
  const searchRound = {
    meta: {
      api: "openai-responses",
      stopReason: "stop",
      usage: { input: 80_509, cacheRead: 3_456, output: 2_366, reasoning: 1_543, totalTokens: 86_331 },
    },
    blocks: [
      { kind: "thinking", text: "short summary", replayTokenUnits },
      { kind: "hostedSearch", item: { queries: ["Xi'an"], sources: [] } },
      { kind: "text", text: "Xi'an news roundup for today" },
    ],
  };
  const items = [
    { kind: "user", text: "please search the web for today's news about Xi'an" },
    { kind: "assistant", rounds: [searchRound] },
  ];
  assert.equal(hasContextUsageUsageAnchor(items), false);
  const idle = deriveContextUsageTokens(items, { unanchoredFixedTokens: 17_000 });
  const withoutReplay = deriveContextUsageTokens(
    [
      items[0],
      {
        kind: "assistant",
        rounds: [
          {
            ...searchRound,
            blocks: [
              { kind: "thinking", text: "short summary" },
              { kind: "hostedSearch", item: { queries: ["Xi'an"], sources: [] } },
              { kind: "text", text: "Xi'an news roundup for today" },
            ],
          },
        ],
      },
    ],
    { unanchoredFixedTokens: 17_000 },
  );
  assert.ok(idle > withoutReplay + 3_000, `replay must lift idle: ${idle} vs ${withoutReplay}`);
  assert.notEqual(idle, 86_331);

  const afterThanks = deriveContextUsageTokens(
    [
      ...items,
      { kind: "user", text: "thanks" },
      {
        kind: "assistant",
        rounds: [
          {
            meta: {
              api: "openai-responses",
              stopReason: "stop",
              usage: { input: 3_149, cacheRead: 29_056, output: 81, totalTokens: 32_286 },
            },
            blocks: [{ kind: "text", text: "you're welcome" }],
          },
        ],
      },
    ],
    { unanchoredFixedTokens: 17_000 },
  );
  assert.equal(afterThanks, 32_286);
  assert.ok(
    afterThanks - idle < afterThanks - withoutReplay,
    `new idle must shrink the 19k→32k jump: idle=${idle} old=${withoutReplay} real=${afterThanks}`,
  );
});

test("warm hosted-search idle uses cacheRead+output so a short reply does not drop 36k→32k", () => {
  // Measured conversation b96f6ab6: a warm-cache search round has cacheRead 30080
  // and output 2965. Estimating the encrypted signature at 0.4/char would lift the
  // idle ring to ~36k; the next short reply's real usage is 32703.
  const searchUsage = {
    input: 53_290,
    cacheRead: 30_080,
    output: 2_965,
    reasoning: 2_057,
    totalTokens: 86_335,
  };
  assert.equal(hostedSearchFollowUpTokens(searchUsage), 33_045);
  assert.equal(hostedSearchFollowUpTokens(searchUsage, 26_466), 33_045);
  assert.equal(
    hostedSearchFollowUpTokens({
      input: 80_509,
      cacheRead: 3_456,
      output: 2_366,
      totalTokens: 86_331,
    }),
    undefined,
  );
  assert.equal(
    isStrippedHostedSearchUsage({ input: 0, cacheRead: 30_080, output: 2_965, totalTokens: 0 }),
    true,
  );
  assert.equal(
    isStrippedHostedSearchUsage(searchUsage),
    false,
  );

  const searchRound = {
    meta: { api: "openai-responses", stopReason: "stop", usage: searchUsage },
    blocks: [
      { kind: "thinking", text: "short summary", replayTokenUnits: 8_674 },
      { kind: "hostedSearch", item: { queries: ["Xi'an"], sources: [] } },
      { kind: "text", text: "Xi'an news roundup for today" },
    ],
  };
  const items = [
    { kind: "user", text: "please search the web for today's news about Xi'an" },
    { kind: "assistant", rounds: [searchRound] },
  ];
  assert.equal(hasContextUsageUsageAnchor(items, { unanchoredFixedTokens: 26_466 }), true);
  const idle = deriveContextUsageTokens(items, { unanchoredFixedTokens: 26_466 });
  assert.equal(idle, 33_045);
  assert.notEqual(idle, 86_335);

  const afterThanks = deriveContextUsageTokens(
    [
      ...items,
      { kind: "user", text: "ok" },
      {
        kind: "assistant",
        rounds: [
          {
            meta: {
              api: "openai-responses",
              stopReason: "stop",
              usage: { input: 3_588, cacheRead: 29_056, output: 59, totalTokens: 32_703 },
            },
            blocks: [{ kind: "text", text: "you're welcome" }],
          },
        ],
      },
    ],
    { unanchoredFixedTokens: 26_466 },
  );
  assert.equal(afterThanks, 32_703);
  assert.ok(
    Math.abs(afterThanks - idle) < 500,
    `warm idle must stay within hundreds of the next real usage: idle=${idle} real=${afterThanks}`,
  );
});

test("openai-responses usage rounds keep reasoning in the stop anchor", () => {
  // A Responses round without hostedSearch: api + reasoning means it will replay, so stop does not deduct.
  assert.equal(
    deriveContextUsageTokens([
      {
        kind: "assistant",
        rounds: [
          {
            meta: {
              api: "openai-responses",
              stopReason: "stop",
              usage: { input: 18_000, output: 2_000, reasoning: 1_500 },
            },
            blocks: [{ kind: "thinking", text: "plan" }],
          },
        ],
      },
    ]),
    20_000,
  );
});

test("ledger and idle scan agree on the same round so settle never jumps", () => {
  // In-flight (ledger) and idle (backward scan) must give the same reading for
  // the same round: both compute the same formula live from usage + stopReason +
  // the thinking body.
  const thinking = "reasoning process ".repeat(100);
  const messageUsage = {
    input: 40_000,
    cacheRead: 8_000,
    output: 900,
    cacheWrite: 0,
    totalTokens: 48_900,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const ledgerReading = tokenLedger.getMessageObservedTokens({
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text: "conclusion" },
    ],
    stopReason: "stop",
    usage: messageUsage,
    timestamp: 2,
  });
  const scanReading = deriveContextUsageTokens([
    {
      kind: "assistant",
      rounds: [
        {
          meta: { usage: messageUsage, stopReason: "stop" },
          blocks: [
            { kind: "thinking", text: thinking },
            { kind: "text", text: "conclusion" },
          ],
        },
      ],
    },
  ]);
  assert.equal(ledgerReading, scanReading);
  const thinkingTokens = Math.ceil(contextUsage.estimateTextTokenUnits(thinking));
  assert.equal(ledgerReading, 48_000 + Math.max(0, 900 - thinkingTokens));
});

test("deriveContextUsageTokens adds fixed overhead only when unanchored", () => {
  // Without an anchor the backward scan counts only visible text; not adding
  // fixed (system+tools estimate) would oscillate against the in-flight ledger
  // reading (which includes fixed) -- on conversations where the provider does
  // not return usage, the ring jumps on every settle.
  const items = [{ kind: "user", text: "a".repeat(400) }];
  const base = deriveContextUsageTokens(items);
  assert.equal(base, 100 + 8);
  assert.equal(
    deriveContextUsageTokens(items, { unanchoredFixedTokens: 2_000 }),
    base + 2_000,
  );
  // With a usage anchor the reading already includes fixed, so never add it again.
  const anchored = [
    { kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 50_000 } } }] },
  ];
  assert.equal(
    deriveContextUsageTokens(anchored, { unanchoredFixedTokens: 2_000 }),
    50_000,
  );
  // Completely empty transcript + fixed: the reading is fixed itself (system+tools really occupy context).
  assert.equal(deriveContextUsageTokens([], { unanchoredFixedTokens: 2_000 }), 2_000);
  assert.equal(deriveContextUsageTokens([], { unanchoredFixedTokens: 0 }), undefined);
});

test("deriveContextUsageTokens adds fixed overhead to legacy checkpoint estimates only", () => {
  const summaryText = "legacy checkpoint summary body".repeat(30);
  // Legacy history checkpoints have no authoritative snapshot: the body estimate excludes system/tools, so fixed must be added to match the basis.
  assert.equal(
    deriveContextUsageTokens([{ kind: "summary", content: summaryText }], {
      unanchoredFixedTokens: 1_500,
    }),
    estimateTextTokens(summaryText) + 1_500,
  );
  // The authoritative snapshot (contextUsageTokens) comes from deriveContextTokens and already includes fixed.
  assert.equal(
    deriveContextUsageTokens(
      [{ kind: "checkpoint", content: summaryText, contextUsageTokens: 40_000 }],
      { unanchoredFixedTokens: 1_500 },
    ),
    40_000,
  );
});

test("JSON / tool-schema estimates are denser than prose chars/4", () => {
  // Tool definitions are JSON schema: o200k runs about 2.5 chars/token. chars/4
  // would make fixedTokens 4-8k short of the real first-turn prompt (later
  // search-turn cacheRead is still steady at ~29k).
  const schema = JSON.stringify({
    type: "object",
    properties: {
      path: { type: "string", description: "workspace-relative path" },
      limit: { type: "number", minimum: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  }).repeat(40);
  const prose = estimateTextTokens(schema);
  const json = estimateJsonTokens(schema);
  assert.ok(json > prose, `json=${json} must exceed prose=${prose}`);
  assert.equal(json, Math.ceil(schema.length * 0.4));
  // CJK still uses 0.7 and is not suppressed by the JSON basis.
  assert.equal(estimateJsonTokens("アイ".repeat(10)), Math.ceil(20 * 0.7));
  // estimateToolsTokens must use the JSON basis, or the ledger's fixed stays on chars/4.
  const tools = [{ name: "Read", description: "d".repeat(200), parameters: { type: "object" } }];
  assert.equal(tokenLedger.estimateToolsTokens(tools), estimateJsonTokens(JSON.stringify(tools)));
  assert.ok(tokenLedger.estimateToolsTokens(tools) > estimateTextTokens(JSON.stringify(tools)));
});

test("estimateTextTokens keeps the CJK-aware estimate after the move to shared", () => {
  // The tokenLedger re-export and the shared-layer implementation must be the same function (the migration must not change the basis).
  assert.equal(tokenLedger.estimateTextTokens, estimateTextTokens);
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("   "), 0);
  // 4 Latin characters ~= 1 token; each CJK character is 0.7 token (rounded up).
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("あいうえ"), Math.ceil(4 * 0.7));
  // Additivity: the sum of the segments = the whole (concatenating the same string).
  const west = "hello world ";
  const cjk = "コンテキスト";
  assert.equal(
    Math.ceil(
      contextUsage.estimateTextTokenUnits(west) + contextUsage.estimateTextTokenUnits(cjk),
    ),
    estimateTextTokens(west + cjk),
  );
});

test("deriveContextTokens includes system, tools, and messages without an observed usage", () => {
  const context = {
    systemPrompt: "system instructions",
    tools: [{ name: "Read", description: "read a file", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "continue", timestamp: 1 }],
  };
  assert.equal(
    tokenLedger.deriveContextTokens(context),
    estimateTextTokens(context.systemPrompt) +
      tokenLedger.estimateToolsTokens(context.tools) +
      tokenLedger.estimateMessageTokens(context.messages[0]),
  );
});

test("buildContextUsageScanItems appends live rounds so streaming anchors the ring in real time", () => {
  const history = [{ kind: "user", text: "hi" }];
  const liveRounds = [
    {
      round: 1,
      key: "r1",
      blocks: [],
      meta: { usage: { totalTokens: 120_000 } },
      runningToolCallIds: [],
      thinkingOpen: false,
    },
  ];
  const items = buildContextUsageScanItems(history, {
    liveRounds,
    draftAssistantText: "",
  });
  assert.equal(items.length, 2);
  assert.equal(deriveContextUsageTokens(items), 120_000);
  // When idle (no live), pass history items through unchanged.
  assert.equal(buildContextUsageScanItems(history, null), history);
});

test("buildContextUsageScanItems counts the streaming draft as a trailing round", () => {
  const draft = "x".repeat(4_000);
  const items = buildContextUsageScanItems(
    [{ kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 50_000 } } }] }],
    { liveRounds: [], draftAssistantText: draft },
  );
  assert.equal(
    deriveContextUsageTokens(items),
    50_000 + Math.ceil(contextUsage.estimateTextTokenUnits(draft)) + 8,
  );
});

// Real DOM acceptance for the ring's hideBelowWarn
// (docs/design/composer-context-stats-bar.md §4.5 division of semantics, §9 component layer).
// The DOM env is created/destroyed inside the case: the rest of this file is pure
// functions and needs no jsdom globals.
async function withRing(run) {
  const env = await createDomTestEnv();
  try {
    const { React, act, createRoot } = env;
    const doc = env.dom.window.document;
    const { ContextUsageRing } = env.loadModule(
      "@liveagent/ui/components/chat/ContextUsageRing.tsx",
    );
    const { LocaleContext } = env.loadModule("@liveagent/ui/i18n/LocaleContext.tsx");
    const { t: translate } = env.loadModule("@liveagent/app/i18n/config.ts");
    const locale = { locale: "en-US", t: (key) => translate(key, "en-US") };

    const container = doc.createElement("div");
    doc.body.appendChild(container);
    const root = createRoot(container);
    const paint = async (props) => {
      await act(async () => {
        root.render(
          React.createElement(
            LocaleContext.Provider,
            { value: locale },
            React.createElement(ContextUsageRing, { contextWindow: 100_000, ...props }),
          ),
        );
      });
      return container.innerHTML;
    };

    await run(paint);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  } finally {
    env.cleanup();
  }
}

test("context usage ring hides below the warn ratio and reappears exactly at 50%", async () => {
  await withRing(async (paint) => {
    // The threshold is inclusive, the same basis as canManualCompact: the ring appears exactly when it can carry a compaction entry point.
    assert.equal(await paint({ totalTokens: 49_000, hideBelowWarn: true }), "", "should hide at 49%");
    const atThreshold = await paint({ totalTokens: 50_000, hideBelowWarn: true });
    assert.notEqual(atThreshold, "", "must appear at 50%");
    assert.match(atThreshold, /50%/);
    // The ring tracks "current context usage" (instantaneous, falling back after compaction), complementing the status bar's cumulative reading.
    assert.equal(
      await paint({ totalTokens: 12_000, hideBelowWarn: true }),
      "",
      "usage falling back below the threshold after compaction should hide again",
    );
  });
});

test("context usage ring still renders at low usage without hideBelowWarn", async () => {
  await withRing(async (paint) => {
    // Defaults to false: other callers (non-composer) are unaffected by this change.
    const lowUsage = await paint({ totalTokens: 12_000 });
    assert.notEqual(lowUsage, "", "low usage still renders when hideBelowWarn is not passed");
    assert.match(lowUsage, /12%/);
  });
});

test("composer renders ring and stats bar per three-state contextDisplayMode", () => {
  // Three modes (docs/design/composer-context-stats-bar.md §4.7): in ring/both mode
  // the ring always shows (the composer does not pass hideBelowWarn, so even low
  // usage must not hide); in statsBar mode the whole ring is not rendered; the
  // statsBar slot is unmounted only in ring mode -- it renders in both statsBar and
  // both modes.
  assert.match(
    chatComposerBarSource,
    /\{contextDisplayMode === "ring" \|\| contextDisplayMode === "both" \? \(/,
  );
  assert.match(
    chatComposerBarSource,
    /statsBar && approvalBar == null && contextDisplayMode !== "ring"/,
  );
  assert.doesNotMatch(chatComposerBarSource, /hideBelowWarn/);
});
