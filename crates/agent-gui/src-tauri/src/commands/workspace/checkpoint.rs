//! Conversation-level file checkpoints: before writing to disk, fs write commands
//! store the "pre-image" of each modified file under
//! `~/.liveagent/checkpoints/<conversationId>/`, letting rewind roll the workspace
//! back to the state before a given turn began.
//!
//! Design points (schema v2):
//! - Capture happens inside the fs command implementations (in the same call as the
//!   mutation), introducing no extra IPC and avoiding a second resolution of
//!   root:// / skill:// paths.
//! - Records store only `root + relPath` (the root already resolved at capture time
//!   plus the relative path), and never treat an absolute path as restore
//!   authorization: on rewind, root must still belong to the current authorized root
//!   set, root itself must not be a symlink, then the relative path is re-filtered
//!   and symlinks along the chain and (on Unix) multi-hardlinked targets are rejected
//!   level by level; immediately before writing, the whole chain is validated again
//!   (window protection), persistence goes through a temp file + atomic rename, and
//!   the preview-time state fingerprint (content hash + Unix permission bits) is
//!   carried for conflict detection (TOCTOU protection; a missing fingerprint is
//!   always treated as a conflict rather than overwriting).
//! - Authorized root set = the current workspace root and any still-active extra
//!   authorized roots supplied by the caller, plus two self-owned roots derived by
//!   the backend: the Skills root (where skill:// writes are recorded) and the git
//!   repository root containing each authorized root (where subagent worktree apply
//!   records the parent workspace pre-image). The latter two never accept
//!   caller-supplied values, so they are not new authorization entry points; the
//!   upward search for the repository root is capped at the home directory and the
//!   filesystem root, avoiding making the whole home directory a writable rewind
//!   target when "the home directory itself is a dotfiles repository".
//! - Turn identity: the TS side passes only a stable turnId (the user message ID);
//!   turn_seq is assigned monotonically per conversation by this module under
//!   INDEX_LOCK -- clock rollback or duplicate IDs cannot disturb rewind order.
//!   The UI displays firstCapturedAt for time and no longer reuses the sequence.
//! - The blob is a raw byte copy (no embedded JSON), and the index is an append-only
//!   index.jsonl; rewind correctness comes from "for each path, take the earliest
//!   record with turn_seq >= target".
//! - The index is physically append-only and never truncated, but semantically it
//!   prunes: a fully successful rewind writes a kind="rewind" marker with
//!   turn_seq=target, on which the read side discards "stale future" records with
//!   turn_seq >= target, so revoked turns do not remain in the menu after a rewind.
//!   A partially successful rewind (with conflicts/failures) writes a marker with
//!   turn_seq=0 that only audits without pruning.
//! - Capture is best-effort: internal errors only append a kind="error" record (so
//!   the turn shows as "incomplete" in the UI) and log, never failing the file write itself.
//! - Capacity defenses: caps on single files, per-conversation total, and record
//!   count; exceeding a limit records an error without capturing.
//! - Directory deletion only records an unrecoverable marker (kind="dir"), faithfully
//!   shown in the diff stats.
//! - Writes from Bash / managed processes do not pass through here; the UI must
//!   clearly state this limitation.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Size cap for a single pre-image blob; beyond it only an error is recorded (the turn is marked incomplete).
const MAX_BLOB_BYTES: u64 = 32 * 1024 * 1024;
/// Per-conversation total blob cap (estimated by summing the size of file records in the index).
const MAX_TOTAL_BLOB_BYTES: u64 = 512 * 1024 * 1024;
/// Per-conversation index record count cap; beyond it even error records are no longer appended (to prevent the index itself from growing).
const MAX_RECORDS_PER_CONVERSATION: usize = 10_000;

/// Tail quota reserved for error records within the record cap: ordinary captures
/// stop first, so failures can still be written truthfully to the index and turns
/// that hit the cap are not displayed as "complete" in the UI.
const RECORD_CAP_ERROR_RESERVE: usize = 64;

/// Checkpoint context attached by the TS side to fs mutation commands; absent
/// (None) means the call does not capture.
/// turnId is the stable ID of the user message (independent of the clock); the
/// sequence number is assigned by the Rust side.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCtx {
    pub conversation_id: String,
    pub turn_id: String,
}

/// A single record in index.jsonl (schema v2).
/// kind: "turn" | "file" | "dir" | "error" (capture failure marker) | "rewind" (rewind audit marker).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRecord {
    /// Record format version; old v1 lines (storing absolute paths) are silently skipped when deserialization fails.
    pub schema: u32,
    pub turn_seq: u64,
    pub turn_id: String,
    /// Root directory already resolved (canonicalized) at capture time; re-validated on rewind.
    pub root: String,
    /// Path relative to root, separated by forward slashes; may be an empty string for error/rewind records.
    pub rel_path: String,
    pub kind: String,
    pub existed_before: bool,
    /// File name under the blobs/ directory; empty for non-file records or when existed_before=false.
    pub blob: Option<String>,
    pub size: u64,
    pub mtime_ms: u64,
    pub captured_at: u64,
    /// Error reason for error records / summary for rewind records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Unix permission bits (only in file records, only written on Unix captures). A
    /// script whose content is right but which lost +x is still broken, so the mode
    /// is restored on rewind too. Optional field: v2 old records read back as None,
    /// so restoring is simply skipped, with no schema bump needed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

/// Pre-image content carried at capture time, so bytes already read by the caller (e.g. Edit) are not read a second time.
pub enum PreImage<'a> {
    /// The file did not exist before the change (rewind = delete that file).
    Missing,
    /// The file was a regular file before the change; None means the capturer reads it from disk itself.
    File(Option<&'a [u8]>),
    /// The path was a directory before the change (recursive deletion); only a marker can be recorded, it cannot be restored.
    Dir,
}

// The "read-check + append" on index.jsonl must be mutually exclusive: concurrent fs
// commands may race on the same file in the same turn, and turn_seq assignment also
// relies on this lock for monotonicity. It must also be held throughout a rewind,
// otherwise newly persisted captures would be buried along with the pruning marker
// written afterwards.
//
// The lock guards `()`, and no protected invariant is corrupted by a panic, so all
// sites recover from poisoning with `into_inner()` -- an unrelated panic should not
// turn the whole checkpoint subsystem into "can never capture again, nor rewind again".
static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

/// conversationId becomes a directory name, so it is defensively filtered to a safe character set.
fn sanitize_conversation_id(id: &str) -> Option<String> {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn checkpoints_root() -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Failed to locate the user home directory".to_string())?;
    Ok(home.join(".liveagent").join("checkpoints"))
}

fn conversation_dir(conversation_id: &str) -> Result<PathBuf, String> {
    let safe = sanitize_conversation_id(conversation_id)
        .ok_or_else(|| "checkpoint conversationId is empty".to_string())?;
    Ok(checkpoints_root()?.join(safe))
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.jsonl")
}

fn blobs_dir(dir: &Path) -> PathBuf {
    dir.join("blobs")
}

/// On Unix, tighten checkpoint directories/files to owner-only read/write; Windows has no POSIX bits, so skip.
#[cfg(unix)]
fn tighten_permissions(path: &Path, is_dir: bool) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if is_dir { 0o700 } else { 0o600 };
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn tighten_permissions(_path: &Path, _is_dir: bool) {}

/// Records Unix permission bits when capturing a pre-image; Windows has no POSIX bits, so always None.
#[cfg(unix)]
fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).ok().map(|md| md.permissions().mode())
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Option<u32> {
    None
}

/// Restores permission bits after rewind writes content back. Old records without this field keep the current state.
#[cfg(unix)]
fn restore_file_mode(path: &Path, mode: Option<u32>) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
}

#[cfg(not(unix))]
fn restore_file_mode(_path: &Path, _mode: Option<u32>) {}

fn ensure_conversation_dirs(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    tighten_permissions(dir, true);
    let blobs = blobs_dir(dir);
    fs::create_dir_all(&blobs).map_err(|e| e.to_string())?;
    tighten_permissions(&blobs, true);
    Ok(())
}

fn path_hash16(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    hex_encode(&digest)[..16].to_string()
}

fn read_index(dir: &Path) -> Vec<CheckpointRecord> {
    let Ok(text) = fs::read_to_string(index_path(dir)) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<CheckpointRecord>(line).ok())
        .filter(|record| record.schema == 2)
        .collect()
}

fn append_record(dir: &Path, record: &CheckpointRecord) -> Result<(), String> {
    let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    let path = index_path(dir);
    let existed = path.exists();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| e.to_string())?;
    if !existed {
        tighten_permissions(&path, false);
    }
    Ok(())
}

/// Finds the next free version number under blobs/ to write to. Versions for the same path are rare, so linear probing is enough.
fn write_blob(dir: &Path, key: &str, bytes: &[u8]) -> Result<String, String> {
    let blobs = blobs_dir(dir);
    let hash = path_hash16(key);
    for version in 1..u32::MAX {
        let name = format!("{hash}@v{version}");
        let target = blobs.join(&name);
        if target.exists() {
            continue;
        }
        fs::write(&target, bytes).map_err(|e| e.to_string())?;
        tighten_permissions(&target, false);
        return Ok(name);
    }
    Err("checkpoint blob version space exhausted".to_string())
}

/// Stable key of a record: root + relative path, used for blob naming and round-trip matching in conflict detection.
fn record_key(root: &str, rel_path: &str) -> String {
    format!("{root}\u{1}{rel_path}")
}

fn normalize_root(root: &Path) -> String {
    root.to_string_lossy().replace('\\', "/")
}

