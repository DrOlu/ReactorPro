//! Probing / installation / permission queries for `cua-driver`.
//!
//! The computer-operation capability itself does **not** go through here — `cua-driver mcp`
//! is a standard stdio MCP server driven by the generic MCP client in
//! `commands/integration/mcp.rs`, with tools auto-discovered via `tools/list`. This module
//! only handles the small piece of bootstrapping in front of it: whether the binary exists
//! on the user's machine, where it is installed, whether to install it, and whether macOS
//! TCC authorization has been granted.
//!
//! The design principle is to **push all the work upstream**. Version checks, downloads,
//! extraction, updates, and authorization prompts all exist in the upstream CLI
//! (`install.sh` / `update --apply` / `permissions grant` / `doctor`); we do not reimplement
//! them here, only three things:
//!
//! 1. find the binary (a GUI process's PATH usually lacks `~/.local/bin`, so candidate paths must be added);
//! 2. ask `cua-driver manifest` for the MCP invocation instead of hardcoding `["mcp"]`;
//! 3. when installation is needed, delegate to the official install script and stream its output to the frontend.
//!
//! On macOS we deliberately do **not** use `mcp --direct`: that would make the MCP process
//! inherit the host's (ReactorPro.app) TCC attribution, effectively requiring ReactorPro to
//! obtain Accessibility and Screen Recording authorization itself. The default mode proxies
//! through the CuaDriver.app daemon, which owns the authorization, so the host needs no TCC
//! permissions.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use wait_timeout::ChildExt;

pub mod installed_apps;

/// Wait limit for a single external command. `manifest` / `permissions status` both return
/// within 1 second; leave ample margin for a cold-start daemon handshake.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Wait limit for the install script. It must download and extract, so it is far slower
/// than probing, but it should not wait forever either — when the network hangs, a bare
/// `wait()` would leave the UI's "installing" state stuck forever, with no way out but
/// restarting the app.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Progress event name for the install script. The frontend `CuaDriverSetupCard` listens to it to scroll logs.
pub const INSTALL_PROGRESS_EVENT: &str = "cua_driver_install_progress";

/// Official install script source. This domain is what users see — it must match the URL
/// actually executed, otherwise the confirmation dialog is lying.
const INSTALL_SCRIPT_URL_UNIX: &str = "https://cua.ai/driver/install.sh";
const INSTALL_SCRIPT_URL_WINDOWS: &str = "https://cua.ai/driver/install.ps1";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaDriverProbe {
    pub installed: bool,
    /// Absolute path to the binary. This is what gets written into the MCP server config —
    /// not the bare name, because the MCP child process inherits the GUI process's narrow PATH.
    pub path: Option<String>,
    pub version: Option<String>,
    /// The invocation given by `manifest.mcp_invocation`. If upstream changes its subcommand,
    /// this follows along without requiring a release from us.
    pub mcp_command: Option<String>,
    pub mcp_args: Vec<String>,
    /// Whether this platform has a system authorization gate the user must handle. Only macOS
    /// has TCC; Windows / Linux are always false — the frontend uses this to decide
    /// **immediately** whether to render the authorization section, without waiting for the
    /// `permissions_status` child process to return.
    pub permissions_required: bool,
    /// Reason probing failed (not being installed is a normal state, not an error, in which case this is None).
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaDriverPermissions {
    /// Only macOS has a TCC gate; other platforms are always false, and the frontend hides
    /// the whole section accordingly.
    pub supported: bool,
    pub accessibility: bool,
    pub screen_recording: bool,
    /// The bundle id the authorization is attributed to (normally `com.trycua.driver`). When
    /// the daemon is not running, upstream reports unknown, and the two booleans are unreliable.
    pub attributed_to: Option<String>,
    pub error: Option<String>,
}

/// Install command preview. **Describes only, never executes** — the UI must first show
/// `display` verbatim for the user to confirm before `install` may be called.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCommandPreview {
    pub program: String,
    pub args: Vec<String>,
    /// The complete command, pasteable directly into a terminal. The user may also choose to
    /// run this one themselves in a terminal.
    pub display: String,
    /// Script source URL, used in the confirmation text to make clear "this downloads and
    /// executes a script from the network".
    pub source_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    /// `stdout` | `stderr` | `done` | `failed`
    pub stream: String,
    pub line: String,
}

// ───────── Probing ─────────

