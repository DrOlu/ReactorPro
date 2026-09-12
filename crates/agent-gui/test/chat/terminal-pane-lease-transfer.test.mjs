import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createTerminalPaneLeaseStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneLeaseStore.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);
const { createTerminalPaneAutoLaunchRegistry } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneRuntime.ts",
);

// Integration-level sequence: the dock ↔ Pane lease transfer path (binding first → mount acquires lease → dock mutual-exclusion set).

test("dock drag-in sequence: bind, open, acquire — dock hidden set tracks the lease", () => {
  const lease = createTerminalPaneLeaseStore();
  const bindings = createTerminalPaneBindingStore({ storage: null });

  // Drop transaction: write the binding first, then open the Pane (mounting the host reuses the session).
  bindings.set("surface-1", "session-1");
  assert.equal(lease.paneIdFor("session-1"), null);
  assert.deepEqual([...lease.leasedSessionIds()], []);

  // Host mount: resolve binding → acquire.
  const release = lease.acquire(bindings.get("surface-1"), "pane-1");
  assert.equal(lease.paneIdFor("session-1"), "pane-1");
  assert.deepEqual([...lease.leasedSessionIds()], ["session-1"]);

  release();
  assert.deepEqual([...lease.leasedSessionIds()], []);
});

test("rapid re-acquire: a stale release token never revokes the successor lease", () => {
  const lease = createTerminalPaneLeaseStore();
  // Effect re-run sequence: acquire → release → immediately re-acquire (new effect on the same pane).
  const first = lease.acquire("session-1", "pane-1");
  first();
  const second = lease.acquire("session-1", "pane-1");
  // A late replay of the old release (out-of-order cleanup) must not mistakenly release the new lease.
  first();
  assert.equal(lease.paneIdFor("session-1"), "pane-1");
  assert.deepEqual([...lease.leasedSessionIds()], ["session-1"]);
  second();
  assert.equal(lease.paneIdFor("session-1"), null);
});

test("detach returns the session to the dock and allows a fresh drag-in", () => {
  const lease = createTerminalPaneLeaseStore();
  const bindings = createTerminalPaneBindingStore({ storage: null });

  bindings.set("surface-1", "session-1");
  const release = lease.acquire("session-1", "pane-1");
  assert.deepEqual([...lease.leasedSessionIds()], ["session-1"]);

  // Detach: closing the Pane releases the lease; semantically the binding is reclaimed along with the Pane's disappearance.
  release();
  bindings.delete("surface-1");
  assert.deepEqual([...lease.leasedSessionIds()], []);

  // Dragged in again: new surfaceId + new paneId, and acquire must succeed.
  bindings.set("surface-2", "session-1");
  lease.acquire("session-1", "pane-2");
  assert.equal(lease.paneIdFor("session-1"), "pane-2");
});

test("conflicting acquire throws and leaves the holder's lease intact", () => {
  const lease = createTerminalPaneLeaseStore();
  lease.acquire("session-1", "pane-a");
  assert.throws(() => lease.acquire("session-1", "pane-b"));
  assert.equal(lease.paneIdFor("session-1"), "pane-a");
  assert.deepEqual([...lease.leasedSessionIds()], ["session-1"]);
});

test("subscription fires across the transfer sequence for dock recomputation", () => {
  const lease = createTerminalPaneLeaseStore();
  let notifications = 0;
  const unsubscribe = lease.subscribe(() => {
    notifications += 1;
  });
  const release = lease.acquire("session-1", "pane-1");
  release();
  assert.equal(notifications, 2);
  unsubscribe();
});

// Distinguishing dormant placeholders from explicit creation: the auto-launch authorization set.

test("auto-launch registry authorizes explicitly created surfaces only", () => {
  const registry = createTerminalPaneAutoLaunchRegistry();
  assert.equal(registry.isAuthorized("surface-restored"), false);
  registry.authorize("surface-new");
  assert.equal(registry.isAuthorized("surface-new"), true);
  // Non-consuming: repeated queries from StrictMode double-mounting still return true.
  assert.equal(registry.isAuthorized("surface-new"), true);
  // Blank input is ignored.
  registry.authorize("   ");
  assert.equal(registry.isAuthorized(""), false);
});
