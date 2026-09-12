use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};

use crate::runtime::platform::{
    expand_tilde_path, maybe_augment_macos_path, shell_basename, strip_windows_verbatim_prefix,
};
use crate::runtime::process::{configure_child_process_group, terminate_child_process_tree};
use crate::runtime::sandbox::{self, SandboxOptions, SandboxSpec};

const MAX_STDOUT_BYTES: usize = 400 * 1024; // 400KB
const MAX_STDERR_BYTES: usize = 400 * 1024; // 400KB
pub(crate) const DEFAULT_SHELL_TIMEOUT_MS: u64 = 120_000;
pub(crate) const MIN_SHELL_TIMEOUT_MS: u64 = 1_000;
pub(crate) const MAX_SHELL_TIMEOUT_MS: u64 = 10 * 60_000;
const TERMINATION_GRACE_MS: u64 = 300;
const STREAM_EOF_GRACE_MS: u64 = 300;

/// Cancellation flag shared between the (possibly blocking) run body and the
/// async cancel watchers. Blocking code polls `is_cancelled`; async code
/// awaits `cancelled()`, which is event-driven via `Notify` — no polling.
#[derive(Default)]
pub(crate) struct ShellCancelFlag {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl ShellCancelFlag {
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once `cancel` has been called.
    pub(crate) async fn cancelled(&self) {
        while !self.is_cancelled() {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Register interest before the re-check so a `cancel` landing
            // between the check and the await cannot be missed.
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

pub(crate) type ShellCancelToken = Arc<ShellCancelFlag>;

#[derive(Default)]
pub(crate) struct ShellRunRegistry {
    runs: Mutex<HashMap<String, ShellCancelToken>>,
}

impl ShellRunRegistry {
    pub(crate) fn register(&self, run_id: &str) -> ShellCancelToken {
        let token = Arc::new(ShellCancelFlag::default());
        let previous = self
            .runs
            .lock()
            .expect("shell run registry poisoned")
            .insert(run_id.to_string(), Arc::clone(&token));
        if let Some(previous) = previous {
            previous.cancel();
        }
        token
    }

    pub(crate) fn cancel(&self, run_id: &str) -> bool {
        let Some(token) = self
            .runs
            .lock()
            .expect("shell run registry poisoned")
            .get(run_id)
            .cloned()
        else {
            return false;
        };
        token.cancel();
        true
    }

    pub(crate) fn unregister(&self, run_id: &str, token: &ShellCancelToken) {
        let mut runs = self.runs.lock().expect("shell run registry poisoned");
        let owns_registration = runs
            .get(run_id)
            .is_some_and(|registered| Arc::ptr_eq(registered, token));
        if owns_registration {
            runs.remove(run_id);
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ShellRunResponse {
    pub exit_code: i32,
    pub shell: String,
    pub platform: String,
    pub profile: String,
    pub shell_family: String,
    /// Sandbox mechanism ("seatbelt"/"bubblewrap"/"low-integrity-token"/"appcontainer"),
    /// None when no sandbox is enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub cancelled: bool,
    pub stdio_open_after_exit: bool,
    pub effective_timeout_ms: u64,
    pub duration_ms: u128,
}

#[derive(Debug)]
enum ShellError {
    InvalidWorkdir(String),
    InvalidRelPath(String),
    OutOfBounds(String),
    Io(io::Error),
    Other(String),
}

impl std::fmt::Display for ShellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ShellError::InvalidWorkdir(s) => {
                write!(f, "workdir must be an existing absolute directory: {s}")
            }
            ShellError::InvalidRelPath(s) => {
                write!(
                    f,
                    "cwd must be relative and must not contain .., drive letters, or a root path: {s}"
                )
            }
            ShellError::OutOfBounds(s) => {
                write!(f, "Target path is outside the workspace root: {s}")
            }
            ShellError::Io(e) => write!(f, "I/O error: {e}"),
            ShellError::Other(s) => write!(f, "{s}"),
        }
    }
}

impl From<io::Error> for ShellError {
    fn from(value: io::Error) -> Self {
        ShellError::Io(value)
    }
}

fn canonicalize_workdir(workdir: &str) -> Result<PathBuf, ShellError> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err(ShellError::InvalidWorkdir(workdir.to_string()));
    }

    let p = expand_tilde_path(raw);
    if !p.is_absolute() {
        return Err(ShellError::InvalidWorkdir(workdir.to_string()));
    }

    let md = fs::metadata(&p).map_err(|_| ShellError::InvalidWorkdir(workdir.to_string()))?;
    if !md.is_dir() {
        return Err(ShellError::InvalidWorkdir(workdir.to_string()));
    }

    // Strip the Windows `\\?\` verbatim prefix: this path becomes the child
    // process cwd and the model-visible workdir string.
    Ok(strip_windows_verbatim_prefix(fs::canonicalize(&p)?))
}

/// Canonical workspace root for runtime entry points that need to construct a
/// sandbox spec. Keep the internal error type private while sharing the exact
/// validation/canonicalization semantics with the one-shot runner.
pub(crate) fn canonical_workdir(workdir: &str) -> Result<PathBuf, String> {
    canonicalize_workdir(workdir).map_err(|error| error.to_string())
}

fn normalize_rel_path_input(input: &str) -> String {
    input.trim().replace('\\', "/")
}

fn sanitize_rel_path_core(input: &str) -> Result<Option<PathBuf>, ShellError> {
    let normalized = normalize_rel_path_input(input);
    if normalized.is_empty() {
        return Err(ShellError::InvalidRelPath(input.to_string()));
    }

    let p = Path::new(&normalized);
    let mut out = PathBuf::new();

    for c in p.components() {
        match c {
            Component::Prefix(_) | Component::RootDir => {
                return Err(ShellError::InvalidRelPath(input.to_string()));
            }
            Component::ParentDir => return Err(ShellError::InvalidRelPath(input.to_string())),
            Component::CurDir => {
                // ignore
            }
            Component::Normal(seg) => {
                if seg.to_string_lossy().contains(':') {
                    return Err(ShellError::InvalidRelPath(input.to_string()));
                }
                out.push(seg);
            }
        }
    }

    if out.as_os_str().is_empty() {
        return Ok(None);
    }

    Ok(Some(out))
}

fn ensure_within_workdir_existing(workdir: &Path, target: &Path) -> Result<PathBuf, ShellError> {
    // Both sides are verbatim-stripped so the prefix check compares like
    // shapes on Windows (workdir came from canonicalize_workdir).
    let canon = strip_windows_verbatim_prefix(fs::canonicalize(target)?);
    if !canon.starts_with(workdir) {
        return Err(ShellError::OutOfBounds(canon.display().to_string()));
    }
    Ok(canon)
}

fn is_absolute_cwd_input(value: &str) -> bool {
    if value.starts_with('/') || value.starts_with('\\') {
        return true;
    }
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn resolve_absolute_cwd(value: &str) -> Result<PathBuf, ShellError> {
    let invalid =
        || ShellError::Other(format!("cwd does not exist or is not a directory: {value}"));
    let canon = strip_windows_verbatim_prefix(fs::canonicalize(value).map_err(|_| invalid())?);
    let md = fs::metadata(&canon).map_err(|_| invalid())?;
    if !md.is_dir() {
        return Err(invalid());
    }
    Ok(canon)
}

pub(crate) fn resolve_shell_cwd(workdir: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let wd = canonicalize_workdir(workdir).map_err(|error| error.to_string())?;
    match cwd {
        None => Ok(wd),
        Some(value) if is_absolute_cwd_input(value.trim()) => {
            resolve_absolute_cwd(value.trim()).map_err(|error| error.to_string())
        }
        Some(value) => match sanitize_rel_path_core(value).map_err(|error| error.to_string())? {
            None => Ok(wd),
            Some(rel) => {
                let target = ensure_within_workdir_existing(&wd, &wd.join(rel))
                    .map_err(|error| error.to_string())?;
                let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
                if !metadata.is_dir() {
                    return Err(
                        ShellError::Other("cwd must be a directory".to_string()).to_string()
                    );
                }
                Ok(target)
            }
        },
    }
}

#[derive(Default)]
struct StreamReadState {
    buf: Vec<u8>,
    truncated: bool,
    done: bool,
}

struct StreamReadHandle {
    state: Arc<(Mutex<StreamReadState>, Condvar)>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl StreamReadHandle {
    fn finish(mut self, eof_grace: Duration) -> (Vec<u8>, bool, bool) {
        let (lock, cvar) = &*self.state;
        let mut state = lock.lock().expect("stream reader state poisoned");

        if !state.done {
            let (next_state, _) = cvar
                .wait_timeout_while(state, eof_grace, |state| !state.done)
                .expect("stream reader state poisoned");
            state = next_state;
        }

        let stdio_open_after_exit = !state.done;
        let buf = state.buf.clone();
        let truncated = state.truncated || stdio_open_after_exit;
        drop(state);

        if !stdio_open_after_exit {
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }

        (buf, truncated, stdio_open_after_exit)
    }
}

fn read_stream_with_limit<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
) -> StreamReadHandle {
    let state = Arc::new((Mutex::new(StreamReadState::default()), Condvar::new()));
    let worker_state = Arc::clone(&state);

    let join = std::thread::spawn(move || {
        let mut tmp = [0u8; 8192];
        loop {
            match reader.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    let (lock, _) = &*worker_state;
                    let mut state = lock.lock().expect("stream reader state poisoned");
                    if state.buf.len() < limit {
                        let take = std::cmp::min(limit - state.buf.len(), n);
                        state.buf.extend_from_slice(&tmp[..take]);
                        if take < n {
                            state.truncated = true;
                        }
                    } else {
                        state.truncated = true;
                    }
                    // Keep draining even after truncation to avoid deadlocks on full pipes.
                }
                Err(_) => break,
            }
        }

        let (lock, cvar) = &*worker_state;
        let mut state = lock.lock().expect("stream reader state poisoned");
        state.done = true;
        cvar.notify_all();
    });

