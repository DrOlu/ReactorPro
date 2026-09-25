import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");

test("the only builtin provider is SuperAgent at https://api.superagent.ng", () => {
  const builtins = settings.getBuiltinCustomProviders();
  assert.equal(builtins.length, 1);
  const [provider] = builtins;
  assert.equal(provider.id, "builtin-codex");
  assert.equal(provider.name, "SuperAgent");
  assert.equal(provider.type, "codex");
  assert.equal(provider.baseUrl, "https://api.superagent.ng");
  // SuperAgent speaks OpenAI-compatible chat completions.
  assert.equal(provider.requestFormat, "openai-completions");
});

test("persisted OpenAI defaults migrate to SuperAgent without touching custom URLs", () => {
  // The old default base URL migrates, and the name normalizes to SuperAgent.
  const migrated = settings.normalizeCustomProvider({
    id: "builtin-codex",
    name: "OpenAI",
    type: "codex",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(migrated.name, "SuperAgent");
  assert.equal(migrated.baseUrl, "https://api.superagent.ng");

  // A user-customized endpoint survives the migration untouched.
  const customized = settings.normalizeCustomProvider({
    id: "builtin-codex",
    name: "My Gateway",
    type: "codex",
    baseUrl: "https://my-own-gateway.example/v1",
  });
  assert.equal(customized.name, "My Gateway");
  assert.equal(customized.baseUrl, "https://my-own-gateway.example/v1");
});
