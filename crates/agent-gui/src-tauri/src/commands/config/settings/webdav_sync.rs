// WebDAV sync orchestration: settings storage + upload/download commands.
//
// Layering: this file only does orchestration and validation; all HTTP details live in `services/webdav.rs`.
// Snapshot collection/validation/application reuses `backup_snapshot.rs`, the same code path as local import/export.

/// Version directory of the remote layout. When the protocol or schema evolves incompatibly, switch directories
/// so old and new clients each read their own, rather than corrupting the same file for one another.
const WEBDAV_LAYOUT_DIR: &str = "v1";
/// Manifest size cap: it is only a few hundred bytes, so 1 MiB is already a very loose upper bound.
const WEBDAV_MANIFEST_MAX_BYTES: usize = 1024 * 1024;
/// Config size cap, kept consistent with the local import limit.
const WEBDAV_CONFIG_MAX_BYTES: usize = 16 * 1024 * 1024;
const WEBDAV_MANIFEST_FILENAME: &str = "manifest.json";
const WEBDAV_CONFIG_FILENAME: &str = "config.json";
const WEBDAV_DEFAULT_PROFILE: &str = "default";
const WEBDAV_DEFAULT_REMOTE_DIR: &str = "liveagent";

/// Sync configuration.
///
/// Stored in a separate table `backup_sync_settings`, **not part of the config snapshot** -- it is device-level;
/// letting it travel with snapshots would let machine A's credentials overwrite machine B's, creating a loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// Remote root directory, relative to url.
    #[serde(default = "default_backup_remote_dir")]
    pub remote_dir: String,
    /// Isolation of multiple config sets under the same account (e.g. work / personal).
    #[serde(default = "default_backup_profile")]
    pub profile: String,
    /// Auto-sync switch (**auto upload only, never auto download**).
    #[serde(default)]
    pub auto_sync: bool,
    /// Time of the most recent successful sync (milliseconds).
    #[serde(default)]
    pub last_sync_at: Option<i64>,
    /// Failure reason of the most recent **automatic** sync.
    ///
    /// Only the automatic path is recorded: manual sync success/failure is reported right away by the
    /// command return value since the user is at the screen and needs no trace. Automatic sync happens in the
    /// background, when the user is mostly not on the settings page; if the error lived only in frontend state
    /// it would be lost as soon as the page unmounts, and the user would never know their config had long stopped syncing.
    ///
    /// Equivalent to cc-switch's `last_error` + `last_error_source == "auto"`:
    /// we only write this field on the automatic entry point, so the source is implied by "the field has a value".
    #[serde(default)]
    pub last_error: Option<String>,
}

fn default_backup_remote_dir() -> String {
    WEBDAV_DEFAULT_REMOTE_DIR.to_string()
}

fn default_backup_profile() -> String {
    WEBDAV_DEFAULT_PROFILE.to_string()
}

impl Default for BackupSyncConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            username: String::new(),
            password: String::new(),
            remote_dir: default_backup_remote_dir(),
            profile: default_backup_profile(),
            auto_sync: false,
            last_sync_at: None,
            last_error: None,
        }
    }
}

/// Save request. Separating password from passwordTouched lets the UI show a masked placeholder
/// without sending the real password back to the frontend -- when the user has not touched the password field,
/// the backend reuses the old value from the database.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfigRequest {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub password_touched: bool,
    #[serde(default = "default_backup_remote_dir")]
    pub remote_dir: String,
    #[serde(default = "default_backup_profile")]
    pub profile: String,
    #[serde(default)]
    pub auto_sync: bool,
}

/// Config view returned to the frontend: **contains no password**, only reports whether one is set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfigView {
    pub url: String,
    pub username: String,
    pub has_password: bool,
    pub remote_dir: String,
    pub profile: String,
    pub auto_sync: bool,
    pub last_sync_at: Option<i64>,
    /// Failure reason of the most recent automatic sync; None on success or if it never failed.
    pub last_error: Option<String>,
}

/// Summary of the remote backup, shown in the confirmation dialog before upload/download.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRemoteInfo {
    pub manifest: BackupManifest,
    pub size: usize,
    pub sha256: String,
}

/// Remote manifest: on top of the export manifest it carries the size and digest of config.json,
/// used to verify integrity after download (a PUT may be interrupted, leaving a truncated config.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupRemoteManifest {
    #[serde(flatten)]
    manifest: BackupManifest,
    #[serde(default)]
    size: usize,
    #[serde(default)]
    sha256: String,
}

