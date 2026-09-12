use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::future::Future;
use std::io::{BufReader, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::runtime::platform::expand_tilde_path;
use crate::services::power_activity::PowerActivityManager;
pub use crate::services::skills::{
    SystemListSkillFilesResponse, SystemManageSkillResponse, SystemReadSkillMetadataResponse,
    SystemReadSkillTextResponse,
};

const UPLOADED_IMAGE_PREVIEW_MAX_BYTES: usize = 5 * 1024 * 1024; // 5MB
const IMAGE_PREVIEW_DATA_MAX_BYTES: usize = 25 * 1024 * 1024; // Keep preview actions bounded.
const IMAGE_PREVIEW_MAX_DIMENSION: u32 = 8_192;
const IMAGE_PREVIEW_MAX_ALLOC_BYTES: u64 = 64 * 1024 * 1024;
const IMAGE_PREVIEW_CLIPBOARD_CACHE_TTL: Duration = Duration::from_secs(2 * 60);
const IMAGE_PREVIEW_SAVE_TARGET_TTL: Duration = Duration::from_secs(5 * 60);
const UPLOADED_NATIVE_ATTACHMENT_MAX_BYTES: u64 = 25 * 1024 * 1024; // 25MB

#[derive(Debug)]
struct PendingImagePreviewSaveTarget {
    target: PathBuf,
    created_at: SystemTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ImagePreviewFileSignature {
    len: u64,
    modified_at: Option<SystemTime>,
}

#[derive(Debug)]
struct PreparedImagePreviewClipboard {
    target: PathBuf,
    signature: ImagePreviewFileSignature,
    prepared_at: SystemTime,
    width: usize,
    height: usize,
    rgba: Vec<u8>,
}

static PENDING_IMAGE_PREVIEW_SAVE_TARGETS: OnceLock<
    Mutex<HashMap<String, PendingImagePreviewSaveTarget>>,
> = OnceLock::new();

static PREPARED_IMAGE_PREVIEW_CLIPBOARD: OnceLock<Mutex<Option<PreparedImagePreviewClipboard>>> =
    OnceLock::new();

fn pending_image_preview_save_targets(
) -> &'static Mutex<HashMap<String, PendingImagePreviewSaveTarget>> {
    PENDING_IMAGE_PREVIEW_SAVE_TARGETS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prepared_image_preview_clipboard() -> &'static Mutex<Option<PreparedImagePreviewClipboard>> {
    PREPARED_IMAGE_PREVIEW_CLIPBOARD.get_or_init(|| Mutex::new(None))
}
const UPLOADED_TEXT_TRANSCODE_MAX_BYTES: u64 = 64 * 1024 * 1024; // 64MB; above this size, persist as-is without transcoding

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemReadableFileEntry {
    pub relative_path: String,
    pub absolute_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
    pub file_name: String,
    pub kind: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPickReadableFilesResponse {
    pub files: Vec<SystemReadableFileEntry>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SystemReadableFileUploadInput {
    pub file_name: String,
    pub mime_type: Option<String>,
    pub content: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUploadedReadableFileInput {
    pub file_name: String,
    pub mime_type: Option<String>,
    pub content_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPastedTextInput {
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUploadedImagePreviewResponse {
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUploadedNativeAttachmentResponse {
    pub mime_type: String,
    pub data: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCreateProjectFolderResponse {
    pub path: String,
}

fn app_storage_dir() -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Failed to locate the user home directory".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create the application directory: {e}"))?;
    Ok(dir)
}

fn debug_root_dir() -> Result<PathBuf, String> {
    let dir = app_storage_dir()?.join("debug");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create debug directory: {e}"))?;
    Ok(dir)
}

fn sanitize_debug_file_stem(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Conversation ID cannot be empty".to_string());
    }
    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Ok(trimmed.to_string());
    }
    Err(format!("Invalid conversation ID: {input}"))
}

fn canonicalize_upload_workdir(workdir: &str) -> Result<PathBuf, String> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err("Project directory not selected; cannot import files".to_string());
    }

    let path = expand_tilde_path(raw);
    if !path.is_absolute() {
        return Err(format!("Working directory must be an absolute path: {workdir}"));
    }

    let metadata =
        fs::metadata(&path).map_err(|_| format!("Working directory does not exist or is inaccessible: {workdir}"))?;
    if !metadata.is_dir() {
        return Err(format!("Working directory is not a folder: {workdir}"));
    }

    fs::canonicalize(&path).map_err(|e| format!("Failed to resolve working directory: {e}"))
}

fn infer_image_upload_kind(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp") | Some("bmp")
        | Some("svg") | Some("ico") => Some("image"),
        _ => None,
    }
}

fn infer_image_upload_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("bmp") => Some("image/bmp"),
        Some("svg") => Some("image/svg+xml"),
        Some("ico") => Some("image/x-icon"),
        _ => None,
    }
}

fn is_pdf_upload(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("pdf")),
        Some(true)
    )
}

fn is_notebook_upload(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("ipynb")),
        Some(true)
    )
}

fn upload_extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

fn upload_file_name_lower(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_word_upload(path: &Path) -> bool {
    matches!(
        upload_extension_lower(path).as_deref(),
        Some("docx") | Some("doc")
    )
}

fn is_spreadsheet_upload(path: &Path) -> bool {
    matches!(
        upload_extension_lower(path).as_deref(),
        Some("xlsx") | Some("xlsm") | Some("xltx") | Some("xltm") | Some("xls")
    )
}

fn is_archive_upload(path: &Path) -> bool {
    let name = upload_file_name_lower(path);
    matches!(
        upload_extension_lower(path).as_deref(),
        Some("zip")
            | Some("rar")
            | Some("7z")
            | Some("tar")
            | Some("gz")
            | Some("tgz")
            | Some("bz2")
            | Some("xz")
            | Some("txz")
            | Some("tbz")
            | Some("tbz2")
    ) || name.ends_with(".tar.gz")
        || name.ends_with(".tar.bz2")
        || name.ends_with(".tar.xz")
}

fn normalized_mime_matches(mime_type: Option<&str>, candidates: &[&str]) -> bool {
    let Some(normalized) = mime_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
    else {
        return false;
    };
    candidates.iter().any(|candidate| normalized == *candidate)
}

fn is_word_upload_mime(mime_type: Option<&str>) -> bool {
    normalized_mime_matches(
        mime_type,
        &[
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
    )
}

fn is_spreadsheet_upload_mime(mime_type: Option<&str>) -> bool {
    normalized_mime_matches(
        mime_type,
        &[
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel.sheet.macroenabled.12",
            "application/vnd.ms-excel.template.macroenabled.12",
        ],
    )
}

fn is_archive_upload_mime(mime_type: Option<&str>) -> bool {
    normalized_mime_matches(
        mime_type,
        &[
            "application/zip",
            "application/x-zip-compressed",
            "application/x-7z-compressed",
            "application/vnd.rar",
            "application/x-rar-compressed",
            "application/gzip",
            "application/x-gzip",
            "application/x-tar",
            "application/x-bzip2",
            "application/x-xz",
        ],
    )
}

fn probe_file_prefix(path: &Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| format!("Failed to open file {}: {e}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut buffer = vec![0u8; max_bytes.max(1)];
    let read = reader
        .read(&mut buffer)
        .map_err(|e| format!("Failed to read file {}: {e}", path.display()))?;
    buffer.truncate(read);
    Ok(buffer)
}

const UPLOAD_TEXT_PROBE_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadTextClass {
    /// The content is valid UTF-8 (or an empty file) and can be used as-is.
    Utf8,
    /// The content is text, but uses a non-UTF-8 encoding such as GBK/Big5/Shift-JIS/UTF-16;
    /// the staged copy must be transcoded to UTF-8, otherwise downstream Read/native attachment inlining is garbled.
    NeedsTranscode,
    /// It is not parseable text.
    Binary,
}

/// Uploaded-text detection cannot rely on strict UTF-8 validation alone: on Chinese Windows, .txt files are commonly GBK/
/// UTF-16 (Notepad "Unicode"), and because probing only examines a prefix, a truncated UTF-8 multi-byte character
/// also makes strict validation fail — neither of these cases is a binary file.
fn classify_upload_text_bytes(bytes: &[u8], prefix_truncated: bool) -> UploadTextClass {
    if bytes.is_empty() {
        return UploadTextClass::Utf8;
    }
    // The UTF-16 BOM must be checked before the NUL check: UTF-16-encoded ASCII characters always carry 0x00.
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return UploadTextClass::NeedsTranscode;
    }
    if bytes.contains(&0) {
        return UploadTextClass::Binary;
    }
    let stripped = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(stripped) {
        Ok(_) => return UploadTextClass::Utf8,
        Err(error) => {
            // The probe prefix truncated a trailing multi-byte character (error_len() == None means the sequence
            // is incomplete rather than invalid), so the whole file may still be valid UTF-8.
            if prefix_truncated
                && error.error_len().is_none()
                && stripped.len() - error.valid_up_to() < 4
            {
                return UploadTextClass::Utf8;
            }
        }
    }
    // No NUL and not UTF-8: use the control-character ratio to distinguish legacy-encoded text from binary.
    // GBK/Big5/Shift-JIS multi-byte sequences all fall at or above 0x80, and body control characters
    // should only be \t \n \r (plus a few \x0C form feeds and \x1B escapes).
    let suspicious = stripped
        .iter()
        .filter(|byte| matches!(**byte, 0x01..=0x08 | 0x0B | 0x0E..=0x1A | 0x1C..=0x1F | 0x7F))
        .count();
    if suspicious * 32 > stripped.len() {
        UploadTextClass::Binary
    } else {
        UploadTextClass::NeedsTranscode
    }
}

fn classify_upload_text_file(path: &Path) -> Result<UploadTextClass, String> {
    let buffer = probe_file_prefix(path, UPLOAD_TEXT_PROBE_BYTES)?;
    let prefix_truncated = buffer.len() == UPLOAD_TEXT_PROBE_BYTES;
    Ok(classify_upload_text_bytes(&buffer, prefix_truncated))
}

/// Transcode non-UTF-8 text to UTF-8. The input must be the full file content (classification may
/// be based on a truncated prefix; re-check the full bytes here, returning valid UTF-8 as-is).
fn transcode_upload_text_to_utf8(bytes: &[u8]) -> Vec<u8> {
    if bytes.is_empty() || std::str::from_utf8(bytes).is_ok() {
        return bytes.to_vec();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return text.into_owned().into_bytes();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        return text.into_owned().into_bytes();
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned().into_bytes()
}

#[derive(Debug, Clone, Copy)]
struct DetectedUploadKind {
    kind: &'static str,
    /// Can only be true when kind == "text": the staged copy must be transcoded to UTF-8 before being written to disk.
    needs_utf8_transcode: bool,
}

impl DetectedUploadKind {
    fn plain(kind: &'static str) -> Self {
        Self {
            kind,
            needs_utf8_transcode: false,
        }
    }

    fn from_text_class(class: UploadTextClass) -> Option<Self> {
        match class {
            UploadTextClass::Utf8 => Some(Self::plain("text")),
            UploadTextClass::NeedsTranscode => Some(Self {
                kind: "text",
                needs_utf8_transcode: true,
            }),
            UploadTextClass::Binary => None,
        }
    }
}

fn detect_upload_file_kind(path: &Path) -> Result<DetectedUploadKind, String> {
    if let Some(kind) = infer_image_upload_kind(path) {
        return Ok(DetectedUploadKind::plain(kind));
    }
    if is_pdf_upload(path) {
        return Ok(DetectedUploadKind::plain("pdf"));
    }
    if is_notebook_upload(path) {
        return Ok(DetectedUploadKind::plain("notebook"));
    }
    if is_word_upload(path) {
        return Ok(DetectedUploadKind::plain("word"));
    }
    if is_spreadsheet_upload(path) {
        return Ok(DetectedUploadKind::plain("spreadsheet"));
    }
    if is_archive_upload(path) {
        return Ok(DetectedUploadKind::plain("archive"));
    }
    if let Some(detected) = DetectedUploadKind::from_text_class(classify_upload_text_file(path)?) {
        return Ok(detected);
    }
    Err(format!(
        "{} is not a text/image/PDF/notebook/Word/Excel/archive file that Read currently supports",
        path.display()
    ))
}

fn detect_uploaded_bytes_kind(
    file_name: &str,
    mime_type: Option<&str>,
    bytes: &[u8],
) -> Result<DetectedUploadKind, String> {
    let path = Path::new(file_name);
    let normalized_mime = mime_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());

    if normalized_mime
        .as_deref()
        .map(|value| value.starts_with("image/"))
        .unwrap_or(false)
    {
        return Ok(DetectedUploadKind::plain("image"));
    }
    if let Some(kind) = infer_image_upload_kind(path) {
        return Ok(DetectedUploadKind::plain(kind));
    }
    if normalized_mime.as_deref() == Some("application/pdf") || is_pdf_upload(path) {
        return Ok(DetectedUploadKind::plain("pdf"));
    }
    if is_notebook_upload(path) {
        return Ok(DetectedUploadKind::plain("notebook"));
    }
    if is_word_upload(path) || is_word_upload_mime(mime_type) {
        return Ok(DetectedUploadKind::plain("word"));
    }
    if is_spreadsheet_upload(path) || is_spreadsheet_upload_mime(mime_type) {
        return Ok(DetectedUploadKind::plain("spreadsheet"));
    }
    if is_archive_upload(path) || is_archive_upload_mime(mime_type) {
        return Ok(DetectedUploadKind::plain("archive"));
    }
    if let Some(detected) =
        DetectedUploadKind::from_text_class(classify_upload_text_bytes(bytes, false))
    {
        return Ok(detected);
    }

    Err(format!(
        "{file_name} is not a text/image/PDF/notebook/Word/Excel/archive file that Read currently supports"
    ))
}

fn sanitize_uploaded_file_name(input: &str) -> String {
    // A file name only needs to be a safe single path component: keep non-ASCII characters such as Chinese, replacing only
    // path separators, Windows-reserved symbols, and control characters. The former ASCII allowlist ground
    // all-Chinese file names down to a bare extension ("report.pdf" -> "pdf").
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_control() || matches!(ch, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    // Trailing spaces/dots are illegal on Windows, and a hidden file's leading dot is trimmed as well.
    let trimmed = out.trim_matches(|ch: char| ch == '.' || ch.is_whitespace());
    let candidate = if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.to_string()
    };
    avoid_windows_reserved_file_name(candidate)
}

/// Directory import must preserve legitimate leading dots such as `.env`, `.gitignore`, and `.github`; it only cleans
/// cross-platform illegal characters and trailing spaces/dots that Windows disallows. Exact `.`/`..` are rejected by the caller.
fn sanitize_import_path_component(input: &str) -> Option<String> {
    if input == "." || input == ".." {
        return None;
    }
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_control() || matches!(ch, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim_end_matches(|ch: char| ch == '.' || ch.is_whitespace());
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
    }
    Some(avoid_windows_reserved_file_name(trimmed.to_string()))
}

fn is_windows_reserved_file_name(input: &str) -> bool {
    let stem = input
        .split('.')
        .next()
        .unwrap_or(input)
        .trim_matches(|ch| ch == ' ' || ch == '.')
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

fn avoid_windows_reserved_file_name(candidate: String) -> String {
    if !is_windows_reserved_file_name(&candidate) {
        return candidate;
    }
    if let Some(dot_index) = candidate.find('.') {
        return format!(
            "{}_file{}",
            &candidate[..dot_index],
            &candidate[dot_index..]
        );
    }
    format!("{candidate}_file")
}

fn unique_path_for_copy(mut target: PathBuf) -> PathBuf {
    if !target.exists() {
        return target;
    }

    let stem = target
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = target
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string());
    let parent = target.parent().map(Path::to_path_buf).unwrap_or_default();

    for idx in 2..=10_000usize {
        let file_name = match ext.as_deref() {
            Some(ext) if !ext.is_empty() => format!("{stem}-{idx}.{ext}"),
            _ => format!("{stem}-{idx}"),
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    target.set_file_name(format!(
        "{}-{}",
        stem,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    target
}

fn rel_to_workdir_forward_slash(workdir: &Path, abs: &Path) -> Result<String, String> {
    abs.strip_prefix(workdir)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map_err(|_| format!("Path escapes the working directory: {}", abs.display()))
}

/// Upload staging base directory (`~/.liveagent/uploads`). Uploaded attachments are conversation assets rather than
/// workspace files: they live in the app storage domain, avoiding pollution of the workspace's git status and file tree.
///
/// Returns the logical path (not canonicalized): disk writes, display, and the
/// absolute_path persisted in messages all use it, avoiding exposing `\\?\` verbatim paths to
/// the user and the model on Windows. Authorization comparisons always go through [`canonical_upload_staging_base`].
fn upload_staging_base() -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        Ok(test_upload_staging_base().to_path_buf())
    }
    #[cfg(not(test))]
    {
        Ok(app_storage_dir()?.join("uploads"))
    }
}

/// Test-process-only staging root: all staging-related tests write into the system temp directory and never touch
/// the real `~/.liveagent/uploads`. On Unix the staging root deliberately passes through a symlink,
/// so that tests exercising the full command chain necessarily cover the "logical path != canonical path" comparison
/// (the counterpart on Windows is the `\\?\` verbatim prefix and symlink-home distributions).
#[cfg(test)]
fn test_upload_staging_base() -> &'static Path {
    use std::sync::OnceLock;
    static BASE: OnceLock<PathBuf> = OnceLock::new();
    BASE.get_or_init(|| {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "liveagent-upload-staging-test-{}-{unique}",
            std::process::id()
        ));
        let real = root.join("real");
        fs::create_dir_all(&real).expect("create test staging dir");
        #[cfg(unix)]
        {
            let link = root.join("staging");
            std::os::unix::fs::symlink(&real, &link).expect("symlink test staging dir");
            link
        }
        #[cfg(not(unix))]
        {
            real
        }
    })
}

/// Staging root used for authorization comparisons. Attachment read targets always come from `fs::canonicalize`
/// (on Windows this is the `\\?\C:\...` verbatim form, with symlinks already resolved), so a logical
/// path compared to it component-wise is never equal; the staging root must also be canonicalized into the same form
/// before comparison. It returns None when the directory does not exist (no staged file was ever written), in which case the staging branch does not permit access.
fn canonical_upload_staging_base() -> Option<PathBuf> {
    let base = upload_staging_base().ok()?;
    fs::canonicalize(base).ok()
}

/// Number of days staged files are retained: expired batches are cleaned up by the startup GC. Attachment paths are persisted in history messages,
/// so they are not tied to deleting any single conversation; time-based reclamation is consistent with the "staging area" semantics.
const UPLOAD_STAGING_RETENTION: std::time::Duration =
    std::time::Duration::from_secs(30 * 24 * 60 * 60);

fn upload_import_root_in(base: &Path) -> Result<PathBuf, String> {
    let batch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    fs::create_dir_all(base).map_err(|e| format!("Failed to create upload directory {}: {e}", base.display()))?;
    // The batch directory is the semantic unit of a "single import": files in the same batch share a directory, and both GC and cleanup
    // delete the whole directory. When concurrent imports in the same millisecond collide on a name, a sequence number is appended to obtain a separate directory, never shared
    // (create_dir rather than create_dir_all; an existing directory counts as a collision).
    for suffix in 0u32..1000 {
        let name = if suffix == 0 {
            batch.to_string()
        } else {
            format!("{batch}-{suffix}")
        };
        let root = base.join(name);
        match fs::create_dir(&root) {
            Ok(()) => return Ok(root),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to create upload directory {}: {e}", root.display())),
        }
    }
    Err(format!(
        "Failed to create upload directory: too many batch name collisions under {}",
        base.display()
    ))
}

fn upload_import_root() -> Result<PathBuf, String> {
    upload_import_root_in(&upload_staging_base()?)
}

fn gc_upload_staging_in(base: &Path, now: SystemTime, retention: std::time::Duration) -> usize {
    let Ok(entries) = fs::read_dir(base) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let expired = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > retention);
        if expired && fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Clean up expired upload batches at startup; failures are only logged and never block startup.
pub fn gc_upload_staging_on_startup() {
    tauri::async_runtime::spawn_blocking(|| {
        if let Ok(base) = upload_staging_base() {
            gc_upload_staging_in(&base, SystemTime::now(), UPLOAD_STAGING_RETENTION);
        }
    });
}

fn build_readable_file_entry(
    workdir: &Path,
    destination: &Path,
    kind: &str,
    size_bytes: u64,
    dedupe_key: Option<String>,
) -> Result<SystemReadableFileEntry, String> {
    // Files inside the workspace use their real relative path; staged files use a display path of the form
    // `uploads/<batch>/<name>` (UI badges, paste references, and dedup keys all consume this field), while the model-side
    // read path always relies on absolute_path. Caller contract: the staging destination
    // is assembled from upload_staging_base's logical path (not canonicalized), so here
    // stripping with the logical root is sufficient to align them.
    let relative_path = match rel_to_workdir_forward_slash(workdir, destination) {
        Ok(relative) => relative,
        Err(_) => {
            let base = upload_staging_base()?;
            let staged = destination.strip_prefix(&base).map_err(|_| {
                format!(
                    "Path is neither in the working directory nor in the upload staging area: {}",
                    destination.display()
                )
            })?;
            format!("uploads/{}", staged.to_string_lossy().replace('\\', "/"))
        }
    };
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&relative_path)
        .to_string();

    Ok(SystemReadableFileEntry {
        relative_path,
        absolute_path: destination.to_string_lossy().into_owned(),
        dedupe_key,
        file_name,
        kind: kind.to_string(),
        size_bytes,
    })
}

