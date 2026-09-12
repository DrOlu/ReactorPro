import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Anti-drift lock for inputModalities (user override of model input modalities):
// 1. the normalizer's filter/fill-in/canonical-order contract;
// 2. settings load round-trips without dropping fields;
// 3. modelFactory applies the override only on branches where attachment sending is actually
//    gated by model.input (codex/gemini/deepseek); it does not apply to anthropic (to avoid
//    false capability claims).
const loader = createTsModuleLoader();
const { normalizeInputModalities, normalizeProviderModelConfig, normalizeProviderModelConfigs } =
  loader.loadModule("src/lib/settings/index.ts");
const { createModelFromConfig } = loader.loadModule(
  "src/lib/providers/runtime/modelFactory.ts",
);
// providerUtils depends on tauri invoke; normalizeFetchedModels itself does not trigger network
// access, so the mock exists only to satisfy module loading.
const providerUtilsLoader = createTsModuleLoader({
  mocks: { "@tauri-apps/api/core": { invoke: async () => ({}) } },
});
const {
  applyModelInputModalitiesMode,
  getModelInputModalitiesMode,
  normalizeFetchedModels,
  providerSupportsModelInputModalitiesOverride,
} = providerUtilsLoader.loadModule("@liveagent/ui/pages/settings/providerUtils.ts");

test("normalizeInputModalities rejects non-arrays and empty/fully-invalid arrays", () => {
  assert.equal(normalizeInputModalities(undefined), undefined);
  assert.equal(normalizeInputModalities(null), undefined);
  assert.equal(normalizeInputModalities("image"), undefined);
  assert.equal(normalizeInputModalities({ 0: "image" }), undefined);
  assert.equal(normalizeInputModalities([]), undefined);
  assert.equal(normalizeInputModalities(["audio"]), undefined);
  assert.equal(normalizeInputModalities([" image "]), undefined);
});

test("normalizeInputModalities filters mixed arrays and dedupes", () => {
  assert.deepEqual(normalizeInputModalities(["image", 123, "future"]), ["text", "image"]);
  assert.deepEqual(normalizeInputModalities(["image", "image", "text"]), ["text", "image"]);
});

test("normalizeInputModalities auto-adds text and emits canonical order", () => {
  // The chat protocol always sends text: an image-only override auto-fills text
  assert.deepEqual(normalizeInputModalities(["image"]), ["text", "image"]);
  assert.deepEqual(normalizeInputModalities(["image", "text"]), ["text", "image"]);
  assert.deepEqual(normalizeInputModalities(["text"]), ["text"]);
});

test("normalizeProviderModelConfig preserves a valid inputModalities override", () => {
  const normalized = normalizeProviderModelConfig(
    {
      id: "k3",
      contextWindow: 258000,
      maxOutputToken: 32000,
      limitsSource: "user",
      inputModalities: ["text", "image"],
    },
    "codex",
  );
  assert.deepEqual(normalized.inputModalities, ["text", "image"]);
});

test("normalizeProviderModelConfig drops malformed inputModalities and legacy archives", () => {
  const malformed = normalizeProviderModelConfig(
    { id: "k3", contextWindow: 258000, maxOutputToken: 32000, inputModalities: "image" },
    "codex",
  );
  assert.equal("inputModalities" in malformed, false);
  const legacy = normalizeProviderModelConfig(
    { id: "k3", contextWindow: 258000, maxOutputToken: 32000 },
    "codex",
  );
  assert.equal("inputModalities" in legacy, false);
});

test("modelFactory: codex completions custom model honors the override", () => {
  const base = ["codex", "k3", "https://api.kimi.com/coding/v1", "openai-completions"];
  const withoutOverride = createModelFromConfig(...base);
  assert.deepEqual(withoutOverride.input, ["text"]);
  const withOverride = createModelFromConfig(...base, {
    id: "k3",
    contextWindow: 258000,
    maxOutputToken: 32000,
    inputModalities: ["text", "image"],
  });
  // Constructing a model with an override must not retroactively pollute previously created
  // no-override model instances.
  assert.deepEqual(withoutOverride.input, ["text"]);
  assert.deepEqual(withOverride.input, ["text", "image"]);
});

