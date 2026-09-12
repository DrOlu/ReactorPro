//! Scans MCP servers already configured by other AI tools on this machine
//! (Claude Code / Codex / Claude Desktop / CodeBuddy), and parses a
//! user-selected local config file ([`scan_mcp_config_file`]) for the MCP Hub
//! "Local Import" page to display so the user can check and import entries. The
//! import itself is a pure frontend settings write (appending to
//! `AppSettings.mcp.servers`); this module only reads and parses configuration.
//!
//! Fixed-path scanning is fully fault-tolerant: a single file / single entry
//! parse failure is only recorded in `errors` and never fails the whole scan;
//! for a manually selected file ([`scan_mcp_config_file`]), an unusable file
//! errors out directly. Any value containing `${VAR}` expansion syntax is kept
//! as-is for the user to adjust after import.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use super::types::{SystemExternalMcpServerEntry, SystemExternalMcpToolScan};
use super::util::strip_utf8_bom;
use crate::runtime::platform::expand_tilde_path;

const TRANSPORT_STDIO: &str = "stdio";
const TRANSPORT_HTTP: &str = "http";
const TRANSPORT_SSE: &str = "sse";

/// Source identifier for "Import from File"; the frontend uses it to display this separately from fixed-tool scans.
pub(crate) const LOCAL_FILE_MCP_TOOL: &str = "local-file";

/// Size cap for a manually selected config file, so a mistakenly chosen large file does not read its entire contents into memory.
const MAX_MCP_CONFIG_FILE_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) fn scan_external_mcp_servers() -> Vec<SystemExternalMcpToolScan> {
    vec![
        scan_claude_code(),
        scan_codex(),
        scan_claude_desktop(),
        scan_codebuddy(),
    ]
}

/// Parses a user-selected local MCP config file, used by MCP Hub's "Local Import"
/// "Import from File" feature.
///
/// Two format families are distinguished by extension:
/// - `.toml`: Codex-style `[mcp_servers.*]` sections
/// - everything else as JSON: a top-level `mcpServers` object (including
///   `projects.<path>.mcpServers`), or a bare format where the entire root object
///   is the server map `{ "<id>": { ... } }`
///
/// Unlike the fault-tolerant fixed-path scan, an unreadable file, a syntax error,
/// or finding no server definitions at all returns `Err` directly so the frontend
/// can report it clearly; a single entry failure is still recorded in `errors` and skipped.
pub(crate) fn scan_mcp_config_file(path: &str) -> Result<SystemExternalMcpToolScan, String> {
    let file = expand_tilde_path(path.trim());
    let metadata = std::fs::metadata(&file)
        .map_err(|err| format!("Cannot access config file {}: {err}", file.display()))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", file.display()));
    }
    if metadata.len() > MAX_MCP_CONFIG_FILE_BYTES {
        return Err(format!(
            "Config file too large: {} ({} bytes, max {MAX_MCP_CONFIG_FILE_BYTES} bytes)",
            file.display(),
            metadata.len(),
        ));
    }
    let display = file.display().to_string();
    let text =
        std::fs::read_to_string(&file).map_err(|err| format!("Failed to read {display}: {err}"))?;

    let is_toml = file
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("toml"));

    let mut servers = Vec::new();
    let mut errors = Vec::new();
    if is_toml {
        parse_mcp_config_toml(&text, &display, &mut servers, &mut errors)?;
    } else {
        parse_mcp_config_json(&text, &display, &mut servers, &mut errors)?;
    }
    if servers.is_empty() {
        let mut message = format!("No MCP server definitions found in {display}");
        // When an unrelated JSON file (e.g. a large locale file) is picked by mistake,
        // there may be thousands of entry errors; show only the first few.
        if !errors.is_empty() {
            const MAX_SHOWN_ERRORS: usize = 3;
            let shown = errors
                .iter()
                .take(MAX_SHOWN_ERRORS)
                .cloned()
                .collect::<Vec<_>>()
                .join("; ");
            if errors.len() > MAX_SHOWN_ERRORS {
                message.push_str(&format!(
                    " ({shown}; … and {} more)",
                    errors.len() - MAX_SHOWN_ERRORS
                ));
            } else {
                message.push_str(&format!(" ({shown})"));
            }
        }
        return Err(message);
    }
    Ok(finish_scan(
        LOCAL_FILE_MCP_TOOL,
        vec![display.clone()],
        &display,
        servers,
        errors,
    ))
}

