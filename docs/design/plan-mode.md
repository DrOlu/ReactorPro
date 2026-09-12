# Plan Mode Design and Implementation Baseline

| Metadata | Content |
|---|---|
| Status | Implemented / initial implementation baseline |
| Version | v1.0 |
| Date | 2026-08-21 |
| Parent plan | [2026 H2 Capability Roadmap](./2026h2-capability-roadmap.md) P1-① |

## 1. Requirements and Semantics

A mode gate for "read-only exploration → submit plan → user approval → automatically enter execution", aligned with Claude Code's plan mode:

1. A turn initiated after the user turns on the "Plan" toggle in the composer (visible only in agent execution mode) is in plan mode;
2. In a plan mode turn, the model **only gets read-only tools** + `ExitPlanMode` + subagent collaboration tools (Agent/SendMessage, with Agent forced readonly);
3. After finishing research, the model calls `ExitPlanMode(plan)` to submit a complete plan (markdown), which is rendered as an interactive card and suspended pending a decision;
4. User "Approve and start executing" → turns off the plan toggle + automatically enqueues a "start executing" continuation turn (with a `planModeEnabled:false` snapshot); the remainder of the current turn is still in plan mode, and the model receives an instruction to wrap up briefly;
5. User "Request changes" (optionally with feedback) → the feedback is passed back as a tool result, and the model stays in plan mode to keep refining;
6. Plans have **no response timeout**: a pending plan survives across runs until the user approves, rejects, or the submission is superseded by a new plan (in the conversational paradigm, "not approving" just means continuing the conversation, so no timeout arbitration is needed); stopping/deleting the session cleans it up with the session.

## 2. Core Design Decisions

