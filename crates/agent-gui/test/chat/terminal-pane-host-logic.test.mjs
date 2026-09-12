import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Pure logic layer of TerminalPaneHost: restoring Pane explicit authorization,
// stale binding cleanup, ensure's mount-race dedupe, and
// restartFromLaunchSpec's teardown order.
// The host itself needs a DOM to mount, so coverage is split into two layers:
//   1) model layer -- the combined semantics of the real runtime modules
//      (authorization set + binding table + ensure);
//   2) source assertions -- that the host really wires up according to those
//      semantics (guard expressions / early returns / call order).
// The ensure basic paths already covered by terminal-pane-runtime.test.mjs
// (single creation, concurrent sharing of one create, retry after failure,
// SSH prompt error) are not repeated here.

const loader = createTsModuleLoader();
const {
  createTerminalPaneAutoLaunchRegistry,
  ensureTerminalPaneSession,
  isTerminalPaneAutoLaunchAuthorized,
} = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneRuntime.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);

// The host implementation is now shared with the WebUI: source assertions point
// at the implementation in @liveagent/ui; the desktop file is just a thin wrapper
// that injects the Tauri client and the window-level singleton.
const hostSource = readFileSync(
  new URL(
    "../../../agent-ui/src/components/workbench/TerminalPaneHost.tsx",
    import.meta.url,
  ),
  "utf8",
);

const PROJECT = { projectId: "project-1", projectPathKey: "/repo" };

function localSurface(surfaceId) {
  return {
    kind: "localTerminal",
    surfaceId,
    project: PROJECT,
    launchSpec: { cwd: "/repo", shell: "zsh", title: "Build" },
  };
}

function session(id) {
  return {
    id,
    projectPathKey: "/repo",
    cwd: "/repo",
    shell: "zsh",
    title: "Build",
    kind: "local",
    cols: 80,
    rows: 24,
    createdAt: 1,
    updatedAt: 1,
    running: true,
  };
}

