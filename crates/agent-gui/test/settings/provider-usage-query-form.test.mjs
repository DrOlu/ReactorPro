import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const forms = loader.loadModule("@liveagent/ui/pages/settings/providerUtils.ts");

const usageQuery = {
  enabled: true,
  mode: "newapi",
  script: "",
  scripts: {},
  baseUrl: "https://usage.example.test",
  apiKey: "",
  apiKeyConfigured: true,
  accessToken: "",
  accessTokenConfigured: true,
  userId: "user-1",
  accessKeyId: "key-1",
  secretAccessKey: "",
  secretAccessKeyConfigured: true,
  codingPlanProvider: "",
  teamOrganizationId: "",
  teamProjectId: "",
  timeoutSecs: 10,
};

test("usage query draft preserves configured redacted secrets when saved", () => {
  assert.equal(typeof forms.createUsageQueryDraft, "function");
  assert.equal(typeof forms.serializeUsageQueryDraft, "function");

  const draft = forms.createUsageQueryDraft(usageQuery, true);
  assert.notEqual(draft.apiKey, "");
  assert.notEqual(draft.accessToken, "");
  assert.notEqual(draft.secretAccessKey, "");

  assert.deepEqual(forms.serializeUsageQueryDraft(draft, true), usageQuery);
});

test("usage query serialization clamps the timeout", () => {
  const serialized = forms.serializeUsageQueryDraft({ ...usageQuery, timeoutSecs: 500 }, false);
  assert.equal(serialized.timeoutSecs, 30);

  assert.equal(forms.clampUsageQueryTimeoutSecs(Number.NaN), 10);
  assert.equal(forms.clampUsageQueryTimeoutSecs(1), 2);
});

test("usage test action accepts only a persisted provider id", () => {
  assert.equal(typeof forms.getPersistedUsageQueryProviderId, "function");
  assert.equal(forms.getPersistedUsageQueryProviderId(undefined), null);
  assert.equal(forms.getPersistedUsageQueryProviderId({ id: "" }), null);
  assert.equal(forms.getPersistedUsageQueryProviderId({ id: "provider-a" }), "provider-a");
});

test("custom usage query needs confirmation before its first enabled save", () => {
  assert.equal(typeof forms.requiresCustomUsageQueryConfirmation, "function");
  assert.equal(
    forms.requiresCustomUsageQueryConfirmation({ ...usageQuery, mode: "custom" }, false),
    true,
  );
  assert.equal(
    forms.requiresCustomUsageQueryConfirmation({ ...usageQuery, mode: "custom" }, true),
    false,
  );
  assert.equal(
    forms.requiresCustomUsageQueryConfirmation({ ...usageQuery, mode: "custom", enabled: true }, true),
    false,
  );
  assert.equal(
    forms.requiresCustomUsageQueryConfirmation({ ...usageQuery, enabled: false, mode: "custom" }, false),
    false,
  );
});

test("each query mode keeps its own script and empty modes show their preset", () => {
  const customPreset = forms.USAGE_QUERY_PRESET_SCRIPTS.custom;
  const generalPreset = forms.USAGE_QUERY_PRESET_SCRIPTS.general;
  const newapiPreset = forms.USAGE_QUERY_PRESET_SCRIPTS.newapi;
  // A one-to-one copy of cc-switch: custom is an empty skeleton, general has UA + isValid, newapi has
  // UA.
  assert.ok(customPreset.includes('url: ""'));
  assert.ok(generalPreset.includes("{{baseUrl}}/user/balance"));
  assert.ok(generalPreset.includes('"User-Agent": "ReactorPro/1.0"'));
  assert.ok(generalPreset.includes("isValid: response.is_active || true"));
  assert.ok(newapiPreset.includes("{{baseUrl}}/api/user/self"));
  assert.ok(newapiPreset.includes('"User-Agent": "ReactorPro/1.0"'));

  // A mode never filled in shows its own template preset (custom is an empty skeleton).
  const filled = forms.applyUsageQueryModePreset({ ...usageQuery, script: "" }, "general");
  assert.equal(filled.mode, "general");
  assert.equal(filled.script, generalPreset);
  const skeleton = forms.applyUsageQueryModePreset({ ...usageQuery, script: "" }, "custom");
  assert.equal(skeleton.script, customPreset);

  // Each mode's script is independent: an edit in newapi is restored exactly after switching away
  // and back.
  const editedNewapi = forms.setUsageQueryScript(
    { ...usageQuery, mode: "newapi", script: newapiPreset },
    "(my newapi script)",
  );
  assert.equal(editedNewapi.scripts.newapi, "(my newapi script)");
  const onGeneral = forms.applyUsageQueryModePreset(editedNewapi, "general");
  assert.equal(onGeneral.script, generalPreset);
  const editedGeneral = forms.setUsageQueryScript(onGeneral, "(my general script)");
  const backToNewapi = forms.applyUsageQueryModePreset(editedGeneral, "newapi");
  assert.equal(backToNewapi.script, "(my newapi script)");
  assert.equal(backToNewapi.scripts.general, "(my general script)");

  // A non-script mode does not touch the editor content; switching back to script mode restores from
  // the slot.
  const onBalance = forms.applyUsageQueryModePreset(backToNewapi, "balance");
  assert.equal(onBalance.mode, "balance");
  assert.equal(onBalance.script, "(my newapi script)");
  const restored = forms.applyUsageQueryModePreset(onBalance, "general");
  assert.equal(restored.script, "(my general script)");
});

test("serialization folds the editor content into the per-mode script slot", () => {
  const serialized = forms.serializeUsageQueryDraft(
    {
      ...usageQuery,
      mode: "custom",
      script: "  (custom body)  ",
      scripts: { general: "(general body)", newapi: "   " },
    },
    false,
  );
  assert.equal(serialized.script, "(custom body)");
  assert.deepEqual(serialized.scripts, {
    custom: "(custom body)",
    general: "(general body)",
  });
});

test("preset scripts stay in sync with the Rust builtin presets", async () => {
  // KEEP IN SYNC anchor: character-for-character identical to GENERAL_SCRIPT/NEWAPI_SCRIPT in
  // src-tauri/src/services/provider_usage.rs. The custom skeleton is filled in only by the frontend
  // (Rust errors directly on an empty custom script, with no fallback) and does not participate in
  // the comparison.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const rustSource = await readFile(
    fileURLToPath(new URL("../../src-tauri/src/services/provider_usage.rs", import.meta.url)),
    "utf8",
  );
  for (const preset of [
    forms.USAGE_QUERY_PRESET_SCRIPTS.general,
    forms.USAGE_QUERY_PRESET_SCRIPTS.newapi,
  ]) {
    assert.ok(
      rustSource.includes(`r#"${preset}"#`),
      "preset script must match the Rust builtin byte-for-byte",
    );
  }
});
