# ReactorPro overall architecture

## System layers

| Layer | Main path | Tech stack | Core responsibilities |
|---|---|---|---|
| Shared application UI | `crates/agent-ui/src` | React, TypeScript, Tailwind | Settings, Skills Hub, MCP Hub, chat sidebar, composer, project tools, and domain logic shared by the GUI/WebUI. |
| Desktop GUI | `crates/agent-gui/src` | React, TypeScript, Vite, Tailwind | Desktop startup entry, Chat data controllers, Tauri capability adapters, upload and streaming runtime state. |
| Desktop backend | `crates/agent-gui/src-tauri/src` | Tauri 2, Rust, SQLite, tokio | System commands, file/Shell/process, MCP runtime, MemoryStore, CronManager, GatewayController, proxy service. |
| Agent runtime | `crates/agent-gui/src/lib/chat`, `crates/agent-gui/src/pages/chat`, `crates/agent-gui/src/lib/tools` | TypeScript, `@earendil-works/pi-ai` | Build context, request models, execute tools, compact context, persist history, publish Gateway events. |
| Gateway | `crates/agent-gateway` | Go, net/http, WebSocket+Protobuf (v2) | Remote relay between the desktop Agent and browser WebUI, authentication, session management, recovery buffering, static WebUI and share pages. |
| WebUI | `crates/agent-gateway/web` | React, TypeScript, Vite, WebSocket | Browser startup entry, Gateway data controllers and remote capability adapters, operating the local Agent through the Gateway. |
| Materials and policy | `docs/` | Markdown | Current architecture, feature descriptions, design specs, and historical worklogs. |

## Process boundaries

| Process/runtime | Entry | Communicates with | Permission boundary |
|---|---|---|---|
| Tauri WebView | `crates/agent-gui/src/main.tsx`, `src/App.tsx` | Tauri invoke, Gateway bridge, model API | The user-visible desktop UI; triggers local capabilities but does not directly access Rust internal state. |
| Tauri Rust process | `src-tauri/src/main.rs`, `src-tauri/src/lib.rs` | Frontend invoke, SQLite, OS, Gateway WebSocket v2, MCP server | The local high-privilege source of truth, responsible for system capabilities, persistence, and remote bridging. |
| Gateway Go process | `crates/agent-gateway/cmd/gateway/main.go` | Desktop/Browser WebSocket v2 (Protobuf frames), HTTP | The network relay layer; does not execute local tools directly. |
| Browser WebUI | `crates/agent-gateway/web/src/main.tsx`, `web/src/App.tsx`, `web/src/app/GatewayApp.tsx` | Gateway `/ws/v2`, `/api/*` | Remote UI; holds only a token, redacted settings, and local browser cache. |

## Core data flows

| Data flow | Steps | Key paths |
|---|---|---|
| Local desktop conversation | The shared composer submits a message, the GUI `ChatPage` builds context, enters a text or agent turn by execution mode, the model streams back, builtin tools are executed as needed, and finally history is written to SQLite. | `crates/agent-ui/src/pages/chat/ChatComposerBar.tsx`, `src/pages/ChatPage.tsx`, `src/pages/chat/turns/*`, `src/lib/providers/llm.ts`, `src/lib/tools/builtinRegistry.ts` |
| WebUI remote conversation | After the WebUI optimistic echo, it first sends `chat_prepare` over `/ws/v2`; the Gateway verifies the desktop envelope stream via a correlated native Ping/Pong and wakes the desktop Chat Runtime; then `chat_command` (`chat.submit`/`chat.edit_resend`) is accepted and delivered over the `/ws/v2/agent` envelope stream. The desktop runs locally and continuously sends back `ChatEvent`/`ChatControlEvent`, and the Gateway pushes them to the WebUI by seq over the conversation subscription (`chat.subscribe`/`chat.event`). | `web/src/lib/gatewaySocket.ts`, `internal/protocol/pbws/browser_local.go`, `internal/chatcmd/chatcmd.go`, `proto/v2/gateway.proto`, `src-tauri/src/services/gateway/*` |
| Settings sync | The GUI loads/saves settings to local SQLite and also publishes a redacted settings snapshot to the Gateway; when the WebUI reads/updates settings it goes through the Gateway, and ordinary sync carries no real provider API key. | `src/lib/settings/*`, `src-tauri/src/commands/config/settings/*`, `crates/agent-ui/src/lib/settings/sync.ts`, `web/src/lib/settings/*` |
| History sync | The GUI persists `chatHistory` and `chatHistorySegment` and publishes history sync after operations; the Gateway forwards it to the WebUI, which refreshes its list or detail cache. | `src-tauri/src/commands/history/chat_history/*`, `src-tauri/src/services/gateway/*`, `web/src/lib/sidebar/webSidebarBackend.ts`, `web/src/lib/historyParser.ts` |
| File upload | The GUI imports directly through Tauri; the WebUI goes through Gateway HTTP multipart, and the Gateway converts the bytes into an `UploadReadableFilesRequest` envelope. The desktop uniformly writes files to the `~/.liveagent/uploads` staging area (outside the workspace) and then returns a file reference. | `src-tauri/src/commands/app/system.rs`, `internal/handler/upload.go`, `web/src/lib/uploadReadableFiles.ts` |
| Memory recall | Each Chat round may call the Rust `MemoryStore` to generate an overview injected into the system prompt; the tool layer exposes `MemoryManager` for reads and writes; the shared Settings Memory displays and manages the same store. | `src-tauri/src/services/memory/*`, `src/lib/chat/memory/*`, `src/lib/tools/memoryTools.ts`, `crates/agent-ui/src/pages/settings/memory/*` |

