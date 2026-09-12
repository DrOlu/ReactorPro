# Composer Prompt Clarification · Plan 2: Web (agent-gateway) Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `ChatComposerBar` clarify button usable on the Web side (`crates/agent-gateway/web`)—clicking it forwards a request via the gateway RPC `clarify.prompt_turn` to the desktop agent to execute a plain-text completion, producing an optimized prompt that is written back into the input box.

**Architecture:** Browser WS → gateway (`browserConn.handleAgentRequest` direct passthrough forwarding + `vetAgentRequest` allowlist) → desktop Rust `envelope_handler` → new unary bridge (oneshot pending + emit event) → desktop TS runtime (reusing the clarify execution logic `streamAssistantMessage` from GUI Plan 1) → return the text. The Web host `GatewayAppView` reuses `agent-ui`'s `ChatComposerBar` and only needs to inject the two props `runClarifyTurn` / `clarifyContext`—the clarify button/panel/state machine all take effect automatically. The request carries the model currently selected on the Web side (provider_id + model + runtime_controls), and the desktop side constructs the provider runtime accordingly.

**Tech Stack:** protobuf (`proto/v2/gateway.proto`), Go (`internal/protocol/pbws/guard.go`), Rust (`services/gateway/`), TypeScript (`crates/agent-gui/src/pages/chat/gateway/` + `crates/agent-gateway/web/src/lib/gatewaySocketV2/`).

**Spec:** `docs/superpowers/specs/2026-08-30-composer-clarify-design.md`

## Global Constraints

- Final-draft protocol markers: `[CLARIFY_QUESTION]` / `[CLARIFY_FINAL]` on a single line at the start of the reply—**the Web host reuses `clarifyProtocol.ts` verbatim and does not create a new protocol** (spec implementation-deviation note).
- The clarification turn is returned as a whole segment, no streaming needed (spec "Web Host" section: the server executes one text completion and returns it as a whole segment).
- The model is the primary model selected in the Web's current session (`activeSelectedModel` + `currentChatProvider` + `chatRuntimeControlsForCurrentProvider`), passed to the desktop side via RPC.
- When there is no model configuration the button is hidden (consistent with the GUI; spec implementation-deviation note "decide uniformly when wiring the Web" → decided hidden).
- Clarification sessions are not persisted and do not enter session history; closing the panel discards them.
- i18n reuses agent-ui's `LocaleContext` + `chat.clarify.*` keys (the Web already imports `t as translate`), with no new keys needed.
- After modifying proto, generate for both ends: Go via `buf generate`, desktop Rust via build.rs prost-build (automatic on `cargo build`).
- Tests: Web RPC aligns with the existing envelope pattern in `crates/agent-gateway/test/webui/gateway-socket-client.test.mjs`; Go allowlist tests align with `guard_test.go`.
- Code comment style follows the surrounding code: Chinese comments, explaining "why".

## Existing Code Facts (Required Reading for Implementers)

- **Web→gateway passthrough**: `browserConn.handleAgentRequest` (`crates/agent-gateway/internal/protocol/pbws/browser_relay.go:17`) allowlist validation (`vetAgentRequest`, `guard.go:24`) → request_id namespacing → `sm.AwaitUnaryResponse` → restore and return. The payload proto passes through directly; the gateway does not parse business fields.
- **gateway→desktop**: `connection.rs` dispatcher → `envelope_handler.rs:28 handle_gateway_envelope` big match. Each arm pattern: `Some(proto::gateway_envelope::Payload::X(req)) => { let r = gateway_bridge::handle_x(req).await; self.send_agent_envelope(payload: Some(Payload::XResp(r))).await }`.
- **Rust→TS unary bridge template**: `chat.rs:258 handle_chat_queue_request`—push a oneshot channel into the pending map → `app_handle.emit("gateway:chat-queue-request", event)` → `tokio::time::timeout(30s, rx)` → `send_agent_envelope`. On the TS side, `respond_chat_queue_request` (`chat.rs:340`) receives the invoke callback → pending tx send. **clarify copies this pattern.**
- **TS-side chat execution**: `useGatewayBridgeListeners.ts:349 handleGatewayChatRequest` (inbox queue + claim lease, designed for chat command, high complexity). clarify does not need this—an **independent lightweight unary bridge** that listens for the new event and executes directly.
- **GUI clarify executor**: `createGuiClarifyRunner` (`crates/agent-gui/src/pages/chat/runtime/clarifyRunner.ts:78`) receives `getSelection` (`resolveEffectiveChatModelSelection`) and `getRuntime` (`createProviderRuntimeConfig(provider, model, chatRuntimeControls)`). ChatPage.tsx:2086 `getConversationClarifyRunner` shows the complete construction.
- **Web RPC client**: `gatewaySocketRpc.ts`'s `GatewayWebSocketRpcClient`, `this.request<T>("rpc.name", payload)` (`gatewaySocketTransport.ts:860`). `clarify.prompt_turn` is not in `AGENT_ID_OPTIONAL_REQUEST_TYPES` (`gatewaySocketShared.ts:891`, only `agent.list`/`chat.activities`) → it automatically requires an agent id, with no changes needed.
- **adapters mapping**: `agentRequestPayload(type, body)` (`gatewaySocketV2/adapters.ts:388`) maps the string type to a `GatewayEnvelope` typed oneof payload.
- **Web model state**: `useGatewayChatConfiguration` (`web/src/app/hooks/useGatewayChatConfiguration.ts:40`)—`activeSelectedModel{customProviderId, model}`, `currentChatProvider` (including `type`/`requestFormat`), `chatRuntimeControlsForCurrentProvider`. The injection point is `GatewayAppView.tsx:754 <ChatComposerBar>`.
- **proto generation**: Go's `internal/proto/v2/gateway.pb.go` is generated by `buf generate` (`buf.yaml`); the desktop's `src-tauri/build.rs:42` prost-build compiles `agent-gateway/proto/v2/gateway.proto` (automatic on cargo build).
- **proto field numbers**: `GatewayEnvelope` oneof is already at 100 (`installed_apps_list`); `AgentEnvelope` oneof is already at 105 (`installed_apps_list_resp`). Use 101 / 106 for the new fields.

