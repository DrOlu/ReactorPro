import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Invariant: "clicking a control inside the Right Dock does not change focusedPaneId"
// (docs/design/session-workbench-pane-architecture.md §28, §30.2).
// The Dock sits outside the Canvas and only does session lists / tool panels; it neither holds a layout command
// path (source-level assertion) nor does the reducer change focus except on explicit FOCUS/OPEN (model-level assertion).
//
// Terminals and file trees leased by a Pane are hidden from the dock entirely (a tool appears in at most one host
// at a time), so the dock keeps no Pane focus affordance. The SSH overlay's shell tab is the sole exception: it is
// a connection-management entry point and keeps the placeholder jump callback injected by the page.

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const DOCK_SOURCES = {
  "RightDockPanel.tsx": readSource(
    "../../../agent-ui/src/components/project-tools/RightDockPanel.tsx",
  ),
  "RightDockTabStrip.tsx": readSource(
    "../../../agent-ui/src/components/project-tools/RightDockTabStrip.tsx",
  ),
  "RightDockContent.tsx": readSource(
    "../../../agent-ui/src/components/project-tools/RightDockContent.tsx",
  ),
  "RightDockLauncher.tsx": readSource(
    "../../../agent-ui/src/components/project-tools/RightDockLauncher.tsx",
  ),
  "useRightDockSessions.ts": readSource(
    "../../../agent-ui/src/components/project-tools/useRightDockSessions.ts",
  ),
  "useRightDockProjectTabs.ts": readSource(
    "../../../agent-ui/src/components/project-tools/useRightDockProjectTabs.ts",
  ),
};

const chatPageSource = readSource("../../src/pages/ChatPage.tsx");

/**
 * Extract the props text of `<RightDockPanel ... />` in ChatPage. Scans by `{}` depth, robust to
 * prop additions/removals and line reflow (does not anchor to line numbers).
 */
function extractJsxProps(source, componentName) {
  const start = source.indexOf(`<${componentName}`);
  assert.notEqual(start, -1, `${componentName} JSX not found in ChatPage`);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (depth === 0 && char === "/" && source[index + 1] === ">") {
      return source.slice(start, index + 2);
    }
  }
  assert.fail(`${componentName} JSX block is unterminated`);
}

test("dock components hold no workbench layout commands", () => {
  for (const [name, source] of Object.entries(DOCK_SOURCES)) {
    // Calling a focus command directly = wiring dock clicks into the focus path, exactly the pattern this invariant blocks.
    assert.equal(source.includes("focusPane("), false, `${name} calls focusPane(`);
    assert.equal(source.includes("FOCUS_PANE"), false, `${name} dispatches FOCUS_PANE`);
    // Coarser guardrail: the dock should not import the layout layer at all (reducer/commands/useWindowWorkbench).
    assert.equal(source.includes("lib/workbench"), false, `${name} imports the workbench layout lib`);
    assert.equal(
      source.includes("applyWorkbenchCommand"),
      false,
      `${name} applies a workbench command`,
    );
    assert.equal(source.includes("useWindowWorkbench"), false, `${name} uses the workbench hook`);
  }
});

test("leased sessions are hidden from dock terminal tabs, leaving no focus affordance", () => {
  // New semantics: a session dragged onto the canvas is filtered out of localSessions entirely, so the dock has no
  // tab, viewport, or jump button for it; it returns automatically once detach releases the lease.
  assert.match(
    DOCK_SOURCES["useRightDockSessions.ts"],
    /!leasedSessionIds\?\.has\(session\.id\)/,
  );
  // The dock's local terminal path no longer has any Pane focus callback.
  assert.equal(DOCK_SOURCES["RightDockContent.tsx"].includes("onFocusWorkbenchPane"), false);
  assert.equal(DOCK_SOURCES["RightDockTabStrip.tsx"].includes("onFocusWorkbenchPane"), false);
  assert.equal(DOCK_SOURCES["RightDockPanel.tsx"].includes("onFocusWorkbenchPane"), false);
  // The leased marker state is retired along with the hide semantics.
  assert.equal(DOCK_SOURCES["RightDockTabStrip.tsx"].includes("isLeased"), false);
  assert.equal(
    DOCK_SOURCES["RightDockContent.tsx"].includes("terminalLeasedPlaceholder"),
    false,
  );
});

