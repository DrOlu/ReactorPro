// Config backup snapshot: capture / validate / apply.
//
// The carrier deliberately uses "JSON aggregated by domain" rather than a whole-database SQL dump
// -- the latter would hand untrusted SQL to SQLite for execution (ATTACH DATABASE can write a file
// to any writable path), and line-by-line INSERTs during a large import would freeze the UI. This
// module moves payloads for the five domains providers / mcp / system / agents / model_failover;
// the system domain carries only portable preferences, and device-local state such as workdir,
// workspace paths, and the system proxy does not enter the snapshot (see
// SYSTEM_PORTABLE_BACKUP_KEYS).
//
// Another pitfall on the import side is the provider id: it is a locally randomly generated UUID on
// each device, while chat sessions, the default model, memory, and scheduled tasks all reference it
// as {customProviderId, model}. Before a whole-domain overwrite, backup providers are mapped back
// to local ids by identity (see build_provider_id_map), so local references do not all break after
// import.

/// Carrier format version. Incremented when the manifest structure itself changes.
pub(crate) const BACKUP_PROTOCOL_VERSION: u32 = 1;
/// Config domain schema version. Incremented when a domain payload structure evolves incompatibly.
///
/// v2: removed the skills domain (syncing only the enabled toggle is meaningless; the skills
/// themselves live on disk); added the agents / modelFailover domains; narrowed the system domain to
/// portable preferences.
/// v1 backups can still be imported: the skills field is ignored and device-local keys in system
/// are filtered out.
pub(crate) const BACKUP_SCHEMA_VERSION: u32 = 2;

/// Portable preferences that travel with the snapshot in the system domain.
///
/// system keys outside the whitelist (workdir, workspaceProjects and its derived keys, systemProxy)
/// are device-local state: absolute paths most likely do not exist on another machine, and the proxy
/// configuration is specific to each machine / network environment. They are filtered at capture
/// time, and at apply time only these keys are overwritten while everything else keeps the local
/// value.
const SYSTEM_PORTABLE_BACKUP_KEYS: &[&str] = &[
    SYSTEM_EXECUTION_MODE_KEY,
    SYSTEM_TOOL_POLICIES_KEY,
    SYSTEM_COMMAND_SAFETY_MODE_KEY,
    SYSTEM_BROWSER_AUTOMATION_MODE_KEY,
];

/// Field name of the inline manifest in the export file.
const BACKUP_MANIFEST_FIELD: &str = "_manifest";
/// Import file size limit, to keep malformed/oversized input from exhausting memory.
const BACKUP_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Number of local backups to retain.
const BACKUP_RETENTION: usize = 10;
const BACKUP_DIRNAME: &str = "backups";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub protocol_version: u32,
    pub schema_version: u32,
    pub snapshot_id: String,
    /// RFC3339 UTC timestamp.
    pub created_at: String,
    pub device_name: String,
    pub app_version: String,
    /// Reserved: always "none" in the first version; when end-to-end encryption is introduced later,
    /// this field changes without breaking the format.
    #[serde(default = "default_backup_encryption")]
    pub encryption: String,
    /// Entry counts per domain, used only for the UI summary and not part of validation.
    #[serde(default)]
    pub domains: BackupDomainCounts,
}

fn default_backup_encryption() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDomainCounts {
    #[serde(default)]
    pub providers: usize,
    #[serde(default)]
    pub mcp: usize,
    #[serde(default)]
    pub system: usize,
    #[serde(default)]
    pub agents: usize,
    #[serde(default)]
    pub model_failover: usize,
}

/// A complete config snapshot. All fields are optional: an empty domain means the exporting side had
/// no such config.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshot {
    #[serde(default)]
    pub providers: Option<Value>,
    #[serde(default)]
    pub mcp: Option<Value>,
    /// Contains only the SYSTEM_PORTABLE_BACKUP_KEYS whitelist keys.
    #[serde(default)]
    pub system: Option<Value>,
    /// Array of prompt templates, shaped like the settings_save_agents payload.
    #[serde(default)]
    pub agents: Option<Value>,
    /// Model failover config object, grouped by provider type.
    #[serde(default)]
    pub model_failover: Option<Value>,
}

