//! neuralOS native integration — the on-device needle 3 engine plus the
//! instance fleet, wired as first-class ReactorPro commands.
//!
//! Split of responsibilities (kept deliberately identical to the standalone
//! neuralOS contract):
//!
//! 1. **Selection** — the bundled needle engine (`needle --model needle3.cact
//!    --tools <instance>/needle_menu.json --prompt <question>`) emits the
//!    chosen probe call as JSON. Deterministic, offline, ~100 MB RAM.
//! 2. **Execution** — the instance's own `bridge.py` runs the selected probe
//!    and returns a small validated JSON digest. Credentials never leave the
//!    bridge (Keychain resolution), and the 121M model never sees raw data.
//!
//! Resolution order for every external component (env var wins, then bundled
//! resource, then app-data, then PATH):
//! - engine: `REACTORPRO_NEURALOS_ENGINE` → resource `neuralos/needle[.exe]`
//!   → app_data `neuralos/engine/needle[.exe]`
//! - weights: `REACTORPRO_NEURALOS_CACT` → resource `neuralos/needle3.cact`
//!   → app_data `neuralos/engine/needle3.cact`
//! - python: `REACTORPRO_NEURALOS_PYTHON` → app_data `neuralos/venv/…`
//!   → `python3`
//! - instances: `REACTORPRO_NEURALOS_INSTANCES` → app_data
//!   `neuralos/neuralos-instances` → legacy `~/neuralos-instances` (read-only
//!   fallback so an existing fleet keeps working before migration)

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

const ENGINE_TIMEOUT_SECS: u64 = 60;
const BRIDGE_TIMEOUT_SECS: u64 = 180;
/// The generated `needle_menu.json` entries are snake_case identifiers; this
/// doubles as an injection guard before the name reaches `getattr`.
const PROBE_NAME_MAX_LEN: usize = 64;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstanceInfo {
    pub name: String,
    pub probes: usize,
    pub has_bridge: bool,
    pub path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NeuralOsStatus {
    pub engine_path: Option<String>,
    pub cact_path: Option<String>,
    pub python_path: Option<String>,
    pub instances_dir: String,
    pub legacy_instances_dir_used: bool,
    pub instances: Vec<InstanceInfo>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProbeDigest {
    pub instance: String,
    pub probe: String,
    pub confidence: f64,
    pub result: serde_json::Value,
}

// ---------------------------------------------------------------- pure helpers

/// Scan one directory for neuralOS instances (a folder containing
/// `needle_menu.json`; `bridge.py` marks it runnable).
fn scan_instances(dir: &Path) -> Vec<InstanceInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let menu = path.join("needle_menu.json");
        if !menu.exists() {
            continue;
        }
        let probes = std::fs::read_to_string(&menu)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.as_array().map(|a| a.len()))
            .unwrap_or(0);
        out.push(InstanceInfo {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            probes,
            has_bridge: path.join("bridge.py").exists(),
            path: path.to_string_lossy().into_owned(),
        });
    }
    out
}

fn first_existing(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|p| p.exists()).cloned()
}

/// Injection guard: menu probe names are snake_case identifiers without
/// dunders, dots or whitespace.
fn is_valid_probe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= PROBE_NAME_MAX_LEN
        && !name.starts_with("__")
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Parse the engine's selection output: `{function_calls: [{name, arguments}],
/// confidence}`. Empty `function_calls` is the engine's honest refusal, not an
/// error — surfaced as one.
fn parse_selection(stdout: &[u8]) -> Result<(String, serde_json::Value, f64), String> {
    let text = String::from_utf8_lossy(stdout);
    let parsed: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|e| format!("engine output unparseable: {e}"))?;
    let confidence = parsed["confidence"].as_f64().unwrap_or(0.0);
    let call = parsed["function_calls"]
        .as_array()
        .and_then(|calls| calls.first())
        .cloned()
        .ok_or_else(|| {
            format!(
                "no probe selected (confidence {confidence:.2}) — try a phrasing closer to the instance's canonical questions"
            )
        })?;
    let name = call["name"]
        .as_str()
        .ok_or_else(|| "engine selected a call without a name".to_string())?
        .to_string();
    let arguments = match call.get("arguments") {
        Some(v) if !v.is_null() => v.clone(),
        _ => serde_json::json!({}),
    };
    Ok((name, arguments, confidence))
}

/// Python that runs the instance bridges: env override → managed venv → PATH.
fn resolve_python_candidates(app_data: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(p) = std::env::var("REACTORPRO_NEURALOS_PYTHON") {
        candidates.push(PathBuf::from(p));
    }
    #[cfg(target_os = "windows")]
    candidates.push(
        app_data
            .join("neuralos")
            .join("venv")
            .join("Scripts")
            .join("python.exe"),
    );
    #[cfg(not(target_os = "windows"))]
    candidates.push(app_data.join("neuralos").join("venv").join("bin").join("python3"));
    candidates.push(PathBuf::from("python3"));
    candidates
}