    StreamReadHandle {
        state,
        join: Some(join),
    }
}

fn normalize_timeout_ms(timeout_ms: Option<u64>, max_timeout_ms: Option<u64>) -> u64 {
    let max_timeout_ms = max_timeout_ms
        .unwrap_or(MAX_SHELL_TIMEOUT_MS)
        .clamp(MIN_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS);
    timeout_ms
        .unwrap_or(DEFAULT_SHELL_TIMEOUT_MS)
        .clamp(MIN_SHELL_TIMEOUT_MS, max_timeout_ms)
}

fn is_cancelled(cancel_token: Option<&ShellCancelToken>) -> bool {
    cancel_token
        .map(|token| token.is_cancelled())
        .unwrap_or(false)
}

#[cfg(windows)]
fn windows_powershell_command(cmd: &str) -> String {
    [
        "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "$OutputEncoding = [Console]::OutputEncoding",
        // When redirecting to a file, PowerShell's Console.Out is block-buffered by
        // default, so periodic Write-Output/echo from a ManagedProcess does not appear
        // in the log until the process exits.
        "try { [Console]::Out.AutoFlush = $true; [Console]::Error.AutoFlush = $true } catch {}",
        cmd,
    ]
    .join("; ")
}

#[cfg(windows)]
fn windows_cmd_command(cmd: &str) -> String {
    format!("chcp 65001>nul & {cmd}")
}

#[cfg(windows)]
fn normalize_windows_dir_for_compare(p: &Path) -> String {
    strip_windows_verbatim_prefix(p.to_path_buf())
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn windows_dirs_equal(left: &Path, right: &Path) -> bool {
    if normalize_windows_dir_for_compare(left) == normalize_windows_dir_for_compare(right) {
        return true;
    }
    let Ok(left) = fs::canonicalize(left) else {
        return false;
    };
    let Ok(right) = fs::canonicalize(right) else {
        return false;
    };
    normalize_windows_dir_for_compare(&left) == normalize_windows_dir_for_compare(&right)
}

#[cfg(windows)]
fn is_windows_system_bash_alias_dir(dir: &Path) -> bool {
    let Some(root) = std::env::var_os("SystemRoot") else {
        return false;
    };
    ["System32", "Sysnative"]
        .iter()
        .any(|name| windows_dirs_equal(dir, &Path::new(&root).join(name)))
}

#[cfg(windows)]
fn is_windows_apps_alias_dir(dir: &Path) -> bool {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return false;
    };
    windows_dirs_equal(
        dir,
        &Path::new(&local).join("Microsoft").join("WindowsApps"),
    )
}

/// The App-Execution-Alias registered by Store apps is a 0-byte reparse point, and
/// `is_file()` returns true for it; a real Git Bash executable can never be 0 bytes.
#[cfg(windows)]
fn is_app_execution_alias(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|md| md.len() == 0)
}

