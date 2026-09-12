# Desktop GUI and Tauri Architecture

## Module Boundaries

| Module | Path | Responsibility |
|---|---|---|
| React app shell | `crates/agent-gui/src/App.tsx` | Settings hydration/save, theme/i18n, Settings overlay, ChatPage, CronPromptRunner, MemoryOrganizerRunner, global toast. |
| Chat page | `crates/agent-gui/src/pages/ChatPage.tsx` | Session state, message send/cancel, history, uploads, model selection, Gateway bridge, Skills/Memory prompt, compaction and runtime orchestration. |
| Chat submodules | `crates/agent-gui/src/pages/chat/*` | transcript data controller, agent/text turn, history actions, uploads, context construction and live transcript store; shared composer/header/visual components come from `crates/agent-ui`. |
| Settings | `crates/agent-ui/src/pages/settings/*`, `crates/agent-gui/src/pages/settings/*` | Shared Settings pages live in `agent-ui`; the GUI directory keeps only desktop extensions such as shortcuts, the about page, and the Memory platform adapter. |
| Hub pages | `crates/agent-ui/src/pages/skills-hub/*`, `crates/agent-ui/src/pages/mcp-hub/*`, `crates/agent-ui/src/components/hub/*` | Skills Hub, MCP Hub, store/registry browsing and the shared Hub shell. |
| UI components | `crates/agent-ui/src/components/*`, `crates/agent-gui/src/components/*` | Shared Sidebar, Markdown, ImagePreview and base components live in `agent-ui`; the GUI directory keeps desktop-only components. |
| Frontend settings library | `src/lib/settings/*` | Defaults, normalize, storage, Gateway sync snapshot, provider redaction. |
| Model layer | `src/lib/providers/llm.ts` | provider-to-concrete-model API mapping, headers, Responses/Anthropic/Gemini stream, thinking/cache/search. |
| Tool layer | `src/lib/tools/*`, `src/lib/subagents/*` | builtin tool registry, FS, Shell, MCP, Skills, Cron, Memory, custom system tools; the subagents domain provides the `Agent`/`SendMessage` delegation tools. |
| Tauri backend | `src-tauri/src` | System commands, SQLite, MCP runtime, MemoryStore, GatewayController, CronManager, proxy service. |

## App Shell

| Responsibility | Current Implementation |
|---|---|
| Initial settings | Reads providers/system/mcp/agents/hooks/cron/remote/memory via the settings API and merges them with frontend defaults. |
| Settings save | After edits on the Settings page, saves by config domain to Tauri SQLite and publishes settings sync to the Gateway when needed. |
| Theme and language | `theme` is written to the document root, and `LocaleProvider` provides translations. |
| Page layout | The main view centers on ChatPage, and Settings opens in an overlay/modal style. |
| Background runners | `CronPromptRunner` handles prompt-type cron; `MemoryOrganizerRunner` handles automatic memory organization. |
| Remote bridging | When Remote settings are enabled, the Tauri GatewayController connects to the Go Gateway and publishes settings/history/chat events. |

## Local Shortcut Preferences

Desktop "Settings → Shortcuts" preferences are stored in the local WebView's localStorage and do not enter settings sync or Gateway configuration.

- **Send message**: toggles inline between Enter and Ctrl+Enter (macOS shows ⌘+Enter, with Ctrl+Enter also supported). When the chord-send option is selected, plain Enter inserts a newline; Shift+Enter always inserts a newline. The send key only takes effect in the current message input box, preserving IME candidate-selection protection. Enter-to-send is the default.
- **Effective scope**: each bound app action can toggle between "Global / App". Global bindings are registered via Tauri system hotkeys; app bindings are dispatched only when the ReactorPro window has focus, with window focus checked again on the Rust side. Legacy bindings without a scope field continue to be treated as global.
- **Recording and switching**: recording simultaneously pauses global registration and in-app listening; full registration requests execute serially, and switching to app scope revokes the original system hotkeys. Unmodified character keys in app scope will not preempt normal input in the input box, and the tray menu only echoes global-scope shortcuts.

The main entry points are `src/lib/shortcuts/globalShortcuts.ts`, `src/pages/settings/GlobalShortcutsSection.tsx`, `src-tauri/src/commands/app/app.rs`; the shared message input box reads `agent-ui/src/lib/chat/sendShortcut.ts`.

## ChatPage Orchestration

