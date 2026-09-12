import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Interaction between explicit close (registry `closed` event) and workbench Panes:
//   1) Model layer — findTerminalPaneForSession locates the affected Pane by binding;
//   2) Source assertions — ChatPage subscribes to the closed event and closes the Pane; the host
//      parks a session that was "seen and then disappeared" in the session-closed state and never
//      revives a new PTY from launchSpec.
// Background: without this link, closing a terminal already dragged into the canvas from the dock
// triggers the host's stale-binding auto-recreate, manifesting as "the terminal won't close"
// (killing the old process + a loop of starting new processes).

const loader = createTsModuleLoader();
const { findTerminalPaneForSession, createTerminalAppExitGuard } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneRuntime.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);

const chatPageSource = readFileSync(
  new URL("../../src/pages/ChatPage.tsx", import.meta.url),
  "utf8",
);
// The host implementation is already shared with WebUI: source assertions point at the
// implementation in @liveagent/ui.
const hostSource = readFileSync(
  new URL(
    "../../../agent-ui/src/components/workbench/TerminalPaneHost.tsx",
    import.meta.url,
  ),
  "utf8",
);
const projectTerminalsSource = readFileSync(
  new URL("../../src/pages/chat/workspace/useProjectTerminals.tsx", import.meta.url),
  "utf8",
);
const dockSessionsSource = readFileSync(
  new URL("../../../agent-ui/src/components/project-tools/useRightDockSessions.ts", import.meta.url),
  "utf8",
);

const PROJECT = { projectId: "project-1", projectPathKey: "/repo" };

function terminalPane(paneId, surfaceId) {
  return {
    paneId,
    surface: {
      kind: "localTerminal",
      surfaceId,
      project: PROJECT,
      launchSpec: { cwd: "/repo" },
    },
    view: {},
  };
}

function conversationPane(paneId) {
  return {
    paneId,
    surface: { kind: "conversation", conversationId: "conv-1", project: PROJECT },
    view: {},
  };
}

// ---------------------------------------------------------------------------
// Model layer: findTerminalPaneForSession
// ---------------------------------------------------------------------------

test("finds the pane whose binding points at the closed session", () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-a", "session-1");
  bindings.set("surface-b", "session-2");
  const layout = {
    panes: {
      "pane-a": terminalPane("pane-a", "surface-a"),
      "pane-b": terminalPane("pane-b", "surface-b"),
      "pane-c": conversationPane("pane-c"),
    },
  };
  assert.equal(findTerminalPaneForSession("session-2", { bindings, layout }), "pane-b");
  assert.equal(findTerminalPaneForSession("session-1", { bindings, layout }), "pane-a");
});

test("misses cleanly: unbound session, conversation panes, blank id", () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-a", "session-1");
  const layout = {
    panes: {
      "pane-a": terminalPane("pane-a", "surface-a"),
      "pane-c": conversationPane("pane-c"),
    },
  };
  assert.equal(findTerminalPaneForSession("session-9", { bindings, layout }), null);
  assert.equal(findTerminalPaneForSession("   ", { bindings, layout }), null);
  assert.equal(findTerminalPaneForSession("", { bindings, layout }), null);
});

test("connecting window: a binding without a lease still resolves the pane", () => {
  // The drop transaction writes the binding before opening the Pane; a dock close must still hit
  // before the host acquires the lease. This lookup depends only on the binding, not the lease
  // store — verified here directly with empty-lease semantics.
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-fresh", "session-1");
  const layout = { panes: { "pane-fresh": terminalPane("pane-fresh", "surface-fresh") } };
  assert.equal(findTerminalPaneForSession("session-1", { bindings, layout }), "pane-fresh");
});

