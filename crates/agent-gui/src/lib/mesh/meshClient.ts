import {
  buildDiscoverQuery,
  type MeshAgent,
  type MeshApproval,
  type MeshClient,
  type MeshDiscoverFilter,
  type MeshDispatchReply,
  type MeshDispatchRequest,
  normalizeMeshDispatchReply,
  normalizeMeshStatus,
} from "@liveagent/ui/lib/mesh/types";
import { invoke } from "@tauri-apps/api/core";

/**
 * The default wait for a cross-fleet dispatch. A dispatch runs a real agent
 * turn on the peer (observed 7-19s against live peers, and an agent turn can
 * legitimately take far longer), so this is minutes-scale.
 */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 120_000;

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
  /** The Rust proxy caps this (see GATEWAY_API_MAX_TIMEOUT_SECS). */
  timeoutSecs?: number,
): Promise<T> {
  // The command declares rename_all = "snake_case", so the key must be
  // snake_case on this side — a camelCase key here is silently dropped and the
  // call falls back to the 30s default, which times out real agent turns.
  return (await invoke<T>("gateway_api_request", {
    method,
    path,
    body: body ?? null,
    timeout_secs: timeoutSecs ?? null,
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

  async dispatch(request: MeshDispatchRequest): Promise<MeshDispatchReply> {
    // A dispatch runs a real agent turn on the peer, so the default budget is
    // minutes, not the proxy's 30s default.
    const timeoutMs = request.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    const payload = await gatewayApiRequest<unknown>(
      "POST",
      "/api/mesh/dispatch",
      {
        target: request.target,
        skill: "invoke",
        input: { text: request.text },
        timeoutMs,
      },
      Math.ceil(timeoutMs / 1000) + 5,
    );
    return normalizeMeshDispatchReply(payload);
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
