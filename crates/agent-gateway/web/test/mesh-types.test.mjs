import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const { buildDiscoverQuery, emptyMeshStatus, normalizeMeshStatus } = loader.loadModule(
  "@liveagent/ui/lib/mesh/types.ts",
);

test("mesh: an empty status is the disabled shape", () => {
  const status = emptyMeshStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.connected, false);
  assert.deepEqual(status.reputation, []);
  assert.deepEqual(status.pendingApprovals, []);
});

test("mesh: a response from a disabled gateway normalizes without throwing", () => {
  // The gateway reports a disabled bridge as the zero value of every field.
  const status = normalizeMeshStatus({
    enabled: false,
    connected: false,
    agentId: "",
    fingerprint: "",
    url: "",
    serving: false,
    skills: [],
    subscriptions: [],
    reputation: [],
    pendingApprovals: [],
  });
  assert.equal(status.enabled, false);
  assert.equal(status.agentId, "");
  assert.equal(status.lastError, undefined);
});

test("mesh: an older gateway that omits newer fields still normalizes", () => {
  const status = normalizeMeshStatus({ enabled: true, connected: true });
  assert.equal(status.enabled, true);
  assert.equal(status.connected, true);
  assert.deepEqual(status.skills, []);
  assert.deepEqual(status.subscriptions, []);
  assert.deepEqual(status.pendingApprovals, []);
  assert.equal(status.fingerprint, "");
});

test("mesh: a malformed response cannot produce a truthy enabled flag", () => {
  // Anything that is not literally true is treated as false, so a string field
  // arriving where a boolean is expected cannot light up the UI.
  for (const value of [null, undefined, {}, { enabled: "true" }, { enabled: 1 }]) {
    const status = normalizeMeshStatus(value);
    assert.equal(status.enabled, false, `enabled for ${JSON.stringify(value)}`);
    assert.equal(status.connected, false);
  }
});

test("mesh: non-string skills are dropped rather than rendered", () => {
  const status = normalizeMeshStatus({ skills: ["ping", 42, null, "status"] });
  assert.deepEqual(status.skills, ["ping", "status"]);
});

test("mesh: lastError is only surfaced when non-empty", () => {
  assert.equal(normalizeMeshStatus({ lastError: "" }).lastError, undefined);
  assert.equal(normalizeMeshStatus({ lastError: "connect failed" }).lastError, "connect failed");
});

test("mesh: discovery queries encode filters and omit empty ones", () => {
  assert.equal(buildDiscoverQuery(), "");
  assert.equal(buildDiscoverQuery({}), "");
  assert.equal(buildDiscoverQuery({ capabilities: [] }), "");
  assert.equal(buildDiscoverQuery({ capabilities: [""] }), "");
  assert.equal(buildDiscoverQuery({ capabilities: ["sre"] }), "?capabilities=sre");
  assert.equal(
    buildDiscoverQuery({ capabilities: ["sre", "agent"], skillIds: ["ping"] }),
    "?capabilities=sre%2Cagent&skillIds=ping",
  );
  assert.equal(buildDiscoverQuery({ skillIds: ["a b"] }), "?skillIds=a+b");
});