/// Wait for a child with a hard budget; kill on expiry. std-only polling
/// keeps the dependency tree untouched.
fn wait_with_timeout(
    child: &mut std::process::Child,
    budget: Duration,
) -> Result<std::process::ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => return Ok(status),
            None if started.elapsed() > budget => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {}s", budget.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

/// Run a subprocess to completion, capturing stdout/stderr with a budget.
fn run_captured(
    mut cmd: Command,
    stdin_text: Option<&str>,
    budget: Duration,
    label: &str,
) -> Result<Vec<u8>, String> {
    use std::io::Write;
    cmd.stdin(if stdin_text.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("{label} spawn failed: {e}"))?;
    if let Some(text) = stdin_text {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("{label} stdin failed: {e}"))?;
        }
    }
    wait_with_timeout(&mut child, budget)?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("{label} output read failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let mut last_lines: Vec<&str> = stderr.lines().rev().take(6).collect();
        last_lines.reverse();
        let stderr = last_lines.join("\n");
        return Err(format!(
            "{label} failed ({}): {stderr}",
            output.status
        ));
    }
    Ok(output.stdout)
}

/// One-off bridge invocation: `python -c <SNIPPET> <instance_dir> <probe>`
/// with the arguments JSON on stdin. The probe name is grammar-validated
/// before it reaches `getattr`.
const BRIDGE_SNIPPET: &str = r#"import json, sys
sys.path.insert(0, sys.argv[1])
import bridge
fn = getattr(bridge, sys.argv[2])
args = json.load(sys.stdin)
out = fn(**args)
print(json.dumps({"probe": sys.argv[2], "result": out}, ensure_ascii=False, default=str))
"#;

fn run_bridge_probe(
    python: &Path,
    instance_dir: &Path,
    probe: &str,
    arguments: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut cmd = Command::new(python);
    cmd.arg("-c")
        .arg(BRIDGE_SNIPPET)
        .arg(instance_dir)
        .arg(probe)
        .env("NEEDLE_TELEMETRY", "0")
        .env("DO_NOT_TRACK", "1")
        .env("PYTHONIOENCODING", "utf-8");
    let stdout = run_captured(
        cmd,
        Some(&arguments.to_string()),
        Duration::from_secs(BRIDGE_TIMEOUT_SECS),
        "bridge",
    )?;
    serde_json::from_slice(&stdout).map_err(|e| {
        format!(
            "bridge output unparseable: {e}; raw head: {}",
            String::from_utf8_lossy(&stdout[..stdout.len().min(400)])
        )
    })
}

// ------------------------------------------------------------------- commands

fn resolve_engine_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(p) = std::env::var("REACTORPRO_NEURALOS_ENGINE") {
        candidates.push(PathBuf::from(p));
    }
    if let Ok(resource) = app.path().resource_dir() {
        #[cfg(target_os = "windows")]
        candidates.push(resource.join("neuralos").join("needle.exe"));
        #[cfg(not(target_os = "windows"))]
        candidates.push(resource.join("neuralos").join("needle"));
    }
    if let Ok(data) = app.path().app_data_dir() {
        #[cfg(target_os = "windows")]
        candidates.push(data.join("neuralos").join("engine").join("needle.exe"));
        #[cfg(not(target_os = "windows"))]
        candidates.push(data.join("neuralos").join("engine").join("needle"));
    }
    candidates
}

fn resolve_cact_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(p) = std::env::var("REACTORPRO_NEURALOS_CACT") {
        candidates.push(PathBuf::from(p));
    }
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("neuralos").join("needle3.cact"));
    }
    if let Ok(data) = app.path().app_data_dir() {
        candidates.push(data.join("neuralos").join("engine").join("needle3.cact"));
    }
    candidates
}

