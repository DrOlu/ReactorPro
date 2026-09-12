//! Browser automation service (native Browser tool, see docs/design/browser-automation.md).
//! BrowserManager holds at most one browser session, with two access modes:
//! - extension: when the ReactorPro browser extension (browser-extension/) is already connected to the bridge service,
//!   directly drive a newly opened automation tab in the user's everyday browser — reusing the user's login state without starting another
//!   browser process (the Claude Code in Chrome approach);
//! - launcher: fallback when the extension is not connected — launch a new browser process on demand with an isolated profile.
//!
//! The launcher process is reclaimed when the app exits or on browser_close; extension mode has no
//! child process, so close only closes the automation tab (Target.closeTarget, mapped by the extension to closing a tab).

mod bridge;
mod cdp;
mod launcher;
mod page;
mod snapshot;
pub mod types;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::runtime::process::signal_process_tree_by_pid;
use bridge::ExtensionBridge;
use cdp::CdpConnection;
use launcher::{discover_browser_executable, launch_browser, LaunchedBrowser};
use page::PageSession;
use types::{
    effective_timeout_ms, BrowserActionArgs, BrowserActionResponse, BrowserStatusResponse,
};

struct ActiveBrowser {
    /// Child process handle in launcher mode; None in extension mode (the user's own browser).
    launched: Option<LaunchedBrowser>,
    page: PageSession,
}

impl ActiveBrowser {
    fn mode(&self) -> &'static str {
        if self.launched.is_some() {
            "launcher"
        } else {
            "extension"
        }
    }
}

#[derive(Default)]
pub struct BrowserManager {
    active: Mutex<Option<ActiveBrowser>>,
    /// Side record of the current browser process pid: on shutdown, if the `active` lock is held by an in-flight
    /// action (try_lock fails), the process tree can still be killed by pid, avoiding leftovers after exit.
    /// Extension mode has no child process and is always None.
    child_pid: StdMutex<Option<u32>>,
    bridge: Arc<ExtensionBridge>,
}

impl BrowserManager {
    /// Start the extension bridge listener (called once in lib.rs run()). Bridge unavailability does not affect
    /// the launcher fallback path.
    pub fn start_extension_bridge(&self) {
        self.bridge.start();
    }

    /// Whether the bridge service currently has a live extension connection (used by the settings page's onboarding UI polling).
    pub fn extension_connected(&self) -> bool {
        self.bridge.live_connection().is_some()
    }

    /// Cleanup hook when the app truly exits (Drop is not guaranteed to be called).
    pub fn shutdown_cleanup(&self) {
        if let Ok(mut guard) = self.active.try_lock() {
            // Taking it out triggers LaunchedBrowser::drop -> kills the process tree.
            guard.take();
        }
        // Fallback: if an action happens to be executing at the exact moment of exit, the try_lock above cannot acquire the lock, so
        // kill the process tree directly by the recorded pid (re-signaling an already-dead process is harmless), preventing the profile from being
        // locked by a leftover instance and failing the next startup.
        if let Ok(mut pid) = self.child_pid.lock() {
            if let Some(pid) = pid.take() {
                signal_process_tree_by_pid(pid, true);
            }
        }
    }

    fn record_child_pid(&self, pid: Option<u32>) {
        if let Ok(mut guard) = self.child_pid.lock() {
            *guard = pid;
        }
    }

    pub async fn close(&self) -> Result<(), String> {
        let taken = self.active.lock().await.take();
        if let Some(active) = taken {
            // Extension mode has no child process to kill; cleanup closes the automation tab (best effort,
            // the user may have closed it manually); in launcher mode LaunchedBrowser::drop kills the process tree.
            if active.launched.is_none() {
                let _ = active.page.close_target().await;
            }
        }
        self.record_child_pid(None);
        Ok(())
    }