---

### Task 1: proto Definition + Dual-End Generation

**Files:**
- Modify: `crates/agent-gateway/proto/v2/gateway.proto`
- Generated artifacts (do not edit by hand): `crates/agent-gateway/internal/proto/v2/gateway.pb.go`, desktop `src-tauri/src/proto/*.rs` (automatic via cargo)

**Interfaces:**
- Consumes: none.
- Produces (exact types that subsequent tasks depend on):
  - `ClarifyTurnRequest { messages_json: string; provider_id: string; model: string; request_format: string; runtime_controls: ChatRuntimeControls; workdir: string; git_branch: string }`
  - `ClarifyTurnResponse { final_text: string; error_code: string; error_message: string }`
  - `GatewayEnvelope.clarify_turn` (oneof field, number 101)
  - `AgentEnvelope.clarify_turn_resp` (oneof field, number 106; 105 is already taken by `installed_apps_list_resp`)

- [ ] **Step 1: Append the message definitions to gateway.proto**

In `proto/v2/gateway.proto`, append after `ChatRuntimeControls` (line 163):

```proto
// Clarify turn (Web Plan 2): a single plain-text completion forwarded from the browser
// through the gateway to the desktop agent. messages uses a JSON string (ClarifyMessage[],
// see agent-ui clarifyTypes) to avoid introducing a new first-class message type for
// clarification sessions; provider/model/runtime are sent down by the Web's current
// selection, and the desktop side constructs the provider runtime accordingly.
message ClarifyTurnRequest {
  string messages_json = 1;
  string provider_id = 2;
  string model = 3;
  string request_format = 4;
  ChatRuntimeControls runtime_controls = 5;
  string workdir = 6;
  string git_branch = 7;
}

message ClarifyTurnResponse {
  string final_text = 1;
  string error_code = 2;
  string error_message = 3;
}
```

- [ ] **Step 2: Add oneof fields to GatewayEnvelope / AgentEnvelope**

`GatewayEnvelope`'s oneof payload (starting at line 14, after the final `installed_apps_list = 100;`):

```proto
    ClarifyTurnRequest clarify_turn = 101;
```

`AgentEnvelope`'s oneof payload (starting at line 81, after the final `trajectory_fetch_resp = 104;`):

```proto
    ClarifyTurnResponse clarify_turn_resp = 106;
```

- [ ] **Step 3: Regenerate proto on the Go side**

Run: `cd crates/agent-gateway && buf generate`
Expected: `internal/proto/v2/gateway.pb.go` is updated and `GatewayEnvelope_ClarifyTurn` and `AgentEnvelope_ClarifyTurnResp` appear.

- [ ] **Step 4: Automatic Rust generation on the desktop side**

Run: `cd crates/agent-gui/src-tauri && cargo check`
Expected: compilation succeeds and `src-tauri/src/proto/gateway.rs` (generated in OUT_DIR) contains `clarify_turn`-related types. If the Rust-side proto module exposure differs from expectation (`cargo check` reports missing fields), locate the generated path from the errors—build.rs already has rerun-if-changed, so no manual trigger is needed.

- [ ] **Step 5: Commit**

```bash
git add crates/agent-gateway/proto/v2/gateway.proto crates/agent-gateway/internal/proto/v2/gateway.pb.go
git commit -m "feat(clarify): add ClarifyTurnRequest/Response proto for web phase 2"
```

---

### Task 2: Go Allowlist Passthrough

**Files:**
- Modify: `crates/agent-gateway/internal/protocol/pbws/guard.go:72`
- Test: `crates/agent-gateway/internal/protocol/pbws/guard_test.go`

