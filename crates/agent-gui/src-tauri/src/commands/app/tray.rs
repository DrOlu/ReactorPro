use std::sync::Arc;

use crate::services::tray::{apply_tray_menu, TrayMenuHandles, TrayMenuModel};

/// Push the tray menu model from the frontend (localized labels + dynamic list + state).
/// The single write entry point for tray content; apply internally proxies to the
/// main thread through the menu handles.
#[tauri::command(rename_all = "snake_case")]
pub async fn app_tray_menu_sync(
    app: tauri::AppHandle,
    model: TrayMenuModel,
    handles: tauri::State<'_, Arc<TrayMenuHandles>>,
) -> Result<(), String> {
    apply_tray_menu(&app, &handles, model)
}
