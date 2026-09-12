# Project Tool Pane Design (Review / Tunneling / SSH / Background Tasks)

> Status: implemented (2026-09-02). This document describes the design and implementation of splitting the four remaining project tools in the Right Dock into independent Workbench containers (Panes); the desktop and Web sides share the same implementation.
> Prerequisite reading: [session-workbench-pane-architecture.md](session-workbench-pane-architecture.md)
> §15 (Terminal Surface) and §16 (File Tree Surface and the Right Dock Boundary).

## 1. Background and Goals

The Right Dock's "Get Started" panel lists six tools. Before this round:

| Tool | Previous form |
|---|---|
| New Terminal | Already an independent Pane (`localTerminal` / `sshTerminal` Surface, draggable and composable) |
| New File Tree | Already an independent Pane (`fileTree` Surface, project-level singleton + lease) |
| New Review | Right Dock tab only |
| New Tunneling | Right Dock tab only |
| New SSH Connection | Right Dock tab only |
| Background Tasks | Right Dock-derived tab only |

Goals:

1. Review, tunneling, SSH connection, and background tasks can all leave the Right Dock and become draggable, composable, movable/closable Workbench Panes, sharing the same layout engine as the terminal / file tree (split, divider, minimum size, keyboard commands, layout restore).
2. The Right Dock and Panes maintain the lease semantics of "one tool appears in only one host", avoiding duplicate data requests, subscriptions, and state races.
3. The desktop side (`agent-gui`) and the Web side (`agent-gateway/web`) behave consistently, with the implementation placed in the shared layer `@liveagent/ui`, and both ends only doing injection.
4. Do not duplicate any tool panel's business implementation: `GitReviewPanel`, `LocalTunnelPanel`, `SshTunnelPanel`, and `BackgroundTasksPanel` are reused as-is.

Non-goals:

- Do not change the interactions and data flow inside the tool panels.
- Do not change the terminal Pane's lease/binding mechanism.
- Do not introduce cross-window/cross-device layout synchronization.

## 2. Domain Model

### 2.1 Surface Spec

`crates/agent-ui/src/lib/workbench/types.ts` adds a "project tool Surface" family:

```ts
export const PROJECT_TOOL_SURFACE_KINDS = [
  "fileTree", "gitReview", "tunnel", "sshTunnel", "backgroundTasks",
] as const;

export type ProjectToolWorkbenchSurface = {
  [K in ProjectToolSurfaceKind]: { kind: K; project: ProjectRef };
}[ProjectToolSurfaceKind];
```

- A distributed mapped type is used, so `switch (surface.kind)` can narrow kind by kind.
- The original `FileTreeWorkbenchSurface` is kept as an alias of `Extract<…, { kind: "fileTree" }>`.
- All project tool Surfaces carry a `ProjectRef`: when a Pane is focused, the Right Dock follows that project (the `surfaceProjectRef` semantics are unchanged); the layout stores only `{ kind, project }` and no runtime data.

### 2.2 Identity (Uniqueness)

`projectToolSurfaceIdentityKey(kind, projectPathKey)`:

| kind | Identity key | Scope |
|---|---|---|
| fileTree / gitReview / tunnel / sshTunnel | `${kind}:${projectPathKey}` | Project-level singleton |
| backgroundTasks | `backgroundTasks:` | Window-level singleton |

Background tasks mirror the desktop's global ManagedProcess registry and are unrelated to the project; opening a second one for a second project would only show an identical list, so the decision is a whole-window singleton (any project's dock is considered to have leased it). The other four tools are bucketed by project, and opening one review Pane per project is a valid layout.

`surfaceIdentityKey` / `findPaneIdBySurfaceKey` / the reducer's `duplicate-surface` rejection / the `collectWorkbenchLayoutIssues` invariant all still use the same identity key.

### 2.3 Minimum Size

`geometry.ts` defines a hard minimum size (CSS px) for each kind, participating in split feasibility checks, divider clamping, and drop-target rejection:

| kind | minWidth × minHeight | Rationale |
|---|---|---|
| gitReview | 320 × 220 | Toolbar + changed-file list readable; the list/diff split column is enabled internally by the panel itself at ≥500px |
| tunnel | 280 × 200 | One row of form controls + several rows of links |
| sshTunnel | 280 × 200 | Same as above |
| backgroundTasks | 260 × 180 | Process row list |
| fileTree | 240 × 180 | Existing |

### 2.4 Drag Payload

`dragMachine.ts` replaces the original `fileTree` payload with a unified payload:

```ts
| { kind: "projectTool"; tool: ProjectToolSurfaceKind; project: ProjectRef; title: string }
```

- Own-Pane detection (`ownPaneIdForPayload`) looks up by identity key: dropping onto one's own Pane center resolves to focus rather than split.
- Drop feasibility takes that tool's minimum size via `surfaceMinSize({ kind: tool, project })`.

