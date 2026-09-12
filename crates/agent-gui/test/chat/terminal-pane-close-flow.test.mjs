// Terminal Pane close = terminate the terminal (no longer Detach back to the Right Dock): a running session
// confirms via a red bar inside the Pane; an exited session is closed directly; a placeholder Pane with no
// session just closes its view. The Pane itself is closed by the linked closed event, so the session never
// flashes in the dock.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { resolveTerminalPaneCloseAction } = loader.loadModule(
  "@liveagent/ui/lib/workbench/terminalPaneClose.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);

const PROJECT = { projectId: "p", projectPathKey: "/repo" };

function terminalPane(paneId, surfaceId) {
  return {
    paneId,
    surface: { kind: "localTerminal", surfaceId, project: PROJECT, launchSpec: { cwd: "/repo" } },
    view: {},
  };
}

function session(id, running) {
  return { id, projectPathKey: "/repo", cwd: "/repo", kind: "local", running, title: "Build" };
}

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("close action: confirm for running, terminate for exited, plain close otherwise", () => {
  const bindings = createTerminalPaneBindingStore();
  bindings.set("surface-a", "session-a");
  bindings.set("surface-b", "session-b");
  bindings.set("surface-ghost", "session-ghost");
  const sessions = [session("session-a", true), session("session-b", false)];

  assert.deepEqual(resolveTerminalPaneCloseAction(terminalPane("a", "surface-a"), sessions, bindings), {
    kind: "confirm",
    session: sessions[0],
  });
  assert.deepEqual(resolveTerminalPaneCloseAction(terminalPane("b", "surface-b"), sessions, bindings), {
    kind: "terminate",
    session: sessions[1],
  });
  // A binding pointing at a vanished session, a dormant placeholder never bound, a non-terminal Pane, or an unknown Pane: close the view directly.
  assert.deepEqual(
    resolveTerminalPaneCloseAction(terminalPane("g", "surface-ghost"), sessions, bindings),
    { kind: "close-pane" },
  );
  assert.deepEqual(
    resolveTerminalPaneCloseAction(terminalPane("d", "surface-dormant"), sessions, bindings),
    { kind: "close-pane" },
  );
  assert.deepEqual(
    resolveTerminalPaneCloseAction(
      { paneId: "c", surface: { kind: "conversation", conversationId: "c1", project: PROJECT }, view: {} },
      sessions,
      bindings,
    ),
    { kind: "close-pane" },
  );
  assert.deepEqual(resolveTerminalPaneCloseAction(undefined, sessions, bindings), {
    kind: "close-pane",
  });
});

test("the shared flow terminates instead of detaching and never re-creates a PTY", () => {
  const flow = readSource("../../../agent-ui/src/lib/workbench/terminalPaneClose.ts");
  assert.match(flow, /client\s*\.close\(session\.id, session\.projectPathKey\)/);
  // The Pane is closed by the closed event; if the event is lost, the Pane is only closed as a fallback after the session is confirmed gone from the list.
  assert.match(flow, /if \(paneStillOpen\(\) && sessionGone\(\)\) closePaneRef\.current\(paneId\);/);
  // Ghost session: close failed but it is already absent from the list -> treat as closed.
  assert.match(flow, /if \(!alive\) \{\s*if \(paneStillOpen\(\)\) closePaneRef\.current\(paneId\);/);
  assert.equal(flow.includes("create("), false);
});

test("the pane host shows the confirmation in place without remounting the viewport", () => {
  const host = readSource("../../../agent-ui/src/components/workbench/TerminalPaneHost.tsx");
  assert.match(host, /data-terminal-pane-close-confirm=\{paneId\}/);
  assert.match(host, /projectTools\.closeRunningTerminal/);
  // The outer wrapper always exists: the red bar appearing/disappearing does not change XTermViewport's parent node.
  assert.match(
    host,
    /<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">\s*\{closeConfirmBar\}/,
  );
});

test("both hosts route the pane × and Meta+Alt+W through the terminal close flow", () => {
  const chatPage = readSource("../../src/pages/ChatPage.tsx");
  const gatewayView = readSource("../../../agent-gateway/web/src/app/GatewayAppView.tsx");
  const gatewayWorkbench = readSource(
    "../../../agent-gateway/web/src/app/workbench/useGatewayWorkbench.ts",
  );
  assert.match(chatPage, /useTerminalPaneCloseFlow\(\{/);
  assert.match(chatPage, /onClose=\{\(\) => requestWorkbenchClosePane\(pane\.paneId\)\}/);
  assert.match(chatPage, /event\.preventDefault\(\);\s*requestWorkbenchClosePane\(focusedPaneId\);/);
  assert.match(chatPage, /closeRequest=\{\s*terminalPaneClose\.pendingClose\?\.paneId === pane\.paneId/);
  assert.match(gatewayWorkbench, /useTerminalPaneCloseFlow\(\{/);
  assert.match(gatewayWorkbench, /event\.preventDefault\(\);\s*requestClosePane\(focusedPaneId\);/);
  assert.match(gatewayView, /onClose=\{\(\) => workbenchController\.requestClosePane\(pane\.paneId\)\}/);
  assert.match(gatewayView, /workbenchController\.terminalPaneCloseRequest\?\.paneId === pane\.paneId/);
  // The path where the closed event closes the Pane is retained as the official route by which the Pane disappears after termination.
  assert.match(chatPage, /if \(paneId\) handleWorkbenchClosePane\(paneId\);/);
  assert.match(gatewayWorkbench, /if \(paneId\) handleClosePaneRef\.current\(paneId\);/);
});

test("a parked session-closed pane recovers by itself when the session is listed again", () => {
  const host = readSource("../../../agent-ui/src/components/workbench/TerminalPaneHost.tsx");
  assert.match(
    host,
    /if \(liveSession && errorState\?\.kind === "session-closed"\) setErrorState\(null\);/,
  );
});
