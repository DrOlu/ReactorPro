/**
 * WebUI host for the trajectory view: wires the shared implementation onto the shim's invoke.
 *
 * The shim routes `trajectory_get_events` / `trajectory_get_sections` into the Gateway's
 * `trajectory.fetch` requests, which are still ultimately answered by the desktop side --
 * the WebUI holds no local trajectory data.
 */

import type { TrajectoryHost } from "@liveagent/ui/contracts/trajectory";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { createInvokeTrajectoryHost } from "@liveagent/ui/lib/trajectory/host";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import { invoke } from "@/shims/tauriCore";

/**
 * Constructs the WebUI host.
 *
 * @returns The trajectory view host.
 */
export function createGatewayTrajectoryHost(
  api: GatewayWebSocketClientLike | null,
  openFileLink?: (link: ChatFileLink) => void,
): TrajectoryHost {
  return createInvokeTrajectoryHost(invoke, {
    ...(openFileLink === undefined ? {} : { openFileLink }),
    ...(api === null
      ? {}
      : {
          subscribeRefresh: (listener) => {
            let initialized = false;
            let wasConnected = false;
            return api.subscribeConnection((connected) => {
              if (!initialized) {
                initialized = true;
                wasConnected = connected;
                return;
              }
              const recovered = connected && !wasConnected;
              wasConnected = connected;
              if (recovered) listener();
            });
          },
        }),
  });
}