    pub async fn status(&self) -> BrowserStatusResponse {
        let guard = self.active.lock().await;
        match guard.as_ref() {
            Some(active) if active.page.is_connected() => {
                let (url, title) = active
                    .page
                    .current_url_and_title()
                    .await
                    .unwrap_or_default();
                BrowserStatusResponse {
                    running: true,
                    mode: Some(active.mode().to_string()),
                    extension_connected: self.bridge.live_connection().is_some(),
                    url: Some(url),
                    title: Some(title),
                    executable: active
                        .launched
                        .as_ref()
                        .map(|launched| launched.executable.display().to_string()),
                }
            }
            _ => BrowserStatusResponse {
                running: false,
                mode: None,
                extension_connected: self.bridge.live_connection().is_some(),
                url: None,
                title: None,
                executable: discover_browser_executable().map(|path| path.display().to_string()),
            },
        }
    }

    pub async fn execute(&self, args: BrowserActionArgs) -> Result<BrowserActionResponse, String> {
        let requested_mode = RequestedMode::parse(args.browser_mode.as_deref());
        let mut guard = self.active.lock().await;
        // Discard and rebuild if the session is invalid. Two kinds of invalidation: WS disconnect (the user quit the browser entirely), and
        // WS still alive but the page target is gone (the user closed only the automation window/tab, or the tab crashed —
        // the browser-level connection is not dropped for that). Target probing uses browser-level commands
        // and is unaffected by page JS hangs.
        let session_dead = match guard.as_ref() {
            Some(active) => !active.page.is_connected() || !active.page.target_alive().await,
            None => false,
        };
        // After the user changes the browser mode setting, tear down and rebuild when the existing session conflicts with the new mode
        // (auto is not picky and reuses the existing session): userProfile only accepts extension sessions,
        // isolated only accepts launcher sessions.
        let session_mismatch = match (guard.as_ref(), requested_mode) {
            (Some(active), RequestedMode::UserProfile) => active.launched.is_some(),
            (Some(active), RequestedMode::Isolated) => active.launched.is_none(),
            _ => false,
        };
        if session_dead || session_mismatch {
            if let Some(active) = guard.take() {
                if session_mismatch && active.launched.is_none() {
                    // When a mode switch tears down an extension session, close the automation tab along the way;
                    // an invalid session (tab already gone) needs no and cannot be closed.
                    let _ = active.page.close_target().await;
                }
            }
            self.record_child_pid(None);
        }
        if guard.is_none() {
            let started = start_browser(&self.bridge, requested_mode).await?;
            self.record_child_pid(
                started
                    .launched
                    .as_ref()
                    .map(LaunchedBrowser::child_pid),
            );
            *guard = Some(started);
        }
        let active = guard.as_mut().expect("browser session just ensured");

        let timeout = Duration::from_millis(effective_timeout_ms(args.timeout_ms));
        let action = args.action.trim().to_string();
        let mut result_text: Option<String> = None;
        let mut screenshot: Option<(String, String)> = None;

        match action.as_str() {
            "navigate" => {
                let url = required(&args.url, "navigate", "url")?;
                active.page.navigate(&url, timeout).await?;
            }
            "snapshot" => {}
            "click" => {
                let ref_id = required(&args.ref_id, "click", "ref")?;
                active.page.click(&ref_id, timeout).await?;
            }
            "type" => {
                let ref_id = required(&args.ref_id, "type", "ref")?;
                // text only requires that it "was passed", with no trim and no rejection of an empty string: leading/trailing spaces may be intentional
                // input, and an empty string means clearing the field (the page layer does select-all delete).
                let text = args
                    .text
                    .clone()
                    .ok_or_else(|| "type is missing the required parameter text".to_string())?;
                active
                    .page
                    .type_text(&ref_id, &text, args.submit.unwrap_or(false), timeout)
                    .await?;
            }
            "screenshot" => {
                screenshot = Some(active.page.screenshot(timeout).await?);
            }
            "eval" => {
                let expression = required(&args.expression, "eval", "expression")?;
                result_text = Some(active.page.eval(&expression, timeout).await?);
            }
            "wait" => match (&args.selector, args.time_ms) {
                (Some(selector), _) if !selector.trim().is_empty() => {
                    active.page.wait_for_selector(selector, timeout).await?;
                    result_text = Some(format!("selector \"{selector}\" has appeared"));
                }
                (_, Some(time_ms)) => {
                    tokio::time::sleep(Duration::from_millis(time_ms.min(60_000))).await;
                    result_text = Some(format!("Waited {}ms", time_ms.min(60_000)));
                }
                _ => return Err("wait requires either selector or timeMs".to_string()),
            },
            "back" => {
                active.page.back(timeout).await?;
            }
            other => {
                return Err(format!(
                    "Unknown action \"{other}\" (supported: navigate/snapshot/click/type/screenshot/eval/wait/back)"
                ));
            }
        }

        // Page state feedback: actions that change the page include a new snapshot by default, for the model's next step.
        let default_include = matches!(
            action.as_str(),
            "navigate" | "snapshot" | "click" | "type" | "back" | "wait"
        );
        let include_snapshot = args.include_snapshot.unwrap_or(default_include);
        let snapshot_text = if include_snapshot {
            match active.page.snapshot(timeout).await {
                Ok(text) => Some(text),
                // When snapshot itself is the purpose of the action, failure must propagate; a failure of the attached snapshot
                // must not drag down an action that already succeeded (e.g. after a click triggers navigation the AX tree is briefly
                // unavailable) — otherwise the model would misjudge the action as failed and retry, duplicating side effects.
                Err(err) if action == "snapshot" => return Err(err),
                Err(err) => {
                    let note = format!("The action succeeded, but the automatically attached snapshot failed: {err}. You can run snapshot separately later to retry.");
                    result_text = Some(match result_text.take() {
                        Some(prev) => format!("{prev}\n{note}"),
                        None => note,
                    });
                    None
                }
            }
        } else {
            None
        };
        let (url, title) = active
            .page
            .current_url_and_title()
            .await
            .unwrap_or_default();

        Ok(BrowserActionResponse {
            action,
            url: Some(url),
            title: Some(title),
            snapshot: snapshot_text,
            result: result_text,
            screenshot_base64: screenshot.as_ref().map(|(data, _)| data.clone()),
            screenshot_mime: screenshot.map(|(_, mime)| mime),
        })
    }
}