/// Import preview: parsed and validated successfully but not yet written to the database, shown in
/// the confirmation dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportPreview {
    pub path: String,
    pub manifest: BackupManifest,
}

/// Result after an import/download completes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupApplyOutcome {
    pub applied: BackupDomainCounts,
    /// Path of the local backup file generated before applying.
    pub backup_path: Option<String>,
}

fn backup_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?.join(BACKUP_DIRNAME);
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create backup directory: {e}"))?;
    Ok(dir)
}

fn backup_device_name() -> String {
    hostname_label().unwrap_or_else(|| "unknown-device".to_string())
}

fn hostname_label() -> Option<String> {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// The manifest's `createdAt`: RFC3339 UTC with a fixed `Z` suffix.
///
/// Uses chrono (already a direct dependency) rather than computing the calendar by hand, consistent
/// with the existing approach in `services/memory/schema.rs`. `to_rfc3339()` would output `+00:00`,
/// so the format is specified explicitly here to keep `Z`.
fn rfc3339_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn count_domain(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        Some(Value::Object(map)) => map.len(),
        _ => 0,
    }
}

fn count_mcp_servers(value: Option<&Value>) -> usize {
    value
        .and_then(|mcp| mcp.get("servers"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

pub(crate) fn snapshot_domain_counts(snapshot: &BackupSnapshot) -> BackupDomainCounts {
    BackupDomainCounts {
        providers: count_domain(snapshot.providers.as_ref()),
        mcp: count_mcp_servers(snapshot.mcp.as_ref()),
        system: count_domain(snapshot.system.as_ref()),
        agents: count_domain(snapshot.agents.as_ref()),
        model_failover: count_domain(snapshot.model_failover.as_ref()),
    }
}

pub(crate) fn build_backup_manifest(snapshot: &BackupSnapshot) -> BackupManifest {
    BackupManifest {
        protocol_version: BACKUP_PROTOCOL_VERSION,
        schema_version: BACKUP_SCHEMA_VERSION,
        snapshot_id: Uuid::new_v4().to_string(),
        created_at: rfc3339_now(),
        device_name: backup_device_name(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        encryption: default_backup_encryption(),
        domains: snapshot_domain_counts(snapshot),
    }
}

/// Filters portable preferences out of the full system config; returns None when all are missing.
fn portable_system_subset(system: Option<Value>) -> Option<Value> {
    let map = match system {
        Some(Value::Object(map)) => map,
        _ => return None,
    };
    let portable: Map<String, Value> = map
        .into_iter()
        .filter(|(key, _)| SYSTEM_PORTABLE_BACKUP_KEYS.contains(&key.as_str()))
        .collect();
    if portable.is_empty() {
        None
    } else {
        Some(Value::Object(portable))
    }
}

/// Captures the current config. All five domains come from SQLite and require no frontend
/// involvement.
///
/// Note: the sync config (WebDAV address/credentials) is deliberately stored in the separate table
/// `backup_sync_settings` rather than in these tables -- it is device-level, and letting it travel
/// with the snapshot would let machine A's credentials overwrite machine B's, creating a loop.
pub(crate) fn collect_backup_snapshot(conn: &Connection) -> Result<BackupSnapshot, String> {
    Ok(BackupSnapshot {
        providers: load_providers(conn)?,
        mcp: load_mcp(conn)?,
        system: portable_system_subset(load_system(conn)?),
        agents: load_agents(conn)?,
        model_failover: load_model_failover(conn)?,
    })
}

/// Validates the manifest's version compatibility. Any version higher than currently supported is
/// rejected, to avoid writing unreadable data as an "empty config" and silently wiping the database.
pub(crate) fn validate_backup_manifest(manifest: &BackupManifest) -> Result<(), String> {
    if manifest.protocol_version > BACKUP_PROTOCOL_VERSION {
        return Err(format!(
            "backup file format version {} is newer than the supported {BACKUP_PROTOCOL_VERSION}; upgrade the app and retry",
            manifest.protocol_version
        ));
    }
    if manifest.schema_version > BACKUP_SCHEMA_VERSION {
        return Err(format!(
            "backup file config version {} is newer than the supported {BACKUP_SCHEMA_VERSION}; upgrade the app and retry",
            manifest.schema_version
        ));
    }
    if manifest.encryption != "none" {
        return Err(format!(
            "unsupported encryption method: {}",
            manifest.encryption
        ));
    }
    Ok(())
}

/// Structural validation: each domain must have the expected JSON shape; malformed input is rejected.
pub(crate) fn validate_backup_snapshot(snapshot: &BackupSnapshot) -> Result<(), String> {
    if let Some(providers) = &snapshot.providers {
        if !providers.is_array() {
            return Err("backup content providers must be an array".to_string());
        }
    }
    if let Some(mcp) = &snapshot.mcp {
        let mcp = mcp
            .as_object()
            .ok_or_else(|| "backup content mcp must be an object".to_string())?;
        if let Some(servers) = mcp.get("servers") {
            if !servers.is_array() {
                return Err("backup content mcp.servers must be an array".to_string());
            }
        }
        if let Some(selected) = mcp.get("selected") {
            if !selected.is_array() {
                return Err("backup content mcp.selected must be an array".to_string());
            }
        }
    }
    if let Some(system) = &snapshot.system {
        if !system.is_object() {
            return Err("backup content system must be an object".to_string());
        }
    }
    if let Some(agents) = &snapshot.agents {
        if !agents.is_array() {
            return Err("backup content agents must be an array".to_string());
        }
    }
    if let Some(model_failover) = &snapshot.model_failover {
        if !model_failover.is_object() {
            return Err("backup content modelFailover must be an object".to_string());
        }
    }
    Ok(())
}

/// Serializes to the export file content: snapshot + inline manifest, self-contained in a single
/// file.
pub(crate) fn serialize_backup_document(
    snapshot: &BackupSnapshot,
    manifest: &BackupManifest,
) -> Result<String, String> {
    let mut document = match serde_json::to_value(snapshot)
        .map_err(|e| format!("failed to serialize backup content: {e}"))?
    {
        Value::Object(map) => map,
        _ => return Err("failed to serialize backup content: expected an object".to_string()),
    };
    document.insert(
        BACKUP_MANIFEST_FIELD.to_string(),
        serde_json::to_value(manifest).map_err(|e| format!("failed to serialize backup metadata: {e}"))?,
    );
    serde_json::to_string_pretty(&Value::Object(document))
        .map_err(|e| format!("failed to serialize backup file: {e}"))
}

/// Parses the export file content and returns (snapshot, manifest). Version and structural
/// validation have already been performed.
///
/// The skills field in v1 files is ignored by serde during deserialization.
pub(crate) fn parse_backup_document(raw: &str) -> Result<(BackupSnapshot, BackupManifest), String> {
    let mut document = expect_object(
        parse_json(raw, "backup file")?,
        "backup file",
    )?;
    let manifest_value = document
        .remove(BACKUP_MANIFEST_FIELD)
        .ok_or_else(|| "backup file is missing metadata; it may not be a config exported by ReactorPro".to_string())?;
    let manifest = serde_json::from_value::<BackupManifest>(manifest_value)
        .map_err(|e| format!("failed to parse backup metadata: {e}"))?;
    validate_backup_manifest(&manifest)?;

    let snapshot = serde_json::from_value::<BackupSnapshot>(Value::Object(document))
        .map_err(|e| format!("failed to parse backup content: {e}"))?;
    validate_backup_snapshot(&snapshot)?;
    Ok((snapshot, manifest))
}

/// Reads a backup file with a size limit (untrusted input).
pub(crate) fn read_backup_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("failed to read backup file: {e}"))?;
    if metadata.len() > BACKUP_MAX_FILE_BYTES {
        return Err(format!(
            "backup file is too large ({} bytes); the limit is {BACKUP_MAX_FILE_BYTES} bytes",
            metadata.len()
        ));
    }
    fs::read_to_string(path).map_err(|e| format!("failed to read backup file: {e}"))
}

/// Before applying, backs up the current config to ~/.liveagent/backups/, keeping the most recent
/// BACKUP_RETENTION copies.
pub(crate) fn backup_current_config(conn: &Connection) -> Result<Option<String>, String> {
    let snapshot = collect_backup_snapshot(conn)?;
    let manifest = build_backup_manifest(&snapshot);
    let document = serialize_backup_document(&snapshot, &manifest)?;

    let dir = backup_dir()?;
    let filename = format!("config-{}.json", now_ms());
    let path = dir.join(filename);
    fs::write(&path, document).map_err(|e| format!("failed to write backup file: {e}"))?;
    prune_backups(&dir)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn prune_backups(dir: &Path) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("failed to read backup directory: {e}"))?;
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("config-") && name.ends_with(".json"))
        })
        .collect();
    if files.len() <= BACKUP_RETENTION {
        return Ok(());
    }
    // The filename embeds a millisecond timestamp, so lexicographic order equals chronological order.
    files.sort();
    for path in files.iter().take(files.len() - BACKUP_RETENTION) {
        // A cleanup failure must not block the main flow.
        let _ = fs::remove_file(path);
    }
    Ok(())
}