## Current main persistence

| Data | Location | Owner | Notes |
|---|---|---|---|
| App settings | `~/.liveagent/config.sqlite` | Tauri Rust | provider/system/mcp/agents/hooks/cron/remote/memory settings. |
| Chat history | `~/.liveagent/chat-history.sqlite3` | Tauri Rust | Conversation header, segment, share, FTS index. |
| Memory files | `~/.liveagent/memory/...` | Tauri Rust | Markdown is the memory source of truth, organized into global/project/daily and other directories. |
| Memory index | `~/.liveagent/memory/memory-index.sqlite3` | Tauri Rust | `memory_meta`, `memory_fts`, `memory_fts_tri`, audit log. |
| Skills root | `~/.liveagent/skills` | Tauri Rust + GUI | The Skills runtime root that users can install/create/package. |
| WebUI local cache | Browser localStorage | WebUI | token, redacted settings snapshot, UI preferences, and runtime-assist cache. |

Gateway's Chat relay state is not persistent data: the conversation event window retains the last 10 minutes by default and is bounded by a hard limit of 4096 entries / about 8 MiB, while `client_request_id` idempotency records are kept for 24 hours in the current process. After a Gateway restart, the desktop history snapshot, run ledger, and RuntimeStatus are reconciled anew.

## Design principles

| Principle | Manifestation in the current code |
|---|---|
| The desktop is the source of truth | Tool execution, history, settings, memory, Cron prompts, and MCP runtime all land on the Tauri/GUI side. |
| The Gateway does not exceed its authority | The Gateway does not directly access the user's filesystem and does not store real provider keys; it maintains only sessions, relays, and a bounded in-process Chat event window. |
| GUI/WebUI availability alignment | Both clients reuse components and domain logic from `crates/agent-ui`, providing Tauri or Gateway adapters through `@liveagent/adapters`; app-specific capabilities are selectively enabled by an extension registry. |
| Long conversations are recoverable | History uses desktop segments + summary checkpoints; short disconnections are filled in by the Gateway's in-memory seq window and `chat.subscribe.after_seq`, and a window reset or Gateway restart falls back to the desktop history snapshot. |
| Clear feature domains | Chat runtime, Tools, Memory, Skills, MCP, Cron, Hooks, and History each have an independent source area and backend commands. |

## High-level module diagram

```text
Browser WebUI
  ├─ React entry / Gateway controllers / GatewayTranscript
  ├─ Shared UI: Settings / Hubs / sidebar / composer / project tools
  ├─ GatewayWebSocketClient (chat command/subscribe + sync)
  └─ HTTP upload / public share
        │
        ▼
Go Gateway
  ├─ HTTP/WS: /ws/v2, /ws/v2/agent, /ws/v2/terminal, /api/status, /api/files/import, /api/public/history-shares/{token}
  └─ session.Manager: agent session, streams, settings/history subscribers, bounded chat relay window
        │
        ▼
Desktop ReactorPro
  ├─ React GUI: App, ChatPage, desktop adapters
  ├─ Shared UI: Settings / Hubs / sidebar / composer / project tools
  ├─ Agent runtime: model streaming, tools loop, compaction, memory extraction
  └─ Tauri Rust: commands, services, SQLite, MCP, MemoryStore, Cron, Gateway bridge
```