/// Whether this platform has a system authorization gate the user must handle. Only macOS has TCC.
///
/// It is a separate function rather than an inline `cfg!` so tests can assert this bit
/// without spawning any child process — `probe()` really runs `cua-driver manifest`, so
/// putting it in a unit test would make the result depend on whether the machine running
/// the tests has the driver installed.
const fn platform_requires_permissions() -> bool {
    cfg!(target_os = "macos")
}

/// Find `cua-driver` in PATH and the platform candidate directories.
///
/// We must walk ourselves rather than rely on `Command::new("cua-driver")`: on macOS a GUI
/// process launched from Finder / Dock gets launchd's default PATH, which lacks
/// `~/.local/bin` — exactly the default landing spot of the official install script.
fn find_binary() -> Option<PathBuf> {
    if let Some(found) = find_in_path("cua-driver") {
        return Some(found);
    }
    candidate_paths().into_iter().find(|p| p.is_file())
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        {
            let with_exe = dir.join(format!("{binary}.exe"));
            if with_exe.is_file() {
                return Some(with_exe);
            }
        }
    }
    None
}

fn candidate_paths() -> Vec<PathBuf> {
    let home = dirs::home_dir();
    let mut out: Vec<PathBuf> = Vec::new();

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = home.as_ref() {
            out.push(home.join(".local/bin/cua-driver"));
            out.push(home.join(".cua/bin/cua-driver"));
        }
        out.push(PathBuf::from("/usr/local/bin/cua-driver"));
        out.push(PathBuf::from("/opt/homebrew/bin/cua-driver"));
    }

    #[cfg(target_os = "macos")]
    {
        // The case where CuaDriver.app is installed but no PATH symlink was created.
        out.push(PathBuf::from(
            "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
        ));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(home) = home.as_ref() {
            out.push(home.join(".local\\bin\\cua-driver.exe"));
            out.push(home.join("AppData\\Local\\Programs\\cua-driver\\cua-driver.exe"));
        }
    }

    let _ = &home;
    out
}

/// Build a child-process command that will not pop up a console window.
///
/// On Windows, spawning a console program from a GUI process really does open a black
/// console window — probing, permission queries, and the install script are all background
/// work, so the user would get a flash every time they open the CUA settings page.
/// `CREATE_NO_WINDOW` only affects whether a console is allocated; stdout / stderr are still
/// obtained through pipes as usual. Non-Windows platforms have no such concept, so the
/// helper degrades to `Command::new`.
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(program)
    }
}

fn run_capture(program: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = hidden_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to spawn {}: {error}", program.display()))?;

    let status = match child
        .wait_timeout(PROBE_TIMEOUT)
        .map_err(|error| format!("wait failed: {error}"))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{} {} timed out after {}s",
                program.display(),
                args.join(" "),
                PROBE_TIMEOUT.as_secs()
            ));
        }
    };

    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to collect output: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Some subcommands (e.g. permissions status) also exit non-zero on business failure
        // while still printing valid JSON; include stdout as well and let the caller decide
        // how to parse it.
        return Err(format!(
            "exit {}: {}",
            status.code().unwrap_or(-1),
            if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            }
        ));
    }
    Ok(stdout)
}

