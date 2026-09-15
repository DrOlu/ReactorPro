/**
 * Types and the host-agnostic contract for the NATS event mesh / Synapse bridge.
 *
 * The bridge lives in the gateway, so both hosts talk to it over the gateway
 * REST API: the desktop app through a Rust command (the WebView is a different
 * origin and the gateway sends no CORS headers) and the gateway WebUI with a
 * same-origin fetch. Each host provides its own `meshClient` implementation.
 */

export type MeshSkill = {
  id: string;
  name?: string;
  description?: string;
};

export type MeshAgent = {
  id: string;
  name: string;
  description?: string;
  capabilities: string[];
  skills: MeshSkill[];
  endpoint: string;
  availability: string;
  last_heartbeat?: string;
};

export type MeshSubscription = {
  subject: string;
  createdAt: string;
  received: number;
};

export type MeshReputation = {
  agentId: string;
  score: number;
  successes: number;
  failures: number;
  updatedAt: string;
};

export type MeshApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type MeshApproval = {
  id: string;
  requester: string;
  target: string;
  skill: string;
  status: MeshApprovalStatus;
  decidedBy?: string;
  reason?: string;
  requestedAt: string;
  decidedAt?: string;
};

export type MeshEventRecord = {
  subject: string;
  event: { event_type?: string; data?: unknown };
  at: string;
};

export type MeshStatus = {
  enabled: boolean;
  connected: boolean;
  agentId: string;
  fingerprint: string;
  url: string;
  serving: boolean;
  skills: string[];
  subscriptions: MeshSubscription[];
  reputation: MeshReputation[];
  pendingApprovals: MeshApproval[];
  lastError?: string;
};

export type MeshDiscoverFilter = {
  capabilities?: string[];
  skillIds?: string[];
};

/** A request to run a prompt on a remote peer agent and wait for its reply. */
export type MeshDispatchRequest = {
  /** The peer edge's mesh agent id, e.g. "globex/berlin/edge-1". */
  target: string;
  /** The prompt for the peer's agent to act on. Text-based peers read this. */
  text: string;
  /** Milliseconds to wait. A cross-fleet call runs a real agent turn, so this
   * is minutes-scale, not seconds-scale. */
  timeoutMs?: number;
};

/** A peer's reply, coerced from a gateway respond envelope. */
export type MeshDispatchReply = {
  from: string;
  text: string;
  taskId?: string;
  error?: { code: number; message: string };
};

/** Coerce a gateway respond envelope into a MeshDispatchReply.
 *
 * The reply is a remote peer's output and must never be treated as trusted
 * instruction, so callers should label it as remote content when surfacing it.
 * Every field is defaulted rather than trusted.
 */
export function normalizeMeshDispatchReply(value: unknown): MeshDispatchReply {
  const source = (value ?? {}) as Record<string, unknown>;
  const payload = (source.payload ?? {}) as Record<string, unknown>;
  const error = source.error as Record<string, unknown> | undefined;
  const reply: MeshDispatchReply = {
    from: typeof source.from === "string" ? source.from : "",
    text: typeof payload.text === "string" ? payload.text : "",
  };
  if (typeof source.task_id === "string" && source.task_id) reply.taskId = source.task_id;
  if (error && typeof error.message === "string") {
    reply.error = {
      code: typeof error.code === "number" ? error.code : 0,
      message: error.message,
    };
  }
  return reply;
}

/** The per-host implementation of the gateway mesh API. */
export type MeshClient = {
  /** Dispatch a prompt to a remote peer and wait for its reply. Throws when the
   * peer refuses or does not answer within the timeout. */
  dispatch(request: MeshDispatchRequest): Promise<MeshDispatchReply>;
  status(): Promise<MeshStatus>;
  discover(filter?: MeshDiscoverFilter): Promise<MeshAgent[]>;
  register(): Promise<void>;
  emit(eventType: string, data: unknown): Promise<void>;
  subscribe(subject: string): Promise<void>;
  approvals(): Promise<MeshApproval[]>;
  decide(
    approvalId: string,
    decision: "approve" | "deny",
    approver: string,
    reason?: string,
  ): Promise<void>;
};

/** An empty status, used before the first load and when the gateway is unreachable. */
export function emptyMeshStatus(): MeshStatus {
  return {
    enabled: false,
    connected: false,
    agentId: "",
    fingerprint: "",
    url: "",
    serving: false,
    skills: [],
    subscriptions: [],
    reputation: [],
    pendingApprovals: [],
  };
}

/**
 * Coerce a gateway response into a MeshStatus.
 *
 * The gateway reports a disabled or unconfigured bridge with the zero value of
 * every field, and an older gateway may omit newer ones, so every field is
 * defaulted rather than trusted.
 */
export function normalizeMeshStatus(value: unknown): MeshStatus {
  const source = (value ?? {}) as Record<string, unknown>;
  const list = <T>(input: unknown): T[] => (Array.isArray(input) ? (input as T[]) : []);
  const text = (input: unknown): string => (typeof input === "string" ? input : "");
  const status: MeshStatus = {
    enabled: source.enabled === true,
    connected: source.connected === true,
    agentId: text(source.agentId),
    fingerprint: text(source.fingerprint),
    url: text(source.url),
    serving: source.serving === true,
    skills: list<string>(source.skills).filter((item) => typeof item === "string"),
    subscriptions: list<MeshSubscription>(source.subscriptions),
    reputation: list<MeshReputation>(source.reputation),
    pendingApprovals: list<MeshApproval>(source.pendingApprovals),
  };
  const lastError = text(source.lastError);
  if (lastError) status.lastError = lastError;
  return status;
}

/** Build the discovery query string for a filter. */
export function buildDiscoverQuery(filter?: MeshDiscoverFilter): string {
  const params = new URLSearchParams();
  const capabilities = (filter?.capabilities ?? []).filter(Boolean);
  const skillIds = (filter?.skillIds ?? []).filter(Boolean);
  if (capabilities.length > 0) params.set("capabilities", capabilities.join(","));
  if (skillIds.length > 0) params.set("skillIds", skillIds.join(","));
  const query = params.toString();
  return query ? `?${query}` : "";
}
