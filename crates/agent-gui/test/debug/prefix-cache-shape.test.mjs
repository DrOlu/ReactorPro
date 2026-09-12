import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const prefixCacheShape = loader.loadModule("src/lib/debug/prefixCacheShape.ts");

const { capturePrefixShape, comparePrefixShape } = prefixCacheShape;

function tool(name, description = `${name} description`, parameters = { type: "object" }) {
  return { name, description, parameters };
}

const BASE_TOOLS = [tool("Bash"), tool("Read"), tool("Write")];

// ---------------------------------------------------------------------------
// Determinism: the same input always yields the same hash, and the observation method itself must not jitter

test("The same input computed repeatedly yields the same hash", () => {
  const first = capturePrefixShape({ systemPrompt: "system base", tools: BASE_TOOLS });
  const second = capturePrefixShape({ systemPrompt: "system base", tools: BASE_TOOLS });

  assert.deepEqual(first, second);
  assert.equal(typeof first.prefixHash, "string");
  assert.equal(first.prefixHash.length, 16);
  assert.equal(first.toolCount, 3);
});

test("Default systemPrompt / tools do not throw and are equivalent to empty values", () => {
  const empty = capturePrefixShape({});
  const explicit = capturePrefixShape({ systemPrompt: "", tools: [] });

  assert.deepEqual(empty, explicit);
  assert.equal(empty.toolCount, 0);
});

test("The hashes of system and tools do not cross-talk", () => {
  const base = capturePrefixShape({ systemPrompt: "a", tools: BASE_TOOLS });
  const systemChanged = capturePrefixShape({ systemPrompt: "b", tools: BASE_TOOLS });
  const toolsChanged = capturePrefixShape({
    systemPrompt: "a",
    tools: [...BASE_TOOLS, tool("Grep")],
  });

  assert.notEqual(base.systemHash, systemChanged.systemHash);
  assert.equal(base.toolsHash, systemChanged.toolsHash);

  assert.equal(base.systemHash, toolsChanged.systemHash);
  assert.notEqual(base.toolsHash, toolsChanged.toolsHash);
  assert.notEqual(base.prefixHash, toolsChanged.prefixHash);
});

// ---------------------------------------------------------------------------
// Tool order: it is ordered on the wire side, and diagnostics must reflect that faithfully, not mask it by sorting

test("A tool order change is detected -- an order change is a real invalidation, not a false positive", () => {
  // filterRequestTools only filters and does not reorder; the tools array is ordered in the request body. An MCP server
  // reconnect shuffling the registry order -> the provider prefix really is invalidated. The diagnostic must report this.
  const ordered = capturePrefixShape({ systemPrompt: "system", tools: BASE_TOOLS });
  const shuffled = capturePrefixShape({
    systemPrompt: "system",
    tools: [BASE_TOOLS[2], BASE_TOOLS[0], BASE_TOOLS[1]],
  });

  assert.notEqual(ordered.toolsHash, shuffled.toolsHash);
  assert.equal(comparePrefixShape(ordered, shuffled).prefixChangeSummary, "tools");
});

test("Repeated sampling of the same order stays stable", () => {
  const tools = [tool("apply_patch"), tool("Bash"), tool("agent"), tool("Read")];
  const first = capturePrefixShape({ tools });
  const second = capturePrefixShape({ tools: [...tools] });

  assert.equal(first.toolsHash, second.toolsHash);
});

test("A tool description change is detected", () => {
  const before = capturePrefixShape({ tools: [tool("Bash", "old description")] });
  const after = capturePrefixShape({ tools: [tool("Bash", "new description")] });

  assert.notEqual(before.toolsHash, after.toolsHash);
  assert.equal(comparePrefixShape(before, after).prefixChangeSummary, "tools");
});

test("A parameter schema change is detected", () => {
  const before = capturePrefixShape({ tools: [tool("Bash", "d", { type: "object" })] });
  const after = capturePrefixShape({
    tools: [tool("Bash", "d", { type: "object", required: ["command"] })],
  });

  assert.notEqual(before.toolsHash, after.toolsHash);
});