| Decision | Approach | Rationale |
|---|---|---|
| Write tool handling | **Cut directly at the registry assembly layer** (`filterForPlanMode`), not deny-based fallback interception | The model simply cannot see write tools: saves tokens, no leakage surface; follows the existing approach of deny-without-sending |
| Execution-layer fallback | `resolveToolGate` adds a plan-mode branch to cover bypasses such as seed restoration | Semantics match the tool table, double insurance |
| Behavior in the current turn after approval | **No mid-turn tool hot-swapping**; the current turn wraps up, and the continuation turn executes with full tools | The tool table is frozen at turn start; mid-turn expansion depends on pi-agent-core behavior (P1-② spike scope), and the initial version does not take the risk |
| Mode toggle carrier | `ChatRuntimeControls.planModeEnabled` | Reuses the existing pipeline: settings → composer → queue snapshot → gateway override |
| Normalization direction | Only explicit `true` takes effect (a restrictive toggle, opposite to networking/thinking) | Legacy configs/remote missing fields must not accidentally lock historical sessions into read-only |
| Cross-platform merge direction | **Can only tighten** (plan mode takes effect if any source requires it) | Same as `strictestCommandSafetyMode` (P3#9): a stale remote snapshot's false must not turn off local plan mode |
| system prompt segment | Turn-level frozen injection (`withAgentRuntimeContext`, same column as frozenTaskListContext) | Constant within a run, protecting the prefix cache; the trajectory array records it in sync for consistent framing |
| Subagents | `parseSubagentBatch(forceReadonly)`: an explicit worktree is **rejected** with a parameter error (not silently downgraded), and missing/reused identity converges to readonly | Repo-wide fail-closed approach; the model retries after receiving clear guidance |
| ExitPlanMode metadata | `isReadOnly: true` | The tool itself has no side effects (it only suspends and waits); the plan card is the approval gate, so no additional tool approval should be stacked |
| Remote response channel | `chat_queue.plan_decision` action string + `request_json` | Same pattern as tool_answer/tool_approval, **zero proto changes, zero breaking risk** (both the Go relay and the Rust relay forward the action as an opaque string) |
| Approval callback exception | Swallowed and console.warn'd, without polluting the tool result | The approval fact is already settled; a failed continuation-turn enqueue should not let the model see an error |

## 3. Components and Files

**Shared contract layer (agent-ui, platform-agnostic)**
- `lib/chat/planMode.ts` — tool names, length constants, `PlanDecision`/`ExitPlanModeResultDetails` types, pending/approved parameter markers, fault-tolerant parsing (mirrors `askUserQuestion.ts`)
- `components/chat/PlanModeCard.tsx` — plan card: markdown rendering (inner scroll), countdown (clock comparability check same as AskUserQuestionCard), approve/request changes (with feedback), settled-state display
- `components/chat/assistant-bubble/ToolCallItem.tsx` — dispatch by tool name (same as AskUserQuestion), details first with streaming-parameter fallback
- `lib/tools/builtinToolCatalog.ts` — `exit_plan_mode` catalog entry (conditional, CHAT_ONLY)
- `lib/settings/types.ts` / `index.ts` — `planModeEnabled` field + normalization
- `components/chat/ComposerModelControls.tsx` — "Plan" RuntimeToggleChip (sky color scheme, rendered only in agent mode)

**Desktop (agent-gui)**
- `lib/tools/planModeTools.ts` — `ExitPlanMode` tool + pending plan registry + `answerPlanDecision` (the same entry point for local/remote) + `isPlanModeAllowedTool` + plan mode system prompt segment
- `lib/tools/builtinRegistry.ts` — `planMode` parameter: injects the ExitPlanMode bundle + `filterForPlanMode` filters both return paths + subagent `forceReadonly` pass-through
- `lib/subagents/validate.ts` / `agentTool.ts` — `forceReadonly` option and tool description hint
- `pages/chat/turns/runAgentConversationTurn.ts` — `planModeEnabled`/`onPlanApproved` parameters, frozen prompt segment injection + trajectory framing, `resolveToolGate` fallback interception
- `pages/chat/turns/gatewayToolPreview.ts` — ExitPlanMode pending/approved marker stamping
- `pages/chat/runtime/useSendChatTurn.ts` — `effectivePlanModeEnabled` three-source "can only tighten" merge, callback pass-through
- `pages/chat/queue/useChatTurnQueue.ts` — `plan_decision` action branch, `enqueueComposerTurnForConversation` supports `runtimeControls` override
- `pages/ChatPage.tsx` — `handlePlanApprovedForConversation` (turns off the toggle + enqueues the execution continuation turn), session-destroy cancel fallback
- `agent-ui-adapters/assistantBubble.ts` — `readPlanDecisionDeadline`/`submitPlanDecision` (direct connection to the pending table)
- `src-tauri/services/gateway_bridge.rs` — adds `ExitPlanMode` to the share redaction list (enforced by a coverage test)

**WebUI (agent-gateway/web)**
- `lib/chat/planModeBridge.ts` — module-level singleton bridge (mirrors toolApprovalBridge)
- `app/GatewayApp.tsx` — handler registration → `chatQueuePlanDecision`
- `lib/gatewaySocketRpc.ts` — `chat_queue.plan_decision` RPC
- `agent-ui-adapters/assistantBubble.ts` — pending/approved state reading (GUI subscribes to the registry, WebUI parameter markers + local settle overlay), submission goes through the bridge

## 4. Known Boundaries (Initial Version)

1. **Tools are not unlocked in the current turn after approval**: execution always starts from the continuation turn. Mid-turn tool table expansion awaits the spike conclusion of P1-② (ToolSearch).
2. **WebUI cannot remotely turn the plan toggle on/off**: the proto `ChatRuntimeControls` has no `plan_mode_enabled` field added (requires the buf toolchain; can be added via `make proto && make proto-check` after `mise install`). Remote **plan approval** (approve/reject) is already fully available—this is the key part of parity. Merge semantics are already implemented as "can only tighten", so no logic changes are needed once the field is added.
3. **planState is not persisted to `context_meta_json`**: plan content relies on the ExitPlanMode tool result remaining in the conversation history (after compaction it is carried by the summary). If "authoritative plan injection across compaction" is needed (the same File Ledger treatment as taskList), add a `planState` field following the exact same path as `StoredChatContextMeta.taskList` (zero Rust changes).
4. The Cron auto-prompt scenario does not register ExitPlanMode (unattended, so there is no approval to speak of); the planMode parameter only takes effect in chat scope.

## 5. Tests

- `test/tools/plan-mode-tools.test.mjs` — schema, sanitize/resolve/parse, empty plan rejection, approval (including invalid/cross-session response rejection, callback triggering, duplicate response rejection), rejection (feedback pass-through), new submission superseding the old registry, per-session cancel isolation (including approved settled-state cleanup), `isPlanModeAllowedTool` allowlist
- `test/subagents/validate.test.mjs` — forceReadonly: explicit worktree errors, missing/reused identity converges to readonly, explicit readonly passes
- `test/tools/builtin-registry-subagent-mcp.test.mjs` — plan mode registry filtering: read-only + plan + collaboration tools present in the table, all write capabilities (builtin + MCP) absent from the table, Agent description carries the PLAN MODE hint
- Existing adaptations: `tool-argument-display.test.mjs` (new module mock), `settings/normalization.test.mjs` (expected object gains `planModeEnabled: false`)
- Rust `shared_chat_history_builtin_policy_covers_the_tool_catalog` coverage test passes (redaction list synced)

Full baseline: agent-gui 2457/2457 (including 940 cargo backend cases), zero tsc errors on all three platforms, biome on par with the main baseline.