/// Probe the installation status. Not being installed is not an error — returns
/// `installed: false, error: None`.
pub fn probe() -> CuaDriverProbe {
    let Some(path) = find_binary() else {
        return CuaDriverProbe {
            permissions_required: platform_requires_permissions(),
            ..Default::default()
        };
    };

    let mut probe = CuaDriverProbe {
        installed: true,
        path: Some(path.to_string_lossy().into_owned()),
        permissions_required: platform_requires_permissions(),
        ..Default::default()
    };

    match run_capture(&path, &["manifest"]) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(manifest) => {
                probe.version = manifest
                    .get("binary_version")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let invocation = manifest.get("mcp_invocation");
                probe.mcp_command = invocation
                    .and_then(|v| v.get("command"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                probe.mcp_args = invocation
                    .and_then(|v| v.get("args"))
                    .and_then(Value::as_array)
                    .map(|args| {
                        args.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
            }
            Err(error) => probe.error = Some(format!("failed to parse manifest: {error}")),
        },
        Err(error) => probe.error = Some(error),
    }

    // Fall back to the known shape when the manifest gives no invocation (old version /
    // parse failure). Deliberately do not add `--direct`: see the module header comment.
    if probe.mcp_command.is_none() {
        probe.mcp_command = probe.path.clone();
        probe.mcp_args = vec!["mcp".to_string()];
    }

    probe
}

// ───────── Host's own identity ─────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfIdentity {
    pub pid: u32,
}

/// ReactorPro's own process identity, so the frontend can crop host windows out of
/// cua-driver's view.
///
/// Letting the model operate ReactorPro's own UI is a dangerous self-reference: it could
/// dismiss its own approval dialog, change its own permission policy, or simply shut itself
/// down. Filtering is done in the frontend (the Rust-side `mcp_call_tool` is a channel shared
/// by all MCP servers and should not carry cua-specific logic), so this only provides the
/// facts for comparison.
pub fn self_identity() -> SelfIdentity {
    SelfIdentity {
        pid: std::process::id(),
    }
}

/// The pid of the current frontmost (keyboard-focus-holding) application.
///
/// Why it exists: cua-driver's `press_key` / `hotkey` / `type_text` do not require
/// pid / window_id / coordinates under the desktop scope, and deliver input to the
/// **frontmost application**. Such calls slip past both the by-pid and by-coordinate gates —
/// only by knowing who is frontmost can we tell whether this keypress would land on the host
/// itself (dismissing the approval dialog, `cmd+q` quitting the app).
///
/// Returns `Err` when it cannot be obtained, and the frontend handles it **fail-closed**
/// (reject and make the model use an explicit target with pid / window_id). We must not
/// follow the window-rect approach of "allow when unavailable": keyboard input has no
/// ambiguity about "hitting the real target below the rectangle", and the cost of allowing
/// it is that the model can type arbitrary keys at the host.
pub fn frontmost_pid() -> Result<u32, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        let workspace = NSWorkspace::sharedWorkspace();
        let front = workspace
            .frontmostApplication()
            .ok_or_else(|| "no frontmost application".to_string())?;
        let pid = front.processIdentifier();
        u32::try_from(pid).map_err(|_| format!("invalid frontmost pid: {pid}"))
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return Err("no foreground window".to_string());
        }
        let mut pid: u32 = 0;
        let thread = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if thread == 0 || pid == 0 {
            return Err("failed to resolve foreground window process".to_string());
        }
        Ok(pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux has no unified frontmost-app query across X11 / Wayland. Returning Err makes
        // the frontend fail-closed: desktop keyboard calls without an explicit target are
        // rejected, while explicit targets with pid / window_id are unaffected, so no
        // capability is lost.
        Err("frontmost application detection is not supported on this platform".to_string())
    }
}

/// The rectangle of one of the host's own windows in screen coordinates, in logical points
/// (the same system as macOS Accessibility / cua-driver desktop coordinates).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfWindowRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The screen rectangles of all of ReactorPro's own visible windows.
///
/// There is only one purpose: to intercept clicks / drags / keypresses issued **targeting
/// the desktop, by screen coordinate**. Calls addressed by pid or window_id are rejected
/// outright by the frontend's self-targeting gate, but coordinates cannot be traced back to
/// an owner — the model can measure the position of a button inside a host window from a
/// full-screen screenshot and send it as `{"target":{"kind":"desktop"},"x":…,"y":…}`, slipping
/// past that gate. Hand the rectangles to the frontend for comparison and reject any
/// coordinate that falls inside one.
///
/// Invisible / minimized windows are not returned: they cannot receive clicks, and including
/// them would only harm the real target window beneath that area.
pub fn self_window_rects(app: &AppHandle) -> Vec<SelfWindowRect> {
    use tauri::Manager;

    app.webview_windows()
        .values()
        .filter_map(|window| {
            if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
                return None;
            }
            let scale = window.scale_factor().unwrap_or(1.0);
            let position = window.outer_position().ok()?.to_logical::<f64>(scale);
            let size = window.outer_size().ok()?.to_logical::<f64>(scale);
            Some(SelfWindowRect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            })
        })
        .collect()
}

// ───────── Permissions (macOS) ─────────

