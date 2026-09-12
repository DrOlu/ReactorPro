# ReactorPro architecture documentation

This documentation tree systematically lays out ReactorPro's desktop GUI, Tauri backend, Gateway service, and browser WebUI starting from the current code implementation. This `docs/` is positioned as the global architecture index; the repository's existing `doc/` is still retained as historical proposals, special-topic designs, and experimental documents, and is not being migrated or renamed in this effort.

## Project in one sentence

ReactorPro is an Agent application with the desktop as the local execution core: the GUI handles the user experience and local tool execution, Tauri/Rust handles system capabilities and persistence, the Go Gateway handles remote connectivity and protocol relay, and the WebUI operates the same local Agent session through the Gateway.

## Documentation directory

| Document | Coverage | Recommended reader |
|---|---|---|
| [architecture/overview.md](architecture/overview.md) | System overview, process boundaries, data flow, persistence map | Newcomers to the project |
| [architecture/gui.md](architecture/gui.md) | Desktop GUI, Tauri commands/services/runtime, settings and local execution | Frontend and desktop developers |
| [architecture/gateway.md](architecture/gateway.md) | Go Gateway's HTTP/WebSocket (v2), Session Manager, buffering and auth | Gateway development and troubleshooting |
| [architecture/webui.md](architecture/webui.md) | Browser WebUI, socket client, conversation stream subscription, state and security boundaries | WebUI developers |
| [architecture/protocols.md](architecture/protocols.md) | Protocol contracts between GUI and Gateway, and between WebUI and Gateway | Integration and protocol changes |
| [features/chat-runtime.md](features/chat-runtime.md) | Conversation runtime, model layer, streaming, compaction, hooks, upload and resend | Chat feature development |
| [features/tools.md](features/tools.md) | Builtin tools, MCP dynamic tools, subagent (Agent/SendMessage), tool execution boundaries | Tool system development |
| [features/memory.md](features/memory.md) | MemoryStore, MemoryManager, Settings Memory, automatic learning and recall | Memory system development |
| [features/skills-and-mcp.md](features/skills-and-mcp.md) | Skills root/builtin/ClawHub and MCP Hub/registry/runtime | Skills/MCP development |
| [features/history-compaction.md](features/history-compaction.md) | V3 history segmentation, FTS, sharing, context compaction checkpoints | History and context development |
| [features/config-backup-sync.md](features/config-backup-sync.md) | Config snapshots, local import/export, WebDAV sync and automatic upload | Settings and sync development |
| [design/workbench-project-tool-panes.md](design/workbench-project-tool-panes.md) | Review / tunneling / SSH / background tasks move out of the Right Dock to become draggable, tileable Workbench Panes (shared implementation for desktop and Web) | Workbench and project tool development |
| [operations/development.md](operations/development.md) | Local development, build, test, ports, run paths | Day-to-day development |
| [operations/deployment.md](operations/deployment.md) | CI/CD, Gateway Docker, user self-deployment, desktop Release automation | Release maintenance |
| [operations/multi-agent.md](operations/multi-agent.md) | Multi-desktop Agent deployment, per-Agent credential issuance/rotation/deletion, security model | Multi-device deployment |
| [reference/source-map.md](reference/source-map.md) | A source path index organized by feature domain | Quickly locating source code |

## Architecture reading order

| Order | Goal | Document |
|---:|---|---|
| 1 | First build an overall process and boundary model | [architecture/overview.md](architecture/overview.md) |
| 2 | Understand why the desktop is the source of execution truth | [architecture/gui.md](architecture/gui.md) |
| 3 | Understand how remote access is forwarded to the desktop | [architecture/gateway.md](architecture/gateway.md), [architecture/protocols.md](architecture/protocols.md) |
| 4 | Understand the WebUI's state machine and limits | [architecture/webui.md](architecture/webui.md) |
| 5 | Go deeper by feature domain into Chat, Tools, Memory, Skills/MCP, History/Compaction, and config backup sync | `features/` |
| 6 | When you need to get hands-on, consult the run commands and source index | [operations/development.md](operations/development.md), [reference/source-map.md](reference/source-map.md) |

## Core boundaries of the current implementation

| Boundary | Current conclusion |
|---|---|
| Agent execution location | The desktop GUI/Tauri locally executes model requests, tool calls, filesystem, Shell, MCP, Skills, Memory, and Cron prompts. |
| Gateway responsibilities | Authentication, connection keep-alive, request routing, event broadcasting, a bounded Chat relay window, and serving WebUI static assets and public share pages. |
| WebUI responsibilities | The browser-side console. It does not execute tools directly and holds no local filesystem permissions; all high-privilege capabilities return to the desktop through the Gateway. |
| Settings sync | The GUI is the source of truth for settings; the WebUI stores a redacted snapshot, and sensitive keys can only be sent one-way back to the GUI after the user explicitly enters a new value. |
| History sync | The GUI writes SQLite history; the Gateway only forwards history requests and sync events; the WebUI maintains a local visible cache. |
| Documentation source | This document is compiled from the current checkout's source paths, entry files, protocol definitions, and run scripts. |

## Relationship with `doc/`

| Directory | Positioning |
|---|---|
| `docs/` | Global architecture descriptions, module maps, run instructions, and source index for the current implementation. |
| `doc/` | Existing special-topic documents and historical design materials, such as the memory proposal, Gateway protocol drafts, and context compaction strategies. |

In the future, if a special-topic document has stably become part of the current implementation, a summary and navigation can be established in `docs/`, but it is not advisable to directly rename `doc/` to `docs/`, to avoid losing historical context.