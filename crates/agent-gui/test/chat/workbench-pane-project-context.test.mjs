import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Invariant: the resolution of "focusedPane → activeProject → dock data source"
// (docs/design/session-workbench-pane-architecture.md §30.2). The projectPathKey carried
// by the focused Pane switches the Right Dock only when it points to a known,
// non-archived, non-missing workspace project; a stale/synthetic key never falls back to
// another project.

const { loadModule } = createTsModuleLoader();
const { resolveWorkbenchPaneProject } = loadModule("src/pages/chat/workbench/paneProjectContext.ts");
const { workspaceProjectPathKey } = loadModule("src/lib/settings/index.ts");

function project(id, path) {
  return {
    id,
    name: id,
    path,
    kind: "folder",
    createdAt: 0,
    updatedAt: 0,
  };
}

const alpha = project("alpha", "/workspaces/alpha");
const beta = project("beta", "/workspaces/beta");

function context(overrides = {}) {
  return {
    workspaceProjects: [alpha, beta],
    archivedWorkspaceProjectPathKeys: new Set(),
    missingWorkspaceProjectPathKeys: new Set(),
    ...overrides,
  };
}

const alphaKey = workspaceProjectPathKey(alpha.path);

test("a live project's path key resolves to that project", () => {
  assert.equal(resolveWorkbenchPaneProject(alphaKey, context()), alpha);
});

test("an undefined or empty key resolves to nothing", () => {
  assert.equal(resolveWorkbenchPaneProject(undefined, context()), null);
  assert.equal(resolveWorkbenchPaneProject("", context()), null);
});

test("an archived project never activates", () => {
  const resolved = resolveWorkbenchPaneProject(
    alphaKey,
    context({ archivedWorkspaceProjectPathKeys: new Set([alphaKey]) }),
  );
  assert.equal(resolved, null);
});

test("a missing project never activates", () => {
  const resolved = resolveWorkbenchPaneProject(
    alphaKey,
    context({ missingWorkspaceProjectPathKeys: new Set([alphaKey]) }),
  );
  assert.equal(resolved, null);
});

test("a stale key never falls back to a different project", () => {
  // Both a synthetic key (conversation:xxx) and the key of a deleted project must miss,
  // rather than picking a "closest" project to fill in.
  assert.equal(resolveWorkbenchPaneProject("conversation:c1", context()), null);
  assert.equal(
    resolveWorkbenchPaneProject(workspaceProjectPathKey("/workspaces/deleted"), context()),
    null,
  );
});

test("matching runs on normalized path keys, same key space as blocked checks", () => {
  // When the project path has a trailing slash, the stored path and the key carried by the pane still match under the same normalization.
  const trailing = project("gamma", "/workspaces/gamma/");
  const resolved = resolveWorkbenchPaneProject(
    workspaceProjectPathKey("/workspaces/gamma"),
    context({ workspaceProjects: [trailing] }),
  );
  assert.equal(resolved, trailing);
});

test("ChatPage routes pane project activation through the resolver", () => {
  const source = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
  assert.match(source, /resolveWorkbenchPaneProject\(projectPathKey, \{/);
  // The old inline find + set decision must not come back: resolution must live in the resolver only.
  assert.equal(
    source.includes("!archivedWorkspaceProjectPathKeys.has(projectPathKey)"),
    false,
    "inline archived/missing checks must stay inside resolveWorkbenchPaneProject",
  );
});