fn required(value: &Option<String>, action: &str, field: &str) -> Result<String, String> {
    value
        .as_ref()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .ok_or_else(|| format!("{action} is missing the required parameter {field}"))
}

/// The browser access mode requested by the caller (passed through from settings.system.browserAutomationMode).
#[derive(Clone, Copy, PartialEq)]
enum RequestedMode {
    /// Prefer the extension, fall back to launcher when not connected (default, including unknown values).
    Auto,
    /// Use only the user's everyday browser (extension bridge); if not connected, error out directly and guide installation.
    UserProfile,
    /// Use only the isolated-profile dedicated browser, even if the extension is online.
    Isolated,
}

impl RequestedMode {
    fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("userProfile") => Self::UserProfile,
            Some("isolated") => Self::Isolated,
            _ => Self::Auto,
        }
    }
}

/// Error when the extension is not connected in userProfile mode. Passed through verbatim to the model/user by the TS side; must be self-contained
/// with installation-path guidance; the settings page also has visual guidance (browser_extension_install_info).
const EXTENSION_NOT_CONNECTED_ERROR: &str = "Browser extension not connected: the current settings require operating in your everyday browser (reusing login state), but the ReactorPro Browser Bridge extension is not installed or not connected. Please go to Settings -> System Tools -> Browser Automation and follow the guide to install the extension (chrome://extensions -> Developer mode -> Load unpacked), or change the browser mode to Auto / Isolated Browser.";

