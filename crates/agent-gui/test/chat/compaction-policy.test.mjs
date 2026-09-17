import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const policy = loader.loadModule("src/lib/chat/compaction/policy.ts");

const NOW = 1_700_000_000_000;
const modelConfig = { contextWindow: 200_000, maxOutputToken: 32_000 };

function decide(overrides = {}) {
  return policy.decideCompaction({
    intent: "optimization",
    totalTokens: 0,
    modelConfig,
    activeMessageCount: 10,
    userMessageCount: 5,
    lastCompactionAt: 0,
    pressure: policy.createCompactionPressure(),
    inFlight: false,
    now: NOW,
    ...overrides,
  });
}

test("threshold: every provider reserves the output buffer from the total window", () => {
  assert.equal(
    policy.resolveCompactionThreshold({
      intent: "optimization",
      contextWindow: 200_000,
      maxOutputToken: 32_000,
      pressureLevel: 0,
    }),
    200_000 - 32_000 * 1.5,
  );

  assert.equal(
    policy.resolveCompactionThreshold({
      intent: "protection",
      contextWindow: 200_000,
      maxOutputToken: 32_000,
      pressureLevel: 0,
    }),
    200_000 - 32_000 * 1.2,
  );

  // Codex catalog model (total window = 272K input budget + 128K output, already converted for
  // the generation): the protection threshold never exceeds the real input limit
  // (400K - 1.2x128K = 246.4K < 272K).
  assert.equal(
    policy.resolveCompactionThreshold({
      intent: "protection",
      contextWindow: 400_000,
      maxOutputToken: 128_000,
      pressureLevel: 0,
    }),
    400_000 - 128_000 * 1.2,
  );
});

test("threshold: sustained pressure pins the protection factor to 1.0", () => {
  const pinned = policy.resolveCompactionThreshold({
    intent: "protection",
    contextWindow: 200_000,
    maxOutputToken: 32_000,
    pressureLevel: 2,
  });
  assert.equal(pinned, 200_000 - 32_000);

  const optimizationUnchanged = policy.resolveCompactionThreshold({
    intent: "optimization",
    contextWindow: 200_000,
    maxOutputToken: 32_000,
    pressureLevel: 2,
  });
  assert.equal(optimizationUnchanged, 200_000 - 32_000 * 1.5);
});

test("decideCompaction covers every reason", () => {
  assert.equal(decide({ modelConfig: undefined }).reason, "disabled");
  assert.equal(decide({ activeMessageCount: 0, totalTokens: 999_999 }).reason, "no-active-messages");
  assert.equal(decide({ inFlight: true, totalTokens: 999_999 }).reason, "in-flight");
  assert.equal(decide({ totalTokens: 10_000 }).reason, "below-threshold");

  const cooldown = decide({
    totalTokens: 199_000,
    lastCompactionAt: NOW - 30_000,
    userMessageCount: 1,
  });
  assert.equal(cooldown.reason, "cooldown");
  assert.equal(cooldown.shouldCompact, false);

  // Within the cooldown window but user messages are already sufficient -> allow compaction (to prevent a huge single turn from getting stuck).
  assert.equal(
    decide({ totalTokens: 199_000, lastCompactionAt: NOW - 30_000, userMessageCount: 3 }).reason,
    "threshold-exceeded",
  );

  const fire = decide({ totalTokens: 199_000 });
  assert.equal(fire.shouldCompact, true);
  assert.equal(fire.reason, "threshold-exceeded");
  assert.equal(fire.threshold, 152_000);
});