**Interfaces:**
- Consumes: `GatewayEnvelope_ClarifyTurn` (Task 1).
- Produces: none (allowlist admission; forwarding is handled by the existing logic in `browser_relay.go`).

- [ ] **Step 1: Write a failing test**

Append to `guard_test.go` (aligning with the file's existing `TestVetAgentRequest*` style; read the file header first to confirm the test helper functions):

```go
func TestVetAgentRequestAllowsClarifyTurn(t *testing.T) {
	sm := &fakeAgentView{} // align with the existing fake/mock in this file
	err := vetAgentRequest(sm, &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_ClarifyTurn{
			ClarifyTurn: &gatewayv2.ClarifyTurnRequest{
				MessagesJson: `[{"role":"user","content":"hi"}]`,
				ProviderId:   "builtin-gemini",
				Model:        "gemini-2.0-flash",
			},
		},
	})
	if err != nil {
		t.Fatalf("clarify_turn should be passthrough, got %v", err)
	}
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd crates/agent-gateway && go test ./internal/protocol/pbws/ -run TestVetAgentRequestAllowsClarifyTurn -v`
Expected: FAIL, `unsupported agent_request payload`.

- [ ] **Step 3: Add a passthrough arm to the allowlist**

In the normal passthrough arm case list of `guard.go:72` (after `*gatewayv2.GatewayEnvelope_ChatQueue:`), append:

```go
		// Clarify turn: a single plain-text completion; the payload is forwarded to the
		// desktop side for execution, with no gateway-side gating.
		*gatewayv2.GatewayEnvelope_ClarifyTurn,
```

Note: append it into the **existing case group that `return nil`**, not as a new standalone case (same group as the other normal passthrough arms).

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd crates/agent-gateway && go test ./internal/protocol/pbws/`
Expected: PASS (the new test + all existing tests green).

- [ ] **Step 5: Commit**

```bash
git add crates/agent-gateway/internal/protocol/pbws/guard.go crates/agent-gateway/internal/protocol/pbws/guard_test.go
git commit -m "feat(clarify): allow clarify_turn passthrough in gateway vet"
```

---

### Task 3: Desktop Rust unary Bridge

**Files:**
- Create: `crates/agent-gui/src-tauri/src/services/gateway/clarify.rs`
- Modify: `crates/agent-gui/src-tauri/src/services/gateway/mod.rs`
- Modify: `crates/agent-gui/src-tauri/src/services/gateway/envelope_handler.rs`
- Modify: `crates/agent-gui/src-tauri/src/lib.rs` (invoke registration)

**Interfaces:**
- Consumes: `gateway_envelope::Payload::ClarifyTurn` / `agent_envelope::Payload::ClarifyTurnResp` (Task 1).
- Produces (depended on by Task 4):
  - Event name constant `"gateway:clarify-turn-requested"`, payload `GatewayClarifyTurnRequestEvent { request_id, messages_json, provider_id, model, request_format, runtime_controls_json, workdir, git_branch }`
  - invoke command `gateway_clarify_respond`: parameters `{ request_id, final_text?, error_code?, error_message? }`
  - `GatewayClarifyRespondInput` type (Rust, structured response: success final_text / failure error_*)

- [ ] **Step 1: Create clarify.rs (copy the template from chat.rs's handle_chat_queue_request)**

First read `chat.rs:258-345` (handle_chat_queue_request + respond_chat_queue_request + send_chat_queue_response) and `mod.rs:110-130` (`pending_chat_queue_requests` field declaration, `GatewayChatQueueRequestEvent` struct, `GatewayChatQueueResponseInput`), confirm the imports and self field usage for `oneshot`, `now_unix_seconds`, and `send_agent_envelope`, then copy.

```rust
// services/gateway/clarify.rs
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::chat::now_unix_seconds; // if now_unix_seconds is in chat.rs; otherwise make it local or follow the repo's current state
use crate::proto::{agent_envelope, gateway_envelope};

pub(crate) const GATEWAY_CLARIFY_TURN_REQUESTED_EVENT: &str = "gateway:clarify-turn-requested";

/// Payload for the Rust → TS clarify turn event. runtime_controls is passed as a JSON string,
/// and the TS side parses it back into ChatRuntimeControls (reusing agent-ui's normalize logic).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayClarifyTurnRequestEvent {
    pub request_id: String,
    pub messages_json: String,
    pub provider_id: String,
    pub model: String,
    pub request_format: String,
    pub runtime_controls_json: String,
    pub workdir: String,
    pub git_branch: String,
}