fn parse_mcp_config_json(
    text: &str,
    display: &str,
    servers: &mut Vec<SystemExternalMcpServerEntry>,
    errors: &mut Vec<String>,
) -> Result<(), String> {
    let root: Value = serde_json::from_str(strip_utf8_bom(text))
        .map_err(|err| format!("Failed to parse {display}: {err}"))?;
    let Some(map) = root.as_object() else {
        return Err(format!("Config root must be a JSON object: {display}"));
    };
    if map.contains_key("mcpServers") || map.contains_key("projects") {
        collect_json_server_map(map.get("mcpServers"), "user", servers, errors);
        if let Some(projects) = map.get("projects").and_then(Value::as_object) {
            for (project_path, project) in projects {
                collect_json_server_map(project.get("mcpServers"), project_path, servers, errors);
            }
        }
    } else {
        // Without the `mcpServers` wrapper, parse as a bare server map.
        collect_json_server_map(Some(&root), "user", servers, errors);
    }
    Ok(())
}

fn parse_mcp_config_toml(
    text: &str,
    display: &str,
    servers: &mut Vec<SystemExternalMcpServerEntry>,
    errors: &mut Vec<String>,
) -> Result<(), String> {
    // Use only message(), not Display: Display would render the offending source
    // line into the error message, echoing file contents back to the caller
    // (including the remote gateway) when a sensitive file is picked by mistake.
    let root: toml::Value = toml::from_str(strip_utf8_bom(text))
        .map_err(|err| format!("Failed to parse {display}: {}", err.message()))?;
    let Some(map) = root.get("mcp_servers").and_then(toml::Value::as_table) else {
        return Err(format!("No [mcp_servers] section found in {display}"));
    };
    for (name, entry) in map {
        match toml_entry_to_server(name, entry) {
            Ok(server) => servers.push(server),
            Err(err) => errors.push(err),
        }
    }
    Ok(())
}

fn scan_claude_code() -> SystemExternalMcpToolScan {
    // Claude Code's MCP configuration lives in two places:
    // - ~/.claude.json: top-level `mcpServers` (user scope) + `projects.<path>.mcpServers` (project-local scope)
    // - ~/.mcp.json: project-shared configuration (takes effect when a session starts in home)
    let mut servers = Vec::new();
    let mut errors = Vec::new();
    let mut scanned_paths = Vec::new();

    let claude_json = expand_tilde_path("~/.claude.json");
    if claude_json.is_file() {
        scanned_paths.push("~/.claude.json".to_string());
        match read_json(&claude_json) {
            Ok(root) => {
                collect_json_server_map(root.get("mcpServers"), "user", &mut servers, &mut errors);
                if let Some(projects) = root.get("projects").and_then(Value::as_object) {
                    for (project_path, project) in projects {
                        collect_json_server_map(
                            project.get("mcpServers"),
                            project_path,
                            &mut servers,
                            &mut errors,
                        );
                    }
                }
            }
            Err(err) => errors.push(err),
        }
    }

    let mcp_json = expand_tilde_path("~/.mcp.json");
    if mcp_json.is_file() {
        scanned_paths.push("~/.mcp.json".to_string());
        match read_json(&mcp_json) {
            Ok(root) => {
                collect_json_server_map(root.get("mcpServers"), "user", &mut servers, &mut errors);
            }
            Err(err) => errors.push(err),
        }
    }

    finish_scan(
        "claude-code",
        scanned_paths,
        "~/.claude.json",
        servers,
        errors,
    )
}

fn scan_codex() -> SystemExternalMcpToolScan {
    let mut servers = Vec::new();
    let mut errors = Vec::new();
    let mut scanned_paths = Vec::new();

    let config_toml = expand_tilde_path("~/.codex/config.toml");
    if config_toml.is_file() {
        scanned_paths.push("~/.codex/config.toml".to_string());
        match std::fs::read_to_string(&config_toml) {
            Ok(text) => parse_codex_toml(&text, &mut servers, &mut errors),
            Err(err) => errors.push(format!("Failed to read {}: {err}", config_toml.display())),
        }
    }

    finish_scan(
        "codex",
        scanned_paths,
        "~/.codex/config.toml",
        servers,
        errors,
    )
}

