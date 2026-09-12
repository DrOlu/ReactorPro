# 2026 H2 Capability Roadmap: Plan to Close Five Frontier Capability Gaps

| Metadata | Content |
|---|---|
| Status | Approved / scheduled and in execution |
| Version | v1.0 |
| Date | 2026-08-21 |
| Scope | Plan Mode · MCP tool lazy loading · MCP OAuth · Browser automation · Semantic retrieval / codebase indexing |
| Estimation basis | Person-weeks (for a developer familiar with this repository); total about 15–17 person-weeks, or about 10–12 weeks with two people in parallel |

> Background: Compared with the 2026 industry frontier (Claude Code / Codex CLI / Antigravity / OpenClaw / Claude Cowork), ReactorPro has reached the open-source frontier or even leads locally in the secure execution foundation (OS sandbox, approvals, checkpoints), context engineering, and remote architecture, but has clear gaps in the intelligence layer (plan mode, semantic retrieval), the reach layer (browser automation), and MCP ecosystem completeness (OAuth, tool lazy loading). This document is the overall development plan and acceptance baseline for these five capabilities.

## 0. Schedule Overview

| Phase | Content | Estimate | Dependencies |
|---|---|---|---|
| **P1** (wk 1–3) | ① Plan Mode (TS track) ② MCP tool lazy loading (TS track) ③ MCP OAuth (Rust track, in parallel) | 1.5 + 1.5 + 3 person-weeks | None |
| **P2** (wk 4–7) | ④ Browser automation (Phase A: managed Playwright-MCP presets → Phase B: native CDP tools) | 1 + 3.5 person-weeks | Lazy loading (reduces context pressure), OAuth wrap-up |
| **P3** (wk 6–11) | ⑤ Semantic retrieval / codebase indexing (Rust track, started in parallel with P2) | 5–6 person-weeks | No hard dependency |
| **P4** (wk 12) | Wrap-up: evals smoke set, docs, release gate additions, i18n completion | 1 person-week | All |

Every feature uniformly follows the repository's existing discipline:

1. Produce a `docs/design/` design document first, then touch code;
2. Changes involving remote capabilities must update `proto/v2/gateway.proto` in sync to preserve GUI/WebUI parity (the `scripts/check-ui-boundaries.mjs` gate);
3. i18n on both ends (`agent-ui` common layer + gateway web);
4. Shipped items are written into the corresponding release gate checklist.

---

## 1. Plan Mode (1.5 person-weeks)

**Goal**: A mode gate of "read-only exploration → submit plan → user approval → switch to execution", aligned with Claude Code. It has the highest value/cost ratio, and all the raw materials (AskUserQuestion, Task tools, readonly subagent, approval model) are already available.

### Design Highlights

- Add a `planMode` state to the conversation runtime; layer a **mode-aware policy** before `resolveToolGate` in `runAgentConversationTurn.ts`: read-only tools are allowed, and non-read-only tools are **simply not injected to the model** (reusing the existing deny-by-not-sending mechanism to save tokens).
- New tool `ExitPlanMode(plan_markdown)`: triggers an approval card, reusing the pending/settle model of `toolApproval.ts` — approve switches back to tools/agent-dev mode and injects the plan into context (attached to `context_meta_json`, surviving compaction, same as the Task tools); deny stays in plan mode and sends back user feedback.
- Under Plan mode, subagents are forced into `readonly` mode (the mechanism already exists); after approval, the plan can optionally be converted into a `TaskCreate` checklist with one click.
- WebUI parity: approval goes through the existing `chat_queue.tool_approval` channel (nearly zero proto changes); mode switching adds one field to the chat command.

### Change Points

`lib/tools/toolPolicy.ts` · new `lib/tools/planModeTools.ts` · `pages/chat/turns/runAgentConversationTurn.ts` · `agent-ui` plan approval card component · system prompt section · `gateway.proto` minor adjustments

### Acceptance

- [ ] No write operation appears in the model tool table under plan mode
- [ ] Rejecting a plan can continue planning with feedback
- [ ] The plan is not lost after compaction
- [ ] WebUI can approve remotely

---

## 2. MCP Tool Lazy Loading / ToolSearch (1.5 person-weeks)