#[cfg(windows)]
fn is_git_bash_candidate(path: &Path) -> bool {
    if !path.is_file() || is_app_execution_alias(path) {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    !is_windows_system_bash_alias_dir(parent) && !is_windows_apps_alias_dir(parent)
}

#[cfg(windows)]
fn find_git_bash_on_path(path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    for dir in std::env::split_paths(path_var) {
        let candidate = dir.join("bash.exe");
        if is_git_bash_candidate(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Git Bash resolution (matching Claude Code): env override → PATH → Git for Windows default install path.
#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
    for var in ["LIVEAGENT_GIT_BASH_PATH", "CLAUDE_CODE_GIT_BASH_PATH"] {
        if let Ok(raw) = std::env::var(var) {
            let trimmed = raw.trim().trim_matches('"');
            if !trimmed.is_empty() {
                let path = expand_tilde_path(trimmed);
                if is_git_bash_candidate(&path) {
                    return Some(path);
                }
            }
        }
    }

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    if let Some(found) = find_git_bash_on_path(&path_var) {
        return Some(found);
    }

    let roots = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|var| std::env::var_os(var).map(PathBuf::from))
        .chain([
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Program Files (x86)"),
        ]);
    for root in roots {
        // bin\bash.exe is a launcher with MSYS environment injection, preferred over the bare bash in usr\bin.
        for rel in [r"Git\bin\bash.exe", r"Git\usr\bin\bash.exe"] {
            let candidate = root.join(rel);
            if is_git_bash_candidate(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ShellExecutionProfile {
    pub platform: &'static str,
    pub profile: &'static str,
    pub shell_family: &'static str,
    pub display_shell: &'static str,
}

struct ShellCandidate {
    profile: ShellExecutionProfile,
    program: PathBuf,
    args: Vec<String>,
    augment_macos_path: bool,
}

pub(crate) struct SpawnedPlatformShell {
    pub child: std::process::Child,
    pub profile: ShellExecutionProfile,
    /// Effective sandbox mechanism; None means no sandbox is enabled.
    pub sandbox: Option<&'static str>,
}

fn platform_shell_candidates(cmd: &str) -> Vec<ShellCandidate> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Some(bash) = find_git_bash() {
            candidates.push(ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "windows",
                    profile: "windows-git-bash",
                    shell_family: "posix",
                    display_shell: "bash",
                },
                program: bash,
                // Non-login -c: -lc would run /etc/profile and cd $HOME, breaking cwd semantics.
                args: vec!["-c".to_string(), cmd.to_string()],
                augment_macos_path: false,
            });
        }
        let powershell_command = windows_powershell_command(cmd);
        candidates.push(ShellCandidate {
            profile: ShellExecutionProfile {
                platform: "windows",
                profile: "windows-pwsh",
                shell_family: "powershell",
                display_shell: "pwsh",
            },
            program: PathBuf::from("pwsh"),
            args: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                powershell_command.clone(),
            ],
            augment_macos_path: false,
        });
        candidates.push(ShellCandidate {
            profile: ShellExecutionProfile {
                platform: "windows",
                profile: "windows-powershell",
                shell_family: "powershell",
                display_shell: "powershell",
            },
            program: PathBuf::from("powershell.exe"),
            args: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                powershell_command,
            ],
            augment_macos_path: false,
        });
        candidates.push(ShellCandidate {
            profile: ShellExecutionProfile {
                platform: "windows",
                profile: "windows-cmd",
                shell_family: "cmd",
                display_shell: "cmd",
            },
            program: PathBuf::from("cmd.exe"),
            args: vec![
                "/D".to_string(),
                "/S".to_string(),
                "/C".to_string(),
                windows_cmd_command(cmd),
            ],
            augment_macos_path: false,
        });
        return candidates;
    }

    #[cfg(target_os = "macos")]
    {
        vec![
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "macos",
                    profile: "posix-zsh",
                    shell_family: "posix",
                    display_shell: "zsh",
                },
                program: PathBuf::from("zsh"),
                args: vec!["-lc".to_string(), cmd.to_string()],
                augment_macos_path: true,
            },
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "macos",
                    profile: "posix-bash",
                    shell_family: "posix",
                    display_shell: "bash",
                },
                program: PathBuf::from("bash"),
                args: vec!["-lc".to_string(), cmd.to_string()],
                augment_macos_path: true,
            },
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "macos",
                    profile: "posix-sh",
                    shell_family: "posix",
                    display_shell: "sh",
                },
                program: PathBuf::from("sh"),
                args: vec!["-c".to_string(), cmd.to_string()],
                augment_macos_path: true,
            },
        ]
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        vec![
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "linux",
                    profile: "posix-bash",
                    shell_family: "posix",
                    display_shell: "bash",
                },
                program: PathBuf::from("bash"),
                args: vec!["-lc".to_string(), cmd.to_string()],
                augment_macos_path: false,
            },
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "linux",
                    profile: "posix-zsh",
                    shell_family: "posix",
                    display_shell: "zsh",
                },
                program: PathBuf::from("zsh"),
                args: vec!["-lc".to_string(), cmd.to_string()],
                augment_macos_path: false,
            },
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "linux",
                    profile: "posix-sh",
                    shell_family: "posix",
                    display_shell: "sh",
                },
                program: PathBuf::from("sh"),
                args: vec!["-c".to_string(), cmd.to_string()],
                augment_macos_path: false,
            },
        ]
    }
}

#[cfg(test)]
fn default_platform_shell_profile() -> ShellExecutionProfile {
    platform_shell_candidates("")
        .into_iter()
        .next()
        .map(|candidate| candidate.profile)
        .unwrap_or(ShellExecutionProfile {
            platform: "linux",
            profile: "posix-sh",
            shell_family: "posix",
            display_shell: "sh",
        })
}