/// Resolve the directory holding the instance fleet plus whether the legacy
/// `~/neuralos-instances` fallback was the winner.
fn resolve_instances_dir(app: &tauri::AppHandle) -> (PathBuf, bool) {
    if let Ok(p) = std::env::var("REACTORPRO_NEURALOS_INSTANCES") {
        return (PathBuf::from(p), false);
    }
    if let Ok(data) = app.path().app_data_dir() {
        let managed = data.join("neuralos").join("neuralos-instances");
        if managed.is_dir() {
            return (managed, false);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let legacy = PathBuf::from(home).join("neuralos-instances");
        if legacy.is_dir() {
            return (legacy, true);
        }
    }
    let fallback = app
        .path()
        .app_data_dir()
        .map(|d| d.join("neuralos").join("neuralos-instances"))
        .unwrap_or_else(|_| PathBuf::from("neuralos-instances"));
    (fallback, false)
}

fn resolve_engine_pair(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let engine = first_existing(&resolve_engine_candidates(app)).ok_or_else(|| {
        "neuralOS engine not installed — set REACTORPRO_NEURALOS_ENGINE, or install \
         the bundled engine (Settings → neuralOS)"
            .to_string()
    })?;
    let cact = first_existing(&resolve_cact_candidates(app)).ok_or_else(|| {
        "needle3.cact weights not found — set REACTORPRO_NEURALOS_CACT or bundle \
         neuralos/needle3.cact"
            .to_string()
    })?;
    Ok((engine, cact))
}

/// Diagnostics for the Settings panel: what resolved, what is missing.
#[tauri::command(rename_all = "camelCase")]
pub async fn neuralos_status(app: tauri::AppHandle) -> Result<NeuralOsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (instances_dir, legacy) = resolve_instances_dir(&app);
        let instances = scan_instances(&instances_dir);
        Ok(NeuralOsStatus {
            engine_path: first_existing(&resolve_engine_candidates(&app))
                .map(|p| p.to_string_lossy().into_owned()),
            cact_path: first_existing(&resolve_cact_candidates(&app))
                .map(|p| p.to_string_lossy().into_owned()),
            python_path: first_existing(&resolve_python_candidates(
                &app.path().app_data_dir().unwrap_or_default(),
            ))
            .map(|p| p.to_string_lossy().into_owned()),
            instances_dir: instances_dir.to_string_lossy().into_owned(),
            legacy_instances_dir_used: legacy,
            instances,
        })
    })
    .await
    .map_err(|e| format!("neuralos_status join failed: {e}"))?
}

/// The instance fleet available to probes.
#[tauri::command(rename_all = "camelCase")]
pub async fn neuralos_list_instances(app: tauri::AppHandle) -> Result<Vec<InstanceInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (dir, _) = resolve_instances_dir(&app);
        Ok(scan_instances(&dir))
    })
    .await
    .map_err(|e| format!("neuralos_list_instances join failed: {e}"))?
}

/// One question in, one validated digest out. The bundled engine selects the
/// probe; the instance bridge executes it; nothing else is trusted.
#[tauri::command(rename_all = "camelCase")]
pub async fn neuralos_run_probe(
    app: tauri::AppHandle,
    instance: String,
    question: String,
) -> Result<ProbeDigest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if instance.contains('/') || instance.contains('\\') || instance.contains("..") {
            return Err(format!("invalid instance name {instance:?}"));
        }
        let (instances_dir, _) = resolve_instances_dir(&app);
        let instance_dir = instances_dir.join(&instance);
        if !instance_dir.join("needle_menu.json").exists()
            || !instance_dir.join("bridge.py").exists()
        {
            return Err(format!(
                "instance {instance:?} not found under {} (needs needle_menu.json + bridge.py)",
                instances_dir.display()
            ));
        }
        let (engine, cact) = resolve_engine_pair(&app)?;
        let app_data = app.path().app_data_dir().unwrap_or_default();
        let python = first_existing(&resolve_python_candidates(&app_data))
            .ok_or("no python interpreter found for instance bridges")?;

        // Phase A — selection.
        let mut select = Command::new(&engine);
        select
            .arg("--model")
            .arg(&cact)
            .arg("--tools")
            .arg(instance_dir.join("needle_menu.json"))
            .arg("--prompt")
            .arg(&question);
        let stdout = run_captured(
            select,
            None,
            Duration::from_secs(ENGINE_TIMEOUT_SECS),
            "engine selection",
        )?;
        let (probe, arguments, confidence) = parse_selection(&stdout)?;
        if !is_valid_probe_name(&probe) {
            return Err(format!("engine selected invalid probe name {probe:?}"));
        }

        // Phase B — execution through the instance bridge.
        let result = run_bridge_probe(&python, &instance_dir, &probe, &arguments)?;
        Ok(ProbeDigest {
            instance,
            probe,
            confidence,
            result,
        })
    })
    .await
    .map_err(|e| format!("neuralos_run_probe join failed: {e}"))?
}

