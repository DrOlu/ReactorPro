use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};

use crate::services::browser::types::{
    BrowserActionArgs, BrowserActionResponse, BrowserStatusResponse,
};
use crate::services::browser::BrowserManager;

#[tauri::command]
pub async fn browser_action(
    state: State<'_, Arc<BrowserManager>>,
    args: BrowserActionArgs,
) -> Result<BrowserActionResponse, String> {
    let manager = Arc::clone(&state);
    let mut args = args;
    // The browser integration mode treats the persisted setting as the sole authority (same
    // paradigm as load_runtime_command_safety_mode): the renderer/gateway pass-through is not trusted, and a settings change takes effect on the next action.
    args.browser_mode = Some(
        crate::commands::settings::load_runtime_browser_automation_mode(),
    );
    manager.execute(args).await
}

#[tauri::command]
pub async fn browser_status(
    state: State<'_, Arc<BrowserManager>>,
) -> Result<BrowserStatusResponse, String> {
    let manager = Arc::clone(&state);
    Ok(manager.status().await)
}

#[tauri::command]
pub async fn browser_close(state: State<'_, Arc<BrowserManager>>) -> Result<(), String> {
    let manager = Arc::clone(&state);
    manager.close().await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExtensionInstallInfo {
    /// Whether the extension is connected to the bridge service (connected is treated as installation complete).
    pub connected: bool,
    /// The extension install directory (the target of chrome://extensions "Load unpacked"),
    /// fixed to `~/.liveagent/extension`. None when sync fails (no bundled resource found).
    pub extension_dir: Option<String>,
}

/// The stable install directory for the extension: `~/.liveagent/extension`. Chrome records an
/// absolute path when loading an unpacked extension -- if it pointed directly at bundle resources, it would
/// break after an app update (whole install directory replaced) or a .app move; a fixed path under
/// .liveagent stays stable for life, with contents kept current by the sync on every launch.
fn liveagent_extension_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".liveagent").join("extension"))
}

/// Sync source: in a packaged build it is browser-extension/ under bundle resources
/// (declared by tauri.conf.json `bundle.resources`); in dev, Tauri copies resources
/// to target/debug/, then falls back to crates/agent-gui/browser-extension/ inside the repo.
fn bundled_extension_source(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve("browser-extension", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|path| path.join("manifest.json").is_file())
        .or_else(|| {
            let dev_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|gui| gui.join("browser-extension"));
            dev_dir.filter(|path| path.join("manifest.json").is_file())
        })
}

/// Syncs the bundled extension to `~/.liveagent/extension` on app startup (whole-directory replace).
/// After an app update, a restart picks up the new extension files, and the directory already loaded in Chrome needs no reselection.
pub fn sync_bundled_browser_extension(app: &tauri::AppHandle) -> Result<(), String> {
    let source =
        bundled_extension_source(app).ok_or_else(|| "bundled browser extension resource not found".to_string())?;
    let dest = liveagent_extension_dir().ok_or_else(|| "unable to locate the user home directory".to_string())?;
    replace_extension_dir(&source, &dest)
}

/// Replaces dest entirely with the contents of source. Delete-then-copy avoids leftover files from the old version; a failed delete
/// (e.g. an individual file held by an external process) does not abort, degrading to file-by-file overwrite.
fn replace_extension_dir(source: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        let _ = std::fs::remove_dir_all(dest);
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("failed to create extension directory: {e}"))?;
    for entry in walkdir::WalkDir::new(source)
        .follow_links(false)
        .min_depth(1)
    {
        let entry = entry.map_err(|e| format!("failed to read extension resource: {e}"))?;
        let rel = entry
            .path()
            .strip_prefix(source)
            .map_err(|e| format!("failed to compute extension relative path: {e}"))?;
        let target = dest.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("failed to create extension directory: {e}"))?;
        } else if entry.file_type().is_file() {
            std::fs::copy(entry.path(), &target)
                .map_err(|e| format!("failed to copy extension file {}: {e}", rel.display()))?;
        }
    }
    Ok(())
}

/// Settings-page install guidance: returns the extension connection state and the local extension directory. Chrome does not allow an external process
/// to silently install an extension (except via enterprise policy), so the automation ceiling is to give the directory plus step-by-step guidance.
#[tauri::command]
pub fn browser_extension_install_info(
    app: tauri::AppHandle,
    state: State<'_, Arc<BrowserManager>>,
) -> BrowserExtensionInstallInfo {
    let connected = state.extension_connected();
    // Normally the startup sync is already in place, so this only does an existence check (the 5s poll must be cheap); if the directory was
    // manually deleted by the user, a sync is performed on demand to self-heal.
    let extension_dir = liveagent_extension_dir()
        .and_then(|dir| {
            if !dir.join("manifest.json").is_file() {
                sync_bundled_browser_extension(&app).ok()?;
            }
            Some(dir)
        })
        .map(|path| path.display().to_string());
    BrowserExtensionInstallInfo {
        connected,
        extension_dir,
    }
}

/// Opens the extension directory in the system file manager (guiding the user to load it at chrome://extensions).
#[tauri::command]
pub fn browser_extension_reveal_dir(
    app: tauri::AppHandle,
    state: State<'_, Arc<BrowserManager>>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let info = browser_extension_install_info(app.clone(), state);
    let dir = info
        .extension_dir
        .ok_or_else(|| "browser extension directory not found".to_string())?;
    app.opener()
        .open_path(dir, None::<String>)
        .map_err(|e| format!("failed to open extension directory: {e}"))
}

#[cfg(test)]
mod tests {
    use super::replace_extension_dir;

    #[test]
    fn replace_extension_dir_copies_nested_and_removes_stale_files() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        std::fs::create_dir_all(source.join("icons")).unwrap();
        std::fs::write(source.join("manifest.json"), b"{}").unwrap();
        std::fs::write(source.join("icons").join("icon.png"), b"png").unwrap();

        // An old version already exists at dest: leftover files must be cleared, or they may break extension loading.
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("stale.js"), b"old").unwrap();

        replace_extension_dir(&source, &dest).unwrap();

        assert!(dest.join("manifest.json").is_file());
        assert_eq!(
            std::fs::read(dest.join("icons").join("icon.png")).unwrap(),
            b"png"
        );
        assert!(!dest.join("stale.js").exists());
    }
}