impl From<BackupSyncConfig> for BackupSyncConfigView {
    fn from(config: BackupSyncConfig) -> Self {
        Self {
            url: config.url,
            username: config.username,
            has_password: !config.password.is_empty(),
            remote_dir: config.remote_dir,
            profile: config.profile,
            auto_sync: config.auto_sync,
            last_sync_at: config.last_sync_at,
            last_error: config.last_error,
        }
    }
}

/// Serialize all remote reads and writes.
///
/// An upload is a two-step "PUT config -> PUT manifest"; running concurrently would make the two files come from
/// different snapshots, and the sha256 check on the download side would fail.
fn backup_sync_mutex() -> &'static tokio::sync::Mutex<()> {
    static MUTEX: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    MUTEX.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Sanitize a remote path: strip leading/trailing slashes and drop `.` / `..` segments.
///
/// `join_url` percent-encodes segment by segment, and neither `.` nor `..` are in the escape set, so they stay
/// as-is in the URL path and are resolved by the server as relative paths. If a user enters `../../etc` in
/// "remote directory", the request lands outside the WebDAV root -- on upload that PUTs all plaintext API keys to
/// an unexpected path, and on download it reads back from an unexpected path and applies it as config.
fn sanitize_remote_path(raw: &str) -> String {
    raw.split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_backup_sync_config(mut config: BackupSyncConfig) -> BackupSyncConfig {
    config.url = config.url.trim().trim_end_matches('/').to_string();
    config.username = config.username.trim().to_string();
    config.remote_dir = sanitize_remote_path(&config.remote_dir);
    if config.remote_dir.is_empty() {
        config.remote_dir = default_backup_remote_dir();
    }
    config.profile = sanitize_remote_path(&config.profile);
    if config.profile.is_empty() {
        config.profile = default_backup_profile();
    }
    config
}

pub(crate) fn load_backup_sync_config(conn: &Connection) -> Result<BackupSyncConfig, String> {
    let payload_json = conn
        .query_row(
            &format!(
                "SELECT payload_json FROM {BACKUP_SYNC_SETTINGS_TABLE} WHERE config_id = 'default'"
            ),
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("failed to read {BACKUP_SYNC_SETTINGS_TABLE}: {e}"))?;

    let Some(raw) = payload_json else {
        return Ok(BackupSyncConfig::default());
    };
    let value = parse_json(&raw, BACKUP_SYNC_SETTINGS_TABLE)?;
    let config = serde_json::from_value::<BackupSyncConfig>(value)
        .map_err(|e| format!("failed to parse sync config: {e}"))?;
    Ok(normalize_backup_sync_config(config))
}

fn persist_backup_sync_config(
    conn: &Connection,
    config: &BackupSyncConfig,
) -> Result<(), String> {
    let payload = serde_json::to_value(config)
        .map_err(|e| format!("failed to serialize {BACKUP_SYNC_SETTINGS_TABLE}: {e}"))?;
    conn.execute(
        &format!(
            "INSERT INTO {BACKUP_SYNC_SETTINGS_TABLE} (config_id, payload_json, updated_at)
             VALUES ('default', ?1, ?2)
             ON CONFLICT(config_id) DO UPDATE SET
               payload_json = excluded.payload_json,
               updated_at = excluded.updated_at"
        ),
        params![
            serialize_json(&payload, BACKUP_SYNC_SETTINGS_TABLE)?,
            now_ms()
        ],
    )
    .map_err(|e| format!("failed to write {BACKUP_SYNC_SETTINGS_TABLE}: {e}"))?;
    Ok(())
}

/// Resolve a save request into the full config: when the password was not touched, backfill the old value from the DB.
///
/// This is a real pitfall cc-switch hit -- after the UI fills the password field with a masked placeholder and
/// submits it as-is, the placeholder gets written to the DB as the new password, and the user's next sync fails authentication.
pub(crate) fn resolve_backup_sync_config(
    request: BackupSyncConfigRequest,
    persisted: &BackupSyncConfig,
) -> BackupSyncConfig {
    let password = if request.password_touched {
        request.password
    } else {
        persisted.password.clone()
    };
    normalize_backup_sync_config(BackupSyncConfig {
        url: request.url,
        username: request.username,
        password,
        remote_dir: request.remote_dir,
        profile: request.profile,
        auto_sync: request.auto_sync,
        // Saving the config does not change the sync time.
        last_sync_at: persisted.last_sync_at,
        // But clear the old auto-sync error: the user just changed the config, and that error described the
        // state before the change; leaving it up would suggest the new config is broken too. The next auto-sync
        // rewrites the real result.
        last_error: None,
    })
}

/// Remote directory segments: `{remote_dir}/v1/{profile}/`.
///
/// The version segment sits in the middle rather than outermost, so what the user sees in a WebDAV client is a
/// clean `liveagent/` top-level directory, subdivided internally by version and profile.
fn backup_remote_segments(config: &BackupSyncConfig) -> Vec<&str> {
    vec![
        config.remote_dir.as_str(),
        WEBDAV_LAYOUT_DIR,
        config.profile.as_str(),
    ]
}

fn backup_remote_file_segments<'a>(config: &'a BackupSyncConfig, filename: &'a str) -> Vec<&'a str> {
    let mut segments = backup_remote_segments(config);
    segments.push(filename);
    segments
}

fn backup_sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn backup_credentials(config: &BackupSyncConfig) -> Result<crate::services::webdav::WebdavCredentials, String> {
    if config.url.is_empty() {
        return Err("Please enter the WebDAV server address first".to_string());
    }
    if config.username.is_empty() {
        return Err("Please enter the WebDAV username first".to_string());
    }
    if config.password.is_empty() {
        return Err("Please enter the WebDAV password first".to_string());
    }
    Ok(crate::services::webdav::WebdavCredentials {
        base_url: config.url.clone(),
        username: config.username.clone(),
        password: config.password.clone(),
    })
}

/// Verify that the downloaded config matches the size/digest declared in the manifest.
///
/// A PUT may be interrupted, leaving a truncated config.json; without this check the incomplete config would be
/// written into the local DB as a valid snapshot.
///
/// Missing fields are always treated as corruption, **never skipped**. This used to let size==0 / sha256=="" pass,
/// justified as "compatible with manifests written by older versions" -- but the `v1/` layout was introduced
/// together with this feature, so there is no historical version that wrote a manifest without a digest. The only
/// data that actually hits this branch is abnormal: truncated PUTs, manifests rewritten by another client.
/// Letting them pass would let them bypass the integrity check straight into the local DB.
pub(crate) fn verify_backup_payload(
    body: &[u8],
    expected_size: usize,
    expected_sha256: &str,
) -> Result<(), String> {
    if expected_size == 0 || expected_sha256.is_empty() {
        return Err(
            "The remote backup metadata is missing a size or checksum, so the config cannot be confirmed complete; please re-upload from the source device"
                .to_string(),
        );
    }
    if body.len() != expected_size {
        return Err(format!(
            "Remote config size check failed: expected {expected_size} bytes, got {} bytes. The remote file may not have uploaded completely; please re-upload from the source device",
            body.len()
        ));
    }
    let actual = backup_sha256_hex(body);
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err("Remote config checksum mismatch; the file may be corrupted, please re-upload from the source device".to_string());
    }
    Ok(())
}

