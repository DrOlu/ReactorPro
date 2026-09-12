import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// DOM-level verification of the core acceptance criterion "moving/resizing a pane does not remount its DOM"
// (docs/design/session-workbench-pane-architecture.md §30.2).
// Previously only source regexes protected this (PaneSurfaceLayer sorts by paneId + key); this test uses
// jsdom + real react-dom to render PaneSurfaceLayer and compares node instances with Object.is:
// the content DOM of surviving panes must not remount after MOVE/RESIZE (so drafts/scroll/streams survive),
// and CLOSE only removes the closed pane.

const env = await createDomTestEnv();
const { React, act, createRoot } = env;

const { PaneSurfaceLayer } = env.loadModule(
  "@liveagent/ui/components/workbench/PaneSurfaceLayer.tsx",
);
const { applyWorkbenchCommand } = env.loadModule("@liveagent/ui/lib/workbench/reducer.ts");
const { computeWorkbenchGeometry } = env.loadModule("@liveagent/ui/lib/workbench/geometry.ts");

const CANVAS = { left: 0, top: 0, width: 1200, height: 800 };

function conversationPane(paneId, conversationId) {
  return {
    paneId,
    surface: {
      kind: "conversation",
      conversationId,
      project: { projectId: `p-${conversationId}`, projectPathKey: `/ws/${conversationId}` },
    },
    view: {},
  };
}

/** Starting layout with two panes split left/right. */
function twoPaneLayout() {
  return {
    schemaVersion: 1,
    revision: 0,
    root: {
      type: "split",
      splitId: "split-root",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-a" },
      second: { type: "leaf", paneId: "pane-b" },
    },
    panes: {
      "pane-a": conversationPane("pane-a", "conv-a"),
      "pane-b": conversationPane("pane-b", "conv-b"),
    },
    focusedPaneId: "pane-a",
  };
}

function renderLayer(root, layout) {
  const geometry = computeWorkbenchGeometry(layout.root, CANVAS);
  act(() => {
    root.render(
      React.createElement(PaneSurfaceLayer, {
        panes: layout.panes,
        paneGeometries: geometry.panes,
        focusedPaneId: layout.focusedPaneId,
        renderPaneContent: (pane) =>
          React.createElement("div", {
            "data-testid": `content-${pane.paneId}`,
            children: pane.surface.kind === "conversation" ? pane.surface.conversationId : "",
          }),
        getPaneRegionLabel: (pane) => pane.paneId,
      }),
    );
  });
}

function dispatch(layout, command) {
  const result = applyWorkbenchCommand(layout, {
    ...command,
    expectedRevision: layout.revision,
  });
  assert.ok(result.ok, `command ${command.type} must apply: ${JSON.stringify(result)}`);
  return result.layout;
}

function contentNode(container, paneId) {
  return container.querySelector(`[data-testid="content-${paneId}"]`);
}

function frameNode(container, paneId) {
  return container.querySelector(`[data-workbench-pane="${paneId}"]`);
}

test("MOVE_PANE updates rects in place without remounting surviving pane DOM", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  let layout = twoPaneLayout();
  renderLayer(root, layout);

  const contentA = contentNode(container, "pane-a");
  const contentB = contentNode(container, "pane-b");
  const frameA = frameNode(container, "pane-a");
  const frameB = frameNode(container, "pane-b");
  assert.ok(contentA && contentB, "both panes render content");
  const widthBeforeA = frameA.style.width;

  // Move A to B's bottom edge: the horizontal split becomes a vertical split with B on top / A below.
  layout = dispatch(layout, {
    type: "MOVE_PANE",
    paneId: "pane-a",
    target: { kind: "pane-edge", paneId: "pane-b", edge: "bottom" },
  });
  renderLayer(root, layout);

  assert.ok(
    Object.is(contentNode(container, "pane-a"), contentA),
    "pane-a content DOM node must be the same instance after MOVE",
  );
  assert.ok(
    Object.is(contentNode(container, "pane-b"), contentB),
    "pane-b content DOM node must be the same instance after MOVE",
  );
  assert.ok(Object.is(frameNode(container, "pane-a"), frameA), "pane-a frame not remounted");
  assert.ok(Object.is(frameNode(container, "pane-b"), frameB), "pane-b frame not remounted");
  // The geometry really changed (horizontal half-width -> vertical full-width), showing the comparison is not "nothing happened".
  assert.notEqual(frameA.style.width, widthBeforeA, "pane-a rect updated in place");

  act(() => root.unmount());
  container.remove();
});

test("RESIZE_SPLIT keeps every pane's DOM instance", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  let layout = twoPaneLayout();
  renderLayer(root, layout);
  const contentA = contentNode(container, "pane-a");
  const contentB = contentNode(container, "pane-b");
  const widthBeforeA = frameNode(container, "pane-a").style.width;

  layout = dispatch(layout, { type: "RESIZE_SPLIT", splitId: "split-root", ratio: 0.7 });
  renderLayer(root, layout);

  assert.ok(Object.is(contentNode(container, "pane-a"), contentA));
  assert.ok(Object.is(contentNode(container, "pane-b"), contentB));
  assert.notEqual(frameNode(container, "pane-a").style.width, widthBeforeA);

  act(() => root.unmount());
  container.remove();
});

test("CLOSE_PANE removes only the closed pane; the survivor keeps its DOM", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  let layout = twoPaneLayout();
  renderLayer(root, layout);
  const contentB = contentNode(container, "pane-b");

  layout = dispatch(layout, { type: "CLOSE_PANE", paneId: "pane-a" });
  renderLayer(root, layout);

  assert.equal(contentNode(container, "pane-a"), null, "closed pane DOM removed");
  assert.ok(
    Object.is(contentNode(container, "pane-b"), contentB),
    "surviving pane keeps its DOM instance",
  );

  act(() => root.unmount());
  container.remove();
});

test.after(() => {
  env.cleanup();
});