| Subsystem | Notes | Key Paths |
|---|---|---|
| Session runtime state | Current conversation, session, message list, live stream, tool status, running/canceling state. | `ChatPage.tsx`, `pages/chat/hooks/useChatPageRuntimeStore.ts`, `lib/chat/conversation/liveTranscriptStore.ts` |
| Send entry | Merges user text, attachments, selected model, execution mode, workdir, system tools, etc. into a turn request. | `ChatPage.tsx` |
| text mode | Only streams model text, without injecting local tools. | `pages/chat/turns/runTextConversationTurn.ts`, `lib/providers/llm.ts` |
| tools/agent-dev mode | Builds builtin tools, runs the model tool loop, writes tool traces, and syncs Gateway chat events. | `pages/chat/turns/runAgentConversationTurn.ts`, `lib/chat/conversation/run/*` |
| History persistence | V3 segments are written to Tauri SQLite, supporting append segment, active segment update, rename/delete/pin/share. | `lib/chat/conversation/conversationState.ts`, `src-tauri/src/commands/history/chat_history/*` |
| Context compaction | Generates summary checkpoints at pre-send, mid-stream, post-tool stages to avoid exceeding context. | `pages/chat/runtime/conversationContextBuilders.ts`, `lib/chat/compaction/*` |
| Memory injection | Reads the memory overview each turn based on workdir and appends it to the system prompt. | `lib/chat/memory/*`, `src-tauri/src/services/memory/*` |
| Skills injection | Generates the skills prompt from Settings Skills selections and always-on builtin skills. | `crates/agent-ui/src/lib/skills/index.ts`, `crates/agent-ui/src/lib/skills/useChatSkills.ts` |
| Uploads | The GUI directly calls Tauri import readable files/image preview; files outside the workspace are copied to the `~/.liveagent/uploads` staging area (without polluting the workspace), while files inside the workspace are referenced in place. | `pages/chat/hooks/usePendingUploads.ts`, `src-tauri/src/commands/app/system.rs` |
| External directories | The Composer can select a directory outside the workspace and mount it as a read-only workspace root for the current project; the active root is shown in the File Tree but is not added to the workspace activity watcher. | `ChatPage.tsx`, `pages/chat/hooks/useUploadZoneDrop.ts`, `crates/agent-ui/src/components/project-tools/file-tree/*` |
| Gateway bridge | The local runtime receives remote commands and publishes events such as token/thinking/tool/done/error to the Gateway; the listener and worker id remain stable across the component lifecycle. | `pages/chat/gateway/useGatewayBridgeListeners.ts`, `lib/chat/conversation/run/gatewayBridgeEvents.ts` |

## Tauri Invoke Surface

`src-tauri/src/lib.rs` registers all desktop commands with `tauri::generate_handler!`. By domain they can be summarized as:

| Domain | Command Family |
|---|---|
| Chat history | `chat_history_list/search/get/upsert/upsert_active_segment/append_segment/rename/set_pinned/share_get/share_set/delete` |
| Subagent store | `subagent_identity_upsert/list`, `subagent_run_save/list/load/prune`, `subagent_message_append/list` |
| File system | `fs_read_text/read_image_source/write_text/edit_text/delete/list/glob/grep/mention_list` |
| Subagent worktree | `subagent_worktree_create/status/apply/cleanup` |
| MCP runtime | `mcp_list_tools/call_tool/runtime_status/stop_server/test_server/restart_server` |
| Memory | `memory_list/read/search/write/update/delete/accept/apply_batch/organize_* /index_overview/paths_info/recent_rejections/today_daily/wipe_all` |
| Settings | `settings_load_all/save_providers/save_system/save_mcp/save_agents/save_hooks/save_cron/save_remote/save_memory` |
| Hooks/Cron | `hook_run_script/run_http_requests`, `cron_validate_expression/list_logs/clear_logs/take_pending_prompt_runs/complete_prompt_run` |
| Shell/process | `shell_run/cancel`, `managed_process_start/status/stop/read_log` |
| System | folder/file picker, uploads, skill metadata/text/manage, debug jsonl, power activity, cron task manage |
| Gateway | `gateway_connect/disconnect/status/nudge_connection/send_chat_event/publish_conversation_activity/publish_settings_sync` |
| Proxy | `proxy_get_server_info` |

## Rust Services and Runtime