**Goal**: Running many MCP servers no longer blows up context, aligned with Claude Code's ToolSearch mechanism.

### Design Highlights

- New `lib/mcp/toolCatalog.ts`: on conversation start it still calls `tools/list` (to get name+description), but **once a threshold is exceeded (default about 12k tokens of schema, estimated via `tokenLedger`, configurable) the schema is not injected**, and the system prompt keeps only a one-line summary "N MCP tools can be retrieved via ToolSearch".
- New built-in tool `ToolSearch(query)`: performs BM25/substring retrieval over the catalog (small scale, in-memory suffices, no FTS), returns the top-K full schemas and adds them to the conversation-level **activation set**; the activation set is persisted to `context_meta_json` (across compaction, across recovery).
- Name mapping follows the existing FNV-1a truncation rule in `mcpTools.ts`; ToolSearch returns canonical names that can be called directly.
- Keep the `McpManager tools` action as a manual fallback.

### Key Technical Risks

The tool table in each request from `agentRunner.ts` needs to support **mid-round expansion** (after ToolSearch returns, the next request includes the new tools). The tool table is assembled per request, so this is theoretically feasible, but the tolerance of `pi-agent-core` to tool-set changes between rounds must be verified — **do the spike verification on day 1**; if it does not work, downgrade to "effective at turn boundaries".

### Acceptance

- [ ] With 5 servers attached (>80 tools), the first-round prompt size drops by ≥70%
- [ ] Tools hit by retrieval can be called in the current/subsequent round
- [ ] The activation set is not lost after compaction

---

## 3. MCP OAuth (3 person-weeks)

**Goal**: Support OAuth 2.1 per the MCP specification and connect to managed MCP servers (currently only static headers).

### Design Highlights

- Add `src-tauri/src/services/mcp_oauth.rs` on the Rust side and wire it into `HttpTransport`/`SseTransport` in `mcp.rs`: 401 + `WWW-Authenticate` → RFC 9728 resource metadata → RFC 8414 AS metadata → RFC 7591 dynamic registration when there is no client_id → **Authorization Code + PKCE** (system browser + `127.0.0.1` random-port loopback callback) → get the token and retry the original request; token refresh hangs alongside the existing 404 retry chain in `ensure_initialized`.
- Dependencies: `oauth2` v5 + `keyring` v3 (macOS Keychain / Windows Credential Manager / Linux secret-service; environments without secret-service fall back to an encrypted file).
- **Credential discipline follows the existing trade-offs**: tokens go only into the keychain, and `McpServerConfig` in `mcpOps.ts` stores only `auth: { type: "none"|"headers"|"oauth" }` + metadata/presence — Gateway settings sync and WebDAV backups naturally contain no tokens.
- Remote restrictions made explicit: the authorization flow can only be completed on the **desktop machine** (the system browser pops up on the desktop); the WebUI side shows an "authorization required" status via gateway events and guides the user. The device-code flow is left for later.
- UI: add Connect/authorization status/Reauthorize to the MCP server card; the `McpManager test` action outputs auth diagnostics.

### Acceptance

- [ ] Connect to at least 2 real managed MCP servers
- [ ] Token expiry refreshes automatically and seamlessly
- [ ] Uninstalling a server cleans up the keychain entry
- [ ] No re-authorization needed after restart

---

## 4. Browser Automation (4.5 person-weeks, two phases)

**Goal**: Fill the blank in the 2026 agent main battlefield, moving from "usable" to "native".

### Phase A — Managed Playwright-MCP Presets (1 week, shipped first at the start of P2)

- Add "officially recommended connector" presets to the MCP registry card system: one-click enable `playwright-mcp` / `chrome-devtools-mcp` (stdio goes through the existing MCP infrastructure); ReactorPro manages their process lifecycle, detects the Node runtime, and provides guidance.
- Zero new protocol cost, immediately usable, while also collecting interaction-pattern feedback for Phase B.

### Phase B — Native `Browser` Tool (3.5 weeks)

