import {
  TerminalPaneHost as SharedTerminalPaneHost,
  type TerminalPaneHostProps as SharedTerminalPaneHostProps,
} from "@liveagent/ui/components/workbench/TerminalPaneHost";
import { tauriTerminalClient } from "../../../lib/terminal/tauriTerminalClient";
import {
  terminalPaneAutoLaunch,
  terminalPaneBindings,
  terminalPaneLease,
} from "../workbench/terminalPaneRuntime";

export type TerminalPaneHostProps = Omit<
  SharedTerminalPaneHostProps,
  "client" | "bindings" | "lease" | "autoLaunch"
>;

/**
 * Desktop terminal Pane host: shared implementation + desktop injection (Tauri terminal client
 * and window-level lease/binding singletons). For logical semantics see @liveagent/ui's TerminalPaneHost.
 */
export function TerminalPaneHost(props: TerminalPaneHostProps) {
  return (
    <SharedTerminalPaneHost
      {...props}
      client={tauriTerminalClient}
      bindings={terminalPaneBindings}
      lease={terminalPaneLease}
      autoLaunch={terminalPaneAutoLaunch}
    />
  );
}
