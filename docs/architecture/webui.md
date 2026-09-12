# WebUI Architecture

## Positioning

WebUI is the browser-side console hosted by Gateway. It shares `crates/agent-ui` with the GUI, but does not directly execute Agents, local tools, or Tauri commands. All operations requiring local permissions are forwarded to the desktop via Gateway WebSocket/HTTP.

## Main Modules

| Module | Path | Responsibility |
|---|---|---|
| App shell | `crates/agent-gateway/web/src/App.tsx`, `web/src/app/GatewayApp.tsx` | `App` handles login and startup; `GatewayApp` handles the socket, settings/history/chat state, and data assembly for the shared UI. |
| Socket client | `web/src/lib/gatewaySocket.ts` | v2 WebSocket (Protobuf frames) request/response, broadcast listening, connection timeout, native Chat Runtime wake-up, Chat command ACK recovery, and error handling; the proto-generated code is located in `web/src/lib/proto/gen/`. |
| Conversation stream | `web/src/lib/chat/stream/conversationStreamClient.ts` | Per-conversation persistent subscription registry: maintains `after_seq`/`stream_epoch` cursors, auto-resubscribe on reconnect, gap resync, and bounded backoff retries. |
| Gateway types | `web/src/lib/gatewayTypes.ts` | Protocol types on the WebUI side. |
| Settings storage | `web/src/lib/webSettings.ts`, `web/src/lib/settings/*` | Browser-local settings cache, redacted provider snapshot, settings sync payload. |
| History sync | `web/src/lib/sidebar/webSidebarBackend.ts`, `web/src/lib/chat/chatHistory.ts`, `web/src/lib/historyParser.ts` | History summary/event sync, detail reading, and large-history worker parsing. |
| Transcript | `web/src/components/GatewayTranscript.tsx`, `web/src/pages/chat/*` | WebUI row model, streaming snapshot, and virtual list; shared visuals such as composer/header/message actions come from `agent-ui`. |
| Shared UI | `crates/agent-ui/src/*` | Settings shell, Hub, chat sidebar, project tools, and domain logic shared by GUI/WebUI. |
| Host capabilities | `web/src/agent-ui-adapters/*`, `web/src/shims/*` | Provide Gateway/browser implementations for the shared UI and isolate leftover Tauri compatibility entry points. |

## Connection and Authentication

| Stage | Behavior |
|---|---|
| token read | WebUI reads the token from browser storage, or the user enters it via LoginPage. |
| socket creation | `getGatewayWebSocketClient(token)` establishes a `/ws/v2` connection (Protobuf binary frames, subprotocol `liveagent.v2.pb`); the overall connection timeout is 10 seconds, authentication has a separate 15-second timeout, and a late close from an old connection will not affect the new one. |
| status subscription | Subscribes to Gateway status and shows Desktop Agent online/offline. |
| request/response | All requests carry an id; Gateway returns a payload or error with the same id. |
| Chat wake-up | User messages are first echoed optimistically and immediately, then `chat.prepare` is sent serially; Gateway truly wakes the desktop Chat Runtime via a correlated native Ping/Pong, and lets the immediately following command reuse a fresh probe within 2 seconds on the same Agent session, avoiding an extra native RTT on the normal path. The prepare request waits at most 2.5 seconds, falling back to `status.get` when an older Gateway does not support the method, with `chat.command` as the final fallback wake-up signal. |
| Chat stream | Submit/edit/cancel go through the WebSocket `chat.command`; ACK waits at most 4 seconds, and on connection interruption or lost ACK it retries exactly once, reusing the completely identical payload and `client_request_id`. Streaming output uses the per-conversation persistent subscription `chat.subscribe` (`chat.event` pushes, seq continuation). |
| Reconnect recovery | The WebSocket client handles ordinary synchronous reconnects; after the history snapshot is hydrated, the Chat subscription resends `chat.subscribe` with a monotonically increasing `after_seq` for the same conversation (together with `stream_epoch`) to fill missing events within the in-memory window across runs; a single subscription times out after 5 seconds, and on failure it self-recovers with 250ms, 500ms, 1s, 2s, 5s caps plus jitter. When observing a running remote conversation, prefer `history.list.running_conversations[].first_seq - 1` as the subscription start point for the current run. |

## WebUI Local State

| State | Source | Purpose |
|---|---|---|
| `token` | user input/localStorage | WebSocket and HTTP API authentication. |
| `settings` | Gateway `settings.get`, `settings.event`, local redacted cache | Render Settings, Chat mode, model list, MCP/Skills/Memory, etc. |
| `historyItems` | Gateway `history.list`, `history.event` | Sidebar, pin/share/delete/rename. |
| `visible transcript` | `history.get`, live chat events, local draft | Current conversation content. |
| `live stream cache` | Chat Command response, `chat.subscribe` replay and `chat.event` pushes | Keep running conversations visible while streaming. |
| `draft conversation` | WebUI local temporary id | Migrated to the real conversationId returned by the desktop after the new conversation is submitted. |
| upload cache | HTTP upload response | Attach the imported `ChatUploadedFile` to the next Chat Command. |

