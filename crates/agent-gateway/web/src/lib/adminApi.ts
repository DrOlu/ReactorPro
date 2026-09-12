// Gateway admin-plane REST client: Agent directory, name, and per-agent credential management.
// Kept separate from the chat/control plane (gatewaySocket) — admin operations are REST + gateway
// Token (Bearer), following the existing patterns of uploadReadableFiles.ts / gatewayAuth.ts.
import { normalizeGatewayAccessToken } from "@/lib/gatewayAuth";

// AdminAgentEntry is a directory entry (matching the JSON shape of Go agentDirectoryEntry).
export type AdminAgentEntry = {
  agent_id: string;
  online: boolean;
  has_token: boolean;
  registered_at: string;
  token_created_at?: string;
  name: string;
  agent_version?: string;
  connected_since?: number;
};

// AdminAgentsPage is one database-paginated page of the Agent directory plus live status.
export type AdminAgentsPage = {
  agents: AdminAgentEntry[];
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
};

export type AdminAgentStatus = "all" | "online" | "offline";

const GENERATED_AGENT_ID_PATTERN =
  /^agent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isGeneratedAgentID(value: string): boolean {
  return GENERATED_AGENT_ID_PATTERN.test(value.trim());
}

async function readError(response: Response, fallback: string): Promise<string> {
  const raw = (await response.text()).trim();
  if (!raw) {
    return fallback;
  }
  try {
    const payload = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const text =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : "";
    return text.trim() || raw;
  } catch {
    return raw;
  }
}

function authHeaders(token: string): HeadersInit {
  const normalized = normalizeGatewayAccessToken(token);
  if (!normalized) {
    throw new Error("Please enter an admin Token.");
  }
  return { Authorization: `Bearer ${normalized}` };
}

export async function listAdminAgents(
  token: string,
  page: number,
  pageSize: number,
  status: AdminAgentStatus = "all",
): Promise<AdminAgentsPage> {
  const url = new URL(`${window.location.origin}/api/agents`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(pageSize));
  url.searchParams.set("status", status);
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(await readError(response, "Failed to load the Agent directory."));
  }
  return (await response.json()) as AdminAgentsPage;
}

// issueAdminToken issues/rotates a credential and immediately takes the current Agent session
// offline; the plaintext is returned only in this response, so the caller must display it
// immediately and cannot retrieve it again.
export async function issueAdminToken(
  token: string,
  agentId: string,
  name: string,
): Promise<string> {
  const url = `${window.location.origin}/api/agents/${encodeURIComponent(agentId)}/token`;
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, "Failed to issue the credential."));
  }
  const payload = (await response.json()) as { token?: string };
  if (!payload.token) {
    throw new Error("The issue response is missing the credential plaintext.");
  }
  return payload.token;
}

export async function updateAdminAgentName(
  token: string,
  agentId: string,
  name: string,
): Promise<void> {
  const url = `${window.location.origin}/api/agents/${encodeURIComponent(agentId)}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, "Failed to update the client name."));
  }
}

export async function deleteAdminAgent(token: string, agentId: string): Promise<void> {
  const url = `${window.location.origin}/api/agents/${encodeURIComponent(agentId)}`;
  const response = await fetch(url, { method: "DELETE", headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(await readError(response, "Failed to delete the client."));
  }
}
