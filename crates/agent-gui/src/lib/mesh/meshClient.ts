import {
  buildDiscoverQuery,
  type MeshAgent,
  type MeshApproval,
  type MeshClient,
  type MeshDiscoverFilter,
  normalizeMeshStatus,
} from "@liveagent/ui/lib/mesh/types";
import { invoke } from "@tauri-apps/api/core";

/**
 * Desktop mesh client.
 *
 * The WebView is a different origin from the gateway and the gateway sends no
 * CORS headers, so every call goes through the `gateway_api_request` Rust
 * command, which holds the gateway token and only reaches `/api/`.
 */
async function gatewayApiRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  return (await invoke<T>("gateway_api_request", {
    method,
    path,
    body: body ?? null,
  })) as T;
}

export const meshClient: MeshClient = {
  async status() {
    return normalizeMeshStatus(await gatewayApiRequest("GET", "/api/mesh/status"));
  },

  async discover(filter?: MeshDiscoverFilter) {
    const payload = await gatewayApiRequest<{ agents?: MeshAgent[] }>(
      "GET",
      `/api/mesh/agents${buildDiscoverQuery(filter)}`,
    );
    return payload.agents ?? [];
  },

  async register() {
    await gatewayApiRequest("POST", "/api/mesh/register", {});
  },

  async emit(eventType: string, data: unknown) {
    await gatewayApiRequest("POST", "/api/mesh/emit", { type: eventType, data });
  },

  async subscribe(subject: string) {
    await gatewayApiRequest("POST", "/api/mesh/subscribe", { subject });
  },

  async approvals() {
    const payload = await gatewayApiRequest<{ approvals?: MeshApproval[] }>(
      "GET",
      "/api/mesh/approvals",
    );
    return payload.approvals ?? [];
  },

  async decide(approvalId, decision, approver, reason) {
    await gatewayApiRequest(
      "POST",
      `/api/mesh/approvals/${encodeURIComponent(approvalId)}/decision`,
      {
        approver,
        decision,
        reason: reason ?? "",
      },
    );
  },
};
