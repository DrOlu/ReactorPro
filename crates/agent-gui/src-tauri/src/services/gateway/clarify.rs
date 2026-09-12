//! Clarify-turn unary bridge (Web plan 2) + streaming deltas.
//!
//! The web side forwards `ClarifyTurnRequest` through the gateway to the desktop agent. When Rust
//! receives it, it sends the request to the TS runtime as a `gateway:clarify-turn-requested` event
//! to perform the LLM completion; streaming deltas are pushed back via `gateway_clarify_delta` as a
//! `ClarifyTurnDelta` with the same request_id, and the final result returns via
//! `gateway_clarify_respond` as a `ClarifyTurnResp`. A delta must not occupy the first correlated
//! response the unary call is waiting for.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::oneshot;

use super::GatewayChatRuntimeControlsEvent;
use super::GatewayController;
use super::proto::{
    agent_envelope, AgentEnvelope, ClarifyTurnDelta, ClarifyTurnRequest, ClarifyTurnResponse,
};
use super::util::now_unix_seconds;

pub(crate) const GATEWAY_CLARIFY_TURN_REQUESTED_EVENT: &str = "gateway:clarify-turn-requested";

/// Rust -> TS clarify-turn event payload. runtime_controls is passed as a JSON string and parsed
/// back into ChatRuntimeControls on the TS side (reusing agent-ui's normalize logic).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayClarifyTurnRequestEvent {
    pub request_id: String,
    pub messages_json: String,
    pub provider_id: String,
    pub model: String,
    pub runtime_controls_json: String,
}

/// The result returned by the TS side via invoke gateway_clarify_respond.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayClarifyRespondInput {
    pub request_id: String,
    pub final_text: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

/// The streaming delta returned by the TS side via invoke gateway_clarify_delta.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayClarifyDeltaInput {
    pub request_id: String,
    pub text: String,
}

impl GatewayClarifyTurnRequestEvent {
    pub(crate) fn from_request(request_id: String, request: ClarifyTurnRequest) -> Self {
        let runtime_controls_json = request
            .runtime_controls
            .map(|runtime_controls| {
                serde_json::to_string(&GatewayChatRuntimeControlsEvent {
                    thinking_enabled: runtime_controls.thinking_enabled,
                    native_web_search_enabled: runtime_controls.native_web_search_enabled,
                    reasoning: runtime_controls.reasoning,
                    plan_mode_enabled: runtime_controls.plan_mode_enabled,
                })
                .unwrap_or_default()
            })
            .unwrap_or_default();
        Self {
            request_id,
            messages_json: request.messages_json,
            provider_id: request.provider_id,
            model: request.model,
            runtime_controls_json,
        }
    }
}

/// Error response shared by the three failure exits (emit failure / dangling sender / timeout).
fn clarify_error_response(code: &str, message: String) -> ClarifyTurnResponse {
    ClarifyTurnResponse {
        final_text: String::new(),
        error_code: code.to_string(),
        error_message: message,
    }
}

impl From<GatewayClarifyRespondInput> for ClarifyTurnResponse {
    fn from(input: GatewayClarifyRespondInput) -> Self {
        ClarifyTurnResponse {
            final_text: input.final_text.unwrap_or_default(),
            error_code: input.error_code.unwrap_or_default(),
            error_message: input.error_message.unwrap_or_default(),
        }
    }
}

impl GatewayController {
    pub(crate) async fn handle_clarify_turn(
        self: &Arc<Self>,
        request_id: String,
        request: ClarifyTurnRequest,
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
                    clarify_error_response(
                        "emit_failed",
                        format!("emit gateway clarify turn failed: {error}"),
                    ),
                )
                .await;
        }

        let response = match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => clarify_error_response(
                "response_dropped",
                "clarify turn response dropped".to_string(),
            ),
            Err(_) => {
                let _ = self
                    .pending_clarify_turns
                    .lock()
                    .map(|mut pending| pending.remove(&request_id));
                clarify_error_response("timeout", "clarify turn timed out".to_string())
            }
        };

        self.send_clarify_turn_response(request_id, response).await
    }

    pub(crate) async fn send_clarify_turn_response(
        &self,
        request_id: String,
        response: ClarifyTurnResponse,
    ) -> Result<(), String> {
        self.send_agent_envelope(AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(agent_envelope::Payload::ClarifyTurnResp(response)),
        })
        .await
    }

    pub(crate) async fn send_clarify_turn_delta(
        &self,
        request_id: String,
        text: String,
    ) -> Result<(), String> {
        let pending = self
            .pending_clarify_turns
            .lock()
            .map_err(|_| "gateway clarify turn lock poisoned".to_string())?
            .contains_key(&request_id);
        if !pending {
            return Ok(());
        }
        self.send_agent_envelope(AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(agent_envelope::Payload::ClarifyTurnDelta(ClarifyTurnDelta {
                text,
            })),
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
            return Ok(()); // already timed out/removed: silently discard the late response.
        };
        tx.send(ClarifyTurnResponse::from(input))
            .map_err(|_| "gateway clarify turn response receiver dropped".to_string())
    }
}