test("A constrainedSampling change is detected -- it is part of the request-body bytes just like parameters", () => {
  const base = capturePrefixShape({ tools: [tool("Bash")] });
  const withSampling = capturePrefixShape({
    tools: [{ ...tool("Bash"), constrainedSampling: { grammar: "shell" } }],
  });
  const changedSampling = capturePrefixShape({
    tools: [{ ...tool("Bash"), constrainedSampling: { grammar: "json" } }],
  });

  assert.notEqual(base.toolsHash, withSampling.toolsHash);
  assert.notEqual(withSampling.toolsHash, changedSampling.toolsHash);
  assert.equal(comparePrefixShape(base, withSampling).prefixChangeSummary, "tools");
});

test("Default constrainedSampling is equivalent to undefined and does not jitter due to a missing field", () => {
  const absent = capturePrefixShape({ tools: [tool("Bash")] });
  const explicitUndefined = capturePrefixShape({
    tools: [{ ...tool("Bash"), constrainedSampling: undefined }],
  });

  assert.deepEqual(absent, explicitUndefined);
});

// ---------------------------------------------------------------------------
// Attribution: four change cases

test("Only system changes -> system", () => {
  const previous = capturePrefixShape({ systemPrompt: "old", tools: BASE_TOOLS });
  const current = capturePrefixShape({ systemPrompt: "new", tools: BASE_TOOLS });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChanged, true);
  assert.equal(diagnostics.prefixChangeSummary, "system");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["system"]);
  assert.equal(diagnostics.prefixHash, current.prefixHash);
});

test("Only tools changes -> tools", () => {
  const previous = capturePrefixShape({ systemPrompt: "same", tools: BASE_TOOLS });
  const current = capturePrefixShape({
    systemPrompt: "same",
    tools: [...BASE_TOOLS, tool("Grep")],
  });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChanged, true);
  assert.equal(diagnostics.prefixChangeSummary, "tools");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["tools"]);
  assert.equal(diagnostics.toolCount, 4);
});

test("Multiple dimensions change -> multiple", () => {
  const previous = capturePrefixShape({ systemPrompt: "old", tools: BASE_TOOLS });
  const current = capturePrefixShape({ systemPrompt: "new", tools: [tool("Bash")] });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChanged, true);
  assert.equal(diagnostics.prefixChangeSummary, "multiple");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["system", "tools"]);
});

test("None change -> unchanged", () => {
  const previous = capturePrefixShape({ systemPrompt: "same", tools: BASE_TOOLS });
  const current = capturePrefixShape({ systemPrompt: "same", tools: BASE_TOOLS });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChanged, false);
  assert.equal(diagnostics.prefixChangeSummary, "unchanged");
  assert.deepEqual(diagnostics.prefixChangeReasons, []);
});

test("First round has nothing to compare -> initial, and changed is not reported", () => {
  const current = capturePrefixShape({ systemPrompt: "first", tools: BASE_TOOLS });

  for (const previous of [null, undefined]) {
    const diagnostics = comparePrefixShape(previous, current);
    assert.equal(diagnostics.prefixChanged, false);
    assert.equal(diagnostics.prefixChangeSummary, "initial");
    assert.deepEqual(diagnostics.prefixChangeReasons, []);
    assert.equal(diagnostics.systemHash, current.systemHash);
    assert.equal(diagnostics.toolsHash, current.toolsHash);
    assert.equal(diagnostics.cacheControlHash, current.cacheControlHash);
  }
});

// ---------------------------------------------------------------------------
// Cache-parameter dimension: the bytes are identical, but if the TTL / breakpoint policy changed, the cache is invalidated all the same

test("A TTL flip is detected -- the system and tools bytes are exactly identical", () => {
  const base = { systemPrompt: "same", tools: BASE_TOOLS };
  const short = capturePrefixShape({
    ...base,
    cacheControl: { cacheRetention: "short", ttl: "", breakpointStrategy: "anthropic-top-level" },
  });
  const long = capturePrefixShape({
    ...base,
    cacheControl: { cacheRetention: "long", ttl: "1h", breakpointStrategy: "anthropic-top-level" },
  });

  // The first two dimensions must be completely unchanged, otherwise this assertion cannot prove "only the cache parameters changed".
  assert.equal(short.systemHash, long.systemHash);
  assert.equal(short.toolsHash, long.toolsHash);
  assert.notEqual(short.cacheControlHash, long.cacheControlHash);

  const diagnostics = comparePrefixShape(short, long);
  assert.equal(diagnostics.prefixChanged, true);
  assert.equal(diagnostics.prefixChangeSummary, "cacheControl");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["cacheControl"]);
});

