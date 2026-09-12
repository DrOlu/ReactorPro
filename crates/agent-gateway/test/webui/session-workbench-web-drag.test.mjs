// Web-side Session Workbench drag contract tests:
// 1) Model layer — Web and Desktop share the same drag state machine / terminal drop transaction; here we verify the Web
//    window-level singleton (recoverable binding table + in-memory lease) and its combined semantics with the shared transaction: dragging in an existing session first writes
//    the binding then opens a Pane, a repeated drag only moves/focuses, and after closing the Pane (Detach) the binding can be reclaimed.
// 2) Source assertions — useGatewayWorkbench is wired by the same contract as Desktop: CAS-validate the layout
//    revision before submit, a workspace drag atomically opens a new Pane with the draft id returned by the create result, a terminal Pane
//    close reclaims the binding, and the `closed` event closes the Pane in response; the view layer installs dropPreview, the drag
//    ghost, the Pane drag handle and the sidebar / Right Dock drag entry points.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();

const { resolveWorkbenchDropTarget } = loader.loadModule(
  "@liveagent/ui/lib/workbench/dragMachine.ts",
);
const { commitTerminalDrop } = loader.loadModule(
  "@liveagent/ui/lib/workbench/terminalDropCommit.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "@liveagent/ui/lib/workbench/terminalPaneBindingStore.ts",
);
const { createTerminalPaneLeaseStore } = loader.loadModule(
  "@liveagent/ui/lib/workbench/terminalPaneLeaseStore.ts",
);
const { applyWorkbenchCommand, isWorkbenchLayoutValid } = loader.loadModule(
  "@liveagent/ui/lib/workbench/index.ts",
);
const { createInitialWorkbenchLayout } = loader.loadModule(
  "@liveagent/ui/lib/workbench/useWindowWorkbench.ts",
);
const { createGatewayHomeConversationState, isLocalDraftConversationId } = loader.loadModule(
  "src/app/gatewayLocalDraft.ts",
);
const webTerminalRuntime = loader.loadModule("src/app/workbench/terminalPaneRuntime.ts");

const webRoot = fileURLToPath(new URL("../../web", import.meta.url));
const hookSource = readFileSync(
  path.join(webRoot, "src/app/workbench/useGatewayWorkbench.ts"),
  "utf8",
);
const viewSource = readFileSync(path.join(webRoot, "src/app/GatewayAppView.tsx"), "utf8");
const appSource = readFileSync(path.join(webRoot, "src/app/GatewayApp.tsx"), "utf8");
const workspaceDropCommitSource = readFileSync(
  path.join(webRoot, "../../agent-ui/src/lib/workbench/workspaceDropCommit.ts"),
  "utf8",
);
const sharedDragSessionSource = readFileSync(
  path.join(webRoot, "../../agent-ui/src/lib/workbench/useWorkbenchDragSession.ts"),
  "utf8",
);

const PROJECT = { projectId: "project-1", projectPathKey: "/repo" };

function session(id, overrides = {}) {
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
    ...overrides,
  };
}