fn normalize_rel(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

/// Resolves this turn's turn_seq under INDEX_LOCK: reuse for the same turnId, otherwise max+1.
/// Independent of the clock, strictly monotonically increasing with order of appearance within a conversation.
///
/// A rewind marker's turn_id is always an empty string, and a partial rewind records
/// turn_seq 0 (a sentinel). If the caller also passes an empty turnId, it would reuse
/// the marker's seq -- especially reusing 0, putting the whole turn's captures below
/// the valid seq range so they could never be rewound to. Markers do not participate in turnId reuse.
fn resolve_turn_seq(records: &[CheckpointRecord], turn_id: &str) -> u64 {
    if let Some(existing) = records
        .iter()
        .find(|r| r.kind != "rewind" && r.turn_id == turn_id)
    {
        return existing.turn_seq;
    }
    records.iter().map(|r| r.turn_seq).max().unwrap_or(0) + 1
}

/// Fallback for capture failure: append an error record so the turn shows as "incomplete".
/// This too can fail (e.g. disk full), in which case only eprintln remains.
fn append_error_record(
    dir: &Path,
    turn_seq: u64,
    turn_id: &str,
    root: &str,
    rel_path: &str,
    reason: &str,
) {
    let record = CheckpointRecord {
        schema: 2,
        turn_seq,
        turn_id: turn_id.to_string(),
        root: root.to_string(),
        rel_path: rel_path.to_string(),
        kind: "error".to_string(),
        existed_before: false,
        blob: None,
        size: 0,
        mtime_ms: 0,
        captured_at: now_ms(),
        note: Some(reason.to_string()),
        mode: None,
    };
    if let Err(e) = append_record(dir, &record) {
        eprintln!("checkpoint error-record append failed for {rel_path}: {e}");
    }
}

/// Directory-injectable capture implementation, letting unit tests bypass home resolution.
/// Returns the turn_seq assigned to this turn (for test assertions).
fn capture_at(
    dir: &Path,
    turn_id: &str,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
) -> Result<u64, String> {
    capture_at_with_limits(
        dir,
        turn_id,
        root,
        rel_path,
        pre_image,
        MAX_BLOB_BYTES,
        MAX_TOTAL_BLOB_BYTES,
    )
}

/// Limit-injectable capture implementation: unit tests use small limits to genuinely
/// exercise the over-limit branches, rather than creating a real 32MB file just to cover the 32MB check.
fn capture_at_with_limits(
    dir: &Path,
    turn_id: &str,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
    max_blob_bytes: u64,
    max_total_blob_bytes: u64,
) -> Result<u64, String> {
    ensure_conversation_dirs(dir)?;
    let root_str = normalize_root(root);
    let rel_str = normalize_rel(rel_path);
    let abs_path = root.join(rel_path);

    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let existing = read_index(dir);
    let turn_seq = resolve_turn_seq(&existing, turn_id);

    // Record cap: ordinary captures stop RECORD_CAP_ERROR_RESERVE records early,
    // leaving the tail quota for error records. Otherwise turns that hit the cap
    // could not even write "incomplete" and the UI would pretend the turn was intact.
    if existing.len() + RECORD_CAP_ERROR_RESERVE >= MAX_RECORDS_PER_CONVERSATION {
        return Err(format!(
            "checkpoint record cap reached ({MAX_RECORDS_PER_CONVERSATION})"
        ));
    }

    // Within the same turn, keep only the earliest record per path: rewind takes that
    // one, and later records are pure redundancy.
    if existing
        .iter()
        .any(|r| r.turn_seq == turn_seq && r.root == root_str && r.rel_path == rel_str)
    {
        return Ok(turn_seq);
    }

    let record = match pre_image {
        PreImage::Missing => CheckpointRecord {
            schema: 2,
            turn_seq,
            turn_id: turn_id.to_string(),
            root: root_str,
            rel_path: rel_str,
            kind: "file".to_string(),
            existed_before: false,
            blob: None,
            size: 0,
            mtime_ms: 0,
            captured_at: now_ms(),
            note: None,
            mode: None,
        },
        PreImage::Dir => CheckpointRecord {
            schema: 2,
            turn_seq,
            turn_id: turn_id.to_string(),
            root: root_str,
            rel_path: rel_str,
            kind: "dir".to_string(),
            existed_before: true,
            blob: None,
            size: 0,
            mtime_ms: 0,
            captured_at: now_ms(),
            note: None,
            mode: None,
        },
        PreImage::File(bytes) => {
            let owned;
            let bytes = match bytes {
                Some(b) => b,
                None => {
                    // Check metadata before reading from disk: an over-limit file should
                    // not be read entirely into memory just to record an error.
                    let len = fs::metadata(&abs_path).map_err(|e| e.to_string())?.len();
                    if len > max_blob_bytes {
                        append_error_record(
                            dir,
                            turn_seq,
                            turn_id,
                            &root_str,
                            &rel_str,
                            &format!("file too large to checkpoint ({len} bytes)"),
                        );
                        return Ok(turn_seq);
                    }
                    owned = fs::read(&abs_path).map_err(|e| e.to_string())?;
                    &owned
                }
            };
            if bytes.len() as u64 > max_blob_bytes {
                append_error_record(
                    dir,
                    turn_seq,
                    turn_id,
                    &root_str,
                    &rel_str,
                    &format!("file too large to checkpoint ({} bytes)", bytes.len()),
                );
                return Ok(turn_seq);
            }
            let total: u64 = existing
                .iter()
                .filter(|r| r.blob.is_some())
                .map(|r| r.size)
                .sum();
            if total.saturating_add(bytes.len() as u64) > max_total_blob_bytes {
                append_error_record(
                    dir,
                    turn_seq,
                    turn_id,
                    &root_str,
                    &rel_str,
                    "conversation checkpoint storage cap reached",
                );
                return Ok(turn_seq);
            }
            // size is exactly the number of blob bytes this record occupies, and the
            // quota sums only over it. Using metadata().len() would mismatch the
            // persisted amount when "the caller supplies bytes directly" or the file is
            // modified after being read, distorting the quota.
            let mtime_ms = fs::symlink_metadata(&abs_path)
                .ok()
                .and_then(|md| md.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or(0);
            let size = bytes.len() as u64;
            let mode = file_mode(&abs_path);
            let blob = write_blob(dir, &record_key(&root_str, &rel_str), bytes)?;
            CheckpointRecord {
                schema: 2,
                turn_seq,
                turn_id: turn_id.to_string(),
                root: root_str,
                rel_path: rel_str,
                kind: "file".to_string(),
                existed_before: true,
                blob: Some(blob),
                size,
                mtime_ms,
                captured_at: now_ms(),
                note: None,
                mode,
            }
        }
    };

    append_record(dir, &record)?;
    Ok(turn_seq)
}

fn capture_inner(
    ctx: &CheckpointCtx,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
) -> Result<(), String> {
    let dir = conversation_dir(&ctx.conversation_id)?;
    capture_at(&dir, &ctx.turn_id, root, rel_path, pre_image).map(|_| ())
}

/// Truthfully writes "this path could not obtain a pre-image" into the index: the
/// turn shows a ⚠ incomplete marker in the UI, and the specific path is locatable in
/// the diff. When the index directory is unavailable, only a log remains.
fn record_capture_skip(ctx: &CheckpointCtx, root: &Path, rel_path: &Path, reason: &str) {
    let Ok(dir) = conversation_dir(&ctx.conversation_id) else {
        return;
    };
    if ensure_conversation_dirs(&dir).is_err() {
        return;
    }
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let existing = read_index(&dir);
    if existing.len() >= MAX_RECORDS_PER_CONVERSATION {
        eprintln!(
            "checkpoint record cap reached; dropping skip record for {}",
            root.join(rel_path).display()
        );
        return;
    }
    let seq = resolve_turn_seq(&existing, &ctx.turn_id);
    append_error_record(
        &dir,
        seq,
        &ctx.turn_id,
        &normalize_root(root),
        &normalize_rel(rel_path),
        reason,
    );
}

fn begin_turn_at(dir: &Path, turn_id: &str) -> Result<(), String> {
    let turn_id = turn_id.trim();
    if turn_id.is_empty() {
        return Err("checkpoint turnId is empty".to_string());
    }
    ensure_conversation_dirs(dir)?;
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let existing = read_index(dir);
    if existing.iter().any(|record| record.turn_id == turn_id) {
        return Ok(());
    }
    if existing.len() + RECORD_CAP_ERROR_RESERVE >= MAX_RECORDS_PER_CONVERSATION {
        return Err(format!(
            "checkpoint record cap reached ({MAX_RECORDS_PER_CONVERSATION})"
        ));
    }
    let turn_seq = resolve_turn_seq(&existing, turn_id);
    append_record(
        dir,
        &CheckpointRecord {
            schema: 2,
            turn_seq,
            turn_id: turn_id.to_string(),
            root: String::new(),
            rel_path: String::new(),
            kind: "turn".to_string(),
            existed_before: false,
            blob: None,
            size: 0,
            mtime_ms: 0,
            captured_at: now_ms(),
            note: None,
            mode: None,
        },
    )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_begin_turn(conversation_id: String, turn_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = conversation_dir(&conversation_id)?;
        begin_turn_at(&dir, &turn_id)
    })
    .await
    .map_err(|e| format!("checkpoint_begin_turn join failed: {e}"))?
}

/// Capture entry point for fs mutation commands: best-effort, appending an error
/// record + log on failure, never blocking the file write itself.
pub fn capture_pre_image(
    ctx: Option<&CheckpointCtx>,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
) {
    let Some(ctx) = ctx else { return };
    if let Err(error) = capture_inner(ctx, root, rel_path, pre_image) {
        eprintln!(
            "checkpoint capture failed for {}: {error}",
            root.join(rel_path).display()
        );
        // Do our best to write the failure into the index so the turn shows as
        // "incomplete"; when the directory is unavailable, only a log remains.
        record_capture_skip(ctx, root, rel_path, &error);
    }
}

// ---------------------------------------------------------------------------
// Query and rewind commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointTurnSummary {
    pub turn_seq: u64,
    pub turn_id: String,
    pub file_count: usize,
    pub dir_count: usize,
    /// Whether this turn has any capture-failure records (the rewind may be incomplete).
    pub incomplete: bool,
    pub first_captured_at: u64,
}