/// Overlays the portable system keys from the snapshot onto the machine's existing system config.
///
/// The snapshot's system value cannot be passed directly to save_system -- the latter DELETEs and
/// rebuilds the whole table against a fixed whitelist, missing keys get filled with defaults, and
/// the local workdir / workspace / proxy would be clobbered by defaults. Overlaying only the
/// whitelist keys also incidentally filters out device-local keys mixed into v1 backups.
fn merge_portable_system(conn: &Connection, snapshot_system: &Value) -> Result<Value, String> {
    let mut merged = match load_system(conn)? {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    if let Some(snapshot_map) = snapshot_system.as_object() {
        for key in SYSTEM_PORTABLE_BACKUP_KEYS {
            if let Some(value) = snapshot_map.get(*key) {
                merged.insert((*key).to_string(), value.clone());
            }
        }
    }
    Ok(Value::Object(merged))
}

/// Reads a string field (after trimming) from a provider object; missing or non-string yields an
/// empty string.
fn provider_string_field(provider: &Value, key: &str) -> String {
    provider
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

/// baseUrl normalization: strip leading/trailing whitespace and a trailing slash. The most common
/// divergence when two devices manually enter the same endpoint is an extra trailing `/`; more
/// aggressive normalization such as host casing is not done -- a wrong pairing would re-point local
/// references at another account, so it is better to pair fewer than to mispair.
fn normalized_provider_base_url(provider: &Value) -> String {
    provider_string_field(provider, "baseUrl")
        .trim_end_matches('/')
        .to_string()
}

/// Provider identity fingerprint, used to recognize the "same provider config" across devices.
struct ProviderIdentity {
    id: String,
    vendor: String,
    base_url: String,
    name: String,
}

fn provider_identities(providers: &[Value]) -> Vec<ProviderIdentity> {
    providers
        .iter()
        .filter_map(|provider| {
            let id = provider_string_field(provider, "id");
            if id.is_empty() {
                return None;
            }
            Some(ProviderIdentity {
                id,
                vendor: provider_string_field(provider, "type"),
                base_url: normalized_provider_base_url(provider),
                name: provider_string_field(provider, "name"),
            })
        })
        .collect()
}

/// Pairs by key among the unconsumed candidates on both sides: a key is only considered the same
/// provider when it appears exactly once on each side. When multiple candidates exist (multiple
/// accounts on the same endpoint), there is no way to tell which is which, so it is skipped -- this
/// reverts to the old "keep the source id" behavior: references break, but nothing gets misattributed.
fn match_unique_identity<K: std::hash::Hash + Eq>(
    incoming: &[ProviderIdentity],
    incoming_taken: &mut [bool],
    local: &[ProviderIdentity],
    local_taken: &mut [bool],
    id_map: &mut HashMap<String, String>,
    key_of: impl Fn(&ProviderIdentity) -> Option<K>,
) {
    let mut incoming_counts: HashMap<K, usize> = HashMap::new();
    for (index, identity) in incoming.iter().enumerate() {
        if incoming_taken[index] {
            continue;
        }
        if let Some(key) = key_of(identity) {
            *incoming_counts.entry(key).or_default() += 1;
        }
    }
    // key -> (unconsumed candidate count, last candidate index); the index is only meaningful when
    // the count is 1.
    let mut local_slots: HashMap<K, (usize, usize)> = HashMap::new();
    for (index, identity) in local.iter().enumerate() {
        if local_taken[index] {
            continue;
        }
        if let Some(key) = key_of(identity) {
            let slot = local_slots.entry(key).or_insert((0, index));
            slot.0 += 1;
            slot.1 = index;
        }
    }
    // Apply pairings in the original incoming order, so the result is independent of HashMap
    // iteration order.
    for (index, identity) in incoming.iter().enumerate() {
        if incoming_taken[index] {
            continue;
        }
        let Some(key) = key_of(identity) else {
            continue;
        };
        if incoming_counts.get(&key) != Some(&1) {
            continue;
        }
        let Some(&(count, local_index)) = local_slots.get(&key) else {
            continue;
        };
        if count != 1 || local_taken[local_index] {
            continue;
        }
        incoming_taken[index] = true;
        local_taken[local_index] = true;
        if identity.id != local[local_index].id {
            id_map.insert(identity.id.clone(), local[local_index].id.clone());
        }
    }
}

/// The provider id in a backup is a UUID randomly generated on the source device; the local chat
/// sessions, default model, memory maintenance, and scheduled tasks reference the local UUID. If the
/// source id is written as-is during a whole-domain overwrite, these references all break (silently
/// cleared during frontend normalization, forcing the user to reselect models everywhere). Before
/// import, backup providers of the "same identity" are rewritten back to the local id so references
/// survive seamlessly.
///
/// Three pairing levels, progressively looser and mutually exclusive (a successful pairing removes
/// the candidates from both sides):
/// 1. identical id -- built-in slots (builtin-*), ids derived from a same-source import, and
///    devices already synced once (both ids aligned after the previous import);
/// 2. same type + baseUrl + name, unique on both sides;
/// 3. same type + baseUrl, unique on both sides (covers the case where only the display name changed).
///
/// Levels 2/3 require a non-empty type and a unique candidate; when it cannot be determined
/// confidently, the source id is kept.
///
/// Returns source id -> local id, containing only entries where the two differ.
fn build_provider_id_map(incoming: &[Value], local: &[Value]) -> HashMap<String, String> {
    let incoming = provider_identities(incoming);
    let local = provider_identities(local);
    let mut incoming_taken = vec![false; incoming.len()];
    let mut local_taken = vec![false; local.len()];

    // Level 1: ids are directly identical, so no rewrite is needed; just mark the candidates on
    // both sides as consumed.
    let local_index_by_id: HashMap<&str, usize> = local
        .iter()
        .enumerate()
        .map(|(index, identity)| (identity.id.as_str(), index))
        .collect();
    for (index, identity) in incoming.iter().enumerate() {
        if let Some(&local_index) = local_index_by_id.get(identity.id.as_str()) {
            if !local_taken[local_index] {
                incoming_taken[index] = true;
                local_taken[local_index] = true;
            }
        }
    }

    let mut id_map = HashMap::new();
    match_unique_identity(
        &incoming,
        &mut incoming_taken,
        &local,
        &mut local_taken,
        &mut id_map,
        |identity| {
            (!identity.vendor.is_empty()).then(|| {
                (
                    identity.vendor.clone(),
                    identity.base_url.clone(),
                    identity.name.clone(),
                )
            })
        },
    );
    match_unique_identity(
        &incoming,
        &mut incoming_taken,
        &local,
        &mut local_taken,
        &mut id_map,
        |identity| {
            (!identity.vendor.is_empty())
                .then(|| (identity.vendor.clone(), identity.base_url.clone()))
        },
    );
    id_map
}

/// Applies the id map to the snapshot: providers[].id and modelFailover.*.queue[] must be rewritten
/// together, otherwise the failover queue points at a non-existent provider and is silently dropped
/// during normalization. queue supports two historical shapes: a string id and the older
/// { customProviderId, model } object.
fn rewrite_snapshot_provider_ids(snapshot: &mut BackupSnapshot, id_map: &HashMap<String, String>) {
    if id_map.is_empty() {
        return;
    }
    if let Some(Value::Array(providers)) = snapshot.providers.as_mut() {
        for provider in providers.iter_mut() {
            let Some(object) = provider.as_object_mut() else {
                continue;
            };
            let Some(source_id) = object.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Some(local_id) = id_map.get(source_id.trim()) {
                object.insert("id".to_string(), Value::String(local_id.clone()));
            }
        }
    }
    if let Some(Value::Object(failover)) = snapshot.model_failover.as_mut() {
        for settings in failover.values_mut() {
            let Some(queue) = settings.get_mut("queue").and_then(Value::as_array_mut) else {
                continue;
            };
            for entry in queue.iter_mut() {
                match entry {
                    Value::String(source_id) => {
                        if let Some(local_id) = id_map.get(source_id.trim()) {
                            *source_id = local_id.clone();
                        }
                    }
                    Value::Object(object) => {
                        let Some(source_id) =
                            object.get("customProviderId").and_then(Value::as_str)
                        else {
                            continue;
                        };
                        if let Some(local_id) = id_map.get(source_id.trim()) {
                            object.insert(
                                "customProviderId".to_string(),
                                Value::String(local_id.clone()),
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Entry point for pre-import id remapping. When the providers domain is missing there is no
/// source-side identity to pair, so it is skipped; when the machine has no providers at all there
/// are no references to preserve either, and the snapshot is stored as-is.
fn remap_snapshot_provider_ids_to_local(
    conn: &Connection,
    snapshot: &mut BackupSnapshot,
) -> Result<(), String> {
    let id_map = {
        let Some(Value::Array(incoming)) = snapshot.providers.as_ref() else {
            return Ok(());
        };
        let local = match load_providers(conn)? {
            Some(Value::Array(items)) => items,
            _ => return Ok(()),
        };
        build_provider_id_map(incoming, &local)
    };
    rewrite_snapshot_provider_ids(snapshot, &id_map);
    Ok(())
}

/// Whole-domain overwrite write (pure database write, no backup). The system domain is a "portable
/// key overlay" rather than a whole-domain overwrite; the providers domain is id-remapped before
/// writing (see build_provider_id_map).
///
/// Each domain reuses the existing `save_*`, which each open their own transaction -- they cannot be
/// merged into a single cross-domain transaction (`save_*` all require `&mut Connection`, and
/// rusqlite Transactions cannot nest). A mid-way failure therefore theoretically leaves half the
/// config applied. The safeguard is the caller: full validation was completed before writing (not a
/// single line of malformed input is written), and a local backup was generated beforehand so it
/// can be rolled back.
pub(crate) fn apply_backup_snapshot_to_db(
    conn: &mut Connection,
    snapshot: &BackupSnapshot,
) -> Result<(), String> {
    let mut snapshot = snapshot.clone();
    remap_snapshot_provider_ids_to_local(conn, &mut snapshot)?;
    if let Some(providers) = snapshot.providers.take() {
        save_providers(conn, providers)?;
    }
    if let Some(mcp) = snapshot.mcp.take() {
        save_mcp(conn, mcp)?;
    }
    if let Some(system) = &snapshot.system {
        let merged = merge_portable_system(conn, system)?;
        save_system(conn, merged)?;
    }
    if let Some(agents) = snapshot.agents.take() {
        save_agents(conn, agents)?;
    }
    if let Some(model_failover) = snapshot.model_failover.take() {
        save_model_failover(conn, model_failover)?;
    }
    Ok(())
}

/// Applies a snapshot: validate -> back up the current config -> write to the database.
///
/// The system domain only overlays portable keys, so systemProxy is not changed by the snapshot and
/// there is no need to refresh proxy state.
pub(crate) fn apply_backup_snapshot(
    conn: &mut Connection,
    snapshot: BackupSnapshot,
) -> Result<BackupApplyOutcome, String> {
    validate_backup_snapshot(&snapshot)?;
    let applied = snapshot_domain_counts(&snapshot);
    let backup_path = backup_current_config(conn)?;

    apply_backup_snapshot_to_db(conn, &snapshot)?;

    Ok(BackupApplyOutcome {
        applied,
        backup_path,
    })
}
