# Go Gateway Architecture

## Responsibility Boundaries

Gateway is a remote access relay, not an Agent execution environment. It serves both desktop Agents and the browser WebUI, and both ends uniformly use WebSocket+Protobuf (v2 protocol):

| Direction | Protocol | Purpose |
|---|---|---|
| Desktop Agent -> Gateway | WebSocket `/ws/v2/agent` (Protobuf frames) | The desktop registers an online session, receives WebUI requests (`GatewayEnvelope`), and returns responses and events such as chat/history/settings/memory/skills (`AgentEnvelope`). |
| Desktop/Browser -> Gateway | WebSocket `/ws/v2/terminal` (Protobuf frames) | Dedicated terminal byte stream (role distinguished by hello), carrying attach snapshot, input, resize, output; does not share a queue with the normal control plane. |
| WebUI -> Gateway | WebSocket `/ws/v2` (Protobuf frames) | The browser initiates chat (command/subscribe), directly passes through requests such as history/settings/skills/memory/cron, and subscribes to `chat_event` and sync broadcasts. |
| WebUI -> Gateway | HTTP `/api/*` | Status check, file upload, public share pages, image proxy, static assets. |

## Entry Point and Service Startup

| File | Purpose |
|---|---|
| `cmd/gateway/main.go` | Reads config, creates `session.Manager`, starts the HTTP server, handles shutdown. |
| `internal/config/config.go` | Configuration for address, token, TLS, static assets, request size, timeouts, etc. |
| `internal/observability/` | slog initialization and v2 protocol usage counts (`protocol_usage` in `/api/status`). |
| `internal/transport/wscore/` | WebSocket connection runtime: control-first dual-queue write pump, congestion frame dropping, bounded retries, heartbeat and idle eviction. |
| `internal/protocol/pbws/` | **v2 protocol layer**: three-link handshake/encoding-decoding, pass-through whitelist (`guard.go`), correlation id namespacing, event fan-out and snapshot replay. |
| `internal/protocol/shared/` | Protocol-agnostic domain logic: Origin validation, terminal permission gating and post-response processing, terminal interest tracking. |
| `internal/chatcmd/` | chat command orchestration (normalization, liveness probe, delivery, startup watchdog). |
| `internal/auth/` | HTTP/WS token validation. |
| `internal/server/http.go` | HTTP mux, v2 WebSocket routes, API, static WebUI and public share route (proto→JSON shaping in `proto_json.go`). |
| `internal/session/manager.go` | `session.Manager` façade and core public types (transport-agnostic). |
| `internal/session/manager_state.go` | Internal state definitions for session registry, sync hub, chat run store. |
| `internal/session/manager_registry.go` | Current Agent session, auth snapshot, per-request stream registration. |
| `internal/session/manager_*_sync.go`, `manager_terminal.go`, `conversation_stream.go`, `conversation_ingress.go` | history/settings/terminal sync, in-process Chat event window, real-time fan-out, replay and command dedupe. |

## HTTP Routes

| Route | Auth | Description |
|---|---|---|
| `GET /ws/v2` | hello token | **v2** WebUI main link (Protobuf frames, subprotocol `liveagent.v2.pb`). |
| `GET /ws/v2/agent` | hello token | **v2** desktop envelope stream. |
| `GET /ws/v2/terminal` | hello token | **v2** terminal data plane (shared by both ends, role in hello). |
| `GET /api/status` | token | Agent online status + `protocol_usage` protocol usage counts. |
| `POST /api/files/import` | token | WebUI uploads readable files; Gateway forwards them to the desktop to be written to the `~/.liveagent/uploads` staging area. |
| `GET /api/public/history-shares/{token}` | public token | Public read-only history share data. |
| `GET /image-proxy` | depends on config/implementation | Image proxy with URL safety validation. |
| `/` | none or per static asset policy | Embedded/built WebUI static assets and SPA fallback. |

Chat goes through `/ws/v2` and is a strictly new protocol: `chat_prepare` uses a correlated Ping/Pong to probe and wake the desktop Chat Runtime; `chat_command` carries the proto `ChatCommandRequest`; `chat_subscribe` subscribes by `conversation_id`. The old HTTP SSE route `GET /api/chat/events` has been retired.