fn scan_claude_desktop() -> SystemExternalMcpToolScan {
    // Windows: %APPDATA%/Claude；macOS: ~/Library/Application Support/Claude；
    // Linux: ~/.config/Claude. dirs::config_dir corresponds one-to-one with all three.
    let mut servers = Vec::new();
    let mut errors = Vec::new();
    let mut scanned_paths = Vec::new();

    let config_path = claude_desktop_config_path();
    let display_path = config_path
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "Claude/claude_desktop_config.json".to_string());
    if let Some(path) = config_path {
        if path.is_file() {
            scanned_paths.push(display_path.clone());
            match read_json(&path) {
                Ok(root) => {
                    collect_json_server_map(
                        root.get("mcpServers"),
                        "user",
                        &mut servers,
                        &mut errors,
                    );
                }
                Err(err) => errors.push(err),
            }
        }
    }

    finish_scan(
        "claude-desktop",
        scanned_paths,
        &display_path,
        servers,
        errors,
    )
}

fn claude_desktop_config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("Claude").join("claude_desktop_config.json"))
}

fn scan_codebuddy() -> SystemExternalMcpToolScan {
    // CodeBuddy Code user-level MCP configuration: ~/.codebuddy/mcp.json, a standard `mcpServers` object.
    let mut servers = Vec::new();
    let mut errors = Vec::new();
    let mut scanned_paths = Vec::new();

    let mcp_json = expand_tilde_path("~/.codebuddy/mcp.json");
    if mcp_json.is_file() {
        scanned_paths.push("~/.codebuddy/mcp.json".to_string());
        match read_json(&mcp_json) {
            Ok(root) => {
                collect_json_server_map(root.get("mcpServers"), "user", &mut servers, &mut errors);
            }
            Err(err) => errors.push(err),
        }
    }

    finish_scan(
        "codebuddy",
        scanned_paths,
        "~/.codebuddy/mcp.json",
        servers,
        errors,
    )
}

fn finish_scan(
    tool: &str,
    scanned_paths: Vec<String>,
    default_path: &str,
    mut servers: Vec<SystemExternalMcpServerEntry>,
    errors: Vec<String>,
) -> SystemExternalMcpToolScan {
    let exists = !scanned_paths.is_empty();
    // For duplicate names (the same server declared in multiple scopes), keep the
    // first occurrence: user scope is scanned first, making precedence more intuitive.
    let mut seen = std::collections::HashSet::new();
    servers.retain(|server| seen.insert(server.id.to_lowercase()));
    servers.sort_by_key(|a| a.id.to_lowercase());
    SystemExternalMcpToolScan {
        tool: tool.to_string(),
        config_path: if scanned_paths.is_empty() {
            default_path.to_string()
        } else {
            scanned_paths.join(" + ")
        },
        exists,
        servers,
        errors,
    }
}

fn read_json(path: &std::path::Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("Failed to parse {}: {err}", path.display()))
}

/// Parses a Claude Code / Claude Desktop style `mcpServers` JSON object.
pub(crate) fn collect_json_server_map(
    map: Option<&Value>,
    origin: &str,
    servers: &mut Vec<SystemExternalMcpServerEntry>,
    errors: &mut Vec<String>,
) {
    let Some(map) = map.and_then(Value::as_object) else {
        return;
    };
    for (name, entry) in map {
        match json_entry_to_server(name, entry, origin) {
            Ok(server) => servers.push(server),
            Err(err) => errors.push(err),
        }
    }
}

fn json_entry_to_server(
    name: &str,
    entry: &Value,
    origin: &str,
) -> Result<SystemExternalMcpServerEntry, String> {
    if name.trim().is_empty() {
        return Err("MCP server has an empty name".to_string());
    }
    let entry = entry
        .as_object()
        .ok_or_else(|| format!("MCP server \"{name}\" is not an object"))?;
    let command = string_field(entry.get("command"));
    let url = string_field(entry.get("url"));
    let declared_type = string_field(entry.get("type")).to_lowercase();

    let transport = match declared_type.as_str() {
        TRANSPORT_HTTP | "streamable-http" | "streamable_http" => TRANSPORT_HTTP,
        TRANSPORT_SSE => TRANSPORT_SSE,
        TRANSPORT_STDIO => TRANSPORT_STDIO,
        // When type is absent, infer from the fields: command -> stdio; url -> http.
        "" if !command.is_empty() => TRANSPORT_STDIO,
        "" if !url.is_empty() => TRANSPORT_HTTP,
        other => {
            return Err(format!(
                "MCP server \"{name}\" has unsupported type \"{other}\""
            ))
        }
    };
    if transport == TRANSPORT_STDIO && command.is_empty() {
        return Err(format!("MCP server \"{name}\" is missing command"));
    }
    if transport != TRANSPORT_STDIO && url.is_empty() {
        return Err(format!("MCP server \"{name}\" is missing url"));
    }

    Ok(SystemExternalMcpServerEntry {
        id: name.to_string(),
        transport: transport.to_string(),
        command,
        args: string_list(entry.get("args")),
        url,
        env: string_map(entry.get("env")),
        headers: string_map(entry.get("headers")),
        cwd: {
            let cwd = string_field(entry.get("cwd"));
            (!cwd.is_empty()).then_some(cwd)
        },
        timeout_ms: entry.get("timeout").and_then(Value::as_u64),
        origin: origin.to_string(),
    })
}

