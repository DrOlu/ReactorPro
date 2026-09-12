# Protocols and Sync Contracts

## Protocol Overview

Since v2, all real-time links in the gateway are unified under **WebSocket + Protobuf** (hereafter the v2 protocol).

| Channel | Endpoint | Direction | Purpose |
|---|---|---|---|
| **v2** WebSocket | `GET /ws/v2` | WebUI <-> Gateway | Main browser link: local operations + `GatewayEnvelope` passthrough requests + broadcast events. |
| **v2** WebSocket | `GET /ws/v2/agent` | Desktop <-> Gateway | Persistent bidirectional envelope stream for the desktop. |
| **v2** WebSocket | `GET /ws/v2/terminal` | Both ends <-> Gateway | Terminal-specific data plane (role distinguished by hello), carrying `TerminalStreamFrame` to avoid head-of-line blocking of terminal IO behind chat/settings/history. |
| HTTP API | `/api/status` | WebUI -> Gateway | Agent online status + `protocol_usage` (v2 usage counts). |
| HTTP upload | `/api/files/import` | WebUI -> Gateway -> Desktop | Upload readable files and import them into the desktop workspace. |
| Public HTTP | `/api/public/history-shares/{token}` | Browser -> Gateway | Public read-only history sharing. |

## v2 Unified Wire Protocol

Authoritative definition: `crates/agent-gateway/proto/v2/gateway_ws.proto` (frame shell); all business
messages reuse `proto/v2/gateway.proto` (`GatewayEnvelope`/`AgentEnvelope`/
`TerminalStreamFrame` etc. — single source of truth, from which all three ends Go/Rust/TS are generated).

### Transport and Handshake

- WebSocket subprotocol: `liveagent.v2.pb` (the server must echo it back).
- One WS binary message = one proto frame message, no length prefix; text frames are ignored on the v2 path.
- The first frame must be `ClientHello{protocol_version=2, role, token, ...}`; the server replies with
  `ServerHello{ok, session_id, heartbeat_period_seconds, max_message_bytes}`;
  authentication failure closes with close code 4401. The hello for the agent role also completes session registration.
- The message size limit is tightened per link and advertised via `ServerHello.max_message_bytes`: for `/ws/v2`
  the browser is 4 MiB, `/ws/v2/agent` follows `MaxMessageBytes` (default 64 MiB, needed for uploads),
  and `/ws/v2/terminal` is 1 MiB for browsers / 16 MiB for agents. Concurrent connection limits are
  agent 256 / browser 128 / terminal 512 (503 before the limit is raised); the browser link additionally has
  a per-connection in-flight dispatch limit of 16 and an inbound token bucket of 100 frames/s (burst 200).

### Browser Link (/ws/v2)

- Request frame `WebClientFrame{request_id, agent_id, oneof payload}`; response frames echo the same
  `request_id`; broadcast frames have an empty `request_id`.
- **Multi-Agent addressing**: targeted requests must explicitly carry a non-empty `agent_id`; when missing, the client receives
  `local_error: "agent_id is required"`. The official WebUI requests
  `agent_list` on first connection, automatically selects an online Agent and persists the choice, so single-Agent deployments need no
  manual operation; the `agent_id` of a broadcast frame marks the event source, and clients strictly filter out non-active Agents.
  `agent_list` returns the status directory of all registered Agents (including offline entries and entries with only issued credentials).