pub fn permissions_status() -> CuaDriverPermissions {
    if !cfg!(target_os = "macos") {
        return CuaDriverPermissions::default();
    }
    let Some(path) = find_binary() else {
        return CuaDriverPermissions {
            supported: true,
            error: Some("cua-driver not installed".into()),
            ..Default::default()
        };
    };

    // Only ask `permissions status`. We once additionally spawned `cua-driver status` in
    // parallel to decide whether the daemon was up, but the frontend never used that result
    // at all, while the cost was an extra child process on every settings-page visit and a
    // decision made by substring-matching English prose (silently wrong the moment upstream
    // rewords it). Add it back when needed, and with structured output.
    match run_capture(&path, &["permissions", "status", "--json"]) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(payload) => CuaDriverPermissions {
                supported: true,
                accessibility: payload
                    .get("accessibility")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                screen_recording: payload
                    .get("screen_recording")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                attributed_to: payload
                    .get("source")
                    .and_then(|source| source.get("bundle_id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                error: None,
            },
            Err(error) => CuaDriverPermissions {
                supported: true,
                error: Some(format!("failed to parse permissions payload: {error}")),
                ..Default::default()
            },
        },
        Err(error) => CuaDriverPermissions {
            supported: true,
            error: Some(error),
            ..Default::default()
        },
    }
}

/// Trigger upstream's authorization prompt. It pops the system dialog and launches
/// CuaDriver.app, attributing to the correct bundle identity — this is the only correct
/// authorization path; the read-only `permissions status` never triggers it.
pub fn permissions_grant() -> Result<CuaDriverPermissions, String> {
    if !cfg!(target_os = "macos") {
        return Ok(CuaDriverPermissions::default());
    }
    let path = find_binary().ok_or_else(|| "cua-driver not installed".to_string())?;
    run_capture(&path, &["permissions", "grant"])?;
    Ok(permissions_status())
}

// ───────── Installation ─────────

/// The raw install script handed to `/bin/bash -c` on Unix.
///
/// It must be in `curl | bash` pipeline form, and must **not** be written as `$(curl …)`:
/// in a terminal, `bash -c "$(curl …)"` works because the outer interactive shell performs
/// command substitution first, turning the whole script into the argument to `-c`. But when
/// spawning directly from Rust there is no outer shell — the literal `$(curl …)` becomes
/// bash's own script, and bash only word-splits the **substitution result**, executing it as
/// a single simple command without re-parsing it as a script. The first word of the
/// downloaded content, `#!/bin/bash`, is then looked up as a command name, reporting
/// `No such file or directory` and exiting 127.
///
/// `pipefail` is likewise essential: without it, when curl fails to fetch, bash receives
/// empty input and exits 0, silently treating the failed install as success.
fn unix_install_script(script_url: &str) -> String {
    format!("set -o pipefail; curl -fsSL {script_url} | /bin/bash")
}

/// Describe the install command that will be executed. **Executes nothing.**
///
/// The whole reason it exists is to let the UI put the raw command in front of the user
/// before acting: this command fetches a shell script from the network and executes it
/// directly, and the user has the right to decide after seeing the full text.
pub fn install_command_preview() -> InstallCommandPreview {
    if cfg!(target_os = "windows") {
        let inner = format!("irm {INSTALL_SCRIPT_URL_WINDOWS} | iex");
        InstallCommandPreview {
            program: "powershell".into(),
            args: vec!["-NoProfile".into(), "-Command".into(), inner.clone()],
            display: format!("powershell -NoProfile -Command \"{inner}\""),
            source_url: INSTALL_SCRIPT_URL_WINDOWS.into(),
        }
    } else {
        let inner = unix_install_script(INSTALL_SCRIPT_URL_UNIX);
        InstallCommandPreview {
            program: "/bin/bash".into(),
            args: vec!["-c".into(), inner.clone()],
            display: format!("/bin/bash -c \"{inner}\""),
            source_url: INSTALL_SCRIPT_URL_UNIX.into(),
        }
    }
}