## Proto Definitions and Code Generation

`proto/v2/gateway.proto` is the authoritative business message definition shared by all three ends, and `proto/v2/gateway_ws.proto` defines the WebSocket frame shell; Go is generated uniformly under `internal/proto/v2/*`. Code generation is uniformly driven by `buf` (`make proto`), and CI has a gate for generated-artifact drift and breaking checks.

## Session Manager

`session.Manager` is the Gateway state façade, maintaining the original API externally; internally it is split by responsibility into session registry, sync hub and chat run store, avoiding a single lock covering all state.

| State | Description |
|---|---|
| session registry | Current desktop Agent session, auth snapshot, session epoch, per-request stream. |
| sync hub | history/settings/terminal subscribers, settings snapshot, terminal session snapshot. |
| conversation stream store | Within the current process, per conversation it maintains a monotonic `seq`, `stream_epoch`, active run, recent event window and subscribers; responsible for real-time fan-out and short-term replay. |
| chat command dedupe | Within the current process, it atomically maintains `client_request_id -> canonical run`, retained for 24 hours, and stores the latest `bound`/`queued_in_gui`/`failed` update for replay by a reconnecting client after an ACK loss. |

## Chat Event Window and Recovery

| Mechanism | Current meaning |
|---|---|
| Bounded in-memory window | Each conversation retains the last 10 minutes of events by default, with a hard cap of 4096 entries or about 8 MiB; active runs are not evicted by time before the hard cap is reached, and idle conversations are reclaimed after about 30 minutes. |
| `Seq` / `stream_epoch` | Within the same Gateway process, `seq` increases monotonically per conversation and spans runs; WebUI uses `after_seq` to catch up on events within the window. When the epoch differs, the cursor is ahead, or events have been evicted, `reset` is returned and the client rebuilds from the desktop history snapshot. |
| command idempotency | `StartChatCommand` atomically allocates a canonical run under the same store mutex; concurrent or retried submissions of the same `client_request_id` return the same `run_id`, and will not re-seed or re-dispatch. Records are retained for 24 hours. |
| command update replay | Gateway stores the latest `bound`, `queued_in_gui` or `failed` update for the canonical run; when WebUI reconnects and retries with the same ID after an ACK loss, it will not miss the pre-stream result. |
| Process restart boundary | Neither the Chat event window nor command dedupe persists across Gateway processes. After a Gateway restart, reconciliation is redone from the WebUI history snapshot and the desktop run ledger/status republish; exactly-once is not promised across restarts. |

## WebSocket Protocol Roles

| Type | Description |
|---|---|
| request/response | WebUI sends an id-bearing request; Gateway returns a response or error with the same id. |
| broadcast | Gateway proactively pushes non-Chat sync events such as `status`, `history.event`, `settings.event`, `terminal`, `sftp`. |
| chat prepare | `chat.prepare` sends a Ping with a `chat-runtime-wake-` request id to the current `AgentConnect` stream; the desktop Rust emits a WebView wake and reliably returns the correlated Pong; Gateway responds only after receiving a real round trip, and records short-term freshness bound to the current session epoch. |
| chat command | Submit/edit/cancel go through WS `chat.command`; a new command must have a native round-trip probe before it can be accepted. A command immediately following a successful prepare can reuse the same session's fresh result within 2 seconds; old clients or expired results still probe on the spot. The accepted ACK goes through the control-first queue, avoiding being blocked by a backlog of token data. Streaming events go through a per-conversation persistent subscription `chat.subscribe`; both subscribe and unsubscribe are scoped by `(agent_id, conversation_id)` and require a non-empty `agent_id`, delivered via `chat.event` (when the subscription buffer overflows, `chat.subscription_reset` is sent to prompt the client to resubscribe by cursor). |
| terminal stream | Does not go through the main-link request; attach/input/resize/detach go through `/ws/v2/terminal` proto frames, and the page-side `BrowserGatewayTerminalStreamClient` reuses one terminal stream for the same token and fans out by session. |