/// The result returned by the TS side via the invoke gateway_clarify_respond.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayClarifyRespondInput {
    pub request_id: String,
    pub final_text: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl GatewayClarifyTurnRequestEvent {
    pub(crate) fn from_request(request_id: String, request: crate::proto::ClarifyTurnRequest) -> Self {
        Self {
            request_id,
            messages_json: request.messages_json,
            provider_id: request.provider_id,
            model: request.model,
            request_format: request.request_format,
            runtime_controls_json: request
                .runtime_controls
                .map(|rc| serde_json::to_string(&rc).unwrap_or_default())
                .unwrap_or_default(),
            workdir: request.workdir,
            git_branch: request.git_branch,
        }
    }
}

impl From<GatewayClarifyRespondInput> for crate::proto::ClarifyTurnResponse {
    fn from(input: GatewayClarifyRespondInput) -> Self {
        crate::proto::ClarifyTurnResponse {
            final_text: input.final_text.unwrap_or_default(),
            error_code: input.error_code.unwrap_or_default(),
            error_message: input.error_message.unwrap_or_default(),
        }
    }
}
```

- [ ] **Step 2: Implement handle_clarify_turn + respond_clarify_turn + send response**

Append to `clarify.rs` (use the same lock container as `pending_chat_queue_requests` for the pending map, and add the field declaration to `GatewayController`):

```rust
impl GatewayController {
    pub(crate) async fn handle_clarify_turn(
        self: &Arc<Self>,
        request_id: String,
        request: crate::proto::ClarifyTurnRequest,
    ) -> Result<(), String> {
        let event_payload = GatewayClarifyTurnRequestEvent::from_request(request_id.clone(), request);

        let (tx, rx) = oneshot::channel();
        self.pending_clarify_turns
            .lock()
            .map_err(|_| "gateway clarify turn lock poisoned".to_string())?
            .insert(request_id.clone(), tx);

        if let Err(error) = self
            .app_handle
            .emit(GATEWAY_CLARIFY_TURN_REQUESTED_EVENT, event_payload)
        {
            let _ = self
                .pending_clarify_turns
                .lock()
                .map(|mut pending| pending.remove(&request_id));
            return self
                .send_clarify_turn_response(
                    request_id,
                    crate::proto::ClarifyTurnResponse {
                        final_text: String::new(),
                        error_code: "emit_failed".to_string(),
                        error_message: format!("emit gateway clarify turn failed: {error}"),
                    },
                )
                .await;
        }

        let response = match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => crate::proto::ClarifyTurnResponse {
                final_text: String::new(),
                error_code: "response_dropped".to_string(),
                error_message: "clarify turn response dropped".to_string(),
            },
            Err(_) => {
                let _ = self
                    .pending_clarify_turns
                    .lock()
                    .map(|mut pending| pending.remove(&request_id));
                crate::proto::ClarifyTurnResponse {
                    final_text: String::new(),
                    error_code: "timeout".to_string(),
                    error_message: "clarify turn timed out".to_string(),
                }
            }
        };

        self.send_clarify_turn_response(request_id, response).await
    }

    pub(crate) async fn send_clarify_turn_response(
        &self,
        request_id: String,
        response: crate::proto::ClarifyTurnResponse,
    ) -> Result<(), String> {
        self.send_agent_envelope(crate::proto::AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(agent_envelope::Payload::ClarifyTurnResp(response)),
        })
        .await
    }

    pub(crate) fn respond_clarify_turn(
        &self,
        input: GatewayClarifyRespondInput,
    ) -> Result<(), String> {
        let Some(tx) = self
            .pending_clarify_turns
            .lock()
            .map_err(|_| "gateway clarify turn lock poisoned".to_string())?
            .remove(&input.request_id)
        else {
            return Ok(()); // Already timed out / already removed: silently drop the late response.
        };
        tx.send(crate::proto::ClarifyTurnResponse::from(input))
            .map_err(|_| "gateway clarify turn response receiver dropped".to_string())
    }
}
```

- [ ] **Step 3: Register the field + mod + envelope_handler arm**

`mod.rs`:
- `pub(crate) mod clarify;` (module declaration, including re-exports of `GatewayClarifyTurnRequestEvent`/`GatewayClarifyRespondInput` for use by commands)
- Add a field to `GatewayController`:

```rust
    pub(crate) pending_clarify_turns:
        std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<crate::proto::ClarifyTurnResponse>>>,
```

Initialize it alongside the existing `pending_chat_queue_requests` field initialization.

Add to the match in `envelope_handler.rs` (aligning with the `ChatQueue` arm style, see lines 85-90):

```rust
            Some(proto::gateway_envelope::Payload::ClarifyTurn(request)) => {
                if let Err(error) = self.handle_clarify_turn(request_id, request).await {
                    eprintln!("handle clarify turn failed: {error}");
                }
            }
```

- [ ] **Step 4: Register the invoke in lib.rs**

In the `invoke_handler` list in `lib.rs` (refer to where `gateway_chat_claim_next` / `gateway_chat_queue_respond` are registered), add:

```rust
            commands::gateway::clarify_respond,