fn load_backup_sync_config_from_db() -> Result<BackupSyncConfig, String> {
    let conn = open_db()?;
    load_backup_sync_config(&conn)
}

/// Record a successful sync: write the timestamp and clear any leftover auto-sync error banner.
fn touch_backup_last_sync_at() -> Result<i64, String> {
    let timestamp = now_ms();
    let conn = open_db()?;
    let mut config = load_backup_sync_config(&conn)?;
    config.last_sync_at = Some(timestamp);
    // A successful manual sync also clears the error: since this path now works, that old error is stale.
    config.last_error = None;
    persist_backup_sync_config(&conn, &config)?;
    Ok(timestamp)
}

/// Record a failed **automatic** sync.
///
/// Best-effort: if the DB write itself fails we can only give up -- the caller is already on an error path, and
/// throwing another error would be handled by no one while masking the real failure reason.
fn record_backup_auto_sync_error(message: &str) {
    let Ok(conn) = open_db() else { return };
    let Ok(mut config) = load_backup_sync_config(&conn) else {
        return;
    };
    config.last_error = Some(message.to_string());
    let _ = persist_backup_sync_config(&conn, &config);
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn settings_backup_load_sync_config() -> Result<BackupSyncConfigView, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(load_backup_sync_config_from_db()?.into()))
        .await
        .map_err(|e| format!("settings_backup_load_sync_config join failed: {e}"))?
}

