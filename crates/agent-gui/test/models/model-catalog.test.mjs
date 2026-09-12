import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const catalog = loader.loadModule("@liveagent/ui/lib/models/modelCatalog.ts");

// Same values as the SECTIONS in scripts/generate-model-catalog.mjs (keys, order, quality gate):
// a truncated upstream makes refresh hard-fail, so this locks the integrity of the already
// checked-in snapshot. The first four are the native directories for app provider types; the rest
// are domestic-vendor sections consumed only via cross-provider lookup.
const MIN_MODELS_PER_PROVIDER = {
  anthropic: 8,
  google: 15,
  openai: 20,
  xai: 3,
  deepseek: 2,
  zhipuai: 10,
  moonshotai: 8,
  minimax: 5,
  stepfun: 4,
  xiaomi: 4,
  longcat: 1,
  alibaba: 40,
  tencent: 4,
};
const PROVIDERS = Object.keys(MIN_MODELS_PER_PROVIDER);

// Same values as the generator script's INPUT_MODALITIES: the full legal value set and canonical order for inputModalities.
const INPUT_MODALITIES = ["text", "image", "audio", "video", "pdf"];

test("generated catalog upholds the data invariants", () => {
  assert.deepEqual(
    Object.keys(catalog.MODEL_CATALOG),
    PROVIDERS,
    "catalog sections must match the generator's SECTIONS (keys and order)",
  );
  // Cross-provider lookup (findCatalogModelAcrossProviders) and the index's lowercase aliases rely
  // on ids being lowercase-unique across the whole catalog, otherwise same-named models in
  // different sections cause ambiguous hits.
  const allIds = PROVIDERS.flatMap((providerId) =>
    catalog.MODEL_CATALOG[providerId].map((entry) => entry.id.toLowerCase()),
  );
  assert.equal(new Set(allIds).size, allIds.length, "ids must be lowercase-unique across sections");
  for (const providerId of PROVIDERS) {
    const entries = catalog.MODEL_CATALOG[providerId];
    assert.ok(
      entries.length >= MIN_MODELS_PER_PROVIDER[providerId],
      `${providerId}: expected >= ${MIN_MODELS_PER_PROVIDER[providerId]} models, got ${entries.length}`,
    );
    const ids = entries.map((entry) => entry.id);
    assert.deepEqual(ids, [...ids].sort(), `${providerId}: ids must be sorted`);
    assert.equal(new Set(ids).size, ids.length, `${providerId}: ids must be unique`);
    for (const entry of entries) {
      const label = `${providerId}/${entry.id}`;
      assert.ok(Number.isInteger(entry.contextWindow) && entry.contextWindow > 0, label);
      assert.ok(Number.isInteger(entry.maxOutputToken) && entry.maxOutputToken > 0, label);
      // A uniform semantic rule is applied at generation time: output is always less than the window, and the runtime rule treats it as a fixed point.
      assert.ok(entry.maxOutputToken < entry.contextWindow, `${label}: output must be < context`);
      const limits = { contextWindow: entry.contextWindow, maxOutputToken: entry.maxOutputToken };
      assert.deepEqual(catalog.normalizeModelLimits(limits), limits, label);
      // Billing was removed: a catalog entry carries only limits, input modalities, and thinking capability.
      const expectedKeys = ["contextWindow", "id", "maxOutputToken"];
      if (entry.inputModalities) expectedKeys.push("inputModalities");
      if (entry.thinking) expectedKeys.push("thinking");
      assert.deepEqual(Object.keys(entry).sort(), expectedKeys.sort(), label);
      if (entry.inputModalities) {
        assert.ok(entry.inputModalities.length > 0, `${label}: input modalities must be non-empty`);
        // One assertion covers three invariants: every value is in the legal set, there are no
        // duplicates, and they are in canonical order.
        assert.deepEqual(
          entry.inputModalities,
          INPUT_MODALITIES.filter((modality) => entry.inputModalities.includes(modality)),
          `${label}: input modalities must be known values in canonical order`,
        );
      }
      if (entry.thinking) {
        assert.deepEqual(Object.keys(entry.thinking).sort(), ["levels", "off"], label);
      }
    }
  }
});

