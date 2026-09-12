// MCP tool lazy loading (ToolSearch): when the total MCP tool schema size
// exceeds the threshold, tools are still registered in full at the execution
// layer (pi-agent-core's prepareToolCall looks them up from the loop snapshot,
// so they must always be found), but **the request sent to the model** contains
// only activated MCP tools -- unactivated ones are filtered out by the runner's
// requestToolFilter (the same mechanism as provider-native search: "visible at
// the execution layer, hidden at the request layer"). The model retrieves and
// activates tools via ToolSearch; directly calling an unactivated tool also
// succeeds and auto-activates it (turn-layer executor wrapper), avoiding the
// confusion of "the call succeeded but it's invisible next turn". The activation
// set is kept in memory per conversation (persists across turns; after a restart
// the model just searches once more).

import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { estimateToolsTokens } from "../chat/compaction/tokenLedger";
import {
  type BuiltinToolBundle,
  type BuiltinToolMetadata,
  createBuiltinMetadataMap,
} from "./builtinTypes";

export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

/**
 * Lazy-loading threshold (estimated tokens): when the total MCP tool schema
 * size is below it, inject everything into the request and do not enable
 * ToolSearch -- the cost of an extra retrieval turn is only worth it when it
 * genuinely saves meaningful context.
 */
export const MCP_TOOL_DEFERRAL_THRESHOLD_TOKENS = 12_000;

/** Upper bound on tools returned by a single search; clamped to [1, MAX]. */
export const TOOL_SEARCH_MAX_RESULTS = 10;
const TOOL_SEARCH_DEFAULT_RESULTS = 5;

// Conversation-level activation set: kept across turns (within the same desktop
// session process) and cleared when the conversation is destroyed. Not persisted
// to disk -- after a restart the model re-runs ToolSearch as needed, at the cost
// of one tool turn.
const activationByConversation = new Map<string, Set<string>>();

export function getMcpToolActivation(conversationId: string): Set<string> {
  const key = conversationId.trim();
  let set = activationByConversation.get(key);
  if (!set) {
    set = new Set();
    activationByConversation.set(key, set);
  }
  return set;
}

export function clearMcpToolActivation(conversationId: string) {
  activationByConversation.delete(conversationId.trim());
}

export type DeferredMcpToolEntry = {
  tool: Tool;
  serverLabel: string;
};

function normalizeQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;/|]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

/**
 * Dependency-free lightweight scoring: a weighted sum of substring hits for
 * query terms against name (x3) / serverLabel (x2) / description (x1). The
 * catalog is only tens to hundreds of tools, so a linear scan suffices; no FTS
 * is introduced.
 */
function scoreEntry(entry: DeferredMcpToolEntry, terms: string[]): number {
  const name = entry.tool.name.toLowerCase();
  const description = (entry.tool.description ?? "").toLowerCase();
  const server = entry.serverLabel.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3;
    if (server.includes(term)) score += 2;
    if (description.includes(term)) score += 1;
  }
  return score;
}

export type ToolSearchResultDetails = {
  kind: "tool_search";
  query: string;
  /** Tool names newly activated by this call (canonical invocation names). */
  activated: string[];
  totalDeferred: number;
};