fn upload_sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn readable_path_dedupe_key(path: &Path) -> String {
    format!(
        "path:{}",
        upload_sha256_hex(path.to_string_lossy().as_bytes())
    )
}

fn uploaded_content_dedupe_key(file_name: &str, content: &[u8]) -> String {
    format!(
        "content:{}:{}",
        file_name.trim(),
        upload_sha256_hex(content)
    )
}

fn canonicalize_uploaded_file_path(absolute_path: &str) -> Result<PathBuf, String> {
    let raw = absolute_path.trim();
    if raw.is_empty() {
        return Err("Image path cannot be empty".to_string());
    }

    let path = expand_tilde_path(raw);
    if !path.is_absolute() {
        return Err(format!("Image path must be an absolute path: {absolute_path}"));
    }

    let metadata =
        fs::metadata(&path).map_err(|_| format!("Image file does not exist or is inaccessible: {absolute_path}"))?;
    if !metadata.is_file() {
        return Err(format!("Image path is not a regular file: {absolute_path}"));
    }

    fs::canonicalize(&path).map_err(|e| format!("Failed to resolve image path: {e}"))
}

/// Authorization scope for attachment reads: the current working directory, or the app upload staging area.
/// The caller guarantees that both `workdir` and `target` are canonicalized paths,
/// so the staging branch must compare against an equally canonicalized root.
fn is_allowed_attachment_target(workdir: &Path, target: &Path) -> bool {
    if target.starts_with(workdir) {
        return true;
    }
    canonical_upload_staging_base().is_some_and(|base| target.starts_with(base))
}

fn canonicalize_uploaded_attachment_path(
    workdir: &Path,
    absolute_path: Option<&str>,
) -> Result<PathBuf, String> {
    // Attachment reads only honor absolute_path: under the new scheme, workspace files are referenced in place and staging-area
    // files land in ~/.liveagent/uploads; the entry point for both is the absolute path returned at import time.
    // Attachments persisted by older versions with only a workdir-relative path are no longer compatible and must be re-uploaded.
    let raw_absolute_path = absolute_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Attachment is missing an absolute path (re-upload attachments imported by older versions)".to_string())?;
    let target = canonicalize_uploaded_file_path(raw_absolute_path)?;

    if !is_allowed_attachment_target(workdir, &target) {
        return Err(format!(
            "Attachment path escapes the current working directory and upload staging area: {}",
            target.display()
        ));
    }
    Ok(target)
}

fn resolve_uploaded_image_target(
    workdir: &str,
    absolute_path: &str,
) -> Result<(PathBuf, &'static str), String> {
    let workdir = canonicalize_upload_workdir(workdir)?;
    let target = canonicalize_uploaded_file_path(absolute_path)?;
    if !is_allowed_attachment_target(&workdir, &target) {
        return Err(format!(
            "Image path is outside the current workspace and upload staging area: {}",
            target.display()
        ));
    }
    let mime_type = infer_image_upload_mime(&target)
        .ok_or_else(|| format!("{} is not a supported image file", target.display()))?;
    Ok((target, mime_type))
}

fn decode_image_preview_base64(data_base64: &str) -> Result<Vec<u8>, String> {
    let encoded = data_base64.trim();
    if encoded.is_empty() {
        return Err("Image preview data is empty".to_string());
    }

    // Reject oversized input before decoding so a malformed request cannot
    // force a large allocation just to discover that it is not usable.
    if encoded.len() > IMAGE_PREVIEW_DATA_MAX_BYTES.saturating_mul(4) / 3 + 4 {
        return Err("Image preview data is too large".to_string());
    }

    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|error| format!("Invalid image preview data: {error}"))?;
    if bytes.len() > IMAGE_PREVIEW_DATA_MAX_BYTES {
        return Err("Image preview data is too large".to_string());
    }
    Ok(bytes)
}

fn decode_image_preview_rgba_bytes(bytes: Vec<u8>) -> Result<(usize, usize, Vec<u8>), String> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("Unable to identify image preview format: {error}"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(IMAGE_PREVIEW_MAX_DIMENSION);
    limits.max_image_height = Some(IMAGE_PREVIEW_MAX_DIMENSION);
    limits.max_alloc = Some(IMAGE_PREVIEW_MAX_ALLOC_BYTES);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|error| format!("Unable to decode image preview: {error}"))?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok((width as usize, height as usize, rgba.into_raw()))
}

fn decode_image_preview_rgba(data_base64: &str) -> Result<(usize, usize, Vec<u8>), String> {
    decode_image_preview_rgba_bytes(decode_image_preview_base64(data_base64)?)
}

fn write_image_to_clipboard_data(
    width: usize,
    height: usize,
    bytes: Cow<'_, [u8]>,
) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width,
            height,
            bytes,
        })
        .map_err(|error| format!("clipboard image write failed: {error}"))
}

fn write_image_to_clipboard(width: usize, height: usize, bytes: Vec<u8>) -> Result<(), String> {
    write_image_to_clipboard_data(width, height, Cow::Owned(bytes))
}

fn image_preview_file_signature(target: &Path) -> Result<ImagePreviewFileSignature, String> {
    let metadata = fs::metadata(target).map_err(|error| {
        format!(
            "Unable to inspect image attachment {}: {error}",
            target.display()
        )
    })?;
    if metadata.len() > IMAGE_PREVIEW_DATA_MAX_BYTES as u64 {
        return Err(format!(
            "Image attachment is too large for clipboard copying: {}",
            target.display()
        ));
    }
    Ok(ImagePreviewFileSignature {
        len: metadata.len(),
        modified_at: metadata.modified().ok(),
    })
}

fn prepared_image_preview_clipboard_matches(
    prepared: &PreparedImagePreviewClipboard,
    target: &Path,
    signature: &ImagePreviewFileSignature,
    now: SystemTime,
) -> bool {
    prepared.target == target
        && prepared.signature == *signature
        && now
            .duration_since(prepared.prepared_at)
            .map(|age| age <= IMAGE_PREVIEW_CLIPBOARD_CACHE_TTL)
            .unwrap_or(false)
}

fn prepare_uploaded_image_preview_clipboard_target(target: &Path) -> Result<(), String> {
    let signature = image_preview_file_signature(target)?;
    let now = SystemTime::now();
    {
        let cache = prepared_image_preview_clipboard()
            .lock()
            .map_err(|_| "Unable to lock prepared image clipboard data".to_string())?;
        if cache.as_ref().is_some_and(|prepared| {
            prepared_image_preview_clipboard_matches(prepared, target, &signature, now)
        }) {
            return Ok(());
        }
    }

    let bytes = fs::read(target).map_err(|error| {
        format!(
            "Unable to read image attachment {}: {error}",
            target.display()
        )
    })?;
    let (width, height, rgba) = decode_image_preview_rgba_bytes(bytes)?;
    let mut cache = prepared_image_preview_clipboard()
        .lock()
        .map_err(|_| "Unable to lock prepared image clipboard data".to_string())?;
    *cache = Some(PreparedImagePreviewClipboard {
        target: target.to_path_buf(),
        signature,
        prepared_at: now,
        width,
        height,
        rgba,
    });
    Ok(())
}

fn remember_image_preview_save_target(target: PathBuf) -> Result<String, String> {
    let save_token = Uuid::new_v4().to_string();
    let mut targets = pending_image_preview_save_targets()
        .lock()
        .map_err(|_| "Unable to lock image preview save targets".to_string())?;
    let now = SystemTime::now();
    targets.retain(|_, pending| {
        now.duration_since(pending.created_at)
            .map(|age| age <= IMAGE_PREVIEW_SAVE_TARGET_TTL)
            .unwrap_or(true)
    });
    targets.insert(
        save_token.clone(),
        PendingImagePreviewSaveTarget {
            target,
            created_at: now,
        },
    );
    Ok(save_token)
}

fn take_image_preview_save_target(save_token: &str) -> Result<PathBuf, String> {
    let mut targets = pending_image_preview_save_targets()
        .lock()
        .map_err(|_| "Unable to lock image preview save targets".to_string())?;
    let pending = targets
        .remove(save_token)
        .ok_or_else(|| "Image preview save target is unavailable or has expired".to_string())?;
    if pending
        .created_at
        .elapsed()
        .map(|age| age > IMAGE_PREVIEW_SAVE_TARGET_TTL)
        .unwrap_or(false)
    {
        return Err("Image preview save target has expired".to_string());
    }
    Ok(pending.target)
}

pub(crate) fn system_prepare_preview_file_save_sync(
    file_name: String,
) -> Result<Option<String>, String> {
    let safe_file_name = sanitize_uploaded_file_name(&file_name);
    let target = FileDialog::new().set_file_name(&safe_file_name).save_file();
    target.map(remember_image_preview_save_target).transpose()
}

pub(crate) fn system_write_preview_file_sync(
    save_token: String,
    data_base64: String,
    _mime_type: String,
) -> Result<(), String> {
    // Consume the user-selected target before decoding untrusted data so this
    // capability cannot be reused by a concurrent or later frontend request.
    let target = take_image_preview_save_target(&save_token)?;
    let bytes = decode_image_preview_base64(&data_base64)?;
    fs::write(&target, bytes)
        .map_err(|error| format!("Unable to save image preview {}: {error}", target.display()))
}

pub(crate) fn system_save_preview_file_sync(
    data_base64: String,
    file_name: String,
    mime_type: String,
) -> Result<bool, String> {
    let Some(save_token) = system_prepare_preview_file_save_sync(file_name)? else {
        return Ok(false);
    };
    system_write_preview_file_sync(save_token, data_base64, mime_type)?;
    Ok(true)
}

pub(crate) fn system_clipboard_write_image_sync(
    data_base64: String,
    _mime_type: String,
) -> Result<(), String> {
    let (width, height, bytes) = decode_image_preview_rgba(&data_base64)?;
    write_image_to_clipboard(width, height, bytes)
}