- **Passthrough request** `agent_request` (the browser directly constructs a `GatewayEnvelope` payload arm):
  the gateway validates it against the allowlist and quotas (`internal/protocol/pbws/guard.go`; feature gating is determined from the target Agent's settings snapshot),
  namespaces the `request_id` per connection, and forwards it nearly verbatim to the target desktop;
  the response is sent back as the original `AgentEnvelope` (the `agent_response` arm). The former ~90
  "JSON decode → manually assemble proto → manually unpack map" handlers are replaced by this single path.
- **Local frames** (gateway status answered/orchestrated directly): `status_get`, `chat_prepare`,
  `chat_command` (carrying `ChatCommandRequest`), `chat_subscribe`/
  `chat_unsubscribe`/`chat_activities`, `workspace_subscribe`/`workspace_unsubscribe`. Among these, `chat.subscribe` and `chat.unsubscribe` are likewise targeted operations and must carry a non-empty `agent_id`; conversation streams are isolated by `(agent_id, conversation_id)`, and `chat.activities` is a global directory query.
- **Broadcast arms**: `history_event`/`settings_event`/`terminal_event`/`sftp_event`/
  `chat_queue_event`/`tunnel_state`/`process_state`/`workspace_activity`
  are forwarded directly as session-layer seam messages; `status`/`chat_activity`/`chat_event`/
  `chat_command_update`/`chat_subscription_reset` are proto-ized payloads.
  chat event payloads remain dynamic JSON (`payload_json` bytes).
- **Local errors**: `local_error` (`ErrorResponse`).
- Heartbeat and backpressure: server WS control-frame ping + application-layer `PingFrame` dual channels; idle eviction
  at `3× heartbeat period + grace`; the write side uses a control-priority dual queue + droppable data frames + correlation response drop means
  disconnect (`internal/transport/wscore` connection runtime).

### Desktop Link (/ws/v2/agent)

After hello (role=AGENT) completes authentication and session registration, the connection enters a bidirectional envelope stream: the gateway sends downstream
`GatewayEnvelope` (requests + periodic Ping), and the desktop sends upstream `AgentEnvelope`
(responses/events/Pong); heartbeats use an independent channel unaffected by data congestion; transport-layer keepalive is handled by WS control-frame
ping/pong, and the client uses absence of inbound traffic for 3× the heartbeat period as the disconnect criterion.

**Multi-Agent**: the gateway maintains multiple coexisting Agent sessions keyed by `agent_id` (scale ≤10),
reconnecting with the same `agent_id` only evicts the old connection for that id, and different Agents do not affect each other. Snapshots
(settings/terminal/prompt queue/managed processes) and broadcast events are isolated per Agent, and tunnel frames reject
cross-Agent `stream_id` forgery. Each desktop automatically generates and persists a canonical
`agent-UUIDv4` when settings are first initialized; the settings page displays this identifier read-only, without relying on hostname or manual user naming.

### Agent Authentication (Independent Credentials per Agent)

The gateway by default automatically creates an embedded SQLite database (the path can be specified with `-agent-db` or
`LIVEAGENT_GATEWAY_AGENT_DB`) and enables per-Agent credential storage:

- The Agent link accepts either the gateway Token or an independent credential issued for a given `agent_id` (`agt_` prefix);
- An independent Agent credential only authorizes the bound Agent link; it cannot impersonate a browser or call REST; the gateway Token
  authorizes the browser, the admin API, and the Agent link at the same time;
- A credential can be used continuously for the corresponding Agent connection, but the plaintext is shown only once in the issuance response, and only the
  SHA-256 hash is stored on disk (SQLite file permission 0600);
- Admin API (gated by admin token): `GET /api/agents` directory,
  `POST /api/agents/{id}/token` issues/rotates and sets an optional name; rotation immediately disconnects the current Agent
  session, makes the old credential unable to reconnect,
  `PATCH /api/agents/{id}` changes or clears the name, `DELETE /api/agents/{id}` deletes the entire record and
  credential and immediately disconnects that Agent's active sessions.

The first version of the Gateway database's Agent structure is a single table `agents`. The `agent_id` primary key serves credential point lookups,
name updates, and deletion; the composite index `(created_at, agent_id)` serves database-layer directory pagination.

Gateway Tokens and independent Agent credentials can coexist: clients using the gateway Token must provide a stable
`agent_id`, while clients using independent credentials are additionally subject to `agent_id` binding validation.

### Terminal Link (/ws/v2/terminal)

Both ends share one path, and hello.role distinguishes browser/desktop; after hello, both directions carry
`TerminalStreamFrame` (proto passthrough). The browser role binds the target Agent of the data plane via `hello.agent_id`;
`agent_id` is required; outbound traffic is routed by binding, and inbound traffic only allows frames from the same source.
attach/detach maintain this connection's subscription set; input/resize require an existing attachment; output is delivered only to
attached connections; the desktop-side readiness signal is carried by `ServerHello`.

## Chat Protocol

| Stage | WebUI -> Gateway | Gateway -> Desktop | Desktop -> Gateway -> WebUI |
|---|---|---|---|
| Wake | `chat_prepare` | `PingRequest{request_id=chat-runtime-wake-*}` | Rust emits a WebView wake, reliably returning the correlated `PongResponse`; the Gateway responds with the current status after completing the real native round trip. |
| Submit | `chat_command`, `type=chat.submit` | `ChatCommandRequest{type=chat.submit}` | `chat_accepted` carries `run_id`/`accepted_seq`; user messages and token events are pushed via conversation subscription `chat_event`. |
| Edit resend | `chat_command`, `type=chat.edit_resend` | `ChatCommandRequest{type=chat.edit_resend, base_message_ref}` | The Gateway first publishes `rebased` and the new user message event, then the desktop atomically truncates and runs the new turn. |
| Resume | `chat_subscribe`, `{conversation_id, after_seq, stream_epoch}` | None | The WebUI first hydrates with a history snapshot/projection; the subscription response replays missing events across runs from the Gateway in-process event window by conversation seq (`events_json`/`latest_seq`/`reset`); returns reset when the epoch changes or the window is insufficient. When the subscription buffer overflows, the Gateway sends `chat_subscription_reset`, and the client resubscribes from its cursor. |
| Cancel | `chat_command`, `type=chat.cancel` | `ChatCommandRequest{type=chat.cancel}` | The Gateway sets the `cancelling` state; the desktop's real terminal state takes priority, and a timeout falls back to the watchdog emitting `run_finished(cancelled)`. |
| Complete | None | None | `ChatEvent.type=DONE` is mapped to the `run.completed` terminal state. |

The desktop still expresses low-level events such as `TOKEN`, `THINKING`, `TOOL_CALL`, `TOOL_RESULT`, `DONE`, `ERROR`, `TOOL_STATUS`, `HOSTED_SEARCH` via `ChatEvent`. The Gateway uniformly attaches an externally visible monotonically increasing `seq` within the same conversation, and normalizes control events into WebUI events such as `run.accepted`, `user.message.appended`, `conversation.rebased`, `projection.updated`, `run.completed`, `run.failed`, `run.cancelled`. Command orchestration logic (deduplication, liveness probing, acceptance receipts, starting watchdogs) is consolidated in `internal/chatcmd`.

The WebUI uses a 4-second cap for command ACKs. When the connection drops or an ACK is lost, it retries only once, reusing exactly the same payload and `client_request_id`; the Gateway returns the canonical run atomically within the same process, so it never double-seeds or double-dispatches. The probe freshness of a successful prepare is bound to the Agent session epoch and retained for 2 seconds, so it can be reused directly by an immediately following command, avoiding a duplicate native RTT on the normal path; `chat_accepted` and `chat_prepare` responses go through the WebSocket control-priority queue to avoid head-of-line blocking behind token data frames.

## Settings Sync

| Operation | Direction | Semantics |
|---|---|---|
| `SettingsGetRequest` (passthrough) | WebUI -> Gateway -> Desktop | Read the desktop's current settings snapshot. |
| `SettingsUpdateRequest` (passthrough) | WebUI -> Gateway -> Desktop | Update settings; provider secrets use a separate `providerApiKeyUpdates`. |
| `settings_event` / `SettingsSyncEvent` | Desktop -> Gateway -> WebUI | After a local GUI save, broadcast a redacted settings snapshot (`settings_json` is parsed by the client). |

The key constraint of the settings protocol is that provider API keys do not go through the ordinary sync snapshot. The WebUI can only see redacted provider data and the `apiKeyConfigured` status.

## History Sync

| Operation | Semantics |
|---|---|
| `HistoryListRequest` | Paginated reading of conversation summaries for the sidebar; the gateway clamps pagination (page defaults to 1, page_size defaults to 80 with a cap of 200). |
| `HistoryGetRequest` | Read conversation detail; supports `max_messages` to return a tail window. |
| `HistoryRenameRequest` | Change the title and broadcast an upsert event. |
| `HistoryPinRequest` | Change the pinned status while preserving ordering. |
| `HistoryShareGet/SetRequest` | Manage public share tokens and redaction options. |
| `HistoryDeleteRequest` | Delete the conversation and related FTS/share rows. |
| Edit-resend truncation | No longer exposes an independent WebUI history command; it is handled on the desktop by `chat.edit_resend` and synchronized to the view via `conversation.rebased`/`projection.updated`. |

The desktop is the source of truth for the history database; the Gateway handles request forwarding and sync event broadcasting; the WebUI handles local list and transcript state updates.

## Upload Protocol

| Step | Description |
|---|---|
| 1 | The WebUI POSTs the file via multipart to `/api/files/import`. |
| 2 | The Gateway reads the file bytes, registers a request stream, and converts it into `UploadReadableFilesRequest` sent to the Desktop. |
| 3 | The Desktop writes the file into the app upload staging area `~/.liveagent/uploads/<batch>/` (outside the workspace), returning a `ChatUploadedFile` list and a skipped list. |
| 4 | The WebUI attaches the returned uploaded files to the next Chat Command. |

Local GUI upload does not need HTTP/Gateway and is imported directly via a Tauri command. The upload arm is not in the
`agent_request` passthrough allowlist (large files are better served by HTTP multipart).

## Public Share Error Codes

`/api/public/history-shares/{token}` still forwards through the Gateway to the desktop to resolve the share token. After the desktop returns `ErrorResponse.code`, the Gateway HTTP maps the status directly by code:

| code | HTTP | Scenario |
|---:|---:|---|
| `400` | Bad Request | The share token is empty or the request is invalid. |
| `404` | Not Found | The share link does not exist, has been closed, or the corresponding history conversation does not exist. |
| Other | Bad Gateway | The desktop failed to process or returned an unknown error. |

The Gateway no longer infers public share status from error text; error semantics are produced by the desktop and transmitted via proto.

## Terminal Stream Protocol

The terminal is an independent stream model. The main link (passthrough `TerminalRequest` on `/ws/v2`) only carries
session list/create/close/rename, SSH prompt, SSH tabs, and other control-plane and metadata
sync; the high-frequency `attach/input/resize/output/detach` go over the `/ws/v2/terminal` data plane.

| Layer | Contract |
|---|---|
| Browser-Gateway | `GET /ws/v2/terminal` first frame `ClientHello{role=BROWSER}`; afterwards `TerminalClientFrame{frame}` / `TerminalServerFrame{frame}` carry the proto `TerminalStreamFrame` in both directions. |
| Frame fields | `kind` is `attach/input/resize/detach/output/snapshot/error`; includes `stream_id/session_id/project_path_key/seq/start_offset/end_offset/cols/rows/max_bytes/truncated/error/data`. |
| Desktop-Gateway | `GET /ws/v2/terminal` first frame `ClientHello{role=AGENT}`, after which it carries `TerminalStreamFrame`; the main link does not carry terminal output/input/resize. |
| Snapshot | attach returns a `snapshot` frame, data is the tail bytes, and `start_offset/end_offset` are used by the frontend for deduplication. |
| Input | input frames are fire-and-forget bytes; they do not return session metadata and do not enter the ordinary request pending map. |
| Resize | resize frames send only the latest cols/rows; they do not return session metadata. |
| Output | output frames carry only the lightweight session id, project key, offset, and bytes; React session state is not updated by output. |
| Page stream client | Each page maintains one terminal stream per token, and upstream reuses attach per session; multiple handles for the same session share output. |

The Gateway's terminal connection only maintains the set of session attachments within this connection; detach only affects output delivery on this terminal stream and does not change the desktop terminal registry.

## Workspace Activity Protocol

The Git panel and file tree no longer poll: the desktop `workspace_watch` service (notify watcher, 250ms debounce, `.git` internal noise filtering, changedPaths capped at 64 + truncated) emits an invalidation signal for each watched workdir.

| Layer | Contract |
|---|---|
| Inside Desktop | Tauri event `workspace:activity`, payload `{workdir, revision, fs, git, changedPaths, truncated}`; the frontend declaratively registers this webview's watch set via `workspace_watch_set(workdirs)`. |
| Desktop→Gateway | `AgentEnvelope.workspace_activity` (`WorkspaceActivityEvent`, field 90). Gateway→Desktop uses `GatewayEnvelope.workspace_watch` (`WorkspaceWatchRequest`, declaratively the full workdir set; resent when the subscription count changes or the agent reconnects). |
| Browser-Gateway | `/ws/v2` frame `workspace_subscribe/workspace_unsubscribe {workdir}`, event arm `workspace_activity`. |
| Semantics | best-effort invalidation signal, not guaranteed lossless: the client must mark itself dirty and refetch on (re)subscription, channel rebuild, and revision rollback. revision is a per-workdir monotonic counter (within the agent process). |
| Consumer | `crates/agent-ui/src/lib/workspace-activity/useWorkspaceInvalidation.ts` is the shared implementation; each end provides its own `WorkspaceActivityClient`: when the panel is hidden it only marks dirty, and flushes on activation; the data itself still goes through the existing fs/git fetch commands (invalidate-push + fetch-on-demand). |

## Skills and Memory Management Protocol

| Capability | Passthrough request arm | Desktop destination |
|---|---|---|
| Skills listing and management | `SkillFilesListRequest`, `SkillManageRequest`, `SkillMetadataReadRequest`, `SkillTextReadRequest` | `system_ensure_builtin_skills`, `system_manage_skill`, `system_read_skill_*`, `commands/app/system.rs`, `services/skills/*` |
| Memory management | `MemoryManageRequest` | `commands/integration/memory.rs`, `services/memory/*` |
| Cron management | `CronManageRequest` | `commands/automation/cron.rs`, `services/automation/*`, settings cron table |

## Recovery and Deduplication Mechanisms

| Mechanism | Location | Purpose |
|---|---|---|
| `clientRequestId` | WebUI Chat Command -> Gateway session manager | Process-level 24-hour idempotency key; concurrent or single ACK-recovery retries return the same canonical run. Not retained after a Gateway restart. |
| `conversationId` -> run index | Gateway session manager | Locate the currently running event stream after a refresh/switch of the conversation. |
| `Seq` | Gateway in-process conversation event window / `chat_event` payload | Monotonically increasing within the same conversation; after a disconnect, `chat_subscribe` carries an `after_seq` cursor to replay missing events within the window, and resets + hydrates history when the window is insufficient. |
| Passthrough correlation id namespace | Gateway v2 relay | Multiple tabs share one desktop; the gateway prefixes forwarded `request_id`s per connection and strips the prefix on the return path, eliminating cross-connection conflicts. |
| done retention | Gateway session manager | Finished runs are retained briefly so the terminal state is visible after a refresh. |
| local running ids | WebUI App | Prevent a running conversation from being switched or deleted by mistake. |

## Protocol Change Notes

| Scenario | Must-check points |
|---|---|
| Adding a Gateway request | Add request/response arms in `proto/v2/gateway.proto` (numbers only increase, never change) → `buf generate` → allowlist it in the v2 passthrough (`internal/protocol/pbws/guard.go`) → WebUI client method + adapter; add a branch in the desktop `envelope_handler.rs`. Hand-written Go payload shaping is no longer needed. |
| Adding a local/orchestration operation | Add a frame arm in `proto/v2/gateway_ws.proto` → pbws local handler → client method. |
| proto evolution discipline | CI `buf breaking` (WIRE_JSON) gates this; use `reserved` for deleted fields; v2 business messages never renumber and are never deprecated. |
| Adding a settings field | GUI settings normalize/storage, Rust settings save/load, Gateway redaction whitelist, and WebUI settings copy must all be synchronized. |
| Adding a history field | Rust summary model, proto `ConversationSummary`, and GUI/WebUI sidebar render must all be synchronized. |
| Adding a chat event | Desktop event publisher, proto enum, Gateway event normalization and `chat_event` payload, and WebUI event reducer/transcript must all be synchronized. |
| Involving secrets | By default they do not enter the ordinary sync; a one-way or explicit update channel must be designed. |