/// Parses the `[mcp_servers.*]` sections of a Codex `config.toml`.
pub(crate) fn parse_codex_toml(
    text: &str,
    servers: &mut Vec<SystemExternalMcpServerEntry>,
    errors: &mut Vec<String>,
) {
    let root: toml::Value = match toml::from_str(text) {
        Ok(value) => value,
        Err(err) => {
            errors.push(format!("Failed to parse ~/.codex/config.toml: {err}"));
            return;
        }
    };
    let Some(map) = root.get("mcp_servers").and_then(toml::Value::as_table) else {
        return;
    };
    for (name, entry) in map {
        match toml_entry_to_server(name, entry) {
            Ok(server) => servers.push(server),
            Err(err) => errors.push(err),
        }
    }
}

fn toml_entry_to_server(
    name: &str,
    entry: &toml::Value,
) -> Result<SystemExternalMcpServerEntry, String> {
    if name.trim().is_empty() {
        return Err("MCP server has an empty name".to_string());
    }
    let entry = entry
        .as_table()
        .ok_or_else(|| format!("MCP server \"{name}\" is not a table"))?;
    let command = toml_string(entry.get("command"));
    let url = toml_string(entry.get("url"));
    let declared_type = toml_string(entry.get("type")).to_lowercase();

    let transport = match declared_type.as_str() {
        TRANSPORT_HTTP | "streamable-http" | "streamable_http" => TRANSPORT_HTTP,
        TRANSPORT_SSE => TRANSPORT_SSE,
        TRANSPORT_STDIO => TRANSPORT_STDIO,
        "" if !command.is_empty() => TRANSPORT_STDIO,
        "" if !url.is_empty() => TRANSPORT_HTTP,
        other => {
            return Err(format!(
                "MCP server \"{name}\" has unsupported type \"{other}\""
            ))
        }
    };
    if transport == TRANSPORT_STDIO && command.is_empty() {
        return Err(format!("MCP server \"{name}\" is missing command"));
    }
    if transport != TRANSPORT_STDIO && url.is_empty() {
        return Err(format!("MCP server \"{name}\" is missing url"));
    }

    let mut headers = BTreeMap::new();
    if let Some(table) = entry.get("http_headers").and_then(toml::Value::as_table) {
        for (key, value) in table {
            headers.insert(key.clone(), toml_string(Some(value)));
        }
    }

    let mut env = BTreeMap::new();
    if let Some(table) = entry.get("env").and_then(toml::Value::as_table) {
        for (key, value) in table {
            env.insert(key.clone(), toml_string(Some(value)));
        }
    }

    Ok(SystemExternalMcpServerEntry {
        id: name.to_string(),
        transport: transport.to_string(),
        command,
        args: entry
            .get("args")
            .and_then(toml::Value::as_array)
            .map(|items| items.iter().map(|item| toml_string(Some(item))).collect())
            .unwrap_or_default(),
        url,
        env,
        headers,
        cwd: {
            let cwd = toml_string(entry.get("cwd"));
            (!cwd.is_empty()).then_some(cwd)
        },
        timeout_ms: entry
            .get("startup_timeout_ms")
            .and_then(toml::Value::as_integer)
            .and_then(|value| u64::try_from(value).ok()),
        origin: "user".to_string(),
    })
}