fn infer_native_attachment_mime(path: &Path, kind: Option<&str>) -> String {
    if let Some(mime_type) = infer_image_upload_mime(path) {
        return mime_type.to_string();
    }

    if is_pdf_upload(path) {
        return "application/pdf".to_string();
    }
    if is_notebook_upload(path) {
        return "application/json".to_string();
    }
    if is_word_upload(path) {
        return match upload_extension_lower(path).as_deref() {
            Some("doc") => "application/msword",
            _ => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }
        .to_string();
    }
    if is_spreadsheet_upload(path) {
        return match upload_extension_lower(path).as_deref() {
            Some("xls") => "application/vnd.ms-excel",
            Some("xlsm") => "application/vnd.ms-excel.sheet.macroenabled.12",
            Some("xltx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
            Some("xltm") => "application/vnd.ms-excel.template.macroenabled.12",
            _ => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }
        .to_string();
    }
    if is_archive_upload(path) {
        return match upload_extension_lower(path).as_deref() {
            Some("zip") => "application/zip",
            Some("7z") => "application/x-7z-compressed",
            Some("rar") => "application/vnd.rar",
            Some("tar") => "application/x-tar",
            Some("gz") | Some("tgz") => "application/gzip",
            Some("bz2") | Some("tbz") | Some("tbz2") => "application/x-bzip2",
            Some("xz") | Some("txz") => "application/x-xz",
            _ => "application/octet-stream",
        }
        .to_string();
    }

    match kind.map(str::trim).filter(|value| !value.is_empty()) {
        Some("text") => "text/plain".to_string(),
        Some("pdf") => "application/pdf".to_string(),
        Some("notebook") => "application/json".to_string(),
        Some("word") => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string()
        }
        Some("spreadsheet") => {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()
        }
        Some("archive") => "application/octet-stream".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn system_pick_readable_files_sync(
    workdir: String,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    let workdir = canonicalize_upload_workdir(&workdir)?;
    let selected = FileDialog::new().set_directory(&workdir).pick_files();

    let Some(selected_paths) = selected else {
        return Ok(SystemPickReadableFilesResponse {
            files: Vec::new(),
            skipped: Vec::new(),
        });
    };

    import_readable_file_paths_into_workdir(
        &workdir,
        selected_paths,
        max_files.unwrap_or(usize::MAX),
        Vec::new(),
    )
}

fn system_import_readable_file_paths_sync(
    workdir: String,
    paths: Vec<String>,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    let workdir = canonicalize_upload_workdir(&workdir)?;
    let mut selected_paths = Vec::with_capacity(paths.len());
    let mut skipped = Vec::new();

    for path in paths {
        let raw = path.trim();
        if raw.is_empty() {
            skipped.push("An empty dropped file path is present".to_string());
            continue;
        }
        let path = expand_tilde_path(raw);
        if !path.is_absolute() {
            skipped.push(format!("Dropped file path must be an absolute path: {raw}"));
            continue;
        }
        selected_paths.push(path);
    }

    import_readable_file_paths_into_workdir(
        &workdir,
        selected_paths,
        max_files.unwrap_or(usize::MAX),
        skipped,
    )
}

fn import_readable_file_paths_into_workdir(
    workdir: &Path,
    selected_paths: Vec<PathBuf>,
    max_files: usize,
    mut skipped: Vec<String>,
) -> Result<SystemPickReadableFilesResponse, String> {
    let mut import_root: Option<PathBuf> = None;
    let mut files = Vec::new();
    let mut skipped_for_limit = 0usize;

    for source in selected_paths {
        if files.len() >= max_files {
            skipped_for_limit += 1;
            continue;
        }

        let metadata = match fs::metadata(&source) {
            Ok(value) => value,
            Err(err) => {
                skipped.push(format!("{}: {err}", source.display()));
                continue;
            }
        };
        if !metadata.is_file() {
            skipped.push(format!("{}: only regular files can be selected", source.display()));
            continue;
        }

        let detected = match detect_upload_file_kind(&source) {
            Ok(detected) => detected,
            Err(message) => {
                skipped.push(message);
                continue;
            }
        };

        let canonical_source = fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
        let dedupe_key = readable_path_dedupe_key(&canonical_source);
        let mut entry_size = metadata.len();
        let destination = if canonical_source.starts_with(workdir) {
            // Files inside the workspace keep their in-place reference (including non-UTF-8 text; user files are not rewritten);
            // native attachment inlining transcodes on the read side, see system_read_uploaded_native_attachment_sync.
            canonical_source
        } else {
            let import_root = match import_root.as_ref() {
                Some(root) => root.clone(),
                None => {
                    let root = upload_import_root()?;
                    import_root = Some(root.clone());
                    root
                }
            };
            let source_name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("file");
            let sanitized_name = sanitize_uploaded_file_name(source_name);
            let target = unique_path_for_copy(import_root.join(sanitized_name));
            if detected.needs_utf8_transcode && metadata.len() <= UPLOADED_TEXT_TRANSCODE_MAX_BYTES
            {
                let bytes = fs::read(&source)
                    .map_err(|e| format!("Failed to read file {}: {e}", source.display()))?;
                let utf8 = transcode_upload_text_to_utf8(&bytes);
                entry_size = utf8.len() as u64;
                fs::write(&target, &utf8).map_err(|e| {
                    format!(
                        "Failed to write upload staging file {} -> {}: {e}",
                        source.display(),
                        target.display()
                    )
                })?;
            } else {
                fs::copy(&source, &target).map_err(|e| {
                    format!(
                        "Failed to copy file into the upload staging area {} -> {}: {e}",
                        source.display(),
                        target.display()
                    )
                })?;
            }
            target
        };

        files.push(build_readable_file_entry(
            workdir,
            &destination,
            detected.kind,
            entry_size,
            Some(dedupe_key),
        )?);
    }

    if skipped_for_limit > 0 {
        skipped.push(format!(
            "Upload count limit reached; ignored {skipped_for_limit} extra file(s)"
        ));
    }

    Ok(SystemPickReadableFilesResponse { files, skipped })
}

pub(crate) fn system_import_uploaded_readable_files_sync(
    workdir: String,
    uploads: Vec<SystemReadableFileUploadInput>,
) -> Result<SystemPickReadableFilesResponse, String> {
    let workdir = canonicalize_upload_workdir(&workdir)?;

    if uploads.is_empty() {
        return Ok(SystemPickReadableFilesResponse {
            files: Vec::new(),
            skipped: Vec::new(),
        });
    }

    let mut import_root: Option<PathBuf> = None;
    let mut files = Vec::new();
    let mut skipped = Vec::new();

    for upload in uploads {
        let source_name = upload.file_name.trim();
        if source_name.is_empty() {
            skipped.push("An uploaded file is missing its file name".to_string());
            continue;
        }

        let detected = match detect_uploaded_bytes_kind(
            source_name,
            upload.mime_type.as_deref(),
            &upload.content,
        ) {
            Ok(detected) => detected,
            Err(message) => {
                skipped.push(message);
                continue;
            }
        };
        let dedupe_key = uploaded_content_dedupe_key(source_name, &upload.content);

        let import_root = match import_root.as_ref() {
            Some(root) => root.clone(),
            None => {
                let root = upload_import_root()?;
                import_root = Some(root.clone());
                root
            }
        };

        let content = if detected.needs_utf8_transcode
            && upload.content.len() as u64 <= UPLOADED_TEXT_TRANSCODE_MAX_BYTES
        {
            transcode_upload_text_to_utf8(&upload.content)
        } else {
            upload.content
        };

        let sanitized_name = sanitize_uploaded_file_name(source_name);
        let target = unique_path_for_copy(import_root.join(sanitized_name));
        fs::write(&target, &content)
            .map_err(|e| format!("Failed to write uploaded file {}: {e}", target.display()))?;

        files.push(build_readable_file_entry(
            &workdir,
            &target,
            detected.kind,
            content.len() as u64,
            Some(dedupe_key),
        )?);
    }

    Ok(SystemPickReadableFilesResponse { files, skipped })
}

fn system_import_uploaded_readable_files_from_base64_sync(
    workdir: String,
    files: Vec<SystemUploadedReadableFileInput>,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    let max_files = max_files.unwrap_or(usize::MAX);
    let mut skipped_for_limit = 0usize;
    let mut uploads = Vec::new();

    for file in files {
        if uploads.len() >= max_files {
            skipped_for_limit += 1;
            continue;
        }
        let source_name = file.file_name.trim().to_string();
        let content_base64 = file.content_base64.trim();
        let content = BASE64_STANDARD.decode(content_base64).map_err(|err| {
            if source_name.is_empty() {
                format!("Failed to decode clipboard upload file: {err}")
            } else {
                format!("Failed to decode clipboard upload file {source_name}: {err}")
            }
        })?;
        uploads.push(SystemReadableFileUploadInput {
            file_name: source_name,
            mime_type: file
                .mime_type
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            content,
        });
    }

    let mut response = system_import_uploaded_readable_files_sync(workdir, uploads)?;
    if skipped_for_limit > 0 {
        response.skipped.push(format!(
            "Upload count limit reached; ignored {skipped_for_limit} extra file(s)"
        ));
    }
    Ok(response)
}

pub(crate) fn system_read_uploaded_image_preview_sync(
    workdir: String,
    absolute_path: String,
) -> Result<SystemUploadedImagePreviewResponse, String> {
    let (target, mime_type) = resolve_uploaded_image_target(&workdir, &absolute_path)?;
    let bytes = fs::read(&target).map_err(|e| format!("Failed to read image {}: {e}", target.display()))?;
    if bytes.len() > UPLOADED_IMAGE_PREVIEW_MAX_BYTES {
        return Err(format!(
            "Image is too large to use for chat attachment preview ({})",
            target.display()
        ));
    }

    Ok(SystemUploadedImagePreviewResponse {
        mime_type: mime_type.to_string(),
        data: BASE64_STANDARD.encode(bytes),
    })
}

pub(crate) fn system_open_uploaded_image_sync(
    workdir: String,
    absolute_path: String,
) -> Result<(), String> {
    let (target, _) = resolve_uploaded_image_target(&workdir, &absolute_path)?;
    crate::commands::fs::spawn_workspace_open_command(&target, "open")
}

pub(crate) fn system_prepare_uploaded_image_clipboard_sync(
    workdir: String,
    absolute_path: String,
) -> Result<(), String> {
    let (target, _) = resolve_uploaded_image_target(&workdir, &absolute_path)?;
    prepare_uploaded_image_preview_clipboard_target(&target)
}

pub(crate) fn system_clipboard_write_uploaded_image_sync(
    workdir: String,
    absolute_path: String,
) -> Result<(), String> {
    let (target, _) = resolve_uploaded_image_target(&workdir, &absolute_path)?;
    prepare_uploaded_image_preview_clipboard_target(&target)?;
    let signature = image_preview_file_signature(&target)?;
    let cache = prepared_image_preview_clipboard()
        .lock()
        .map_err(|_| "Unable to lock prepared image clipboard data".to_string())?;
    let prepared = cache
        .as_ref()
        .filter(|prepared| {
            prepared_image_preview_clipboard_matches(
                prepared,
                &target,
                &signature,
                SystemTime::now(),
            )
        })
        .ok_or_else(|| "Prepared image clipboard data is unavailable".to_string())?;
    write_image_to_clipboard_data(
        prepared.width,
        prepared.height,
        Cow::Borrowed(prepared.rgba.as_slice()),
    )
}

pub(crate) fn system_read_uploaded_native_attachment_sync(
    workdir: String,
    absolute_path: Option<String>,
    kind: Option<String>,
) -> Result<SystemUploadedNativeAttachmentResponse, String> {
    let workdir = canonicalize_upload_workdir(&workdir)?;
    let target = canonicalize_uploaded_attachment_path(&workdir, absolute_path.as_deref())?;
    let metadata = fs::metadata(&target)
        .map_err(|e| format!("Failed to read attachment metadata {}: {e}", target.display()))?;
    if metadata.len() > UPLOADED_NATIVE_ATTACHMENT_MAX_BYTES {
        return Err(format!(
            "Attachment is too large to inline as a native Responses attachment ({}, limit {} MiB)",
            target.display(),
            UPLOADED_NATIVE_ATTACHMENT_MAX_BYTES / 1024 / 1024
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("Failed to read attachment {}: {e}", target.display()))?;
    // Text attachments must be inlined as UTF-8: files referenced in place inside the workspace may use GBK/UTF-16
    // and other encodings (user files are not rewritten on import), while the JS-side decodeBase64Utf8 and the various APIs interpret
    // text/plain as UTF-8, so transcoding happens on the read side.
    let bytes = if kind.as_deref() == Some("text") {
        transcode_upload_text_to_utf8(&bytes)
    } else {
        bytes
    };
    let size_bytes = bytes.len() as u64;

    Ok(SystemUploadedNativeAttachmentResponse {
        mime_type: infer_native_attachment_mime(&target, kind.as_deref()),
        data: BASE64_STANDARD.encode(bytes),
        size_bytes,
    })
}

pub(crate) fn system_list_skill_files_sync() -> Result<SystemListSkillFilesResponse, String> {
    crate::services::skills::system_list_skill_files_sync()
}

pub(crate) fn system_read_skill_metadata_sync(
    path: String,
) -> Result<SystemReadSkillMetadataResponse, String> {
    crate::services::skills::system_read_skill_metadata_sync(path)
}

pub(crate) fn system_read_skill_text_sync(
    path: String,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<SystemReadSkillTextResponse, String> {
    crate::services::skills::system_read_skill_text_sync(path, offset, length)
}

fn system_append_debug_jsonl_sync(conversation_id: String, entry: Value) -> Result<(), String> {
    let file_stem = sanitize_debug_file_stem(&conversation_id)?;
    let debug_path = debug_root_dir()?.join(format!("{file_stem}.jsonl"));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&debug_path)
        .map_err(|e| format!("Failed to open debug log file: {e}"))?;
    serde_json::to_writer(&mut file, &entry).map_err(|e| format!("Failed to serialize debug log: {e}"))?;
    file.write_all(b"\n")
        .map_err(|e| format!("Failed to write debug log newline: {e}"))?;
    file.flush().map_err(|e| format!("Failed to flush debug log: {e}"))?;
    Ok(())
}

fn resolve_pick_folder_initial_dir(initial_workdir: Option<String>) -> Option<PathBuf> {
    let raw = initial_workdir?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let path = expand_tilde_path(trimmed);
    if path.is_dir() {
        return Some(path);
    }

    path.parent()
        .filter(|parent| parent.is_dir())
        .map(Path::to_path_buf)
}

fn is_windows_reserved_project_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem[3..]
                .parse::<u8>()
                .is_ok_and(|value| (1..=9).contains(&value)))
}

pub(crate) fn validate_project_folder_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Project name cannot be . or ..".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains(':') {
        return Err("Project name cannot contain path separators".to_string());
    }
    if trimmed
        .chars()
        .any(|ch| ch == '\0' || ch.is_ascii_control())
    {
        return Err("Project name contains illegal characters".to_string());
    }
    if Path::new(trimmed).components().count() != 1 {
        return Err("Project name cannot contain path segments".to_string());
    }
    if is_windows_reserved_project_name(trimmed) {
        return Err("Project name cannot use a system-reserved name".to_string());
    }
    Ok(trimmed)
}

/// Mirror of the fs command layer's `display_path`: strip the Windows `\\?\`
/// verbatim prefix and use forward slashes so the returned path matches the
/// shape `fs_roots`/`fs_list_dirs` hand to the WebUI picker (a mismatched
/// shape shows up as a duplicate tree node after the parent refresh).
fn project_folder_display_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    if let Some(rest) = normalized.strip_prefix("//?/") {
        return rest.to_string();
    }
    normalized
}

