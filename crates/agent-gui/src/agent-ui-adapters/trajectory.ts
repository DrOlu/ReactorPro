/**
 * Desktop host for the trajectory view: wires the shared implementation to the real Tauri invoke.
 */

import type { TrajectoryHost } from "@liveagent/ui/contracts/trajectory";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { createInvokeTrajectoryHost } from "@liveagent/ui/lib/trajectory/host";
import { invoke } from "../shims/tauriCore";

/**
 * Constructs the desktop host.
 *
 * @param openFileLink - callback for opening a workspace file; when omitted, the detail panel offers no navigation.
 * @returns the trajectory view host.
 */
export function createTauriTrajectoryHost(
  openFileLink?: (link: ChatFileLink) => void,
): TrajectoryHost {
  return createInvokeTrajectoryHost(invoke, {
    ...(openFileLink === undefined ? {} : { openFileLink }),
  });
}