#[tauri::command]
pub async fn settings_backup_save_sync_config(
    config: BackupSyncConfigRequest,
) -> Result<BackupSyncConfigView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        let persisted = load_backup_sync_config(&conn)?;
        let resolved = resolve_backup_sync_config(config, &persisted);
        persist_backup_sync_config(&conn, &resolved)?;
        Ok(resolved.into())
    })
    .await
    .map_err(|e| format!("settings_backup_save_sync_config join failed: {e}"))?
}

/// Test the connection. Uses the config already saved in the DB, so the frontend must save before testing.
#[tauri::command]
pub async fn settings_backup_test_sync_connection() -> Result<(), String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("settings_backup_test_sync_connection join failed: {e}"))??;
    let creds = backup_credentials(&config)?;
    crate::services::webdav::test_connection(&creds).await
}

/// Fetch the remote summary. Returns None when the remote has no backup yet.
#[tauri::command]
pub async fn settings_backup_fetch_remote_info() -> Result<Option<BackupRemoteInfo>, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("settings_backup_fetch_remote_info join failed: {e}"))??;
    let creds = backup_credentials(&config)?;
    let _guard = backup_sync_mutex().lock().await;

    let segments = backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME);
    let Some(body) = crate::services::webdav::get_bytes(
        &creds,
        &segments,
        WEBDAV_MANIFEST_MAX_BYTES,
        "remote backup metadata",
    )
    .await?
    else {
        return Ok(None);
    };

    let remote = parse_backup_remote_manifest(&body)?;
    Ok(Some(BackupRemoteInfo {
        manifest: remote.manifest,
        size: remote.size,
        sha256: remote.sha256,
    }))
}

pub(crate) fn parse_backup_remote_manifest(body: &[u8]) -> Result<BackupRemoteManifest, String> {
    let text = std::str::from_utf8(body)
        .map_err(|_| "Remote backup metadata is not valid UTF-8 text".to_string())?;
    let remote = serde_json::from_str::<BackupRemoteManifest>(text)
        .map_err(|e| format!("failed to parse remote backup metadata: {e}"))?;
    validate_backup_manifest(&remote.manifest)?;
    Ok(remote)
}

/// Upload: collect -> create directories -> **PUT config first, then PUT manifest**.
///
/// The order is intentional. The manifest is the signal that "this backup is usable", so it is written last; if the
/// process fails midway the remote is left with an old manifest + new config, and the sha256 check on the download
/// side catches the mismatch instead of applying it as valid data.
///
/// **The lock must be acquired before collection.** The reverse (collect first, lock later) opens a window: a
/// manual download could squeeze entirely between collection and the PUT, so this upload would overwrite the remote
/// with the pre-download old snapshot, silently clobbering the remote config the user just pulled with their own
/// machine. A suppression guard cannot stop this -- it only blocks dirty flags created during a download, not an
/// upload that has already collected its snapshot and is sitting on the lock.
async fn upload_backup_snapshot() -> Result<i64, String> {
    let _guard = backup_sync_mutex().lock().await;

    let (config, document) = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        let config = load_backup_sync_config(&conn)?;
        let snapshot = collect_backup_snapshot(&conn)?;
        let manifest = build_backup_manifest(&snapshot);
        let document = serialize_backup_document(&snapshot, &manifest)?;
        Ok::<_, String>((config, (document, manifest)))
    })
    .await
    .map_err(|e| format!("settings_backup_upload join failed: {e}"))??;
    let (document, manifest) = document;

    let creds = backup_credentials(&config)?;

    let body = document.into_bytes();
    let remote_manifest = BackupRemoteManifest {
        manifest,
        size: body.len(),
        sha256: backup_sha256_hex(&body),
    };
    let manifest_body = serde_json::to_vec_pretty(&remote_manifest)
        .map_err(|e| format!("failed to serialize remote backup metadata: {e}"))?;

    crate::services::webdav::ensure_remote_dirs(&creds, &backup_remote_segments(&config)).await?;
    crate::services::webdav::put_bytes(
        &creds,
        &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME),
        body,
        "application/json",
    )
    .await?;
    crate::services::webdav::put_bytes(
        &creds,
        &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME),
        manifest_body,
        "application/json",
    )
    .await?;

    tauri::async_runtime::spawn_blocking(touch_backup_last_sync_at)
        .await
        .map_err(|e| format!("settings_backup_upload join failed: {e}"))?
}