```

In `commands/gateway.rs` (or the existing gateway commands module), add the new command:

```rust
#[tauri::command]
pub(crate) fn clarify_respond(
    state: tauri::State<'_, Arc<crate::services::gateway::GatewayController>>,
    input: crate::services::gateway::clarify::GatewayClarifyRespondInput,
) -> Result<(), String> {
    state.respond_clarify_turn(input)
}
```

First read the existing `chat_queue_respond` (or similarly named) command in `commands/gateway.rs` and align the `#[tauri::command]` State acquisition and return style.

- [ ] **Step 5: Compilation verification**

Run: `cd crates/agent-gui/src-tauri && cargo check`
Expected: compilation succeeds. If the `GatewayController` fields / `commands/gateway.rs` structure differ, adjust per the errors—semantics unchanged.

- [ ] **Step 6: Commit**

```bash
git add crates/agent-gui/src-tauri/src/services/gateway/ crates/agent-gui/src-tauri/src/lib.rs
git commit -m "feat(clarify): desktop gateway unary bridge for clarify turns"
```

---

### Task 4: Desktop TS bridge + ChatPage Executor Injection

**Files:**
- Modify: `crates/agent-gui/src/pages/chat/gateway/useGatewayBridgeListeners.ts`
- Modify: `crates/agent-gui/src/pages/chat/gateway/gatewayBridgeTypes.ts` (or whichever file holds the event types; grep `GatewayChatQueueRequestEvent` to locate it first)
- Modify: `crates/agent-gui/src/pages/ChatPage.tsx`

**Interfaces:**
- Consumes: event `gateway:clarify-turn-requested`, invoke `gateway_clarify_respond` (Task 3); `createGuiClarifyRunner` (clarifyRunner.ts:78); `createProviderRuntimeConfig` (lib/providers/llm.ts); `ClarifyMessage` / `RunClarifyTurn` (agent-ui clarifyTypes).
- Produces: none (terminal executor).

- [ ] **Step 1: Type definitions**

The event type file (grep to locate the TS definition of `GatewayChatQueueRequestEvent`; append in the same file):

```ts
export interface GatewayClarifyTurnRequestEvent {
  request_id: string;
  messages_json: string;
  provider_id: string;
  model: string;
  request_format: string;
  runtime_controls_json: string;
  workdir: string;
  git_branch: string;
}

export interface GatewayClarifyRespondInput {
  request_id: string;
  final_text?: string;
  error_code?: string;
  error_message?: string;
}
```

- [ ] **Step 2: Add the executor method to params**

Add an injected method to `UseGatewayBridgeListenersParams` in `useGatewayBridgeListeners.ts` (provided by ChatPage, see Step 4):

```ts
  /** Execute one clarification completion (model selection sent down by the Web). Returns the assistant's full text. */
  runGatewayClarifyTurn: (
    messages: ClarifyMessage[],
    selection: {
      providerId: string;
      providerType: string;
      model: string;
      requestFormat: string;
    },
    runtimeControls: ChatRuntimeControls,
  ) => Promise<string>;
```

- [ ] **Step 3: Listen for the event + execute + return the result**

In `useGatewayBridgeListeners.ts` (aligning with the registration style of `listen<GatewayChatRequestReadyEvent>("gateway:chat-request-ready", ...)`, around line 618):

```ts
    const handleClarifyTurnRequested = async (
      event: GatewayClarifyTurnRequestEvent,
    ) => {
      const { request_id } = event;
      let final_text = "";
      let error_code: string | undefined;
      let error_message: string | undefined;
      try {
        let messages: ClarifyMessage[];
        try {
          messages = JSON.parse(event.messages_json) as ClarifyMessage[];
        } catch {
          messages = [{ role: "user", content: event.messages_json }];
        }
        const runtimeControls = event.runtime_controls_json
          ? (JSON.parse(event.runtime_controls_json) as Partial<ChatRuntimeControls>)
          : undefined;
        final_text = await latestParamsRef.current.runGatewayClarifyTurn(
          messages,
          {
            providerId: event.provider_id,
            providerType: event.provider_id,
            model: event.model,
            requestFormat: event.request_format,
          },
          normalizeChatRuntimeControls(runtimeControls),
        );
      } catch (error) {
        error_code = "execution_error";
        error_message = error instanceof Error ? error.message : String(error);
      } finally {
        await invoke<unknown>("gateway_clarify_respond", {
          request_id,
          final_text: final_text || undefined,
          error_code,
          error_message,
        }).catch((error: unknown) => {
          console.warn("gateway_clarify_respond failed", error);
        });
      }
    };

    void listen<GatewayClarifyTurnRequestEvent>(
      "gateway:clarify-turn-requested",
      handleClarifyTurnRequested,
    ).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlistenClarifyTurnRequested = dispose;
    });
```

Declare the `disposed` / `unlisten*` variables following the file's existing pattern. `normalizeChatRuntimeControls` is already imported (line 6).