test("a leased project tool leaves the dock tab, content, and launcher", () => {
  // File tree / review / tunnels / SSH / background tasks share the same lease set: when the layout has a Pane for
  // that tool, the dock no longer mounts its tab, content, or create entry.
  assert.match(
    DOCK_SOURCES["useRightDockProjectTabs.ts"],
    /getRightDockVisibleTabs\(\{[\s\S]*leasedTools/,
  );
  assert.match(DOCK_SOURCES["RightDockContent.tsx"], /leasedTools\.has\(definition\.kind\)\) return null/);
  assert.match(DOCK_SOURCES["RightDockContent.tsx"], /!leasedTools\.has\("backgroundTasks"\)/);
  assert.match(DOCK_SOURCES["RightDockLauncher.tsx"], /!leasedTools\.has\(definition\.kind\)/);
  assert.match(DOCK_SOURCES["RightDockLauncher.tsx"], /leasedTools\.has\("backgroundTasks"\)/);
  assert.equal(DOCK_SOURCES["RightDockContent.tsx"].includes("openInWorkbenchHint"), false);
  assert.equal(DOCK_SOURCES["RightDockContent.tsx"].includes("onFocusFileTreePane"), false);
  assert.equal(DOCK_SOURCES["RightDockContent.tsx"].includes("fileTreeLeased"), false);
});

test("dock tab selection routes through dock-local state, never through pane focus", () => {
  const sessions = DOCK_SOURCES["useRightDockSessions.ts"];
  // Selecting a terminal tab only writes the dock's own activeTabId (project state), never the layout.
  assert.match(sessions, /activeTabId: session\.id/);
  assert.equal(sessions.includes("onFocusWorkbenchPane"), false);
  assert.equal(sessions.includes("paneId"), false);
});

test("ChatPage passes only tool lease state into the dock", () => {
  const dockProps = extractJsxProps(chatPageSource, "RightDockPanel");
  // The Dock only needs to know which tools are leased by a Pane; it should gain no Pane focusing capability.
  assert.match(dockProps, /leasedTools=\{leasedDockTools\}/);
  assert.match(
    chatPageSource,
    /leasedProjectToolKinds\(workbench\.layout, terminalProjectPathKey, PROJECT_TOOL_SURFACE_KINDS\)/,
  );
  assert.equal(dockProps.includes("onFocusFileTreePane"), false);
  // (onGitReviewFocusRequest* are scroll/selection requests inside the git panel, unrelated to Pane focus,
  // so they are filtered out by the "Pane" match.)
  const paneFocusProps = [...dockProps.matchAll(/\bon[A-Za-z]*Focus[A-Za-z]*Pane[A-Za-z]*=/g)].map(
    (match) => match[0],
  );
  assert.deepEqual(paneFocusProps, []);
});

test("the explicit jump only focuses a pane that actually holds the session's lease", () => {
  // The allowlisted path itself is narrow: with no lease (the session is still in the dock) it does nothing and
  // never guesses a Pane from the sessionId to steal focus.
  const helper = chatPageSource.slice(chatPageSource.indexOf("const focusWorkbenchTerminalPane"));
  const body = helper.slice(0, helper.indexOf("\n  );") + 5);
  assert.match(body, /terminalPaneLease\.paneIdFor\(sessionId\)/);
  assert.match(body, /if \(paneId && workbench\.layoutRef\.current\.panes\[paneId\]\)/);
  assert.match(body, /handleWorkbenchFocusPane\(paneId\)/);
});

// ---------------------------------------------------------------------------
// Model layer: only explicit FOCUS/OPEN change focusedPaneId in the reducer.
// ---------------------------------------------------------------------------

const loader = createTsModuleLoader();
const { applyWorkbenchCommand } = loader.loadModule("@liveagent/ui/lib/workbench/reducer.ts");
const { createEmptyWorkbenchLayout } = loader.loadModule("@liveagent/ui/lib/workbench/types.ts");

let splitCounter = 0;
const reducerOptions = { createSplitId: () => `split-${++splitCounter}` };

const PROJECT = { projectId: "project-main", projectPathKey: "/workspace/project-main" };

function conversationPane(paneId, conversationId) {
  return {
    paneId,
    surface: { kind: "conversation", conversationId, project: PROJECT },
    view: {},
  };
}

function terminalPane(paneId, surfaceId) {
  return {
    paneId,
    surface: {
      kind: "localTerminal",
      surfaceId,
      project: PROJECT,
      launchSpec: { cwd: "/workspace/project-main" },
    },
    view: {},
  };
}

function apply(layout, command) {
  return applyWorkbenchCommand(
    layout,
    { expectedRevision: layout.revision, ...command },
    reducerOptions,
  );
}

function mustApply(layout, command) {
  const result = apply(layout, command);
  assert.equal(result.ok, true, `command ${command.type} failed: ${JSON.stringify(result)}`);
  return result.layout;
}

/** Conversation Pane + a terminal Pane dragged in from the dock; focus rests on the conversation Pane. */
function dockedLayout() {
  const withConversation = mustApply(createEmptyWorkbenchLayout(), {
    type: "OPEN_PANE",
    pane: conversationPane("pane-conv", "conv-a"),
    target: { kind: "canvas-empty" },
  });
  const withTerminal = mustApply(withConversation, {
    type: "OPEN_PANE",
    pane: terminalPane("pane-term", "term-1"),
    target: { kind: "pane-edge", paneId: "pane-conv", edge: "right" },
  });
  return mustApply(withTerminal, { type: "FOCUS_PANE", paneId: "pane-conv" });
}

test("dragging a dock session in is an explicit open: focus follows the new pane", () => {
  // Intentional exception: an explicit open is an explicit jump, unlike "clicking a dock control".
  const layout = mustApply(
    mustApply(createEmptyWorkbenchLayout(), {
      type: "OPEN_PANE",
      pane: conversationPane("pane-conv", "conv-a"),
      target: { kind: "canvas-empty" },
    }),
    {
      type: "OPEN_PANE",
      pane: terminalPane("pane-term", "term-1"),
      target: { kind: "pane-edge", paneId: "pane-conv", edge: "right" },
    },
  );
  assert.equal(layout.focusedPaneId, "pane-term");
});

test("resizing the split that hosts a dock terminal never moves focus", () => {
  const layout = dockedLayout();
  const splitId = layout.root.splitId;
  const resized = mustApply(layout, { type: "RESIZE_SPLIT", splitId, ratio: 0.72 });
  assert.equal(resized.root.ratio, 0.72);
  assert.equal(resized.revision, layout.revision + 1);
  assert.equal(resized.focusedPaneId, "pane-conv");
});

test("equalizing a split never moves focus", () => {
  const base = dockedLayout();
  const splitId = base.root.splitId;
  const skewed = mustApply(base, { type: "RESIZE_SPLIT", splitId, ratio: 0.8 });
  const equalized = mustApply(skewed, { type: "EQUALIZE_SPLIT", splitId });
  assert.equal(equalized.root.ratio, 0.5);
  assert.equal(equalized.focusedPaneId, "pane-conv");
});

test("re-opening a session already living in a pane is rejected and leaves focus put", () => {
  // Dragging in again a session already taken from the dock by a Pane: the reducer rejects the duplicate surface;
  // "jump to an existing Pane" must be an explicit FOCUS_PANE from the caller, not a side effect of OPEN.
  const layout = dockedLayout();
  const result = apply(layout, {
    type: "OPEN_PANE",
    pane: terminalPane("pane-term-dup", "term-1"),
    target: { kind: "pane-edge", paneId: "pane-conv", edge: "bottom" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "duplicate-surface");
  assert.equal(result.error.currentRevision, layout.revision);
  assert.equal(layout.focusedPaneId, "pane-conv");
  assert.equal(Object.keys(layout.panes).length, 2);
});

test("a whole dock-shaped command run keeps focus until an explicit FOCUS_PANE", () => {
  let layout = dockedLayout();
  const splitId = layout.root.splitId;
  const steps = [
    { type: "RESIZE_SPLIT", splitId, ratio: 0.3 },
    { type: "RESIZE_SPLIT", splitId, ratio: 0.65 },
    { type: "EQUALIZE_SPLIT", splitId },
    { type: "SWAP_PANES", firstPaneId: "pane-conv", secondPaneId: "pane-term" },
  ];
  for (const step of steps) {
    layout = mustApply(layout, step);
    assert.equal(layout.focusedPaneId, "pane-conv", `${step.type} moved focus`);
  }
  // A failed command likewise must not change focus.
  const failed = apply(layout, { type: "RESIZE_SPLIT", splitId: "split-missing", ratio: 0.5 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "target-not-found");
  assert.equal(layout.focusedPaneId, "pane-conv");

  const focused = mustApply(layout, { type: "FOCUS_PANE", paneId: "pane-term" });
  assert.equal(focused.focusedPaneId, "pane-term");
});

test("re-focusing the already focused pane is a no-op with no revision churn", () => {
  // Repeated clicks on the dock placeholder's "focus workbench panel" produce no layout revision/persistence churn.
  const layout = dockedLayout();
  const result = apply(layout, { type: "FOCUS_PANE", paneId: "pane-conv" });
  assert.equal(result.ok, true);
  assert.equal(result.layout, layout);
  assert.equal(result.layout.revision, layout.revision);
});

test("the dock toggle badge counts only sessions still living in the dock", () => {
  // The header collapse button's sessionCount stays consistent with the dock's tab count: sessions dragged onto the
  // canvas (leased) are not counted, and are counted again once detach returns them.
  const start = chatPageSource.indexOf("const projectTerminalSessions = useMemo(");
  assert.notEqual(start, -1);
  const memo = chatPageSource.slice(start, chatPageSource.indexOf("]);", start) + 3);
  assert.match(memo, /!leasedDockSessionIds\?\.has\(session\.id\)/);
  assert.match(chatPageSource, /sessionCount=\{projectTerminalSessions\.length\}/);
});
