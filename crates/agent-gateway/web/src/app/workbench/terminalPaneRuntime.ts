// Window-level runtime singleton for the Web-side terminal Pane. The lease (View Lease) and the binding
// (Runtime Binding) must be shared across the whole window: useGatewayWorkbench, the terminal Pane host
// and the Right Dock reference the same instance.
//
// Web always starts from the single-Pane home page on each open, so the runtime binding is kept only for the lifetime
// of this page; Desktop continues to use sessionStorage to support re-mounting across webview reloads.

import { createTerminalPaneBindingStore } from "@liveagent/ui/lib/workbench/terminalPaneBindingStore";
import { createTerminalPaneLeaseStore } from "@liveagent/ui/lib/workbench/terminalPaneLeaseStore";
import { createTerminalPaneAutoLaunchRegistry } from "@liveagent/ui/lib/workbench/terminalPaneRuntime";

export const gatewayTerminalPaneLease = createTerminalPaneLeaseStore();
export const gatewayTerminalPaneBindings = createTerminalPaneBindingStore({ storage: null });
export const gatewayTerminalPaneAutoLaunch = createTerminalPaneAutoLaunchRegistry();
