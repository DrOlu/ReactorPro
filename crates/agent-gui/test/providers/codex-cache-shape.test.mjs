import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const codexCache = loader.loadModule("src/lib/providers/runtime/codexPromptCache.ts");

// This group of contract tests mirrors the OpenAI official codex CLI's cache key tests
// (codex-rs's review_session / guardian tests): the key must be deterministic, must distinguish
// sessions, and must fall within the Responses API's 64-character limit. The official key is never
// empty; our sessionId can be empty, so we guard one extra thing -- empty-value degradation must be
// visible in attribution, not merely a silently worse hit rate.

const OPENAI_BASE = "https://api.openai.com/v1";

test("codex cache key: the same sessionId always yields the same key (deterministic)", () => {
  const first = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-abc",
    "short",
  );
  const second = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-abc",
    "short",
  );
  assert.equal(first.cacheKey, second.cacheKey);
  assert.ok(first.cacheKey, "the key must have a value for the official domain + responses API");
});

test("codex cache key: different sessionIds yield different keys (shard isolation)", () => {
  const a = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-a",
    "short",
  );
  const b = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-b",
    "short",
  );
  assert.notEqual(a.cacheKey, b.cacheKey);
});

test("codex cache key: a long sessionId is truncated to 64 characters (Responses API limit)", () => {
  const long = "s".repeat(200);
  const shape = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    long,
    "short",
  );
  assert.equal(shape.cacheKey.length, 64);
});

test("codex cache key: a missing sessionId must expose an empty key in attribution -- the only visible trace of silent degradation", () => {
  // attachCodexPromptCacheHint does not inject prompt_cache_key when sessionId is empty; the
  // server falls back to default routing, the request does not error, and only the hit rate gets
  // worse. An empty cacheKey string in attribution is the only trace this degradation leaves, and
  // this assertion guards it.
  const missing = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    undefined,
    "short",
  );
  assert.equal(missing.cacheKey, "");
  assert.equal(missing.breakpointStrategy, "codex-openai-key", "the mode is still there, only the key is not active");

  const blank = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "   ",
    "short",
  );
  assert.equal(blank.cacheKey, "", "a blank sessionId is treated the same as missing");
});

test("codex cache shape: cacheRetention=none collapses everything to none, consistent with the injection side", () => {
  // attachCodexPromptCacheHint collapses mode to none when retention=none, generating no cache
  // hint at all from the source. Attribution must describe the same reality, not tell a different story.
  const shape = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-abc",
    "none",
  );
  assert.equal(shape.breakpointStrategy, "none");
  assert.equal(shape.cacheKey, "");
});

test("codex cache shape: non-codex protocol families are always none", () => {
  const shape = codexCache.describeCodexCacheShape(
    "claude_code",
    "https://api.anthropic.com/v1",
    undefined,
    undefined,
    "session-abc",
    "short",
  );
  assert.equal(shape.breakpointStrategy, "none");
});

test("codex cache shape: openrouter uses x-session-id, key limit relaxed to 256", () => {
  const long = "r".repeat(300);
  const shape = codexCache.describeCodexCacheShape(
    "codex",
    "https://openrouter.ai/api/v1",
    undefined,
    undefined,
    long,
    "short",
  );
  assert.equal(shape.breakpointStrategy, "codex-openrouter-session");
  assert.equal(shape.cacheKey.length, 256);
});

test("codex cache shape: when the request already has an x-session-id header, describe uses the header value (consistent with attach)", () => {
  const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
  // On the attach side: if the header already exists, injection is skipped and the effective
  // routing key is the existing header's value. If describe still reported clamp(sessionId), it
  // would be describing a request that does not exist.
  const withHeader = codexCache.describeCodexCacheShape(
    "codex",
    OPENROUTER_BASE,
    undefined,
    undefined,
    "session-configured",
    "short",
    { "X-Session-Id": "custom-upstream-key" },
  );
  assert.equal(withHeader.cacheKey, "custom-upstream-key");

  const withoutHeader = codexCache.describeCodexCacheShape(
    "codex",
    OPENROUTER_BASE,
    undefined,
    undefined,
    "session-configured",
    "short",
    { "x-other-header": "1" },
  );
  assert.equal(withoutHeader.cacheKey, "session-configured");
  assert.notEqual(withHeader.cacheKey, withoutHeader.cacheKey);
});

test("codex cache shape: x-session-id header detection is case-insensitive and cross-validated against the injection side", async () => {
  const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
  // First prove attach really does not overwrite when the header exists (the consistency premise),
  // then prove describe reports the same value.
  const attached = codexCache.attachCodexPromptCacheHint(
    "codex",
    OPENROUTER_BASE,
    undefined,
    undefined,
    {
      sessionId: "session-configured",
      cacheRetention: "short",
      headers: { "X-SESSION-ID": "upstream-value" },
    },
  );
  assert.equal(attached.headers["X-SESSION-ID"], "upstream-value");
  assert.equal(
    Object.keys(attached.headers).filter((key) => key.toLowerCase() === "x-session-id").length,
    1,
    "attach must not inject a second x-session-id",
  );

  const shape = codexCache.describeCodexCacheShape(
    "codex",
    OPENROUTER_BASE,
    undefined,
    undefined,
    "session-configured",
    "short",
    attached.headers,
  );
  assert.equal(shape.cacheKey, "upstream-value");
});

test("codex cache shape: openai-key mode is unaffected by the x-session-id header", () => {
  // prompt_cache_key is injected via the payload, unrelated to the x-session-id header; the
  // header's presence must not change the cacheKey semantics of the openai path.
  const shape = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-abc",
    "short",
    { "x-session-id": "should-not-matter" },
  );
  assert.equal(shape.cacheKey, "session-abc");
});

test("codex cache shape: a sessionId change is reflected as a cacheKey change, catchable by prefix attribution", () => {
  // Changing sessionId = changing cache shard = a full miss no matter how stable the prefix bytes
  // are. The attribution dimension must move.
  const before = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-before",
    "short",
  );
  const after = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-after",
    "short",
  );
  assert.notEqual(
    JSON.stringify(before),
    JSON.stringify(after),
    "cacheKey is part of the shape; a sessionId change must make the shapes unequal",
  );
});