// A live relay (provider-declared limits, limitsSource "provider") publishes
// degraded output caps of 72-90% of the window for models whose real output
// cap is a tenth of that. Before the reserve cap, 1.5x of such a "reserve"
// exceeded the window and the threshold fell to the 1024 floor: compaction
// fired on every turn while the usage ring read 1-5%. The exact numbers from
// the reported conversation are pinned here.
test("threshold: an inflated relay output cap cannot collapse compaction to the floor", () => {
  // z-ai/glm-5.3 as declared by the relay: 1,310,720-token window, 943,718
  // declared output (72% of it). Uncapped, the optimization threshold is
  // 1,310,720 - 1.5*943,718 < 0 -> the 1024 floor.
  const glm = policy.resolveCompactionThreshold({
    intent: "optimization",
    contextWindow: 1_310_720,
    maxOutputToken: 943_718,
    pressureLevel: 0,
  });
  // The reserve is capped at a third of the window (436,906), so the
  // threshold sits at exactly half the window — not the floor.
  assert.equal(glm, 1_310_720 - Math.floor(1_310_720 / 3) * 1.5);
  assert.equal(glm, 655_361);
  assert.ok(glm >= 1_310_720 / 2, "compaction must not fire below half the window");

  // meta/muse-spark-1.3 declared output at 90% of its 1,048,576 window.
  const muse = policy.resolveCompactionThreshold({
    intent: "optimization",
    contextWindow: 1_048_576,
    maxOutputToken: 943_718,
    pressureLevel: 0,
  });
  assert.ok(muse >= 1_048_576 / 2, "the 90%-output case is also rescued");

  // z-ai/glm-5.1: 128,000 of 204,800 (62.5%) — the case that compacted at
  // 6.25% of the window.
  const glm51 = policy.resolveCompactionThreshold({
    intent: "optimization",
    contextWindow: 204_800,
    maxOutputToken: 128_000,
    pressureLevel: 0,
  });
  assert.ok(glm51 >= 204_800 / 2, "the just-under-two-thirds case is rescued too");

  // End to end: with the relay's glm-5.3 limits, a 30,000-token context
  // (system prompt + tools alone) must be below threshold, where it used to
  // compact every turn.
  const decision = decide({
    modelConfig: { contextWindow: 1_310_720, maxOutputToken: 943_718 },
    totalTokens: 30_000,
  });
  assert.equal(decision.reason, "below-threshold");
  assert.equal(decision.shouldCompact, false);
  assert.equal(decision.threshold, 655_361);
});

test("threshold: honest output caps are untouched by the reserve cap", () => {
  // claude (16% of window) and codex (32% — the real GPT-5 output cap) both
  // sit under the window/3 cap and must keep their exact thresholds.
  assert.equal(
    policy.resolveCompactionThreshold({
      intent: "optimization",
      contextWindow: 200_000,
      maxOutputToken: 32_000,
      pressureLevel: 0,
    }),
    200_000 - 32_000 * 1.5,
  );
  assert.equal(
    policy.resolveCompactionThreshold({
      intent: "protection",
      contextWindow: 400_000,
      maxOutputToken: 128_000,
      pressureLevel: 0,
    }),
    400_000 - 128_000 * 1.2,
  );
});

test("pressure escalates on consecutive ineffective compactions and resets on an effective one", () => {
  let pressure = policy.createCompactionPressure();
  assert.equal(pressure.level, 0);

  // Still above 90% of the threshold after compaction = inefficient.
  pressure = policy.notePressureAfterCompaction(pressure, {
    totalTokensAfter: 150_000,
    threshold: 160_000,
    now: NOW,
  });
  assert.equal(pressure.level, 1);
  assert.equal(pressure.consecutiveIneffective, 1);
  assert.equal(pressure.compactionsApplied, 1);

  pressure = policy.notePressureAfterCompaction(pressure, {
    totalTokensAfter: 150_000,
    threshold: 160_000,
    now: NOW + 1000,
  });
  assert.equal(pressure.level, 2);

  // Never hard-reject: the third inefficient result still stays at the highest tier rather than forbidding compaction.
  pressure = policy.notePressureAfterCompaction(pressure, {
    totalTokensAfter: 150_000,
    threshold: 160_000,
    now: NOW + 2000,
  });
  assert.equal(pressure.level, 2);
  assert.equal(pressure.consecutiveIneffective, 3);

  pressure = policy.notePressureAfterCompaction(pressure, {
    totalTokensAfter: 20_000,
    threshold: 160_000,
    now: NOW + 3000,
  });
  assert.equal(pressure.level, 0);
  assert.equal(pressure.consecutiveIneffective, 0);
  assert.equal(pressure.compactionsApplied, 4);
});

