use serde::{Deserialize, Serialize};

/// Inputs for a single `Browser` tool command: action + the optional fields for each action.
/// Field validation happens at dispatch (a missing argument error names the action), keeping the TS-side schema permissive.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionArgs {
    pub action: String,
    /// Browser attachment mode (settings.system.browserAutomationMode, passed through by
    /// the TS side on every call): "auto" (default, extension preferred, fallback allowed) /
    /// "userProfile" (extension only, errors guide setup when not connected) /
    /// "isolated" (dedicated profile only).
    pub browser_mode: Option<String>,
    /// navigate target; treated as https:// when no scheme is present.
    pub url: Option<String>,
    /// click / type target: the ref id from the snapshot output (e.g. "e12").
    #[serde(rename = "ref")]
    pub ref_id: Option<String>,
    /// Text for type to input.
    pub text: Option<String>,
    /// CSS selector for wait to await.
    pub selector: Option<String>,
    /// eval expression.
    pub expression: Option<String>,
    /// Pure delay in milliseconds for wait (mutually exclusive with selector).
    pub time_ms: Option<u64>,
    /// Per-operation timeout; defaults to 30s, capped at 120s.
    pub timeout_ms: Option<u64>,
    /// Whether to append Enter after type.
    pub submit: Option<bool>,
    /// Whether to include a fresh snapshot after the action completes. The default depends on
    /// the action: true for actions that change/read page state (navigate/snapshot/click/type/
    /// back/wait), false for screenshot/eval (see mod.rs default_include).
    pub include_snapshot: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionResponse {
    pub action: String,
    pub url: Option<String>,
    pub title: Option<String>,
    /// a11y tree text (with ref ids).
    pub snapshot: Option<String>,
    /// Textual information such as eval results / wait results.
    pub result: Option<String>,
    pub screenshot_base64: Option<String>,
    pub screenshot_mime: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatusResponse {
    pub running: bool,
    /// "extension" (drives an automation tab in the user's everyday browser) or "launcher"
    /// (a dedicated-profile subprocess); None when not running.
    pub mode: Option<String>,
    /// Whether the bridge service currently has a live extension connection (the next session will use extension mode).
    pub extension_connected: bool,
    pub url: Option<String>,
    pub title: Option<String>,
    /// Browser executable path in launcher mode; None in extension mode.
    pub executable: Option<String>,
}

pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub(crate) const MAX_TIMEOUT_MS: u64 = 120_000;

pub(crate) fn effective_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS)
}