test("Switching the breakpoint policy between top-level and explicit is detected", () => {
  const topLevel = capturePrefixShape({
    systemPrompt: "same",
    cacheControl: { cacheRetention: "short", ttl: "", breakpointStrategy: "anthropic-top-level" },
  });
  const explicit = capturePrefixShape({
    systemPrompt: "same",
    cacheControl: { cacheRetention: "short", ttl: "", breakpointStrategy: "anthropic-explicit" },
  });

  assert.equal(comparePrefixShape(topLevel, explicit).prefixChangeSummary, "cacheControl");
});

test("Default cacheControl is equivalent to per-field empty strings and does not jitter due to undefined", () => {
  const omitted = capturePrefixShape({ systemPrompt: "same", tools: BASE_TOOLS });
  const empty = capturePrefixShape({
    systemPrompt: "same",
    tools: BASE_TOOLS,
    cacheControl: { cacheRetention: "", ttl: "", breakpointStrategy: "" },
  });

  assert.deepEqual(omitted, empty);
  assert.equal(comparePrefixShape(omitted, empty).prefixChangeSummary, "unchanged");
});

test("Repeated sampling of the same cache parameters stays stable", () => {
  const cacheControl = {
    cacheRetention: "long",
    ttl: "1h",
    breakpointStrategy: "anthropic-top-level",
  };
  const first = capturePrefixShape({ systemPrompt: "s", cacheControl });
  const second = capturePrefixShape({ systemPrompt: "s", cacheControl: { ...cacheControl } });

  assert.deepEqual(first, second);
});

test("Three dimensions change at once -> multiple, with reasons listed in system / tools / cacheControl order", () => {
  const previous = capturePrefixShape({
    systemPrompt: "old",
    tools: BASE_TOOLS,
    cacheControl: { cacheRetention: "short", breakpointStrategy: "anthropic-top-level" },
  });
  const current = capturePrefixShape({
    systemPrompt: "new",
    tools: [tool("Bash")],
    cacheControl: { cacheRetention: "long", ttl: "1h", breakpointStrategy: "anthropic-explicit" },
  });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChangeSummary, "multiple");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["system", "tools", "cacheControl"]);
});

// ---------------------------------------------------------------------------
// Round-by-round reconciliation: simulating real scenarios such as memory-section drift across midnight

test("Round-by-round reconciliation can locate the round that invalidated the prefix", () => {
  const rounds = [
    { systemPrompt: "base\n\nmemory: today", tools: BASE_TOOLS },
    { systemPrompt: "base\n\nmemory: today", tools: BASE_TOOLS },
    // Across midnight: the memory section's day-level label drifts, invalidating the whole system prefix
    { systemPrompt: "base\n\nmemory: 1 days ago", tools: BASE_TOOLS },
    { systemPrompt: "base\n\nmemory: 1 days ago", tools: BASE_TOOLS },
  ];

  let previous = null;
  const summaries = rounds.map((round) => {
    const shape = capturePrefixShape(round);
    const diagnostics = comparePrefixShape(previous, shape);
    previous = shape;
    return diagnostics.prefixChangeSummary;
  });

  assert.deepEqual(summaries, ["initial", "unchanged", "system", "unchanged"]);
});

// ---------------------------------------------------------------------------
// Pure function: no time or randomness, and it does not mutate its arguments

test("The hash contains no time component: recomputing across time yields the same result", async () => {
  const shape = capturePrefixShape({ systemPrompt: "stable", tools: BASE_TOOLS });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const later = capturePrefixShape({ systemPrompt: "stable", tools: BASE_TOOLS });

  assert.deepEqual(shape, later);
});