async fn start_browser(
    bridge: &ExtensionBridge,
    mode: RequestedMode,
) -> Result<ActiveBrowser, String> {
    // Extension bridge: open an automation tab directly in the user's everyday browser (with login state, no separate
    // process). Under auto, fall back to launcher if the extension is unavailable; under userProfile it is a hard requirement.
    if mode != RequestedMode::Isolated {
        if let Some(connection) = bridge.live_connection() {
            match PageSession::attach_new_tab(Arc::clone(&connection)).await {
                Ok(page) => {
                    return Ok(ActiveBrowser {
                        launched: None,
                        page,
                    });
                }
                Err(error) => {
                    if mode == RequestedMode::UserProfile {
                        return Err(format!("Failed to open an automation tab in the everyday browser: {error}"));
                    }
                    // auto: report the reason and fall back, do not silently swallow — launcher mode has different semantics
                    // (no login state) and the user should be able to perceive it.
                    eprintln!("browser extension bridge: attach_new_tab failed, falling back to launcher: {error}");
                }
            }
        } else if mode == RequestedMode::UserProfile {
            return Err(EXTENSION_NOT_CONNECTED_ERROR.to_string());
        }
    }
    let executable = discover_browser_executable().ok_or_else(|| {
        "No Chrome/Edge/Chromium detected. Browser automation requires an installed Chromium-based browser, or install the ReactorPro browser extension to reuse an existing browser.".to_string()
    })?;
    let launched = tauri::async_runtime::spawn_blocking({
        let executable = executable.clone();
        move || launch_browser(&executable)
    })
    .await
    .map_err(|e| format!("Failed to join browser launch task: {e}"))??;

    let ws_url = fetch_browser_ws_url(launched.debug_port).await?;
    let connection = CdpConnection::connect(&ws_url).await?;
    let page = PageSession::attach(connection).await?;
    Ok(ActiveBrowser {
        launched: Some(launched),
        page,
    })
}

/// `GET http://127.0.0.1:<port>/json/version` -> webSocketDebuggerUrl.
async fn fetch_browser_ws_url(port: u16) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to request DevTools metadata: {e}"))?;
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse DevTools metadata: {e}"))?;
    body.get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "DevTools metadata is missing webSocketDebuggerUrl".to_string())
}

/// Expose the isolated profile path for status queries (diagnostics).
#[allow(dead_code)]
pub fn profile_dir() -> Result<PathBuf, String> {
    launcher::automation_profile_dir()
}

#[cfg(test)]
mod e2e_tests {
    use super::*;
    use base64::Engine;

    /// Manual e2e for the acceptance loop: navigate to the docs site -> a11y snapshot -> screenshot to disk.
    /// Requires Chrome/Edge installed locally; not run in CI:
    /// `cargo test -p liveagent browser_e2e -- --ignored --nocapture`
    /// The screenshot output path can be overridden with LIVEAGENT_BROWSER_E2E_SHOT.
    #[test]
    #[ignore = "requires an installed Chromium-family browser; manual acceptance evidence"]
    fn browser_e2e_manual() {
        tauri::async_runtime::block_on(async {
            let manager = BrowserManager::default();

            let navigated = manager
                .execute(BrowserActionArgs {
                    action: "navigate".to_string(),
                    url: Some("https://tauri.app".to_string()),
                    ..Default::default()
                })
                .await
                .expect("navigate should succeed");
            let snapshot = navigated.snapshot.expect("navigate returns a snapshot");
            println!(
                "== navigate ==\nurl={:?} title={:?}\nsnapshot chars={} (~{} tokens)\n{}",
                navigated.url,
                navigated.title,
                snapshot.len(),
                snapshot.len() / 4,
                snapshot
            );
            assert!(snapshot.contains("[ref=e"), "snapshot should carry ref ids");
            assert!(snapshot.len() < 32_000, "snapshot must stay within budget");

            let shot = manager
                .execute(BrowserActionArgs {
                    action: "screenshot".to_string(),
                    ..Default::default()
                })
                .await
                .expect("screenshot should succeed");
            let data = shot
                .screenshot_base64
                .expect("screenshot returns base64 data");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&data)
                .expect("screenshot base64 decodes");
            let out = std::env::var("LIVEAGENT_BROWSER_E2E_SHOT")
                .unwrap_or_else(|_| "browser-e2e-screenshot.jpg".to_string());
            std::fs::write(&out, &bytes).expect("screenshot file writes");
            println!("== screenshot == {} bytes -> {out}", bytes.len());

            manager.close().await.expect("close should succeed");
        });
    }
}
