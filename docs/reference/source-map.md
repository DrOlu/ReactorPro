# Source index

## Root directory

| Path | Description |
|---|---|
| `README.md` | Project root readme. |
| `Makefile` | Common commands for desktop, Gateway, WebUI, proto, and release. |
| `Cargo.toml` | Rust workspace. |
| `docs/` | Current architecture, features, design, operations docs, and historical worklogs. |

## Shared application UI

| Feature | Path |
|---|---|
| Package manifest | `crates/agent-ui/package.json` |
| Application view | `crates/agent-ui/src/application/ApplicationView.tsx` |
| Settings page | `crates/agent-ui/src/pages/settings/SettingsPage.tsx` |
| Skills Hub | `crates/agent-ui/src/pages/skills-hub/SkillsHubPage.tsx` |
| MCP Hub | `crates/agent-ui/src/pages/mcp-hub/McpHubPage.tsx` |
| Composer/top bar | `crates/agent-ui/src/pages/chat/ChatComposerBar.tsx`, `crates/agent-ui/src/components/chat/ChatHeader.tsx` |
| History sidebar | `crates/agent-ui/src/components/chat/ChatHistorySidebar.tsx` |
| Hub common shell | `crates/agent-ui/src/components/hub/HubChrome.tsx` |
| Project tools | `crates/agent-ui/src/components/project-tools/*` |
| Host contracts | `crates/agent-ui/src/contracts/*` |

## GUI Frontend

| Feature | Path |
|---|---|
| App shell | `crates/agent-gui/src/App.tsx` |
| React entry | `crates/agent-gui/src/main.tsx` |
| Chat page | `crates/agent-gui/src/pages/ChatPage.tsx` |
| Chat turn | `crates/agent-gui/src/pages/chat/turns/runTextConversationTurn.ts`, `runAgentConversationTurn.ts` |
| Chat transcript controller | `crates/agent-gui/src/pages/chat/transcript/ChatTranscript.tsx`, `components/AssistantBubble.tsx` |
| Gateway bridge hooks | `crates/agent-gui/src/pages/chat/gateway/useGatewayBridgeListeners.ts`, `useGatewayBridgeReadiness.ts` |
| Context builders | `crates/agent-gui/src/pages/chat/runtime/conversationContextBuilders.ts` |
| GUI Settings extensions | `crates/agent-gui/src/pages/settings/*` |
| Backup and sync settings section | `crates/agent-gui/src/pages/settings/BackupSyncSection.tsx`, `backupSyncForm.ts` |
| Shared UI adapters | `crates/agent-gui/src/agent-ui-adapters/*` |
| i18n | `crates/agent-gui/src/i18n/*` |

## GUI Libraries

| Feature | Path |
|---|---|
| Model provider layer | `crates/agent-gui/src/lib/providers/llm.ts` |
| Provider proxy helpers | `crates/agent-ui/src/lib/providers/proxy.ts` |
| Settings defaults/storage/sync | `crates/agent-gui/src/lib/settings/*` |
| Config backup/sync IPC | `crates/agent-gui/src/lib/backup/index.ts` |
| Builtin tool registry | `crates/agent-gui/src/lib/tools/builtinRegistry.ts` |
| FS tools | `crates/agent-gui/src/lib/tools/fsTools.ts` |
| Project additional-directory policy | `crates/agent-gui/src/lib/tools/fsTools.ts`, `src/lib/tools/pathUtils.ts` |
| Project additional-directory grants | `crates/agent-gui/src/lib/workspaceRootGrants.ts`, `src-tauri/src/commands/workspace/root_grants.rs` |
| Shell tools | `crates/agent-gui/src/lib/tools/shellTools.ts` |
| MCP tools | `crates/agent-gui/src/lib/tools/mcpTools.ts`, `mcpManagerTools.ts` |
| Skills tools | `crates/agent-gui/src/lib/tools/skillTools.ts` |
| Memory tools | `crates/agent-gui/src/lib/tools/memoryTools.ts` |
| Cron tools | `crates/agent-gui/src/lib/tools/cronTools.ts` |
| Subagent tools (Agent/SendMessage) | `crates/agent-gui/src/lib/subagents/*` |
| Conversation state | `crates/agent-gui/src/lib/chat/conversation/*` |
| Memory prompt/policy | `crates/agent-gui/src/lib/chat/memory/*` |
| Skills shared logic | `crates/agent-ui/src/lib/skills/*` |
| MCP registry | `crates/agent-ui/src/lib/mcpRegistry/*` |

## Tauri Rust