test("a deleted binding no longer resolves (restart raced with a late closed event)", () => {
  // A late closed event can only arrive after restartFromLaunchSpec synchronously deletes the
  // binding; the lookup must then miss, so the Pane the user just tried to restart is not
  // wrongly closed.
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-a", "session-1");
  const layout = { panes: { "pane-a": terminalPane("pane-a", "surface-a") } };
  bindings.delete("surface-a");
  assert.equal(findTerminalPaneForSession("session-1", { bindings, layout }), null);
});

// ---------------------------------------------------------------------------
// Source assertion: ChatPage's closed-event wiring
// ---------------------------------------------------------------------------

function blockFrom(source, marker, terminator = "]);") {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found: ${marker}`);
  const end = source.indexOf(terminator, start);
  assert.notEqual(end, -1, `unterminated block for marker: ${marker}`);
  return source.slice(start, end + terminator.length);
}

function assertOrderIn(block, steps, label) {
  let previous = -1;
  for (const step of steps) {
    const index = block.indexOf(step);
    assert.notEqual(index, -1, `${label}: missing step ${step}`);
    assert.ok(index > previous, `${label}: step out of order — ${step}`);
    previous = index;
  }
}

test("ChatPage subscribes to closed events and closes the bound pane", () => {
  const effect = blockFrom(chatPageSource, 'if (event.kind !== "closed") return;');
  assert.match(effect, /findTerminalPaneForSession\(closedSessionId, \{/);
  assert.match(effect, /bindings: terminalPaneBindings/);
  assert.match(effect, /layout: workbench\.layoutRef\.current/);
  assert.match(effect, /if \(paneId\) handleWorkbenchClosePane\(paneId\);/);
});

test("the closed-event sync is gated on the workbench flag", () => {
  const start = chatPageSource.indexOf('if (event.kind !== "closed") return;');
  assert.notEqual(start, -1);
  const gate = chatPageSource.lastIndexOf("if (!sessionWorkbench.enabled) return;", start);
  assert.notEqual(gate, -1, "closed-event effect must early-return when workbench is disabled");
  // No other effect may sit between the gate and the subscription (same useEffect body).
  const between = chatPageSource.slice(gate, start);
  assert.equal(between.includes("useEffect"), false);
});

// ---------------------------------------------------------------------------
// App-exit guard: the close_all closed-event storm must not wipe terminal Panes from the layout
// ---------------------------------------------------------------------------

test("the exit guard latches on mark and releases on reset", () => {
  const guard = createTerminalAppExitGuard();
  assert.equal(guard.isExiting(), false);
  guard.mark();
  assert.equal(guard.isExiting(), true);
  guard.mark();
  assert.equal(guard.isExiting(), true);
  guard.reset();
  assert.equal(guard.isExiting(), false);
});

test("ChatPage skips pane teardown while the app-exit guard is set", () => {
  const effect = blockFrom(chatPageSource, 'if (event.kind !== "closed") return;');
  assertOrderIn(
    effect,
    [
      'if (event.kind !== "closed") return;',
      "if (terminalAppExitGuard.isExiting()) return;",
      "findTerminalPaneForSession(closedSessionId, {",
    ],
    "exit-guard precedes pane lookup",
  );
});

test("the exit flow marks the guard before invoking and resets it on failure", () => {
  const markIndex = projectTerminalsSource.indexOf("terminalAppExitGuard.mark();");
  const invokeIndex = projectTerminalsSource.indexOf('await invoke("app_confirmed_exit")');
  assert.ok(markIndex !== -1 && invokeIndex !== -1);
  assert.ok(markIndex < invokeIndex, "guard must be set before app_confirmed_exit");
  const catchStart = projectTerminalsSource.indexOf("} catch (error) {", markIndex);
  const resetIndex = projectTerminalsSource.indexOf("terminalAppExitGuard.reset();");
  assert.ok(catchStart !== -1 && resetIndex > catchStart, "guard must reset when the exit fails");
});

// ---------------------------------------------------------------------------
// Source assertion: the host parks on session-closed for an explicit close and no longer auto-recreates
// ---------------------------------------------------------------------------

test("a session seen live that disappears parks in session-closed instead of recreating", () => {
  const ensureEffect = blockFrom(hostSource, "if (session || errorState) return;");
  const guard = ensureEffect.indexOf("seenLiveSessionIdRef.current === boundSessionId");
  const parked = ensureEffect.indexOf('setErrorState({ kind: "session-closed" })');
  const staleDelete = ensureEffect.indexOf("bindings.delete(surface.surfaceId)");
  const ensureCall = ensureEffect.indexOf("ensureTerminalPaneSession(surface, {");
  assert.ok(guard !== -1, "missing seen-live guard");
  assert.ok(parked !== -1, "missing session-closed state");
  assert.ok(guard < parked, "guard must decide before parking");
  assert.ok(parked < staleDelete, "seen-live guard must run before the stale-binding cleanup");
  assert.ok(staleDelete < ensureCall, "stale cleanup still precedes auto-recreate");
  // The branch that parks in the closed state must return and not fall into the recreate path.
  assert.match(
    ensureEffect,
    /setErrorState\(\{ kind: "session-closed" \}\);\s*return;/,
  );
});

test("session-closed maps to the dedicated missing-session message", () => {
  assert.match(hostSource, /case "session-closed":\s*return t\("workbench\.terminalSessionMissing"\)/);
});

test("the seen-live marker only records sessions observed in the live list", () => {
  const marker = blockFrom(hostSource, "const seenLiveSessionIdRef");
  assert.match(marker, /if \(liveSession\) seenLiveSessionIdRef\.current = liveSession\.id;/);
});

// ---------------------------------------------------------------------------
// Ghost-session self-healing: a record left over in the frontend but already gone from the backend must be able to retire and be closed
// ---------------------------------------------------------------------------

test("dock close treats an already-gone session as closed instead of erroring forever", () => {
  // Inside catch, first re-check against the authoritative list; confirmed disappearance follows
  // the same finalization as a successful close (remove the tab, forget the session), and only a
  // confirmed-alive session surfaces an error. A failed list conservatively treats it as alive
  // and does not delete it by mistake.
  const closeBlock = blockFrom(dockSessionsSource, "const closeSession = useCallback(");
  assertOrderIn(
    closeBlock,
    [
      "const finalizeClose = () => {",
      ".then(finalizeClose)",
      ".catch(async (err) => {",
      ".list()",
      ".catch(() => true)",
      "if (!alive) {",
      "finalizeClose();",
      "setError(err instanceof Error ? err.message : String(err));",
    ],
    "ghost-tolerant close",
  );
});

test("viewport errors escalate to an authoritative session-alive check", () => {
  const handler = blockFrom(hostSource, "const handleViewportError = useCallback(");
  assert.match(handler, /if \(message\) onSessionGhost\?\.\(errorSessionId\);/);
  // Page side: refresh the whole table only on confirmed disappearance; a still-alive session
  // (transient error) leaves the list untouched.
  const verify = blockFrom(projectTerminalsSource, "const verifyTerminalSessionAlive");
  assertOrderIn(
    verify,
    [
      ".list()",
      "if (live.some((session) => session.id === key)) return;",
      "setTerminalSessions(sortTerminalSessions(live));",
    ],
    "verify-alive refresh",
  );
});

test("ChatPage wires the ghost check into every terminal pane host", () => {
  assert.match(chatPageSource, /onSessionGhost=\{verifyTerminalSessionAlive\}/);
});

test("dock viewport errors escalate to the same ghost check as pane hosts", () => {
  const dockSource = readFileSync(
    new URL(
      "../../../agent-ui/src/components/project-tools/RightDockPanel.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  // After error bucketing the dock side likewise raises onSessionGhost; ChatPage wires it to
  // verifyTerminalSessionAlive.
  assert.match(dockSource, /if \(message\) onSessionGhost\?\.\(sessionId\);/);
  assert.match(chatPageSource, /onSessionGhost=\{verifyTerminalSessionAlive\}/);
});
