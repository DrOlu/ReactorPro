//! The "view layer" of the tray menu: a fixed skeleton + a single apply write path.
//!
//! Design constraints (do not break):
//! - The menu skeleton is built only once (bootstrap uses English default labels);
//!   afterwards all updates go through [`apply_tray_menu`] to change content
//!   (set_text/set_checked/set_enabled + submenu rebuild), never a whole-tree
//!   `set_menu` replacement -- once set, a Linux tray menu cannot be replaced, and
//!   replacing a macOS menu while it is open causes flicker.
//! - The single source of truth for labels is the frontend i18n (`i18n/config.ts`);
//!   Rust keeps no translation table and does not guess the locale; the frontend
//!   pushes an already-localized [`TrayMenuModel`] via `app_tray_menu_sync`.
//! - User data such as conversation titles must pass through [`sanitize_menu_label`]
//!   before entering the menu (`&` escaping, control-character stripping, display-width truncation).
//! - Action dispatch is not in this module: menu item IDs are resolved and executed by the action bus in `lib.rs`.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIcon;
use tauri::AppHandle;

// ---- Static menu item IDs (the lib.rs action bus resolves by these IDs) ----
pub const TRAY_STATUS_ID: &str = "tray-status";
pub const TRAY_SHOW_ID: &str = "tray-show";
pub const TRAY_NEW_CHAT_ID: &str = "tray-new-chat";
pub const TRAY_PIN_ID: &str = "tray-pin";
pub const TRAY_RECENT_MENU_ID: &str = "tray-recent-menu";
pub const TRAY_RECENT_VIEW_ALL_ID: &str = "tray-recent-view-all";
pub const TRAY_WORKSPACES_MENU_ID: &str = "tray-workspaces-menu";
pub const TRAY_RUNS_MENU_ID: &str = "tray-runs-menu";
pub const TRAY_RUN_STOP_ALL_ID: &str = "tray-run-stop-all";
pub const TRAY_CRON_MENU_ID: &str = "tray-cron-menu";
pub const TRAY_GATEWAY_ID: &str = "tray-gateway";
pub const TRAY_APPEARANCE_MENU_ID: &str = "tray-appearance-menu";
pub const TRAY_THEME_LIGHT_ID: &str = "tray-theme:light";
pub const TRAY_THEME_DARK_ID: &str = "tray-theme:dark";
pub const TRAY_THEME_SYSTEM_ID: &str = "tray-theme:system";
pub const TRAY_SETTINGS_ID: &str = "tray-settings";
pub const TRAY_CHECK_UPDATES_ID: &str = "tray-check-updates";
pub const TRAY_OPEN_DATA_DIR_ID: &str = "tray-open-data-dir";
pub const TRAY_QUIT_ID: &str = "tray-quit";

// ---- Dynamic child item ID prefixes (`<prefix><business id>`) ----
pub const TRAY_RECENT_PREFIX: &str = "tray-recent:";
pub const TRAY_WORKSPACE_PREFIX: &str = "tray-ws:";
pub const TRAY_RUN_PREFIX: &str = "tray-run:";
pub const TRAY_CRON_PREFIX: &str = "tray-cron:";

/// Display-width upper bound for dynamic lists (half-width units; wide characters count as 2).
const TRAY_LABEL_MAX_WIDTH: usize = 40;
/// Upper bound on entries in a single submenu (the frontend truncates already; this is a defensive fallback).
const TRAY_SUBMENU_MAX_ENTRIES: usize = 20;

/// A dynamic child item pushed by the frontend: `id` is the business id (conversation/workspace/
/// cron task), and `label` is already localized but **not** sanitized -- sanitization is done
/// uniformly in Rust during apply.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuEntry {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub checked: bool,
}

/// Localized labels for static menu items. An empty string = keep the current value (bootstrap label).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayMenuLabels {
    pub show: String,
    pub new_chat: String,
    pub pin: String,
    pub recent: String,
    pub recent_view_all: String,
    pub workspaces: String,
    pub runs: String,
    pub stop_all: String,
    pub cron: String,
    pub gateway: String,
    pub appearance: String,
    pub theme_light: String,
    pub theme_dark: String,
    pub theme_system: String,
    pub settings: String,
    pub check_updates: String,
    pub open_data_dir: String,
    pub quit: String,
}