fn canonicalize_project_folder(path: &Path) -> String {
    project_folder_display_path(&fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))
}

/// Classification result for content dropped onto the upload area: files go through the attachment import pipeline, directories are mounted as attached directories.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemClassifiedDroppedPaths {
    pub files: Vec<String>,
    pub dirs: Vec<String>,
}

/// Unlike the workspace area's atomic rejection: the upload area allows files and directories to be dropped together, routing each separately,
/// so this only validates existence and classifies, without failing everything because directories were mixed in.
fn system_classify_dropped_paths_sync(
    paths: Vec<String>,
) -> Result<SystemClassifiedDroppedPaths, String> {
    if paths.is_empty() {
        return Err("No dropped content detected".to_string());
    }

    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    for raw_path in paths {
        let raw_path = raw_path.trim();
        if raw_path.is_empty() {
            return Err("Dropped path cannot be empty".to_string());
        }

        let path = expand_tilde_path(raw_path);
        if !path.is_absolute() {
            return Err(format!("Dropped path must be an absolute path: {raw_path}"));
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Dropped path does not exist or is inaccessible ({raw_path}): {error}"))?;

        if metadata.is_dir() {
            let canonical = fs::canonicalize(&path)
                .map_err(|error| format!("Failed to resolve dropped directory ({raw_path}): {error}"))?;
            let display_path = project_folder_display_path(&canonical);
            if seen.insert(display_path.clone()) {
                dirs.push(display_path);
            }
        } else if seen.insert(raw_path.to_string()) {
            // Files keep their original path and are handed to the attachment import pipeline, which does readability validation and staging.
            files.push(raw_path.to_string());
        }
    }

    Ok(SystemClassifiedDroppedPaths { files, dirs })
}

fn system_resolve_dropped_workspace_folders_sync(
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("No dropped folder detected".to_string());
    }

    let mut resolved = Vec::with_capacity(paths.len());
    let mut seen = HashSet::new();
    for raw_path in paths {
        let raw_path = raw_path.trim();
        if raw_path.is_empty() {
            return Err("Dropped path cannot be empty".to_string());
        }

        let path = expand_tilde_path(raw_path);
        if !path.is_absolute() {
            return Err(format!("Dropped workspace path must be an absolute path: {raw_path}"));
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Dropped path does not exist or is inaccessible ({raw_path}): {error}"))?;
        if !metadata.is_dir() {
            return Err(format!("The workspace area only supports dropping folders: {raw_path}"));
        }

        let canonical = fs::canonicalize(&path)
            .map_err(|error| format!("Failed to resolve dropped workspace directory ({raw_path}): {error}"))?;
        let display_path = project_folder_display_path(&canonical);
        if seen.insert(display_path.clone()) {
            resolved.push(display_path);
        }
    }

    Ok(resolved)
}

/// Input/output shape of a directory dropped from the web side after being forwarded through the gateway and written to disk locally.
pub(crate) struct SystemImportDirectoryInputFile {
    pub relative_path: String,
    pub content: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct SystemImportDirectoryOutcome {
    pub root_path: String,
    pub file_count: u32,
    pub skipped: Vec<String>,
    pub received_bytes: u64,
}

const DIRECTORY_IMPORT_MAX_FILES: usize = 2000;
const DIRECTORY_IMPORT_MAX_BYTES: u64 = 200 * 1024 * 1024;
pub(crate) const DIRECTORY_IMPORT_CHUNK_BYTES: usize = 1024 * 1024;

struct DirectoryImportFileState {
    destination: Option<PathBuf>,
    next_offset: u64,
    complete: bool,
}

struct DirectoryImportTransferState {
    base: PathBuf,
    folder_name: String,
    staging_root: PathBuf,
    expected_files: usize,
    expected_bytes: u64,
    received_bytes: u64,
    files: HashMap<String, DirectoryImportFileState>,
    skipped: Vec<String>,
    last_activity: Instant,
}

static DIRECTORY_IMPORT_TRANSFERS: OnceLock<Mutex<HashMap<String, DirectoryImportTransferState>>> =
    OnceLock::new();

fn directory_import_transfers() -> &'static Mutex<HashMap<String, DirectoryImportTransferState>> {
    DIRECTORY_IMPORT_TRANSFERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// After a gateway disconnect/restart, ABORT may never arrive; any transfer idle longer than this duration is treated as
/// dead (the gateway-side single round-trip timeout defaults to 2 minutes, and normal transfers idle for far less than that).
const DIRECTORY_IMPORT_IDLE_TTL: Duration = Duration::from_secs(15 * 60);

/// The proactive cleanup interval must be significantly shorter than the idle TTL so reclamation does not depend on the next directory import.
const DIRECTORY_IMPORT_SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// The activity marker sits next to the staging directory rather than inside it, avoiding name collisions with user-uploaded files
/// or getting mixed into the final import directory after COMMIT. Cross-process GC uses it to identify transfers still in progress.
const DIRECTORY_IMPORT_ACTIVITY_SUFFIX: &str = ".activity";

fn directory_import_activity_path(staging_root: &Path) -> PathBuf {
    let transfer_id = staging_root
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    staging_root.with_file_name(format!("{transfer_id}{DIRECTORY_IMPORT_ACTIVITY_SUFFIX}"))
}

fn write_directory_import_activity(staging_root: &Path) -> Result<(), String> {
    let activity_path = directory_import_activity_path(staging_root);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    fs::write(&activity_path, timestamp).map_err(|error| {
        format!(
            "Failed to update directory import activity marker ({}): {error}",
            activity_path.display()
        )
    })
}

fn remove_directory_import_staging_root(staging_root: &Path) -> Result<(), String> {
    let activity_path = directory_import_activity_path(staging_root);
    let mut errors = Vec::new();
    if let Err(error) = fs::remove_dir_all(staging_root) {
        if error.kind() != std::io::ErrorKind::NotFound {
            errors.push(format!("{}: {error}", staging_root.display()));
        }
    }
    if let Err(error) = fs::remove_file(&activity_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            errors.push(format!("{}: {error}", activity_path.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("Failed to clean up directory import staging data: {}", errors.join("; ")))
    }
}

/// Removes idle-timed-out transfers from the in-memory table and returns their staging paths. The caller must already hold the lock; on-disk
/// deletion must happen after releasing the lock, to avoid a slow filesystem blocking other transfers still progressing normally.
fn take_stale_directory_transfers(
    transfers: &mut HashMap<String, DirectoryImportTransferState>,
    idle_ttl: Duration,
) -> Vec<PathBuf> {
    let stale: Vec<String> = transfers
        .iter()
        .filter(|(_, transfer)| transfer.last_activity.elapsed() > idle_ttl)
        .map(|(id, _)| id.clone())
        .collect();
    stale
        .into_iter()
        .filter_map(|transfer_id| {
            transfers
                .remove(&transfer_id)
                .map(|transfer| transfer.staging_root)
        })
        .collect()
}

/// Clean stale directories under `<base>/.staging` that are not in the current process's active table. Prefer the cross-
/// process activity marker, falling back to directory mtime for leftovers from older versions (the directory name is the transfer id).
fn gc_directory_import_staging_in(
    staging_base: &Path,
    active: &HashSet<String>,
    now: SystemTime,
    retention: Duration,
) -> usize {
    let entries = match fs::read_dir(staging_base) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return 0,
        Err(error) => {
            eprintln!(
                "failed to read directory import staging base {}: {error}",
                staging_base.display()
            );
            return 0;
        }
    };
    let mut removed = 0usize;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!(
                    "failed to read an entry under directory import staging base {}: {error}",
                    staging_base.display()
                );
                continue;
            }
        };
        let path = entry.path();
        if !path.is_dir() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(transfer_id) = name.strip_suffix(DIRECTORY_IMPORT_ACTIVITY_SUFFIX) {
                let staging_root = staging_base.join(transfer_id);
                let expired = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|age| age > retention);
                if !staging_root.exists() && expired {
                    match fs::remove_file(&path) {
                        Ok(()) => removed += 1,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => eprintln!(
                            "failed to remove orphaned directory import activity marker {}: {error}",
                            path.display()
                        ),
                    }
                }
            }
            continue;
        }
        let transfer_id = entry.file_name().to_string_lossy().into_owned();
        if active.contains(&transfer_id) {
            continue;
        }
        // Cross-process active transfers are not in this process's in-memory table; prefer reading the marker that every chunk
        // refreshes, and fall back to directory mtime when an old-version leftover has no marker.
        let activity_path = directory_import_activity_path(&path);
        let modified = fs::metadata(&activity_path)
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    entry.metadata()
                } else {
                    Err(error)
                }
            })
            .and_then(|metadata| metadata.modified())
            .map_err(|error| {
                eprintln!(
                    "failed to read directory import activity time for {}: {error}",
                    path.display()
                );
                error
            })
            .ok();
        let expired = modified
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > retention);
        if expired {
            match remove_directory_import_staging_root(&path) {
                Ok(()) => removed += 1,
                Err(error) => eprintln!("{error}"),
            }
        }
    }
    removed
}

fn directory_import_staging_bases() -> Vec<PathBuf> {
    ["workspace", "project-root"]
        .into_iter()
        .filter_map(|target| match directory_import_base(target) {
            Ok(base) => Some(base.join(".staging")),
            Err(error) => {
                eprintln!("failed to resolve directory import staging base: {error}");
                None
            }
        })
        .collect()
}

fn sweep_directory_import_staging_in(
    transfers: &Mutex<HashMap<String, DirectoryImportTransferState>>,
    staging_bases: &[PathBuf],
    now: SystemTime,
    idle_ttl: Duration,
) {
    let (stale_roots, active) = {
        let mut transfers = match transfers.lock() {
            Ok(transfers) => transfers,
            Err(_) => {
                eprintln!("failed to lock directory import transfer state during staging sweep");
                return;
            }
        };
        let stale_roots = take_stale_directory_transfers(&mut transfers, idle_ttl);
        let active = transfers.keys().cloned().collect::<HashSet<_>>();
        (stale_roots, active)
    };

    for staging_root in stale_roots {
        if let Err(error) = remove_directory_import_staging_root(&staging_root) {
            eprintln!("{error}");
        }
    }
    for staging_base in staging_bases {
        gc_directory_import_staging_in(staging_base, &active, now, idle_ttl);
    }
}

fn sweep_directory_import_staging_once() {
    let staging_bases = directory_import_staging_bases();
    sweep_directory_import_staging_in(
        directory_import_transfers(),
        &staging_bases,
        SystemTime::now(),
        DIRECTORY_IMPORT_IDLE_TTL,
    );
}

async fn run_periodic_directory_import_gc<F, Fut>(period: Duration, mut sweep: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()>,
{
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The interval's first tick is immediately ready; startup cleanup already ran separately, so consume it before entering the periodic loop.
    interval.tick().await;
    loop {
        interval.tick().await;
        sweep().await;
    }
}

async fn run_directory_import_staging_sweep() {
    if let Err(error) =
        tauri::async_runtime::spawn_blocking(sweep_directory_import_staging_once).await
    {
        eprintln!("directory import staging sweep task failed: {error}");
    }
}

/// Clean up once immediately at startup, and periodically reclaim idle transfers and stale
/// `.staging` for the lifetime of the process. Cleanup failures are only logged; the next round retries without blocking app startup.
pub fn start_directory_import_staging_gc() {
    tauri::async_runtime::spawn(async {
        run_directory_import_staging_sweep().await;
        run_periodic_directory_import_gc(DIRECTORY_IMPORT_SWEEP_INTERVAL, || {
            run_directory_import_staging_sweep()
        })
        .await;
    });
}

/// Directory imports land under `~/.liveagent/imports/` rather than the uploads staging area: an import result becomes
/// the root path authorized as a workspace or attached directory, so it must avoid the staging area's 30-day GC.
fn directory_import_base(target: &str) -> Result<PathBuf, String> {
    let subdir = match target {
        "workspace" => "workspaces",
        "project-root" => "mounts",
        _ => return Err(format!("Unknown directory import target: {target}")),
    };
    Ok(app_storage_dir()?.join("imports").join(subdir))
}

fn create_unique_import_root(base: &Path, name: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(base)
        .map_err(|error| format!("Failed to create directory import base directory ({}): {error}", base.display()))?;
    let mut suffix = 1usize;
    loop {
        let candidate = if suffix == 1 {
            base.join(name)
        } else {
            base.join(format!("{name}-{suffix}"))
        };
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                suffix += 1;
                if suffix > 1000 {
                    return Err(format!("Too many directory name collisions; cannot create import directory: {name}"));
                }
            }
            Err(error) => {
                return Err(format!(
                    "Failed to create import directory ({}): {error}",
                    candidate.display()
                ))
            }
        }
    }
}

/// Relative paths must be sanitized segment by segment: reject `.`/`..` to prevent traversal, while preserving legitimate leading dots such as `.env`,
/// `.gitignore`, and `.github`.
fn sanitized_relative_components(relative_path: &str) -> Option<Vec<String>> {
    let normalized = relative_path.replace('\\', "/");
    let mut components = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() {
            continue;
        }
        if part == "." || part == ".." {
            return None;
        }
        components.push(sanitize_import_path_component(part)?);
    }
    if components.is_empty() {
        None
    } else {
        Some(components)
    }
}

pub(crate) fn system_import_directory_sync(
    name: String,
    target: String,
    files: Vec<SystemImportDirectoryInputFile>,
) -> Result<SystemImportDirectoryOutcome, String> {
    if files.is_empty() {
        return Err("No uploaded directory content detected".to_string());
    }
    if files.len() > DIRECTORY_IMPORT_MAX_FILES {
        return Err(format!(
            "Too many files in the directory (more than {DIRECTORY_IMPORT_MAX_FILES}); please reduce and retry"
        ));
    }
    let total_bytes = files.iter().try_fold(0u64, |total, file| {
        total.checked_add(u64::try_from(file.content.len()).unwrap_or(u64::MAX))
    });
    let total_bytes = total_bytes.ok_or_else(|| "Directory content byte count overflowed".to_string())?;
    if total_bytes > DIRECTORY_IMPORT_MAX_BYTES {
        return Err(format!(
            "Directory content exceeds the {} MiB limit",
            DIRECTORY_IMPORT_MAX_BYTES / 1024 / 1024
        ));
    }
    let folder_name =
        sanitize_import_path_component(name.trim()).ok_or_else(|| "Invalid directory name".to_string())?;
    let base = directory_import_base(target.trim())?;
    let root = create_unique_import_root(&base, &folder_name)?;

    let mut skipped = Vec::new();
    let mut file_count = 0u32;
    for file in files {
        let Some(components) = sanitized_relative_components(&file.relative_path) else {
            skipped.push(file.relative_path);
            continue;
        };
        let mut destination = root.clone();
        for component in &components {
            destination.push(component);
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create import subdirectory ({}): {error}", parent.display()))?;
        }
        // A sanitized component may collide with other files in the same directory (e.g. illegal characters all normalize to `_`).
        let destination = unique_path_for_copy(destination);
        fs::write(&destination, &file.content)
            .map_err(|error| format!("Failed to write import file ({}): {error}", destination.display()))?;
        file_count += 1;
    }

    if file_count == 0 {
        let _ = fs::remove_dir_all(&root);
        return Err("None of the uploaded directory content could be imported".to_string());
    }

    Ok(SystemImportDirectoryOutcome {
        root_path: project_folder_display_path(&root),
        file_count,
        skipped,
        received_bytes: total_bytes,
    })
}

fn validate_directory_transfer_id(transfer_id: &str) -> Result<&str, String> {
    let transfer_id = transfer_id.trim();
    if transfer_id.is_empty()
        || transfer_id.len() > 128
        || !transfer_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid directory import transfer id".to_string());
    }
    Ok(transfer_id)
}

