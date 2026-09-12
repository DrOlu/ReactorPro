import { serverPolicyKeyCandidates } from "@liveagent/ui/contracts/mcpServerDefaults";

import type { ToolPolicy } from "../settings";
import type { BuiltinToolMetadata } from "./builtinTypes";

// The construction and candidate order of server policy keys live in contracts: the settings
// page (agent-ui) reading policies must follow the same order as the runtime resolution here;
// see the comment on serverPolicyKeyCandidates.
export {
  TOOL_SERVER_POLICY_PREFIX,
  toolServerPolicyKey,
} from "@liveagent/ui/contracts/mcpServerDefaults";
export type { ToolPolicy } from "../settings";

/**
 * Tool group-level default policies are stored in toolPolicies under the key `group:<groupId>`
 * (e.g. group:mcp). Real tool names never contain a colon prefix, so they cannot collide with it;
 * reusing the same policy table avoids adding new settings fields and sync paths. An explicit
 * policy for a single tool name still takes precedence over the group level.
 */
export const TOOL_GROUP_POLICY_PREFIX = "group:";

export function toolGroupPolicyKey(groupId: string): string {
  return `${TOOL_GROUP_POLICY_PREFIX}${groupId}`;
}

/**
 * Resolve the approval policy for one tool call. Design goals: explicit config always wins, and
 * defaults guarantee zero regression to existing behavior (builtin/MCP allow by default), blocking
 * by default only for third-party plugin tools.
 *
 * Decision order (from most specific to coarsest; the first match wins):
 * 1. Explicit override for this tool name (toolPolicies[toolName]) --- most specific, highest priority.
 * 2. MCP policy by server (server:<serverId>, only for MCP tools that carry a serverId).
 * 3. Server-level hardcoded default (`metadata.serverPolicyDefault`): tools of certain servers
 *    directly operate the user's machine (e.g. cua-driver's kill_app / type_text) and must not be
 *    implicitly allowed by the fallback allow in step 7. A user's explicit choice in step 2 overrides
 *    it. This value is computed when building the tool table from the server config (including
 *    command), not looked up by id here --- the id is a user-modifiable display identifier, see
 *    contracts/mcpServerDefaults.ts.
 * 4. Tool group-level default (group:<groupId>, e.g. setting "all MCP tools" to ask/deny).
 *    Both 2 and 4 are the user's explicit statement about a broader scope and should override the
 *    read-only defaults below.
 * 5. The browser group defaults to ask when there is no explicit config: a browser can reach the
 *    network and interact with external sites, so first use must go through user approval once (the
 *    user can allow the session with approve_session). This default is also declared in the
 *    defaultPolicy field of agent-ui's builtinToolCatalog (the settings page displays the default
 *    from it and decides when to write an explicit key), so the two must stay in sync.
 * 6. Read-only tools (metadata.isReadOnly) are always allow: read operations have no side effects
 *    and should not interrupt the conversation.
 * 7. Everything else (builtin, mcp, unknown names without metadata) defaults to allow: keep the
 *    status quo and do not introduce regressions.
 */
export function resolveToolPolicy(
  toolName: string,
  metadata: BuiltinToolMetadata | undefined,
  policies: Record<string, ToolPolicy> | undefined,
): ToolPolicy {
  const explicit = policies?.[toolName];
  if (explicit) return explicit;
  const serverId = metadata?.serverId;
  if (serverId) {
    for (const key of serverPolicyKeyCandidates(serverId)) {
      const serverPolicy = policies?.[key];
      if (serverPolicy) return serverPolicy;
    }
  }
  if (metadata?.serverPolicyDefault) return metadata.serverPolicyDefault;
  const groupId = metadata?.groupId;
  const groupPolicy = groupId ? policies?.[toolGroupPolicyKey(groupId)] : undefined;
  if (groupPolicy) return groupPolicy;
  if (groupId === "browser") return "ask";
  if (metadata?.isReadOnly) return "allow";
  return "allow";
}
