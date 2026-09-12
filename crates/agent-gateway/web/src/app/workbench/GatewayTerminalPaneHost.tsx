import {
  TerminalPaneHost,
  type TerminalPaneHostProps,
} from "@liveagent/ui/components/workbench/TerminalPaneHost";
import {
  gatewayTerminalPaneAutoLaunch,
  gatewayTerminalPaneBindings,
  gatewayTerminalPaneLease,
} from "./terminalPaneRuntime";

export type GatewayTerminalPaneHostProps = Omit<
  TerminalPaneHostProps,
  "bindings" | "lease" | "autoLaunch"
>;

/**
 * Web terminal pane host: shared implementation plus gateway injection (the
 * gateway terminal client and the window-level lease/binding singletons). For
 * the logical semantics see TerminalPaneHost in @liveagent/ui.
 */
export function GatewayTerminalPaneHost(props: GatewayTerminalPaneHostProps) {
  return (
    <TerminalPaneHost
      {...props}
      bindings={gatewayTerminalPaneBindings}
      lease={gatewayTerminalPaneLease}
      autoLaunch={gatewayTerminalPaneAutoLaunch}
    />
  );
}