pub(crate) fn system_import_directory_start_sync(
    transfer_id: String,
    name: String,
    target: String,
    total_files: u32,
    total_bytes: u64,
) -> Result<SystemImportDirectoryOutcome, String> {
    let transfer_id = validate_directory_transfer_id(&transfer_id)?.to_string();
    let expected_files = usize::try_from(total_files).unwrap_or(usize::MAX);
    if expected_files == 0 || expected_files > DIRECTORY_IMPORT_MAX_FILES {
        return Err(format!(
            "The number of files in the directory must be between 1 and {DIRECTORY_IMPORT_MAX_FILES}"
        ));
    }
    if total_bytes > DIRECTORY_IMPORT_MAX_BYTES {
        return Err(format!(
            "Directory content exceeds the {} MiB limit",
            DIRECTORY_IMPORT_MAX_BYTES / 1024 / 1024
        ));
    }

    let folder_name =
        sanitize_import_path_component(name.trim()).ok_or_else(|| "Invalid directory name".to_string())?;
    let base = directory_import_base(target.trim())?;
    let staging_base = base.join(".staging");
    fs::create_dir_all(&staging_base).map_err(|error| {
        format!(
            "Failed to create the directory import staging area ({}): {error}",
            staging_base.display()
        )
    })?;
    let staging_root = staging_base.join(&transfer_id);

    // START still performs one immediate reclamation; the periodic task handles proactive cleanup when there are no subsequent imports.
    sweep_directory_import_staging_in(
        directory_import_transfers(),
        std::slice::from_ref(&staging_base),
        SystemTime::now(),
        DIRECTORY_IMPORT_IDLE_TTL,
    );
    let mut transfers = directory_import_transfers()
        .lock()
        .map_err(|_| "Directory import state lock is poisoned".to_string())?;
    if transfers.contains_key(&transfer_id) || staging_root.exists() {
        return Err("Directory import transfer id already exists".to_string());
    }
    fs::create_dir(&staging_root).map_err(|error| {
        format!(
            "Failed to create the directory import staging directory ({}): {error}",
            staging_root.display()
        )
    })?;
    if let Err(error) = write_directory_import_activity(&staging_root) {
        let _ = remove_directory_import_staging_root(&staging_root);
        return Err(error);
    }
    transfers.insert(
        transfer_id,
        DirectoryImportTransferState {
            base,
            folder_name,
            staging_root,
            expected_files,
            expected_bytes: total_bytes,
            received_bytes: 0,
            files: HashMap::new(),
            skipped: Vec::new(),
            last_activity: Instant::now(),
        },
    );

    Ok(SystemImportDirectoryOutcome {
        root_path: String::new(),
        file_count: 0,
        skipped: Vec::new(),
        received_bytes: 0,
    })
}

pub(crate) fn system_import_directory_chunk_sync(
    transfer_id: String,
    relative_path: String,
    offset: u64,
    chunk: Vec<u8>,
    file_complete: bool,
) -> Result<SystemImportDirectoryOutcome, String> {
    let transfer_id = validate_directory_transfer_id(&transfer_id)?.to_string();
    if chunk.len() > DIRECTORY_IMPORT_CHUNK_BYTES {
        return Err(format!(
            "Directory import chunk exceeds the {} byte limit",
            DIRECTORY_IMPORT_CHUNK_BYTES
        ));
    }
    if chunk.is_empty() && !file_complete {
        return Err("Directory import chunk is empty while the file is not finished".to_string());
    }
    let normalized_path = relative_path.replace('\\', "/");
    if normalized_path.trim().is_empty() {
        return Err("Directory import relative path is empty".to_string());
    }

    let mut transfers = directory_import_transfers()
        .lock()
        .map_err(|_| "Directory import state lock is poisoned".to_string())?;
    let transfer = transfers
        .get_mut(&transfer_id)
        .ok_or_else(|| "Directory import transfer id does not exist".to_string())?;

    if !transfer.files.contains_key(&normalized_path) {
        if offset != 0 {
            return Err("The first chunk offset of a directory import file must be 0".to_string());
        }
        if transfer.files.len() >= transfer.expected_files {
            return Err("Directory import file count exceeds the declared value".to_string());
        }
        let destination = if let Some(components) = sanitized_relative_components(&normalized_path)
        {
            let mut destination = transfer.staging_root.clone();
            for component in components {
                destination.push(component);
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!("Failed to create import subdirectory ({}): {error}", parent.display())
                })?;
            }
            Some(unique_path_for_copy(destination))
        } else {
            transfer.skipped.push(normalized_path.clone());
            None
        };
        transfer.files.insert(
            normalized_path.clone(),
            DirectoryImportFileState {
                destination,
                next_offset: 0,
                complete: false,
            },
        );
    }

    let file = transfer
        .files
        .get_mut(&normalized_path)
        .expect("directory import file state inserted above");
    if file.complete {
        return Err("Directory import file is already complete".to_string());
    }
    if offset != file.next_offset {
        return Err(format!(
            "Directory import chunk offset is discontinuous: expected {}, received {offset}",
            file.next_offset
        ));
    }
    let chunk_bytes = u64::try_from(chunk.len()).unwrap_or(u64::MAX);
    let next_received = transfer
        .received_bytes
        .checked_add(chunk_bytes)
        .ok_or_else(|| "Directory import byte count overflowed".to_string())?;
    if next_received > transfer.expected_bytes || next_received > DIRECTORY_IMPORT_MAX_BYTES {
        return Err("Directory import content exceeds the declared total byte count".to_string());
    }

    if let Some(destination) = &file.destination {
        let mut output = if offset == 0 {
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(destination)
        } else {
            OpenOptions::new().append(true).open(destination)
        }
        .map_err(|error| format!("Failed to open import file ({}): {error}", destination.display()))?;
        output
            .write_all(&chunk)
            .map_err(|error| format!("Failed to write import file ({}): {error}", destination.display()))?;
    }
    file.next_offset = file
        .next_offset
        .checked_add(chunk_bytes)
        .ok_or_else(|| "Directory import file offset overflowed".to_string())?;
    file.complete = file_complete;
    transfer.received_bytes = next_received;
    transfer.last_activity = Instant::now();
    write_directory_import_activity(&transfer.staging_root)?;

    let file_count = transfer
        .files
        .values()
        .filter(|state| state.complete && state.destination.is_some())
        .count();
    Ok(SystemImportDirectoryOutcome {
        root_path: String::new(),
        file_count: u32::try_from(file_count).unwrap_or(u32::MAX),
        skipped: transfer.skipped.clone(),
        received_bytes: transfer.received_bytes,
    })
}

fn move_staging_to_unique_import_root(
    staging_root: &Path,
    base: &Path,
    name: &str,
) -> Result<PathBuf, String> {
    for suffix in 1usize..=1000 {
        let destination = if suffix == 1 {
            base.join(name)
        } else {
            base.join(format!("{name}-{suffix}"))
        };
        // On Unix, rename can replace an existing empty directory. Never let an
        // import commit overwrite a user-created directory, even when it is empty.
        if destination.exists() {
            continue;
        }
        match fs::rename(staging_root, &destination) {
            Ok(()) => return Ok(destination),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to commit directory import ({} -> {}): {error}",
                    staging_root.display(),
                    destination.display()
                ))
            }
        }
    }
    Err(format!("Too many directory name collisions; cannot commit import directory: {name}"))
}

pub(crate) fn system_import_directory_commit_sync(
    transfer_id: String,
) -> Result<SystemImportDirectoryOutcome, String> {
    let transfer_id = validate_directory_transfer_id(&transfer_id)?.to_string();
    let transfer = directory_import_transfers()
        .lock()
        .map_err(|_| "Directory import state lock is poisoned".to_string())?
        .remove(&transfer_id)
        .ok_or_else(|| "Directory import transfer id does not exist".to_string())?;

    let complete_files = transfer
        .files
        .values()
        .filter(|state| state.complete)
        .count();
    if complete_files != transfer.expected_files
        || transfer.files.len() != transfer.expected_files
        || transfer.received_bytes != transfer.expected_bytes
    {
        let _ = remove_directory_import_staging_root(&transfer.staging_root);
        return Err(format!(
            "Directory import incomplete: files {complete_files}/{}, bytes {}/{}",
            transfer.expected_files, transfer.received_bytes, transfer.expected_bytes
        ));
    }
    let written_files = transfer
        .files
        .values()
        .filter(|state| state.destination.is_some())
        .count();
    if written_files == 0 {
        let _ = remove_directory_import_staging_root(&transfer.staging_root);
        return Err("None of the uploaded directory content could be imported".to_string());
    }

    let activity_path = directory_import_activity_path(&transfer.staging_root);
    if let Err(error) = fs::remove_file(&activity_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "failed to remove committed directory import activity marker {}: {error}",
                activity_path.display()
            );
        }
    }

    let root = match move_staging_to_unique_import_root(
        &transfer.staging_root,
        &transfer.base,
        &transfer.folder_name,
    ) {
        Ok(root) => root,
        Err(error) => {
            let _ = remove_directory_import_staging_root(&transfer.staging_root);
            return Err(error);
        }
    };
    Ok(SystemImportDirectoryOutcome {
        root_path: project_folder_display_path(&root),
        file_count: u32::try_from(written_files).unwrap_or(u32::MAX),
        skipped: transfer.skipped,
        received_bytes: transfer.received_bytes,
    })
}

pub(crate) fn system_import_directory_abort_sync(transfer_id: String) -> Result<(), String> {
    let transfer_id = validate_directory_transfer_id(&transfer_id)?.to_string();
    let transfer = directory_import_transfers()
        .lock()
        .map_err(|_| "Directory import state lock is poisoned".to_string())?
        .remove(&transfer_id);
    if let Some(transfer) = transfer {
        remove_directory_import_staging_root(&transfer.staging_root)?;
    }
    Ok(())
}

