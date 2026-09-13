//! Gateway controller module (split from the original single-file gateway.rs;
//! the code was moved verbatim with unchanged behavior).
//!
//! - [`types`]: outbound event / DTO types and event-name constants
//! - [`controller`]: `GatewayController` lifecycle and public API (new/start/apply_config/publish_*)
//! - [`connection`]: WebSocket connection main loop, outbound channel, and endpoint construction
//! - [`envelope_handler`]: gateway inbound envelope (`GatewayEnvelope`) dispatch
//! - [`terminal`]: terminal request handling, terminal streams, and proto conversion
//! - [`sftp`]: SFTP request handling and proto conversion
//! - [`chat`]: chat commands, chat queue, and chat event envelope construction
//! - [`chat_inbox`]: remote chat inbox, lease management, and chat run ledger accounting
//! - [`settings_sync`]: settings sync snapshot merging and envelope construction
//! - [`history_sync`]: conversation history sync events and envelope construction
//! - [`util`]: timestamp and JSON field utilities

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use crate::commands::git::GitCloneTaskRegistry;
use crate::commands::settings::RemoteSettingsPayload;
use crate::runtime::managed_process::ManagedProcessRegistry;
use crate::runtime::sftp::SftpSessionRegistry;
use crate::runtime::terminal::TerminalSessionRegistry;
use crate::services::automation::AutomationStore;
use crate::services::chat_run_ledger::ChatRunLedger;
use crate::services::memory::MemoryStore;
use crate::services::provider_usage::ProviderUsageService;
use crate::services::tunnel::{TunnelProxy, TunnelStore};
use crate::services::workspace_watch::WorkspaceWatchService;

/// Gateway v2 protobuf generation module. Business messages and the frame
/// envelope belong to the same package. Generates messages only, not a client
/// or server.
pub mod gateway_proto {
    #[allow(clippy::large_enum_variant, dead_code)]
    pub mod v2 {
        include!(concat!(env!("OUT_DIR"), "/liveagent.gateway.v2.rs"));
    }
}

pub use gateway_proto::v2 as proto;

mod chat;
mod chat_inbox;
mod chat_ingress;
mod chat_ingress_transport;
mod clarify;
mod connection;
mod controller;
mod envelope_handler;
mod history_sync;
mod managed_process;
mod settings_sync;
mod sftp;
mod terminal;
#[cfg(test)]
mod tests;
mod types;
mod util;
mod ws_transport;

pub(crate) use chat::*;
pub(crate) use chat_inbox::*;
pub(crate) use chat_ingress::*;
pub(crate) use clarify::*;
pub(crate) use connection::*;
pub(crate) use history_sync::*;
pub use history_sync::{build_history_sync_delete, build_history_sync_upsert};
pub(crate) use settings_sync::*;
pub(crate) use sftp::*;
pub(crate) use terminal::*;
pub use types::*;
pub(crate) use util::*;
pub(crate) use ws_transport::*;