/// Execute the official install script, emitting stdout / stderr line by line to the frontend.
///
/// The caller (Tauri command) must ensure the user has explicitly confirmed after seeing
/// `install_command_preview().display`.
pub fn install(app: &AppHandle) -> Result<CuaDriverProbe, String> {
    let preview = install_command_preview();
    let mut child = hidden_command(&preview.program)
        .args(&preview.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to launch installer: {error}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pump = |handle: Option<Box<dyn std::io::Read + Send>>, stream: &'static str| {
        let app = app.clone();
        handle.map(|reader| {
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in std::io::BufReader::new(reader).lines().map_while(Result::ok) {
                    let _ = app.emit(
                        INSTALL_PROGRESS_EVENT,
                        InstallProgress {
                            stream: stream.to_string(),
                            line,
                        },
                    );
                }
            })
        })
    };
    let out_pump = pump(
        stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        "stdout",
    );
    let err_pump = pump(
        stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        "stderr",
    );

    let status = match child
        .wait_timeout(INSTALL_TIMEOUT)
        .map_err(|error| format!("installer wait failed: {error}"))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let message = format!(
                "installer timed out after {} minutes",
                INSTALL_TIMEOUT.as_secs() / 60
            );
            let _ = app.emit(
                INSTALL_PROGRESS_EVENT,
                InstallProgress {
                    stream: "failed".into(),
                    line: message.clone(),
                },
            );
            return Err(message);
        }
    };
    if let Some(handle) = out_pump {
        let _ = handle.join();
    }
    if let Some(handle) = err_pump {
        let _ = handle.join();
    }

    if !status.success() {
        let message = format!("installer exited with {}", status.code().unwrap_or(-1));
        let _ = app.emit(
            INSTALL_PROGRESS_EVENT,
            InstallProgress {
                stream: "failed".into(),
                line: message.clone(),
            },
        );
        return Err(message);
    }

    let probe = probe();
    let _ = app.emit(
        INSTALL_PROGRESS_EVENT,
        InstallProgress {
            stream: "done".into(),
            line: probe
                .version
                .clone()
                .map(|version| format!("cua-driver {version}"))
                .unwrap_or_else(|| "installed".into()),
        },
    );
    Ok(probe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_preview_never_executes_and_matches_its_source_url() {
        let preview = install_command_preview();
        // The command shown to the user must really contain that URL — the entire point of
        // the confirmation dialog is "what you see is what will run".
        assert!(preview.display.contains(&preview.source_url));
        assert!(preview.args.iter().any(|arg| arg.contains(&preview.source_url)));
    }

    /// Actually run bash (curl supports file://, so no network and no dependency on whether
    /// the driver is installed), pinning down two semantics: the whole script is executed
    /// **by being parsed as a script**, and a curl failure must be propagated.
    ///
    /// The former implementation handed the `$(curl …)` literal to `bash -c` — bash only
    /// word-splits the substitution result and executes it as a single simple command, so
    /// the script's first word `#!/bin/bash` was treated as a command name and the install
    /// inevitably failed with 127. This test would immediately go red on that form.
    #[cfg(unix)]
    #[test]
    fn unix_install_script_parses_the_payload_as_a_script_and_propagates_curl_failure() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("cua-install-wrapper-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let script = dir.join("install.sh");
        std::fs::File::create(&script)
            .and_then(|mut f| f.write_all(b"#!/bin/bash\nexit 42\n"))
            .expect("write fake installer");

        let run = |url: &str| {
            hidden_command("/bin/bash")
                .args(["-c", &unix_install_script(url)])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("spawn bash")
        };

        // A script with a shebang should be parsed and executed in full (the shebang line is
        // a comment), exiting with the script's own 42 rather than 127's "command #!/bin/bash
        // not found".
        let ok = run(&format!("file://{}", script.display()));
        assert_eq!(ok.code(), Some(42), "the script should be parsed and executed as a script, not treated as a single command");

        // When curl cannot fetch, the whole pipeline must exit non-zero — without pipefail,
        // bash receiving empty input exits 0 and the failed install is silently treated as
        // success.
        let missing = run(&format!("file://{}", dir.join("missing.sh").display()));
        assert_ne!(missing.code(), Some(0), "a curl failure must not be silently treated as a successful install");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn permissions_required_tracks_the_platform_tcc_gate() {
        // The frontend uses this bit to decide whether to render the authorization section;
        // it must not wait for the slow permissions_status query to learn the platform, or
        // the card would "not appear first, then grow in later".
        assert_eq!(platform_requires_permissions(), cfg!(target_os = "macos"));
        assert_eq!(
            CuaDriverProbe::default().permissions_required,
            false,
            "Default is the fallback for a total probe failure and must not claim an authorization gate"
        );
    }

    #[test]
    fn probe_reports_not_installed_without_error() {
        // Not being installed is a normal state and must not be rendered by the frontend as a failure red bar.
        let probe = CuaDriverProbe::default();
        assert!(!probe.installed);
        assert!(probe.error.is_none());
    }

    #[test]
    fn candidate_paths_cover_the_official_install_location() {
        let paths = candidate_paths();
        assert!(
            paths.iter().any(|p| p.to_string_lossy().contains(".local")),
            "the official install script lands in ~/.local/bin by default, which a GUI process's PATH usually lacks"
        );
    }
}