function buildErrorResult(toolCall: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * Decide whether to enable lazy loading: estimate the token size of all MCP
 * tool schemas and compare against the threshold. The input is "the JSON that
 * would go into the request" (the same estimation basis as tokenLedger).
 */
export function shouldDeferMcpTools(
  mcpTools: readonly Tool[],
  thresholdTokens = MCP_TOOL_DEFERRAL_THRESHOLD_TOKENS,
): boolean {
  if (mcpTools.length === 0) return false;
  return estimateToolsTokens(mcpTools as Tool[]) > thresholdTokens;
}

export function createToolSearchTools(params: {
  conversationId: string;
  /** Catalog of MCP tools whose injection is deferred (name is the canonical invocation name mcp_<server>_<tool>). */
  entries: readonly DeferredMcpToolEntry[];
}): BuiltinToolBundle {
  const activation = getMcpToolActivation(params.conversationId);
  const serverLabels = [...new Set(params.entries.map((entry) => entry.serverLabel))];
  const toolSearch: Tool = {
    name: TOOL_SEARCH_TOOL_NAME,
    description: [
      `Search the deferred MCP tool catalog and activate matching tools. ${params.entries.length} MCP tools (from: ${serverLabels.join(", ")}) are NOT in your tool list yet to save context.`,
      'Call this with a task-oriented query (e.g. "create issue", "query database", "send message") BEFORE assuming a capability is missing. Matched tools are returned with their full schemas and become directly callable from the next step on.',
      "Results are ranked by name/server/description match. Broaden the query if nothing relevant comes back; activation persists for this conversation.",
    ].join("\n"),
    parameters: Type.Object({
      query: Type.String({
        description: "Task-oriented keywords to match against tool names and descriptions.",
      }),
      max_results: Type.Optional(
        Type.Number({
          description: `How many tools to return and activate (default ${TOOL_SEARCH_DEFAULT_RESULTS}, max ${TOOL_SEARCH_MAX_RESULTS}).`,
        }),
      ),
    }),
  };

  async function executeToolCall(toolCall: ToolCall): Promise<ToolResultMessage> {
    if (toolCall.name !== TOOL_SEARCH_TOOL_NAME) {
      return buildErrorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
    const args = (toolCall.arguments || {}) as Record<string, unknown>;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return buildErrorResult(toolCall, "query is required: pass task-oriented keywords.");
    }
    const requested =
      typeof args.max_results === "number" && Number.isFinite(args.max_results)
        ? Math.floor(args.max_results)
        : TOOL_SEARCH_DEFAULT_RESULTS;
    const limit = Math.min(Math.max(requested, 1), TOOL_SEARCH_MAX_RESULTS);

    const terms = normalizeQueryTerms(query);
    const ranked = params.entries
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (ranked.length === 0) {
      const details: ToolSearchResultDetails = {
        kind: "tool_search",
        query,
        activated: [],
        totalDeferred: params.entries.length,
      };
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: `No deferred MCP tools matched "${query}". ${params.entries.length} tools available from: ${serverLabels.join(", ")}. Try broader or different keywords.`,
          },
        ],
        details,
        isError: false,
        timestamp: Date.now(),
      };
    }

    const activated: string[] = [];
    for (const { entry } of ranked) {
      if (!activation.has(entry.tool.name)) {
        activation.add(entry.tool.name);
        activated.push(entry.tool.name);
      }
    }
    const lines = ranked.map(({ entry }) =>
      [
        `## ${entry.tool.name}`,
        entry.tool.description ?? "",
        "```json",
        JSON.stringify(entry.tool.parameters ?? {}),
        "```",
      ].join("\n"),
    );
    const details: ToolSearchResultDetails = {
      kind: "tool_search",
      query,
      activated,
      totalDeferred: params.entries.length,
    };
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [
        {
          type: "text",
          text: [
            `Activated ${ranked.length} tool(s) — callable directly from now on:`,
            "",
            ...lines,
          ].join("\n"),
        },
      ],
      details,
      isError: false,
      timestamp: Date.now(),
    };
  }

  return {
    groupId: "system",
    tools: [toolSearch],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        TOOL_SEARCH_TOOL_NAME,
        {
          groupId: "system",
          kind: "tool_search",
          // Read-only: only queries the catalog and updates the in-conversation activation set; touches no external state.
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}

/**
 * Request-layer visibility predicate: non-MCP business tools are always visible;
 * MCP business tools must be activated. The check must use kind === "mcp"
 * (business-tool specific), not a bare groupId -- McpManager is also under
 * groupId "mcp" but does not enter the deferred catalog, and hiding by groupId
 * would make it vanish from model requests forever. ToolSearch itself is always
 * visible. The runner re-evaluates every request, so activation takes effect
 * from the next turn on.
 */
export function buildMcpRequestToolFilter(params: {
  conversationId: string;
  metadataByName: Map<string, BuiltinToolMetadata>;
}): (toolName: string) => boolean {
  const activation = getMcpToolActivation(params.conversationId);
  return (toolName: string) => {
    const metadata = params.metadataByName.get(toolName);
    if (metadata?.groupId !== "mcp" || metadata.kind !== "mcp") return true;
    return activation.has(toolName);
  };
}
