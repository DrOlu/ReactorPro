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

test("a SuperAgent provider persisted in full-URL mode is canonicalised to the non-full-URL chat-completions endpoint", () => {
  // Regression: the provider could be saved as a full URL (or with the codex
  // default Responses format), which made the runtime POST to the bare origin
  // /v1 and surface `Request failed: Not Found` (HTTP 404) in Provider Settings.
  const normalized = settings.normalizeCustomProvider({
    id: "builtin-codex",
    name: "SuperAgent",
    type: "codex",
    baseUrl: "https://api.superagent.ng/v1/chat/completions",
    isFullUrl: true,
    requestFormat: "openai-responses",
  });
  assert.equal(normalized.baseUrl, "https://api.superagent.ng");
  assert.equal(normalized.isFullUrl, false);
  assert.equal(normalized.requestFormat, "openai-completions");
});

test("a SuperAgent endpoint without an explicit format defaults to chat completions, never Responses", () => {
  const normalized = settings.normalizeCustomProvider({
    id: "custom-superagent",
    name: "My SuperAgent",
    type: "codex",
    baseUrl: "https://api.superagent.ng",
  });
  assert.equal(normalized.baseUrl, "https://api.superagent.ng");
  assert.equal(normalized.isFullUrl, false);
  assert.equal(normalized.requestFormat, "openai-completions");
});

test("a non-SuperAgent codex endpoint keeps its configured format and full-URL flag", () => {
  const normalized = settings.normalizeCustomProvider({
    id: "custom-relay",
    name: "My Relay",
    type: "codex",
    baseUrl: "https://my-relay.example/v1/chat/completions",
    isFullUrl: true,
    requestFormat: "openai-responses",
  });
  assert.equal(normalized.baseUrl, "https://my-relay.example/v1/chat/completions");
  assert.equal(normalized.isFullUrl, true);
  assert.equal(normalized.requestFormat, "openai-responses");
});