test("openai catalog prefers Codex metadata and keeps models.dev supplements", () => {
  // Codex models.json's context_window is an input-side budget (272K); generation time converts
  // it to the total-window semantic used by the catalog's other sections: 272K + 128K (models.dev
  // output supplement) = 400K.
  for (const modelId of [
    "gpt-5.2",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ]) {
    assert.equal(
      catalog.findCatalogModel("codex", modelId)?.contextWindow,
      400_000,
      `${modelId}: context window must come from openai/codex models.json (input budget + output)`,
    );
  }

  const sol = catalog.findCatalogModel("codex", "gpt-5.6-sol");
  assert.equal(sol?.maxOutputToken, 128_000, "models.dev must supplement missing output limits");
  assert.deepEqual(sol?.thinking, {
    levels: ["low", "medium", "high", "xhigh", "max"],
    off: true,
  });

  // gpt-5.6 is not a same-id Codex catalog entry; models.dev-only entries stay
  // available as supplements instead of inheriting another model's metadata.
  assert.equal(catalog.findCatalogModel("codex", "gpt-5.6")?.contextWindow, 1_050_000);
});

test("formal DeepSeek catalog only exposes models documented for Responses", () => {
  assert.deepEqual(
    catalog.MODEL_CATALOG.deepseek.map((entry) => entry.id),
    ["deepseek-v4-flash", "deepseek-v4-pro"],
  );
  assert.equal(catalog.findCatalogModel("deepseek", "deepseek-chat"), undefined);
  assert.equal(catalog.findCatalogModel("deepseek", "deepseek-reasoner"), undefined);
});

test("normalizeModelLimits repairs degenerate pairs uniformly and leaves valid pairs alone", () => {
  // Degenerate (output consumes the whole window): clamp to min(32K, ⌊window/4⌋).
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 500_000, maxOutputToken: 500_000 }),
    { contextWindow: 500_000, maxOutputToken: 32_000 },
  );
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 8_192, maxOutputToken: 8_192 }),
    { contextWindow: 8_192, maxOutputToken: 2_048 },
  );
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 100_000, maxOutputToken: 200_000 }),
    { contextWindow: 100_000, maxOutputToken: 25_000 },
  );
  // Valid values pass through unchanged (including large-output models; no unconditional clamping).
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 200_000, maxOutputToken: 128_000 }),
    { contextWindow: 200_000, maxOutputToken: 128_000 },
  );
  // A non-positive window is not repaired (handled by the upper-layer fallback logic).
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 0, maxOutputToken: 0 }),
    { contextWindow: 0, maxOutputToken: 0 },
  );
});

test("normalizeModelIdCandidates yields the decorated-id chain in order without duplicates", () => {
  assert.deepEqual(catalog.normalizeModelIdCandidates("Claude-Sonnet-4-6-20260115[1m]@v2"), [
    "Claude-Sonnet-4-6-20260115[1m]@v2",
    "claude-sonnet-4-6-20260115[1m]@v2",
    "claude-sonnet-4-6-20260115[1m]",
    "claude-sonnet-4-6-20260115",
    "claude-sonnet-4-6",
  ]);
  assert.deepEqual(catalog.normalizeModelIdCandidates("grok-4.5"), ["grok-4.5"]);
});

test("findCatalogModel resolves exact and decorated ids across providers", () => {
  assert.equal(catalog.findCatalogModel("xai", "grok-4.5")?.id, "grok-4.5");
  // The candidate chain applies to every provider: casing, [1m], date suffix, @version.
  assert.equal(catalog.findCatalogModel("xai", "GROK-4.5")?.id, "grok-4.5");
  assert.equal(catalog.findCatalogModel("claude_code", "claude-sonnet-4-6[1m]")?.id, "claude-sonnet-4-6");
  assert.equal(catalog.findCatalogModel("claude_code", "claude-sonnet-4-6@v1")?.id, "claude-sonnet-4-6");
  assert.equal(catalog.findCatalogModel("codex", "gpt-5")?.id, "gpt-5");
  assert.equal(catalog.findCatalogModel("codex", "model-not-in-catalog"), undefined);
  assert.equal(catalog.findCatalogModel("gemini", ""), undefined);
  assert.equal(catalog.findCatalogModel("gemini", undefined), undefined);
});

