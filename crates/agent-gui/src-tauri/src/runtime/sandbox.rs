//! OS-level sandbox (sandbox mode v1): before model-driven Bash / ManagedProcess spawns a child process
//! it is wrapped by the platform-native mechanism — macOS uses Seatbelt (/usr/bin/sandbox-exec), Linux uses
//! bubblewrap (bwrap), Windows networked mode uses a Low Integrity primary token, offline mode uses
//! AppContainer (both with a workspace write fence + Job Object, admin-free / UAC-free).
//!
//! Semantics are workspace-write: reads are allowed by default (toolchains/dependencies are scattered across the whole disk, so default-deny is unrealistic),
//! writes are limited to the workspace root + temp directories, sensitive directories (~/.ssh, the app config store, etc.) are fully masked for read and write, and the network can
//! be disabled entirely. fail-closed: when a sandbox is requested but the platform mechanism is unavailable it errors out directly, and never silently degrades to
//! unsandboxed execution.
//!
//! Windows dual backend (both admin-free / UAC-free, see memory windows-sandbox-facts):
//! - sandbox (networked): a copy of the current user's primary token lowered to Low IL, with network capability identical to an unsandboxed process;
//!   the workspace/TEMP are also marked Low, and writes are fenced by MIC NoWriteUp.
//! - sandboxOffline (network cut): AppContainer (zero capability). Because WFP denies all network access by default for an AppContainer without
//!   network capability, including loopback => kernel-level network cutoff with no elevation required (compare
//!   Codex: unelevated is only an env-level soft cutoff; a hard cutoff requires elevation to create a dedicated account + firewall). AC by default
//!   denies unauthorized reads; system directories are readable via their bundled ALL APPLICATION PACKAGES ACE, and the user home directory is
//!   unreadable by default => the offline variant incidentally gains sensitive-directory read masking; tighter reads are acceptable for offline scenarios.

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// Self-reexec launcher subcommand marker: on Windows `wrap_command` wraps (program, args) as
/// `current_exe __sandbox_exec --write-root <root> --net on|off [--isolated] -- <program> <args...>`;
/// the earliest stage of process startup `windows_sandbox::run_sandbox_launcher_if_requested` recognizes it,
/// then builds a Low IL primary token (networked) or AppContainer (offline) according to --net before executing the real command.
/// Non-Windows platforms never produce this marker.
pub(crate) const SANDBOX_EXEC_SUBCOMMAND: &str = "__sandbox_exec";

/// Invocation info after the launcher parses it (pure logic, cross-platform testable).
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LauncherInvocation {
    pub write_root: PathBuf,
    /// Whether the network is allowed determines the backend: true -> Low IL primary token (networked), false -> AppContainer (offline).
    pub allow_network: bool,
    /// An isolated long-running process must survive the launcher's death => the launcher must not attach
    /// a KILL_ON_JOB_CLOSE Job Object to the child (matching Linux bwrap omitting --die-with-parent).
    pub isolated: bool,
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Build the argument vector passed to the self-reexec launcher (including the subcommand marker, as argv[1]).
/// Of the form `[__sandbox_exec, --write-root, <root>, --net, on|off, [--isolated,] --, <program>, <args...>]`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn build_launcher_args(
    write_root: &Path,
    allow_network: bool,
    isolated: bool,
    program: &Path,
    args: &[String],
) -> Vec<String> {
    let mut out = vec![
        SANDBOX_EXEC_SUBCOMMAND.to_string(),
        "--write-root".to_string(),
        write_root.to_string_lossy().into_owned(),
        "--net".to_string(),
        if allow_network { "on" } else { "off" }.to_string(),
    ];
    if isolated {
        out.push("--isolated".to_string());
    }
    out.push("--".to_string());
    out.push(program.to_string_lossy().into_owned());
    out.extend(args.iter().cloned());
    out
}

/// Parse the launcher payload (the part after the subcommand marker):
/// `--write-root <root> --net on|off [--isolated] -- <program> [args...]`.
/// `--net` is required: construction and parsing are the same version (self-reexec of the same exe), so there is no legacy-format compatibility issue;
/// missing it is rejected outright and never implicitly defaults to a backend.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn parse_launcher_args(payload: &[String]) -> Result<LauncherInvocation, String> {
    let mut it = payload.iter();
    let mut write_root: Option<PathBuf> = None;
    let mut allow_network: Option<bool> = None;
    let mut isolated = false;
    let mut program: Option<PathBuf> = None;
    let mut rest: Vec<String> = Vec::new();
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--write-root" => {
                let value = it
                    .next()
                    .ok_or_else(|| "--write-root requires a value".to_string())?;
                write_root = Some(PathBuf::from(value));
            }
            "--net" => {
                let value = it
                    .next()
                    .ok_or_else(|| "--net requires a value".to_string())?;
                allow_network = Some(match value.as_str() {
                    "on" => true,
                    "off" => false,
                    other => return Err(format!("--net expects on|off, got: {other}")),
                });
            }
            "--isolated" => isolated = true,
            "--" => {
                program = it.next().map(PathBuf::from);
                rest = it.cloned().collect();
                break;
            }
            other => return Err(format!("unexpected launcher argument: {other}")),
        }
    }
    let write_root = write_root.ok_or_else(|| "missing --write-root".to_string())?;
    let allow_network = allow_network.ok_or_else(|| "missing --net on|off".to_string())?;
    let program = program.ok_or_else(|| "missing program after `--`".to_string())?;
    Ok(LauncherInvocation {
        write_root,
        allow_network,
        isolated,
        program,
        args: rest,
    })
}

/// Deterministically derive a synthetic SID from the workspace canonical path (Codex form `S-1-5-21-{4×u32}`).
/// Stable + stateless: the same path always yields the same SID — legacy inherited ACEs still match exactly on the next run,
/// with no persistence needed. Uses stable FNV-1a (not DefaultHasher, whose algorithm is not guaranteed stable across versions).
/// Windows paths are case-insensitive, so lowercase before hashing: `C:\Foo` and `c:\foo` yield the same SID.
/// Edge case: Rust's Unicode lowercasing and Windows' upcase folding (e.g. dotted/dotless I, ß)
/// are not fully consistent, so the two cases of a non-ASCII workspace path may yield different SIDs, causing legacy inherited ACEs to mismatch
/// -> writes rejected. This is fail-closed (reduced functionality, not an escape), and ASCII paths are unaffected.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn synthetic_workspace_sid(write_root: &Path) -> String {
    fn fnv1a64(bytes: &[u8]) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for &b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }
    let canonical = write_root.to_string_lossy().to_lowercase();
    let h1 = fnv1a64(canonical.as_bytes());
    // A second hash mixes in salt to produce an independent low 64 bits, filling the 4×u32 sub-authorities.
    let mut salted = canonical.into_bytes();
    salted.push(0);
    salted.extend_from_slice(b"liveagent-sandbox");
    let h2 = fnv1a64(&salted);
    let a = (h1 >> 32) as u32;
    let b = h1 as u32;
    let c = (h2 >> 32) as u32;
    let d = h2 as u32;
    format!("S-1-5-21-{a}-{b}-{c}-{d}")
}