/// The complete tray model pushed by the frontend. Absent fields mean "keep/clear this block",
/// which differs from settings sync's keep-current semantics: the tray model is pushed in full each time.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayMenuModel {
    pub labels: TrayMenuLabels,
    /// Status-line suffix (e.g. "Remote connected"); when None, only `ReactorPro <version>` is shown.
    pub status_suffix: Option<String>,
    pub recent: Vec<TrayMenuEntry>,
    /// Appends "View All…" at the end of the submenu when recent chats are truncated.
    pub recent_truncated: bool,
    pub workspaces: Vec<TrayMenuEntry>,
    pub runs: Vec<TrayMenuEntry>,
    pub cron: Vec<TrayMenuEntry>,
    /// "light" | "dark" | "system"; other values do not update the checkmarks.
    pub theme: String,
    /// Whether the remote gateway row is clickable (disabled when remote is not configured).
    pub gateway_enabled: bool,
    /// summon / newChat global shortcut echo (muda accelerator format; display only, not registered).
    pub show_accelerator: Option<String>,
    pub new_chat_accelerator: Option<String>,
    pub tooltip: Option<String>,
    /// macOS status-bar text badge (e.g. "2"); None clears it. Ignored on other platforms.
    pub badge_text: Option<String>,
}

/// All handles of the fixed skeleton. Menu item handles are main-thread proxies (Send+Sync),
/// and all changes are serialized through [`apply_tray_menu`].
pub struct TrayMenuHandles {
    apply_lock: Mutex<()>,
    app_version: &'static str,
    status: MenuItem<tauri::Wry>,
    show: MenuItem<tauri::Wry>,
    new_chat: MenuItem<tauri::Wry>,
    pin: CheckMenuItem<tauri::Wry>,
    recent: Submenu<tauri::Wry>,
    workspaces: Submenu<tauri::Wry>,
    runs: Submenu<tauri::Wry>,
    cron: Submenu<tauri::Wry>,
    gateway: MenuItem<tauri::Wry>,
    appearance: Submenu<tauri::Wry>,
    theme_light: CheckMenuItem<tauri::Wry>,
    theme_dark: CheckMenuItem<tauri::Wry>,
    theme_system: CheckMenuItem<tauri::Wry>,
    settings: MenuItem<tauri::Wry>,
    check_updates: MenuItem<tauri::Wry>,
    open_data_dir: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
    tray_icon: TrayIcon,
}