test("capturePrefixShape does not mutate the passed-in tools array", () => {
  const tools = [tool("Write"), tool("Bash"), tool("Read")];
  const snapshot = tools.map((item) => item.name);
  capturePrefixShape({ systemPrompt: "system", tools });

  assert.deepEqual(
    tools.map((item) => item.name),
    snapshot,
  );
});

test("Non-serializable parameters do not make the reconciliation chain throw", () => {
  const circular = { type: "object" };
  circular.self = circular;

  const shape = capturePrefixShape({ tools: [tool("Bash", "d", circular)] });
  assert.equal(typeof shape.toolsHash, "string");
  assert.equal(shape.toolsHash.length, 16);
});

// ---------------------------------------------------------------------------
// Snapshot storage: isolated by sessionId; interleaved multi-session use must not pollute each other's baselines

const prefixShapeStore = loader.loadModule("src/lib/debug/prefixShapeStore.ts");
const { readPreviousPrefixShape, recordPrefixShape } = prefixShapeStore;

test("Interleaved writes across sessions do not pollute each other: each reads back its own previous snapshot", () => {
  const shapeA = capturePrefixShape({ systemPrompt: "session-a", tools: BASE_TOOLS });
  const shapeB = capturePrefixShape({ systemPrompt: "session-b", tools: BASE_TOOLS });

  // Simulate interleaving of the main session and a subagent: A writes -> B writes -> A reads; A must not get B's snapshot.
  recordPrefixShape("store-session-a", shapeA);
  recordPrefixShape("store-session-b", shapeB);

  assert.deepEqual(readPreviousPrefixShape("store-session-a"), shapeA);
  assert.deepEqual(readPreviousPrefixShape("store-session-b"), shapeB);

  // Under interleaving, A's next-round attribution must be unchanged, not a false system change after being displaced by B.
  const nextA = capturePrefixShape({ systemPrompt: "session-a", tools: BASE_TOOLS });
  const diagnostics = comparePrefixShape(readPreviousPrefixShape("store-session-a"), nextA);
  assert.equal(diagnostics.prefixChangeSummary, "unchanged");
});

test("Snapshots persist across reads: two successive reads of the same session get the same baseline", () => {
  const shape = capturePrefixShape({ systemPrompt: "persist", tools: BASE_TOOLS });
  recordPrefixShape("store-session-persist", shape);

  assert.deepEqual(readPreviousPrefixShape("store-session-persist"), shape);
  assert.deepEqual(readPreviousPrefixShape("store-session-persist"), shape);
});

test("An unknown session reads back null, and attribution returns to initial rather than reporting changed", () => {
  assert.equal(readPreviousPrefixShape("store-session-unknown"), null);

  const shape = capturePrefixShape({ systemPrompt: "fresh", tools: BASE_TOOLS });
  const diagnostics = comparePrefixShape(readPreviousPrefixShape("store-session-unknown"), shape);
  assert.equal(diagnostics.prefixChangeSummary, "initial");
  assert.equal(diagnostics.prefixChanged, false);
});

test("A missing sessionId degrades to a single slot, semantically equivalent to the old local variable", () => {
  const first = capturePrefixShape({ systemPrompt: "anon-1", tools: BASE_TOOLS });
  const second = capturePrefixShape({ systemPrompt: "anon-2", tools: BASE_TOOLS });

  recordPrefixShape(undefined, first);
  assert.deepEqual(readPreviousPrefixShape(undefined), first);
  // A blank string uses the same measure as missing.
  recordPrefixShape("   ", second);
  assert.deepEqual(readPreviousPrefixShape(""), second);
});

test("The LRU cap evicts the least recently touched session; the active session survives", () => {
  const shape = capturePrefixShape({ systemPrompt: "evict", tools: BASE_TOOLS });
  recordPrefixShape("store-evict-victim", shape);

  // Push in far more sessions than the cap (32), then read back the earliest written one: it should have been evicted.
  for (let index = 0; index < 40; index += 1) {
    recordPrefixShape(`store-evict-filler-${index}`, shape);
  }

  assert.equal(readPreviousPrefixShape("store-evict-victim"), null);
  // The most recently written one is still there.
  assert.deepEqual(readPreviousPrefixShape("store-evict-filler-39"), shape);
});