/// Assemble a command line per Windows (CommandLineToArgvW) rules, NUL-terminated as UTF-16.
/// The algorithm replicates Rust std's `make_command_line`/`append_arg` verbatim, so that under a Low IL token
/// `CreateProcessAsUserW`'s child receives exactly the same argv as an unsandboxed `std::process::Command`
/// — behavior aligned, no parsing discrepancies introduced. Pure logic, cross-platform testable.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn build_command_line(program: &str, args: &[String]) -> Vec<u16> {
    fn append_arg(cmd: &mut Vec<u16>, arg: &str) {
        let arg: Vec<u16> = arg.encode_utf16().collect();
        let space = u16::from(b' ');
        let tab = u16::from(b'\t');
        let quote = u16::from(b'"');
        let backslash = u16::from(b'\\');
        let needs_quote = arg.is_empty() || arg.iter().any(|&c| c == space || c == tab);
        if needs_quote {
            cmd.push(quote);
        }
        let mut backslashes: usize = 0;
        for &w in &arg {
            if w == backslash {
                backslashes += 1;
            } else {
                if w == quote {
                    // Double the backslashes before a ", then add one more, and finally the escaped ".
                    for _ in 0..=backslashes {
                        cmd.push(backslash);
                    }
                }
                backslashes = 0;
            }
            cmd.push(w);
        }
        if needs_quote {
            for _ in 0..backslashes {
                cmd.push(backslash);
            }
            cmd.push(quote);
        }
    }

    let mut cmd: Vec<u16> = Vec::new();
    append_arg(&mut cmd, program);
    for a in args {
        cmd.push(u16::from(b' '));
        append_arg(&mut cmd, a);
    }
    cmd.push(0);
    cmd
}

/// Resolve a bare program name to an absolute path in PATH (Windows semantics: `;`-separated, applies PATHEXT),
/// **searching only absolute directories in PATH, never the current/working directory**.
///
/// Rationale: if `CreateProcessAsUserW`'s `lpApplicationName` is a "partial name", Win32 only completes it with the current
/// drive + current directory and **does not consult PATH** (see the CreateProcess docs). The sandbox launcher's cwd is the
/// workspace (model-writable), so a bare name `cmd.exe` could be completed inside the workspace: at best it is not found and the whole thing fails, at worst
/// it hits a same-named binary poisoned by the model and is executed as a shell. So here we pre-resolve to the system shell's absolute path
/// and strip relative entries from PATH (including `"."`), so that even if the user's PATH contains `.` it cannot fall back into the workspace.
///
/// Absolute-path inputs are returned as-is. Pure logic; the `is_file` predicate is injected for cross-platform unit tests (Windows path semantics
/// are compiled+verified on Windows on real hardware; `is_absolute`/`join` follow Unix rules on this host).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn resolve_program_in_path(
    program: &Path,
    path_env: &str,
    pathext: &str,
    is_file: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if program.is_absolute() {
        return Some(program.to_path_buf());
    }
    let name = program.as_os_str();
    // Candidate extensions: first as-is (""), then each PATHEXT entry (bare name pwsh -> pwsh.EXE).
    let mut exts: Vec<String> = vec![String::new()];
    exts.extend(
        pathext
            .split(';')
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_string),
    );
    for dir in path_env.split(';').map(str::trim) {
        let dir_path = Path::new(dir);
        // Only absolute directories are accepted: drop "", ".", and relative entries — eliminating any fallback into the workspace.
        if !dir_path.is_absolute() {
            continue;
        }
        for ext in &exts {
            let mut file = name.to_os_string();
            file.push(ext);
            let candidate = dir_path.join(&file);
            if is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Microsoft Store / MSIX execution aliases live under `WindowsApps`. A sandbox security context cannot directly
/// launch such packaged binaries via `CreateProcess*`, so it must not be treated as a shell.
/// Split on both the / and the backslash characters, so Windows path literals can be unit-tested on a non-Windows host.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn is_msix_windowsapps_path(path: &Path) -> bool {
    path.to_string_lossy()
        .split(['\\', '/'])
        .any(|seg| seg.eq_ignore_ascii_case("WindowsApps"))
}

/// HKCU subkeys: CAPI/CNG calls `RegCreateKey` on them during provider initialization (create implies write).
/// Under a Low IL token, a Medium label would be rejected by NoWriteUp, and PowerShell/.NET would ultimately
/// misreport it as "BCrypt.dll failed to load" (exit `0xE0434352`).
/// This is a narrow exception for the user certificate/key store, not opening up all of HKCU.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const CNG_USER_REGISTRY_SUBKEYS: &[&str] = &[
    r"Software\Microsoft\SystemCertificates",
    r"Software\Microsoft\SystemCertificates\CA",
    r"Software\Microsoft\SystemCertificates\Root",
    r"Software\Microsoft\SystemCertificates\My",
    r"Software\Policies\Microsoft\SystemCertificates",
    r"Software\Policies\Microsoft\SystemCertificates\CA",
    r"Software\Microsoft\Cryptography",
];

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn cng_named_registry_object(subkey: &str) -> String {
    format!("CURRENT_USER\\{subkey}")
}

/// CNG also writes key containers / DPAPI / certificate URL caches into the user profile directory
/// (not TEMP; the sandbox's TEMP redirection does not cover it).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn cng_user_file_dirs(appdata: &Path, localappdata: &Path) -> Vec<PathBuf> {
    vec![
        appdata.join("Microsoft").join("Crypto"),
        appdata.join("Microsoft").join("Protect"),
        localappdata.join("Microsoft").join("CryptnetUrlCache"),
    ]
}

/// HKCU subkeys: Windows PowerShell 5.1 / .NET Framework CLR startup calls `RegCreateKey`.
/// This is a separate failure surface from the CNG certificate store — when denied here the process exits with HRESULT `0x80070005`
/// (E_ACCESSDENIED), rather than `0xE0434352` / `NTE_PROVIDER_DLL_FAIL`.
/// Still a narrow exception for user runtime caches, not opening up all of HKCU.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const CLR_USER_REGISTRY_SUBKEYS: &[&str] = &[
    r"Software\Microsoft\PowerShell",
    r"Software\Microsoft\PowerShell\1",
    r"Software\Microsoft\Windows\PowerShell",
    r"Software\Microsoft\.NETFramework",
];

/// .NET Framework / Windows PowerShell startup also writes user CLR caches and module analysis directories
/// (Fusion, UsageLogs, ModuleAnalysisCache). Without covering these paths, powershell.exe
/// crashes immediately with `0x80070005` when it cannot write under a Low IL token.
///
/// Deliberately excludes `%LOCALAPPDATA%\Temp`: TEMP is already redirected to the fenced directory, and granting the user's real Temp
/// a write ACE would tear the fence open.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn clr_user_file_dirs(appdata: &Path, localappdata: &Path) -> Vec<PathBuf> {
    vec![
        localappdata.join("Microsoft").join("CLR_v4.0"),
        localappdata.join("Microsoft").join("CLR_v4.0_32"),
        localappdata.join("assembly"),
        localappdata
            .join("Microsoft")
            .join("Windows")
            .join("PowerShell"),
        localappdata.join("Microsoft").join("PowerShell"),
        appdata.join("Microsoft").join("Windows").join("PowerShell"),
        appdata.join("Microsoft").join("CLR Security Config"),
        localappdata.join("IsolatedStorage"),
    ]
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SandboxOptions {
    pub allow_network: bool,
}