- New Rust `services/browser/`: launch the user's installed Chrome/Edge with `--remote-debugging-port` + a **separate profile** (`~/.liveagent/browser-profile`, isolated from the user's daily profile to prevent credential exposure); Rust connects directly to the CDP WebSocket.
- The tool shape follows the repository's manager style: **a single `Browser` tool + action parameter** (navigate / snapshot / click / type / screenshot / eval / wait / back), reducing the number of schemas (synergizing with lazy loading).
- `snapshot` outputs an **a11y tree + ref id** (Playwright aria-snapshot style), prioritizing token efficiency; `screenshot` goes through the existing Image rendering chain into the chat.
- Security integrates with the existing system: new `group:browser` defaults to `ask`; under `sandboxOffline` mode Browser is always denied (offline semantics must cover browser network access); optional URL allowlist.
- UI: add a Browser panel to the Right Dock (screenshot preview + current URL + stop button); WebUI parity goes through proto pass-through.

### Acceptance

- [ ] Complete the loop of "open the docs site → search → extract content → screenshot as evidence"
- [ ] a11y snapshot under 8k tokens for a single page
- [ ] The separate profile cannot read the user's daily browser login state
- [ ] Approval/sandbox policies take effect

---

## 5. Semantic Retrieval / Codebase Indexing (5–6 person-weeks)

**Goal**: Free large repositories from blind Grep searching with hybrid retrieval (lexical + semantic + symbolic).

### Design Highlights

New Rust `services/code_index/` (walker / chunker / embedder / store / search), reusing the mature SQLite service-layer pattern:

- **Walker**: the `ignore` crate respects `.gitignore` + custom exclusions; incremental = mtime + content hash; integrates with the **existing workspace watch** for real-time invalidation.
- **Chunker**: tree-sitter chunks by function/class (first batch of languages: TS/JS/TSX, Rust, Go, Python, Java); languages without a grammar fall back to a sliding window.
- **Embedder**: local first — `fastembed-rs` (ONNX) running a small model with CPU inference, available offline by default; provider embedding APIs as an **optional** enhancement. Model selection is to be decided (given the high proportion of Chinese users, a multilingual model at the `multilingual-e5-small` level ~120MB is suggested; the English-only `bge-small` is a smaller, faster alternative).
- **Store**: `sqlite-vec` + FTS5 dual index, per-workspace `code-index.sqlite3` (same infrastructure as memory-index).
- **Hybrid retrieval**: FTS5 BM25 + vector cosine, fused and ranked with RRF.
- New tool `CodeSearch(query, mode: hybrid|semantic|lexical, path?)` → `file:line` + snippets; subagents inherit it read-only; the system prompt injects a "this workspace is indexed" hint.
- Lifecycle: **per-workspace opt-in** (privacy + disk considerations), background indexing job (reusing the job/progress/cooperative cancellation pattern of skill installation), size caps and quotas, can be scheduled via cron for periodic rebuilds.
- UI: index toggle + progress + size statistics on the workspace settings page; add retrieval details to Trajectory.

### Acceptance

- [ ] Full indexing of this repository (about 200k lines) in <5 minutes, incremental in <2s
- [ ] On a self-built 30-query smoke set, hybrid top-5 hit rate is significantly better than the pure-Grep baseline
- [ ] Index corruption can be rebuilt with one click
- [ ] `CodeSearch` is not injected when indexing is turned off

---

## 6. Cross-Cutting Concerns and Risks

| Item | Description |
|---|---|
| **pi-agent-core coupling** | Both ② and ④ touch the inter-round tool table, the concentrated risk point of the external main loop. Do a spike in the first week of P1; if the blocker is severe, use it as the trigger for the "internalize the main loop" decision (this plan does not include internalization) |
| **GUI/WebUI parity** | Each feature includes proto + `agent-ui` common-layer changes, with `check-ui-boundaries.mjs` as the minimum safeguard gate |
| **Evals started along the way** | ⑤'s 30-query retrieval smoke set + ①④'s scenario scripts serve as the first brick of the evals framework (closed out in P4) |

### Decisions Pending

1. Local embedding model selection (multilingual e5-small vs English-only bge-small);
2. Whether browser Phase B is bound to Chrome/Edge (Firefox unsupported);
3. The default lazy-loading threshold (12k tokens suggested, configurable).