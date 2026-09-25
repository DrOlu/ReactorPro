import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const tabs = loader.loadModule("@liveagent/ui/lib/settings/providerUiTabs.ts");

// The closed ProviderId union the Go gateway validates on the wire
// (handler/types.go: selected_model.provider_type).
const CLOSED_PROVIDER_IDS = ["codex", "claude_code", "gemini", "xai", "deepseek"];

test("the SuperAgent tab is first, before Anthropic", () => {
  assert.equal(tabs.PROVIDER_UI_TABS[0].id, "superagent");
  assert.equal(tabs.PROVIDER_UI_TABS[1].id, "claude_code");
  assert.equal(tabs.PROVIDER_UI_TABS.length, 6);
});

test("the SuperAgent tab rides claude_code and stays inside the closed ProviderId union", () => {
  assert.equal(
    tabs.resolveProviderUiTabProviderType("superagent"),
    "claude_code",
    "SuperAgent must ride the Anthropic-compatible surface",
  );
  for (const id of CLOSED_PROVIDER_IDS) {
    assert.equal(tabs.resolveProviderUiTabProviderType(id), id, `${id} must map to itself`);
  }
  assert.doesNotThrow(() =>
    tabs.assertProviderUiTabsStayInClosedUnion(CLOSED_PROVIDER_IDS),
  );
  assert.throws(() => tabs.assertProviderUiTabsStayInClosedUnion(["codex", "claude_code"]));
});

test("the SuperAgent preset base URL matches the deployed endpoint", () => {
  assert.equal(tabs.SUPERAGENT_PRESET_BASE_URL, "https://api.superagent.ng");
  assert.equal(tabs.SUPERAGENT_PRESET_NAME, "SuperAgent");
});