function countingClient() {
  let created = 0;
  return {
    get created() {
      return created;
    },
    async create() {
      created += 1;
      return { session: session(`session-${created}`), output: "", truncated: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Model layer: restore authorization
// ---------------------------------------------------------------------------

test("a restored surface without a binding stays unauthorized", () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const autoLaunch = createTerminalPaneAutoLaunchRegistry();
  assert.equal(bindings.get("surface-a"), null);
  assert.equal(isTerminalPaneAutoLaunchAuthorized("surface-a", autoLaunch), false);
});

test("a webview reload that keeps its binding mounts live", () => {
  // sessionStorage alive + Rust terminal registry alive: the binding hits, so it can remount directly without authorization.
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-a", "session-1");
  assert.equal(bindings.get("surface-a"), "session-1");
});

test("an explicitly authorized surface can ensure a replacement PTY", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const autoLaunch = createTerminalPaneAutoLaunchRegistry();
  const client = countingClient();
  const surface = localSurface("surface-a");
  const inflight = new Map();

  autoLaunch.authorize(surface.surfaceId);
  assert.equal(isTerminalPaneAutoLaunchAuthorized(surface.surfaceId, autoLaunch), true);
  const created = await ensureTerminalPaneSession(surface, { client, bindings, inflight });
  assert.equal(client.created, 1);
  assert.equal(bindings.get("surface-a"), created.id);
});

// ---------------------------------------------------------------------------
// Model layer: ensure's dedupe boundary
// ---------------------------------------------------------------------------

test("the module-level in-flight table dedupes the host's own double mount", async () => {
  // The host does not inject inflight, so it uses the module-level shared table; a StrictMode double mount also creates only once on this path.
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const client = countingClient();
  const surface = localSurface(`surface-shared-${Date.now().toString(36)}`);
  const [first, second] = await Promise.all([
    ensureTerminalPaneSession(surface, { client, bindings }),
    ensureTerminalPaneSession(surface, { client, bindings }),
  ]);
  assert.equal(client.created, 1);
  assert.equal(first.id, second.id);
  assert.equal(bindings.get(surface.surfaceId), first.id);
});

test("dedupe is keyed by surfaceId: sibling panes each get their own session", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const client = countingClient();
  const inflight = new Map();
  const [a, b] = await Promise.all([
    ensureTerminalPaneSession(localSurface("surface-a"), { client, bindings, inflight }),
    ensureTerminalPaneSession(localSurface("surface-b"), { client, bindings, inflight }),
  ]);
  assert.equal(client.created, 2);
  assert.notEqual(a.id, b.id);
  assert.equal(bindings.get("surface-a"), a.id);
  assert.equal(bindings.get("surface-b"), b.id);
});

test("in-flight dedupe only guards the mount race; the binding guards idempotence", async () => {
  // The slot is released after settling, so calling ensure again really does
  // create another PTY. The host therefore cannot rely on ensure being
  // idempotent; it checks the binding first (if bound, resolve the existing
  // session and do not enter the ensure branch).
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const client = countingClient();
  const inflight = new Map();
  const surface = localSurface("surface-a");
  await ensureTerminalPaneSession(surface, { client, bindings, inflight });
  assert.equal(inflight.size, 0);
  await ensureTerminalPaneSession(surface, { client, bindings, inflight });
  assert.equal(client.created, 2);
  assert.equal(bindings.get("surface-a"), "session-2");
});

// ---------------------------------------------------------------------------
// Source assertions: the host wires up according to the semantics above
// ---------------------------------------------------------------------------

/** Slice from the marker to the closing `]);` of that hook/callback's dependency array, not anchored to line numbers. */
function blockFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found in TerminalPaneHost: ${marker}`);
  const end = source.indexOf("]);", start);
  assert.notEqual(end, -1, `unterminated block for marker: ${marker}`);
  return source.slice(start, end + 3);
}

function assertOrder(block, steps, label) {
  let previous = -1;
  for (const step of steps) {
    const index = block.indexOf(step);
    assert.notEqual(index, -1, `${label}: missing step ${step}`);
    assert.ok(index > previous, `${label}: step out of order — ${step}`);
    previous = index;
  }
}

test("host exposes a dormant state for restored unbound surfaces", () => {
  assert.equal(hostSource.includes("launchRequestedSurfaceId"), true);
  assert.equal(hostSource.includes('phase = "dormant"'), true);
  assert.equal(hostSource.includes("killSession"), false);
});

test("an unbound surface requires explicit auto-launch authorization", () => {
  const ensureEffect = blockFrom(hostSource, "if (session || errorState) return;");
  assert.match(ensureEffect, /if \(session \|\| errorState\) return;/);
  assertOrder(
    ensureEffect,
    [
      "if (boundSessionId && !pendingEnsure) {",
      "if (!sessionsLoaded) return;",
      "if (!launchAuthorized && !pendingEnsure) return;",
      "ensureTerminalPaneSession(surface, {",
    ],
    "binding-only session-list gate",
  );
});

test("a bound-but-missing restored session drops the stale binding before going dormant", () => {
  const ensureEffect = blockFrom(hostSource, "if (session || errorState) return;");
  assertOrder(
    ensureEffect,
    [
      "if (boundSessionId && !pendingEnsure) {",
      "bindings.delete(surface.surfaceId)",
      "setCreatedSession(null)",
    ],
    "stale-binding branch",
  );
  assert.match(
    ensureEffect,
    /bindings\.delete\(surface\.surfaceId\);\s*setCreatedSession\(null\);\s*return;/,
  );
  // Trigger the binding store update first so the next effect round enters ensure, avoiding a double create in the same round.
  assert.ok(
    ensureEffect.indexOf("bindings.delete(surface.surfaceId)") <
      ensureEffect.indexOf("ensureTerminalPaneSession(surface, {"),
  );
});

test("a fresh binding cannot be deleted while its create promise is settling", () => {
  const ensureEffect = blockFrom(hostSource, "if (session || errorState) return;");
  assertOrder(
    ensureEffect,
    [
      "const pendingEnsure = ensureSessionPromiseRef.current;",
      "if (boundSessionId && !pendingEnsure) {",
      "bindings.delete(surface.surfaceId)",
      "const ensurePromise =",
      "pendingEnsure ??",
      "ensureSessionPromiseRef.current = ensurePromise;",
      "void ensurePromise",
      "setCreatedSession(created)",
    ],
    "create binding/list race guard",
  );
});

test("restartFromLaunchSpec closes the stale session and drops the binding", () => {
  const restart = blockFrom(hostSource, "const restartFromLaunchSpec = useCallback(");
  assertOrder(
    restart,
    [
      "bindings.get(surface.surfaceId)",
      "client.close(staleSessionId)",
      "autoLaunch.authorize(surface.surfaceId)",
      "bindings.delete(surface.surfaceId)",
      "setErrorState(null)",
    ],
    "restartFromLaunchSpec",
  );
  // Restart itself does not call ensure: after clearing the state cleanly, the ensure effect re-runs and takes over.
  assert.equal(restart.includes("ensureTerminalPaneSession"), false);
});

test("only a leased session renders a live viewport", () => {
  // Only a session holding a lease is handed to the viewport for rendering.
  assert.match(hostSource, /const leased = session !== null && leasedSessionId === session\.id;/);
  assert.match(hostSource, /if \(errorState\) \{[\s\S]{0,240}else if \(leased && session\) \{[\s\S]{0,80}renderSession = session;/);
});