#[tauri::command]
pub async fn settings_backup_upload() -> Result<i64, String> {
    upload_backup_snapshot().await
}

/// Upload entry point for auto-sync.
///
/// Differs from a manual upload in two ways:
/// 1. If the switch is off or credentials are incomplete, skip silently -- the automatic path should not pop errors
///    repeatedly just because the user has not configured WebDAV.
/// 2. Failures are persisted (`last_error`). The user is most likely not on the settings page right now; relying on
///    event push alone, the error would vanish as soon as the page unmounts, leaving the user unaware that config
///    had long stopped syncing.
pub(crate) async fn auto_upload_backup_snapshot() -> Result<Option<i64>, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("auto_upload_backup_snapshot join failed: {e}"))??;
    if !config.auto_sync || backup_credentials(&config).is_err() {
        return Ok(None);
    }
    match upload_backup_snapshot().await {
        Ok(timestamp) => Ok(Some(timestamp)),
        Err(error) => {
            let message = error.clone();
            // Persisting goes on a blocking thread to avoid synchronous SQLite IO in an async context.
            let _ = tauri::async_runtime::spawn_blocking(move || {
                record_backup_auto_sync_error(&message);
            })
            .await;
            Err(error)
        }
    }
}

/// Download: pull manifest -> pull config -> verify size+sha256 -> apply snapshot.
///
/// **The global lock is held throughout**, including while applying the snapshot. Applying writes to several config
/// domains separately, and the intermediate state is inconsistent; if an auto-upload then acquired the lock and
/// started collecting a snapshot, what it uploaded would be half old and half new. The suppression guard is
/// acquired under the lock and released with the blocking task, matching cc-switch's `run_with_webdav_lock` order.
#[tauri::command]
pub async fn settings_backup_download() -> Result<BackupApplyOutcome, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("settings_backup_download join failed: {e}"))??;
    let creds = backup_credentials(&config)?;

    let _guard = backup_sync_mutex().lock().await;

    let Some(manifest_body) = crate::services::webdav::get_bytes(
        &creds,
        &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME),
        WEBDAV_MANIFEST_MAX_BYTES,
        "remote backup metadata",
    )
    .await?
    else {
        return Err("There is no backup on the remote yet; please upload once from any device first".to_string());
    };
    // The manifest's version compatibility is already validated during parse; an incompatible one aborts here.
    let remote = parse_backup_remote_manifest(&manifest_body)?;

    let Some(body) = crate::services::webdav::get_bytes(
        &creds,
        &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME),
        WEBDAV_CONFIG_MAX_BYTES,
        "remote config",
    )
    .await?
    else {
        return Err("Remote metadata exists but the config file is missing; please re-upload from the source device".to_string());
    };
    verify_backup_payload(&body, remote.size, &remote.sha256)?;
    let document =
        String::from_utf8(body).map_err(|_| "Remote config is not valid UTF-8 text".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        // Applying the snapshot goes through each domain's save_*, all of which mark dirty.
        // Without suppression it would push the just-pulled remote data right back.
        let _suppression = crate::services::webdav_auto_sync::suppress();
        let (snapshot, _) = parse_backup_document(&document)?;
        let mut conn = open_db()?;
        let outcome = apply_backup_snapshot(&mut conn, snapshot)?;
        // A failed timestamp write must **not** overturn a restore already committed to the DB. The snapshot is
        // committed at this point, so returning Err here would send the frontend down the catch branch: the restore
        // notice becomes an error notice, and `syncStateAfterRestore`, which reloads the frontend store, would not
        // run -- memory would still hold the pre-restore old config, and the next edit to any domain would write it
        // all back to the DB. The user would see "restore errored and the config really did not change" while the
        // DB had already been modified. last_sync_at is only display metadata; losing it is far less serious than
        // losing the restore result.
        let _ = touch_backup_last_sync_at();
        Ok(outcome)
    })
    .await
    .map_err(|e| format!("settings_backup_download join failed: {e}"))?
}