fn string_field(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn toml_string(value: Option<&toml::Value>) -> String {
    value
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::skills::util::TempDir;

    fn write_config(dir: &TempDir, name: &str, content: &str) -> String {
        let path = dir.path().join(name);
        std::fs::write(&path, content).expect("write config file");
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn scan_mcp_config_file_parses_claude_style_json() {
        let tmp = TempDir::new("liveagent-mcp-file-claude-test").expect("temp dir");
        let path = write_config(
            &tmp,
            "config.json",
            r#"{
                "mcpServers": { "files": { "command": "npx", "args": ["-y", "server-files"] } },
                "projects": {
                    "/repo": { "mcpServers": { "search": { "type": "http", "url": "https://mcp.example.com" } } }
                }
            }"#,
        );
        let scan = scan_mcp_config_file(&path).expect("scan file");

        assert_eq!(scan.tool, LOCAL_FILE_MCP_TOOL);
        assert!(scan.exists);
        assert!(
            scan.errors.is_empty(),
            "unexpected errors: {:?}",
            scan.errors
        );
        assert_eq!(scan.servers.len(), 2);
        let files = scan.servers.iter().find(|s| s.id == "files").unwrap();
        assert_eq!(files.transport, "stdio");
        assert_eq!(files.origin, "user");
        let search = scan.servers.iter().find(|s| s.id == "search").unwrap();
        assert_eq!(search.transport, "http");
        assert_eq!(search.origin, "/repo");
    }

    #[test]
    fn scan_mcp_config_file_parses_bare_server_map_json() {
        let tmp = TempDir::new("liveagent-mcp-file-bare-test").expect("temp dir");
        let path = write_config(
            &tmp,
            "servers.json",
            r#"{ "files": { "command": "npx" }, "broken": { "args": [] } }"#,
        );
        let scan = scan_mcp_config_file(&path).expect("scan file");

        assert_eq!(scan.servers.len(), 1);
        assert_eq!(scan.servers[0].id, "files");
        assert_eq!(scan.errors.len(), 1);
        assert!(scan.errors[0].contains("broken"));
    }

    #[test]
    fn scan_mcp_config_file_parses_codex_toml() {
        let tmp = TempDir::new("liveagent-mcp-file-toml-test").expect("temp dir");
        let path = write_config(
            &tmp,
            "config.toml",
            r#"
[mcp_servers.commander]
command = "cmd"
args = ["/c", "npx"]

[mcp_servers.remote]
url = "https://mcp.example.com"
"#,
        );
        let scan = scan_mcp_config_file(&path).expect("scan file");

        assert!(
            scan.errors.is_empty(),
            "unexpected errors: {:?}",
            scan.errors
        );
        assert_eq!(scan.servers.len(), 2);
        let commander = scan.servers.iter().find(|s| s.id == "commander").unwrap();
        assert_eq!(commander.transport, "stdio");
        let remote = scan.servers.iter().find(|s| s.id == "remote").unwrap();
        assert_eq!(remote.transport, "http");
    }

    #[test]
    fn scan_mcp_config_file_rejects_empty_server_names() {
        let tmp = TempDir::new("liveagent-mcp-file-empty-id-test").expect("temp dir");
        let path = write_config(
            &tmp,
            "servers.json",
            r#"{ "": { "command": "x" }, "  ": { "command": "y" }, "ok": { "command": "z" } }"#,
        );
        let scan = scan_mcp_config_file(&path).expect("scan file");

        assert_eq!(scan.servers.len(), 1);
        assert_eq!(scan.servers[0].id, "ok");
        assert_eq!(scan.errors.len(), 2);
        assert!(scan.errors.iter().all(|err| err.contains("empty name")));
    }

    #[test]
    fn scan_mcp_config_file_caps_joined_errors_in_no_server_message() {
        let tmp = TempDir::new("liveagent-mcp-file-error-cap-test").expect("temp dir");
        let entries = (0..10)
            .map(|index| format!("\"key{index}\": \"value\""))
            .collect::<Vec<_>>()
            .join(", ");
        let path = write_config(&tmp, "flat.json", &format!("{{ {entries} }}"));
        let err = scan_mcp_config_file(&path).unwrap_err();

        assert!(err.contains("No MCP server definitions found"));
        assert!(err.contains("… and 7 more"));
    }

    #[test]
    fn scan_mcp_config_file_rejects_invalid_and_empty_sources() {
        let tmp = TempDir::new("liveagent-mcp-file-invalid-test").expect("temp dir");

        let missing = tmp
            .path()
            .join("missing.json")
            .to_string_lossy()
            .into_owned();
        assert!(scan_mcp_config_file(&missing)
            .unwrap_err()
            .contains("Cannot access config file"));

        let invalid = write_config(&tmp, "invalid.json", "{ not json");
        assert!(scan_mcp_config_file(&invalid)
            .unwrap_err()
            .contains("Failed to parse"));

        let not_object = write_config(&tmp, "array.json", r#"["a", "b"]"#);
        assert!(scan_mcp_config_file(&not_object)
            .unwrap_err()
            .contains("must be a JSON object"));

        // Ordinary JSON such as package.json: all entries fail to parse -> a whole-file error carrying the reason.
        let unrelated = write_config(&tmp, "package.json", r#"{ "name": "x", "version": "1" }"#);
        let err = scan_mcp_config_file(&unrelated).unwrap_err();
        assert!(err.contains("No MCP server definitions found"));
        assert!(err.contains("is not an object"));

        let no_section = write_config(&tmp, "plain.toml", "model = \"custom\"\n");
        assert!(scan_mcp_config_file(&no_section)
            .unwrap_err()
            .contains("No [mcp_servers] section"));
    }

    #[test]
    fn parses_claude_json_stdio_and_http_entries() {
        let root: Value = serde_json::from_str(
            r#"{
                "mcpServers": {
                    "files": { "command": "npx", "args": ["-y", "server-files"], "env": { "HOME": "/tmp" } },
                    "search": { "type": "http", "url": "https://mcp.example.com/v1", "headers": { "Authorization": "Bearer x" } },
                    "legacy": { "type": "sse", "url": "https://sse.example.com" },
                    "broken": { "args": ["no-command"] }
                }
            }"#,
        )
        .unwrap();
        let mut servers = Vec::new();
        let mut errors = Vec::new();
        collect_json_server_map(root.get("mcpServers"), "user", &mut servers, &mut errors);

        assert_eq!(servers.len(), 3);
        let files = servers.iter().find(|s| s.id == "files").unwrap();
        assert_eq!(files.transport, "stdio");
        assert_eq!(files.command, "npx");
        assert_eq!(files.args, vec!["-y", "server-files"]);
        assert_eq!(files.env.get("HOME").map(String::as_str), Some("/tmp"));

        let search = servers.iter().find(|s| s.id == "search").unwrap();
        assert_eq!(search.transport, "http");
        assert_eq!(search.url, "https://mcp.example.com/v1");
        assert_eq!(
            search.headers.get("Authorization").map(String::as_str),
            Some("Bearer x")
        );

        let legacy = servers.iter().find(|s| s.id == "legacy").unwrap();
        assert_eq!(legacy.transport, "sse");

        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("broken"));
    }

    #[test]
    fn parses_codex_toml_entries() {
        let text = r#"
model_provider = "custom"

[mcp_servers.desktop-commander]
type = "stdio"
command = "cmd"
args = ["/c", "npx", "-y", "@wonderwhy-er/desktop-commander@latest"]
startup_timeout_ms = 20000

[mcp_servers.desktop-commander.env]
SystemRoot = 'C:\Windows'

[mcp_servers.remote]
url = "https://mcp.example.com"
"#;
        let mut servers = Vec::new();
        let mut errors = Vec::new();
        parse_codex_toml(text, &mut servers, &mut errors);

        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(servers.len(), 2);
        let commander = servers
            .iter()
            .find(|s| s.id == "desktop-commander")
            .unwrap();
        assert_eq!(commander.transport, "stdio");
        assert_eq!(commander.command, "cmd");
        assert_eq!(commander.timeout_ms, Some(20_000));
        assert_eq!(
            commander.env.get("SystemRoot").map(String::as_str),
            Some("C:\\Windows")
        );
        let remote = servers.iter().find(|s| s.id == "remote").unwrap();
        assert_eq!(remote.transport, "http");
    }

    #[test]
    fn dedupes_by_id_keeping_first_scope() {
        let user: Value = serde_json::from_str(
            r#"{ "a": { "command": "user-a" }, "b": { "command": "user-b" } }"#,
        )
        .unwrap();
        let project: Value =
            serde_json::from_str(r#"{ "a": { "command": "project-a" } }"#).unwrap();
        let mut servers = Vec::new();
        let mut errors = Vec::new();
        collect_json_server_map(Some(&user), "user", &mut servers, &mut errors);
        collect_json_server_map(Some(&project), "E:/proj", &mut servers, &mut errors);

        let scan = finish_scan(
            "claude-code",
            vec!["~/.claude.json".into()],
            "",
            servers,
            errors,
        );
        assert_eq!(scan.servers.len(), 2);
        let a = scan.servers.iter().find(|s| s.id == "a").unwrap();
        assert_eq!(a.command, "user-a");
        assert_eq!(a.origin, "user");
    }
}