The WebSocket server implementation is layered: `internal/transport/wscore` handles the write pump/backpressure/heartbeat; the protocol layer is in `internal/protocol/pbws` (frame encoding/decoding, pass-through whitelist, event fan-out). Domain logic (terminal gating/post-response processing, chat orchestration) is in `internal/protocol/shared` and `internal/chatcmd`.

Terminal metadata events are synchronized over the `/ws/v2` broadcast arm (`terminal_event`) for the `created`, `exit`, `closed`, `renamed`, SSH prompt and SSH tab states; terminal output does not enter React session state and does not carry the full session. Output bytes are pushed only over `/ws/v2/terminal`, and a slow client only blocks its own terminal stream.

## Security Model

| Area | Design |
|---|---|
| Authentication | HTTP API via Bearer token; WebSocket via hello token (supplemented by Origin validation). |
| Chat command protection | Chat commands are submitted only via the authenticated WebSocket `chat.command` (connection-level token + Origin validation, 2 MiB payload cap); a correlated Ping/Pong of the current native stream must complete before acceptance. |
| Chat subscription protection | `chat.subscribe` is available only on authenticated `/ws/v2` connections; each conversation's replay is protected by the hard cap of the 4096-entry and about 8 MiB event window. |
| Provider API key | Normal settings sync should not carry real keys; WebUI only receives presence/redacted fields. |
| File access | WebUI uploads only hand bytes to the desktop for import; Gateway does not directly write them to arbitrary local paths. |
| Tool execution | Gateway does not run high-privilege tools such as Shell, FS, MCP, Memory mutation; it only forwards requests to the desktop. |
| Public share | Share data is located by token, supports read-only transcripts, and can redact tool content per settings. |
| Public share error | The desktop returns the `history_share_resolve` error semantic via `ErrorResponse.code`; Gateway HTTP maps codes to statuses such as 400/404/502, no longer relying on error text. |

## Gateway Failure Modes

| Failure | Symptom | Design handling |
|---|---|---|
| Desktop offline | WebUI request returns agent offline or status offline | `session.Manager` detects the current session; WebUI shows offline/unavailable state. |
| WebSocket disconnect | WebUI reconnects automatically; Chat subscription resumes by `after_seq` cursor | `GatewayWebSocketClient` uniformly manages reconnection and re-sends `chat.subscribe` after reconnecting; Gateway replays from the current process's bounded event window; when the window is insufficient it returns reset, rebuilt from the desktop history snapshot. |
| Desktop envelope stream disconnect | Agent session close, pending streams end | Desktop remote auto reconnect can re-establish the session; after reconnecting the desktop republishes the chat run ledger (active `started` + unacknowledged terminal control events), and the gateway idempotently adopts it. |
| First send after long idle | socket, envelope stream or WebView runtime may be half-open/asleep | `chat.prepare` completes a correlated native Ping/Pong within a default 2 seconds; an immediately following command reuses the session-bound fresh result; when there is no fresh result the command probes on its own. Failure returns immediately rather than incorrectly marking the command as accepted. |
| Chat run terminal signal loss | The run has already ended on the desktop but gateway activity is not cleared | The desktop `ChatRunLedger` records before sending, and a 5s sweeper re-sends undelivered terminal states; heartbeat `RuntimeStatusEvent.active_runs/finished_runs` drives gateway reconciliation: finished reports are adopted per the real terminal state, active reports extend each run's life; absence with no event/life extension beyond `runReportLostTimeout` (15s) is judged `failed/desktop_run_lost`. |
| Chat run stuck fallback | Desktop stops reporting a run | Online uses `staleRunTimeout` (10min, per-run life extension; a busy single conversation does not mask others); offline uses `offlineRunTimeout` (30min) to judge `failed/agent_offline`. |
| Chat run duplicate submission | Same `client_request_id` repeated within the same Gateway process | 24-hour process-level atomic dedupe returns the canonical run; used to cover a single same-ID retry after a WebSocket ACK loss. |
| Chat command does not enter running state | Event stream only reaches accepted/delivered and does not continue | The command path uses a default 5-second `LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT` plus a 10-second `LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT` watchdog to write `run.failed`, avoiding the WebUI waiting indefinitely. |
| Service exit | HTTP graceful shutdown after Ctrl+C | `cmd/gateway/main.go` controls exit and timeouts. |