pub(crate) fn system_create_project_folder_sync(
    parent: String,
    name: String,
) -> Result<SystemCreateProjectFolderResponse, String> {
    let parent_raw = parent.trim();
    if parent_raw.is_empty() {
        return Err("Parent directory cannot be empty".to_string());
    }
    let parent_path = expand_tilde_path(parent_raw);
    if !parent_path.is_absolute() {
        return Err(format!("Parent directory must be an absolute path: {parent_raw}"));
    }
    let parent_meta =
        fs::metadata(&parent_path).map_err(|_| format!("Parent directory does not exist or is inaccessible: {parent_raw}"))?;
    if !parent_meta.is_dir() {
        return Err(format!("Parent directory is not a folder: {parent_raw}"));
    }
    let parent_path = fs::canonicalize(&parent_path).map_err(|e| format!("Failed to resolve parent directory: {e}"))?;
    let folder_name = validate_project_folder_name(&name)?;
    let target = parent_path.join(folder_name);

    match fs::metadata(&target) {
        Ok(meta) if meta.is_dir() => {
            return Ok(SystemCreateProjectFolderResponse {
                path: canonicalize_project_folder(&target),
            });
        }
        Ok(_) => {
            return Err(format!("Target path already exists and is not a folder: {}", target.display()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("Failed to access target path: {error}"));
        }
    }

    match fs::create_dir(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && target.is_dir() => {}
        Err(error) => return Err(format!("Failed to create project directory: {error}")),
    }

    Ok(SystemCreateProjectFolderResponse {
        path: canonicalize_project_folder(&target),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn system_sandbox_capability() -> crate::runtime::sandbox::SandboxCapability {
    crate::runtime::sandbox::capability()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_pick_folder(initial_workdir: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = FileDialog::new();
        if let Some(initial_dir) = resolve_pick_folder_initial_dir(initial_workdir) {
            dialog = dialog.set_directory(initial_dir);
        }

        Ok(dialog
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("system_pick_folder join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_resolve_dropped_workspace_folders(
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_resolve_dropped_workspace_folders_sync(paths)
    })
    .await
    .map_err(|e| format!("system_resolve_dropped_workspace_folders join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_classify_dropped_paths(
    paths: Vec<String>,
) -> Result<SystemClassifiedDroppedPaths, String> {
    tauri::async_runtime::spawn_blocking(move || system_classify_dropped_paths_sync(paths))
        .await
    .map_err(|e| format!("system_classify_dropped_paths join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_pick_file(
    initial_workdir: Option<String>,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = FileDialog::new();
        if let Some(initial_dir) = resolve_pick_folder_initial_dir(initial_workdir) {
            dialog = dialog.set_directory(initial_dir);
        }
        if let Some(extensions) = extensions.filter(|list| !list.is_empty()) {
            let extension_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(filter_name.as_deref().unwrap_or("Files"), &extension_refs);
        }

        Ok(dialog
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("system_pick_file join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_save_preview_file(
    file_name: String,
    mime_type: Option<String>,
    data_base64: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_save_preview_file_sync(data_base64, file_name, mime_type.unwrap_or_default())
    })
    .await
    .map_err(|e| format!("system_save_preview_file join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_clipboard_write_image(
    mime_type: Option<String>,
    data_base64: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mime_type = mime_type.unwrap_or_default();
        if !mime_type.to_ascii_lowercase().starts_with("image/") {
            return Err("The selected workspace preview is not an image".to_string());
        }
        system_clipboard_write_image_sync(data_base64, mime_type)
    })
    .await
    .map_err(|e| format!("system_clipboard_write_image join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_create_project_folder(
    parent: String,
    name: String,
) -> Result<SystemCreateProjectFolderResponse, String> {
    tauri::async_runtime::spawn_blocking(move || system_create_project_folder_sync(parent, name))
        .await
        .map_err(|e| format!("system_create_project_folder join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_pick_readable_files(
    workdir: String,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_pick_readable_files_sync(workdir, max_files)
    })
    .await
    .map_err(|e| format!("system_pick_readable_files join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_import_readable_file_paths(
    workdir: String,
    paths: Vec<String>,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_import_readable_file_paths_sync(workdir, paths, max_files)
    })
    .await
    .map_err(|e| format!("system_import_readable_file_paths join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_import_uploaded_readable_files(
    workdir: String,
    files: Vec<SystemUploadedReadableFileInput>,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_import_uploaded_readable_files_from_base64_sync(workdir, files, max_files)
    })
    .await
    .map_err(|e| format!("system_import_uploaded_readable_files join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_import_pasted_texts(
    workdir: String,
    texts: Vec<SystemPastedTextInput>,
) -> Result<SystemPickReadableFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let uploads = texts
            .into_iter()
            .map(|text| SystemReadableFileUploadInput {
                file_name: text.file_name,
                mime_type: Some("text/plain".to_string()),
                content: text.content.into_bytes(),
            })
            .collect();
        system_import_uploaded_readable_files_sync(workdir, uploads)
    })
    .await
    .map_err(|e| format!("system_import_pasted_texts join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_read_uploaded_image_preview(
    workdir: String,
    absolute_path: String,
) -> Result<SystemUploadedImagePreviewResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_read_uploaded_image_preview_sync(workdir, absolute_path)
    })
    .await
    .map_err(|e| format!("system_read_uploaded_image_preview join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_open_uploaded_image(
    workdir: String,
    absolute_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_open_uploaded_image_sync(workdir, absolute_path)
    })
    .await
    .map_err(|e| format!("system_open_uploaded_image join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_prepare_preview_file_save(file_name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || system_prepare_preview_file_save_sync(file_name))
        .await
        .map_err(|e| format!("system_prepare_preview_file_save join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_write_preview_file(
    save_token: String,
    data_base64: String,
    mime_type: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_write_preview_file_sync(save_token, data_base64, mime_type)
    })
    .await
    .map_err(|e| format!("system_write_preview_file join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_prepare_uploaded_image_clipboard(
    workdir: String,
    absolute_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_prepare_uploaded_image_clipboard_sync(workdir, absolute_path)
    })
    .await
    .map_err(|e| format!("system_prepare_uploaded_image_clipboard join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_clipboard_write_uploaded_image(
    workdir: String,
    absolute_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_clipboard_write_uploaded_image_sync(workdir, absolute_path)
    })
    .await
    .map_err(|e| format!("system_clipboard_write_uploaded_image join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_read_uploaded_native_attachment(
    workdir: String,
    absolute_path: Option<String>,
    kind: Option<String>,
) -> Result<SystemUploadedNativeAttachmentResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_read_uploaded_native_attachment_sync(workdir, absolute_path, kind)
    })
    .await
    .map_err(|e| format!("system_read_uploaded_native_attachment join failed: {e}"))?
}

#[tauri::command]
pub async fn system_list_skill_files() -> Result<SystemListSkillFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(system_list_skill_files_sync)
        .await
        .map_err(|e| format!("system_list_skill_files join failed: {e}"))?
}

#[tauri::command]
pub async fn system_ensure_builtin_skills(
) -> Result<Vec<crate::services::skills::SystemBuiltinSkillSeedResponse>, String> {
    tauri::async_runtime::spawn_blocking(crate::services::skills::ensure_builtin_agent_skills_sync)
        .await
        .map_err(|e| format!("system_ensure_builtin_skills join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_manage_skill(payload: Value) -> Result<SystemManageSkillResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::skills::system_manage_skill_sync(payload)
    })
    .await
    .map_err(|e| format!("system_manage_skill join failed: {e}"))?
}

#[tauri::command]
pub async fn system_read_skill_text(
    path: String,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<SystemReadSkillTextResponse, String> {
    tauri::async_runtime::spawn_blocking(move || system_read_skill_text_sync(path, offset, length))
        .await
        .map_err(|e| format!("system_read_skill_text join failed: {e}"))?
}

#[tauri::command]
pub async fn system_read_skill_metadata(
    path: String,
) -> Result<SystemReadSkillMetadataResponse, String> {
    tauri::async_runtime::spawn_blocking(move || system_read_skill_metadata_sync(path))
        .await
        .map_err(|e| format!("system_read_skill_metadata join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_append_debug_jsonl(
    conversation_id: String,
    entry: Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_append_debug_jsonl_sync(conversation_id, entry)
    })
    .await
    .map_err(|e| format!("system_append_debug_jsonl join failed: {e}"))?
}

// The only channel for the desktop side to read the system clipboard: WKWebView's navigator.clipboard.readText()
// pops up a native "Paste" confirmation bubble for clipboard content from other apps (DOM paste access),
// so paste from a custom context menu must bypass the webview and read the native clipboard directly.
fn system_clipboard_read_text_sync() -> Result<String, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        // When the clipboard has no text content (empty/image/files), treat it as empty text; the frontend silently dismisses the menu accordingly.
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(format!("clipboard read failed: {e}")),
    }
}

#[tauri::command]
pub async fn system_clipboard_read_text() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(system_clipboard_read_text_sync)
        .await
        .map_err(|e| format!("system_clipboard_read_text join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub fn system_begin_power_activity(
    activity_id: String,
    reason: String,
    ttl_ms: Option<u64>,
    power_activity: tauri::State<'_, Arc<PowerActivityManager>>,
) -> Result<(), String> {
    power_activity.begin(activity_id, reason, ttl_ms);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn system_end_power_activity(
    activity_id: String,
    power_activity: tauri::State<'_, Arc<PowerActivityManager>>,
) -> Result<(), String> {
    power_activity.end(activity_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn project_folder_display_path_strips_verbatim_and_uses_forward_slashes() {
        assert_eq!(
            project_folder_display_path(Path::new(r"\\?\C:\Users\Me\Repo")),
            "C:/Users/Me/Repo"
        );
        assert_eq!(
            project_folder_display_path(Path::new(r"\\?\UNC\server\share\Repo")),
            "//server/share/Repo"
        );
        assert_eq!(
            project_folder_display_path(Path::new("/Users/me/repo")),
            "/Users/me/repo"
        );
    }

    #[test]
    fn sanitize_uploaded_file_name_avoids_windows_reserved_names() {
        assert_eq!(
            sanitize_uploaded_file_name("safe name.txt"),
            "safe name.txt"
        );
        assert_eq!(sanitize_uploaded_file_name("CON.txt"), "CON_file.txt");
        assert_eq!(sanitize_uploaded_file_name("aux"), "aux_file");
        assert_eq!(sanitize_uploaded_file_name("LPT9.log"), "LPT9_file.log");
        assert_eq!(sanitize_uploaded_file_name("COM0.log"), "COM0.log");
    }

    #[test]
    fn sanitize_uploaded_file_name_preserves_unicode_names() {
        assert_eq!(sanitize_uploaded_file_name("report.pdf"), "report.pdf");
        assert_eq!(
            sanitize_uploaded_file_name("Q3 finance:report.xlsx"),
            "Q3 finance_report.xlsx"
        );
        assert_eq!(
            sanitize_uploaded_file_name("русский файл.txt"),
            "русский файл.txt"
        );
        assert_eq!(
            sanitize_uploaded_file_name("interview-questions(final).docx"),
            "interview-questions(final).docx"
        );
        // Path separators and traversal sequences are flattened into a single component; control characters are replaced.
        assert_eq!(
            sanitize_uploaded_file_name("../../secret.txt"),
            "_.._secret.txt"
        );
        assert_eq!(
            sanitize_uploaded_file_name("malicious\u{7}bell.txt"),
            "malicious_bell.txt"
        );
        // Falls back to a placeholder name when every character is illegal.
        assert_eq!(sanitize_uploaded_file_name("..."), "file");
    }

    #[test]
    fn directory_import_components_preserve_leading_dots() {
        assert_eq!(
            sanitized_relative_components(".env"),
            Some(vec![".env".to_string()])
        );
        assert_eq!(
            sanitized_relative_components(".github/workflows/ci.yml"),
            Some(vec![
                ".github".to_string(),
                "workflows".to_string(),
                "ci.yml".to_string(),
            ])
        );
        assert_eq!(
            sanitized_relative_components(".gitignore"),
            Some(vec![".gitignore".to_string()])
        );
        assert_eq!(sanitized_relative_components("../.env"), None);
        assert_eq!(sanitized_relative_components("./.env"), None);
    }

    #[test]
    fn upload_import_root_stays_outside_the_workspace() {
        let root = upload_import_root().expect("create upload root");

        let staging_base = upload_staging_base().expect("resolve staging base");
        assert!(
            root.starts_with(&staging_base),
            "upload root should live in the app staging area: {}",
            root.display()
        );
        assert!(root.exists(), "upload root should be created");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gc_upload_staging_removes_only_expired_batches() {
        let temp = tempdir().expect("create temp dir");
        let base = temp.path().join("uploads");
        let expired = base.join("100");
        let fresh = base.join("200");
        fs::create_dir_all(&expired).expect("create expired batch");
        fs::create_dir_all(&fresh).expect("create fresh batch");
        fs::write(expired.join("old.txt"), b"old").expect("write expired file");

        let retention = std::time::Duration::from_secs(60);
        let now = SystemTime::now() + std::time::Duration::from_secs(120);
        let removed = gc_upload_staging_in(&base, now, retention);

        assert_eq!(removed, 2, "both stale batches are collected");
        assert!(!expired.exists());
        assert!(!fresh.exists());

        fs::create_dir_all(&fresh).expect("recreate fresh batch");
        let kept = gc_upload_staging_in(&base, SystemTime::now(), retention);
        assert_eq!(kept, 0, "batches inside the retention window survive");
        assert!(fresh.exists());
    }

    #[test]
    fn readable_file_entries_report_staging_display_paths() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        let staging = upload_staging_base().expect("resolve staging base");
        let batch = staging.join("test-batch-entry");
        fs::create_dir_all(&workdir).expect("create workdir");
        fs::create_dir_all(&batch).expect("create staging batch");
        let staged = batch.join("notes.txt");
        fs::write(&staged, b"hello").expect("write staged file");

        let entry = build_readable_file_entry(&workdir, &staged, "text", 5, None)
            .expect("build staged entry");
        assert_eq!(entry.relative_path, "uploads/test-batch-entry/notes.txt");
        assert_eq!(entry.absolute_path, staged.to_string_lossy());

        let inside = workdir.join("src").join("main.rs");
        fs::create_dir_all(inside.parent().expect("parent")).expect("create src dir");
        fs::write(&inside, b"fn main() {}").expect("write workspace file");
        let workspace_entry =
            build_readable_file_entry(&workdir, &inside, "text", 12, None).expect("build entry");
        assert_eq!(workspace_entry.relative_path, "src/main.rs");

        let _ = fs::remove_dir_all(&batch);
    }

    #[test]
    fn upload_dedupe_keys_distinguish_source_identity_and_content_versions() {
        let first_path = Path::new("/tmp/source-a.txt");
        assert_eq!(
            readable_path_dedupe_key(first_path),
            readable_path_dedupe_key(first_path)
        );
        assert_ne!(
            readable_path_dedupe_key(first_path),
            readable_path_dedupe_key(Path::new("/tmp/source-b.txt"))
        );

        assert_eq!(
            uploaded_content_dedupe_key("notes.txt", b"same"),
            uploaded_content_dedupe_key("notes.txt", b"same")
        );
        assert_ne!(
            uploaded_content_dedupe_key("notes.txt", b"same"),
            uploaded_content_dedupe_key("notes.txt", b"changed")
        );
        assert_ne!(
            uploaded_content_dedupe_key("notes.txt", b"same"),
            uploaded_content_dedupe_key("other.txt", b"same")
        );
    }

    #[test]
    fn create_project_folder_creates_new_directory() {
        let temp = tempdir().expect("create temp dir");
        let response = system_create_project_folder_sync(
            temp.path().to_string_lossy().into_owned(),
            "Project Alpha".to_string(),
        )
        .expect("create project folder");

        let path = PathBuf::from(response.path);
        assert!(path.is_dir());
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("Project Alpha")
        );
    }

    #[test]
    fn create_project_folder_reuses_existing_directory() {
        let temp = tempdir().expect("create temp dir");
        let existing = temp.path().join("Existing");
        fs::create_dir(&existing).expect("create existing dir");

        let response = system_create_project_folder_sync(
            temp.path().to_string_lossy().into_owned(),
            "Existing".to_string(),
        )
        .expect("reuse existing dir");

        assert_eq!(
            response.path,
            project_folder_display_path(
                &existing.canonicalize().expect("canonicalize existing dir")
            )
        );
    }

    #[test]
    fn create_project_folder_rejects_invalid_name_and_file_conflict() {
        let temp = tempdir().expect("create temp dir");
        let invalid = system_create_project_folder_sync(
            temp.path().to_string_lossy().into_owned(),
            "..".to_string(),
        )
        .expect_err("reject invalid project name");
        assert!(invalid.contains("Project name"));

        let file_path = temp.path().join("conflict");
        fs::write(&file_path, b"not a directory").expect("write conflict file");
        let conflict = system_create_project_folder_sync(
            temp.path().to_string_lossy().into_owned(),
            "conflict".to_string(),
        )
        .expect_err("reject file conflict");
        assert!(conflict.contains("is not a folder"));
    }

    #[test]
    fn create_project_folder_rejects_missing_parent() {
        let temp = tempdir().expect("create temp dir");
        let missing_parent = temp.path().join("missing");

        let error = system_create_project_folder_sync(
            missing_parent.to_string_lossy().into_owned(),
            "Project".to_string(),
        )
        .expect_err("reject missing parent");

        assert!(error.contains("Parent directory does not exist"));
    }

    #[test]
    fn resolve_dropped_workspace_folders_canonicalizes_and_deduplicates() {
        let temp = tempdir().expect("create temp dir");
        let project = temp.path().join("project");
        fs::create_dir(&project).expect("create project dir");
        let raw = project.to_string_lossy().into_owned();

        let resolved =
            system_resolve_dropped_workspace_folders_sync(vec![raw.clone(), format!("{raw}/./")])
                .expect("resolve dropped workspace folders");

        assert_eq!(resolved.len(), 1);
        assert_eq!(
            resolved[0],
            project_folder_display_path(&project.canonicalize().expect("canonicalize project"))
        );
    }

    #[test]
    fn resolve_dropped_workspace_folders_rejects_mixed_files_atomically() {
        let temp = tempdir().expect("create temp dir");
        let project = temp.path().join("project");
        let file = temp.path().join("notes.txt");
        fs::create_dir(&project).expect("create project dir");
        fs::write(&file, b"notes").expect("write file");

        let error = system_resolve_dropped_workspace_folders_sync(vec![
            project.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        ])
        .expect_err("mixed drop must be rejected");

        assert!(error.contains("only supports dropping folders"));
    }

    #[test]
    fn classify_dropped_paths_splits_files_and_dirs() {
        let temp = tempdir().expect("create temp dir");
        let project = temp.path().join("project");
        let file = temp.path().join("notes.txt");
        fs::create_dir(&project).expect("create project dir");
        fs::write(&file, b"notes").expect("write file");

        let classified = system_classify_dropped_paths_sync(vec![
            project.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        ])
        .expect("classify dropped paths");

        assert_eq!(classified.files, vec![file.to_string_lossy().into_owned()]);
        assert_eq!(
            classified.dirs,
            vec![project_folder_display_path(
                &project.canonicalize().expect("canonicalize project")
            )]
        );
    }

    #[test]
    fn classify_dropped_paths_deduplicates_canonical_dirs() {
        let temp = tempdir().expect("create temp dir");
        let project = temp.path().join("project");
        fs::create_dir(&project).expect("create project dir");
        let raw = project.to_string_lossy().into_owned();

        let classified = system_classify_dropped_paths_sync(vec![raw.clone(), format!("{raw}/./")])
            .expect("classify dropped paths");

        assert!(classified.files.is_empty());
        assert_eq!(classified.dirs.len(), 1);
    }

    #[test]
    fn classify_dropped_paths_rejects_missing_entries() {
        let temp = tempdir().expect("create temp dir");
        let missing = temp.path().join("missing");

        let error =
            system_classify_dropped_paths_sync(vec![missing.to_string_lossy().into_owned()])
                .expect_err("missing path must be rejected");

        assert!(error.contains("does not exist or is inaccessible"));
    }

    #[test]
    fn import_directory_writes_nested_files_and_skips_traversal() {
        let temp = tempdir().expect("create temp dir");
        let base = temp.path().join("imports");
        let root = create_unique_import_root(&base, "demo").expect("create root");
        assert!(root.ends_with("demo"));

        let files = vec![
            SystemImportDirectoryInputFile {
                relative_path: "src/main.rs".to_string(),
                content: b"fn main() {}".to_vec(),
            },
            SystemImportDirectoryInputFile {
                relative_path: "../escape.txt".to_string(),
                content: b"nope".to_vec(),
            },
        ];
        let mut skipped = Vec::new();
        let mut count = 0u32;
        for file in files {
            match sanitized_relative_components(&file.relative_path) {
                Some(components) => {
                    let mut destination = root.clone();
                    for component in &components {
                        destination.push(component);
                    }
                    fs::create_dir_all(destination.parent().expect("parent"))
                        .expect("create parent");
                    fs::write(&destination, &file.content).expect("write file");
                    count += 1;
                }
                None => skipped.push(file.relative_path),
            }
        }

        assert_eq!(count, 1);
        assert_eq!(skipped, vec!["../escape.txt".to_string()]);
        assert_eq!(
            fs::read(root.join("src/main.rs")).expect("read nested file"),
            b"fn main() {}"
        );
    }

    #[test]
    fn chunked_directory_import_preserves_dot_paths_and_commits_atomically() {
        let temp = tempdir().expect("create temp dir");
        let base = temp.path().join("imports");
        let staging_root = base.join(".staging").join("test-dotfiles");
        fs::create_dir_all(&staging_root).expect("create staging root");
        let env_content = b"TOKEN=secret";
        let workflow_content = b"name: CI";
        let expected_bytes = u64::try_from(env_content.len() + workflow_content.len()).unwrap();
        directory_import_transfers()
            .lock()
            .expect("lock transfers")
            .insert(
                "test-dotfiles".to_string(),
                DirectoryImportTransferState {
                    base: base.clone(),
                    folder_name: ".demo".to_string(),
                    staging_root,
                    expected_files: 2,
                    expected_bytes,
                    received_bytes: 0,
                    files: HashMap::new(),
                    skipped: Vec::new(),
                    last_activity: Instant::now(),
                },
            );

        system_import_directory_chunk_sync(
            "test-dotfiles".to_string(),
            ".env".to_string(),
            0,
            env_content.to_vec(),
            true,
        )
        .expect("write env chunk");
        system_import_directory_chunk_sync(
            "test-dotfiles".to_string(),
            ".github/workflows/ci.yml".to_string(),
            0,
            workflow_content.to_vec(),
            true,
        )
        .expect("write workflow chunk");
        let outcome = system_import_directory_commit_sync("test-dotfiles".to_string())
            .expect("commit directory import");

        let root = PathBuf::from(&outcome.root_path);
        assert!(root.ends_with(".demo"));
        assert_eq!(fs::read(root.join(".env")).unwrap(), env_content);
        assert_eq!(
            fs::read(root.join(".github/workflows/ci.yml")).unwrap(),
            workflow_content
        );
        assert_eq!(outcome.file_count, 2);
        assert_eq!(outcome.received_bytes, expected_bytes);
    }

    #[test]
    fn chunked_directory_import_rejects_oversized_or_non_contiguous_chunks() {
        let too_large = vec![0; DIRECTORY_IMPORT_CHUNK_BYTES + 1];
        let error = system_import_directory_chunk_sync(
            "missing-transfer".to_string(),
            "large.bin".to_string(),
            0,
            too_large,
            true,
        )
        .expect_err("oversized chunks must fail before transfer lookup");
        assert!(error.contains("chunk exceeds"));

        let temp = tempdir().expect("create temp dir");
        let base = temp.path().join("imports");
        let staging_root = base.join(".staging").join("test-offsets");
        fs::create_dir_all(&staging_root).expect("create staging root");
        directory_import_transfers()
            .lock()
            .expect("lock transfers")
            .insert(
                "test-offsets".to_string(),
                DirectoryImportTransferState {
                    base,
                    folder_name: "offsets".to_string(),
                    staging_root,
                    expected_files: 1,
                    expected_bytes: 4,
                    received_bytes: 0,
                    files: HashMap::new(),
                    skipped: Vec::new(),
                    last_activity: Instant::now(),
                },
            );
        system_import_directory_chunk_sync(
            "test-offsets".to_string(),
            "data.bin".to_string(),
            0,
            vec![1, 2],
            false,
        )
        .expect("write first chunk");
        let error = system_import_directory_chunk_sync(
            "test-offsets".to_string(),
            "data.bin".to_string(),
            3,
            vec![3, 4],
            true,
        )
        .expect_err("non-contiguous offsets must fail");
        assert!(error.contains("offset is discontinuous"));
        system_import_directory_abort_sync("test-offsets".to_string())
            .expect("abort offset test transfer");
    }

    fn directory_transfer_state_for_test(
        base: &Path,
        staging_root: PathBuf,
    ) -> DirectoryImportTransferState {
        DirectoryImportTransferState {
            base: base.to_path_buf(),
            folder_name: "demo".to_string(),
            staging_root,
            expected_files: 1,
            expected_bytes: 4,
            received_bytes: 0,
            files: HashMap::new(),
            skipped: Vec::new(),
            last_activity: Instant::now(),
        }
    }

    #[test]
    fn stale_directory_transfers_expire_with_their_staging_dirs() {
        let temp = tempdir().expect("create temp dir");
        let base = temp.path().join("imports");
        let staging_base = base.join(".staging");
        let stale_staging = staging_base.join("stale-transfer");
        let live_staging = staging_base.join("live-transfer");
        fs::create_dir_all(&stale_staging).expect("create stale staging");
        fs::create_dir_all(&live_staging).expect("create live staging");
        write_directory_import_activity(&stale_staging).expect("write stale activity");
        write_directory_import_activity(&live_staging).expect("write live activity");

        // A local table avoids parallel tests sharing a global singleton; run a sweep directly to verify that without a further
        // START or process restart, memory state, the staging directory, and the activity marker are all released together.
        let transfers = Mutex::new(HashMap::new());
        let mut states = transfers.lock().expect("lock local transfers");
        states.insert(
            "stale-transfer".to_string(),
            DirectoryImportTransferState {
                last_activity: Instant::now()
                    .checked_sub(Duration::from_secs(10))
                    .expect("stale instant"),
                ..directory_transfer_state_for_test(&base, stale_staging.clone())
            },
        );
        states.insert(
            "live-transfer".to_string(),
            directory_transfer_state_for_test(&base, live_staging.clone()),
        );
        drop(states);

        sweep_directory_import_staging_in(
            &transfers,
            &[staging_base],
            SystemTime::now(),
            Duration::from_secs(5),
        );

        let states = transfers.lock().expect("lock swept transfers");
        assert!(!states.contains_key("stale-transfer"));
        assert!(!stale_staging.exists());
        assert!(!directory_import_activity_path(&stale_staging).exists());
        assert!(states.contains_key("live-transfer"));
        assert!(live_staging.exists());
        assert!(directory_import_activity_path(&live_staging).exists());
    }

    #[test]
    fn directory_import_staging_gc_removes_only_stale_orphans() {
        let temp = tempdir().expect("create temp dir");
        let base = temp.path().join("imports");
        let staging_base = base.join(".staging");
        let orphan = staging_base.join("orphan-transfer");
        let active_staging = staging_base.join("active-transfer");
        fs::create_dir_all(&orphan).expect("create orphan staging");
        fs::write(orphan.join("partial.bin"), b"data").expect("write orphan residue");
        write_directory_import_activity(&orphan).expect("write orphan activity");
        fs::create_dir_all(&active_staging).expect("create active staging");

        let active = HashSet::from(["active-transfer".to_string()]);

        // Use a deferred now to simulate a stale directory, avoiding changing mtime in the test.
        let aged_now = SystemTime::now() + DIRECTORY_IMPORT_IDLE_TTL + Duration::from_secs(60);
        let removed = gc_directory_import_staging_in(
            &staging_base,
            &active,
            aged_now,
            DIRECTORY_IMPORT_IDLE_TTL,
        );
        assert_eq!(removed, 1);
        assert!(!orphan.exists());
        assert!(!directory_import_activity_path(&orphan).exists());
        assert!(active_staging.exists());

        // A directory with no state in the current process but a still-fresh activity marker may belong to another
        // ReactorPro instance and must be preserved; a fresh old-version directory without a marker is likewise preserved.
        let foreign_active = staging_base.join("foreign-active");
        fs::create_dir_all(&foreign_active).expect("create foreign active staging");
        write_directory_import_activity(&foreign_active).expect("write foreign activity");
        let fresh_legacy = staging_base.join("fresh-legacy");
        fs::create_dir_all(&fresh_legacy).expect("create fresh legacy staging");
        let removed = gc_directory_import_staging_in(
            &staging_base,
            &active,
            SystemTime::now(),
            DIRECTORY_IMPORT_IDLE_TTL,
        );
        assert_eq!(removed, 0);
        assert!(foreign_active.exists());
        assert!(fresh_legacy.exists());
    }

    #[tokio::test]
    async fn directory_import_gc_runs_periodically_without_external_events() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let mut sender = Some(sender);
        let task = tokio::spawn(run_periodic_directory_import_gc(
            Duration::from_millis(10),
            move || {
                let sender = sender.take();
                async move {
                    if let Some(sender) = sender {
                        let _ = sender.send(());
                    }
                }
            },
        ));

        tokio::time::timeout(Duration::from_secs(1), receiver)
            .await
            .expect("periodic directory import GC did not run")
            .expect("periodic directory import GC signal dropped");
        task.abort();
    }

    #[test]
    fn chunked_directory_commit_does_not_replace_existing_empty_directory() {
        let temp = tempdir().expect("create temp dir");
        let base = temp.path().join("imports");
        let existing = base.join("demo");
        let staging = base.join(".staging").join("test-no-replace");
        fs::create_dir_all(&existing).expect("create existing directory");
        fs::create_dir_all(&staging).expect("create staging directory");
        fs::write(staging.join("file.txt"), b"content").expect("write staged file");

        let destination = move_staging_to_unique_import_root(&staging, &base, "demo")
            .expect("commit without replacing existing directory");

        assert!(existing.is_dir());
        assert_eq!(destination, base.join("demo-2"));
        assert_eq!(fs::read(destination.join("file.txt")).unwrap(), b"content");
    }

    #[test]
    fn import_root_names_get_unique_suffixes() {
        let temp = tempdir().expect("create temp dir");
        let base = temp.path().join("imports");

        let first = create_unique_import_root(&base, "demo").expect("first root");
        let second = create_unique_import_root(&base, "demo").expect("second root");

        assert!(first.ends_with("demo"));
        assert!(second.ends_with("demo-2"));
    }

    #[test]
    fn sanitized_relative_components_rejects_dot_segments_and_keeps_cjk() {
        assert_eq!(sanitized_relative_components("../secret"), None);
        assert_eq!(sanitized_relative_components("a/./b"), None);
        assert_eq!(sanitized_relative_components(""), None);
        assert_eq!(
            sanitized_relative_components("docs\\report.pdf"),
            Some(vec!["docs".to_string(), "report.pdf".to_string()])
        );
    }

    #[test]
    fn import_uploaded_readable_files_keeps_multiple_files_in_one_batch() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let workdir = std::env::temp_dir().join(format!(
            "liveagent-upload-multiple-test-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&workdir).expect("create test workdir");

        let response = system_import_uploaded_readable_files_sync(
            workdir.to_string_lossy().into_owned(),
            vec![
                SystemReadableFileUploadInput {
                    file_name: "notes.txt".to_string(),
                    mime_type: Some("text/plain".to_string()),
                    content: b"hello".to_vec(),
                },
                SystemReadableFileUploadInput {
                    file_name: "tasks.md".to_string(),
                    mime_type: Some("text/markdown".to_string()),
                    content: b"# tasks".to_vec(),
                },
            ],
        )
        .expect("import multiple uploaded files");

        assert!(
            response.skipped.is_empty(),
            "skipped = {:?}",
            response.skipped
        );
        assert_eq!(response.files.len(), 2);
        assert_eq!(response.files[0].file_name, "notes.txt");
        assert_eq!(response.files[1].file_name, "tasks.md");
        assert!(response.files[0].relative_path.starts_with("uploads/"));
        assert!(response.files[1].relative_path.starts_with("uploads/"));

        let first_parent = Path::new(&response.files[0].absolute_path)
            .parent()
            .expect("first upload parent")
            .to_path_buf();
        let second_parent = Path::new(&response.files[1].absolute_path)
            .parent()
            .expect("second upload parent")
            .to_path_buf();
        assert_eq!(
            first_parent, second_parent,
            "files selected in one upload should share a batch directory"
        );
        assert!(
            !first_parent.starts_with(&workdir),
            "uploads must not land inside the workspace: {}",
            first_parent.display()
        );

        let _ = fs::remove_dir_all(&first_parent);
        let _ = fs::remove_dir_all(&workdir);
    }

    #[test]
    fn import_uploaded_readable_files_from_base64_respects_max_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let workdir = std::env::temp_dir().join(format!(
            "liveagent-upload-base64-test-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&workdir).expect("create test workdir");

        let response = system_import_uploaded_readable_files_from_base64_sync(
            workdir.to_string_lossy().into_owned(),
            vec![
                SystemUploadedReadableFileInput {
                    file_name: "clipboard-a.txt".to_string(),
                    mime_type: Some("text/plain".to_string()),
                    content_base64: BASE64_STANDARD.encode("alpha"),
                },
                SystemUploadedReadableFileInput {
                    file_name: "clipboard-b.txt".to_string(),
                    mime_type: Some("text/plain".to_string()),
                    content_base64: BASE64_STANDARD.encode("beta"),
                },
            ],
            Some(1),
        )
        .expect("import base64 clipboard upload");

        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].file_name, "clipboard-a.txt");
        assert!(
            response
                .skipped
                .iter()
                .any(|item| item.contains("ignored 1 extra file")),
            "skipped = {:?}",
            response.skipped
        );
        assert_eq!(
            fs::read_to_string(&response.files[0].absolute_path).expect("read imported file"),
            "alpha"
        );

        if let Some(parent) = Path::new(&response.files[0].absolute_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
        let _ = fs::remove_dir_all(&workdir);
    }

    #[test]
    fn import_uploaded_readable_files_preserves_unicode_file_names() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");

        let response = system_import_uploaded_readable_files_sync(
            workdir.to_string_lossy().into_owned(),
            vec![SystemReadableFileUploadInput {
                file_name: "café-report.txt".to_string(),
                mime_type: Some("text/plain".to_string()),
                content: "hello".as_bytes().to_vec(),
            }],
        )
        .expect("import unicode-named upload");

        assert!(
            response.skipped.is_empty(),
            "skipped = {:?}",
            response.skipped
        );
        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].file_name, "café-report.txt");
        assert!(
            response.files[0].relative_path.ends_with("/café-report.txt"),
            "relative_path = {}",
            response.files[0].relative_path
        );
        assert!(
            response.files[0].absolute_path.ends_with("café-report.txt"),
            "absolute_path = {}",
            response.files[0].absolute_path
        );

        if let Some(parent) = Path::new(&response.files[0].absolute_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn read_uploaded_native_attachment_reads_workspace_file_and_rejects_escape() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        let upload_dir = workdir.join("uploads").join("batch");
        fs::create_dir_all(&upload_dir).expect("create upload dir");
        let upload = upload_dir.join("note.txt");
        fs::write(&upload, b"hello").expect("write upload");

        let response = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            Some(upload.to_string_lossy().into_owned()),
            Some("text".to_string()),
        )
        .expect("read native attachment");

        assert_eq!(response.mime_type, "text/plain");
        assert_eq!(response.data, BASE64_STANDARD.encode(b"hello"));
        assert_eq!(response.size_bytes, 5);

        // Old attachments with only a workdir-relative path are no longer compatible: a missing absolute path is rejected outright.
        let legacy = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            None,
            Some("text".to_string()),
        )
        .expect_err("relative-only legacy attachments must be rejected");
        assert!(legacy.contains("Attachment is missing an absolute path"), "error = {legacy}");

        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"outside").expect("write outside file");
        let error = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            Some(outside.to_string_lossy().into_owned()),
            Some("text".to_string()),
        )
        .expect_err("outside file must be rejected");

        assert!(
            error.contains("Attachment path escapes the current working directory and upload staging area"),
            "error = {error}"
        );
    }

    #[test]
    fn read_uploaded_native_attachment_allows_staging_files() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");
        let staging = upload_staging_base().expect("resolve staging base");
        let batch = staging.join("test-batch-native");
        fs::create_dir_all(&batch).expect("create staging batch");
        let staged = batch.join("note.txt");
        fs::write(&staged, b"staged").expect("write staged file");

        let response = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            Some(staged.to_string_lossy().into_owned()),
            Some("text".to_string()),
        )
        .expect("staging attachment must be readable");

        assert_eq!(response.data, BASE64_STANDARD.encode(b"staged"));

        let _ = fs::remove_dir_all(&batch);
    }

    #[test]
    fn attachment_authorization_compares_canonical_staging_base() {
        // Reproduces the production bug shape: at authorization time target is always the canonicalize output (on Windows
        // this is `\\?\` verbatim, with symlinks resolved), while the logical staging root is not. The test staging root
        // deliberately passes through a symlink on Unix; if the comparison is not performed in canonical isomorphic form,
        // the canonicalized target will not hit the logical root and this fails immediately. Out-of-bounds rejection is covered by
        // read_uploaded_native_attachment_reads_workspace_file_and_rejects_escape.
        let staging = upload_staging_base().expect("resolve staging base");
        let batch = staging.join("test-batch-auth");
        fs::create_dir_all(&batch).expect("create staging batch");
        let staged = batch.join("auth.txt");
        fs::write(&staged, b"auth").expect("write staged file");
        let canonical_target = fs::canonicalize(&staged).expect("canonicalize staged file");

        let temp = tempdir().expect("create temp dir");
        let workdir = fs::canonicalize(temp.path()).expect("canonicalize workdir");

        assert!(
            is_allowed_attachment_target(&workdir, &canonical_target),
            "canonicalized staging target must stay authorized: {}",
            canonical_target.display()
        );

        let _ = fs::remove_dir_all(&batch);
    }

    #[test]
    fn resolve_uploaded_image_target_allows_workspace_and_staging_images() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");
        let workspace_image = workdir.join("diagram.png");
        fs::write(&workspace_image, b"not-decoded-by-this-validation").expect("write image");

        let (target, mime_type) = resolve_uploaded_image_target(
            &workdir.to_string_lossy(),
            &workspace_image.to_string_lossy(),
        )
        .expect("workspace image should be authorized");
        assert_eq!(
            target,
            fs::canonicalize(&workspace_image).expect("canonicalize image")
        );
        assert_eq!(mime_type, "image/png");

        let staging = upload_staging_base().expect("resolve staging base");
        let batch = staging.join(format!("test-batch-image-open-{}", std::process::id()));
        fs::create_dir_all(&batch).expect("create staging batch");
        let staged_image = batch.join("generated.webp");
        fs::write(&staged_image, b"staged-image").expect("write staged image");

        let (_, staged_mime_type) = resolve_uploaded_image_target(
            &workdir.to_string_lossy(),
            &staged_image.to_string_lossy(),
        )
        .expect("staging image should be authorized");
        assert_eq!(staged_mime_type, "image/webp");

        let _ = fs::remove_dir_all(&batch);
    }

    #[test]
    fn resolve_uploaded_image_target_rejects_directories_non_images_invalid_workdirs_and_escapes() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");

        let directory_error =
            resolve_uploaded_image_target(&workdir.to_string_lossy(), &workdir.to_string_lossy())
                .expect_err("directories must be rejected");
        assert!(!directory_error.trim().is_empty());

        let text_file = workdir.join("notes.txt");
        fs::write(&text_file, b"notes").expect("write text file");
        let non_image_error =
            resolve_uploaded_image_target(&workdir.to_string_lossy(), &text_file.to_string_lossy())
                .expect_err("non-images must be rejected");
        assert!(non_image_error.contains("not a supported image file"));

        let outside = temp.path().join("outside.png");
        fs::write(&outside, b"outside").expect("write outside image");
        let outside_error =
            resolve_uploaded_image_target(&workdir.to_string_lossy(), &outside.to_string_lossy())
                .expect_err("outside images must be rejected");
        assert!(outside_error.contains("outside the current workspace"));

        let invalid_workdir = temp.path().join("missing-workspace");
        let workdir_error = resolve_uploaded_image_target(
            &invalid_workdir.to_string_lossy(),
            &outside.to_string_lossy(),
        )
        .expect_err("missing workdir must be rejected");
        assert!(!workdir_error.trim().is_empty());
    }

    #[test]
    fn image_preview_data_rejects_empty_invalid_and_oversized_base64() {
        assert!(decode_image_preview_base64("").is_err());
        assert!(decode_image_preview_base64("definitely-not-base64").is_err());

        let oversized = "A".repeat(IMAGE_PREVIEW_DATA_MAX_BYTES * 4 / 3 + 8);
        let error = decode_image_preview_base64(&oversized)
            .expect_err("oversized preview data must be rejected before decoding");
        assert!(error.contains("too large"));
    }

    #[test]
    fn image_preview_rgba_decoder_converts_png() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let (width, height, rgba) =
            decode_image_preview_rgba(png).expect("valid PNG preview should decode");

        assert_eq!((width, height), (1, 1));
        assert_eq!(rgba.len(), 4);
    }

    #[test]
    fn prepared_image_preview_clipboard_requires_matching_fresh_file_signature() {
        let now = SystemTime::now();
        let target = PathBuf::from("prepared-image-preview.png");
        let signature = ImagePreviewFileSignature {
            len: 123,
            modified_at: Some(now),
        };
        let prepared = PreparedImagePreviewClipboard {
            target: target.clone(),
            signature: signature.clone(),
            prepared_at: now,
            width: 1,
            height: 1,
            rgba: vec![0, 0, 0, 255],
        };

        assert!(prepared_image_preview_clipboard_matches(
            &prepared, &target, &signature, now
        ));
        assert!(!prepared_image_preview_clipboard_matches(
            &prepared,
            &PathBuf::from("other-image-preview.png"),
            &signature,
            now,
        ));
        assert!(!prepared_image_preview_clipboard_matches(
            &prepared,
            &target,
            &ImagePreviewFileSignature {
                len: 124,
                modified_at: Some(now),
            },
            now,
        ));
        assert!(!prepared_image_preview_clipboard_matches(
            &prepared,
            &target,
            &signature,
            now.checked_add(IMAGE_PREVIEW_CLIPBOARD_CACHE_TTL + Duration::from_secs(1))
                .expect("valid expiry timestamp"),
        ));
    }

    #[test]
    fn image_preview_save_target_is_one_time_and_expires() {
        let target = PathBuf::from("image-preview-save-target.png");
        let save_token = remember_image_preview_save_target(target.clone())
            .expect("remember image preview save target");
        assert_eq!(
            take_image_preview_save_target(&save_token).expect("consume image preview save target"),
            target
        );
        assert!(take_image_preview_save_target(&save_token).is_err());

        let expired_token = Uuid::new_v4().to_string();
        pending_image_preview_save_targets()
            .lock()
            .expect("lock image preview save targets")
            .insert(
                expired_token.clone(),
                PendingImagePreviewSaveTarget {
                    target: PathBuf::from("expired-image-preview-save-target.png"),
                    created_at: SystemTime::now()
                        .checked_sub(IMAGE_PREVIEW_SAVE_TARGET_TTL + Duration::from_secs(1))
                        .expect("valid expired image preview save timestamp"),
                },
            );
        assert!(take_image_preview_save_target(&expired_token).is_err());
    }

    #[test]
    fn image_preview_save_name_is_reduced_to_a_safe_file_name() {
        assert_eq!(
            sanitize_uploaded_file_name("../../chart.png"),
            "_.._chart.png"
        );
        assert_eq!(
            sanitize_uploaded_file_name("C:\\temp\\chart.png"),
            "C__temp_chart.png"
        );
    }

    #[test]
    fn import_readable_file_paths_copies_external_files_and_honors_limit() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp_root = std::env::temp_dir().join(format!(
            "liveagent-upload-paths-test-{}-{unique}",
            std::process::id()
        ));
        let workdir = temp_root.join("workspace");
        let external = temp_root.join("external");
        fs::create_dir_all(&workdir).expect("create test workdir");
        fs::create_dir_all(&external).expect("create external dir");
        let external_file = external.join("notes.txt");
        let workspace_file = workdir.join("inside.md");
        fs::write(&external_file, "hello").expect("write external file");
        fs::write(&workspace_file, "# inside").expect("write workspace file");

        let response = system_import_readable_file_paths_sync(
            workdir.to_string_lossy().into_owned(),
            vec![
                external_file.to_string_lossy().into_owned(),
                workspace_file.to_string_lossy().into_owned(),
            ],
            Some(1),
        )
        .expect("import readable file paths");

        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].file_name, "notes.txt");
        assert!(response.files[0].relative_path.starts_with("uploads/"));
        assert!(
            !Path::new(&response.files[0].absolute_path).starts_with(&workdir),
            "external uploads must be staged outside the workspace: {}",
            response.files[0].absolute_path
        );
        assert!(
            response
                .skipped
                .iter()
                .any(|item| item.contains("Upload count limit reached")),
            "skipped = {:?}",
            response.skipped
        );

        if let Some(parent) = Path::new(&response.files[0].absolute_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn detects_office_and_archive_upload_kinds() {
        assert_eq!(
            detect_uploaded_bytes_kind(
                "report.docx",
                Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                b"not validated here",
            )
            .expect("docx should be accepted")
            .kind,
            "word"
        );
        assert_eq!(
            detect_uploaded_bytes_kind(
                "workbook.xlsx",
                Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
                b"not validated here",
            )
            .expect("xlsx should be accepted")
            .kind,
            "spreadsheet"
        );
        assert_eq!(
            detect_uploaded_bytes_kind("bundle.tar.gz", Some("application/gzip"), b"gzip")
                .expect("tar.gz should be accepted")
                .kind,
            "archive"
        );
        assert_eq!(
            detect_uploaded_bytes_kind("assets.7z", Some("application/x-7z-compressed"), b"7z")
                .expect("7z should be accepted")
                .kind,
            "archive"
        );
    }

    /// GBK-encoded bytes of "café".
    fn gbk_sample(repeat: usize) -> Vec<u8> {
        let unit: &[u8] = &[
            0x63, 0x61, 0x66, 0xA8, 0xA6,
        ];
        unit.repeat(repeat)
    }

    #[test]
    fn classify_upload_text_bytes_accepts_legacy_encodings() {
        assert_eq!(
            classify_upload_text_bytes("café".as_bytes(), false),
            UploadTextClass::Utf8
        );
        assert_eq!(
            classify_upload_text_bytes(&[0xEF, 0xBB, 0xBF, b'h', b'i'], false),
            UploadTextClass::Utf8
        );
        assert_eq!(
            classify_upload_text_bytes(&gbk_sample(4), false),
            UploadTextClass::NeedsTranscode
        );
        // UTF-16LE BOM + "café": non-ASCII characters must not be mistakenly rejected by the NUL check.
        assert_eq!(
            classify_upload_text_bytes(&[0xFF, 0xFE, 0x63, 0x00, 0x61, 0x00, 0x66, 0x00, 0xE9, 0x00], false),
            UploadTextClass::NeedsTranscode
        );
        assert_eq!(
            classify_upload_text_bytes(&[0x00, 0x01, 0x02, 0x03], false),
            UploadTextClass::Binary
        );
        // Not UTF-8 and with a high control-character ratio: classify as binary rather than text needing transcoding.
        assert_eq!(
            classify_upload_text_bytes(&[0x80, 0x01, 0x02, 0x81, 0x03, 0x04, 0x82, 0x05], false),
            UploadTextClass::Binary
        );
    }

    #[test]
    fn classify_upload_text_bytes_tolerates_truncated_utf8_tail() {
        // Simulate the 32KiB probe boundary splitting a multi-byte character: the full UTF-8 text, on the truncated prefix,
        // must also be classified as UTF-8 text rather than binary or text needing transcoding.
        let mut prefix = vec![b'a'; 16];
        prefix.extend_from_slice(&"€".as_bytes()[..2]);
        assert_eq!(
            classify_upload_text_bytes(&prefix, true),
            UploadTextClass::Utf8
        );
        // In the non-truncated case the same bytes are still invalid UTF-8 -> classified as needing transcoding.
        assert_eq!(
            classify_upload_text_bytes(&prefix, false),
            UploadTextClass::NeedsTranscode
        );
    }

    #[test]
    fn classify_upload_text_file_tolerates_probe_boundary_split() {
        let temp = tempdir().expect("create temp dir");
        let path = temp.path().join("large-utf8.txt");
        // Make a three-byte character land exactly across the 32KiB probe boundary.
        let mut content = vec![b'a'; UPLOAD_TEXT_PROBE_BYTES - 1];
        content.extend_from_slice("€€€".as_bytes());
        fs::write(&path, &content).expect("write large utf8 file");

        assert_eq!(
            classify_upload_text_file(&path).expect("classify large utf8 file"),
            UploadTextClass::Utf8
        );
        assert_eq!(
            detect_upload_file_kind(&path)
                .expect("large utf8 txt must stay text")
                .kind,
            "text"
        );
    }

    #[test]
    fn transcode_upload_text_handles_gbk_and_utf16() {
        let gbk = gbk_sample(4);
        let transcoded = transcode_upload_text_to_utf8(&gbk);
        assert_eq!(
            String::from_utf8(transcoded).expect("transcoded output must be utf8"),
            "café".repeat(4)
        );

        let utf16le = [0xFF, 0xFE, 0x63, 0x00, 0x61, 0x00, 0x66, 0x00, 0xE9, 0x00];
        assert_eq!(
            String::from_utf8(transcode_upload_text_to_utf8(&utf16le)).expect("utf16 to utf8"),
            "café"
        );

        // Valid UTF-8 is returned as-is (classification may come from a false positive on a truncated prefix).
        let utf8 = "café".as_bytes();
        assert_eq!(transcode_upload_text_to_utf8(utf8), utf8);
    }

    #[test]
    fn import_uploaded_gbk_text_is_transcoded_to_utf8() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");

        let response = system_import_uploaded_readable_files_sync(
            workdir.to_string_lossy().into_owned(),
            vec![SystemReadableFileUploadInput {
                file_name: "gbk-notes.txt".to_string(),
                mime_type: Some("text/plain".to_string()),
                content: gbk_sample(8),
            }],
        )
        .expect("import gbk upload");

        assert!(
            response.skipped.is_empty(),
            "skipped = {:?}",
            response.skipped
        );
        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].kind, "text");
        let staged =
            fs::read_to_string(&response.files[0].absolute_path).expect("staged copy must be utf8");
        assert_eq!(staged, "café".repeat(8));
        assert_eq!(response.files[0].size_bytes, staged.len() as u64);

        if let Some(parent) = Path::new(&response.files[0].absolute_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn import_external_gbk_file_path_is_transcoded_to_utf8() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        let external = temp.path().join("external");
        fs::create_dir_all(&workdir).expect("create workdir");
        fs::create_dir_all(&external).expect("create external dir");
        let source = external.join("gbk-notes.txt");
        fs::write(&source, gbk_sample(8)).expect("write gbk source");

        let response = system_import_readable_file_paths_sync(
            workdir.to_string_lossy().into_owned(),
            vec![source.to_string_lossy().into_owned()],
            None,
        )
        .expect("import gbk file path");

        assert!(
            response.skipped.is_empty(),
            "skipped = {:?}",
            response.skipped
        );
        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].kind, "text");
        let staged =
            fs::read_to_string(&response.files[0].absolute_path).expect("staged copy must be utf8");
        assert_eq!(staged, "café".repeat(8));
        // The original file stays as-is and is not rewritten.
        assert_eq!(fs::read(&source).expect("read source"), gbk_sample(8));

        if let Some(parent) = Path::new(&response.files[0].absolute_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn read_uploaded_native_attachment_transcodes_legacy_text() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");
        // A GBK file referenced in place inside the workspace: not rewritten on import, transcoded when inlined on read.
        let inside = workdir.join("legacy.txt");
        fs::write(&inside, gbk_sample(8)).expect("write gbk workspace file");

        let response = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            Some(inside.to_string_lossy().into_owned()),
            Some("text".to_string()),
        )
        .expect("read gbk native attachment");

        assert_eq!(response.mime_type, "text/plain");
        let expected = "café".repeat(8);
        assert_eq!(response.data, BASE64_STANDARD.encode(expected.as_bytes()));
        assert_eq!(response.size_bytes, expected.len() as u64);
    }
}