/// Expanded sandbox spec: write_root is the workspace root allowed for writing (must be a canonicalized
/// absolute path, already guaranteed by shell_runner / managed_process workdir validation).
#[derive(Debug, Clone)]
pub(crate) struct SandboxSpec {
    pub write_root: PathBuf,
    pub allow_network: bool,
    /// An isolated long-running process must survive after ReactorPro exits (managed_process's isolated
    /// semantics). Linux bwrap omits `--die-with-parent` accordingly; the Windows launcher accordingly omits
    /// the KILL_ON_JOB_CLOSE Job Object (threaded through the self-reexec boundary via `--isolated`).
    /// macOS Seatbelt has no parent-death coupling, so it does not read this field.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub isolated: bool,
}

impl SandboxSpec {
    pub(crate) fn from_options(write_root: PathBuf, options: SandboxOptions) -> Self {
        Self {
            write_root,
            allow_network: options.allow_network,
            // Default is non-isolated (Bash tool child processes terminate when ReactorPro exits);
            // managed_process's isolated long-running processes explicitly set it to true after construction.
            isolated: false,
        }
    }
}

/// Command safety mode -> sandbox parameters. `ask`/`auto` do not enable the OS sandbox (`ask` is the frontend's per-invocation human approval
/// gate and does not change execution isolation); `sandbox` is networked, `sandboxOffline` is offline.
pub(crate) fn options_from_mode(mode: &str) -> Option<SandboxOptions> {
    match mode.trim() {
        "sandbox" => Some(SandboxOptions {
            allow_network: true,
        }),
        "sandboxOffline" => Some(SandboxOptions {
            allow_network: false,
        }),
        _ => None,
    }
}

/// Take the stricter side. Strictness: no sandbox < networked sandbox < offline sandbox.
pub(crate) fn strictest(
    a: Option<SandboxOptions>,
    b: Option<SandboxOptions>,
) -> Option<SandboxOptions> {
    match (a, b) {
        (Some(x), Some(y)) => Some(SandboxOptions {
            allow_network: x.allow_network && y.allow_network,
        }),
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    }
}

/// Backend-independent lower bound (P1#3): the `sandbox` / `sandbox_allow_network` sent by the renderer process can only "tighten",
/// never loosen. At the command boundary the backend re-reads the persisted `settings.system.commandSafetyMode` and derives the
/// lower bound itself, then takes the stricter of that and the requested value — whether the request comes from the desktop UI, the gateway (remote WebUI), or the Cron scheduler,
/// the same lower bound is enforced (matching the "server re-resolves persisted config" paradigm of `load_runtime_ssh_host`).
///
/// Failure to read the persisted config => error out directly (fail-closed); never execute unsandboxed just because settings could not be read.
pub(crate) fn resolve_effective_options(
    requested: Option<SandboxOptions>,
) -> Result<Option<SandboxOptions>, String> {
    let mode = crate::commands::settings::load_runtime_command_safety_mode().map_err(|err| {
        format!(
            "Cannot verify the persisted sandbox floor (settings.system.commandSafetyMode): {err}. \
Refusing to run the command unsandboxed."
        )
    })?;
    Ok(strictest(requested, options_from_mode(&mode)))
}

#[derive(Debug, Clone, Serialize)]
pub struct SandboxCapability {
    pub supported: bool,
    pub mechanism: &'static str,
    pub platform: &'static str,
    /// Whether the offline variant (sandboxOffline) is supported. macOS/Linux are true when `supported` is true;
    /// on Windows it is determined by a runtime probe (whether an AppContainer SID can be derived). When `supported=false`
    /// this field is meaningless (the whole thing is unavailable).
    pub network_control: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Sensitive-directory masking table (relative to home). The app's own config directory (where provider keys and the approval policy
/// live: config.sqlite) is masked as well; the default workspace is inside it, and is re-allowed by the write_root post-allow rule,
/// so it is unaffected.
fn sensitive_home_subdirs() -> [&'static str; 4] {
    [".ssh", ".aws", ".gnupg", ".config/gh"]
}

fn app_config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(format!(".{}", env!("CARGO_PKG_NAME"))))
}

fn sensitive_dirs() -> Vec<PathBuf> {
    let mut dirs_out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for sub in sensitive_home_subdirs() {
            dirs_out.push(home.join(sub));
        }
    }
    if let Some(config) = app_config_dir() {
        dirs_out.push(config);
    }
    dirs_out
}

fn canonical_or_self(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Path normalization before lexical comparison (P2#5).
///
/// `canonical_or_self` only canonicalizes when the path exists, and Windows canonicalize adds
/// a verbatim prefix (`\\?\C:\...`, UNC form `\\?\UNC\server\share`); a nonexistent path
/// keeps its original form. `Path::starts_with` is a purely lexical component comparison and does not normalize prefixes, so when the two sides'
/// prefix forms differ (write_root exists while some sensitive directory does not, or vice versa) the comparison is always false —
/// the fence check is silently skipped, which is fail-open. Here we uniformly strip the verbatim prefix, and on Windows fold
/// case (NTFS paths are case-insensitive), making the comparison valid in both forms.
fn normalize_for_compare(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let stripped: String = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.to_string()
    };
    if cfg!(windows) {
        PathBuf::from(stripped.to_lowercase())
    } else {
        PathBuf::from(stripped)
    }
}

/// Whether `ancestor` contains or equals `descendant` (compared component-wise after normalization).
fn path_encloses(ancestor: &Path, descendant: &Path) -> bool {
    normalize_for_compare(descendant).starts_with(normalize_for_compare(ancestor))
}

/// fail-closed workspace validation (P1#2): reject workspaces that would re-expose sensitive directories through the write fence.
///
/// The write fence has a post re-allow for write_root (macOS) / post --bind (Linux), so:
/// - **ancestor or equal**: the workspace contains or equals any sensitive directory (e.g. the workspace is home or /); the
///   re-allow would re-permit that sensitive directory -> always reject.
/// - **descendant**: the workspace lies inside a sensitive directory. Workspaces under credential directories (~/.ssh/.aws/.gnupg/.config/gh)
///   are always rejected; the app config directory (~/.liveagent) is exempt — the default workspace
///   ~/.liveagent/default-project is exactly inside it, and rejecting it would break out-of-the-box usability.
///
/// Both the wrap path (`wrap_command`) and the Windows self-reexec launcher (`windows_sandbox::win::execute`)
/// must call it, otherwise the same write_root has asymmetric preconditions across the two chains (P3#8).
pub(crate) fn validate_workspace(write_root: &Path) -> Result<(), String> {
    let root = canonical_or_self(write_root);
    let app_config = app_config_dir().map(|p| canonical_or_self(&p));

    for dir in sensitive_dirs() {
        let dir = canonical_or_self(&dir);
        if path_encloses(&root, &dir) {
            return Err(format!(
                "Sandbox refuses workspace \"{}\": it encloses or equals the sensitive directory \
\"{}\", which the workspace write fence would re-expose. Choose a workspace that does not \
contain credential or app-config directories.",
                root.display(),
                dir.display()
            ));
        }
        if path_encloses(&dir, &root) {
            // Exempt inside the app config directory (the default workspace lives here); inside any other sensitive directory, always reject.
            let dir_key = normalize_for_compare(&dir);
            if app_config
                .as_deref()
                .is_some_and(|config| normalize_for_compare(config) == dir_key)
            {
                continue;
            }
            return Err(format!(
                "Sandbox refuses workspace \"{}\": it lives inside the sensitive directory \"{}\". \
Choose a workspace outside credential directories.",
                root.display(),
                dir.display()
            ));
        }
    }
    Ok(())
}

/// The Darwin user temp directory looks like `/var/folders/<xx>/<rand>/T` (or `/private/var/folders/.../T`).
/// Only this layout allows promoting the write permit to the parent directory, to cover both confstr's `T` and `C`
/// (clang module caches, etc.). Calling `parent()` on `/tmp`, `/private/tmp`, or `$HOME` yields
/// `/` or `$HOME`, and Seatbelt last-match-wins would re-permit the entire disk (including ~/.ssh).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn darwin_user_temp_parent(tmpdir: &Path) -> Option<PathBuf> {
    let mut names: Vec<&str> = Vec::new();
    for component in tmpdir.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => names.push(name.to_str()?),
            _ => return None,
        }
    }
    let n = names.len();
    if n < 4 || names[n - 1] != "T" || names[n - 4] != "folders" {
        return None;
    }
    let prefix = &names[..n - 4];
    if prefix != ["var"] && prefix != ["private", "var"] {
        return None;
    }
    tmpdir.parent().map(Path::to_path_buf)
}

