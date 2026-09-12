//! `cua-driver` onboarding command bridge.
//!
//! It only covers the onboarding steps of "is it installed / install it / is it authorized"; the actual computer-use capability
//! goes through the generic MCP path (`cua-driver mcp` is an ordinary stdio MCP server, driven by
//! `commands/integration/mcp.rs`, with tools discovered from `tools/list`).
//!
//! It lives under `integration/` rather than its own domain precisely because it is part of MCP integration.

use tauri::AppHandle;

use crate::services::cua_driver::installed_apps::InstalledApp;
use crate::services::cua_driver::{
    self, CuaDriverPermissions, CuaDriverProbe, InstallCommandPreview, SelfIdentity, SelfWindowRect,
};

/// Probes the binary location, version, and MCP invocation method. If not installed, returns `installed: false`,
/// which is not an error. Read-only, no side effects.
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_probe() -> Result<CuaDriverProbe, String> {
    tauri::async_runtime::spawn_blocking(cua_driver::probe)
        .await
        .map_err(|error| format!("cua_driver_probe join failed: {error}"))
}

/// Returns the **full text** of the install command that will be executed, without executing it.
///
/// The UI must first show `display` to the user and obtain explicit confirmation before it may call
/// `cua_driver_install`: that command downloads a shell script from the network and executes
/// it directly, so the user has the right to see it clearly first.
#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_install_command() -> InstallCommandPreview {
    cua_driver::install_command_preview()
}

/// Runs the official install script; progress is streamed back via the `cua_driver_install_progress` event.
///
/// The UI guarantees the preconditions: the user has seen the output of `cua_driver_install_command`
/// and confirmed. No second confirmation dialog here—the backend has no UI context and cannot present a trustworthy prompt.
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_install(app: AppHandle) -> Result<CuaDriverProbe, String> {
    tauri::async_runtime::spawn_blocking(move || cua_driver::install(&app))
        .await
        .map_err(|error| format!("cua_driver_install join failed: {error}"))?
}

/// Reads macOS Accessibility / Screen Recording authorization status. Read-only,
/// does not trigger a system authorization dialog. On non-macOS returns `supported: false`.
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_permissions_status() -> Result<CuaDriverPermissions, String> {
    tauri::async_runtime::spawn_blocking(cua_driver::permissions_status)
        .await
        .map_err(|error| format!("cua_driver_permissions_status join failed: {error}"))
}

/// Triggers the upstream authorization flow: launches CuaDriver.app and requests both permissions. This shows a system
/// dialog—the grant belongs to CuaDriver.app (not ReactorPro), which is the only correct path recommended upstream.
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_permissions_grant() -> Result<CuaDriverPermissions, String> {
    tauri::async_runtime::spawn_blocking(cua_driver::permissions_grant)
        .await
        .map_err(|error| format!("cua_driver_permissions_grant join failed: {error}"))?
}

/// ReactorPro's own process identity. The frontend uses it to filter out records belonging to the host
/// from cua-driver's window / app lists, and to block calls that target the host pid directly. Read-only.
#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_self_identity() -> SelfIdentity {
    cua_driver::self_identity()
}

/// Screen rectangles (logical points) of ReactorPro's own visible windows. The frontend uses them to block clicks / drags
/// targeting the desktop and dispatched by screen coordinates—that path bypasses the pid / window_id checks.
/// Read-only; windows move, so callers should re-fetch before each use.
#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_self_windows(app: AppHandle) -> Vec<SelfWindowRect> {
    cua_driver::self_window_rects(&app)
}

/// pid of the current foreground app. The frontend uses it to block desktop keyboard calls with no pid / window_id / coordinates
/// (press_key / hotkey / type_text)—that kind of input is delivered to the foreground app, and when the foreground app
/// is the host, that amounts to letting the model dismiss its own approval dialog. Read-only; focus changes at any time, so callers
/// should re-fetch before each decision. Returns Err when unavailable, which the frontend handles as fail-closed.
#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_frontmost_pid() -> Result<u32, String> {
    cua_driver::frontmost_pid()
}

/// Enumerates installed apps, to serve as computer use targets for @-mentions in the input box.
///
/// The host itself (by tauri identifier) is always filtered out—`cuaSelfGuard` rejects all
/// operations targeting the host, so leaving it in the candidates would only let the user pick an item that is certain to fail.
/// Read-only; scanning directories + reading plists one by one involves I/O, so it goes through spawn_blocking.
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_list_installed_apps(app: AppHandle) -> Result<Vec<InstalledApp>, String> {
    let host_identifier = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        cua_driver::installed_apps::list_installed_apps(&host_identifier)
    })
    .await
    .map_err(|error| format!("cua_driver_list_installed_apps join failed: {error}"))
}
