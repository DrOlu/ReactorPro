// Local import/export commands for configuration backups.
//
// File dialogs go through rfd (the same pattern as system_pick_file) rather than
// pulling in tauri-plugin-dialog / plugin-fs -- the repository does not have
// either plugin installed.
//
// Export and write happen within the same command (the file is written to disk
// immediately after the user picks a path), so the one-shot save_token mechanism
// used by system_prepare_preview_file_save_sync is not needed.

/// Export: opens a save dialog and writes the file. Returns None if the user cancels.
#[tauri::command]
pub async fn settings_backup_export() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        let snapshot = collect_backup_snapshot(&conn)?;
        let manifest = build_backup_manifest(&snapshot);
        let document = serialize_backup_document(&snapshot, &manifest)?;

        let default_name = format!("liveagent-config-{}.json", now_ms());
        let Some(target) = rfd::FileDialog::new()
            .set_file_name(&default_name)
            .add_filter("ReactorPro configuration", &["json"])
            .save_file()
        else {
            return Ok(None);
        };

        fs::write(&target, document).map_err(|e| format!("Failed to write backup file: {e}"))?;
        Ok(Some(target.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("settings_backup_export join failed: {e}"))?
}

/// Import pre-check: pick a file -> parse -> validate, but do **not write to the database**.
///
/// Splitting this into peek/apply lets the user see the source summary and confirm
/// before overwriting their local configuration.
/// When path is empty, a pick dialog is shown; returns None if the user cancels.
#[tauri::command]
pub async fn settings_backup_peek_import(
    path: Option<String>,
) -> Result<Option<BackupImportPreview>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = match path {
            Some(value) => PathBuf::from(value),
            None => {
                let Some(picked) = rfd::FileDialog::new()
                    .add_filter("ReactorPro configuration", &["json"])
                    .pick_file()
                else {
                    return Ok(None);
                };
                picked
            }
        };

        let raw = read_backup_file(&target)?;
        let (_, manifest) = parse_backup_document(&raw)?;
        Ok(Some(BackupImportPreview {
            path: target.to_string_lossy().into_owned(),
            manifest,
        }))
    })
    .await
    .map_err(|e| format!("settings_backup_peek_import join failed: {e}"))?
}

/// Import apply: actually writes to the database. The current configuration is
/// automatically backed up before writing.
///
/// **Shares the global lock with WebDAV.** Import writes to several configuration
/// domains separately, and the intermediate state is not self-consistent; without
/// the lock, an automatic upload could take its snapshot exactly halfway through
/// and push a half-old, half-new configuration to the remote, where it would pass
/// all the download-side checks with a self-consistent sha256.
/// This closes the same window as hoisting the lock before collection in
/// `upload_backup_snapshot`.
///
/// The suppression guard is **deliberately omitted** here: an import is the user
/// explicitly asking for this configuration to become the current one, and having
/// it automatically sync up afterwards is exactly the expected behavior (the
/// opposite of a WebDAV download -- there the data already came from the remote,
/// so pushing it back is pure echo).
#[tauri::command]
pub async fn settings_backup_apply_import(path: String) -> Result<BackupApplyOutcome, String> {
    let _guard = backup_sync_mutex().lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let target = PathBuf::from(path);
        let raw = read_backup_file(&target)?;
        let (snapshot, _) = parse_backup_document(&raw)?;
        let mut conn = open_db()?;
        apply_backup_snapshot(&mut conn, snapshot)
    })
    .await
    .map_err(|e| format!("settings_backup_apply_import join failed: {e}"))?
}