/// Intermediate product of skeleton construction: the menu + item handles (the tray icon is merged in after build).
pub struct TrayMenuSkeleton {
    pub menu: Menu<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    show: MenuItem<tauri::Wry>,
    new_chat: MenuItem<tauri::Wry>,
    pin: CheckMenuItem<tauri::Wry>,
    recent: Submenu<tauri::Wry>,
    workspaces: Submenu<tauri::Wry>,
    runs: Submenu<tauri::Wry>,
    cron: Submenu<tauri::Wry>,
    gateway: MenuItem<tauri::Wry>,
    appearance: Submenu<tauri::Wry>,
    theme_light: CheckMenuItem<tauri::Wry>,
    theme_dark: CheckMenuItem<tauri::Wry>,
    theme_system: CheckMenuItem<tauri::Wry>,
    settings: MenuItem<tauri::Wry>,
    check_updates: MenuItem<tauri::Wry>,
    open_data_dir: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// Builds the fixed skeleton. Bootstrap labels use English (i18n DEFAULT_LOCALE), and are
/// replaced by real localized content on the frontend's first sync after mount.
pub fn build_tray_menu_skeleton(
    app: &tauri::App,
    app_version: &str,
) -> tauri::Result<TrayMenuSkeleton> {
    let status = MenuItem::with_id(
        app,
        TRAY_STATUS_ID,
        compose_status_line(app_version, None),
        false,
        None::<&str>,
    )?;
    let show = MenuItem::with_id(app, TRAY_SHOW_ID, "Show Main Window", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, TRAY_NEW_CHAT_ID, "New Chat", true, None::<&str>)?;
    let pin = CheckMenuItem::with_id(app, TRAY_PIN_ID, "Always on Top", true, false, None::<&str>)?;
    let recent = Submenu::with_id(app, TRAY_RECENT_MENU_ID, "Recent Chats", false)?;
    let workspaces = Submenu::with_id(app, TRAY_WORKSPACES_MENU_ID, "Workspaces", false)?;
    let runs = Submenu::with_id(app, TRAY_RUNS_MENU_ID, "Running", false)?;
    let cron = Submenu::with_id(app, TRAY_CRON_MENU_ID, "Scheduled Tasks", false)?;
    let gateway = MenuItem::with_id(app, TRAY_GATEWAY_ID, "Remote Gateway", false, None::<&str>)?;
    let theme_light =
        CheckMenuItem::with_id(app, TRAY_THEME_LIGHT_ID, "Light", true, false, None::<&str>)?;
    let theme_dark =
        CheckMenuItem::with_id(app, TRAY_THEME_DARK_ID, "Dark", true, false, None::<&str>)?;
    let theme_system = CheckMenuItem::with_id(
        app,
        TRAY_THEME_SYSTEM_ID,
        "Follow System",
        true,
        false,
        None::<&str>,
    )?;
    let appearance = Submenu::with_id_and_items(
        app,
        TRAY_APPEARANCE_MENU_ID,
        "Appearance",
        true,
        &[&theme_light, &theme_dark, &theme_system],
    )?;
    let settings = MenuItem::with_id(app, TRAY_SETTINGS_ID, "Settings…", true, None::<&str>)?;
    let check_updates =
        MenuItem::with_id(app, TRAY_CHECK_UPDATES_ID, "Check for Updates…", true, None::<&str>)?;
    let open_data_dir = MenuItem::with_id(
        app,
        TRAY_OPEN_DATA_DIR_ID,
        "Open Data Folder",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &show,
            &new_chat,
            &pin,
            &PredefinedMenuItem::separator(app)?,
            &recent,
            &workspaces,
            &PredefinedMenuItem::separator(app)?,
            &runs,
            &cron,
            &gateway,
            &PredefinedMenuItem::separator(app)?,
            &appearance,
            &settings,
            &check_updates,
            &open_data_dir,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    Ok(TrayMenuSkeleton {
        menu,
        status,
        show,
        new_chat,
        pin,
        recent,
        workspaces,
        runs,
        cron,
        gateway,
        appearance,
        theme_light,
        theme_dark,
        theme_system,
        settings,
        check_updates,
        open_data_dir,
        quit,
    })
}

impl TrayMenuHandles {
    pub fn new(skeleton: TrayMenuSkeleton, tray_icon: TrayIcon, app_version: &'static str) -> Self {
        Self {
            apply_lock: Mutex::new(()),
            app_version,
            status: skeleton.status,
            show: skeleton.show,
            new_chat: skeleton.new_chat,
            pin: skeleton.pin,
            recent: skeleton.recent,
            workspaces: skeleton.workspaces,
            runs: skeleton.runs,
            cron: skeleton.cron,
            gateway: skeleton.gateway,
            appearance: skeleton.appearance,
            theme_light: skeleton.theme_light,
            theme_dark: skeleton.theme_dark,
            theme_system: skeleton.theme_system,
            settings: skeleton.settings,
            check_updates: skeleton.check_updates,
            open_data_dir: skeleton.open_data_dir,
            quit: skeleton.quit,
            tray_icon,
        }
    }

    /// Always-on-top checkmark sync (source of truth is Rust `WindowPinState`, not the apply model).
    pub fn set_pin_checked(&self, checked: bool) {
        if let Err(error) = self.pin.set_checked(checked) {
            eprintln!("failed to sync tray pin checkmark: {error}");
        }
    }
}

/// The only tray menu write path: all content updates and submenu rebuilds happen here.
/// Called from the IPC command thread (menu operations proxy to the main thread internally;
/// calling from the main thread is also safe -- tauri's `send_user_message` runs inline on the main thread).
pub fn apply_tray_menu(
    app: &AppHandle,
    handles: &TrayMenuHandles,
    model: TrayMenuModel,
) -> Result<(), String> {
    let _guard = handles
        .apply_lock
        .lock()
        .map_err(|_| "tray menu apply lock poisoned".to_string())?;

    let err = |error: tauri::Error| format!("tray menu update failed: {error}");

    // Status line: Rust owns the version number, the frontend feeds the localized status suffix.
    handles
        .status
        .set_text(compose_status_line(
            handles.app_version,
            model.status_suffix.as_deref(),
        ))
        .map_err(err)?;

    // Static labels (empty string = keep the current value).
    set_text_if_present(&handles.show, &model.labels.show).map_err(err)?;
    set_text_if_present(&handles.new_chat, &model.labels.new_chat).map_err(err)?;
    set_check_text_if_present(&handles.pin, &model.labels.pin).map_err(err)?;
    set_submenu_text_if_present(&handles.recent, &model.labels.recent).map_err(err)?;
    set_submenu_text_if_present(&handles.workspaces, &model.labels.workspaces).map_err(err)?;
    set_submenu_text_if_present(&handles.runs, &model.labels.runs).map_err(err)?;
    set_submenu_text_if_present(&handles.cron, &model.labels.cron).map_err(err)?;
    set_text_if_present(&handles.gateway, &model.labels.gateway).map_err(err)?;
    set_submenu_text_if_present(&handles.appearance, &model.labels.appearance).map_err(err)?;
    set_check_text_if_present(&handles.theme_light, &model.labels.theme_light).map_err(err)?;
    set_check_text_if_present(&handles.theme_dark, &model.labels.theme_dark).map_err(err)?;
    set_check_text_if_present(&handles.theme_system, &model.labels.theme_system).map_err(err)?;
    set_text_if_present(&handles.settings, &model.labels.settings).map_err(err)?;
    set_text_if_present(&handles.check_updates, &model.labels.check_updates).map_err(err)?;
    set_text_if_present(&handles.open_data_dir, &model.labels.open_data_dir).map_err(err)?;
    set_text_if_present(&handles.quit, &model.labels.quit).map_err(err)?;

    // Shortcut echo (display only; actual registration is in the global-shortcut plugin).
    handles
        .show
        .set_accelerator(model.show_accelerator.as_deref())
        .map_err(err)?;
    handles
        .new_chat
        .set_accelerator(model.new_chat_accelerator.as_deref())
        .map_err(err)?;

    // Theme checkmarks (unknown values do not update, to avoid clearing all three checks).
    match model.theme.as_str() {
        "light" | "dark" | "system" => {
            handles
                .theme_light
                .set_checked(model.theme == "light")
                .map_err(err)?;
            handles
                .theme_dark
                .set_checked(model.theme == "dark")
                .map_err(err)?;
            handles
                .theme_system
                .set_checked(model.theme == "system")
                .map_err(err)?;
        }
        _ => {}
    }

    // Remote gateway row.
    handles
        .gateway
        .set_enabled(model.gateway_enabled)
        .map_err(err)?;

    // Dynamic submenu rebuild.
    let recent_trailing = if model.recent_truncated {
        Some((
            TRAY_RECENT_VIEW_ALL_ID,
            non_empty_or(&model.labels.recent_view_all, "View All…"),
        ))
    } else {
        None
    };
    rebuild_submenu(
        app,
        &handles.recent,
        &model.recent,
        TRAY_RECENT_PREFIX,
        false,
        recent_trailing,
    )
    .map_err(err)?;
    handles
        .recent
        .set_enabled(!model.recent.is_empty())
        .map_err(err)?;

    rebuild_submenu(
        app,
        &handles.workspaces,
        &model.workspaces,
        TRAY_WORKSPACE_PREFIX,
        true,
        None,
    )
    .map_err(err)?;
    handles
        .workspaces
        .set_enabled(!model.workspaces.is_empty())
        .map_err(err)?;

    let runs_trailing = if model.runs.is_empty() {
        None
    } else {
        Some((
            TRAY_RUN_STOP_ALL_ID,
            non_empty_or(&model.labels.stop_all, "Stop All"),
        ))
    };
    rebuild_submenu(
        app,
        &handles.runs,
        &model.runs,
        TRAY_RUN_PREFIX,
        false,
        runs_trailing,
    )
    .map_err(err)?;
    handles
        .runs
        .set_enabled(!model.runs.is_empty())
        .map_err(err)?;

    // Scheduled tasks are enable toggles: checkable child items (✓ = enabled), clicking flips the state.
    rebuild_submenu(
        app,
        &handles.cron,
        &model.cron,
        TRAY_CRON_PREFIX,
        true,
        None,
    )
    .map_err(err)?;
    handles
        .cron
        .set_enabled(!model.cron.is_empty())
        .map_err(err)?;

    // Tray icon auxiliary state.
    let tooltip = model.tooltip.as_deref().unwrap_or("ReactorPro");
    if let Err(error) = handles.tray_icon.set_tooltip(Some(tooltip)) {
        // Linux does not support tooltips; log only, do not fail.
        eprintln!("failed to set tray tooltip: {error}");
    }
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = handles.tray_icon.set_title(model.badge_text.as_deref()) {
            eprintln!("failed to set tray title badge: {error}");
        }
    }

    Ok(())
}

fn compose_status_line(app_version: &str, status_suffix: Option<&str>) -> String {
    let base = format!("ReactorPro {app_version}");
    match status_suffix {
        Some(suffix) if !suffix.trim().is_empty() => format!("{base} · {}", suffix.trim()),
        _ => base,
    }
}

fn non_empty_or<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value
    }
}