test(
  "ProviderModal input capability mode preserves auto/text/image semantics and provider boundary",
  () => {
    const baseModel = { id: "k3", contextWindow: 258000, maxOutputToken: 32000 };
    const textOnly = applyModelInputModalitiesMode(baseModel, "text");
    const textAndImage = applyModelInputModalitiesMode(textOnly, "text-image");
    const automatic = applyModelInputModalitiesMode(textAndImage, "auto");

    assert.equal(getModelInputModalitiesMode(baseModel), "auto");
    assert.equal(getModelInputModalitiesMode(textOnly), "text");
    assert.equal(getModelInputModalitiesMode(textAndImage), "text-image");
    assert.equal("inputModalities" in automatic, false);

    assert.equal(providerSupportsModelInputModalitiesOverride("codex"), true);
    assert.equal(providerSupportsModelInputModalitiesOverride("xai"), true);
    assert.equal(providerSupportsModelInputModalitiesOverride("gemini"), true);
    assert.equal(providerSupportsModelInputModalitiesOverride("deepseek"), true);
    assert.equal(providerSupportsModelInputModalitiesOverride("claude_code"), false);
  },
);

test("modelFactory: codex custom model ignores a malformed override", () => {
  const model = createModelFromConfig(
    "codex",
    "k3",
    "https://api.kimi.com/coding/v1",
    "openai-completions",
    { id: "k3", contextWindow: 258000, maxOutputToken: 32000, inputModalities: ["audio"] },
  );
  assert.deepEqual(model.input, ["text"]);
});

test("modelFactory: gemini custom model honors the override", () => {
  const model = createModelFromConfig(
    "gemini",
    "some-custom-proxy-model",
    "https://gemini-proxy.example.com",
    undefined,
    {
      id: "some-custom-proxy-model",
      contextWindow: 128000,
      maxOutputToken: 32000,
      inputModalities: ["text"],
    },
  );
  assert.deepEqual(model.input, ["text"]);
});

test("modelFactory: deepseek infers image input from the model id and honors the override", () => {
  // The official "Image Understanding" guide only promises image input for the flash family;
  // Pro and earlier models are not opened up along with it.
  const flash = createModelFromConfig(
    "deepseek",
    "deepseek-v4-flash",
    "https://api.deepseek.com",
  );
  assert.deepEqual(flash.input, ["text", "image"]);

  const pro = createModelFromConfig("deepseek", "deepseek-v4-pro", "https://api.deepseek.com");
  assert.deepEqual(pro.input, ["text"]);

  // When a relay endpoint does not accept images, use the override to switch back to text-only
  // (the override takes precedence over id inference).
  const forcedText = createModelFromConfig(
    "deepseek",
    "deepseek-v4-flash",
    "https://relay.example.com",
    undefined,
    {
      id: "deepseek-v4-flash",
      contextWindow: 128000,
      maxOutputToken: 32000,
      inputModalities: ["text"],
    },
  );
  assert.deepEqual(forcedText.input, ["text"]);

  // The reverse: when the user knows their endpoint supports it, they can enable images for Pro too.
  const forcedImage = createModelFromConfig(
    "deepseek",
    "deepseek-v4-pro",
    "https://api.deepseek.com",
    undefined,
    {
      id: "deepseek-v4-pro",
      contextWindow: 128000,
      maxOutputToken: 32000,
      inputModalities: ["text", "image"],
    },
  );
  assert.deepEqual(forcedImage.input, ["text", "image"]);
});

test("modelFactory: anthropic custom model does not apply the override (attachments ignore model.input upstream)", () => {
  const model = createModelFromConfig(
    "claude_code",
    "unknown-relay-claude-model",
    "https://claude-relay.example.com",
    undefined,
    {
      id: "unknown-relay-claude-model",
      contextWindow: 200000,
      maxOutputToken: 32000,
      inputModalities: ["text", "image"],
    },
  );
  assert.deepEqual(model.input, ["text"]);
});

test("gemini persisted model survives the ProviderModal open/save round trip", () => {
  const persisted = [
    {
      id: "gemini-custom",
      contextWindow: 123456,
      maxOutputToken: 789,
      limitsSource: "user",
      inputModalities: ["text", "image"],
    },
  ];
  // ProviderModal initialization (persistence normalization): all user fields round-trip as-is
  const viaModal = normalizeProviderModelConfigs(persisted, "gemini");
  assert.deepEqual(viaModal[0], {
    id: "gemini-custom",
    contextWindow: 123456,
    maxOutputToken: 789,
    limitsSource: "user",
    inputModalities: ["text", "image"],
  });
});

test("gemini fetch-path normalization preserves the inputModalities override", () => {
  // When an API-response-shaped entry (inputTokenLimit/outputTokenLimit) also carries user
  // override fields, the override must not be lost after refresh (previously
  // normalizeGeminiFetchedModels rebuilding the object would wash it out).
  const fetched = [
    {
      name: "models/gemini-custom",
      inputTokenLimit: 123456,
      outputTokenLimit: 789,
      inputModalities: ["image"],
    },
  ];
  const viaFetch = normalizeFetchedModels(fetched, "gemini");
  assert.equal(viaFetch.length, 1);
  assert.deepEqual(viaFetch[0].inputModalities, ["text", "image"]);
});
