import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const tabs = loader.loadModule("@liveagent/ui/lib/settings/providerUiTabs.ts");

// The closed ProviderId union the Go gateway validates on the wire
// (handler/types.go: selected_model.provider_type).
const CLOSED_PROVIDER_IDS = ["codex", "claude_code", "gemini", "xai", "deepseek"];

test("exactly one tab: SuperAgent — a conversion of the OpenAI (codex) tab", () => {
  assert.equal(tabs.PROVIDER_UI_TABS.length, 1);
  assert.equal(tabs.PROVIDER_UI_TABS[0].id, "superagent");
  // The OpenAI tab's provider type (codex) is preserved — a conversion, not a
  // new provider type.
  assert.equal(tabs.PROVIDER_UI_TABS[0].providerType, "codex");
});

test("the SuperAgent tab rides codex and stays inside the closed ProviderId union", () => {
  assert.equal(tabs.resolveProviderUiTabProviderType("superagent"), "codex");
  assert.doesNotThrow(() =>
    tabs.assertProviderUiTabsStayInClosedUnion(CLOSED_PROVIDER_IDS),
  );
  assert.throws(() => tabs.assertProviderUiTabsStayInClosedUnion(["claude_code"]));
});

test("the SuperAgent preset base URL matches the deployed endpoint", () => {
  assert.equal(tabs.SUPERAGENT_PRESET_BASE_URL, "https://api.superagent.ng");
  assert.equal(tabs.SUPERAGENT_PRESET_NAME, "SuperAgent");
});
