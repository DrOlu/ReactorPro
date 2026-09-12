# MCP tool lazy loading (ToolSearch) design and implementation baseline

| Metadata | Content |
|---|---|
| Status | Implemented / first-version implementation baseline |
| Version | v1.0 |
| Date | 2026-08-21 |
| Plan | [2026 H2 capability roadmap](./2026h2-capability-roadmap.md) P1-② |

## 1. Problem and goals

As MCP servers multiply, tool argument schemas consume a large amount of context (paid on every request round). Goal: when total schema size exceeds a threshold, inject only the "useful" MCP tools into the model request and defer the rest until a retrieval hit activates them—aligned with Claude Code's ToolSearch mechanism.

## 2. Spike conclusions (the key technical risk flagged by the roadmap)

Source review of `pi-agent-core` 0.84.2 and real integration tests established:

1. `Agent.continue()` snapshots `state.tools` at loop start (the `.slice()` in `createContextSnapshot`) and **does not re-read it within the loop**—changing `agent.state.tools` mid-turn has no effect;
2. But the execution side's `prepareToolCall` lookup/schema validation also uses this same snapshot—**as long as tools are always registered in full, execution is always reachable**;
3. The runner's own `streamFn` assembles the outbound tool table via `filterRequestTools` on **every request round**—the provider-native search bridge already uses this "visible to the execution layer, hidden from the request layer" mechanism in production.

**Conclusion: pi-agent-core does not need to be touched.** All MCP tools are registered to the execution layer as usual, and outbound requests are dynamically filtered by the "activation set"; after ToolSearch activation, tools are immediately visible **on the next round of the same run**. The integration test
`agent-runner.test.mjs: "requestToolFilter re-evaluates per round"` formally verified this behavior with real pi-agent-core (round 1 excludes deferred tools → activated within the round → round 2 includes and can execute them).

## 3. Core design

| Decision | Choice | Rationale |
|---|---|---|
| Layering | **Full registration at the execution layer, filtering at the request layer** | Execution is always reachable (loop snapshot constraint); schemas the model cannot see cost no tokens |
| Threshold | Enabled only when estimated tokens > 12k (`MCP_TOOL_DEFERRAL_THRESHOLD_TOKENS`) | Below the threshold an extra retrieval round is not worthwhile; estimation uses the same measure as `tokenLedger` (schema JSON) |
| Activation set | Session-level in-memory Map (conversationId → Set), kept across turns, cleaned up on session destruction | Naturally survives compaction (independent of message history); after a restart the model just retrieves once more. `context_meta_json` persistence is left for later |
| Retrieval | Lightweight linear scoring: term weighted by substring hits on name (×3)/serverLabel (×2)/description (×1) | At most a few hundred entries in the catalog, so no FTS is introduced; returns 5 by default, capped at 10 |
| Direct call to an unactivated tool | **Allow and auto-activate** (executor wrapper) | The execution layer can find it anyway; activation ensures subsequent request rounds include the schema and avoids model confusion |
| Guidance | The ToolSearch tool description embeds "which servers the N deferred tools come from" | Tool descriptions are visible on every request round, so no system prompt change is needed (protects the prefix cache) |
| Plan mode interaction | ToolSearch is not registered in plan mode | MCP tools are not read-only and are already absent from plan mode's table, so activation is meaningless |
| Cache cost | Activation changes the request tool table → the prefix cache is invalidated once | Inherent cost of lazy loading (same as Claude Code); activation is a low-frequency event, and the constant overhead saved far outweighs it |

## 4. Components and files

- `crates/agent-gui/src/lib/tools/toolSearchTools.ts` (new) — the `ToolSearch` tool (retrieval + activation), the `shouldDeferMcpTools` threshold check, the session-level activation set `getMcpToolActivation`/`clearMcpToolActivation`, and the request-layer predicate `buildMcpRequestToolFilter`
- `crates/agent-gui/src/lib/chat/runner/agentRunner.ts` — adds a `requestToolFilter` parameter, layered into `filterRequestTools` (re-evaluated every request round)
- `crates/agent-gui/src/lib/tools/builtinRegistry.ts` — `toolSearch` parameter: injects the ToolSearch bundle above the threshold; the return value carries the `mcpToolDeferralActive` flag
- `crates/agent-gui/src/pages/chat/turns/runAgentConversationTurn.ts` — passes `toolSearch`, builds the requestToolFilter, and auto-activates on direct executor calls
- `crates/agent-gui/src/pages/ChatPage.tsx` — clears the activation set on session destruction
- The catalog/i18n/share-redaction lists (TS + Rust) are updated in sync with the `ToolSearch` entry

## 5. Known boundaries (first version)

1. **The activation set is not persisted**: after a restart, a new session re-runs ToolSearch via the model (one tool round); the direct-call activation fallback ensures that tool names that appeared in history can still be called directly. Later, `context_meta_json` persistence will be added along the `taskList` path.
2. **The threshold is currently a constant** (12k tokens): `shouldDeferMcpTools` already supports an injected threshold, and the settings item is pending (roadmap item c, to be decided).
3. **Effective only in the main session**: the subagent registry and Cron auto-prompt do not enable deferral (each has a fresh context and a manageable number of tools); this can be extended later as needed.
4. **Compaction budget is estimated on the full set**: `combinedTools` (including deferred tools) enters the compaction budget → slight overestimation and earlier compaction, a conservative and safe direction.

## 6. Tests

- `test/tools/tool-search-tools.test.mjs` — 5 cases: threshold check (including injected threshold), schema, retrieval ranking + activation + empty-hit guidance + argument errors, session isolation + cleanup, and live-reference semantics of the request predicate
- `test/chat/agent-runner.test.mjs` — **mid-turn activation integration test** (real pi-agent-core): round 1 request excludes deferred tools → activated within the round → round 2 request includes them → both calls actually execute
- `test/tools/builtin-registry-subagent-mcp.test.mjs` — ToolSearch is not registered below the threshold, and the measurement is consistent

Full baseline: agent-gui 2464/2464, zero errors across all three TypeScript targets, biome on par with the main baseline.