/// Process-level cache of sandbox shell candidate usability. key = (candidate program
/// path, sandbox mechanism): the same shell may differ in compatibility between the
/// Low IL token and AppContainer mechanisms, so record them separately; probe results
/// are independent of the workspace (loader death comes from token/kernel-object
/// semantics, not paths), so the key excludes write_root.
#[cfg(windows)]
static SANDBOX_SHELL_PROBE_CACHE: std::sync::OnceLock<
    Mutex<HashMap<(PathBuf, &'static str), bool>>,
> = std::sync::OnceLock::new();

/// Exit codes where the child dies immediately on startup and cannot serve as a
/// sandbox shell:
/// - 0xC0000142 DLL initialization failed (the typical way msys/cygwin dies in a sandbox context)
/// - 0xC0000135 DLL not found
/// - 0xC0000022 access denied (NTSTATUS)
/// - 0xE0434352 unhandled CLR exception (PowerShell wraps CNG NTE_PROVIDER_DLL_FAIL as
///   "BCrypt.dll failed to load"; the process already reached the CLR, so it is not an NTSTATUS loader code)
/// - 0x8009001D NTE_PROVIDER_DLL_FAIL itself
/// - 0x80070005 HRESULT E_ACCESSDENIED (Windows PowerShell / .NET Framework failed to
///   write the CLR user cache; a different path from 0xC0000022 / 0xE0434352)
/// - 0xFFFF0000 the wrapper exit code when the PowerShell host fails CLR initialization
///   (inner HRESULT 80070005). Missing these two codes would probe an already-crashed
///   powershell.exe as usable.
///
/// A hit means the candidate cannot start under this sandbox mechanism; fall through
/// to the next candidate.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_loader_failure_exit(code: i32) -> bool {
    matches!(
        code as u32,
        0xC000_0142
            | 0xC000_0135
            | 0xC000_0022
            | 0xE043_4352
            | 0x8009_001D
            | 0x8007_0005
            | 0xFFFF_0000
    )
}

/// Probe verdict: given the probe process's exit code (None = timeout/killed/no exit
/// code), whether the candidate is usable. Only explicit startup-death codes are deemed
/// unusable; everything else (timeout, ordinary non-zero exit) passes through, letting
/// the real spawn fail on its own through the existing error chain — the probe only
/// identifies the "dies immediately on startup" class of hard incompatibility.
#[cfg_attr(not(windows), allow(dead_code))]
fn sandbox_probe_verdict(exit_code: Option<i32>) -> bool {
    !exit_code.is_some_and(is_loader_failure_exit)
}

/// If the first same-named binary on PATH lands in WindowsApps, the sandbox security context cannot launch it directly.
#[cfg(windows)]
fn candidate_resolves_to_windowsapps(program: &Path) -> bool {
    if sandbox::is_msix_windowsapps_path(program) {
        return true;
    }
    let path_env = std::env::var("PATH").unwrap_or_default();
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    sandbox::resolve_program_in_path(program, &path_env, &pathext, &|p| p.is_file())
        .is_some_and(|p| sandbox::is_msix_windowsapps_path(&p))
}

/// Under the Windows sandbox, probe whether a shell candidate survives startup
/// (result cached at process level).
///
/// Spawn a minimal `exit 0` command through the launcher and wait ≤2s: if the exit code
/// hits a startup-death code (Git Bash's 0xC0000142, PowerShell/CNG's 0xE0434352, or the
/// CLR's 0x80070005) ⇒ unusable, and the caller falls through to the next candidate.
/// pwsh/powershell is not necessarily usable under the write fence; cmd.exe does not go
/// through CNG and is usually the last fallback. If the probe itself fails (wrap/spawn
/// error), judge it usable: let the real spawn reproduce the error and go through the
/// existing fail-closed/error-reporting path — the probe does not swallow errors.
#[cfg(windows)]
fn sandbox_candidate_usable(
    spec: &SandboxSpec,
    candidate: &ShellCandidate,
    mechanism: &'static str,
) -> bool {
    use wait_timeout::ChildExt;

    if candidate_resolves_to_windowsapps(&candidate.program) {
        return false;
    }

    let cache = SANDBOX_SHELL_PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (candidate.program.clone(), mechanism);
    if let Ok(map) = cache.lock() {
        if let Some(&usable) = map.get(&key) {
            return usable;
        }
    }

    let probe_args: Vec<String> = match candidate.profile.profile {
        "windows-git-bash" => vec!["-c".to_string(), "exit 0".to_string()],
        "windows-pwsh" | "windows-powershell" => vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            "exit 0".to_string(),
        ],
        _ => vec!["/D".to_string(), "/C".to_string(), "exit 0".to_string()],
    };

    let usable = match sandbox::wrap_command(spec, &candidate.program, &probe_args) {
        Ok((program, args, _)) => {
            let exit_code = Command::new(&program)
                .args(&args)
                .current_dir(&spec.write_root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()
                .and_then(
                    |mut child| match child.wait_timeout(Duration::from_secs(2)) {
                        Ok(Some(status)) => status.code(),
                        _ => {
                            let _ = child.kill();
                            let _ = child.wait();
                            None
                        }
                    },
                );
            sandbox_probe_verdict(exit_code)
        }
        Err(_) => true,
    };
    if let Ok(mut map) = cache.lock() {
        map.insert(key, usable);
    }
    usable
}

