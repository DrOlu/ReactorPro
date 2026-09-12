use std::sync::Arc;

use serde_json::Value;

use crate::commands::settings::{
    load_remote_settings, open_db, parse_remote_settings_payload, RemoteSettingsPayload,
};
use crate::services::gateway::{
    GatewayChatCheckpointCommitResult, GatewayChatCheckpointInput, GatewayChatClaimedRequest,
    GatewayChatIngressAcceptResult, GatewayChatIngressBatchInput, GatewayChatQueueEventInput,
    GatewayChatQueueResponseInput, GatewayClarifyDeltaInput, GatewayClarifyRespondInput,
    GatewayController,
    GatewayStatusSnapshot,
};
use crate::services::provider_usage::{ProviderUsageResult, ProviderUsageService};
use crate::services::tunnel::{
    GatewayTunnelCreateInput, GatewayTunnelUpdateInput, TunnelStatePayload,
};
use crate::services::workspace_watch::WatchSource;

#[tauri::command]
pub async fn provider_usage_query(
    provider_id: String,
    refresh: bool,
    provider_usage_service: tauri::State<'_, Arc<ProviderUsageService>>,
) -> Result<ProviderUsageResult, String> {
    Ok(provider_usage_service.query(&provider_id, refresh).await)
}

#[tauri::command]
pub async fn provider_usage_test(
    provider_id: String,
    config_json: String,
    provider_usage_service: tauri::State<'_, Arc<ProviderUsageService>>,
) -> Result<ProviderUsageResult, String> {
    Ok(provider_usage_service
        .test(&provider_id, &config_json)
        .await)
}

#[tauri::command]
pub async fn gateway_connect(
    payload: Option<Value>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    let mut config = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        let persisted = load_remote_settings(&conn)?;
        let mut requested = match payload {
            Some(value) => parse_remote_settings_payload(value)?,
            None => persisted.clone(),
        };
        // Agent ID always comes from the locally persisted identity; callers cannot temporarily override it via the connect command.
        requested.agent_id = persisted.agent_id;
        Ok::<_, String>(requested)
    })
    .await
    .map_err(|e| format!("gateway_connect join failed: {e}"))??;
    config.enabled = true;
    gateway_controller.apply_config(config)
}

#[tauri::command]
pub fn gateway_disconnect(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.disconnect_runtime()
}

