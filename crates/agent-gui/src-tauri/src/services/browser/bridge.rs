//! Extension bridge: a local WebSocket service that accepts reverse connections from the
//! ReactorPro browser extension (MV3, `crates/agent-gui/browser-extension/`). The extension
//! uses `chrome.debugger` to relay CDP inside the user's everyday browser---automation therefore
//! reuses the user's login state and does not need to launch a separate browser process. The wire
//! protocol is identical to native CDP ({id,method,params,sessionId} / {id,result|error} / events),
//! and the Rust-side CdpConnection/PageSession are reused as-is.
//!
//! Security boundary: binds only 127.0.0.1; the handshake verifies Origin is chrome-extension://
//! (a malicious local process can still forge this header---compared with Claude Code native
//! messaging this is a tradeoff; the extension side exposes only the automation tabs it created
//! itself, so the attack surface is limited to "driving a new tab"). Only the newest connection is
//! kept at any time: an extension reconnect replaces it.

use std::sync::Mutex as StdMutex;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request, Response as HandshakeResponse,
};

use super::cdp::CdpConnection;

/// Default listen port; can be overridden with LIVEAGENT_BROWSER_BRIDGE_PORT (the extension side must be changed in sync).
const DEFAULT_BRIDGE_PORT: u16 = 19_222;

/// Handshake timeout: connections that do not send an upgrade request after the TCP connect are dropped after this limit.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn bridge_port() -> u16 {
    std::env::var("LIVEAGENT_BROWSER_BRIDGE_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_BRIDGE_PORT)
}

#[derive(Default)]
pub(crate) struct ExtensionBridge {
    latest: StdMutex<Option<Arc<CdpConnection>>>,
}

impl ExtensionBridge {
    /// Start the listen task. A bind failure (port in use, etc.) only logs and does not block app
    /// startup---when the bridge is unavailable, BrowserManager automatically falls back to launcher mode.
    pub(crate) fn start(self: &Arc<Self>) {
        let bridge = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let port = bridge_port();
            let listener = match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("browser extension bridge: bind 127.0.0.1:{port} failed: {error}");
                    return;
                }
            };
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                // The handshake runs in its own task with a timeout: if awaited serially in the accept loop,
                // any local connection that connects but never sends an upgrade request would block the
                // loop forever, and the extension would then be unable to connect to the bridge.
                let bridge = Arc::clone(&bridge);
                tauri::async_runtime::spawn(async move {
                    let handshake = tokio::time::timeout(
                        HANDSHAKE_TIMEOUT,
                        accept_hdr_async(stream, verify_extension_origin),
                    )
                    .await;
                    match handshake {
                        Ok(Ok(ws)) => {
                            let connection = CdpConnection::from_stream(ws);
                            if let Ok(mut latest) = bridge.latest.lock() {
                                *latest = Some(connection);
                            }
                        }
                        Ok(Err(error)) => {
                            eprintln!("browser extension bridge: handshake rejected: {error}");
                        }
                        Err(_) => {
                            eprintln!("browser extension bridge: handshake timed out");
                        }
                    }
                });
            }
        });
    }

    /// Currently live extension connections (disconnected connections count as none).
    pub(crate) fn live_connection(&self) -> Option<Arc<CdpConnection>> {
        self.latest
            .lock()
            .ok()?
            .as_ref()
            .filter(|connection| !connection.is_closed())
            .cloned()
    }
}

/// Accepts handshakes initiated only by the browser extension: Chromium-family extension service
/// worker WebSocket requests carry Origin: chrome-extension://<id>.
fn verify_extension_origin(
    request: &Request,
    response: HandshakeResponse,
) -> Result<HandshakeResponse, ErrorResponse> {
    let origin_ok = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(|origin| origin.starts_with("chrome-extension://"))
        .unwrap_or(false);
    if origin_ok {
        Ok(response)
    } else {
        let mut rejection = ErrorResponse::new(Some("forbidden origin".to_string()));
        *rejection.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
        Err(rejection)
    }
}
