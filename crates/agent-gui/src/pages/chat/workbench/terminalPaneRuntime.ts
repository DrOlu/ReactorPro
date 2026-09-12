// The terminal pane runtime helpers are shared with the WebUI (the
// implementation lives in @liveagent/ui); this module keeps the desktop's
// window-level singletons so ChatPage, TerminalPaneHost and tests reference
// the same instances.
import {
  createTerminalAppExitGuard,
  createTerminalPaneAutoLaunchRegistry,
} from "@liveagent/ui/lib/workbench/terminalPaneRuntime";
import { createTerminalPaneBindingStore } from "./terminalPaneBindingStore";
import { createTerminalPaneLeaseStore } from "./terminalPaneLeaseStore";

export {
  createTerminalAppExitGuard,
  createTerminalPaneAutoLaunchRegistry,
  createTerminalSurfaceId,
  type EnsureTerminalPaneSessionDeps,
  ensureTerminalPaneSession,
  type FindTerminalPaneForSessionDeps,
  findTerminalPaneForSession,
  isTerminalPaneAutoLaunchAuthorized,
  type ResolveLiveTerminalSurfaceIdsDeps,
  resolveLiveTerminalSurfaceIds,
  type TerminalPaneAutoLaunchRegistry,
  TerminalPaneSshPromptError,
} from "@liveagent/ui/lib/workbench/terminalPaneRuntime";

/**
 * Window-level runtime singleton for the terminal Pane: the lease (View Lease) and the binding
 * (Runtime Binding) must be shared across the whole window; ChatPage, TerminalPaneHost, and the tests reference the same instance.
 */
export const terminalPaneLease = createTerminalPaneLeaseStore();
export const terminalPaneBindings = createTerminalPaneBindingStore();

export const terminalPaneAutoLaunch = createTerminalPaneAutoLaunchRegistry();

export const terminalAppExitGuard = createTerminalAppExitGuard();