test("cross-provider lookup resolves models configured under a foreign provider", () => {
  // Relay aggregation scenario: when another vendor's model is mounted under this provider type,
  // look it up by id across the whole catalog.
  assert.equal(catalog.findCatalogModelAcrossProviders("grok-4.5")?.id, "grok-4.5");
  // The candidate chain (casing, @version, [1m], date suffix) applies to cross-provider lookup too.
  assert.equal(catalog.findCatalogModelAcrossProviders("GROK-4.5@prod")?.id, "grok-4.5");
  assert.equal(catalog.findCatalogModelAcrossProviders("model-not-in-catalog"), undefined);
  assert.equal(catalog.findCatalogModelAcrossProviders(""), undefined);
  assert.equal(catalog.findCatalogModelAcrossProviders(undefined), undefined);
  assert.deepEqual(catalog.resolveModelLimitsAcrossProviders("grok-4.5"), {
    contextWindow: 500_000,
    maxOutputToken: 32_000,
  });
  assert.equal(catalog.resolveModelLimitsAcrossProviders("model-not-in-catalog"), undefined);
  // Domestic-vendor sections (with no corresponding app provider type) are hit via cross-provider lookup.
  assert.equal(catalog.findCatalogModelAcrossProviders("deepseek-v4-pro")?.id, "deepseek-v4-pro");
  assert.equal(catalog.findCatalogModelAcrossProviders("glm-4.6")?.id, "glm-4.6");
  assert.equal(catalog.findCatalogModelAcrossProviders("qwen-max")?.id, "qwen-max");
  assert.equal(catalog.findCatalogModelAcrossProviders("kimi-k2.5")?.id, "kimi-k2.5");
  // Mixed-case catalog ids (MiniMax/LongCat): a lowercase config hits via the index alias and
  // returns the original id.
  assert.equal(catalog.findCatalogModelAcrossProviders("minimax-m2.5")?.id, "MiniMax-M2.5");
  assert.equal(catalog.findCatalogModelAcrossProviders("longcat-2.0")?.id, "LongCat-2.0");
});

test("resolveModelInputModalities resolves scoped, decorated, and cross-provider ids", () => {
  // Provider-scoped hit (including decorated candidate forms).
  assert.deepEqual(catalog.resolveModelInputModalities("claude_code", "claude-sonnet-4-6"), [
    "text",
    "image",
    "pdf",
  ]);
  assert.deepEqual(catalog.resolveModelInputModalities("claude_code", "claude-sonnet-4-6[1m]"), [
    "text",
    "image",
    "pdf",
  ]);
  // The Codex main-source merge path also carries modalities (models.json's input_modalities).
  assert.deepEqual(catalog.resolveModelInputModalities("codex", "gpt-5.6-sol"), ["text", "image"]);
  // A text-only model truthfully returns ["text"], distinguishable from a "catalog miss" (undefined).
  assert.deepEqual(catalog.resolveModelInputModalities("deepseek", "deepseek-v4-pro"), ["text"]);
  // On a provider-scoped miss it falls back to cross-provider lookup (domestic-vendor sections
  // are consumed only through this path).
  assert.deepEqual(catalog.resolveModelInputModalities("codex", "glm-4.6"), ["text"]);
  assert.deepEqual(catalog.resolveModelInputModalities("codex", "qwen3-omni-flash"), [
    "text",
    "image",
    "audio",
    "video",
  ]);
  assert.equal(catalog.resolveModelInputModalities("codex", "model-not-in-catalog"), undefined);
  assert.equal(catalog.resolveModelInputModalities("codex", undefined), undefined);
});

// repairStaleCrossProviderLimits (fingerprint-matching repair of bad defaults) has been replaced
// by the "plan B" limitsSource origin tag: settings/index.ts's normalizeProviderModelConfig decides
// whether to re-resolve based on the stored catalog/fallback/provider/user origin rather than
// guessing from numeric fingerprints. The corresponding origin-aware tests are the "limitsSource"
// cases in crates/agent-gui/test/settings/normalization.test.mjs.

test("resolveModelLimits returns repaired catalog limits and undefined on miss", () => {
  // grok-4.5 is what triggered this refactor: upstream recorded 500K/500K, and the snapshot has
  // been repaired to 500K/32K.
  assert.deepEqual(catalog.resolveModelLimits("xai", "grok-4.5"), {
    contextWindow: 500_000,
    maxOutputToken: 32_000,
  });
  assert.equal(catalog.resolveModelLimits("xai", "grok-unknown"), undefined);
});

test("provider fallback limits use total-window semantics and return copies", () => {
  assert.deepEqual(catalog.getProviderFallbackLimits("claude_code"), {
    contextWindow: 200_000,
    maxOutputToken: 32_000,
  });
  // codex/xai fall back to total-window semantics: 258K input budget + 142K output = 400K.
  assert.deepEqual(catalog.getProviderFallbackLimits("codex"), {
    contextWindow: 400_000,
    maxOutputToken: 142_000,
  });
  assert.deepEqual(catalog.getProviderFallbackLimits("gemini"), {
    contextWindow: 1_048_576,
    maxOutputToken: 65_536,
  });
  assert.deepEqual(catalog.getProviderFallbackLimits("xai"), {
    contextWindow: 400_000,
    maxOutputToken: 142_000,
  });
  const first = catalog.getProviderFallbackLimits("xai");
  first.maxOutputToken = 1;
  assert.equal(catalog.getProviderFallbackLimits("xai").maxOutputToken, 142_000);
});
