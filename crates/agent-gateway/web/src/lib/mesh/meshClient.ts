import {
  buildDiscoverQuery,
  type MeshAgent,
  type MeshApproval,
  type MeshClient,
  type MeshDiscoverFilter,
  normalizeMeshStatus,
} from "@liveagent/ui/lib/mesh/types";

import { loadToken } from "@/lib/storage";

/**
 * WebUI mesh client.
 *
 * The WebUI is served by the gateway itself, so the same-origin fetch needs no
 * proxy — only the stored access token.
 */
async function gatewayApiRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const token = loadToken();
  if (!token) {
    throw new Error("No gateway access token is stored. Sign in again.");
  }

  const hasBody = body !== undefined;
  const response = await fetch(`${window.location.origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // A proxy error page rather than JSON.
      if (!response.ok) throw new Error(text.trim() || `Gateway returned ${response.status}.`);
      throw new Error("The gateway returned a non-JSON response.");
    }
  }

  if (!response.ok) {
    const message =
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `Gateway returned ${response.status}.`;
    throw new Error(message);
  }
  return parsed as T;
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