function singlePaneLayout(paneId = "pane-a") {
  return {
    schemaVersion: 1,
    revision: 1,
    focusedPaneId: paneId,
    root: { type: "leaf", paneId },
    panes: {
      [paneId]: {
        paneId,
        surface: { kind: "conversation", conversationId: "conv-1", project: PROJECT },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Model layer: Web singleton + shared drop transaction
// ---------------------------------------------------------------------------

test("web terminal pane runtime exposes the same binding contract as desktop", () => {
  const { gatewayTerminalPaneBindings } = webTerminalRuntime;
  gatewayTerminalPaneBindings.set("surface-mem", "session-mem");
  assert.equal(gatewayTerminalPaneBindings.get("surface-mem"), "session-mem");
  gatewayTerminalPaneBindings.delete("surface-mem");
  assert.equal(gatewayTerminalPaneBindings.get("surface-mem"), null);
  // When the Node environment has no window/sessionStorage, the shared store safely degrades to an in-memory implementation.
});

test("Web starts from a single-pane homepage and keeps terminal bindings in memory", () => {
  assert.match(hookSource, /persistence:\s*false/);
  assert.match(appSource, /useState\(createGatewayHomeConversationState\)/);
  assert.match(appSource, /resetToFreshHomeConversation\(\)/);
  const runtimeSource = readFileSync(
    path.join(webRoot, "src/app/workbench/terminalPaneRuntime.ts"),
    "utf8",
  );
  assert.match(runtimeSource, /createTerminalPaneBindingStore\(\{ storage: null \}\)/);
});

test("the Web homepage is a valid local-draft root that accepts conversation and terminal splits", () => {
  const home = createGatewayHomeConversationState();
  assert.equal(home.selectedHistoryId, home.conversationId);
  assert.equal(isLocalDraftConversationId(home.conversationId), true);

  const layout = createInitialWorkbenchLayout(home.conversationId, PROJECT);
  assert.equal(isWorkbenchLayoutValid(layout), true);
  assert.equal(layout.root?.type, "leaf");
  assert.equal(layout.panes[layout.focusedPaneId].surface.conversationId, home.conversationId);

  const conversationResult = applyWorkbenchCommand(layout, {
    type: "OPEN_PANE",
    pane: {
      paneId: "pane-conversation",
      surface: { kind: "conversation", conversationId: "conv-2", project: PROJECT },
      view: {},
    },
    target: { kind: "pane-edge", paneId: layout.focusedPaneId, edge: "right" },
    expectedRevision: layout.revision,
  });
  assert.equal(conversationResult.ok, true);
  assert.equal(Object.keys(conversationResult.layout.panes).length, 2);

  const terminalResult = applyWorkbenchCommand(layout, {
    type: "OPEN_PANE",
    pane: {
      paneId: "pane-terminal",
      surface: {
        kind: "localTerminal",
        surfaceId: "surface-terminal",
        project: PROJECT,
        launchSpec: { cwd: "/repo" },
      },
      view: {},
    },
    target: { kind: "pane-edge", paneId: layout.focusedPaneId, edge: "right" },
    expectedRevision: layout.revision,
  });
  assert.equal(terminalResult.ok, true);
  assert.equal(Object.keys(terminalResult.layout.panes).length, 2);
});

test("a blank boot identity degrades to a valid empty layout instead of an invalid pane", () => {
  const layout = createInitialWorkbenchLayout("", PROJECT);
  assert.equal(isWorkbenchLayoutValid(layout), true);
  assert.equal(layout.root, null);
  assert.deepEqual(layout.panes, {});
  assert.equal(layout.focusedPaneId, null);
});

test("dropping an existing dock session binds first, then opens the pane", () => {
  const bindings = createTerminalPaneBindingStore({
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const lease = createTerminalPaneLeaseStore();
  const layout = singlePaneLayout();
  const opened = [];
  const result = commitTerminalDrop(
    { kind: "terminalSession", sessionId: "session-1", project: PROJECT, title: "Build" },
    { kind: "pane-edge", paneId: "pane-a", edge: "right" },
    {
      layout,
      sessions: [session("session-1")],
      lease,
      bindings,
      resolveProjectPath: () => "/repo",
      createSurfaceId: () => "surface-1",
      authorizeAutoLaunch: () => {},
      openTerminalSurface: (surface, target) => {
        // The binding must already be in place when the Pane opens, so the host mount can reuse the session instead of creating a new PTY.
        assert.equal(bindings.get(surface.surfaceId), "session-1");
        opened.push({ surface, target });
        return { paneId: "pane-b" };
      },
      movePane: () => {
        throw new Error("fresh drops never move panes");
      },
      focusPane: () => {},
    },
  );
  assert.deepEqual(result, { action: "opened", paneId: "pane-b", surfaceId: "surface-1" });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].surface.kind, "localTerminal");
  // The lease must be taken synchronously within the drop transaction, so the Right Dock unmounts the viewport in the same render.
  assert.equal(lease.paneIdFor("session-1"), "pane-b");
});

test("a leased session dropped again only moves its existing pane", () => {
  const bindings = createTerminalPaneBindingStore({
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const lease = createTerminalPaneLeaseStore();
  lease.acquire("session-1", "pane-term");
  const layout = singlePaneLayout("pane-a");
  layout.panes["pane-term"] = {
    paneId: "pane-term",
    surface: {
      kind: "localTerminal",
      surfaceId: "surface-1",
      project: PROJECT,
      launchSpec: { cwd: "/repo" },
    },
  };
  const moves = [];
  const result = commitTerminalDrop(
    { kind: "terminalSession", sessionId: "session-1", project: PROJECT, title: "Build" },
    { kind: "pane-edge", paneId: "pane-a", edge: "bottom" },
    {
      layout,
      sessions: [session("session-1")],
      lease,
      bindings,
      resolveProjectPath: () => "/repo",
      createSurfaceId: () => {
        throw new Error("moving a leased session never mints a new surface");
      },
      authorizeAutoLaunch: () => {},
      openTerminalSurface: () => {
        throw new Error("moving a leased session never opens a second pane");
      },
      movePane: (paneId, target) => {
        moves.push({ paneId, target });
        return true;
      },
      focusPane: () => {},
    },
  );
  assert.deepEqual(result, { action: "moved", paneId: "pane-term" });
  assert.equal(moves.length, 1);
});

test("sidebar payloads auto-dock instead of overwriting a pane center", () => {
  const layout = singlePaneLayout("pane-a");
  const geometry = {
    canvas: { left: 0, top: 0, width: 1200, height: 800 },
    panes: [{ paneId: "pane-a", rect: { left: 0, top: 0, width: 1200, height: 800 } }],
    dividers: [],
  };
  const resolved = resolveWorkbenchDropTarget(
    { kind: "pane-center", paneId: "pane-a" },
    { kind: "conversation", conversationId: "conv-2", project: PROJECT, title: "Other" },
    geometry,
    layout,
  );
  assert.deepEqual(resolved, { kind: "pane-edge", paneId: "pane-a", edge: "right" });
});

// ---------------------------------------------------------------------------
// Source assertions: the wiring contract of useGatewayWorkbench
// ---------------------------------------------------------------------------

/** Slice from the marker to the end of that hook/callback dependency array (`]);` or the multi-line `],\n  );`), without anchoring to line numbers. */
function blockFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found: ${marker}`);
  const tail = source.slice(start);
  const end = tail.search(/\][,]?\s*\);/);
  assert.notEqual(end, -1, `unterminated block for marker: ${marker}`);
  return tail.slice(0, end + 3);
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

test("drop commits are CAS-checked against the layout revision", () => {
  const commit = blockFrom(hookSource, "const handleDropCommit = useCallback(");
  assert.match(commit, /commit\.revision !== workbench\.layoutRef\.current\.revision/);
  assert.match(commit, /onDropStateChanged\(\)/);
});

test("workspace drops await the exact draft id before opening the frozen target", () => {
  const commit = blockFrom(hookSource, "const handleDropCommit = useCallback(");
  assertOrder(
    commit,
    [
      'if (payload.kind === "workspace") {',
      'if (target.kind === "pane-center") return;',
      "if (archivedProjectPathKeys.has(pathKey)) return;",
      "pendingWorkspaceDropRef.current = {",
      "conversationId: null,",
      "commitWorkspaceDropConversation({",
      "startConversation: () => startConversationForProjectRef.current(project),",
      "onConversationCreated: (conversationId) => {",
      "pendingWorkspaceDropRef.current = { ...pending, conversationId };",
      "conversationMatchesProject:",
      "openConversation: workbench.openConversation,",
    ],
    "workspace drop",
  );
});

test("the sync effect pauses only for the identified workspace draft", () => {
  const sync = blockFrom(hookSource, "const pendingDrop = pendingWorkspaceDropRef.current;");
  assertOrder(
    sync,
    [
      "shouldDeferWorkspaceDropConversationSync(",
      "return;",
      "lastSyncedConversationRef.current = key;",
      "workbench.syncCurrentConversation(key, sidebarProjectRef(key));",
    ],
    "pending workspace drop guard",
  );
  assert.match(workspaceDropCommitSource, /if \(exactId\) return exactId === currentId/);
});

test("Web exposes the shared unavailable-drop feedback path", () => {
  assert.match(hookSource, /onUnavailable:/);
  assert.match(hookSource, /reason === "geometry-unavailable"/);
});

test("closing a terminal pane recycles its runtime binding (detach-first)", () => {
  const close = blockFrom(hookSource, "const handleClosePane = useCallback(");
  assertOrder(
    close,
    [
      "const result = workbench.closePane(paneId);",
      "gatewayTerminalPaneBindings.delete(pane.surface.surfaceId);",
    ],
    "terminal pane close",
  );
});

test("an explicit dock close cascades to the leased pane via the closed event", () => {
  const effect = blockFrom(hookSource, "return terminalClient.subscribe((event) => {");
  assertOrder(
    effect,
    [
      'if (event.kind !== "closed") return;',
      "findTerminalPaneForSession(closedSessionId, {",
      "if (paneId) handleClosePaneRef.current(paneId);",
    ],
    "closed-event cascade",
  );
});

// ---------------------------------------------------------------------------
// Source assertions: the view layer installs the drag entry points
// ---------------------------------------------------------------------------

test("the canvas renders the drop preview and the drag ghost from dragState", () => {
  assert.match(viewSource, /dropPreview=\{\s*dragState\?\.previewRect/);
  assert.ok(viewSource.includes("data-workbench-drag-ghost"));
});

test("pane chrome, sidebar and right dock all expose drag entry points", () => {
  assert.ok(viewSource.includes("onDragHandlePointerDown={(event) => {"));
  assert.ok(viewSource.includes("workbenchController.beginPaneDrag(pane, title, {"));
  assert.ok(viewSource.includes("onConversationWorkbenchDragIntent={"));
  assert.ok(viewSource.includes("onProjectWorkbenchDragIntent={"));
  assert.ok(viewSource.includes("onTerminalTabDragStart={"));
  assert.ok(viewSource.includes("onNewTerminalDragStart={"));
  assert.ok(viewSource.includes("onOpenTerminalInWorkbench={"));
  assert.ok(viewSource.includes("onOpenNewTerminalInWorkbench={"));
  assert.ok(viewSource.includes("leasedSessionIds={workbenchLeasedDockSessionIds}"));
});

test("terminal panes render through the gateway terminal pane host", () => {
  assert.match(
    viewSource,
    /surface\.kind === "localTerminal" \|\| surface\.kind === "sshTerminal"/,
  );
  assert.ok(viewSource.includes("<GatewayTerminalPaneHost"));
});

// ---------------------------------------------------------------------------
// Source assertions: the session Pane uses the same host model as Desktop
// ---------------------------------------------------------------------------

const hostSource = readFileSync(
  path.join(webRoot, "src/app/workbench/GatewayConversationPaneHost.tsx"),
  "utf8",
);

test("workbench never injects the page stage into the focused pane", () => {
  assert.equal(viewSource.includes("return stage"), false);
  assert.equal(viewSource.includes("key={surface.conversationId}"), false);
  assert.match(viewSource, /<GatewayConversationPaneHost/);
  assert.match(viewSource, /paneId=\{pane\.paneId\}/);
  assert.match(viewSource, /isPrimary=\{isPrimary\}/);
  assert.match(viewSource, /pageComposerRef=\{isPrimary \? composerRef : undefined\}/);
});

test("every conversation pane keeps a stable host; focus only swaps the primary binding", () => {
  assert.match(hostSource, /isPrimary: boolean/);
  assert.match(hostSource, /pageComposerRef\?/);
  assert.match(hostSource, /if \(isDraft \|\| isPrimary\) return;/);
  assert.match(hostSource, /onSend=\{usePrimary && primary \? primary\.onSend : handleSend\}/);
  assert.doesNotMatch(hostSource, /pageComposerRef\.current = null/);
  assert.match(
    hostSource,
    /if \(composerRef\.current\) pageComposerRef\.current = composerRef\.current/,
  );
  assert.match(hostSource, /if \(!hydrated && !isPrimary && rowCount === 0\)/);
});

test("pane chrome owns per-conversation trajectory toggle and hides top tabs when split", () => {
  assert.match(viewSource, /trajectoryToggle=/);
  assert.match(viewSource, /setConversationView\(/);
  assert.match(
    viewSource,
    /activeView === "chat" && hasConversationReply && !workbenchHasMultiplePanes/,
  );
});

test("file-drop hover focuses the pane under the cursor via workbench hit-testing", () => {
  assert.match(viewSource, /focusWorkbenchPaneUnderPoint/);
  assert.match(viewSource, /hitTestWorkbenchDrop\(/);
  assert.match(viewSource, /onDragEnter: handleChatFileDragEnter/);
});

test("conversation reference drags and sends keep the same semantics in every Web pane", () => {
  const conversationDrag = blockFrom(hookSource, "const handleConversationDragIntent = useCallback(");
  assert.match(conversationDrag, /cwd: item\.cwd/);
  assert.match(conversationDrag, /updatedAt: item\.updatedAt/);
  assert.match(sharedDragSessionSource, /findConversationReferenceDropZone/);
  assert.match(sharedDragSessionSource, /zone\.onDrop\(reference\)/);
  assert.match(hostSource, /mentionableConversations=\{context\.mentionableConversations\}/);
  assert.match(
    hostSource,
    /searchMentionableConversations=\{context\.searchMentionableConversations\}/,
  );
  assert.match(hostSource, /referencedConversations,/);
  assert.match(viewSource, /mentionableConversations,/);
  assert.match(viewSource, /searchMentionableConversations,/);
});

test("archived and missing workspaces render a blocked banner without rebinding the pane", () => {
  assert.match(viewSource, /workbench\.projectArchived/);
  assert.match(viewSource, /workbench\.projectMissing/);
  assert.match(hostSource, /data-workbench-pane-blocked=/);
});