## 3. Transactions and Leases (Shared Pure Functions)

`crates/agent-ui/src/lib/workbench/projectToolDropCommit.ts`, shared by the desktop and Web sides, replacing the file-tree drop logic previously inlined on both ends:

| Function | Semantics |
|---|---|
| `commitProjectToolDrop(payload, target, deps)` | Existing Pane: dropping on its own center → focus; other drop targets → move; empty canvas → ignore. No Pane → open at the drop target. |
| `openProjectToolInSplit(tool, project, deps)` | Menu/keyboard entry: existing Pane → focus; otherwise `resolveAutoDockTarget()` auto-docks, and when there is no space → `onNoSpace()`. |
| `leasedProjectToolKinds(layout, projectPathKey, kinds)` | The set of tools already held by Panes in the layout, used by the Right Dock to hide tabs/content/entries. |

`useWindowWorkbench.openFileTreeSurface` is generalized to `openProjectToolSurface`.

The lease semantics match the file tree (§16): while a Pane exists, the Right Dock does not mount that tool's tab, content, or new-entry (`RightDockPanel.leasedTools`).

**Closing a Pane = closing the tool**: after the layout confirms removal, the Pane's × / `Meta+Alt+W` also removes that tool from the dock (`lib/projectTools/releaseProjectToolFromDock.ts`: the tool tab deletes `tools[kind]` and the tabOrder entry, and clears the activeTabId pointing at it; background tasks are hidden by their own close gesture and the current process id is snapshotted). After the lease is released, the dock will not pop the tab back; for a tool that never entered the dock, this is a no-op. Closing does not modify the project, tunnel, SSH session, or background process; reopening from "Get Started" rebuilds it with the default UI state.

## 4. Pane Host and Runtime Environment

### 4.1 `ProjectToolPaneHost`

`crates/agent-ui/src/components/workbench/ProjectToolPaneHost.tsx`:

```text
ProjectToolPaneHost({ paneId, surface, environment })
├── Resolve WorkspaceProject from surface.project (missing → UnsupportedPaneSurface "<kind>:missing")
├── Assemble RightDockToolContextValue and inject via Provider
└── Render by kind:
    ├── fileTree        → FileTreePaneSurface (props injection, with its own multi-root fetching)
    ├── gitReview       → GitReviewPanel (reads context)
    ├── tunnel          → LocalTunnelPanel
    ├── sshTunnel       → SshTunnelPanel
    └── backgroundTasks → BackgroundTasksPanel (the host is responsible for ensureManagedProcessInit)
```

Design decision: GitReview reads `RightDockToolContext` in 5 files (data layer, state view, toolbar, committer, history), and converting it to props injection would require rewriting the data layer; instead the Pane host "provides the same context", leaving the panel unchanged, and the dock and Pane rendering semantics are naturally consistent.

Tools inside a Pane are always `active` (no tab occlusion), and font scaling follows the dock's `fontScale.rightDock` (`zone-font-scale`).

### 4.2 `ProjectToolPaneEnvironment`

Constructed once per page (`useMemo`), with the same batch of clients / callbacks as those passed to `RightDockPanel`; the only difference is "fetching state by the Pane's own projectPathKey":

| Field | Description |
|---|---|
| `clients` | terminal / git / textGeneration / tunnel / workspaceActivity |
| `capabilities` | git write permission, tunnel toggle and publicBaseUrl, disabled hints |
| `fileTree.getState(key)` / `onStateChange(key, patch)` | Project-bucketed file tree UI state |
| `fileTree.onOpenFile(request)` / `onInsertFileMention` / `onRevealInFileTree(key, path)` | Open editor/preview, @ mention, review → file tree locate |
| `git` | commit/file mention, code-review skill, `focusRequest` |
| `ssh.getAssociatedHostIds(key)` / `onAssociatedHostIdsChange(key, ids)` | Project-associated hosts |
| `ssh.sessions` + `onSessionSnapshot` / `onSessionClosed` / `onSessionsReconcile` | Bridge with the page-level session list (`sessionStore.ts` adds the pure functions `mergeTerminalSession` / `removeTerminalSession` / `reconcileSshTerminalSessions`) |
| `activeProjectPathKey` | Composer mention insertion and git focusRequest only take effect for the Right Dock's current project |

## 5. Interaction Entries

