// Web-side project tool Pane contract test: the gateway Workbench controller shares the same
// project tool Surface model and drop transactions with the desktop, GatewayAppView renders
// through ProjectToolPaneHost, and the dock hides tools according to leases.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { commitProjectToolDrop, leasedProjectToolKinds, PROJECT_TOOL_SURFACE_KINDS } =
  loader.loadModule("@liveagent/ui/lib/workbench/index.ts");
const { applyWorkbenchCommand, createEmptyWorkbenchLayout } = loader.loadModule(
  "@liveagent/ui/lib/workbench/index.ts",
);

const PROJECT = { projectId: "p", projectPathKey: "/repo" };

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("gateway workbench wires every project tool through the shared drop transaction", () => {
  const controller = readSource("../../web/src/app/workbench/useGatewayWorkbench.ts");
  assert.match(controller, /payload\.kind === "projectTool"/);
  assert.match(controller, /commitProjectToolDrop\(payload, target, \{/);
  assert.match(controller, /handleToolDragIntent/);
  assert.match(controller, /handleOpenToolInSplit/);
  assert.match(controller, /projectToolTitle\(tool\)/);
  assert.equal(controller.includes("openFileTreeSurface"), false);
  assert.equal(controller.includes('kind: "fileTree"'), false);

  const view = readSource("../../web/src/app/GatewayAppView.tsx");
  assert.match(view, /<ProjectToolPaneHost/);
  assert.match(view, /leasedTools=\{leasedDockTools\}/);
  assert.match(view, /onToolDragStart=/);
  assert.match(view, /onOpenToolInWorkbench=/);
  assert.match(view, /workbench\.paneRegionTool/);
  // When the gateway is offline (no terminal client), tool Panes are not rendered just like terminal Panes.
  assert.match(view, /if \(!projectToolPaneEnvironment\) return null;/);

  const app = readSource("../../web/src/app/GatewayApp.tsx");
  assert.match(app, /projectToolTitle: \(tool\) => translate\(projectToolSurfaceTitleKey\(tool\)/);
});

test("shared drop transaction opens and moves tool panes on the web layout", () => {
  let layout = applyWorkbenchCommand(createEmptyWorkbenchLayout(), {
    type: "OPEN_PANE",
    expectedRevision: 0,
    pane: { paneId: "root", surface: { kind: "conversation", conversationId: "c1", project: PROJECT }, view: {} },
    target: { kind: "canvas-empty" },
  }).layout;
  const deps = () => ({
    layout,
    openProjectToolSurface(surface, target) {
      const result = applyWorkbenchCommand(layout, {
        type: "OPEN_PANE",
        expectedRevision: layout.revision,
        pane: { paneId: `pane-${surface.kind}`, surface, view: {} },
        target,
      });
      assert.ok(result.ok);
      layout = result.layout;
      return { paneId: `pane-${surface.kind}` };
    },
    movePane: () => true,
    focusPane: () => {},
  });
  for (const tool of PROJECT_TOOL_SURFACE_KINDS) {
    const result = commitProjectToolDrop(
      { kind: "projectTool", tool, project: PROJECT, title: tool },
      { kind: "pane-edge", paneId: "root", edge: "right" },
      deps(),
    );
    assert.deepEqual(result, { action: "opened", paneId: `pane-${tool}` });
  }
  assert.deepEqual(
    [...leasedProjectToolKinds(layout, PROJECT.projectPathKey, PROJECT_TOOL_SURFACE_KINDS)].sort(),
    [...PROJECT_TOOL_SURFACE_KINDS].sort(),
  );
  assert.deepEqual(
    commitProjectToolDrop(
      { kind: "projectTool", tool: "sshTunnel", project: PROJECT, title: "ssh" },
      { kind: "pane-edge", paneId: "root", edge: "bottom" },
      deps(),
    ),
    { action: "moved", paneId: "pane-sshTunnel" },
  );
});