/// "Live records" view of the index: removes stale future turns revoked by a rewind.
/// A rewind marker with turn_seq=t (t>0) means the changes at and after t have been
/// fully revoked; those turns should no longer appear on the timeline nor participate
/// in the next rewind's aggregation; the marker itself is only for audit and is never
/// returned. A marker with turn_seq=0 comes from a partially successful rewind and
/// does not prune. Note: turn_seq assignment and same-turn deduplication on the
/// capture side still read the raw index, keeping sequence numbers monotonic after
/// pruning and avoiding collisions with stale records.
fn live_records(records: Vec<CheckpointRecord>) -> Vec<CheckpointRecord> {
    let mut out: Vec<CheckpointRecord> = Vec::new();
    for record in records {
        if record.kind == "rewind" {
            if record.turn_seq > 0 {
                out.retain(|r| r.turn_seq < record.turn_seq);
            }
            continue;
        }
        out.push(record);
    }
    out
}

/// List of rewindable turns within a conversation, in ascending turn_seq order.
/// Error records do not count toward the file count but mark the turn incomplete;
/// stale turns revoked by a rewind have already been removed by live_records.
fn checkpoint_turn_summaries(records: Vec<CheckpointRecord>) -> Vec<CheckpointTurnSummary> {
    let records = live_records(records);
    let mut turns: Vec<CheckpointTurnSummary> = Vec::new();
    for record in records {
        let summary = match turns.iter_mut().find(|t| t.turn_seq == record.turn_seq) {
            Some(existing) => existing,
            None => {
                turns.push(CheckpointTurnSummary {
                    turn_seq: record.turn_seq,
                    turn_id: record.turn_id.clone(),
                    file_count: 0,
                    dir_count: 0,
                    incomplete: false,
                    first_captured_at: record.captured_at,
                });
                turns.last_mut().expect("just pushed")
            }
        };
        match record.kind.as_str() {
            "dir" => summary.dir_count += 1,
            "error" => summary.incomplete = true,
            "file" => summary.file_count += 1,
            // "turn" boundary records and unknown types are not counted; they only pin
            // the turn into the list: a zero-file turn must also be a valid rewind point
            // (rewind = undo everything from that turn onward).
            _ => {}
        }
        if record.captured_at < summary.first_captured_at {
            summary.first_captured_at = record.captured_at;
        }
    }
    turns.sort_by_key(|t| t.turn_seq);
    turns
}

fn checkpoint_list_sync(conversation_id: String) -> Result<Vec<CheckpointTurnSummary>, String> {
    let dir = conversation_dir(&conversation_id)?;
    Ok(checkpoint_turn_summaries(read_index(&dir)))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_list(
    conversation_id: String,
) -> Result<Vec<CheckpointTurnSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoint_list_sync(conversation_id))
        .await
        .map_err(|e| format!("checkpoint_list join failed: {e}"))?
}

/// The action and current dirtiness of each affected path when rewinding to the state before a turn.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffEntry {
    /// Display path (root/rel).
    pub path: String,
    /// Round-trip key for conflict detection: the UI passes (key, currentHash) back verbatim to rewind.
    pub key: String,
    /// "restore" | "delete" | "clean" | "skip-dir" | "missing-blob" | "unresolvable"
    pub action: String,
    /// State fingerprint of the target file at preview time (content hash + Unix
    /// permission bits); "absent" when the file does not exist. None when the target
    /// is unresolvable (root unauthorized / symlink in the path chain) or is a
    /// directory marker. Rewind recomputes and compares it; a mismatch or absence
    /// skips that file and reports a conflict.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_hash: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffStats {
    pub turn_seq: u64,
    pub restore_files: usize,
    pub delete_files: usize,
    pub clean_files: usize,
    pub skipped_dirs: usize,
    pub missing_blobs: usize,
    /// Entries whose root is no longer in the authorized workspace set, or whose path chain contains a symlink: never rewound.
    pub unresolvable_files: usize,
    /// Number of entries that failed during capture: rewind does not cover these files, warning the user it may be incomplete.
    pub capture_errors: usize,
    pub entries: Vec<CheckpointDiffEntry>,
}

/// Takes recoverable records with turn_seq >= target, keeping the earliest record per
/// path in file order (i.e. time order). Error records are counted separately; stale
/// future turns and rewind markers have already been removed by live_records.
fn earliest_records_since(dir: &Path, turn_seq: u64) -> (Vec<CheckpointRecord>, usize) {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<CheckpointRecord> = Vec::new();
    let mut errors = 0usize;
    for record in live_records(read_index(dir)) {
        if record.turn_seq < turn_seq {
            continue;
        }
        if record.kind == "error" {
            errors += 1;
            continue;
        }
        if record.kind == "turn" {
            continue;
        }
        let key = record_key(&record.root, &record.rel_path);
        if seen.iter().any(|p| p == &key) {
            continue;
        }
        seen.push(key);
        out.push(record);
    }
    (out, errors)
}

/// Normalizes the "currently still authorized workspace roots" supplied by the
/// caller: roots that are themselves symlinks are not trusted, and the rest are
/// canonicalized and deduplicated. An empty set means no record can be rewound (fail-closed).
fn canonical_authorized_roots(roots: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |candidate: PathBuf| {
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    };
    for raw in roots {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = Path::new(trimmed);
        if matches!(fs::symlink_metadata(path), Ok(md) if md.file_type().is_symlink()) {
            continue;
        }
        let Ok(canonical) = fs::canonicalize(path) else {
            continue;
        };
        // subagent worktree apply records the parent workspace pre-image under the
        // parent repository root (see subagent_worktree.rs); that root is not in the
        // caller-supplied list. It is derived upward from the authorized root itself
        // and never accepts caller input, so it is not a new authorization entry point.
        if let Some(repo_root) = enclosing_repo_root(&canonical) {
            push(repo_root);
        }
        push(canonical);
    }
    // skill:// write pre-images are recorded under the Skills root, which is
    // determined by the backend's own configuration and cannot be supplied by the
    // frontend; omitting it would make turns that wrote skill files forever unrewindable.
    if let Ok(skills_root) = crate::services::skills::skills_root_dir() {
        push(skills_root);
    }
    out
}

/// Finds the nearest git repository root by walking up from an authorized root
/// (`.git` may be a directory or a worktree file). If none is found, the root is not
/// inside a repository and no extra root needs to be allowed.
///
/// The upward walk must be capped: the home directory itself is often a dotfiles
/// repository, and a drive/filesystem root may have been `git init`'d. Walking up
/// unbounded would turn the entire home directory (or even the whole drive) into a
/// writable rewind target, effectively opening the authorized root into a wildcard,
/// so these two kinds of candidates are never trusted.
fn enclosing_repo_root(start: &Path) -> Option<PathBuf> {
    let home = dirs::home_dir().and_then(|h| fs::canonicalize(h).ok());
    let mut cursor = Some(start);
    while let Some(dir) = cursor {
        // No parent means we have reached the filesystem/drive root, which cannot be a repository root.
        let parent = dir.parent()?;
        if home.as_deref() == Some(dir) {
            return None;
        }
        if dir.join(".git").exists() {
            return fs::canonicalize(dir).ok();
        }
        cursor = Some(parent);
    }
    None
}

/// First link in the rewind authorization chain: the record's root must still be one
/// of the currently authorized workspace roots. symlink_metadata is used first to
/// reject "the root itself is a symlink" -- after a workspace is renamed and a link
/// pointing elsewhere is mounted at the original path, canonicalize would follow it
/// and write the rewind outside the workspace.
fn resolve_authorized_root(
    root_str: &str,
    authorized_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let raw = Path::new(root_str);
    match fs::symlink_metadata(raw) {
        Ok(md) if md.file_type().is_symlink() => {
            return Err("refusing to follow a symlinked checkpoint root".to_string());
        }
        Ok(md) if !md.is_dir() => {
            return Err("checkpoint root is no longer a directory".to_string());
        }
        Ok(_) => {}
        Err(e) => return Err(format!("checkpoint root unavailable: {e}")),
    }
    let root = fs::canonicalize(raw).map_err(|e| format!("checkpoint root unavailable: {e}"))?;
    if !authorized_roots.iter().any(|allowed| allowed == &root) {
        return Err("checkpoint root is not an authorized workspace root".to_string());
    }
    Ok(root)
}

/// Re-validation of a rewind target: the root must still be in the authorized set
/// and not be a symlink, the relative path is re-filtered (Normal components only),
/// and symlinks along the path chain are rejected level by level.
/// The absolute path from capture time is never trusted -- this is rewind's only authorization channel.
fn resolve_rewind_target(
    root_str: &str,
    rel_str: &str,
    authorized_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let root = resolve_authorized_root(root_str, authorized_roots)?;
    let rel = PathBuf::from(rel_str);
    if rel.as_os_str().is_empty() {
        return Err("empty relative path".to_string());
    }
    for comp in rel.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return Err(format!("unsafe relative path: {rel_str}")),
        }
    }
    let mut current = root;
    for comp in rel.components() {
        current.push(comp);
        match fs::symlink_metadata(&current) {
            Ok(md) if md.file_type().is_symlink() => {
                return Err(format!(
                    "refusing to follow symlink at {}",
                    current.display()
                ));
            }
            _ => {}
        }
    }
    Ok(current)
}