fn set_text_if_present(item: &MenuItem<tauri::Wry>, text: &str) -> tauri::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    item.set_text(text)
}

fn set_check_text_if_present(item: &CheckMenuItem<tauri::Wry>, text: &str) -> tauri::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    item.set_text(text)
}

fn set_submenu_text_if_present(item: &Submenu<tauri::Wry>, text: &str) -> tauri::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    item.set_text(text)
}

/// Clears and rebuilds the submenu from the model. May only be called on a thread that can safely
/// block (the IPC command thread or the main thread).
fn rebuild_submenu(
    app: &AppHandle,
    submenu: &Submenu<tauri::Wry>,
    entries: &[TrayMenuEntry],
    prefix: &str,
    checkable: bool,
    trailing: Option<(&str, &str)>,
) -> tauri::Result<()> {
    while submenu.remove_at(0)?.is_some() {}

    for entry in entries.iter().take(TRAY_SUBMENU_MAX_ENTRIES) {
        let id = format!("{prefix}{}", entry.id);
        let label = sanitize_menu_label(&entry.label, TRAY_LABEL_MAX_WIDTH);
        if checkable {
            let item = CheckMenuItem::with_id(app, id, label, true, entry.checked, None::<&str>)?;
            submenu.append(&item)?;
        } else {
            let item = MenuItem::with_id(app, id, label, true, None::<&str>)?;
            submenu.append(&item)?;
        }
    }

    if let Some((trailing_id, trailing_label)) = trailing {
        if !entries.is_empty() {
            submenu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        let item = MenuItem::with_id(
            app,
            trailing_id,
            sanitize_menu_label(trailing_label, TRAY_LABEL_MAX_WIDTH),
            true,
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }

    Ok(())
}

/// Uniform sanitization before user data enters the menu: control/zero-width characters become
/// spaces and are collapsed, truncated by display width (wide characters count as 2 half-widths),
/// and `&`→`&&` (Windows mnemonic; on macOS muda's strip_mnemonic removes a bare `&`, so after
/// escaping it displays as-is).
pub(crate) fn sanitize_menu_label(text: &str, max_width: usize) -> String {
    let mut cleaned = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        let is_space = c.is_whitespace() || c.is_control() || c == '\u{200B}';
        if is_space {
            if !cleaned.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            cleaned.push(' ');
            pending_space = false;
        }
        cleaned.push(c);
    }

    let mut out = String::new();
    let mut width = 0usize;
    let mut truncated = false;
    for c in cleaned.chars() {
        let w = char_display_width(c);
        if width + w > max_width {
            truncated = true;
            break;
        }
        width += w;
        out.push(c);
    }
    if truncated {
        while out.ends_with(' ') {
            out.pop();
        }
        out.push('…');
    }
    if out.is_empty() {
        out.push('—');
    }

    out.replace('&', "&&")
}

/// Common wide-character ranges (CJK/fullwidth/Hangul/Kana) count as 2, everything else as 1.
/// Sufficient for tray truncation; full UAX#11 coverage is not attempted.
fn char_display_width(c: char) -> usize {
    let cp = c as u32;
    match cp {
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1FAFF
        | 0x20000..=0x3FFFD => 2,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_escapes_windows_mnemonic_ampersand() {
        assert_eq!(sanitize_menu_label("Fix & ship", 40), "Fix && ship");
        assert_eq!(sanitize_menu_label("a && b", 40), "a &&&& b");
    }

    #[test]
    fn sanitize_strips_control_chars_and_collapses_whitespace() {
        assert_eq!(
            sanitize_menu_label("First line\nSecond line\tend  ", 40),
            "First line Second line end"
        );
        assert_eq!(sanitize_menu_label("\u{200B}a\u{0007}b", 40), "a b");
    }

    #[test]
    fn sanitize_truncates_by_display_width_with_cjk_as_double() {
        // 10 double-width characters = width 20; upper bound 10 -> 5 characters + ellipsis.
        assert_eq!(
            sanitize_menu_label("ａｂｃｄｅｆｇｈｉｊ", 10),
            "ａｂｃｄｅ…"
        );
        // ASCII counts as 1.
        assert_eq!(sanitize_menu_label("abcdefghij", 5), "abcde…");
        // No truncation when under the limit.
        assert_eq!(sanitize_menu_label("abc", 5), "abc");
    }

    #[test]
    fn sanitize_empty_input_falls_back_to_dash() {
        assert_eq!(sanitize_menu_label("", 10), "—");
        assert_eq!(sanitize_menu_label("  \n\t ", 10), "—");
    }

    #[test]
    fn sanitize_truncation_before_escape_keeps_width_semantics() {
        // & counts as 1 half-width during truncation; escaping happens after truncation.
        assert_eq!(sanitize_menu_label("a&bcdef", 3), "a&&b…");
    }

    #[test]
    fn tray_menu_model_deserializes_from_camel_case_json() {
        let model: TrayMenuModel = serde_json::from_value(serde_json::json!({
            "labels": { "newChat": "New Chat", "openDataDir": "Open Data Folder" },
            "statusSuffix": "Remote connected",
            "recent": [{ "id": "c1", "label": "Conversation A" }],
            "recentTruncated": true,
            "workspaces": [{ "id": "w1", "label": "Default project", "checked": true }],
            "runs": [],
            "cron": [{ "id": "t1", "label": "Nightly build" }],
            "theme": "dark",
            "gatewayEnabled": true,
            "newChatAccelerator": "Ctrl+Shift+KeyN",
            "tooltip": "ReactorPro · Idle",
            "badgeText": null
        }))
        .expect("model should deserialize");

        assert_eq!(model.labels.new_chat, "New Chat");
        assert_eq!(model.labels.open_data_dir, "Open Data Folder");
        assert_eq!(model.status_suffix.as_deref(), Some("Remote connected"));
        assert_eq!(model.recent.len(), 1);
        assert!(model.recent_truncated);
        assert!(model.workspaces[0].checked);
        assert_eq!(model.theme, "dark");
        assert!(model.gateway_enabled);
        assert_eq!(
            model.new_chat_accelerator.as_deref(),
            Some("Ctrl+Shift+KeyN")
        );
        assert!(model.badge_text.is_none());
        // Absent fields fall back to defaults.
        assert!(model.labels.show.is_empty());
        assert!(model.show_accelerator.is_none());
    }

    #[test]
    fn compose_status_line_appends_suffix_only_when_non_empty() {
        assert_eq!(compose_status_line("1.3.0", None), "ReactorPro 1.3.0");
        assert_eq!(compose_status_line("1.3.0", Some("  ")), "ReactorPro 1.3.0");
        assert_eq!(
            compose_status_line("1.3.0", Some("Remote connected")),
            "ReactorPro 1.3.0 · Remote connected"
        );
    }
}