| Path | Role |
|---|---|
| `src-tauri/src/services/gateway/*` | GatewayController, maintaining the desktop-to-Gateway connection, native wakeup, inbox, state sync, and reconnection. |
| `src-tauri/src/services/gateway_bridge.rs` | Translates Gateway requests into operations the frontend/Tauri can handle, handling settings/history/chat bridging. |
| `src-tauri/src/services/memory/*` | MemoryStore, responsible for Markdown memory files, SQLite FTS index, quota, daily, organizer. |
| `src-tauri/src/services/skills/*` | Skills root, builtin seed, install/create/validate/package, ClawHub. |
| `src-tauri/src/services/automation/*` | Automation scheduling and storage, covering bash/http/prompt tasks and run records. |
| `src-tauri/src/services/proxy.rs` | Local proxy server, used for provider proxy and upstream access. |
| `src-tauri/src/runtime/shell_runner.rs` | Shell script execution abstraction. |
| `src-tauri/src/runtime/managed_process.rs` | Long-running task/background process management. |
| `src-tauri/src/runtime/task_runner.rs` | Generic async task-running helper. |

## Gateway Connection and Runtime Wakeup

| Mechanism | Current Implementation |
|---|---|
| Stable WebView listener | `useGatewayBridgeListeners` stores the worker id and latest callbacks in refs, and the effect only registers/destroys on component mount/unmount; ordinary React renders no longer rebuild the listener, creating a receive gap or duplicate `suspended` reports. |
| Native round-trip wakeup | After Rust receives a correlated Ping with the `chat-runtime-wake-` prefix, it emits `gateway:chat-runtime-wake`; all Pongs (wakeup and heartbeat) are returned via `try_send` over a dedicated outbound control channel (depth 64, merged with the data queue into the same envelope stream (v2 WebSocket)), so probes can still be answered when the token stream saturates the data queue, and the inbound receive loop is never blocked. |
| Lifecycle nudge | `online`, `focus`, `pageshow`, `visibilitychange`, WebView `resume`, and Tauri `RunEvent::Resumed` wake the runtime; `online`/focus-type events go through `gateway_nudge_connection` and rebuild the connection only after an offline/stale-heartbeat health check (not forced), while only `RunEvent::Resumed` retains forced reconnection. |
| Fast reconnection | The envelope stream auto-reconnects with exponential backoff from 250ms to 5s (v2 `/ws/v2/agent`), resetting after 30s of stable connection; staleness is determined using the heartbeat interval plus 20s (at most 60s). |
| inbound priority | Once the envelope stream (`/ws/v2/agent`) is established, it immediately enters the inbound receive loop. Runtime status recovers first; settings, terminal, tunnel, process and run ledger are replayed at low priority in an abortable background task after a 200ms delay, yielding between batches. |
| Startup gap elimination | The WebView performs one heartbeat + drain before the Tauri listener's async registration completes; native wake, request-ready, and Gateway online events all continue to trigger drains. |

## Local Persistence Model

| Data Domain | Rust Command/Service | Table or File |
|---|---|---|
| Providers/System/MCP/Agents/Hooks/Cron/Remote/Memory settings | `commands/config/settings/*` | Multiple settings tables inside `~/.liveagent/config.sqlite` |
| Chat history | `commands/history/chat_history/*`, `commands/history/history_db.rs` | `chatHistory`, `chatHistorySegment`, `chatHistoryShare`, FTS in `~/.liveagent/chat-history.sqlite3` |
| Memory | `services/memory/*` | `~/.liveagent/memory/**/*.md` + `memory-index.sqlite3` |
| Skills | `services/skills/*` | `~/.liveagent/skills` |
| Cron logs | `commands/config/settings/*`, `services/automation/*` | `cron_execution_logs` |
| Subagent identity/run/message | `commands/history/subagent_store.rs` | `subagentMeta` version marker in the chat history DB + `subagentIdentity`/`subagentRun`/`subagentRunSegment`/`subagentMessage` (schema v2, drop-and-recreate on version mismatch, no event table) |

## GUI Design Trade-offs

| Trade-off | Reason |
|---|---|
| ChatPage remains the top orchestration layer | Chat runtime spans models, tools, history, compaction, memory, Gateway, uploads and UI state; keeping a single orchestration hub reduces implicit cross-module state. |
| High-privilege capabilities in Rust | File system, Shell, MCP processes, SQLite, Gateway connections, and Cron are better suited to permission and lifecycle control in the Tauri backend. |
| GUI and WebUI share application UI | Settings, Hub, chat sidebar, input bar and shared visuals are kept in a single copy in `crates/agent-ui`; the GUI accesses Tauri capabilities through host adapters. |
| Settings saved by domain | Domains such as provider secret, remote, cron, and memory have different validation and sync policies; saving by domain helps limit leakage and reduce accidental overwrites. |
| Gateway control plane first | The first remote Chat command and Ping/Pong must precede bulky state reconciliation; background snapshot replay is only responsible for eventual consistency and does not block inbound. |