/// Whether the temp write root is safe: it must not equal or enclose `/`, `$HOME`, or any sensitive directory, otherwise the post
/// write-allow / bwrap `--bind` would re-expose credentials (same rationale as `validate_workspace`).
#[cfg(any(not(windows), test))]
pub(crate) fn temp_write_root_is_safe(path: &Path) -> bool {
    let root = canonical_or_self(path);
    let cmp = normalize_for_compare(&root);
    if cmp == Path::new("/") || cmp.as_os_str().is_empty() {
        return false;
    }
    #[cfg(windows)]
    {
        if cmp.components().count() <= 1 {
            return false;
        }
    }
    if let Some(home) = dirs::home_dir() {
        if path_encloses(&root, &canonical_or_self(&home)) {
            return false;
        }
    }
    for dir in sensitive_dirs() {
        if path_encloses(&root, &canonical_or_self(&dir)) {
            return false;
        }
    }
    true
}

/// Resolve `bwrap` to an absolute path, never searching cwd / relative PATH.
///
/// Prefer `/usr/bin/bwrap` and `/usr/local/bin/bwrap`, to avoid a same-named poisoned binary in a project PATH prefix
/// (`node_modules/.bin`, `.venv/bin`) winning. Then only absolute PATH
/// directories; `skip_under` is used during wrap to skip hits inside the workspace (model-writable).
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub(crate) fn resolve_bwrap_executable(
    path_env: &str,
    is_file: &dyn Fn(&Path) -> bool,
    skip_under: Option<&Path>,
) -> Option<PathBuf> {
    const PINNED: &[&str] = &["/usr/bin/bwrap", "/usr/local/bin/bwrap"];
    let skipped = |candidate: &Path| skip_under.is_some_and(|root| path_encloses(root, candidate));
    for candidate in PINNED {
        let path = Path::new(candidate);
        if is_file(path) && !skipped(path) {
            return Some(path.to_path_buf());
        }
    }
    for dir in path_env.split(':').map(str::trim) {
        let dir_path = Path::new(dir);
        if !dir_path.is_absolute() || skipped(dir_path) {
            continue;
        }
        let candidate = dir_path.join("bwrap");
        if is_file(&candidate) && !skipped(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Allowed temp-directory write set: TMPDIR (only the Darwin user-private `/var/folders/.../T` is promoted
/// to its parent to cover the confstr cache directory), std::env::temp_dir, and the system-level tmp.
/// Any root that would enclose `/` or `$HOME` is discarded and never written into the Seatbelt allow / bwrap `--bind`.
#[cfg(not(windows))]
fn writable_temp_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push_canonical = |path: PathBuf| {
        if !temp_write_root_is_safe(&path) {
            return;
        }
        let canonical = std::fs::canonicalize(&path).unwrap_or(path);
        if !temp_write_root_is_safe(&canonical) {
            return;
        }
        if !out.contains(&canonical) {
            out.push(canonical);
        }
    };

    if let Ok(tmpdir) = std::env::var("TMPDIR") {
        let tmpdir = PathBuf::from(tmpdir.trim_end_matches('/'));
        if tmpdir.is_absolute() && tmpdir.is_dir() {
            // /var/folders/xx/yyy/T -> permit the parent /var/folders/xx/yyy, also covering
            // DARWIN_USER_CACHE_DIR (.../C). Other layouts (including TMPDIR=/tmp) must not be promoted.
            #[cfg(target_os = "macos")]
            if let Some(parent) = darwin_user_temp_parent(&tmpdir) {
                push_canonical(parent);
            }
            push_canonical(tmpdir);
        }
    }
    push_canonical(std::env::temp_dir());
    for path in ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"] {
        let path = Path::new(path);
        if path.is_dir() {
            push_canonical(path.to_path_buf());
        }
    }
    out
}

pub fn capability() -> SandboxCapability {
    platform::capability()
}

/// Wrap the (program, args) about to be executed in the platform sandbox, returning the replaced
/// (program, args, mechanism). If the platform is unsupported or a dependency is missing, it errors out (fail-closed).
pub(crate) fn wrap_command(
    spec: &SandboxSpec,
    program: &Path,
    args: &[String],
) -> Result<(PathBuf, Vec<String>, &'static str), String> {
    let capability = capability();
    if !capability.supported {
        return Err(format!(
            "Sandbox mode is enabled but unavailable on this platform: {}. \
Disable sandbox mode in Settings → System, or resolve the issue and retry.",
            capability
                .reason
                .as_deref()
                .unwrap_or("unsupported platform")
        ));
    }
    validate_workspace(&spec.write_root)?;
    platform::wrap_command(spec, program, args)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

    pub(super) fn capability() -> SandboxCapability {
        if Path::new(SANDBOX_EXEC).exists() {
            SandboxCapability {
                supported: true,
                mechanism: "seatbelt",
                platform: "macos",
                network_control: true,
                reason: None,
            }
        } else {
            SandboxCapability {
                supported: false,
                mechanism: "seatbelt",
                platform: "macos",
                network_control: false,
                reason: Some(format!("{SANDBOX_EXEC} not found")),
            }
        }
    }

    /// Seatbelt string-literal escaping: backslash and double quote.
    fn escape(path: &Path) -> String {
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    }

    fn subpath_filters(paths: &[PathBuf]) -> String {
        paths
            .iter()
            .map(|p| format!("(subpath \"{}\")", escape(p)))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// allow-default + write-fenced Seatbelt profile. Rule matching is "last match wins",
    /// order: global allow -> whole-disk write deny -> workspace/temp write allow -> device-node write
    /// allow -> sensitive-directory read deny -> workspace read/write re-allow (the default workspace is inside the app config
    /// directory, so it must come after the sensitive-directory deny) -> optional network deny.
    pub(super) fn seatbelt_profile(spec: &SandboxSpec) -> String {
        let mut writable = vec![spec.write_root.clone()];
        writable.extend(writable_temp_dirs());

        let mut profile = String::from("(version 1)\n(allow default)\n(deny file-write*)\n");
        profile.push_str(&format!(
            "(allow file-write* {})\n",
            subpath_filters(&writable)
        ));
        profile.push_str(
            "(allow file-write-data file-ioctl (literal \"/dev/null\") (literal \"/dev/zero\") \
(literal \"/dev/tty\") (literal \"/dev/stdout\") (literal \"/dev/stderr\") \
(literal \"/dev/dtracehelper\"))\n(allow file-write* (subpath \"/dev/fd\"))\n",
        );
        let sensitive = sensitive_dirs();
        if !sensitive.is_empty() {
            profile.push_str(&format!(
                "(deny file-read* {})\n",
                subpath_filters(&sensitive)
            ));
        }
        profile.push_str(&format!(
            "(allow file-read* file-write* (subpath \"{}\"))\n",
            escape(&spec.write_root)
        ));
        if !spec.allow_network {
            profile.push_str("(deny network*)\n");
        }
        profile
    }

    pub(super) fn wrap_command(
        spec: &SandboxSpec,
        program: &Path,
        args: &[String],
    ) -> Result<(PathBuf, Vec<String>, &'static str), String> {
        let mut out = vec!["-p".to_string(), seatbelt_profile(spec)];
        out.push(program.to_string_lossy().into_owned());
        out.extend(args.iter().cloned());
        Ok((PathBuf::from(SANDBOX_EXEC), out, "seatbelt"))
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
mod platform {
    use super::*;
    use std::process::Command;
    use std::sync::OnceLock;

    static CAPABILITY: OnceLock<SandboxCapability> = OnceLock::new();

    fn resolve_installed_bwrap() -> Option<PathBuf> {
        resolve_bwrap_executable(
            &std::env::var("PATH").unwrap_or_default(),
            &|path| path.is_file(),
            None,
        )
    }

    fn probe() -> SandboxCapability {
        let unsupported = |reason: String| SandboxCapability {
            supported: false,
            mechanism: "bubblewrap",
            platform: "linux",
            network_control: false,
            reason: Some(reason),
        };
        let Some(bwrap) = resolve_installed_bwrap() else {
            return unsupported(
                "bubblewrap (bwrap) is not available. Install it, e.g. `apt install bubblewrap`."
                    .to_string(),
            );
        };
        // Probe real availability (in containers/restricted kernels bwrap may exist but be unable to create a namespace).
        // Must use the resolved absolute path, never a relative name from PATH (a writable workspace directory could win first).
        match Command::new(&bwrap)
            .args([
                "--die-with-parent",
                "--unshare-pid",
                "--ro-bind",
                "/",
                "/",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--",
                "/bin/true",
            ])
            .output()
        {
            Ok(output) if output.status.success() => SandboxCapability {
                supported: true,
                mechanism: "bubblewrap",
                platform: "linux",
                network_control: true,
                reason: None,
            },
            Ok(output) => unsupported(format!(
                "bubblewrap probe failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(err) => unsupported(format!("bubblewrap (bwrap) is not available: {err}.")),
        }
    }

    pub(super) fn capability() -> SandboxCapability {
        CAPABILITY.get_or_init(probe).clone()
    }

    pub(super) fn bwrap_args(spec: &SandboxSpec) -> Vec<String> {
        // An isolated long-running process must survive after ReactorPro exits and must not be coupled to parent death;
        // non-isolated (Bash tool child) keeps --die-with-parent to avoid leaving orphans.
        let mut args: Vec<String> = Vec::new();
        if !spec.isolated {
            args.push("--die-with-parent".to_string());
        }
        args.extend(
            [
                "--unshare-pid",
                "--ro-bind",
                "/",
                "/",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
            ]
            .into_iter()
            .map(String::from),
        );

        for tmp in writable_temp_dirs() {
            let tmp = tmp.to_string_lossy().into_owned();
            args.extend(["--bind".to_string(), tmp.clone(), tmp]);
        }
        // Masking must precede the write_root bind: the default workspace is inside the app config directory, and a later
        // --bind would re-expose the workspace on top of the tmpfs mask.
        for dir in sensitive_dirs() {
            if dir.is_dir() {
                args.extend(["--tmpfs".to_string(), dir.to_string_lossy().into_owned()]);
            }
        }
        let root = spec.write_root.to_string_lossy().into_owned();
        args.extend(["--bind".to_string(), root.clone(), root]);
        if !spec.allow_network {
            args.push("--unshare-net".to_string());
        }
        args.push("--".to_string());
        args
    }

    pub(super) fn wrap_command(
        spec: &SandboxSpec,
        program: &Path,
        args: &[String],
    ) -> Result<(PathBuf, Vec<String>, &'static str), String> {
        let bwrap = resolve_bwrap_executable(
            &std::env::var("PATH").unwrap_or_default(),
            &|path| path.is_file(),
            Some(&spec.write_root),
        )
        .ok_or_else(|| {
            "Sandbox mode is enabled but bwrap was not found outside the workspace. \
Install bubblewrap to a system path such as /usr/bin/bwrap (a binary inside the \
project folder is never used)."
                .to_string()
        })?;
        let mut out = bwrap_args(spec);
        out.push(program.to_string_lossy().into_owned());
        out.extend(args.iter().cloned());
        Ok((bwrap, out, "bubblewrap"))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::OnceLock;

    static CAPABILITY: OnceLock<SandboxCapability> = OnceLock::new();

    /// Runtime probe (P1#4): no longer hardcodes "always available". Both backends actually build a security context once —
    /// the networked backend duplicates the current user primary token and lowers it to Low IL, the offline backend derives
    /// an AppContainer SID. Group Policy, EDR hooks, and restricted SKUs can make these calls fail on real hardware;
    /// probing surfaces the failure early as `supported=false` / `network_control=false`,
    /// so `wrap_command`'s fail-closed guard is genuinely reachable on Windows.
    fn probe() -> SandboxCapability {
        let unsupported = |reason: String| SandboxCapability {
            supported: false,
            mechanism: "low-integrity-token",
            platform: "windows",
            network_control: false,
            reason: Some(reason),
        };
        // The self-reexec launcher uses current_exe as the shell; if it cannot be resolved, everything is unavailable.
        if let Err(err) = std::env::current_exe() {
            return unsupported(format!("cannot resolve current executable: {err}"));
        }
        let (networked_token, appcontainer) = crate::runtime::windows_sandbox::probe_backends();
        if let Err(err) = networked_token {
            return unsupported(format!("low-integrity token backend unavailable: {err}"));
        }
        SandboxCapability {
            supported: true,
            mechanism: "low-integrity-token",
            platform: "windows",
            // The offline variant uses AppContainer: if the AC SID cannot be derived => only sandboxOffline is unavailable,
            // and the networked write fence still works (the UI disables only the offline item accordingly).
            network_control: appcontainer.is_ok(),
            reason: appcontainer
                .err()
                .map(|err| format!("offline (AppContainer) backend unavailable: {err}")),
        }
    }

    pub(super) fn capability() -> SandboxCapability {
        CAPABILITY.get_or_init(probe).clone()
    }

    pub(super) fn wrap_command(
        spec: &SandboxSpec,
        program: &Path,
        args: &[String],
    ) -> Result<(PathBuf, Vec<String>, &'static str), String> {
        // Self-reexec: wrap the real command in current_exe's __sandbox_exec launcher. The launcher picks the backend
        // by --net at the earliest stage of the process: on -> Low IL primary token (CreateProcessAsUserW), off ->
        // AppContainer (CreateProcessW + SECURITY_CAPABILITIES); see windows_sandbox.
        if !spec.allow_network && !capability().network_control {
            return Err(format!(
                "Offline sandbox is enabled but the AppContainer backend is unavailable on this \
machine: {}. Switch to the networked sandbox mode or resolve the issue and retry.",
                capability()
                    .reason
                    .as_deref()
                    .unwrap_or("AppContainer SID could not be derived")
            ));
        }
        let current_exe = std::env::current_exe()
            .map_err(|err| format!("failed to resolve current executable for sandbox: {err}"))?;
        let launcher_args = build_launcher_args(
            &spec.write_root,
            spec.allow_network,
            spec.isolated,
            program,
            args,
        );
        let mechanism = if spec.allow_network {
            "low-integrity-token"
        } else {
            "appcontainer"
        };
        Ok((current_exe, launcher_args, mechanism))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_profile_contains_write_root_and_ordering() {
        let spec = SandboxSpec {
            write_root: PathBuf::from("/tmp/liveagent \"quoted\" ws"),
            allow_network: false,
            isolated: false,
        };
        let profile = platform::seatbelt_profile(&spec);
        assert!(profile.starts_with("(version 1)\n(allow default)\n(deny file-write*)\n"));
        assert!(profile.contains("liveagent \\\"quoted\\\" ws"));
        assert!(profile.ends_with("(deny network*)\n"));
        // The workspace re-allow must come after the sensitive-directory deny (last match wins).
        let deny_read = profile
            .find("(deny file-read*")
            .expect("deny file-read rule");
        let reallow = profile
            .find("(allow file-read* file-write*")
            .expect("workspace re-allow rule");
        assert!(reallow > deny_read);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_network_allowed_omits_network_rule() {
        let spec = SandboxSpec {
            write_root: PathBuf::from("/tmp/ws"),
            allow_network: true,
            isolated: false,
        };
        assert!(!platform::seatbelt_profile(&spec).contains("network"));
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn bwrap_args_order_masks_before_write_root_bind() {
        let spec = SandboxSpec {
            write_root: PathBuf::from("/home/user/project"),
            allow_network: false,
            isolated: false,
        };
        let args = platform::bwrap_args(&spec);
        assert_eq!(args.first().map(String::as_str), Some("--die-with-parent"));
        assert!(args.contains(&"--unshare-net".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("--"));
        let root_bind = args
            .iter()
            .position(|a| a == "/home/user/project")
            .expect("write root bind");
        if let Some(mask) = args.iter().position(|a| a == "--tmpfs") {
            assert!(mask < root_bind);
        }
    }

    // P1#3: an isolated long-running process must not be coupled to parent death, so bwrap must omit --die-with-parent.
    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn bwrap_args_isolated_omits_die_with_parent() {
        let base = PathBuf::from("/home/user/project");
        let attached = platform::bwrap_args(&SandboxSpec {
            write_root: base.clone(),
            allow_network: false,
            isolated: false,
        });
        assert!(attached.contains(&"--die-with-parent".to_string()));

        let isolated = platform::bwrap_args(&SandboxSpec {
            write_root: base,
            allow_network: false,
            isolated: true,
        });
        assert!(!isolated.contains(&"--die-with-parent".to_string()));
        // With the death coupling omitted, the remaining fencing (pid namespace, read-only root bind) stays unchanged.
        assert_eq!(isolated.first().map(String::as_str), Some("--unshare-pid"));
        assert_eq!(isolated.last().map(String::as_str), Some("--"));
    }

    // P1#2: if the workspace contains/equals a sensitive directory, the write-fence re-allow would re-expose it -> reject.
    #[test]
    fn validate_workspace_rejects_ancestor_of_sensitive_dir() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        // home itself contains sensitive directories such as ~/.ssh.
        assert!(validate_workspace(&home).is_err());
    }

    // P1#2: workspaces inside credential directories are always rejected.
    #[test]
    fn validate_workspace_rejects_inside_credential_dir() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let inside_ssh = home.join(".ssh").join("ws");
        assert!(validate_workspace(&inside_ssh).is_err());
    }

    // P1#2: exempt inside the app config directory — the default workspace ~/.liveagent/default-project must be permitted.
    #[test]
    fn validate_workspace_allows_default_project_under_app_config() {
        let Some(config) = app_config_dir() else {
            return;
        };
        let default_project = config.join("default-project");
        assert!(validate_workspace(&default_project).is_ok());
    }

    // P1#2: a normal workspace with no ancestor/descendant relation to any sensitive directory is permitted.
    #[test]
    fn validate_workspace_allows_ordinary_workspace() {
        assert!(validate_workspace(Path::new("/tmp/liveagent-ordinary-ws")).is_ok());
    }

    // --- cross-platform pure logic (relied on by the Windows launcher, runnable on any host) ---

    // P2#5: the verbatim prefix must be stripped before lexical comparison, otherwise the canonicalized side and the non-
    // canonicalized side never match (fail-open).
    #[test]
    fn normalize_for_compare_strips_verbatim_prefixes() {
        assert_eq!(
            normalize_for_compare(Path::new(r"\\?\C:\ws\proj")).to_string_lossy(),
            if cfg!(windows) {
                r"c:\ws\proj".to_string()
            } else {
                r"C:\ws\proj".to_string()
            }
        );
        assert_eq!(
            normalize_for_compare(Path::new(r"\\?\UNC\server\share\ws")).to_string_lossy(),
            r"\\server\share\ws"
        );
    }

    #[test]
    fn path_encloses_matches_ancestor_and_self() {
        assert!(path_encloses(
            Path::new("/home/user"),
            Path::new("/home/user/.ssh")
        ));
        assert!(path_encloses(
            Path::new("/home/user"),
            Path::new("/home/user")
        ));
        assert!(!path_encloses(
            Path::new("/home/user/.ssh"),
            Path::new("/home/user")
        ));
        // Different prefix forms (one side canonicalized) must still match.
        #[cfg(windows)]
        {
            assert!(path_encloses(
                Path::new(r"C:\Users\Me"),
                Path::new(r"\\?\C:\Users\Me\.ssh")
            ));
            assert!(path_encloses(
                Path::new(r"\\?\C:\Users\Me"),
                Path::new(r"c:\users\me\.aws")
            ));
        }
    }

    // P1#3: take the stricter of the lower bound and the requested value; only when neither has a sandbox is there no fencing.
    #[test]
    fn strictest_takes_the_tighter_side() {
        let online = Some(SandboxOptions {
            allow_network: true,
        });
        let offline = Some(SandboxOptions {
            allow_network: false,
        });
        assert!(strictest(None, None).is_none());
        assert_eq!(strictest(None, online).map(|o| o.allow_network), Some(true));
        assert_eq!(strictest(online, None).map(|o| o.allow_network), Some(true));
        // One side offline => result offline (not allowed to be loosened back to networked by the other side).
        assert_eq!(
            strictest(online, offline).map(|o| o.allow_network),
            Some(false)
        );
        assert_eq!(
            strictest(offline, online).map(|o| o.allow_network),
            Some(false)
        );
    }

    #[test]
    fn options_from_mode_only_sandbox_modes_fence() {
        assert!(options_from_mode("auto").is_none());
        assert!(options_from_mode("ask").is_none());
        assert!(options_from_mode("nonsense").is_none());
        assert_eq!(
            options_from_mode("sandbox").map(|o| o.allow_network),
            Some(true)
        );
        assert_eq!(
            options_from_mode("sandboxOffline").map(|o| o.allow_network),
            Some(false)
        );
    }

    #[test]
    fn launcher_args_roundtrip() {
        let program = PathBuf::from(r"C:\Program Files\Git\bin\bash.exe");
        let args = vec!["-lc".to_string(), "echo \"hi there\" && ls".to_string()];
        for (allow_network, isolated) in
            [(true, false), (false, false), (true, true), (false, true)]
        {
            let built = build_launcher_args(
                Path::new(r"C:\ws\proj"),
                allow_network,
                isolated,
                &program,
                &args,
            );
            assert_eq!(built[0], SANDBOX_EXEC_SUBCOMMAND);
            // payload = built[1..] (dropping argv[1], the subcommand marker), i.e. the part the launcher actually parses.
            let parsed = parse_launcher_args(&built[1..]).expect("parse");
            assert_eq!(parsed.write_root, PathBuf::from(r"C:\ws\proj"));
            assert_eq!(parsed.allow_network, allow_network);
            assert_eq!(parsed.isolated, isolated);
            assert_eq!(parsed.program, program);
            assert_eq!(parsed.args, args);
        }
    }

    #[test]
    fn parse_launcher_args_rejects_incomplete() {
        assert!(parse_launcher_args(&["--write-root".to_string()]).is_err());
        assert!(parse_launcher_args(&["--".to_string()]).is_err());
        assert!(parse_launcher_args(&[]).is_err());
        // Missing --write-root.
        assert!(parse_launcher_args(&[
            "--net".to_string(),
            "on".to_string(),
            "--".to_string(),
            "cmd.exe".to_string(),
        ])
        .is_err());
        // Missing --net (required, never implicitly defaults to a backend).
        assert!(parse_launcher_args(&[
            "--write-root".to_string(),
            r"C:\ws".to_string(),
            "--".to_string(),
            "cmd.exe".to_string(),
        ])
        .is_err());
        // --net value is invalid.
        assert!(parse_launcher_args(&[
            "--write-root".to_string(),
            r"C:\ws".to_string(),
            "--net".to_string(),
            "maybe".to_string(),
            "--".to_string(),
            "cmd.exe".to_string(),
        ])
        .is_err());
    }

    #[test]
    fn parse_launcher_args_program_without_extra_args() {
        let parsed = parse_launcher_args(&[
            "--write-root".to_string(),
            r"C:\ws".to_string(),
            "--net".to_string(),
            "off".to_string(),
            "--".to_string(),
            "cmd.exe".to_string(),
        ])
        .expect("parse");
        assert_eq!(parsed.program, PathBuf::from("cmd.exe"));
        assert!(!parsed.allow_network);
        assert!(!parsed.isolated);
        assert!(parsed.args.is_empty());
    }

    #[test]
    fn synthetic_sid_is_deterministic_and_case_insensitive() {
        let a = synthetic_workspace_sid(Path::new(r"C:\Users\Me\Project"));
        let b = synthetic_workspace_sid(Path::new(r"c:\users\me\project"));
        assert_eq!(a, b, "Windows paths are case-insensitive and should yield the same SID");
        assert!(a.starts_with("S-1-5-21-"));
        // Of the form S-1-5-21-<a>-<b>-<c>-<d>: S,1,5,21 + 4 sub-authority segments = 8 segments.
        assert_eq!(a.split('-').count(), 8);
        let other = synthetic_workspace_sid(Path::new(r"C:\Users\Me\Other"));
        assert_ne!(a, other, "different paths should yield different SIDs");
    }

    #[test]
    fn command_line_quotes_spaces_and_escapes_quotes() {
        let line = build_command_line(
            r"C:\Program Files\App\app.exe",
            &[
                "--flag".to_string(),
                "a b".to_string(),
                r#"say "hi""#.to_string(),
            ],
        );
        assert_eq!(line.last(), Some(&0u16), "must be NUL-terminated");
        let decoded = String::from_utf16(&line[..line.len() - 1]).unwrap();
        // A program path containing spaces is quoted as a whole (backslashes are not doubled just because there is no `"`).
        assert!(decoded.starts_with(r#""C:\Program Files\App\app.exe""#));
        // Arguments without special characters are not quoted.
        assert!(decoded.contains(" --flag "));
        // Arguments containing spaces are quoted.
        assert!(decoded.contains(r#" "a b" "#));
        // An embedded " is escaped with a backslash.
        assert!(decoded.ends_with(r#""say \"hi\"""#));
    }

    #[test]
    fn command_line_doubles_trailing_backslashes_before_closing_quote() {
        // When an argument containing spaces needs quoting and ends with a backslash, the trailing backslash must be doubled,
        // otherwise it escapes the closing quote (the classic CommandLineToArgvW trap).
        let line = build_command_line("prog", &[r"a\b c\".to_string()]);
        let decoded = String::from_utf16(&line[..line.len() - 1]).unwrap();
        assert!(decoded.ends_with(r#""a\b c\\""#));
    }

    // resolve_program_in_path: this host (Unix) verifies, under Unix absolute/separator rules, the algorithm "search absolute directories, apply
    // PATHEXT, skip relative entries, pass absolute inputs through"; Windows path semantics are compiled+verified on Windows on real hardware.
    #[test]
    fn resolve_program_searches_absolute_dirs_first_match_wins() {
        let present: std::collections::HashSet<PathBuf> =
            [PathBuf::from("/usr/bin/sh")].into_iter().collect();
        let is_file = |p: &Path| present.contains(p);
        let got =
            resolve_program_in_path(Path::new("sh"), "/nonexist;/usr/bin;/bin", ".EXE", &is_file);
        assert_eq!(got, Some(PathBuf::from("/usr/bin/sh")));
    }

    #[test]
    fn resolve_program_applies_pathext_to_bare_name() {
        let present: std::collections::HashSet<PathBuf> =
            [PathBuf::from("/tools/pwsh.EXE")].into_iter().collect();
        let is_file = |p: &Path| present.contains(p);
        let got = resolve_program_in_path(Path::new("pwsh"), "/tools", ".COM;.EXE", &is_file);
        assert_eq!(got, Some(PathBuf::from("/tools/pwsh.EXE")));
    }

    #[test]
    fn resolve_program_never_probes_relative_or_dot_dirs() {
        // "." and relative entries in PATH must never be probed: the predicate should only receive absolute candidates.
        let is_file = |p: &Path| {
            assert!(
                p.is_absolute(),
                "resolver probed a non-absolute path: {p:?}"
            );
            false
        };
        let got = resolve_program_in_path(Path::new("cmd.exe"), ".;rel/dir;/abs", ".EXE", &is_file);
        assert_eq!(got, None);
    }

    #[test]
    fn resolve_program_passes_absolute_input_through_without_probing() {
        let is_file = |_: &Path| panic!("absolute input must not be probed");
        let got = resolve_program_in_path(Path::new("/bin/sh"), "/other", ".EXE", &is_file);
        assert_eq!(got, Some(PathBuf::from("/bin/sh")));
    }

    #[test]
    fn msix_windowsapps_path_is_detected_case_insensitively() {
        assert!(is_msix_windowsapps_path(Path::new(
            r"C:\Users\Me\AppData\Local\Microsoft\WindowsApps\pwsh.exe"
        )));
        assert!(is_msix_windowsapps_path(Path::new(
            r"C:\Program Files\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe"
        )));
        assert!(!is_msix_windowsapps_path(Path::new(
            r"C:\Program Files\PowerShell\7\pwsh.exe"
        )));
        assert!(!is_msix_windowsapps_path(Path::new(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        )));
    }

    #[test]
    fn cng_user_write_surface_is_narrow_user_store_not_home() {
        assert!(CNG_USER_REGISTRY_SUBKEYS
            .iter()
            .all(|key| key.starts_with(r"Software\")));
        assert!(CNG_USER_REGISTRY_SUBKEYS
            .iter()
            .all(|key| { key.contains("SystemCertificates") || key.contains("Cryptography") }));
        assert_eq!(
            cng_named_registry_object(r"Software\Microsoft\SystemCertificates"),
            r"CURRENT_USER\Software\Microsoft\SystemCertificates"
        );
        let dirs = cng_user_file_dirs(Path::new("/roaming"), Path::new("/local"));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/roaming/Microsoft/Crypto"),
                PathBuf::from("/roaming/Microsoft/Protect"),
                PathBuf::from("/local/Microsoft/CryptnetUrlCache"),
            ]
        );
        assert!(!dirs
            .iter()
            .any(|path| path == Path::new("/roaming") || path == Path::new("/local")));
    }

    #[test]
    fn clr_user_write_surface_is_narrow_runtime_cache_not_home() {
        assert!(CLR_USER_REGISTRY_SUBKEYS
            .iter()
            .all(|key| key.starts_with(r"Software\Microsoft\")));
        assert!(CLR_USER_REGISTRY_SUBKEYS
            .iter()
            .all(|key| { key.contains("PowerShell") || key.contains(".NETFramework") }));
        let dirs = clr_user_file_dirs(Path::new("/roaming"), Path::new("/local"));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/local/Microsoft/CLR_v4.0"),
                PathBuf::from("/local/Microsoft/CLR_v4.0_32"),
                PathBuf::from("/local/assembly"),
                PathBuf::from("/local/Microsoft/Windows/PowerShell"),
                PathBuf::from("/local/Microsoft/PowerShell"),
                PathBuf::from("/roaming/Microsoft/Windows/PowerShell"),
                PathBuf::from("/roaming/Microsoft/CLR Security Config"),
                PathBuf::from("/local/IsolatedStorage"),
            ]
        );
        assert!(!dirs.iter().any(|path| {
            path == Path::new("/roaming")
                || path == Path::new("/local")
                || path == Path::new("/local/Temp")
                || path == Path::new("/local/Microsoft")
        }));
    }

    #[test]
    fn darwin_user_temp_parent_only_matches_var_folders_layout() {
        assert_eq!(
            darwin_user_temp_parent(Path::new("/var/folders/zz/abc123/T")),
            Some(PathBuf::from("/var/folders/zz/abc123"))
        );
        assert_eq!(
            darwin_user_temp_parent(Path::new("/private/var/folders/zz/abc123/T")),
            Some(PathBuf::from("/private/var/folders/zz/abc123"))
        );
        // The parent of /tmp is `/`, which must never be promoted.
        assert_eq!(darwin_user_temp_parent(Path::new("/tmp")), None);
        assert_eq!(darwin_user_temp_parent(Path::new("/private/tmp")), None);
        assert_eq!(darwin_user_temp_parent(Path::new("/var/tmp")), None);
        assert_eq!(darwin_user_temp_parent(Path::new("/tmp/T")), None);
        assert_eq!(
            darwin_user_temp_parent(Path::new("/var/folders/zz/abc123")),
            None
        );
    }

    #[test]
    fn temp_write_root_rejects_filesystem_root_and_home() {
        assert!(!temp_write_root_is_safe(Path::new("/")));
        if let Some(home) = dirs::home_dir() {
            assert!(!temp_write_root_is_safe(&home));
        }
        assert!(temp_write_root_is_safe(Path::new("/tmp")));
        assert!(temp_write_root_is_safe(Path::new("/var/folders/zz/abc123")));
    }

    #[test]
    fn resolve_bwrap_prefers_system_path_over_workspace_path_prefix() {
        let present: std::collections::HashSet<PathBuf> = [
            PathBuf::from("/workspace/node_modules/.bin/bwrap"),
            PathBuf::from("/usr/bin/bwrap"),
        ]
        .into_iter()
        .collect();
        let is_file = |p: &Path| present.contains(p);
        let got = resolve_bwrap_executable("/workspace/node_modules/.bin:/usr/bin", &is_file, None);
        assert_eq!(got, Some(PathBuf::from("/usr/bin/bwrap")));
    }

    #[test]
    fn resolve_bwrap_skips_workspace_and_relative_path_entries() {
        let present: std::collections::HashSet<PathBuf> = [
            PathBuf::from("/workspace/node_modules/.bin/bwrap"),
            PathBuf::from("/opt/nix/bin/bwrap"),
        ]
        .into_iter()
        .collect();
        let is_file = |p: &Path| present.contains(p);
        let got = resolve_bwrap_executable(
            ".:/workspace/node_modules/.bin:/opt/nix/bin",
            &is_file,
            Some(Path::new("/workspace")),
        );
        assert_eq!(got, Some(PathBuf::from("/opt/nix/bin/bwrap")));
    }

    #[test]
    fn resolve_bwrap_refuses_when_only_workspace_copy_exists() {
        let is_file = |p: &Path| p == Path::new("/workspace/.venv/bin/bwrap");
        let got = resolve_bwrap_executable(
            "/workspace/.venv/bin",
            &is_file,
            Some(Path::new("/workspace")),
        );
        assert_eq!(got, None);
    }
}