| Entry | Behavior |
|---|---|
| The six "Get Started" cards | Click: open inside the dock (unchanged). Press and drag (mouse/pen, not touch): drag out to the canvas, and dropping directly opens that tool's Pane (`onToolDragStart`). |
| Right Dock tool tab (including background tasks) | Drag out to the canvas; right-click/long-press menu "Open in split view" (`onOpenToolInWorkbench`). |
| New (+) menu | Already-leased tools are no longer listed. |
| Pane top chrome | Drag the handle to move / compose, × to close (also closing that tool in the dock); the keyboard `Meta/Ctrl+Alt+direction/W/=` is unchanged. |
| Drag ghost / drop preview | The title uses the copy corresponding to `projectToolSurfaceTitleKey(kind)`. |
| Accessibility | Region label `workbench.paneRegionTool` ("Tool panel: {title}"). |

## 6. Host Wiring

### Desktop `crates/agent-gui/src/pages/ChatPage.tsx`

- Drop commit: `payload.kind === "projectTool"` → `commitProjectToolDrop`.
- `handleToolWorkbenchDragIntent(kind, event)` / `handleOpenToolInWorkbenchSplit(kind)` replace the file-tree-specific handlers; `dockToolProjectRef()` provides the ProjectRef of the Right Dock's current project.
- `renderPaneContent`: `isProjectToolSurface(surface)` → `<ProjectToolPaneHost>`.
- `leasedDockTools = leasedProjectToolKinds(layout, terminalProjectPathKey, PROJECT_TOOL_SURFACE_KINDS)`
  is passed to `RightDockPanel.leasedTools`.

### Web `crates/agent-gateway/web/src/app/`

- `workbench/useGatewayWorkbench.ts`: the same drop / open-in-split transactions; the controller exposes `handleToolDragIntent` / `handleOpenToolInSplit`; a new `projectToolTitle(tool)` parameter is added for localizing the ghost title, and `onProjectToolPaneClosed(tool, key)` is wired by GatewayApp to `releaseProjectToolFromDock`.
- `GatewayAppView.tsx`: `projectToolPaneEnvironment` (null when the terminal client is not connected, in which case tool Panes are not rendered just like terminal Panes), `leasedDockTools`, `ProjectToolPaneHost`.
- Session bridging: `useProjectToolsRuntime.updateProjectTerminalSessions(updater)` merges functionally against React's current value (the same convention as the dock side's `sessionsRef.current`), preventing the SSH panel's snapshot / reconcile from overwriting each other when they arrive back-to-back between a single re-render.

## 7. Persistence and Restore

The layout still goes through `layoutStorage.ts` (localStorage, validated by `isWorkbenchLayoutValid`). New kinds store only `{ kind, project }`:

- If the project still exists after restore → render normally; if the project is missing/archived → an `UnsupportedPaneSurface` placeholder (`<kind>:missing`) that can be moved/closed and is not automatically rebound.
- Old versions reading a new kind: `collectWorkbenchLayoutIssues` deems it invalid due to the unknown kind and falls back to an empty layout (consistent with the existing forward-compat strategy).

## 8. Tests

| File | Coverage |
|---|---|
| `crates/agent-gui/test/chat/workbench-project-tool-surfaces.test.mjs` | Identity keys and scopes, minimum sizes, reducer uniqueness (same-project rejection / cross-project coexistence / background-task window singleton), invariants, the four `commitProjectToolDrop` drop targets, `openProjectToolInSplit`, drag drop-target resolution (own Pane → focus, minimum-size rejection), dock lease hiding, both-end source contract |
| `crates/agent-gateway/test/webui/session-workbench-web-project-tools.test.mjs` | Web controller/view wiring contract, open/move of the shared transactions on the Web layout |
| Existing `workbench-dock-focus` / `right-dock-model` / `workbench-drag-performance` | Updated for the `leasedTools` / `projectTool` payloads |

`pnpm test:gui` and `pnpm test:webui` all pass; the three-end `tsc`, Biome on changed paths, `check:ui-boundaries`, and `vite build` pass.

## 9. Known Boundaries and Follow-ups

- **Git focusRequest routing**: the session card's "View diff" still writes the dock's `tools.gitReview` and emits a focusRequest; if the review is already in a Pane, the dock hides that tab and the Pane consumes the request, but it will not automatically focus that Pane. A follow-up could wire `handleChangedFileOpenDiff` to "leased → focusPane".
- **SSH interactive terminal**: the SSH connection Pane is the connection management entry; "Enter Bash / SFTP" still opens the workspace overlay or drags out an `sshTerminal` Pane, with the mutual-exclusion rules of §15/§16 unchanged.
- **Background task scope**: the whole-window singleton is a product decision; if the registry is ever bucketed by project, changing `projectToolSurfaceIdentityKey` in one place suffices.
- **No project context**: Tunnel and background tasks can themselves run in the Right Dock without a project, but all project tool Surfaces in the Workbench layout require a stable `ProjectRef`, so when no workspace is selected, drag-out and "Open in split view" entries are not provided; the entries return after a workspace is selected.
- **Real-device matrix**: this round is model/contract tests + build verification; no three-platform real-device drag verification was done.