test("pressure decays outside the recent-compaction window", () => {
  let pressure = policy.notePressureAfterCompaction(policy.createCompactionPressure(), {
    totalTokensAfter: 150_000,
    threshold: 160_000,
    now: NOW,
  });
  pressure = policy.notePressureAfterCompaction(pressure, {
    totalTokensAfter: 150_000,
    threshold: 160_000,
    now: NOW + 1000,
  });
  assert.equal(pressure.level, 2);

  const withinWindow = policy.normalizeCompactionPressure(pressure, NOW + 2 * 60_000);
  assert.equal(withinWindow.level, 2);

  const decayed = policy.normalizeCompactionPressure(pressure, NOW + 6 * 60_000);
  assert.equal(decayed.level, 0);
  assert.equal(decayed.consecutiveIneffective, 0);
  assert.equal(decayed.compactionsApplied, 2);
});

test("prune options escalate with pressure level", () => {
  const level0 = policy.resolvePruneOptions(policy.createCompactionPressure());
  assert.deepEqual(level0, {
    minimumReleasedTokens: 20_000,
    protectedToolTokens: 40_000,
    protectedRecentUserTurns: 2,
  });

  const level1 = policy.resolvePruneOptions({
    level: 1,
    consecutiveIneffective: 1,
    compactionsApplied: 1,
    lastCompactionAt: NOW,
  });
  assert.equal(level1.protectedToolTokens, 20_000);
  assert.equal(level1.protectedRecentUserTurns, 2);

  const level2 = policy.resolvePruneOptions({
    level: 2,
    consecutiveIneffective: 2,
    compactionsApplied: 2,
    lastCompactionAt: NOW,
  });
  assert.equal(level2.protectedToolTokens, 10_000);
  assert.equal(level2.protectedRecentUserTurns, 1);
});

test("prune-first fires on recent compaction or raised pressure; advisory at max level", () => {
  const fresh = policy.createCompactionPressure();
  assert.equal(policy.shouldPruneBeforeCompaction(fresh, NOW), false);

  const recent = { ...fresh, compactionsApplied: 1, lastCompactionAt: NOW - 2 * 60_000 };
  assert.equal(policy.shouldPruneBeforeCompaction(recent, NOW), true);

  const stale = { ...fresh, compactionsApplied: 1, lastCompactionAt: NOW - 10 * 60_000 };
  assert.equal(policy.shouldPruneBeforeCompaction(stale, NOW), false);

  assert.equal(policy.isNearModelLimit(fresh), false);
  assert.equal(
    policy.isNearModelLimit({ ...fresh, level: 2, consecutiveIneffective: 2 }),
    true,
  );
});

// Settings-driven compaction mode: "off" disables everything (manual included), "manualOnly"
// turns the automatic triggers off while the manual bypass still passes through, and "auto"/
// undefined keeps today's behavior.
test("decideCompaction honors the history compaction mode", () => {
  // "off" always refuses — even the manual bypass and even with oversized tokens.
  for (const bypass of [undefined, true]) {
    const decision = decide({
      mode: "off",
      totalTokens: 199_000,
      bypassThresholdAndCooldown: bypass,
    });
    assert.equal(decision.shouldCompact, false);
    assert.equal(decision.reason, "disabled");
    assert.equal(decision.threshold, 0);
  }
  // "off" wins even before the contextWindow data gate.
  assert.equal(decide({ mode: "off", modelConfig: undefined }).reason, "disabled");

  // "manualOnly" rejects the automatic intents but passes the manual bypass through untouched.
  const autoRejected = decide({ mode: "manualOnly", totalTokens: 199_000 });
  assert.equal(autoRejected.shouldCompact, false);
  assert.equal(autoRejected.reason, "disabled-by-settings");
  const manualAllowed = decide({
    mode: "manualOnly",
    totalTokens: 199_000,
    bypassThresholdAndCooldown: true,
  });
  assert.equal(manualAllowed.shouldCompact, true);
  assert.equal(manualAllowed.reason, "threshold-exceeded");

  // "auto"/undefined keeps the default behavior.
  assert.equal(decide({ mode: "auto", totalTokens: 199_000 }).shouldCompact, true);
  assert.equal(decide({ totalTokens: 199_000 }).shouldCompact, true);
  assert.equal(decide({ totalTokens: 10_000 }).reason, "below-threshold");
});