| Feature | Path |
|---|---|
| Tauri entry | `crates/agent-gui/src-tauri/src/main.rs` |
| App builder/invoke handler | `crates/agent-gui/src-tauri/src/lib.rs` |
| Chat history commands | `crates/agent-gui/src-tauri/src/commands/history/chat_history/*` |
| Settings commands | `crates/agent-gui/src-tauri/src/commands/config/settings/*` |
| Config snapshots/local import-export | `crates/agent-gui/src-tauri/src/commands/config/settings/backup_snapshot.rs`, `backup_io.rs` |
| WebDAV sync orchestration | `crates/agent-gui/src-tauri/src/commands/config/settings/webdav_sync.rs` |
| Memory commands | `crates/agent-gui/src-tauri/src/commands/integration/memory.rs` |
| MCP commands/runtime | `crates/agent-gui/src-tauri/src/commands/integration/mcp.rs` |
| File commands | `crates/agent-gui/src-tauri/src/commands/workspace/fs.rs` |
| Shell/process commands | `crates/agent-gui/src-tauri/src/commands/runtime/shell.rs`, `process.rs` |
| System commands | `crates/agent-gui/src-tauri/src/commands/app/system.rs` |
| Gateway commands | `crates/agent-gui/src-tauri/src/commands/integration/gateway.rs` |
| Subagent worktree commands | `crates/agent-gui/src-tauri/src/commands/workspace/subagent_worktree.rs` |
| Subagent store | `crates/agent-gui/src-tauri/src/commands/history/subagent_store.rs` |
| MemoryStore | `crates/agent-gui/src-tauri/src/services/memory/*` |
| Skills service | `crates/agent-gui/src-tauri/src/services/skills/*` |
| Gateway service | `crates/agent-gui/src-tauri/src/services/gateway/*`, `gateway_bridge.rs` |
| Automation service | `crates/agent-gui/src-tauri/src/services/automation/*` |
| WebDAV transport/auto-sync | `crates/agent-gui/src-tauri/src/services/webdav.rs`, `webdav_auto_sync.rs` |
| Runtime shell/process | `crates/agent-gui/src-tauri/src/runtime/*` |

## Gateway

| Feature | Path |
|---|---|
| Gateway entry | `crates/agent-gateway/cmd/gateway/main.go` |
| Config | `crates/agent-gateway/internal/config/config.go` |
| v2 protocol layer (WebSocket+Protobuf) | `crates/agent-gateway/internal/protocol/pbws/*` (browser/agent/terminal three links, guard allowlist, seam mapping) |
| WS connection runtime | `crates/agent-gateway/internal/transport/wscore/*` |
| Protocol shared domain logic | `crates/agent-gateway/internal/protocol/shared/*` (Origin validation, terminal gating/post-processing, terminal interest tracking) |
| Chat command orchestration | `crates/agent-gateway/internal/chatcmd/chatcmd.go` |
| Observability | `crates/agent-gateway/internal/observability/*` (slog initialization, v2 usage counters) |
| HTTP routes | `crates/agent-gateway/internal/server/http.go` (proto→JSON shaping: `proto_json.go`) |
| Session manager | `crates/agent-gateway/internal/session/manager.go`, `agent_session.go`, `manager_state.go`, `manager_registry.go`, `manager_*_sync.go`, `manager_terminal.go`, `manager_chat_runs.go` |
| Auth | `crates/agent-gateway/internal/auth/*` |
| Handlers | `crates/agent-gateway/internal/handler/*` |
| Proto source | `crates/agent-gateway/proto/v2/gateway.proto` (business messages), `proto/v2/gateway_ws.proto` (v2 frame shell) |
| Generated proto | `crates/agent-gateway/internal/proto/v2/*` |
| Project additional-directory protocol | The `list`, `apply`, and `revoke` actions of `WorkspaceRootGrantsRequest`; `internal/protocol/pbws/guard.go` handles the allowlist and field validation |

## WebUI

| Feature | Path |
|---|---|
| WebUI entry | `crates/agent-gateway/web/src/main.tsx` |
| App shell | `crates/agent-gateway/web/src/App.tsx`, `src/app/GatewayApp.tsx` |
| Gateway socket | `crates/agent-gateway/web/src/lib/gatewaySocket.ts` |
| Conversation stream client | `crates/agent-gateway/web/src/lib/chat/stream/conversationStreamClient.ts` |
| Terminal stream client | `crates/agent-gateway/web/src/lib/terminal/gatewayTerminalStreamClient.ts` |
| Gateway types | `crates/agent-gateway/web/src/lib/gatewayTypes.ts` |
| Web settings | `crates/agent-gateway/web/src/lib/webSettings.ts`, `web/src/lib/settings/*` |
| History sync/parser | `crates/agent-gateway/web/src/lib/sidebar/webSidebarBackend.ts`, `lib/chat/chatHistory.ts`, `lib/historyParser.ts` |
| Upload | `crates/agent-gateway/web/src/lib/uploadReadableFiles.ts` |
| Transcript | `crates/agent-gateway/web/src/components/GatewayTranscript.tsx` |
| Chat UI controllers | `crates/agent-gateway/web/src/pages/chat/*`, `src/components/GatewayTranscript.tsx` |
| Web Settings extensions | `crates/agent-gateway/web/src/pages/settings/*` |
| Shared UI adapters | `crates/agent-gateway/web/src/agent-ui-adapters/*` |
| Compatibility layer | `crates/agent-gateway/web/src/shims/*` |
| WebUI i18n | `crates/agent-gateway/web/src/i18n/*` |

## Materials and design

| Path | Description |
|---|---|
| `docs/README.md` | Current documentation entry. |
| `docs/architecture/*` | Current overview architecture documents. |
| `docs/features/*` | Current feature-domain architecture documents. |
| `docs/worklog/*` | Historical special-topic records; paths and mirror descriptions within are retained as they were at the time. |