/// On Unix, refuse to restore/delete multi-hardlinked files: writing one would affect alias paths outside the workspace.
#[cfg(unix)]
fn reject_multi_hardlink(md: &fs::Metadata) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if md.nlink() > 1 {
        return Err("refusing to modify a multi-hardlink file".to_string());
    }
    Ok(())
}

#[cfg(not(unix))]
fn reject_multi_hardlink(_md: &fs::Metadata) -> Result<(), String> {
    Ok(())
}

/// Fingerprint of the target's current state: content hash + (Unix) permission bits;
/// a sentinel is returned when it does not exist (or is not a regular file). The
/// permission bits must participate in the TOCTOU comparison -- a chmod while the
/// confirmation dialog is open is just as much "modified externally after preview" as
/// a content change, and comparing only content would let a rewind silently overwrite
/// it back to the capture-time permission. Windows has no POSIX bits, so the
/// fingerprint degrades to a pure content hash.
fn current_state_hash(target: &Path) -> String {
    match fs::symlink_metadata(target) {
        Ok(md) if md.is_file() => match fs::read(target) {
            Ok(bytes) => match file_mode(target) {
                Some(mode) => format!("{}@{:o}", sha256_hex(&bytes), mode),
                None => sha256_hex(&bytes),
            },
            Err(_) => "unreadable".to_string(),
        },
        Ok(_) => "non-file".to_string(),
        Err(_) => "absent".to_string(),
    }
}

/// Whether the recorded mode differs from the target's current state. When mode was
/// not recorded (old records/Windows) or the current state is unavailable, they are
/// treated as consistent -- without a baseline there is no drift to speak of, and the
/// rewind side will not change permissions either.
fn mode_differs(recorded: Option<u32>, target: &Path) -> bool {
    match recorded {
        Some(want) => matches!(file_mode(target), Some(have) if have != want),
        None => false,
    }
}

fn classify_entry(
    dir: &Path,
    record: &CheckpointRecord,
    authorized_roots: &[PathBuf],
) -> CheckpointDiffEntry {
    let key = record_key(&record.root, &record.rel_path);
    let display = format!("{}/{}", record.root, record.rel_path);
    if record.kind == "dir" {
        return CheckpointDiffEntry {
            path: display,
            key,
            action: "skip-dir".to_string(),
            current_hash: None,
        };
    }
    // When the target fails to resolve (root unauthorized / symlink in the path
    // chain) there is no current-state hash to compare; the rewind side will fail at
    // the same point and count it in failed, never reaching conflict detection.
    let target = match resolve_rewind_target(&record.root, &record.rel_path, authorized_roots) {
        Ok(target) => target,
        Err(_) => {
            return CheckpointDiffEntry {
                path: display,
                key,
                action: "unresolvable".to_string(),
                current_hash: None,
            };
        }
    };
    let hash = current_state_hash(&target);
    let action = if !record.existed_before {
        if hash == "absent" {
            "clean"
        } else {
            "delete"
        }
    } else {
        match &record.blob {
            None => "missing-blob",
            Some(blob) => match fs::read(blobs_dir(dir).join(blob)) {
                Err(_) => "missing-blob",
                Ok(expected) => {
                    // Compare the content part of the fingerprint with the pre-image; if
                    // the content matches but the permission bits drifted it is still not
                    // clean -- the rewind would restore the permissions, so it must be
                    // presented as restore in the preview and not silently change
                    // permissions while hiding behind "already consistent".
                    let current_content = hash.split_once('@').map_or(hash.as_str(), |(c, _)| c);
                    if sha256_hex(&expected) == current_content
                        && !mode_differs(record.mode, &target)
                    {
                        "clean"
                    } else {
                        "restore"
                    }
                }
            },
        }
    };
    // For every resolvable entry, always return the current-state hash (including
    // clean / missing-blob): the rewind side treats any entry without a hash as a
    // conflict, and omitting one is equivalent to giving up a line of defense.
    CheckpointDiffEntry {
        path: display,
        key,
        action: action.to_string(),
        current_hash: Some(hash),
    }
}

fn checkpoint_diff_stats_sync(
    conversation_id: String,
    turn_seq: u64,
    authorized_roots: Vec<String>,
) -> Result<CheckpointDiffStats, String> {
    let dir = conversation_dir(&conversation_id)?;
    let authorized = canonical_authorized_roots(&authorized_roots);
    let (records, capture_errors) = earliest_records_since(&dir, turn_seq);
    let mut stats = CheckpointDiffStats {
        turn_seq,
        restore_files: 0,
        delete_files: 0,
        clean_files: 0,
        skipped_dirs: 0,
        missing_blobs: 0,
        unresolvable_files: 0,
        capture_errors,
        entries: Vec::new(),
    };
    for record in records {
        let entry = classify_entry(&dir, &record, &authorized);
        match entry.action.as_str() {
            "restore" => stats.restore_files += 1,
            "delete" => stats.delete_files += 1,
            "clean" => stats.clean_files += 1,
            "skip-dir" => stats.skipped_dirs += 1,
            "missing-blob" => stats.missing_blobs += 1,
            "unresolvable" => stats.unresolvable_files += 1,
            _ => {}
        }
        stats.entries.push(entry);
    }
    Ok(stats)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_diff_stats(
    conversation_id: String,
    turn_seq: u64,
    authorized_roots: Vec<String>,
) -> Result<CheckpointDiffStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checkpoint_diff_stats_sync(conversation_id, turn_seq, authorized_roots)
    })
    .await
    .map_err(|e| format!("checkpoint_diff_stats join failed: {e}"))?
}

/// The (key, currentHash) expectations the UI brings back from the diff preview, re-compared before rewind.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointExpectedEntry {
    pub key: String,
    pub current_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRewindResult {
    pub turn_seq: u64,
    pub restored_files: usize,
    pub deleted_files: usize,
    pub clean_files: usize,
    pub skipped_dirs: usize,
    /// Number of records that failed during capture within the target range: these
    /// files have no pre-image, the rewind did not touch them, and the state was not truly restored.
    pub capture_errors: usize,
    /// Files modified concurrently after the preview: skipped without overwriting, left for the user to preview again.
    pub conflicts: Vec<String>,
    pub failed: Vec<String>,
}

/// Whether a rewind is "complete": no conflicts/failures/unrecoverable directories/capture
/// failures. Only a complete rewind may write the turn_seq=target pruning marker. A turn
/// with capture failures is incomplete even if all other files were restored -- files
/// missing a pre-image remain in their modified state, and pruning as complete would hide
/// the error records together with the fact that "this turn was not cleanly rewound".
fn rewind_is_complete(result: &CheckpointRewindResult) -> bool {
    result.conflicts.is_empty()
        && result.failed.is_empty()
        && result.skipped_dirs == 0
        && result.capture_errors == 0
}