/// `stdbuf` on Git Bash usually lives in `Git\usr\bin`, a different directory from `Git\bin\bash.exe`.
fn find_stdbuf_near(shell: &Path) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["stdbuf.exe", "stdbuf"]
    } else {
        &["stdbuf"]
    };
    let mut dirs = Vec::new();
    if let Some(parent) = shell.parent().filter(|p| !p.as_os_str().is_empty()) {
        dirs.push(parent.to_path_buf());
        dirs.push(parent.join("usr").join("bin"));
        if let Some(grand) = parent.parent() {
            dirs.push(grand.join("usr").join("bin"));
        }
    }
    dirs.push(PathBuf::from("/usr/bin"));
    dirs.push(PathBuf::from("/bin"));
    for dir in dirs {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Quote a string for POSIX `sh` single quotes so it can be embedded in `-c`.
fn posix_single_quote(value: &str) -> String {
    let mut out = String::from("'");
    let mut first = true;
    for part in value.split('\'') {
        if !first {
            out.push_str("'\\''");
        }
        first = false;
        out.push_str(part);
    }
    out.push('\'');
    out
}

fn path_for_posix_shell(path: &Path) -> String {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        let trimmed = raw.trim().trim_start_matches(r"\\?\");
        let bytes = trimmed.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' {
            let drive = (bytes[0] as char).to_ascii_lowercase();
            let rest = trimmed[2..].replace('\\', "/");
            return format!("/{drive}{rest}");
        }
        trimmed.replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

/// POSIX managed processes are wrapped in a `stdbuf -oL` layer so periodic output such
/// as an echo loop remains line-visible when redirected to a log file. The image is
/// still bash/zsh/sh, so only the Windows sandbox's Everyone SID / msys stamp for Git
/// Bash keeps matching.
fn posix_line_buffered_script(
    shell: &str,
    command: &str,
    stdbuf: Option<&Path>,
    log_path: Option<&Path>,
) -> String {
    let quoted = posix_single_quote(command);
    let redirect = log_path
        .map(|path| {
            format!(
                " >> {} 2>&1",
                posix_single_quote(&path_for_posix_shell(path))
            )
        })
        .unwrap_or_default();
    if let Some(stdbuf) = stdbuf {
        let stdbuf_q = posix_single_quote(&path_for_posix_shell(stdbuf));
        return format!("exec {stdbuf_q} -oL -eL {shell} -c {quoted}{redirect}");
    }
    format!(
        "if command -v stdbuf >/dev/null 2>&1; then exec stdbuf -oL -eL {shell} -c {quoted}{redirect}; fi\n{{ {command}; }}{redirect}"
    )
}

fn apply_line_buffered_stdio(
    command: &str,
    candidate: &ShellCandidate,
    log_path: Option<&Path>,
) -> (Vec<String>, Vec<(String, String)>) {
    let mut args = candidate.args.clone();
    let extra_envs = vec![("PYTHONUNBUFFERED".to_string(), "1".to_string())];
    if candidate.profile.shell_family == "posix" {
        let stdbuf = find_stdbuf_near(&candidate.program);
        if let Some(script) = args.last_mut() {
            *script = posix_line_buffered_script(
                candidate.profile.display_shell,
                command,
                stdbuf.as_deref(),
                log_path,
            );
        }
    }
    (args, extra_envs)
}

pub(crate) fn spawn_platform_shell_command<F>(
    command: &str,
    cwd: &Path,
    envs: &[(String, String)],
    sandbox_spec: Option<&SandboxSpec>,
    line_buffered: bool,
    log_path: Option<&Path>,
    mut stdio_factory: F,
) -> Result<SpawnedPlatformShell, String>
where
    F: FnMut() -> io::Result<(Stdio, Stdio)>,
{
    let mut errors: Vec<String> = Vec::new();
    let system_proxy_envs = crate::services::system_proxy::shell_proxy_envs()?;

    for candidate in platform_shell_candidates(command) {
        let (candidate_args, extra_envs) = if line_buffered {
            apply_line_buffered_stdio(command, &candidate, log_path)
        } else {
            (candidate.args.clone(), Vec::new())
        };
        // Sandbox wrapping happens after the shell candidate is chosen and before
        // spawn, fail-closed: a wrapping failure (unsupported platform / missing
        // dependency) errors out directly and never falls back to unsandboxed
        // execution. sandbox-exec/bwrap resolving the shell by name also follows PATH,
        // so the semantics are unchanged.
        let (spawn_program, spawn_args, sandbox_mechanism) = match sandbox_spec {
            Some(spec) => {
                let (program, args, mechanism) =
                    sandbox::wrap_command(spec, &candidate.program, &candidate_args)?;
                (program, args, Some(mechanism))
            }
            None => (candidate.program.clone(), candidate_args, None),
        };
        // Windows sandbox only: the candidate fallback chain normally advances on spawn
        // failure, but under the sandbox spawn always launches the ReactorPro.exe
        // launcher (which always succeeds), so loader-level incompatibility (e.g. Git
        // Bash's msys dependency failing with 0xC0000142 in a sandbox context) only
        // shows up as the command "ran but died immediately". A cached probe (`exit 0`)
        // detects this early and falls through to the next candidate, rather than
        // returning a dead shell to the model. pwsh also crashes with CLR 0xE0434352
        // inside the sandbox because the CNG user certificate store is not writable, so
        // one must not assume "a native PE is necessarily usable".
        #[cfg(windows)]
        if let (Some(spec), Some(mechanism)) = (sandbox_spec, sandbox_mechanism) {
            if !sandbox_candidate_usable(spec, &candidate, mechanism) {
                errors.push(format!(
                    "{} ({}) skipped: incompatible with the {mechanism} sandbox (startup \
                     failure under the sandbox security context, e.g. STATUS_DLL_INIT_FAILED, CLR \
                     0xE0434352 / 0xFFFF0000, or HRESULT 0x80070005)",
                    candidate.profile.profile, candidate.profile.display_shell
                ));
                continue;
            }
        }
        let (stdout, stderr) =
            stdio_factory().map_err(|err| format!("Failed to prepare shell stdio: {err}"))?;
        let mut c = Command::new(&spawn_program);
        c.args(&spawn_args);
        // Inject the system-proxy env first; caller envs (e.g. LIVEAGENT_HOOK_*) are written afterwards to keep higher priority.
        for (key, value) in &system_proxy_envs {
            c.env(key, value);
        }
        c.envs(
            envs.iter()
                .chain(extra_envs.iter())
                .map(|(key, value)| (key.as_str(), value.as_str())),
        );
        if candidate.augment_macos_path {
            maybe_augment_macos_path(&mut c);
        }
        configure_child_process_group(&mut c);
        let spawn_result = c
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn();

        match spawn_result {
            Ok(child) => {
                return Ok(SpawnedPlatformShell {
                    child,
                    profile: candidate.profile,
                    sandbox: sandbox_mechanism,
                });
            }
            Err(err) => errors.push(format!(
                "{} ({}) failed: {err}",
                candidate.profile.profile, candidate.profile.display_shell
            )),
        }
    }

    let detail = if errors.is_empty() {
        "no shell candidates were available".to_string()
    } else {
        errors.join("; ")
    };
    Err(ShellError::Other(format!("Failed to start command: {detail}")).to_string())
}

/// Simplest entry point with no env injection and no sandbox. The production path always
/// goes through `run_shell_script_with_envs` and passes the sandbox parameter explicitly
/// (P1#2: Cron used to always execute unsandboxed because of the `None` here), so this
/// entry point is for tests only.
#[cfg(test)]
pub(crate) fn run_shell_script(
    workdir: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_timeout_ms: Option<u64>,
    provider_id: Option<String>,
    cancel_token: Option<ShellCancelToken>,
) -> Result<ShellRunResponse, String> {
    run_shell_script_with_envs(
        workdir,
        command,
        cwd,
        timeout_ms,
        max_timeout_ms,
        provider_id,
        cancel_token,
        &[],
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_shell_script_with_envs(
    workdir: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_timeout_ms: Option<u64>,
    _provider_id: Option<String>,
    cancel_token: Option<ShellCancelToken>,
    envs: &[(String, String)],
    sandbox_options: Option<SandboxOptions>,
) -> Result<ShellRunResponse, String> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Err(ShellError::Other("command cannot be empty".to_string()).to_string());
    }

    let actual_cwd = resolve_shell_cwd(&workdir, cwd.as_deref())?;

    let effective_timeout_ms = normalize_timeout_ms(timeout_ms, max_timeout_ms);
    let timeout = Duration::from_millis(effective_timeout_ms);
    let start = Instant::now();

    // The sandbox write fence anchors on workdir (the workspace root) rather than cwd:
    // cwd may be a subdirectory, but the tool semantics allow writing the whole workspace.
    let sandbox_spec = match sandbox_options {
        Some(options) => {
            let wd = canonicalize_workdir(&workdir).map_err(|e| e.to_string())?;
            Some(SandboxSpec::from_options(wd, options))
        }
        None => None,
    };
    let spawned = spawn_platform_shell_command(
        cmd,
        &actual_cwd,
        envs,
        sandbox_spec.as_ref(),
        false,
        None,
        || Ok((Stdio::piped(), Stdio::piped())),
    )?;
    let mut child = spawned.child;
    let shell_profile = spawned.profile;
    let sandbox_mechanism = spawned.sandbox;
    let shell_name = shell_basename(shell_profile.display_shell);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ShellError::Other("Failed to capture stdout".to_string()).to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ShellError::Other("Failed to capture stderr".to_string()).to_string())?;

    let out_handle = read_stream_with_limit(stdout, MAX_STDOUT_BYTES);
    let err_handle = read_stream_with_limit(stderr, MAX_STDERR_BYTES);

    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        if let Some(s) = child
            .try_wait()
            .map_err(|e| ShellError::Io(e).to_string())?
        {
            break s;
        }

        if is_cancelled(cancel_token.as_ref()) {
            cancelled = true;
            break terminate_child_process_tree(
                &mut child,
                Duration::from_millis(TERMINATION_GRACE_MS),
            )
            .map_err(|e| ShellError::Io(e).to_string())?;
        }

        if start.elapsed() >= timeout {
            timed_out = true;
            break terminate_child_process_tree(
                &mut child,
                Duration::from_millis(TERMINATION_GRACE_MS),
            )
            .map_err(|e| ShellError::Io(e).to_string())?;
        }

        std::thread::sleep(Duration::from_millis(50));
    };

    let duration_ms = start.elapsed().as_millis();

    let stream_eof_grace = Duration::from_millis(STREAM_EOF_GRACE_MS);
    let (stdout_bytes, stdout_truncated, stdout_open_after_exit) =
        out_handle.finish(stream_eof_grace);
    let (stderr_bytes, stderr_truncated, stderr_open_after_exit) =
        err_handle.finish(stream_eof_grace);
    let stdio_open_after_exit = stdout_open_after_exit || stderr_open_after_exit;

    let stdout_str = String::from_utf8_lossy(&stdout_bytes).to_string();
    let mut stderr_str = String::from_utf8_lossy(&stderr_bytes).to_string();

    if stdio_open_after_exit {
        if !stderr_str.is_empty() && !stderr_str.ends_with('\n') {
            stderr_str.push('\n');
        }
        if shell_profile.platform == "windows" {
            stderr_str.push_str(
                "ReactorPro warning: command exited, but stdout/stderr remained open after exit. \
This usually means a background process inherited the tool pipes. Use ManagedProcess for \
long-running Windows commands so ReactorPro can capture logs and stop the process tree.",
            );
        } else {
            stderr_str.push_str(
                "ReactorPro warning: command exited, but stdout/stderr remained open after exit. \
This usually means a background process inherited the tool pipes. Redirect long-running \
process output to a log file, for example: `nohup command > /tmp/liveagent-task.log 2>&1 < /dev/null &`.",
            );
        }
    }

    Ok(ShellRunResponse {
        exit_code: status.code().unwrap_or(-1),
        shell: shell_name,
        platform: shell_profile.platform.to_string(),
        profile: shell_profile.profile.to_string(),
        shell_family: shell_profile.shell_family.to_string(),
        sandbox: sandbox_mechanism.map(str::to_string),
        stdout: stdout_str,
        stderr: stderr_str,
        stdout_truncated,
        stderr_truncated,
        timed_out,
        cancelled,
        stdio_open_after_exit,
        effective_timeout_ms,
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        default_platform_shell_profile, is_loader_failure_exit, normalize_timeout_ms,
        run_shell_script, sandbox_probe_verdict, sanitize_rel_path_core, ShellRunRegistry,
        DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS, MIN_SHELL_TIMEOUT_MS,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    // Verdict logic for sandbox candidate probing (a pure, platform-independent function):
    // only startup-death codes are deemed unusable; timeout/ordinary failures pass through
    // to the real spawn and the existing error chain.
    #[test]
    fn sandbox_probe_verdict_only_rejects_loader_ntstatus() {
        // The three loader-death codes (negative once cast to i32, matching std ExitStatus::code()).
        assert!(is_loader_failure_exit(0xC000_0142_u32 as i32)); // STATUS_DLL_INIT_FAILED
        assert!(is_loader_failure_exit(0xC000_0135_u32 as i32)); // STATUS_DLL_NOT_FOUND
        assert!(is_loader_failure_exit(0xC000_0022_u32 as i32)); // STATUS_ACCESS_DENIED
        assert!(!sandbox_probe_verdict(Some(0xC000_0142_u32 as i32)));
        // PowerShell/CNG: the BCrypt "load failure" is actually an unhandled CLR exception, not NTSTATUS.
        assert_eq!((-532_462_766i32) as u32, 0xE043_4352);
        assert!(is_loader_failure_exit(-532_462_766));
        assert!(!sandbox_probe_verdict(Some(-532_462_766)));
        assert!(is_loader_failure_exit(0x8009_001D_u32 as i32)); // NTE_PROVIDER_DLL_FAIL
        assert!(!sandbox_probe_verdict(Some(0x8009_001D_u32 as i32)));
        // Windows PowerShell / .NET Framework: the CLR user-cache write denial is an HRESULT, not NTSTATUS.
        assert_eq!((-2_147_024_891i32) as u32, 0x8007_0005);
        assert!(is_loader_failure_exit(-2_147_024_891));
        assert!(!sandbox_probe_verdict(Some(-2_147_024_891)));
        // The PowerShell host wraps CLR 80070005 as 0xFFFF0000 (-65536).
        assert_eq!((-65536i32) as u32, 0xFFFF_0000);
        assert!(is_loader_failure_exit(-65536));
        assert!(!sandbox_probe_verdict(Some(-65536)));
        // Normal exit, ordinary failure, other NTSTATUS codes, and timeout (None) do not constitute "candidate unusable".
        assert!(sandbox_probe_verdict(Some(0)));
        assert!(sandbox_probe_verdict(Some(1)));
        assert!(sandbox_probe_verdict(Some(127)));
        assert!(sandbox_probe_verdict(Some(0xC000_0005_u32 as i32))); // ACCESS_VIOLATION: a runtime crash, not startup death
        assert!(sandbox_probe_verdict(None));
    }

    #[test]
    fn sanitize_rel_path_accepts_windows_style_separators() {
        assert_eq!(
            sanitize_rel_path_core(r"src\tauri\commands").unwrap(),
            Some(PathBuf::from("src").join("tauri").join("commands"))
        );
    }

    #[test]
    fn sanitize_rel_path_rejects_parent_and_absolute_segments() {
        for value in ["../x", "a/../x", "/tmp", r"C:\tmp", "file.txt:stream"] {
            assert!(sanitize_rel_path_core(value).is_err(), "{value}");
        }
    }

    #[test]
    fn sanitize_rel_path_core_treats_dot_as_root() {
        assert_eq!(sanitize_rel_path_core(".").unwrap(), None);
        assert_eq!(sanitize_rel_path_core("./").unwrap(), None);
    }

    #[test]
    fn normalize_timeout_ms_clamps_to_supported_range() {
        assert_eq!(normalize_timeout_ms(None, None), DEFAULT_SHELL_TIMEOUT_MS);
        assert_eq!(normalize_timeout_ms(Some(1), None), MIN_SHELL_TIMEOUT_MS);
        assert_eq!(
            normalize_timeout_ms(Some(1_800_000), None),
            MAX_SHELL_TIMEOUT_MS,
        );
        assert_eq!(normalize_timeout_ms(Some(1_800_000), Some(30_000)), 30_000,);
    }

    #[test]
    fn default_platform_shell_profile_matches_current_os() {
        let profile = default_platform_shell_profile();
        if cfg!(windows) {
            assert_eq!(profile.platform, "windows");
            // The first candidate depends on whether Git Bash is installed on the test machine.
            match profile.profile {
                "windows-git-bash" => assert_eq!(profile.shell_family, "posix"),
                "windows-pwsh" => assert_eq!(profile.shell_family, "powershell"),
                other => panic!("unexpected windows profile: {other}"),
            }
        } else if cfg!(target_os = "macos") {
            assert_eq!(profile.platform, "macos");
            assert_eq!(profile.profile, "posix-zsh");
            assert_eq!(profile.shell_family, "posix");
        } else {
            assert_eq!(profile.platform, "linux");
            assert_eq!(profile.profile, "posix-bash");
            assert_eq!(profile.shell_family, "posix");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_chain_orders_git_bash_before_powershell_fallbacks() {
        let profiles: Vec<&'static str> = super::platform_shell_candidates("echo hi")
            .iter()
            .map(|candidate| candidate.profile.profile)
            .collect();
        let tail = ["windows-pwsh", "windows-powershell", "windows-cmd"];
        match profiles.len() {
            4 => {
                assert_eq!(profiles[0], "windows-git-bash");
                assert_eq!(profiles[1..], tail);
            }
            3 => assert_eq!(profiles[..], tail),
            other => panic!("unexpected windows candidate count: {other}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_scan_skips_zero_byte_app_execution_alias() {
        // The WindowsApps WSL bash.exe alias is a 0-byte reparse point; use a 0-byte
        // regular file to simulate the shape "is_file() is true but it is not real bash".
        let alias_dir = tempfile::tempdir().expect("alias dir");
        let real_dir = tempfile::tempdir().expect("real dir");
        fs::write(alias_dir.path().join("bash.exe"), b"").unwrap();
        fs::write(real_dir.path().join("bash.exe"), b"MZfake-git-bash").unwrap();

        // The alias directory comes first: it should skip the 0-byte candidate and hit the real file after it.
        let path_var =
            std::env::join_paths([alias_dir.path(), real_dir.path()]).expect("join paths");
        assert_eq!(
            super::find_git_bash_on_path(&path_var),
            Some(real_dir.path().join("bash.exe"))
        );

        // With only the alias present it should not be chosen by mistake; the candidate chain falls back to the Program Files probe / PowerShell.
        let alias_only = std::env::join_paths([alias_dir.path()]).expect("join paths");
        assert_eq!(super::find_git_bash_on_path(&alias_only), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_known_wsl_alias_dirs_are_rejected() {
        // Even if a non-0-byte bash.exe appears under the WindowsApps directory, it must not be selected from there.
        let local_appdata = std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA");
        let windows_apps = std::path::Path::new(&local_appdata)
            .join("Microsoft")
            .join("WindowsApps");
        assert!(super::is_windows_apps_alias_dir(&windows_apps));
        // Case and trailing slashes do not affect the decision.
        let with_slash = format!("{}\\", windows_apps.display().to_string().to_uppercase());
        assert!(super::is_windows_apps_alias_dir(std::path::Path::new(
            &with_slash
        )));

        let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
        for name in ["System32", "Sysnative"] {
            let alias_dir = std::path::Path::new(&system_root).join(name);
            assert!(super::is_windows_system_bash_alias_dir(&alias_dir));
        }
    }

    #[cfg(windows)]
    #[test]
    fn find_git_bash_env_override_prefers_liveagent_var() {
        // A single test function covers all env scenarios serially, avoiding parallel env races.
        let dir = tempfile::tempdir().expect("tempdir");
        let liveagent_bash = dir.path().join("liveagent-bash.exe");
        let claude_bash = dir.path().join("claude-bash.exe");
        let app_execution_alias = dir.path().join("wsl-bash.exe");
        fs::write(&liveagent_bash, b"MZliveagent-git-bash").unwrap();
        fs::write(&claude_bash, b"MZclaude-git-bash").unwrap();
        fs::write(&app_execution_alias, b"").unwrap();

        std::env::set_var("LIVEAGENT_GIT_BASH_PATH", &liveagent_bash);
        std::env::set_var("CLAUDE_CODE_GIT_BASH_PATH", &claude_bash);
        assert_eq!(super::find_git_bash(), Some(liveagent_bash.clone()));

        // When LIVEAGENT points at an App-Execution-Alias it must also fall back to CLAUDE_CODE.
        std::env::set_var("LIVEAGENT_GIT_BASH_PATH", &app_execution_alias);
        assert_eq!(super::find_git_bash(), Some(claude_bash.clone()));

        // When LIVEAGENT points at a nonexistent file it falls back to CLAUDE_CODE.
        std::env::set_var(
            "LIVEAGENT_GIT_BASH_PATH",
            dir.path().join("missing-bash.exe"),
        );
        assert_eq!(super::find_git_bash(), Some(claude_bash.clone()));

        std::env::remove_var("LIVEAGENT_GIT_BASH_PATH");
        std::env::remove_var("CLAUDE_CODE_GIT_BASH_PATH");
    }

    #[test]
    fn shell_registry_cancel_marks_registered_run() {
        let registry = ShellRunRegistry::default();
        let token = registry.register("run-1");
        assert!(!token.is_cancelled());
        assert!(registry.cancel("run-1"));
        assert!(token.is_cancelled());
        registry.unregister("run-1", &token);
        assert!(!registry.cancel("run-1"));
    }

    #[test]
    fn duplicate_run_id_cancels_old_token_without_losing_new_registration() {
        let registry = ShellRunRegistry::default();
        let first = registry.register("same-run");
        let second = registry.register("same-run");

        assert!(first.is_cancelled());
        registry.unregister("same-run", &first);
        assert!(registry.cancel("same-run"));
        assert!(second.is_cancelled());

        registry.unregister("same-run", &second);
        assert!(!registry.cancel("same-run"));
    }

    #[cfg(unix)]
    #[test]
    fn run_shell_script_can_be_cancelled_before_timeout() {
        let registry = ShellRunRegistry::default();
        let token = registry.register("cancel-test");
        let temp_dir = std::env::temp_dir().join(format!(
            "liveagent-shell-cancel-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&temp_dir);

        let worker_token = Arc::clone(&token);
        let workdir = temp_dir.display().to_string();
        let started = Instant::now();
        let handle = std::thread::spawn(move || {
            run_shell_script(
                workdir,
                "sleep 10".to_string(),
                None,
                Some(60_000),
                None,
                None,
                Some(worker_token),
            )
        });

        std::thread::sleep(Duration::from_millis(150));
        assert!(registry.cancel("cancel-test"));
        let result = handle
            .join()
            .expect("shell cancel worker thread should not panic")
            .expect("shell run should return a cancelled response");

        registry.unregister("cancel-test", &token);
        let _ = fs::remove_dir_all(&temp_dir);

        assert!(result.cancelled);
        assert!(!result.timed_out);
        assert!(!result.stdio_open_after_exit);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancelled shell should return promptly"
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_shell_script_returns_when_background_process_keeps_stdio_open() {
        let temp_dir = std::env::temp_dir().join(format!(
            "liveagent-shell-background-stdio-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&temp_dir);

        let started = Instant::now();
        let result = run_shell_script(
            temp_dir.display().to_string(),
            "sleep 15 & background_pid=$!; echo ready:$background_pid".to_string(),
            None,
            Some(60_000),
            None,
            None,
            None,
        )
        .expect("shell run should return a response");
        let elapsed = started.elapsed();
        let background_pid = result
            .stdout
            .lines()
            .find_map(|line| line.strip_prefix("ready:"))
            .expect("shell should report the background process id")
            .trim();
        let _ = std::process::Command::new("kill")
            .arg(background_pid)
            .status();

        let _ = fs::remove_dir_all(&temp_dir);

        assert_eq!(result.exit_code, 0);
        assert!(result.stdio_open_after_exit);
        assert!(result.stdout.contains("ready:"));
        assert!(result.stderr.contains("stdout/stderr remained open"));
        assert!(
            elapsed < Duration::from_secs(10),
            "background stdio leak should not block until the background process exits; elapsed: {elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_shell_script_accepts_absolute_cwd_outside_workdir() {
        let workdir = std::env::temp_dir().join(format!(
            "liveagent-shell-abs-cwd-workdir-{}",
            std::process::id()
        ));
        let external = std::env::temp_dir().join(format!(
            "liveagent-shell-abs-cwd-external-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&workdir);
        let _ = fs::create_dir_all(&external);
        let external_canonical = fs::canonicalize(&external).expect("canonical external dir");

        let result = run_shell_script(
            workdir.display().to_string(),
            "pwd".to_string(),
            Some(external.display().to_string()),
            Some(30_000),
            None,
            None,
            None,
        )
        .expect("absolute cwd should run");

        assert_eq!(result.exit_code, 0);
        assert!(
            result
                .stdout
                .contains(&external_canonical.display().to_string()),
            "unexpected stdout: {}",
            result.stdout
        );

        let _ = fs::remove_dir_all(&workdir);
        let _ = fs::remove_dir_all(&external);
    }

    #[test]
    fn run_shell_script_rejects_missing_absolute_cwd() {
        let workdir = std::env::temp_dir().join(format!(
            "liveagent-shell-abs-cwd-missing-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&workdir);
        let missing = std::env::temp_dir()
            .join(format!("liveagent-missing-cwd-{}", std::process::id()))
            .join("nope");

        let error = run_shell_script(
            workdir.display().to_string(),
            "echo hi".to_string(),
            Some(missing.display().to_string()),
            Some(30_000),
            None,
            None,
            None,
        )
        .expect_err("missing absolute cwd should fail");

        assert!(
            error.contains("cwd does not exist or is not a directory"),
            "unexpected error: {error}"
        );

        let _ = fs::remove_dir_all(&workdir);
    }

    #[test]
    fn posix_line_buffered_script_embeds_quoted_command_and_stdbuf() {
        let stdbuf = PathBuf::from(r"C:\Program Files\Git\usr\bin\stdbuf.exe");
        let log_path = PathBuf::from(r"C:\Users\me\.liveagent\process-logs\proc.log");
        let script = super::posix_line_buffered_script(
            "bash",
            "echo ready; sleep 1",
            Some(stdbuf.as_path()),
            Some(log_path.as_path()),
        );
        assert!(script.contains("stdbuf.exe"));
        assert!(script.contains("-oL -eL bash -c"));
        assert!(script.contains("'echo ready; sleep 1'"));
        assert!(script.contains(" >> "));
        #[cfg(windows)]
        {
            assert!(script.contains("/c/Program Files/Git/usr/bin/stdbuf.exe"));
            assert!(script.contains("/c/Users/me/.liveagent/process-logs/proc.log"));
        }
    }
}
