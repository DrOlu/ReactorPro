//! MCP OAuth commands (docs/design/mcp-oauth.md §5).
//!
//! All three commands only move status and metadata; the token itself never crosses the
//! frontend boundary:
//! - `mcp_oauth_authorize`: interactive authorization (opens the system browser, blocks until
//!   the callback/timeout), triggered only by the MCP Hub's Connect gesture.
//! - `mcp_oauth_status`: authorization status query (the server card badge).
//! - `mcp_oauth_clear`: cleans up the keychain entry when disconnecting authorization or
//!   deleting a server.

use super::mcp::{run_blocking, McpServerConfig};
use crate::services::mcp_oauth::{self, OauthStatusInfo};
use tauri_plugin_opener::OpenerExt;

fn oauth_server_of(server: &McpServerConfig) -> Result<mcp_oauth::OauthServer, String> {
    if !matches!(server.transport.as_deref().unwrap_or("stdio").trim(), "http" | "sse") {
        return Err("OAuth is only supported for the http/sse transport".to_string());
    }
    server
        .oauth_server()
        .ok_or_else(|| "MCP server is missing a url; cannot perform OAuth".to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_authorize(
    app: tauri::AppHandle,
    server: McpServerConfig,
) -> Result<OauthStatusInfo, String> {
    let target = oauth_server_of(&server)?;
    // The authorization flow blocks for several minutes (waiting for the browser callback), so it
    // must be offloaded; opening the browser goes through the opener plugin and the system default browser.
    run_blocking("mcp_oauth_authorize", move || {
        mcp_oauth::authorize(&target, &|url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| format!("failed to open the system browser: {e}"))
        })
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_status(server: McpServerConfig) -> Result<OauthStatusInfo, String> {
    let target = oauth_server_of(&server)?;
    run_blocking("mcp_oauth_status", move || Ok(mcp_oauth::status(&target))).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_clear(server_id: String) -> Result<(), String> {
    run_blocking("mcp_oauth_clear", move || {
        let id = server_id.trim().to_string();
        if id.is_empty() {
            return Err("server_id must not be empty".to_string());
        }
        mcp_oauth::clear(&id)
    })
    .await
}