/// Persist via a temp file + atomic rename, avoiding a half-written state. On Windows,
/// rename does not overwrite an existing target, so the old file is removed first and
/// then renamed (a tiny window, and the content is already in the local temp file).
fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "target has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".ckpt-tmp-{}-{}", std::process::id(), now_ms()));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    match fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        // On Windows, rename fails when the target is in use (an editor/antivirus holds
        // a handle). The original fallback was to remove the target then rename, but if
        // remove succeeds and rename still fails, both the old and new content vanish --
        // the rewind would lose the file instead. Instead, first move the old file to a
        // backup name: if the second rename fails, move the backup back, so any step's
        // failure still preserves at least one complete copy.
        Err(_) if target.exists() => {
            let backup = parent.join(format!(".ckpt-bak-{}-{}", std::process::id(), now_ms()));
            if let Err(e) = fs::rename(target, &backup) {
                let _ = fs::remove_file(&tmp);
                return Err(e.to_string());
            }
            match fs::rename(&tmp, target) {
                Ok(()) => {
                    let _ = fs::remove_file(&backup);
                    Ok(())
                }
                Err(e) => {
                    let _ = fs::rename(&backup, target);
                    let _ = fs::remove_file(&tmp);
                    Err(e.to_string())
                }
            }
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

/// Restores all modified files with turn_seq >= target to their respective earliest
/// pre-images. The index is still physically append-only, but a fully successful rewind
/// writes a rewind marker with turn_seq=target, on which the read side prunes stale
/// future records with turn_seq >= target so revoked turns do not remain in the menu;
/// when there are conflicts/failures/capture gaps (error records), a marker with
/// turn_seq=0 is written that only audits and does not prune, avoiding burying paths
/// that were not successfully rewound together with the evidence that "this turn was incomplete".
fn checkpoint_rewind_code_sync(
    conversation_id: String,
    turn_seq: u64,
    authorized_roots: Vec<String>,
    expected: Vec<CheckpointExpectedEntry>,
) -> Result<CheckpointRewindResult, String> {
    let dir = conversation_dir(&conversation_id)?;
    let authorized = canonical_authorized_roots(&authorized_roots);
    // Hold the lock for the whole sequence (read index -> restore each -> write
    // marker): if a tool captures to disk during the rewind, the new record's turn_seq
    // lands above target, and the pruning marker written afterwards would bury these
    // just-made changes as "stale future", making their pre-images unrecoverable. The
    // lock guards `()`, and poisoning does not mean inconsistent data, so retrieve the
    // inner value directly rather than failing the rewind over it.
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(rewind_and_mark_at(
        &dir,
        turn_seq,
        &authorized,
        Some(&expected),
    ))
}

/// The in-lock "rewind + write audit/prune marker": the directory is injectable so
/// unit tests can cover the boundary between complete/partial markers. The caller must already hold INDEX_LOCK.
fn rewind_and_mark_at(
    dir: &Path,
    turn_seq: u64,
    authorized: &[PathBuf],
    expected: Option<&[CheckpointExpectedEntry]>,
) -> CheckpointRewindResult {
    let result = rewind_at(dir, turn_seq, authorized, expected);
    // skipped_dirs and capture_errors both count as not cleanly rewound: directories
    // that cannot be restored / files without a pre-image mean this turn's state was
    // not truly restored, and the timeline must not be pruned to make the user think it
    // was revoked (pruning would also bury the error records, making "incomplete" invisible).
    let complete = rewind_is_complete(&result);
    // Rewind audit marker: when turn_seq>0 it also carries the "prune stale future turns" semantics.
    let marker = CheckpointRecord {
        schema: 2,
        turn_seq: if complete { turn_seq } else { 0 },
        turn_id: String::new(),
        root: String::new(),
        rel_path: String::new(),
        kind: "rewind".to_string(),
        existed_before: false,
        blob: None,
        size: 0,
        mtime_ms: 0,
        captured_at: now_ms(),
        note: Some(format!(
            "target={} restored={} deleted={} conflicts={} failed={} capture_errors={} complete={}",
            turn_seq,
            result.restored_files,
            result.deleted_files,
            result.conflicts.len(),
            result.failed.len(),
            result.capture_errors,
            complete
        )),
        mode: None,
    };
    // The caller holds the lock, so append directly.
    let _ = append_record(dir, &marker);
    result
}

/// Directory-injectable rewind implementation, letting unit tests bypass home resolution.
/// When `expected` = Some, fail-closed mode is entered: every resolvable target must
/// carry the preview-time current-state hash and match it, otherwise it is treated as
/// a conflict and skipped. None is reserved for internal/unit-test calls.
fn rewind_at(
    dir: &Path,
    turn_seq: u64,
    authorized_roots: &[PathBuf],
    expected: Option<&[CheckpointExpectedEntry]>,
) -> CheckpointRewindResult {
    let expected_by_key: Option<HashMap<&str, &str>> = expected.map(|entries| {
        entries
            .iter()
            .map(|e| (e.key.as_str(), e.current_hash.as_str()))
            .collect()
    });
    let (records, capture_errors) = earliest_records_since(dir, turn_seq);
    let mut result = CheckpointRewindResult {
        turn_seq,
        restored_files: 0,
        deleted_files: 0,
        clean_files: 0,
        skipped_dirs: 0,
        capture_errors,
        conflicts: Vec::new(),
        failed: Vec::new(),
    };
    for record in records {
        let display = format!("{}/{}", record.root, record.rel_path);
        if record.kind == "dir" {
            result.skipped_dirs += 1;
            continue;
        }
        // Authorization chain: root still in the authorized set and not a symlink +
        // relative path re-filtered + symlinks rejected along the whole chain.
        let target = match resolve_rewind_target(&record.root, &record.rel_path, authorized_roots) {
            Ok(t) => t,
            Err(e) => {
                result.failed.push(format!("{display}: {e}"));
                continue;
            }
        };
        // TOCTOU protection: compare against the preview-time content hash. A missing
        // key means the preview and this execution do not line up (old frontend /
        // truncated request), so treat it as a conflict, never fail-open. "unreadable"
        // is the sentinel for "no content was read this time", not a content digest;
        // two failed reads do not mean the content is unchanged, and comparing them as
        // equal is equally fail-open, so treat it as a conflict directly.
        let key = record_key(&record.root, &record.rel_path);
        if let Some(map) = &expected_by_key {
            let current = current_state_hash(&target);
            match map.get(key.as_str()) {
                Some(expected) if current != "unreadable" && current == **expected => {}
                _ => {
                    result.conflicts.push(display);
                    continue;
                }
            }
        }
        if !record.existed_before {
            match fs::symlink_metadata(&target) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    result.clean_files += 1;
                }
                Err(e) => result.failed.push(format!("{display}: {e}")),
                Ok(md) => {
                    if !md.is_file() {
                        result.failed.push(format!("{display}: not a regular file"));
                        continue;
                    }
                    if let Err(e) = reject_multi_hardlink(&md) {
                        result.failed.push(format!("{display}: {e}"));
                        continue;
                    }
                    // Window between check and write: run the authorization chain again immediately before the action.
                    if let Err(e) = reverify_target(&record, &target, authorized_roots) {
                        result.failed.push(format!("{display}: {e}"));
                        continue;
                    }
                    match fs::remove_file(&target) {
                        Ok(()) => result.deleted_files += 1,
                        Err(e) => result.failed.push(format!("{display}: {e}")),
                    }
                }
            }
            continue;
        }
        let Some(blob) = &record.blob else {
            result.failed.push(format!("{display}: blob missing"));
            continue;
        };
        let blob_path = blobs_dir(dir).join(blob);
        let restore = (|| -> Result<bool, String> {
            let pre_image = fs::read(&blob_path).map_err(|e| e.to_string())?;
            match fs::symlink_metadata(&target) {
                Ok(md) => {
                    if !md.is_file() {
                        return Err("not a regular file".to_string());
                    }
                    reject_multi_hardlink(&md)?;
                    if let Ok(current) = fs::read(&target) {
                        if current == pre_image {
                            // The content matches, but the permission bits may differ from
                            // the pre-image. That case was already disclosed as restore in
                            // the preview, and a chmod during confirmation would be caught
                            // as a conflict by the state fingerprint; any permission restore
                            // reaching here was confirmed by the user. Count restored/clean
                            // based on whether permissions actually changed.
                            let mode_changed = mode_differs(record.mode, &target);
                            restore_file_mode(&target, record.mode);
                            return Ok(mode_changed);
                        }
                    }
                }
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    return Err(e.to_string());
                }
                Err(_) => {}
            }
            // Window between check and write: run the authorization chain again immediately before persisting.
            reverify_target(&record, &target, authorized_roots)?;
            atomic_write(&target, &pre_image)?;
            // atomic_write uses a newly created temp file + rename, so the new file has
            // default permissions; without restoring, an executable script would lose +x
            // after the rewind.
            restore_file_mode(&target, record.mode);
            Ok(true)
        })();
        match restore {
            Ok(true) => result.restored_files += 1,
            Ok(false) => result.clean_files += 1,
            Err(e) => result.failed.push(format!("{display}: {e}")),
        }
    }
    result
}

/// There is a window between validation and action (an attacker could swap root or
/// some parent directory for a symlink there), so immediately before the actual
/// write/delete, run the authorization chain again and confirm the target has not drifted.
fn reverify_target(
    record: &CheckpointRecord,
    target: &Path,
    authorized_roots: &[PathBuf],
) -> Result<(), String> {
    let again = resolve_rewind_target(&record.root, &record.rel_path, authorized_roots)?;
    if again != target {
        return Err("checkpoint target changed during rewind".to_string());
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_rewind_code(
    conversation_id: String,
    turn_seq: u64,
    authorized_roots: Vec<String>,
    expected: Vec<CheckpointExpectedEntry>,
) -> Result<CheckpointRewindResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checkpoint_rewind_code_sync(conversation_id, turn_seq, authorized_roots, expected)
    })
    .await
    .map_err(|e| format!("checkpoint_rewind_code join failed: {e}"))?
}

/// Cleanup entry point: deletes the checkpoint data (index + blobs) for an entire conversation.
#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_clear(conversation_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let dir = conversation_dir(&conversation_id)?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| format!("checkpoint_clear join failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Pre-image capture for worktree subagent merges (called by subagent_worktree_apply)
// ---------------------------------------------------------------------------

/// Pre-image classification for worktree.apply. Err means this path cannot obtain a
/// rewindable pre-image, and the caller must record the reason as an error record
/// rather than silently skipping it.
fn classify_worktree_pre_image(abs: &Path) -> Result<PreImage<'static>, String> {
    match fs::symlink_metadata(abs) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PreImage::Missing),
        Err(e) => Err(format!("pre-image stat failed: {e}")),
        // Symlinks are not captured as pre-images, consistent with the semantics of fs_delete.
        Ok(md) if md.file_type().is_symlink() => Err("symlink pre-image not captured".to_string()),
        Ok(md) if md.is_file() => Ok(PreImage::File(None)),
        Ok(md) if md.is_dir() => Ok(PreImage::Dir),
        Ok(_) => Err("unsupported file type; pre-image not captured".to_string()),
    }
}

/// Before worktree.apply modifies the parent workspace, capture parent-workspace
/// pre-images for paths that will be overwritten/deleted. Paths come from
/// collect_apply_paths (git-relative paths), and root is the parent repository root.
///
/// Returns the paths that could not obtain a pre-image along with the reason: these
/// are capture gaps, but at this moment it is not yet known whether apply will
/// actually modify the parent workspace. If the outcome is already_applied /
/// fallback_noop, the parent repository was not touched at all, and recording the gap
/// as an error would mark a turn where nothing happened as ⚠ "rewind may be
/// incomplete" in the UI. So the gaps are left for the caller to record after
/// confirming apply took effect (see record_worktree_capture_skips).
///
/// Successful pre-images must still be persisted here immediately -- they are content
/// backups, and past this line the parent workspace is about to be overwritten, so
/// delaying would leave nothing to capture.
#[must_use = "capture gaps must be recorded by the caller based on the apply result"]
pub fn capture_worktree_apply_pre_images(
    ctx: Option<&CheckpointCtx>,
    parent_repo_root: &Path,
    rel_paths: &[String],
) -> Vec<(PathBuf, String)> {
    let Some(ctx) = ctx else {
        return Vec::new();
    };
    let mut skipped = Vec::new();
    for rel in rel_paths {
        let rel_path = PathBuf::from(rel);
        let abs = parent_repo_root.join(&rel_path);
        match classify_worktree_pre_image(&abs) {
            Ok(pre_image) => capture_pre_image(Some(ctx), parent_repo_root, &rel_path, pre_image),
            Err(reason) => {
                eprintln!(
                    "checkpoint worktree pre-image skipped for {}: {reason}",
                    abs.display()
                );
                skipped.push((rel_path, reason));
            }
        }
    }
    skipped
}