pub(crate) const UI_ONLY_SETTINGS_SYNC_FIELDS: &[&str] = &[
    "skills",
    "chatRuntimeControls",
    "customSettings",
    "selectedModel",
    "theme",
    "locale",
];
pub(crate) const GATEWAY_OUTBOUND_DATA_QUEUE_DEPTH: usize = 1_024;
pub(crate) const GATEWAY_INBOUND_DISPATCH_QUEUE_DEPTH: usize = 512;
pub(crate) const GATEWAY_RECONNECT_MIN: Duration = Duration::from_millis(250);
pub(crate) const GATEWAY_RECONNECT_MAX: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_RECONNECT_STABLE_AFTER: Duration = Duration::from_secs(30);
// v2 main-link liveness watchdog: the fallback value used when ServerHello does
// not provide a heartbeat period, and the grace duration after we send a WS Ping
// probe once silence exceeds 3x the heartbeat period.
pub(crate) const GATEWAY_WS_DEFAULT_HEARTBEAT_PERIOD: Duration = Duration::from_secs(30);
pub(crate) const GATEWAY_WS_PROBE_GRACE: Duration = Duration::from_secs(10);
pub(crate) const GATEWAY_POST_CONNECT_REPLAY_DELAY: Duration = Duration::from_millis(200);
pub(crate) const GATEWAY_TERMINAL_STREAM_RECONNECT_MIN: Duration = Duration::from_millis(250);
pub(crate) const GATEWAY_TERMINAL_STREAM_RECONNECT_MAX: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_TERMINAL_STREAM_STABLE_AFTER: Duration = Duration::from_secs(30);
pub(crate) const GATEWAY_TERMINAL_STREAM_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_CHAT_LEASE_MS: u64 = 15_000;
pub(crate) const GATEWAY_CHAT_RUNNING_LEASE_MS: u64 = 30 * 60_000;
pub(crate) const GATEWAY_CHAT_LEASE_SWEEP_INTERVAL: Duration = Duration::from_secs(5);
// The gateway marks the chat runtime not-ready 15s after the last runtime
// status heartbeat. The webview timer that drives those heartbeats is
// throttled whenever the desktop window is hidden or occluded, so Rust
// re-publishes the last reported state on a steady cadence and only stops
// once the webview has been silent for the max age (a webview alive enough
// to matter refreshes the record at least once a minute even when heavily
// throttled) or has said "suspended".
pub(crate) const GATEWAY_RUNTIME_STATUS_REPUBLISH_INTERVAL: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_RUNTIME_STATUS_REPUBLISH_MAX_AGE: Duration = Duration::from_secs(10 * 60);
// A healthy webview stamps the republish record every ~2s; a gap beyond this
// window means its DOM timers are throttled (hidden/occluded window), so run
// keepalives are not firing either and ledger staleness proves nothing about
// the runs themselves.
pub(crate) const GATEWAY_WEBVIEW_REPORT_FRESH_WINDOW: Duration = Duration::from_secs(6);
pub(crate) const GATEWAY_CHAT_RUNTIME_WAKE_REQUEST_PREFIX: &str = "chat-runtime-wake-";
pub(crate) const GATEWAY_CHAT_RUNTIME_WAKE_EVENT: &str = "gateway:chat-runtime-wake";
pub(crate) const GATEWAY_CONNECTION_NUDGE_COOLDOWN: Duration = Duration::from_secs(1);
pub(crate) const GATEWAY_CHAT_CHECKPOINT_REQUESTED_EVENT: &str =
    "gateway:chat-checkpoint-requested";

pub struct GatewayController {
    app_handle: tauri::AppHandle,
    automation_store: Arc<AutomationStore>,
    memory_store: Arc<MemoryStore>,
    provider_usage_service: Arc<ProviderUsageService>,
    terminal_registry: Arc<TerminalSessionRegistry>,
    sftp_registry: Arc<SftpSessionRegistry>,
    managed_process_registry: Arc<ManagedProcessRegistry>,
    pub(crate) git_clone_task_registry: Arc<GitCloneTaskRegistry>,
    config_tx: watch::Sender<RemoteSettingsPayload>,
    runner_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    status: Mutex<GatewayStatusSnapshot>,
    outbound_tx: Mutex<Option<GatewayOutboundSender>>,
    outbound_control_tx: Mutex<Option<GatewayOutboundSender>>,
    terminal_stream_tx: Mutex<Option<mpsc::Sender<proto::TerminalStreamFrame>>>,
    settings_snapshot: Mutex<Option<Value>>,
    remote_chat_inbox: Mutex<HashMap<String, RemoteChatInboxRecord>>,
    chat_run_ledger: Mutex<ChatRunLedger>,
    runtime_status_republish: Mutex<Option<RuntimeStatusRepublishRecord>>,
    last_connection_nudge: Mutex<Option<Instant>>,
    pub(crate) tunnel_store: TunnelStore,
    pub(crate) tunnel_proxy: TunnelProxy,
    pub(crate) workspace_watch: Arc<WorkspaceWatchService>,
    pending_chat_queue_requests: Mutex<HashMap<String, oneshot::Sender<proto::ChatQueueResponse>>>,
    pending_clarify_turns:
        Mutex<HashMap<String, oneshot::Sender<proto::ClarifyTurnResponse>>>,
    chat_ingress: ChatIngressMirror,
    chat_ingress_flush_lock: tokio::sync::Mutex<()>,
    terminal_forwarder_once: Once,
    terminal_stream_forwarder_once: Once,
    sftp_forwarder_once: Once,
    remote_chat_inbox_sweeper_once: Once,
    runtime_status_republisher_once: Once,
    pub(crate) tunnel_store_once: Once,
}