/// Install (copy) a local instance folder into the managed fleet directory.
#[tauri::command(rename_all = "camelCase")]
pub async fn neuralos_install_instance(
    app: tauri::AppHandle,
    source: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(expand_home(&source));
        if !src.join("needle_menu.json").exists() || !src.join("bridge.py").exists() {
            return Err(format!(
                "{} is not a neuralOS instance (needs needle_menu.json + bridge.py)",
                src.display()
            ));
        }
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let fleet = data.join("neuralos").join("neuralos-instances");
        let name = src
            .file_name()
            .ok_or("source has no folder name")?
            .to_string_lossy()
            .into_owned();
        let dest = fleet.join(&name);
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        copy_dir_recursive(&src, &dest)?;
        Ok(name)
    })
    .await
    .map_err(|e| format!("neuralos_install_instance join failed: {e}"))?
}

fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dest.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            if entry.file_name() == "__pycache__" {
                continue;
            }
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // The CI `tauri-rust` job runs this module's tests via the
    // `integration_commands::neuralos` filter.
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "reactorpro-neuralos-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_instances_finds_menus_and_flags_bridges() {
        let root = temp_root("scan");
        let good = root.join("chinook");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(good.join("needle_menu.json"), "[{\"name\":\"a\"}]").unwrap();
        std::fs::write(good.join("bridge.py"), "x = 1").unwrap();
        let menu_only = root.join("half");
        std::fs::create_dir_all(&menu_only).unwrap();
        std::fs::write(menu_only.join("needle_menu.json"), "[]").unwrap();
        std::fs::write(root.join("stray.txt"), "nope").unwrap();

        let found = scan_instances(&root);
        assert_eq!(found.len(), 2);
        let chinook = found.iter().find(|i| i.name == "chinook").unwrap();
        assert_eq!(chinook.probes, 1);
        assert!(chinook.has_bridge);
        let half = found.iter().find(|i| i.name == "half").unwrap();
        assert!(!half.has_bridge);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_instances_missing_dir_is_empty() {
        assert!(scan_instances(Path::new("/nonexistent-neuralos-zz")).is_empty());
    }

    #[test]
    fn probe_name_guard_rejects_injection() {
        assert!(is_valid_probe_name("multi_account_customers"));
        assert!(is_valid_probe_name("_internal"));
        assert!(!is_valid_probe_name(""));
        assert!(!is_valid_probe_name("Bridge"));
        assert!(!is_valid_probe_name("os.system"));
        assert!(!is_valid_probe_name("__import__"));
        assert!(!is_valid_probe_name("a b"));
        assert!(!is_valid_probe_name(&"x".repeat(PROBE_NAME_MAX_LEN + 1)));
    }

    #[test]
    fn parse_selection_reads_call_and_confidence() {
        let raw = br#"{"function_calls":[{"name":"aws_status","arguments":{}}],"confidence":0.96}"#;
        let (name, args, conf) = parse_selection(raw).unwrap();
        assert_eq!(name, "aws_status");
        assert_eq!(args, serde_json::json!({}));
        assert!((conf - 0.96).abs() < 1e-9);
    }

    #[test]
    fn parse_selection_empty_call_is_honest_refusal() {
        let raw = br#"{"function_calls":[],"confidence":0.5}"#;
        let err = parse_selection(raw).unwrap_err();
        assert!(err.contains("no probe selected"), "{err}");
    }

    #[test]
    fn parse_selection_malformed_is_an_error() {
        assert!(parse_selection(b"not json").is_err());
    }

    #[test]
    fn wait_with_timeout_kills_runaway_children() {
        let mut child = if cfg!(target_os = "windows") {
            Command::new("cmd")
                .arg("/c")
                .arg("ping -n 30 127.0.0.1 > nul")
                .spawn()
                .unwrap()
        } else {
            Command::new("sleep").arg("30").spawn().unwrap()
        };
        let started = Instant::now();
        let err = wait_with_timeout(&mut child, Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
        let _ = child.wait();
    }

    #[test]
    fn run_bridge_probe_round_trips_arguments() {
        // Uses the real python3 but a stub bridge — proves the stdin/argv
        // plumbing without any instance fleet.
        let python = if cfg!(target_os = "windows") { "python" } else { "python3" };
        let root = temp_root("bridge");
        std::fs::write(
            root.join("bridge.py"),
            "TOYS = {'echo': lambda **kw: {'echo': kw}}\n",
        )
        .unwrap();
        std::fs::write(root.join("needle_menu.json"), "[]").unwrap();
        let mut cmd = Command::new(python);
        cmd.arg("-c")
            .arg(BRIDGE_SNIPPET)
            .arg(&root)
            .arg("echo")
            .env("NEEDLE_TELEMETRY", "0");
        let stdout = run_captured(
            cmd,
            Some(r#"{"word":"ping"}"#),
            Duration::from_secs(30),
            "bridge",
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
        assert_eq!(parsed["probe"], "echo");
        assert_eq!(parsed["result"]["echo"]["word"], "ping");
        let _ = std::fs::remove_dir_all(&root);
    }
}