/// Writes the capture gaps accumulated by capture_worktree_apply_pre_images as error records.
/// Called only when apply actually modified the parent workspace: marking the turn as
/// incomplete requires that this turn genuinely changed something.
pub fn record_worktree_capture_skips(
    ctx: Option<&CheckpointCtx>,
    parent_repo_root: &Path,
    skipped: &[(PathBuf, String)],
) {
    let Some(ctx) = ctx else { return };
    for (rel_path, reason) in skipped {
        record_capture_skip(ctx, parent_repo_root, rel_path, reason);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(file: &Path, root: &Path) -> PathBuf {
        file.strip_prefix(root).unwrap().to_path_buf()
    }

    /// The "currently authorized workspace roots" set in unit tests: equivalent to the frontend passing workspace roots back to the backend.
    fn roots(root: &Path) -> Vec<PathBuf> {
        vec![root.to_path_buf()]
    }

    fn expected_from_diff(ckpt: &Path, turn_seq: u64, root: &Path) -> Vec<CheckpointExpectedEntry> {
        let (records, _) = earliest_records_since(ckpt, turn_seq);
        records
            .iter()
            .map(|r| classify_entry(ckpt, r, &roots(root)))
            .filter_map(|entry| {
                entry.current_hash.map(|hash| CheckpointExpectedEntry {
                    key: entry.key,
                    current_hash: hash,
                })
            })
            .collect()
    }

    #[test]
    fn capture_and_rewind_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        fs::write(&file, "v1").unwrap();

        // Turn 1 modifies: capture the pre-image first, then change.
        let seq = capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&file, &root),
            PreImage::File(None),
        )
        .unwrap();
        fs::write(&file, "v2").unwrap();

        // Rewinding to before turn 1 should restore v1.
        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    }

    #[test]
    fn missing_pre_image_rewinds_to_deletion() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("new.txt");

        let seq = capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&file, &root),
            PreImage::Missing,
        )
        .unwrap();
        fs::write(&file, "created").unwrap();

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.deleted_files, 1);
        assert!(!file.exists());
    }

    #[test]
    fn earliest_record_wins_across_turns() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq1 = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        let seq2 = capture_at(&ckpt, "turn-2", &root, &r, PreImage::File(None)).unwrap();
        assert!(seq2 > seq1);
        fs::write(&file, "v3").unwrap();

        // Rewinding to before turn-1: take the earliest pre-image v1, not turn-2's v2.
        let result = rewind_at(&ckpt, seq1, &roots(&root), None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    }

    #[test]
    fn rewind_to_later_turn_keeps_earlier_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        let seq2 = capture_at(&ckpt, "turn-2", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v3").unwrap();

        // Rewind only turn-2: restore v2 while keeping turn-1's changes.
        let result = rewind_at(&ckpt, seq2, &roots(&root), None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
    }

    #[test]
    fn same_turn_same_path_dedupes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v1a").unwrap();
        // Second touch in the same turn: should skip without adding a record/blob.
        capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();

        let records = read_index(&ckpt);
        assert_eq!(records.len(), 1);
        let blobs: Vec<_> = fs::read_dir(blobs_dir(&ckpt)).unwrap().collect();
        assert_eq!(blobs.len(), 1);
    }

    #[test]
    fn turn_seq_is_monotonic_and_clock_independent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let a = root.join("a.txt");
        let b = root.join("b.txt");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();

        // The same turnId reuses the sequence number; a new turnId strictly increases, regardless of timestamps.
        let s1 = capture_at(&ckpt, "t-x", &root, &rel(&a, &root), PreImage::File(None)).unwrap();
        let s1b = capture_at(&ckpt, "t-x", &root, &rel(&b, &root), PreImage::File(None)).unwrap();
        let s2 = capture_at(&ckpt, "t-y", &root, &rel(&a, &root), PreImage::File(None)).unwrap();
        assert_eq!(s1, s1b);
        assert_eq!(s2, s1 + 1);
    }

    #[test]
    fn begin_turn_creates_stable_zero_file_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");

        begin_turn_at(&ckpt, "turn-1").unwrap();
        let records = read_index(&ckpt);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, "turn");
        assert_eq!(records[0].turn_seq, 1);

        // When a file capture happens after the turn-start marker, it must still be bound to the same user message.
        fs::write(&file, "created").unwrap();
        let seq = capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&file, &root),
            PreImage::Missing,
        )
        .unwrap();
        assert_eq!(seq, records[0].turn_seq);
        let records = read_index(&ckpt);
        assert!(records.iter().any(|record| record.kind == "turn"));
        assert!(records
            .iter()
            .any(|record| record.kind == "file" && record.turn_seq == seq));
    }

    #[test]
    fn rewind_from_zero_file_turn_rewinds_later_file_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("later.txt");

        begin_turn_at(&ckpt, "turn-without-files").unwrap();
        let later_seq = capture_at(
            &ckpt,
            "later-turn",
            &root,
            &rel(&file, &root),
            PreImage::Missing,
        )
        .unwrap();
        fs::write(&file, "created later").unwrap();

        let result = rewind_at(&ckpt, 1, &roots(&root), None);
        assert_eq!(later_seq, 2);
        assert_eq!(result.deleted_files, 1);
        assert!(!file.exists());
    }

    #[test]
    fn turn_boundary_is_not_a_file_rewind_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");

        begin_turn_at(&ckpt, "turn-only").unwrap();
        let (records, errors) = earliest_records_since(&ckpt, 1);
        assert!(records.is_empty());
        assert_eq!(errors, 0);
        let summaries = checkpoint_turn_summaries(read_index(&ckpt));
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].turn_id, "turn-only");
        assert_eq!(summaries[0].file_count, 0);
        assert_eq!(summaries[0].dir_count, 0);

        let result = rewind_at(&ckpt, 1, &roots(&root), None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.deleted_files, 0);
        assert_eq!(result.clean_files, 0);
        assert!(result.failed.is_empty());
    }

    #[test]
    fn rewind_marker_is_never_reused_as_a_turn_seq() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let a = root.join("a.txt");
        fs::write(&a, "a").unwrap();
        let s1 = capture_at(&ckpt, "t-x", &root, &rel(&a, &root), PreImage::File(None)).unwrap();
        // Sentinel marker written by a partial rewind: turn_id empty, turn_seq 0.
        append_rewind_marker(&ckpt, 0);

        // When the caller also passes an empty turnId, it must not reuse the marker's 0, or this turn could never be rewound to.
        let records = read_index(&ckpt);
        assert_eq!(resolve_turn_seq(&records, ""), s1 + 1);
    }

    #[test]
    fn dir_marker_is_skipped_but_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let dir_path = root.join("subdir");
        fs::create_dir_all(&dir_path).unwrap();

        let seq = capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&dir_path, &root),
            PreImage::Dir,
        )
        .unwrap();
        fs::remove_dir_all(&dir_path).unwrap();

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.skipped_dirs, 1);
        assert!(!dir_path.exists());
    }

    #[test]
    fn restore_recreates_missing_parent_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let nested = root.join("x").join("y").join("a.txt");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, "v1").unwrap();

        let seq = capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&nested, &root),
            PreImage::File(None),
        )
        .unwrap();
        fs::remove_dir_all(root.join("x")).unwrap();

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&nested).unwrap(), "v1");
    }

    #[test]
    fn conflict_hash_mismatch_skips_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        // The preview saw v2's state fingerprint; the file is changed to v3 before confirmation -> conflict, skip.
        let preview_hash = current_state_hash(&file);
        fs::write(&file, "v3").unwrap();
        let expected = vec![CheckpointExpectedEntry {
            key: record_key(&normalize_root(&root), &normalize_rel(&r)),
            current_hash: preview_hash,
        }];
        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&expected));
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v3");

        // When the fingerprint matches, restore normally.
        let expected = vec![CheckpointExpectedEntry {
            key: record_key(&normalize_root(&root), &normalize_rel(&r)),
            current_hash: current_state_hash(&file),
        }];
        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&expected));
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_swap_after_capture_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();
        let outside = root.join("outside-secret");
        fs::write(&outside, "secret").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        // Swap the target for a symlink after capture: the rewind must refuse and not follow the link to write.
        fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&outside, &file).unwrap();

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "secret");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_parent_after_capture_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let file = sub.join("a.txt");
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&file, &root),
            PreImage::File(None),
        )
        .unwrap();
        // Replace the entire parent directory with a symlink pointing elsewhere after capture.
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::remove_dir_all(&sub).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &sub).unwrap();

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert!(!elsewhere.join("a.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn multi_hardlink_target_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        // Add a hardlink to the target after capture: restoring would affect the alias path, so it must be refused.
        fs::hard_link(&file, root.join("alias.txt")).unwrap();

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
    }

    #[test]
    fn missing_blob_reports_failure_without_touching_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        // Simulate the blob being lost/truncated and deleted.
        for entry in fs::read_dir(blobs_dir(&ckpt)).unwrap() {
            fs::remove_file(entry.unwrap().path()).unwrap();
        }

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
    }

    #[test]
    fn capture_failure_is_recorded_and_marks_turn_incomplete() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let missing = root.join("does-not-exist.txt");

        // File(None) needs to read from disk on the spot; the file does not exist -> capture fails -> error record.
        let ctx = CheckpointCtx {
            conversation_id: "unused".to_string(),
            turn_id: "turn-1".to_string(),
        };
        let err = capture_at(
            &ckpt,
            &ctx.turn_id,
            &root,
            &rel(&missing, &root),
            PreImage::File(None),
        );
        assert!(err.is_err());
        // capture_pre_image's fallback path appends an error record; here we verify the low-level write directly.
        append_error_record(
            &ckpt,
            1,
            &ctx.turn_id,
            &normalize_root(&root),
            "does-not-exist.txt",
            "read failed",
        );
        let records = read_index(&ckpt);
        assert!(records.iter().any(|r| r.kind == "error"));
        let (recs, errors) = earliest_records_since(&ckpt, 1);
        assert_eq!(recs.len(), 0);
        assert_eq!(errors, 1);
    }

    #[test]
    fn oversized_file_records_error_instead_of_blob() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let big = root.join("big.bin");
        let small = root.join("small.bin");
        fs::write(&big, "0123456789").unwrap();
        fs::write(&small, "ok").unwrap();

        // File(None): metadata alone determines the over-limit, recording an error without reading from disk or producing a blob.
        capture_at_with_limits(
            &ckpt,
            "turn-1",
            &root,
            &rel(&big, &root),
            PreImage::File(None),
            4,
            MAX_TOTAL_BLOB_BYTES,
        )
        .unwrap();
        // File(Some): when the caller already holds the bytes, they are still subject to the same cap.
        capture_at_with_limits(
            &ckpt,
            "turn-1",
            &root,
            &rel(&small, &root),
            PreImage::File(Some(b"too-long-for-cap")),
            4,
            MAX_TOTAL_BLOB_BYTES,
        )
        .unwrap();

        let records = read_index(&ckpt);
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|r| r.kind == "error"));
        assert!(records.iter().all(|r| r.blob.is_none()));
        assert!(records[0].note.as_deref().unwrap().contains("10 bytes"));
        let blobs: Vec<_> = fs::read_dir(blobs_dir(&ckpt)).unwrap().collect();
        assert!(blobs.is_empty());

        // Within the cap, the blob is still persisted normally.
        capture_at_with_limits(
            &ckpt,
            "turn-2",
            &root,
            &rel(&small, &root),
            PreImage::File(None),
            4,
            MAX_TOTAL_BLOB_BYTES,
        )
        .unwrap();
        assert_eq!(fs::read_dir(blobs_dir(&ckpt)).unwrap().count(), 1);
    }

    #[test]
    fn total_storage_cap_records_error_instead_of_blob() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let a = root.join("a.txt");
        let b = root.join("b.txt");
        fs::write(&a, "aaaa").unwrap();
        fs::write(&b, "bbbb").unwrap();

        capture_at_with_limits(
            &ckpt,
            "t-1",
            &root,
            &rel(&a, &root),
            PreImage::File(None),
            64,
            6,
        )
        .unwrap();
        capture_at_with_limits(
            &ckpt,
            "t-2",
            &root,
            &rel(&b, &root),
            PreImage::File(None),
            64,
            6,
        )
        .unwrap();

        let records = read_index(&ckpt);
        assert_eq!(records.len(), 2);
        assert!(records[0].blob.is_some());
        assert_eq!(records[1].kind, "error");
        assert!(records[1]
            .note
            .as_deref()
            .unwrap()
            .contains("storage cap reached"));
    }

    #[test]
    fn v1_index_lines_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        fs::create_dir_all(&ckpt).unwrap();
        // Old v1 lines (absolute-path schema, no schema field) must be silently skipped.
        fs::write(
            index_path(&ckpt),
            "{\"turnSeq\":1,\"path\":\"/tmp/a\",\"kind\":\"file\",\"existedBefore\":true,\"blob\":null,\"size\":0,\"mtimeMs\":0,\"capturedAt\":0}\n",
        )
        .unwrap();
        assert!(read_index(&ckpt).is_empty());
    }

    #[test]
    fn worktree_apply_pre_images_capture_parent_state() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let parent = root.join("parent");
        fs::create_dir_all(&parent).unwrap();
        let existing = parent.join("mod.txt");
        fs::write(&existing, "parent-v1").unwrap();

        // Inject the conversation directory in a controlled way: verify the worktree
        // capture logic equivalently through the low-level capture_at
        // (capture_worktree_apply_pre_images goes through the home directory, so the
        // unit test makes an isomorphic assertion about the classification logic).
        let ckpt = root.join("ckpt");
        let paths = ["mod.txt".to_string(), "new.txt".to_string()];
        for rel_str in &paths {
            let rel_path = PathBuf::from(rel_str);
            let abs = parent.join(&rel_path);
            let pre_image = match fs::symlink_metadata(&abs) {
                Err(_) => PreImage::Missing,
                Ok(md) if md.is_file() => PreImage::File(None),
                Ok(_) => PreImage::Dir,
            };
            capture_at(&ckpt, "turn-1", &parent, &rel_path, pre_image).unwrap();
        }
        // Simulate apply: overwrite an existing file + create a new file.
        fs::write(&existing, "worktree-v2").unwrap();
        fs::write(parent.join("new.txt"), "worktree-new").unwrap();

        let result = rewind_at(&ckpt, 1, &roots(&parent), None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(result.deleted_files, 1);
        assert_eq!(fs::read_to_string(&existing).unwrap(), "parent-v1");
        assert!(!parent.join("new.txt").exists());
    }

    /// worktree.apply's pre-image capture happens before any apply branch, so when
    /// the fallback resolves to already_applied / fallback_noop (the parent repository
    /// was not touched at all), these records are already persisted. The contract is:
    /// they never cause a wrong rewind -- the pre-image equals the current content, so
    /// they are always classified as clean.
    ///
    /// Locking down this contract means that if anyone later changes classify_entry's
    /// equality check or the capture timing, redundant records would immediately
    /// escalate into "the rewind deletes files the user never touched".
    #[test]
    fn worktree_noop_apply_records_rewind_as_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let parent = root.join("parent");
        fs::create_dir_all(&parent).unwrap();
        let ckpt = root.join("ckpt");

        // Already exists in the parent repository and its content already equals the worktree target content (already_applied).
        let already = parent.join("same.txt");
        fs::write(&already, "identical").unwrap();
        capture_at(
            &ckpt,
            "turn-1",
            &parent,
            &PathBuf::from("same.txt"),
            PreImage::File(None),
        )
        .unwrap();

        // A path that does not exist in the parent repository: capture records
        // Missing. If the fallback copies nothing, this file never appears, and the
        // rewind must not treat it as "created this turn" and delete it.
        capture_at(
            &ckpt,
            "turn-1",
            &parent,
            &PathBuf::from("never-created.txt"),
            PreImage::Missing,
        )
        .unwrap();

        // apply is a noop: the parent workspace is not modified at all.
        let result = rewind_at(&ckpt, 1, &roots(&parent), None);
        assert_eq!(result.restored_files, 0, "unchanged content must not be written back as a restore");
        assert_eq!(
            result.deleted_files, 0,
            "this turn never created a file, so it must not be deleted as newly created"
        );
        assert_eq!(result.clean_files, 2);
        assert!(result.failed.is_empty());
        assert!(result.conflicts.is_empty());
        // The most critical point: after rewinding a noop turn, the parent workspace must be left exactly as-is.
        assert_eq!(fs::read_to_string(&already).unwrap(), "identical");
        assert!(!parent.join("never-created.txt").exists());
    }

    #[test]
    fn diff_classification_matches_state() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let dirty = root.join("dirty.txt");
        let clean = root.join("clean.txt");
        fs::write(&dirty, "v1").unwrap();
        fs::write(&clean, "same").unwrap();

        capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&dirty, &root),
            PreImage::File(None),
        )
        .unwrap();
        capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&clean, &root),
            PreImage::File(None),
        )
        .unwrap();
        fs::write(&dirty, "v2").unwrap();

        let (records, _) = earliest_records_since(&ckpt, 1);
        let entries: Vec<_> = records
            .iter()
            .map(|r| classify_entry(&ckpt, r, &roots(&root)))
            .collect();
        let dirty_entry = entries
            .iter()
            .find(|e| e.path.ends_with("dirty.txt"))
            .unwrap();
        let clean_entry = entries
            .iter()
            .find(|e| e.path.ends_with("clean.txt"))
            .unwrap();
        assert_eq!(dirty_entry.action, "restore");
        assert_eq!(clean_entry.action, "clean");
        // The preview returns the current-state fingerprint (content + permission bits) for rewind's conflict comparison.
        assert_eq!(
            dirty_entry.current_hash.as_deref(),
            Some(current_state_hash(&dirty).as_str())
        );
    }

    #[test]
    fn authorized_roots_include_backend_owned_repo_and_skills_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let repo = base.join("repo");
        let workspace = repo.join("crates").join("app");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(repo.join(".git")).unwrap();

        let authorized = canonical_authorized_roots(&[workspace.to_string_lossy().to_string()]);
        assert!(authorized.contains(&workspace));
        // worktree apply records pre-images under the parent repository root; omitting it would make those turns forever unrewindable.
        assert!(authorized.contains(&fs::canonicalize(&repo).unwrap()));
        // skill:// writes are recorded under the Skills root, which likewise must be in the set.
        let skills_root = crate::services::skills::skills_root_dir().unwrap();
        assert!(authorized.contains(&skills_root));
    }

    #[test]
    fn worktree_records_under_parent_repo_root_stay_rewindable() {
        let tmp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let repo = base.join("repo");
        let workspace = repo.join("crates").join("app");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(repo.join(".git")).unwrap();
        let ckpt = base.join("ckpt");

        // Simulate capture_worktree_apply_pre_images: the pre-image is recorded under the parent repository root.
        let file = repo.join("shared.txt");
        fs::write(&file, "v1").unwrap();
        let seq = capture_at(
            &ckpt,
            "turn-1",
            &fs::canonicalize(&repo).unwrap(),
            &rel(&file, &repo),
            PreImage::File(None),
        )
        .unwrap();
        fs::write(&file, "v2").unwrap();

        // The frontend can only supply the workspace root; the parent repository root is filled in by backend derivation.
        let authorized = canonical_authorized_roots(&[workspace.to_string_lossy().to_string()]);
        let result = rewind_at(&ckpt, seq, &authorized, None);
        assert!(result.failed.is_empty(), "failed: {:?}", result.failed);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    }

    #[test]
    fn rewind_marker_cuts_stale_future_turns() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 1);

        // A fully successful rewind writes a turn_seq=target marker: turn-1 is part of
        // the "revoked future" and should neither appear in the menu again nor
        // participate in the next aggregation.
        append_rewind_marker(&ckpt, seq);
        assert!(live_records(read_index(&ckpt)).is_empty());
        let (records, errors) = earliest_records_since(&ckpt, 1);
        assert!(records.is_empty());
        assert_eq!(errors, 0);

        // Pruning only affects the read side: a new turn still gets a larger turn_seq and cannot collide with stale records.
        fs::write(&file, "v3").unwrap();
        let next = capture_at(&ckpt, "turn-2", &root, &r, PreImage::File(None)).unwrap();
        assert!(next > seq);
        let (records, _) = earliest_records_since(&ckpt, next);
        assert_eq!(records.len(), 1);
    }

    #[test]
    fn partial_rewind_marker_does_not_cut_timeline() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        // On partial success (conflicts/failures), the marker is turn_seq=0: audit only,
        // no pruning, otherwise paths that were not successfully rewound would be permanently buried.
        append_rewind_marker(&ckpt, 0);
        let (records, _) = earliest_records_since(&ckpt, seq);
        assert_eq!(records.len(), 1);
        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 1);
    }

    fn append_rewind_marker(ckpt: &Path, turn_seq: u64) {
        append_record(
            ckpt,
            &CheckpointRecord {
                schema: 2,
                turn_seq,
                turn_id: String::new(),
                root: String::new(),
                rel_path: String::new(),
                kind: "rewind".to_string(),
                existed_before: false,
                blob: None,
                size: 0,
                mtime_ms: 0,
                captured_at: now_ms(),
                note: None,
                mode: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn missing_expected_hash_is_treated_as_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let dirty = root.join("dirty.txt");
        let untouched = root.join("clean.txt");
        fs::write(&dirty, "v1").unwrap();
        fs::write(&untouched, "same").unwrap();

        let seq = capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&dirty, &root),
            PreImage::File(None),
        )
        .unwrap();
        capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&untouched, &root),
            PreImage::File(None),
        )
        .unwrap();
        fs::write(&dirty, "v2").unwrap();

        // At preview time clean.txt was clean; it is hand-edited during the confirmation
        // dialog. When only the hashes of restore entries are returned (old frontend
        // behavior), the backend must treat it as a conflict rather than overwriting as before.
        let only_restore: Vec<CheckpointExpectedEntry> = expected_from_diff(&ckpt, seq, &root)
            .into_iter()
            .filter(|e| e.key.ends_with("dirty.txt"))
            .collect();
        assert_eq!(only_restore.len(), 1);
        fs::write(&untouched, "hand-edited").unwrap();

        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&only_restore));
        assert_eq!(result.restored_files, 1);
        assert_eq!(result.conflicts.len(), 1);
        assert!(result.conflicts[0].ends_with("clean.txt"));
        assert_eq!(fs::read_to_string(&untouched).unwrap(), "hand-edited");

        // Only when the hashes of all resolvable entries are returned in full does it actually overwrite.
        let full = expected_from_diff(&ckpt, seq, &root);
        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&full));
        assert!(result.conflicts.is_empty());
        assert_eq!(fs::read_to_string(&untouched).unwrap(), "same");
    }

    #[test]
    fn unauthorized_root_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        // When the authorized set is empty (or does not contain this root), always refuse and leave the file as-is.
        let result = rewind_at(&ckpt, seq, &[], None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert!(result.failed[0].contains("authorized workspace root"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");

        // The diff preview side uses the same rule: mark unresolvable without returning a hash.
        let (records, _) = earliest_records_since(&ckpt, seq);
        let entry = classify_entry(&ckpt, &records[0], &[]);
        assert_eq!(entry.action, "unresolvable");
        assert!(entry.current_hash.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_root_after_rename_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let root = base.join("workspace");
        fs::create_dir_all(&root).unwrap();
        let ckpt = base.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        // Rename the whole workspace, then mount a symlink at the original path
        // pointing to a directory outside it: a direct canonicalize would follow the
        // link and write the rewind outside the workspace.
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("a.txt"), "outside-secret").unwrap();
        fs::rename(&root, base.join("workspace-moved")).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();

        // Even if the frontend passes the ("current") workspace root back verbatim it is refused: if the root itself is a symlink, reject.
        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert!(result.failed[0].contains("symlinked checkpoint root"));
        assert_eq!(
            fs::read_to_string(outside.join("a.txt")).unwrap(),
            "outside-secret"
        );

        // canonical_authorized_roots also does not trust a symlinked root: it never appears in the set.
        let authorized = canonical_authorized_roots(&[root.to_string_lossy().to_string()]);
        assert!(!authorized.contains(&root));
    }

    #[cfg(unix)]
    #[test]
    fn worktree_pre_image_classification_reports_skips() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let file = root.join("a.txt");
        fs::write(&file, "v1").unwrap();
        let dir_path = root.join("sub");
        fs::create_dir_all(&dir_path).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&file, &link).unwrap();

        assert!(matches!(
            classify_worktree_pre_image(&file),
            Ok(PreImage::File(None))
        ));
        assert!(matches!(
            classify_worktree_pre_image(&dir_path),
            Ok(PreImage::Dir)
        ));
        assert!(matches!(
            classify_worktree_pre_image(&root.join("nope.txt")),
            Ok(PreImage::Missing)
        ));
        // Symlinks are not silently skipped: the reason is returned for the caller to write as an error record.
        // Use let-else rather than unwrap_err(): the latter requires PreImage: Debug,
        // but PreImage::File holds the file content itself, which should not be made
        // printable in a panic message just for one test assertion.
        let Err(err) = classify_worktree_pre_image(&link) else {
            panic!("a symlink must not be treated as a capturable pre-image");
        };
        assert!(err.contains("symlink"));
    }

    #[test]
    fn capture_error_marks_rewind_partial_and_keeps_timeline() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        // Another file in the same turn fails to capture: there is only an error record and no pre-image to rewind to.
        append_error_record(
            &ckpt,
            seq,
            "turn-1",
            &normalize_root(&root),
            "big.bin",
            "file too large to checkpoint",
        );
        fs::write(&file, "v2").unwrap();

        let result = {
            let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            rewind_and_mark_at(&ckpt, seq, &roots(&root), None)
        };
        // Files with a pre-image are restored as usual, but the result must report the capture gap and does not count as a complete rewind.
        assert_eq!(result.restored_files, 1);
        assert_eq!(result.capture_errors, 1);
        assert!(!rewind_is_complete(&result));
        // The marker must be turn_seq=0 (audit only, no pruning): the turn along with
        // its error record remains visible, rather than hiding the incompleteness from
        // the timeline after a "successful rewind".
        let live = live_records(read_index(&ckpt));
        assert!(live.iter().any(|rec| rec.kind == "error"));
        assert!(live.iter().any(|rec| rec.kind == "file"));
    }

    #[test]
    fn complete_rewind_marker_prunes_timeline() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        let result = {
            let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            rewind_and_mark_at(&ckpt, seq, &roots(&root), None)
        };
        assert!(rewind_is_complete(&result));
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
        // Only a complete rewind with no gaps may prune, so revoked turns no longer remain in the menu.
        assert!(live_records(read_index(&ckpt)).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn chmod_between_preview_and_rewind_is_a_conflict() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        // The user chmods after the preview (which carried the state fingerprint) but
        // before confirmation: it must be treated as a conflict and skipped, leaving
        // both content and permissions as-is, not silently changing permissions back to
        // the capture-time values.
        let expected = expected_from_diff(&ckpt, seq, &root);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();

        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&expected));
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
        assert_eq!(file_mode(&file).unwrap() & 0o777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn mode_only_drift_previews_as_restore_and_is_restored() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("run.sh");
        let r = rel(&file, &root);
        fs::write(&file, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        // Content unchanged but permission bits drifted: the preview must disclose it
        // as restore, not disguise it as clean and then quietly change permissions.
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();

        let (records, _) = earliest_records_since(&ckpt, seq);
        let entry = classify_entry(&ckpt, &records[0], &roots(&root));
        assert_eq!(entry.action, "restore");

        let expected = expected_from_diff(&ckpt, seq, &root);
        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&expected));
        assert_eq!(result.restored_files, 1);
        assert_eq!(file_mode(&file).unwrap() & 0o777, 0o755);
        assert_eq!(fs::read_to_string(&file).unwrap(), "#!/bin/sh\n");
    }
}