#[tauri::command]
pub fn gateway_status(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<GatewayStatusSnapshot, String> {
    Ok(gateway_controller.status())
}

#[tauri::command(rename_all = "snake_case")]
pub fn gateway_nudge_connection(
    reason: Option<String>,
    force_reconnect: Option<bool>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<bool, String> {
    gateway_controller.nudge_connection(
        reason.as_deref().unwrap_or("runtime_wake"),
        force_reconnect.unwrap_or(false),
    )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_send_chat_ingress_batch(
    input: GatewayChatIngressBatchInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<GatewayChatIngressAcceptResult, String> {
    gateway_controller.accept_chat_ingress_batch(input).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_commit_chat_checkpoint(
    input: GatewayChatCheckpointInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<GatewayChatCheckpointCommitResult, String> {
    gateway_controller.commit_chat_checkpoint(input).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_claim_next(
    worker_id: String,
    lease_ms: Option<u64>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<Option<GatewayChatClaimedRequest>, String> {
    gateway_controller
        .claim_next_chat_request(worker_id, lease_ms)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_mark_started(
    request_id: String,
    conversation_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .mark_chat_request_started(request_id, conversation_id, worker_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_mark_local_started(
    request_id: String,
    conversation_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .mark_local_chat_run_started(request_id, conversation_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_mark_local_cancelled(
    request_id: String,
    conversation_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .mark_local_chat_run_cancelled(request_id, conversation_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_mark_queued_in_gui(
    request_id: String,
    conversation_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .mark_chat_request_queued_in_gui(request_id, conversation_id, worker_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_complete(
    request_id: String,
    conversation_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .complete_chat_request(request_id, conversation_id, worker_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_fail(
    request_id: String,
    conversation_id: Option<String>,
    error_code: String,
    message: String,
    terminal: bool,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .fail_chat_request(
            request_id,
            conversation_id,
            error_code,
            message,
            terminal,
            worker_id,
        )
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_cancel_request(
    request_id: String,
    conversation_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .cancel_chat_request(request_id, conversation_id, worker_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn gateway_chat_heartbeat(
    request_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.heartbeat_chat_request(request_id, worker_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_runtime_heartbeat(
    worker_id: String,
    state: String,
    visible: bool,
    active_run_count: u32,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .publish_chat_runtime_status(worker_id, state, visible, active_run_count)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn gateway_chat_release_lease(
    request_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.release_chat_request_lease(request_id, worker_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn gateway_chat_queue_respond(
    input: GatewayChatQueueResponseInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.respond_chat_queue_request(input)
}

#[tauri::command(rename_all = "snake_case")]
pub fn gateway_clarify_respond(
    input: GatewayClarifyRespondInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.respond_clarify_turn(input)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_clarify_delta(
    input: GatewayClarifyDeltaInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .send_clarify_turn_delta(input.request_id, input.text)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_publish_chat_queue_event(
    input: GatewayChatQueueEventInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.publish_chat_queue_event(input).await
}

#[tauri::command]
pub async fn gateway_publish_settings_sync(
    payload: Value,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.publish_settings_sync(payload).await
}

#[tauri::command]
pub fn gateway_tunnel_state(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<TunnelStatePayload, String> {
    Ok(gateway_controller.tunnel_state())
}

#[tauri::command]
pub async fn gateway_tunnel_create(
    input: GatewayTunnelCreateInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.tunnel_create(input).await
}

#[tauri::command]
pub async fn gateway_tunnel_update(
    input: GatewayTunnelUpdateInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.tunnel_update(input).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_tunnel_close(
    tunnel_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.tunnel_close(tunnel_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_tunnel_check(
    tunnel_id: Option<String>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.tunnel_check(tunnel_id).await
}

#[tauri::command]
pub fn workspace_watch_set(
    workdirs: Vec<String>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .workspace_watch
        .set_desired(WatchSource::Local, workdirs);
    Ok(())
}

/// Cap on a gateway API response body, so a runaway response cannot exhaust
/// memory in the desktop process.
const GATEWAY_API_RESPONSE_LIMIT_BYTES: usize = 4 * 1024 * 1024;

/// Base URL for the configured gateway, e.g. `https://host:443`.
///
/// The dedicated port setting wins over any port in the URL, matching how the
/// Remote settings preview builds its endpoint.
fn gateway_api_base_url(remote: &RemoteSettingsPayload) -> Result<String, String> {
    let raw = remote.gateway_url.trim();
    if raw.is_empty() {
        return Err("No gateway URL is configured. Set it in Settings > Remote.".to_string());
    }
    let port = if remote.gateway_port == 0 {
        443
    } else {
        remote.gateway_port
    };
    let normalized = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let mut url =
        reqwest::Url::parse(&normalized).map_err(|e| format!("Invalid gateway URL {raw:?}: {e}"))?;
    url.set_port(Some(port))
        .map_err(|_| format!("Gateway URL {raw:?} cannot take a port"))?;
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Call the gateway REST API on behalf of the UI.
///
/// The desktop WebView is a different origin from the gateway and the gateway
/// sends no CORS headers, so the request has to go through the Rust side. The
/// gateway token never leaves this process, and callers can only reach `/api/`.
#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_api_request(
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let conn = open_db()?;
    let remote = load_remote_settings(&conn)?;
    let path = path.trim();
    if !path.starts_with("/api/") {
        return Err("Gateway API path must start with /api/.".to_string());
    }
    if remote.token.trim().is_empty() {
        return Err("No gateway token is configured. Set it in Settings > Remote.".to_string());
    }
    let base = gateway_api_base_url(&remote)?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build the gateway client: {e}"))?;

    let url = format!("{base}{path}");
    let request = match method.to_ascii_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url).json(&body.unwrap_or(Value::Null)),
        other => return Err(format!("Unsupported gateway API method: {other}")),
    };
    let response = request
        .bearer_auth(remote.token.trim())
        .send()
        .await
        .map_err(|e| format!("Gateway request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read the gateway response: {e}"))?;
    if text.len() > GATEWAY_API_RESPONSE_LIMIT_BYTES {
        return Err("The gateway response was too large to display.".to_string());
    }

    // A non-JSON body (a proxy error page, for example) is surfaced as-is.
    let parsed = serde_json::from_str::<Value>(&text)
        .unwrap_or_else(|_| serde_json::json!({ "error": text.trim() }));

    if !status.is_success() {
        let message = parsed
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("The gateway returned {status}."));
        return Err(message);
    }
    Ok(parsed)
}
