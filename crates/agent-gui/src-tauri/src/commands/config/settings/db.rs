fn now_ms() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    duration.as_millis() as i64
}

static SCHEMA_INITIALIZED: OnceLock<()> = OnceLock::new();
static SCHEMA_INITIALIZE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn config_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Unable to locate the user directory".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config directory: {e}"))?;
    Ok(dir)
}

fn default_project_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?.join(DEFAULT_PROJECT_DIRNAME);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create the default work directory: {e}"))?;
    Ok(dir)
}

fn default_project_workdir() -> Result<String, String> {
    Ok(default_project_dir()?.to_string_lossy().into_owned())
}

pub(crate) fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS provider_settings (
            provider_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS system_settings (
            setting_key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_settings (
            server_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_prompt_templates (
            template_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            prompt TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ssh_settings (
            host_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            username TEXT NOT NULL,
            auth_type TEXT NOT NULL,
            password TEXT NOT NULL,
            password_configured INTEGER NOT NULL DEFAULT 0,
            private_key TEXT NOT NULL,
            private_key_path TEXT NOT NULL,
            private_key_configured INTEGER NOT NULL DEFAULT 0,
            private_key_passphrase TEXT NOT NULL DEFAULT '',
            private_key_passphrase_configured INTEGER NOT NULL DEFAULT 0,
            proxy_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ssh_project_host_associations (
            project_path_key TEXT PRIMARY KEY,
            host_ids_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ssh_known_hosts (
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            key_type TEXT NOT NULL,
            key_base64 TEXT NOT NULL,
            fingerprint_sha256 TEXT NOT NULL,
            trusted_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (host, port)
        );
        CREATE TABLE IF NOT EXISTS remote_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_failover_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        -- WebDAV sync config. Keeping it as its own table is deliberate: see the
        -- comment on BACKUP_SYNC_SETTINGS_TABLE in mod.rs.
        CREATE TABLE IF NOT EXISTS backup_sync_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tunnel_settings (
            tunnel_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_root_grants (
            grant_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            project_path_key TEXT NOT NULL,
            alias TEXT NOT NULL,
            display_path TEXT NOT NULL,
            canonical_path TEXT NOT NULL,
            access_mode TEXT NOT NULL CHECK (access_mode IN ('read', 'write')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (project_id, alias),
            UNIQUE (project_id, canonical_path)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_root_grants_project
            ON workspace_root_grants (project_id);
        -- The 'agent' login method has been removed; legacy configs fall back to
        -- password login (consistent with the frontend normalize fallback for unknown values).
        UPDATE ssh_settings SET auth_type = 'password' WHERE auth_type = 'agent';
        ",
    )
    .map_err(|e| format!("Failed to initialize settings tables: {e}"))?;
    Ok(())
}

pub(crate) fn config_db_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(DB_FILENAME))
}

pub(crate) fn open_db() -> Result<Connection, String> {
    let db_path = config_db_path()?;
    let mut conn = Connection::open(db_path).map_err(|e| format!("Failed to open settings database: {e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Failed to set SQLite busy_timeout: {e}"))?;
    if SCHEMA_INITIALIZED.get().is_none() {
        let _guard = SCHEMA_INITIALIZE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if SCHEMA_INITIALIZED.get().is_none() {
            initialize_schema(&conn)?;
            ensure_remote_agent_id(&mut conn)?;
            let _ = SCHEMA_INITIALIZED.set(());
        }
    }
    Ok(conn)
}