- [ ] **Step 4: Inject the executor in ChatPage**

`ChatPage.tsx`: add `runGatewayClarifyTurn` to the params passed to `useGatewayBridgeListeners`. The implementation constructs the provider runtime from the model selection sent down by the Web (aligning with `getConversationClarifyRunner`'s usage of `createProviderRuntimeConfig`, ChatPage.tsx:2096-2103):

```ts
      runGatewayClarifyTurn: async (messages, selection, runtimeControls) => {
        const provider = settings.providers.find(
          (p) => p.id === selection.providerId,
        );
        if (!provider) {
          throw new Error(`clarify provider not found: ${selection.providerId}`);
        }
        const runtime = createProviderRuntimeConfig(
          provider,
          selection.model,
          runtimeControls,
        );
        const assistant = await streamAssistantMessage({
          providerId: selection.providerId,
          model: selection.model,
          runtime,
          signal: new AbortController().signal,
          cacheRetention: "none",
          nativeWebSearch: false,
          context: buildClarifyCallContextFromJson(messages),
          onTextDelta: undefined,
        });
        return assistantMessageToText(assistant);
      },
```

`buildClarifyCallContextFromJson`: after parsing `messages_json`, reuse `clarifyRunner.ts`'s `buildClarifyCallContext` (merging `system` messages into `systemPrompt`, mapping user/assistant to `Context`). Export that internal function from `clarifyRunner.ts`, or inline the same logic in the new method (read clarifyRunner.ts:50-72 and copy). The field names of `settings.providers` follow the repository's actual types (provider `id`/`type`/`requestFormat`).

- [ ] **Step 5: Type check**

Run: `cd crates/agent-gui && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add crates/agent-gui/src/pages/chat/gateway/ crates/agent-gui/src/pages/ChatPage.tsx
git commit -m "feat(clarify): desktop TS bridge executes gateway clarify turns"
```

---

### Task 5: Web adapters + RPC Client + Tests

**Files:**
- Modify: `crates/agent-gateway/web/src/lib/gatewaySocketV2/adapters.ts`
- Modify: `crates/agent-gateway/web/src/lib/gatewaySocketRpc.ts`
- Test: `crates/agent-gateway/test/webui/gateway-socket-client.test.mjs`

**Interfaces:**
- Consumes: `ClarifyTurnRequest`/`ClarifyTurnResponse` proto (Task 1 artifacts, `web/src/lib/proto/gen/`).
- Produces (depended on by Task 6):
  - `GatewayWebSocketRpcClient.clarifyPromptTurn(input): Promise<{ final_text: string; error_code?: string; error_message?: string }>`
  - input: `{ messages: ClarifyMessage[]; providerId: string; model: string; requestFormat: string; runtimeControls?: ChatRuntimeControls; workdir: string; gitBranch?: string }`

- [ ] **Step 1: Add the type mapping to adapters**

At the end of the `agentRequestPayload` switch in `adapters.ts` (line 388) (after the `trajectory.fetch` case), add:

```ts
    case "clarify.prompt_turn":
      return {
        case: "clarifyTurn",
        value: create(ClarifyTurnRequestSchema, {
          messages_json: typeof body.messages === "string" ? body.messages : JSON.stringify(body.messages ?? []),
          provider_id: trimStr(body.provider_id),
          model: trimStr(body.model),
          request_format: trimStr(body.request_format),
          runtime_controls: body.runtime_controls
            ? create(ChatRuntimeControlsSchema, {
                thinking_enabled: bool(rec(body.runtime_controls).thinking_enabled),
                native_web_search_enabled: bool(
                  rec(body.runtime_controls).native_web_search_enabled,
                ),
                reasoning: str(rec(body.runtime_controls).reasoning),
                plan_mode_enabled: bool(rec(body.runtime_controls).plan_mode_enabled),
              })
            : undefined,
          workdir: trimStr(body.workdir),
          git_branch: trimStr(body.git_branch),
        }),
      };
```

`ClarifyTurnRequestSchema` / `ChatRuntimeControlsSchema` need to be added to the schema imports at the top of the file (aligning with the existing import list such as `MemoryManageRequestSchema`, `adapters.ts:60-90`). First `grep ClarifyTurnRequestSchema` to confirm the proto-generated schema export name (in `web/src/lib/proto/gen/`).

- [ ] **Step 2: RPC client method**

Add to `GatewayWebSocketRpcClient` in `gatewaySocketRpc.ts` (aligning with the `trajectoryFetch` style):

```ts
  async clarifyPromptTurn(input: {
    messages: ClarifyMessage[];
    providerId: string;
    model: string;
    requestFormat: string;
    runtimeControls?: ChatRuntimeControls;
    workdir: string;
    gitBranch?: string;
  }): Promise<{
    final_text: string;
    error_code?: string;
    error_message?: string;
  }> {
    return this.request("clarify.prompt_turn", {
      messages: input.messages,
      provider_id: input.providerId,
      model: input.model,
      request_format: input.requestFormat,
      runtime_controls: input.runtimeControls,
      workdir: input.workdir,
      git_branch: input.gitBranch ?? "",
    });
  }
```

Import `ClarifyMessage` from `@liveagent/ui/components/chat/clarify/clarifyTypes`; take `ChatRuntimeControls` from the existing imports.

- [ ] **Step 3: Write a failing test (frame assertion)**

Append to `gateway-socket-client.test.mjs` (aligning with the `memory manage payloads` case, lines 603-634—copy the `installBrowser` + `loadGatewaySocket` + `findAgentRequest` + `receiveBinary` skeleton):

```js
test("GatewayWebSocketClient sends clarify prompt turn payloads", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const clarifyPromise = client.clarifyPromptTurn({
    messages: [{ role: "user", content: "help me build a website" }],
    providerId: "builtin-gemini",
    model: "gemini-2.0-flash",
    requestFormat: "google",
    workdir: "/repo/x",
    gitBranch: "main",
  });
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "clarify_turn"), "clarify frame");
  const request = findAgentRequest(codec, socket, "clarify_turn");
  assert.deepEqual(JSON.parse(request.json.agent_request.clarify_turn.messages_json), [
    { role: "user", content: "help me build a website" },
  ]);
  assert.equal(request.json.agent_request.clarify_turn.provider_id, "builtin-gemini");
  assert.equal(request.json.agent_request.clarify_turn.model, "gemini-2.0-flash");
  assert.equal(request.json.agent_request.clarify_turn.workdir, "/repo/x");
  assert.equal(request.json.agent_request.clarify_turn.git_branch, "main");

  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: request.requestId,
      agent_response: {
        clarify_turn_resp: {
          final_text: "optimized prompt",
        },
      },
    }),
  );

  assert.deepEqual(await clarifyPromise, { final_text: "optimized prompt" });
  resetGatewayWebSocketClient();
});
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd crates/agent-gateway && node ../../scripts/run-node-tests.mjs test/webui/gateway-socket-client.test.mjs`
Expected: PASS (the new case + all existing green).

- [ ] **Step 5: Commit**

```bash
git add crates/agent-gateway/web/src/lib/gatewaySocketV2/adapters.ts crates/agent-gateway/web/src/lib/gatewaySocketRpc.ts crates/agent-gateway/test/webui/gateway-socket-client.test.mjs
git commit -m "feat(clarify): web clarify_prompt_turn RPC client + frame test"
```

---

### Task 6: Web Host Injection

**Files:**
- Modify: `crates/agent-gateway/web/src/app/GatewayAppView.tsx`
- Modify: `crates/agent-gateway/web/src/app/GatewayApp.tsx`

**Interfaces:**
- Consumes: `clarifyPromptTurn` (Task 5); `activeSelectedModel`/`currentChatProvider`/`chatRuntimeControlsForCurrentProvider` (useGatewayChatConfiguration); `displayedConversationWorkdir`.
- Produces: none (terminal injection; the `runClarifyTurn`/`clarifyContext` props of `ChatComposerBar` are wired up).

- [ ] **Step 1: GatewayApp.tsx passes the required model state to the View**

Does `GatewayAppView` already receive `activeSelectedModel`/`currentChatProvider`/`chatRuntimeControlsForCurrentProvider` from props? Grep first—if the View only has derived values such as `selectedValue`/`currentModelLabel`, then add to the `<GatewayAppView ...>` props in `GatewayApp.tsx`:

```tsx
    activeSelectedModel={activeSelectedModel}
    currentChatProvider={currentChatProvider}
    chatRuntimeControlsForCurrentProvider={chatRuntimeControlsForCurrentProvider}
```

(Align with the existing props-passing style; add the fields to the View component's props type as well.)

- [ ] **Step 2: GatewayAppView.tsx constructs runClarifyTurn + clarifyContext**

In `GatewayAppView.tsx`, before `<ChatComposerBar>` (line 754), construct the executor (aligning with the component's existing useMemo/useCallback style):

```tsx
  const runClarifyTurn = useCallback<RunClarifyTurn>(
    async (messages, _signal) => {
      if (!activeSelectedModel || !currentChatProvider) {
        throw new Error("no active model selected");
      }
      const result = await api.clarifyPromptTurn({
        messages,
        providerId: currentChatProvider.id,
        model: activeSelectedModel.model,
        requestFormat: currentChatProvider.requestFormat ?? "",
        runtimeControls: chatRuntimeControlsForCurrentProvider,
        workdir: displayedConversationWorkdir,
        gitBranch: displayedConversationGitBranch,
      });
      if (result.error_code) {
        throw new Error(result.error_message || result.error_code);
      }
      return result.final_text;
    },
    [
      activeSelectedModel,
      currentChatProvider,
      chatRuntimeControlsForCurrentProvider,
      displayedConversationWorkdir,
      displayedConversationGitBranch,
    ],
  );

  const clarifyContext = useMemo<ClarifyContext | undefined>(
    () => (displayedConversationWorkdir ? { workdir: displayedConversationWorkdir } : undefined),
    [displayedConversationWorkdir],
  );
```

`api` is the existing gateway WS client instance in the component (grep to confirm the variable name; it may be called `api` or `gatewayApi`). `displayedConversationGitBranch`: reuse an existing git branch state if one exists; otherwise omit the field (`clarifyContext` only feeds workdir, and `runClarifyTurn`'s gitBranch passes an empty string—the spec allows lightweight context, workdir suffices).

- [ ] **Step 3: Inject props into ChatComposerBar**

Add to `<ChatComposerBar>` at `GatewayAppView.tsx:754`:

```tsx
                          runClarifyTurn={runClarifyTurn}
                          clarifyContext={clarifyContext}
```

Import the `RunClarifyTurn` / `ClarifyContext` types from `@liveagent/ui/components/chat/clarify/clarifyTypes` (the file already imports `ChatComposerBar`, so just add the type imports).

- [ ] **Step 4: Type check**

Run: `cd crates/agent-gateway/web && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add crates/agent-gateway/web/src/app/GatewayAppView.tsx crates/agent-gateway/web/src/app/GatewayApp.tsx
git commit -m "feat(clarify): wire web clarify runner into gateway composer"
```

---

### Task 7: End-to-End Manual Testing

**Files:** no new files (verification task).

- [ ] **Step 1: Start the desktop side + gateway**

- Start the desktop GUI (`cd crates/agent-gui && pnpm tauri dev`, in the background). Make sure the desktop agent is connected to the gateway (the status bar shows connected).
- Start the gateway (`cd crates/agent-gateway && go run ./cmd/gateway`, or the repository's existing start method).

- [ ] **Step 2: Browser acceptance checklist**

1. Open the gateway Web UI in a browser and select a configured model (e.g. MiniMax-M3).
2. Type a vague draft in the input box ("help me build a website") → the clarify button (magic wand) becomes available → click it → the panel appears above the input box and the first question appears (with A/B/C/D options).
3. Answer 1-2 rounds → click "Generate prompt directly" → the final draft is written into the input box and the panel closes.
4. Empty draft → the button is disabled.
5. No model configured (clear the provider) → the button is hidden.
6. Switch the UI between Chinese and English; the `chat.clarify.*` copy is correct.
7. While the panel is open, Enter → does not send the main session.

- [ ] **Step 3: Error paths**

- Stop the desktop side → click clarify on the Web → the RPC fails (the gateway reports the agent is offline), and an error line appears in the panel (driven by useClarifySession's failure state).
- The desktop side closes the panel while clarification is in progress → the request times out/is dropped, with no crash.

- [ ] **Step 4: Fix the issues found (run the corresponding test for each fix); after all pass, do a final commit**

```bash
git add -A
git commit -m "fix(clarify): polish from web manual verification pass"
```
(Skip this step if there are no issues.)

---

## Self-Review Notes

- **Spec coverage**: RPC `clarify_prompt_turn` (T1/T5), reuse of the protobuf envelope (T1/T2/T5), server uses the current provider configuration (T3/T4 pass the model selection + `createProviderRuntimeConfig`), whole-segment return without streaming (T3 timeout unary + T4 `streamAssistantMessage` full-text return), the Web host only needs to implement `RunClarifyTurn` (T6), verbatim reuse of clarifyProtocol (T6 reuses agent-ui components/state machine, zero protocol code), i18n reuses `chat.clarify.*` (no additions), Web RPC failures go through the existing error channel (T4 useClarifySession failure state + the toast channel is reused), tests align with gateway-socket-client (T5). The "no model configuration: hide vs disable" decision → hidden (T7 acceptance 5).
- **Placeholders**: T3/T4 mark two wiring points to "fine-tune according to the repo's current state" (the location of `now_unix_seconds`, the existing command style in `commands/gateway.rs`), with the semantics locked down; T6's `api` variable name / `displayedConversationGitBranch` are to be confirmed by grep at implementation time. The rest of the step code is complete.
- **Type consistency**: `ClarifyTurnRequest` field names (`messages_json`/`provider_id`/`model`/`request_format`/`runtime_controls`/`workdir`/`git_branch`) run through T1 (proto) → T3 (Rust event) → T4 (TS event type) → T5 (adapters snake_case + RPC camelCase input) → T6 (camelCase input). `ClarifyTurnResponse` (`final_text`/`error_code`/`error_message`) runs through T1→T3→T5 assertion→T6 throw.
- **Rust→TS unary bridge**: T3 fully copies the oneshot+pending+timeout+emit+invoke return pattern of `handle_chat_queue_request` (chat.rs:258-345); that pattern is production-proven via chat_queue.