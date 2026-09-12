import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const catalog = loader.loadModule("@liveagent/ui/lib/models/modelCatalog.ts");

// The data invariants are fully covered by
// agent-gui/test/models/model-catalog.test.mjs; here we only smoke-test that the
// Web host can load the shared catalog and that the key values match.
test("web shared model catalog resolves limits and fallbacks", () => {
  assert.deepEqual(catalog.resolveModelLimits("xai", "grok-4.5"), {
    contextWindow: 500_000,
    maxOutputToken: 32_000,
  });
  assert.equal(catalog.findCatalogModel("claude_code", "claude-sonnet-4-6[1m]")?.id, "claude-sonnet-4-6");
  assert.deepEqual(catalog.getProviderFallbackLimits("xai"), {
    contextWindow: 400_000,
    maxOutputToken: 142_000,
  });
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 128_000, maxOutputToken: 128_000 }),
    { contextWindow: 128_000, maxOutputToken: 32_000 },
  );
});