## Session Workbench

- WebUI and Desktop share `@liveagent/ui`'s PaneTree, geometry, drag transactions, terminal leases, and Surface shell.
- A conversation's stream, draft, attachments, queue, approvals, model, and trace state are all bucketed by `conversationId`; drop/paste reads the Pane's conversation marker at the event location, without relying on asynchronous focus switching.
- WebUI refresh always creates a single Root Pane for the current conversation and passes `persistence: false` to `useWindowWorkbench`, so the browser's previous multi-Pane layout is not restored.
- WebUI terminals are created through Gateway; explicitly dragging one in or creating one from the menu authorizes startup immediately. If a terminal Surface with no runtime binding is ever restored, the user must still confirm before a local or SSH session can be created.
- `VITE_LIVEAGENT_SESSION_WORKBENCH=0` falls back to the old single-Pane rendering path; it is enabled by default.

## Sharing and Separation from the GUI

| Dimension | Description |
|---|---|
| Visuals/interactions | Settings, Skills Hub, MCP Hub, Chat sidebar, AssistantBubble, etc. stay at parity with the GUI. |
| Source organization | Shared source lives in `crates/agent-ui`; WebUI keeps only application logic such as Gateway, login, remote state, and browser transport. `scripts/check-ui-boundaries.mjs` prevents the shared layer from depending on a specific app in reverse and forbids apps from keeping duplicate copies at the same path. |
| Capability differences | Settings registers pages via `UiExtensionRegistry`: WebUI has `devices` exclusively, while GUI has `shortcuts` and `about` exclusively. |
| Tauri API | WebUI points to shims via a Vite alias, keeping real Tauri dependencies out of the browser runtime. |
| Data channel | GUI uses Tauri invoke; WebUI uses Gateway WebSocket/HTTP. |
| Execution permissions | GUI can trigger local tools; WebUI can only request the desktop to execute on its behalf. |

## Main Gateway Methods Supported by WebUI

| Method family | Examples |
|---|---|
| Auth/status | `status.get`, socket auth/unauthorized handling |
| Chat | WS `chat.prepare`, `chat.command` (`chat.submit`/`chat.edit_resend`/`chat.cancel`), `chat.subscribe`/`chat.unsubscribe`, `chat.activities`; events are pushed via `chat.event`/`chat.command_update` |
| History | `history.list`, `history.get`, `history.rename`, `history.pin`, `history.share.get`, `history.share.set`, `history.delete` |
| Settings | `settings.get`, `settings.update` |
| Providers | `providers.list`, provider model scan related request |
| Skills | `skills.list`, `skills.manage`, `skills.read-metadata`, `skills.read-text` |
| MCP | MCP settings are updated via settings; runtime tools are executed by the desktop. |
| Cron | `cron.manage` |
| Memory | `memory.manage` |
| Files | File uploads go over HTTP `/api/files/import`; selecting a directory rebuilds and imports the directory tree, mounting it as a read-only workspace root for the current project, and the active root is shown in the File Tree. mentions/fs roots/list dirs go over Gateway request. |

## Provider Secret Handling

| Scenario | Handling |
|---|---|
| GUI -> Gateway settings sync | Provider API keys are redacted; only presence information such as `apiKeyConfigured` is synced. |
| Gateway -> WebUI | WebUI can only see a redacted snapshot. |
| WebUI saves an existing provider | When no new key is entered, empty/redacted values do not overwrite the real key in the GUI. |
| WebUI enters a new key | Sent one-way back to the GUI for update via `providerApiKeyUpdates`. |
| WebUI localStorage | Stores redacted provider settings, avoiding long-term storage of real secrets in the browser. |

## Important WebUI Limitations

| Limitation | Impact |
|---|---|
| Does not directly execute tools | Shell, FS, MCP, Memory mutation, and Cron prompts must all go back to the desktop. |
| Depends on Gateway being online | When Gateway or Desktop is offline, Chat/Settings/History capabilities are limited. |
| Shared boundaries | Changes to shared interactions modify only `crates/agent-ui`; application differences must stay in `@liveagent/adapters` or the extension registry. |
| Browser storage is not authoritative | The real source of Settings and history remains desktop SQLite and Gateway sync. |
| Gateway relay is not persistent history | `chat.subscribe` seq replay comes from a bounded event window inside the Gateway process; when Gateway restarts or the window resets, WebUI re-hydrates from the desktop history snapshot. |