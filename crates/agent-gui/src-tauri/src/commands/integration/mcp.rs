use reqwest::blocking::Client as HttpClient;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::StatusCode;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use crate::runtime::platform::{
    expand_tilde_path, maybe_augment_macos_path, resolve_program_path_with_current_dir,
};
use crate::runtime::process::{configure_child_process_group, kill_child_process_tree_best_effort};
use crate::runtime::shell_runner::ShellRunRegistry;

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const LEGACY_SSE_ENDPOINT_WAIT_MS: u64 = 3_000;
const STDERR_TAIL_MAX_LINES: usize = 200;

pub(crate) async fn run_blocking<R: Send + 'static>(
    label: &'static str,
    f: impl FnOnce() -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("{label} join failed: {e}"))?
}

/// OAuth authentication config (docs/design/mcp-oauth.md). Absent / `type:"none"` = current behavior
/// (static `headers` keep applying); when `type:"oauth"` and the transport is http/sse,
/// Bearer injection and the 401 refresh chain are enabled.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthConfig {
    #[serde(rename = "type")]
    pub auth_type: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub enabled: bool,
    pub transport: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub env: Option<BTreeMap<String, String>>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub headers: Option<BTreeMap<String, String>>,
    pub timeout_ms: Option<u64>,
    pub message_url: Option<String>,
    #[serde(default)]
    pub auth: Option<McpAuthConfig>,
}

impl McpServerConfig {
    fn transport(&self) -> &str {
        self.transport.as_deref().unwrap_or("stdio")
    }

    fn timeout(&self) -> Duration {
        let ms = self.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(1);
        Duration::from_millis(ms)
    }

    pub(crate) fn url_trimmed(&self) -> Option<&str> {
        self.url
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
    }

    fn message_url_trimmed(&self) -> Option<&str> {
        self.message_url
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
    }

    pub(crate) fn oauth_enabled(&self) -> bool {
        matches!(self.transport().trim(), "http" | "sse")
            && self
                .auth
                .as_ref()
                .is_some_and(|auth| auth.auth_type.trim() == "oauth")
    }

    pub(crate) fn oauth_server(&self) -> Option<crate::services::mcp_oauth::OauthServer> {
        let url = self.url_trimmed()?;
        let auth = self.auth.as_ref();
        Some(crate::services::mcp_oauth::OauthServer {
            id: self.id.trim().to_string(),
            url: url.to_string(),
            scope_override: auth
                .and_then(|a| a.scope.clone())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            static_client_id: auth
                .and_then(|a| a.client_id.clone())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        })
    }
}

fn build_stdio_command(cmd: &str, args: &[String], cwd: Option<&Path>) -> Command {
    let program = resolve_program_path_with_current_dir(cmd, cwd);

    #[cfg(windows)]
    {
        if is_windows_batch_program(&program) {
            use std::os::windows::process::CommandExt;

            // .cmd/.bat cannot be executed directly by CreateProcess; they must be
            // forwarded through cmd.exe. The command line after /C must be passed
            // verbatim with raw_arg: arg() escapes embedded quotes as `\"` per MSVCRT
            // rules, which cmd.exe does not recognize, so the child process exits
            // immediately and writing to stdin reports os error 232 (issue #205).
            // /E:ON keeps command extensions enabled (the `%%cd:~,` anti-expansion
            // hack depends on it); /V:OFF disables delayed expansion so `!VAR!` in
            // arguments is not substituted; both align with std
            // `make_bat_command_line`'s `/e:ON /v:OFF`.
            let mut command = Command::new("cmd.exe");
            command
                .arg("/E:ON")
                .arg("/V:OFF")
                .arg("/D")
                .arg("/S")
                .arg("/C");
            command.raw_arg(windows_cmd_c_argument(&program, args));
            return command;
        }
    }

    let mut command = Command::new(program);
    command.args(args);
    command
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_windows_batch_program(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

/// Assemble the entire command line after `cmd.exe /S /C`: wrap it in another pair
/// of quotes; under `/S` semantics cmd strips only the leading/trailing quotes and
/// executes the rest verbatim.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_cmd_c_argument(program: &Path, args: &[String]) -> String {
    let line = std::iter::once(program.to_string_lossy().into_owned())
        .chain(args.iter().cloned())
        .map(|value| windows_cmd_quote_arg(&value))
        .collect::<Vec<_>>()
        .join(" ");
    format!("\"{line}\"")
}

/// Quote-wrap a single argument, with escaping rules aligned to std
/// `sys/args/windows.rs::append_bat_arg`:
/// - backslashes before an embedded quote are padded to 2n and then the quote is
///   doubled (cmd.exe does not recognize `\"`);
/// - trailing backslashes before the closing quote are likewise doubled, so an
///   argument like `C:\dir\` cannot escape the closing quote and merge with the
///   next argument;
/// - before `%`/`\r`, insert the `%%cd:~,` no-op (the yt-dlp hack, which relies on
///   `/E:ON`) to stop `%VAR%` from being expanded as an environment variable by
///   cmd, while the child still receives the original text.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_cmd_quote_arg(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    let mut backslashes = 0usize;
    for ch in value.chars() {
        if ch == '\\' {
            backslashes += 1;
        } else {
            if ch == '"' {
                escaped.extend(std::iter::repeat_n('\\', backslashes));
                escaped.push('"');
            } else if ch == '%' || ch == '\r' {
                escaped.push_str("%%cd:~,");
            }
            backslashes = 0;
        }
        escaped.push(ch);
    }
    escaped.extend(std::iter::repeat_n('\\', backslashes));
    escaped.push('"');
    escaped
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server_id: String,
    pub server_label: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Tool result content block sent to the frontend.
///
/// Beware of a serde pitfall: `rename_all` on an enum only renames **variant names**
/// (`Image` → `"image"`), **not the fields inside variants** — fields need their own
/// `rename_all` on the variant. If you miss it, `mime_type` goes out as snake_case
/// while the TS side (pi-ai, UI preview) reads `mimeType`, gets undefined, and builds
/// `data:undefined;base64,…`; when the next request carries this tool result, the
/// provider rejects the whole thing. The field shape is pinned by
/// `mcp_content_image_serializes_camel_case`.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpContent {
    Text {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        data: String,
        mime_type: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallToolResponse {
    pub content: Vec<McpContent>,
    pub is_error: bool,
    pub details: Value,
}

#[derive(Default)]
pub struct McpRuntimeManager {
    clients: Mutex<HashMap<String, Arc<Mutex<McpClient>>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeStatus {
    pub server_id: String,
    pub running: bool,
    pub initialized: bool,
    pub transport: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStopServerResponse {
    pub server_id: String,
    pub stopped: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiagnosticToolInfo {
    pub server_id: String,
    pub server_label: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeTestResponse {
    pub server_id: String,
    pub ok: bool,
    pub phase: String,
    pub transport: String,
    pub duration_ms: u128,
    pub running: bool,
    pub initialized: bool,
    pub tools_count: usize,
    pub tools: Vec<McpDiagnosticToolInfo>,
    pub error: Option<String>,
    pub stderr_tail: Option<String>,
    /// Authorization diagnostics when oauth is enabled (status/expiry/storage backend), never containing the token itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<crate::services::mcp_oauth::OauthStatusInfo>,
}

fn oauth_diag(cfg: &McpServerConfig) -> Option<crate::services::mcp_oauth::OauthStatusInfo> {
    if !cfg.oauth_enabled() {
        return None;
    }
    cfg.oauth_server()
        .map(|server| crate::services::mcp_oauth::status(&server))
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

#[derive(Debug)]
enum McpTransportError {
    Message(String),
    SessionExpired404,
    /// 401 when oauth is enabled: the upper layer does one passive refresh retry, and if that is not viable it converts to a marker error.
    Unauthorized,
}

impl McpTransportError {
    fn msg(s: impl Into<String>) -> Self {
        Self::Message(s.into())
    }
}

fn build_header_map(headers: &Option<BTreeMap<String, String>>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    let Some(headers) = headers else {
        return Ok(map);
    };
    for (k, v) in headers {
        let name =
            HeaderName::from_bytes(k.as_bytes()).map_err(|_| format!("invalid header name: {k}"))?;
        let value = HeaderValue::from_str(v).map_err(|_| format!("invalid header value: {k}"))?;
        map.insert(name, value);
    }
    Ok(map)
}

/// Merge static headers with the OAuth Bearer. The Bearer must overwrite a
/// same-named entry via `HeaderMap::insert`: if a leftover `Authorization` from the
/// static config (e.g. a manually entered token from before migrating to OAuth)
/// were appended via reqwest `RequestBuilder::header` (append semantics), the
/// request would carry two Authorization headers, and the server/proxy could pick
/// the wrong credential or reject it outright.
fn headers_with_bearer(static_headers: &HeaderMap, bearer: Option<&str>) -> HeaderMap {
    let mut merged = static_headers.clone();
    if let Some(bearer) = bearer {
        if let Ok(value) = HeaderValue::from_str(&format!("Bearer {bearer}")) {
            merged.insert(AUTHORIZATION, value);
        }
    }
    merged
}

fn append_stderr_tail(tail: &Arc<Mutex<Vec<String>>>, line: String) {
    if line.is_empty() {
        return;
    }
    if let Ok(mut buf) = tail.lock() {
        buf.push(line);
        if buf.len() > STDERR_TAIL_MAX_LINES {
            let drain = buf.len() - STDERR_TAIL_MAX_LINES;
            buf.drain(0..drain);
        }
    }
}

fn parse_jsonrpc_result(method: &str, id: u64, msg: &Value) -> Result<Value, String> {
    let msg_id = msg.get("id");
    if msg_id != Some(&json!(id)) {
        return Err(format!(
            "MCP response id mismatch: method={method} id={id} msg={msg}"
        ));
    }

    if let Some(err) = msg.get("error") {
        let rpc_err: JsonRpcError = serde_json::from_value(err.clone()).unwrap_or(JsonRpcError {
            code: -1,
            message: err.to_string(),
        });
        return Err(format!(
            "MCP call failed: method={method} code={} message={}",
            rpc_err.code, rpc_err.message
        ));
    }

    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

fn read_sse_for_matching_id<R: BufRead>(
    reader: &mut R,
    method: &str,
    id: u64,
) -> Result<Value, String> {
    let mut line = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read the SSE stream: {e}"))?;
        if n == 0 {
            return Err(format!(
                "The SSE stream closed before a response was received: method={method} id={id}"
            ));
        }

        let l = line.trim_end_matches(['\r', '\n']);
        if l.is_empty() {
            // dispatch
            if data_lines.is_empty() {
                continue;
            }

            let data = data_lines.join("\n");
            data_lines.clear();

            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                if v.get("id") == Some(&json!(id)) {
                    return Ok(v);
                }
            }

            continue;
        }

        if l.starts_with(':') {
            continue;
        }
        if let Some(_rest) = l.strip_prefix("event:") {
            continue;
        }
        if let Some(rest) = l.strip_prefix("data:") {
            data_lines.push(rest.trim_start().to_string());
            continue;
        }
        if let Some(_rest) = l.strip_prefix("id:") {
            // Ignore SSE event id.
            continue;
        }
    }
}

#[derive(Debug)]
struct StdioTransport {
    child: Child,
    stdin: ChildStdin,
    stdout_rx: mpsc::Receiver<String>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
}

impl StdioTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let cmd = config.command.trim();
        if cmd.is_empty() {
            return Err("MCP server command must not be empty (transport=stdio)".to_string());
        }

        let cwd = config
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(expand_tilde_path);

        let mut command = build_stdio_command(cmd, &config.args, cwd.as_deref());
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        maybe_augment_macos_path(&mut command);
        configure_child_process_group(&mut command);
        // Inject the app-proxy env first (including the NO_PROXY loopback exemption);
        // env from the server config is written afterwards so it keeps higher priority;
        // fail fast on a broken proxy config rather than silently connecting directly.
        for (key, value) in crate::services::system_proxy::shell_proxy_envs()? {
            command.env(key, value);
        }
        if let Some(env) = &config.env {
            command.envs(env);
        }
        if let Some(cwd) = &cwd {
            command.current_dir(cwd);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("failed to start MCP server: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "cannot obtain MCP server stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "cannot obtain MCP server stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "cannot obtain MCP server stderr".to_string())?;

        let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let tail = stderr_tail.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            let l = line.trim_end().to_string();
                            append_stderr_tail(&tail, l);
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if tx.send(trimmed.to_string()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout_rx: rx,
            stderr_tail,
        })
    }

    fn stderr_summary(&self) -> String {
        if let Ok(buf) = self.stderr_tail.lock() {
            if buf.is_empty() {
                return "".to_string();
            }
            let joined = buf.join("\n");
            return format!("\n\n--- MCP server stderr (tail) ---\n{joined}");
        }
        "".to_string()
    }

    fn ensure_running(&mut self) -> Result<(), String> {
        if let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "MCP server exited unexpectedly: status={status}{}",
                self.stderr_summary()
            ));
        }
        Ok(())
    }

    fn send_line(&mut self, line: &str) -> Result<(), String> {
        self.ensure_running()?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| {
                format!(
                    "Failed to write to MCP server stdin: {e}{}",
                    self.stderr_summary()
                )
            })
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        self.send_line(&req.to_string())
    }

    fn request(
        &mut self,
        timeout: Duration,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.ensure_running()?;

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        self.send_line(&req.to_string())?;

        // Read until we see the matching response id. Ignore notifications/other ids.
        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        loop {
            let now = Instant::now();
            let remaining = deadline.saturating_duration_since(now);
            if remaining.is_zero() {
                return Err(format!(
                    "MCP request timed out: method={method} id={id}{}",
                    self.stderr_summary()
                ));
            }

            let line = self.stdout_rx.recv_timeout(remaining).map_err(|e| {
                format!(
                    "Failed to read MCP server stdout or the read timed out: {e}{}",
                    self.stderr_summary()
                )
            })?;

            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue, // Non-JSON output on stdout (should not happen, but ignore).
            };

            if msg.get("id") == Some(&json!(id)) {
                return parse_jsonrpc_result(method, id, &msg)
                    .map_err(|e| format!("{e}{}", self.stderr_summary()));
            }
        }
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        kill_child_process_tree_best_effort(&mut self.child);
    }
}

#[derive(Debug)]
struct HttpTransport {
    endpoint: Url,
    client: HttpClient,
    headers: HeaderMap,
    session_id: Option<String>,
    protocol_version: Option<String>,
}

impl HttpTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let url = config
            .url_trimmed()
            .ok_or_else(|| "MCP http transport requires a url".to_string())?;
        let endpoint = Url::parse(url).map_err(|e| format!("invalid MCP url: {url} ({e})"))?;

        let headers = build_header_map(&config.headers)?;

        // Built via system_proxy: routes through the proxy when the app proxy is enabled
        // (with a loopback-address exemption); fail fast on a broken config.
        let client = crate::services::system_proxy::blocking_client_builder()
            .map_err(|e| format!("failed to create HTTP client: {e}"))?
            .connect_timeout(Duration::from_secs(10))
            .timeout(config.timeout())
            .build()
            .map_err(|e| format!("failed to create HTTP client: {e}"))?;

        Ok(Self {
            endpoint,
            client,
            headers,
            session_id: None,
            protocol_version: None,
        })
    }

    fn reset_session(&mut self) {
        self.session_id = None;
        self.protocol_version = None;
    }

    fn apply_common_headers(
        &self,
        mut builder: reqwest::blocking::RequestBuilder,
        bearer: Option<&str>,
    ) -> reqwest::blocking::RequestBuilder {
        let merged = headers_with_bearer(&self.headers, bearer);
        if !merged.is_empty() {
            builder = builder.headers(merged);
        }
        builder.header(ACCEPT, "application/json, text/event-stream")
    }

    fn notify(&mut self, bearer: Option<&str>, method: &str, params: Value) -> Result<(), String> {
        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        let mut builder = self.client.post(self.endpoint.clone());
        builder = self.apply_common_headers(builder, bearer);

        if let Some(v) = &self.protocol_version {
            builder = builder.header("MCP-Protocol-Version", v);
        }
        if let Some(sid) = &self.session_id {
            builder = builder.header("MCP-Session-Id", sid);
        }

        let resp = builder
            .header(CONTENT_TYPE, "application/json")
            .body(req.to_string())
            .send()
            .map_err(|e| format!("MCP HTTP notify failed: method={method} err={e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "MCP HTTP notify failed: method={method} status={}",
                resp.status()
            ));
        }

        Ok(())
    }

    fn request(
        &mut self,
        oauth: bool,
        bearer: Option<&str>,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, McpTransportError> {
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        let mut builder = self.client.post(self.endpoint.clone());
        builder = self.apply_common_headers(builder, bearer);

        // Negotiated protocol version.
        if let Some(v) = &self.protocol_version {
            builder = builder.header("MCP-Protocol-Version", v);
        } else if method == "initialize" {
            if let Some(v) = req
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
            {
                builder = builder.header("MCP-Protocol-Version", v);
            }
        }

        // Only attach session id for non-initialize requests.
        if method != "initialize" {
            if let Some(sid) = &self.session_id {
                builder = builder.header("MCP-Session-Id", sid);
            }
        }

        let resp = builder
            .header(CONTENT_TYPE, "application/json")
            .body(req.to_string())
            .send()
            .map_err(|e| {
                McpTransportError::msg(format!("MCP HTTP request failed: method={method} err={e}"))
            })?;

        // With oauth enabled, a 401 takes the dedicated path: one passive refresh
        // then retry (handled by the upper layer).
        if oauth && resp.status() == StatusCode::UNAUTHORIZED {
            return Err(McpTransportError::Unauthorized);
        }

        if resp.status() == StatusCode::NOT_FOUND
            && self.session_id.is_some()
            && method != "initialize"
        {
            return Err(McpTransportError::SessionExpired404);
        }

        if !resp.status().is_success() {
            return Err(McpTransportError::msg(format!(
                "MCP HTTP request failed: method={method} status={}",
                resp.status()
            )));
        }

        let session_header = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let ct = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        let msg: Value = if ct.starts_with("text/event-stream") {
            let mut reader = BufReader::new(resp);
            read_sse_for_matching_id(&mut reader, method, id).map_err(McpTransportError::msg)?
        } else {
            let body = resp.text().map_err(|e| {
                McpTransportError::msg(format!("Failed to read the MCP HTTP response: {e}"))
            })?;
            serde_json::from_str(&body).map_err(|e| {
                McpTransportError::msg(format!(
                    "Failed to parse MCP HTTP JSON: method={method} err={e} body={body}"
                ))
            })?
        };

        let result = parse_jsonrpc_result(method, id, &msg).map_err(McpTransportError::msg)?;

        if method == "initialize" {
            if let Some(sid) = session_header {
                self.session_id = Some(sid);
            }

            if let Some(pv) = result.get("protocolVersion").and_then(|v| v.as_str()) {
                self.protocol_version = Some(pv.to_string());
            } else if let Some(pv) = req
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
            {
                self.protocol_version = Some(pv.to_string());
            }
        }

        Ok(result)
    }
}

#[derive(Debug)]
struct SseTransport {
    sse_url: Url,
    message_url_override: Option<Url>,
    post_url: Arc<Mutex<Option<Url>>>,
    client_post: HttpClient,
    headers: HeaderMap,
    rx: mpsc::Receiver<Value>,
    stop: Arc<AtomicBool>,
    _thread: Option<std::thread::JoinHandle<()>>,
}

impl SseTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let url = config
            .url_trimmed()
            .ok_or_else(|| "MCP sse transport requires a url (SSE endpoint)".to_string())?;
        let sse_url = Url::parse(url).map_err(|e| format!("invalid MCP url: {url} ({e})"))?;

        let headers = build_header_map(&config.headers)?;

        let message_url_override = match config.message_url_trimmed() {
            None => None,
            Some(raw) => {
                // Support relative urls.
                Url::parse(raw)
                    .or_else(|_| sse_url.join(raw))
                    .map(Some)
                    .map_err(|e| format!("invalid messageUrl: {raw} ({e})"))?
            }
        };

        // Both clients are built via system_proxy (the GET long connection sets no
        // overall timeout), with the same semantics as HttpTransport.
        let client_get = crate::services::system_proxy::blocking_client_builder()
            .map_err(|e| format!("failed to create SSE http client: {e}"))?
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("failed to create SSE http client: {e}"))?;

        let client_post = crate::services::system_proxy::blocking_client_builder()
            .map_err(|e| format!("failed to create POST http client: {e}"))?
            .connect_timeout(Duration::from_secs(10))
            .timeout(config.timeout())
            .build()
            .map_err(|e| format!("failed to create POST http client: {e}"))?;

        let post_url: Arc<Mutex<Option<Url>>> = Arc::new(Mutex::new(message_url_override.clone()));

        let (tx, rx) = mpsc::channel::<Value>();
        let stop = Arc::new(AtomicBool::new(false));

        let thread_sse_url = sse_url.clone();
        let thread_post_url = post_url.clone();
        let thread_headers = headers.clone();
        let thread_stop = stop.clone();
        let thread_client = client_get.clone();
        // oauth: the GET long connection fetches the current Bearer on every
        // (re)connect — a token refresh takes effect on reconnect, rather than
        // baking the spawn-time token into the thread.
        let thread_oauth = config.oauth_enabled();
        let thread_server_id = config.id.trim().to_string();
        let thread_server_url = url.to_string();

        // Failed reconnects use backoff: a fixed 1s would repeatedly reconnect once
        // per second while the upstream is unreachable (DNS + TCP + TLS handshake),
        // and that loop is permanent when an SSE server is configured but cannot be
        // reached. Reset on a successful connection so a transient blip is not
        // amplified into sustained backoff.
        const SSE_RECONNECT_MIN: Duration = Duration::from_secs(1);
        const SSE_RECONNECT_MAX: Duration = Duration::from_secs(30);
        let handle = std::thread::spawn(move || {
            let mut backoff = SSE_RECONNECT_MIN;
            loop {
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }

            let mut builder = thread_client.get(thread_sse_url.clone());
            let bearer = if thread_oauth {
                crate::services::mcp_oauth::ensure_bearer(&thread_server_id, &thread_server_url)
            } else {
                None
            };
            let merged = headers_with_bearer(&thread_headers, bearer.as_deref());
            if !merged.is_empty() {
                builder = builder.headers(merged);
            }
            builder = builder.header(ACCEPT, "text/event-stream");

            let resp = match builder.send() {
                Ok(r) => {
                    // Reset backoff on a successful connection: the next failure
                    // starts again from the minimum interval, so a transient blip is
                    // not accumulated into reconnecting only once every 30s.
                    backoff = SSE_RECONNECT_MIN;
                    r
                }
                Err(_) => {
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(SSE_RECONNECT_MAX);
                    continue;
                }
            };

            if !resp.status().is_success() {
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(SSE_RECONNECT_MAX);
                continue;
            }

            let mut reader = BufReader::new(resp);
            let mut line = String::new();
            let mut event_name: Option<String> = None;
            let mut data_lines: Vec<String> = Vec::new();

            loop {
                if thread_stop.load(Ordering::Relaxed) {
                    return;
                }

                line.clear();
                let n = match reader.read_line(&mut line) {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if n == 0 {
                    break;
                }

                let l = line.trim_end_matches(['\r', '\n']);
                if l.is_empty() {
                    if data_lines.is_empty() {
                        event_name = None;
                        continue;
                    }

                    let data = data_lines.join("\n");
                    data_lines.clear();

                    let ty = event_name.take().unwrap_or_else(|| "message".to_string());

                    if ty == "endpoint" {
                        let raw = data.trim();
                        if raw.is_empty() {
                            continue;
                        }
                        if let Ok(u) = Url::parse(raw).or_else(|_| thread_sse_url.join(raw)) {
                            if let Ok(mut locked) = thread_post_url.lock() {
                                *locked = Some(u);
                            }
                        }
                        continue;
                    }

                    if let Ok(v) = serde_json::from_str::<Value>(&data) {
                        let _ = tx.send(v);
                    }

                    continue;
                }

                if l.starts_with(':') {
                    continue;
                }
                if let Some(rest) = l.strip_prefix("event:") {
                    event_name = Some(rest.trim().to_string());
                    continue;
                }
                if let Some(rest) = l.strip_prefix("data:") {
                    data_lines.push(rest.trim_start().to_string());
                    continue;
                }
            }
            }
        });

        Ok(Self {
            sse_url,
            message_url_override,
            post_url,
            client_post,
            headers,
            rx,
            stop,
            _thread: Some(handle),
        })
    }

    fn wait_or_guess_post_url(&self, timeout: Duration) -> Result<Url, String> {
        if let Some(u) = &self.message_url_override {
            return Ok(u.clone());
        }

        // Wait for endpoint event a little while (if the stream is slow to emit).
        let wait_ms = timeout.as_millis() as u64;
        let wait_ms = wait_ms.clamp(1, LEGACY_SSE_ENDPOINT_WAIT_MS);
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(wait_ms))
            .unwrap_or_else(Instant::now);

        loop {
            if let Ok(locked) = self.post_url.lock() {
                if let Some(u) = &*locked {
                    return Ok(u.clone());
                }
            }

            if Instant::now() >= deadline {
                break;
            }

            std::thread::sleep(Duration::from_millis(50));
        }

        // Fallback: /sse -> /message
        let path = self.sse_url.path();
        if let Some(prefix) = path.strip_suffix("/sse") {
            let mut u = self.sse_url.clone();
            u.set_path(&format!("{prefix}/message"));
            return Ok(u);
        }

        Err(
            "No endpoint event was received, and the message endpoint could not be inferred. Please provide Message URL."
                .to_string(),
        )
    }

    fn notify(
        &mut self,
        timeout: Duration,
        bearer: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<(), String> {
        let post_url = self.wait_or_guess_post_url(timeout)?;

        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        let mut builder = self.client_post.post(post_url);
        let merged = headers_with_bearer(&self.headers, bearer);
        if !merged.is_empty() {
            builder = builder.headers(merged);
        }
        let resp = builder
            .header(CONTENT_TYPE, "application/json")
            .body(req.to_string())
            .send()
            .map_err(|e| format!("MCP SSE notify failed: method={method} err={e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "MCP SSE notify failed: method={method} status={}",
                resp.status()
            ));
        }

        Ok(())
    }

    fn request(
        &mut self,
        timeout: Duration,
        oauth: bool,
        bearer: Option<&str>,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, McpTransportError> {
        let post_url = self
            .wait_or_guess_post_url(timeout)
            .map_err(McpTransportError::msg)?;

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        let mut builder = self.client_post.post(post_url);
        let merged = headers_with_bearer(&self.headers, bearer);
        if !merged.is_empty() {
            builder = builder.headers(merged);
        }
        let resp = builder
            .header(CONTENT_TYPE, "application/json")
            .body(req.to_string())
            .send()
            .map_err(|e| {
                McpTransportError::msg(format!("MCP SSE request failed: method={method} err={e}"))
            })?;

        if oauth && resp.status() == StatusCode::UNAUTHORIZED {
            return Err(McpTransportError::Unauthorized);
        }

        if !resp.status().is_success() {
            return Err(McpTransportError::msg(format!(
                "MCP SSE request failed: method={method} status={}",
                resp.status()
            )));
        }

        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(McpTransportError::msg(format!(
                    "MCP SSE request timed out: method={method} id={id}"
                )));
            }

            let msg = self.rx.recv_timeout(remaining).map_err(|e| {
                McpTransportError::msg(format!(
                    "Failed to wait for the SSE response or the wait timed out: {e}"
                ))
            })?;

            if msg.get("id") == Some(&json!(id)) {
                return parse_jsonrpc_result(method, id, &msg).map_err(McpTransportError::msg);
            }
        }
    }
}

impl Drop for SseTransport {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Debug)]
enum McpTransport {
    Stdio(StdioTransport),
    Http(HttpTransport),
    Sse(SseTransport),
}

impl McpTransport {
    fn ensure_running(&mut self) -> Result<(), String> {
        match self {
            McpTransport::Stdio(t) => t.ensure_running(),
            McpTransport::Http(_) | McpTransport::Sse(_) => Ok(()),
        }
    }

    fn stderr_tail(&self) -> Option<String> {
        match self {
            McpTransport::Stdio(t) => {
                let text = t.stderr_summary();
                if text.trim().is_empty() {
                    None
                } else {
                    Some(text)
                }
            }
            McpTransport::Http(_) | McpTransport::Sse(_) => None,
        }
    }

    fn reset_session(&mut self) {
        if let McpTransport::Http(h) = self {
            h.reset_session();
        }
    }

    /// Fetch the current Bearer when oauth is enabled (in-process cache + active
    /// refresh before expiry); returns None when unauthorized, the request goes out
    /// bare, and a 401 is converted by the upper layer into an "authorization
    /// required" marker error.
    fn bearer_for(cfg: &McpServerConfig) -> Option<String> {
        if !cfg.oauth_enabled() {
            return None;
        }
        let url = cfg.url_trimmed()?;
        crate::services::mcp_oauth::ensure_bearer(cfg.id.trim(), url)
    }

    fn notify(
        &mut self,
        cfg: &McpServerConfig,
        method: &str,
        params: Value,
    ) -> Result<(), McpTransportError> {
        let timeout = cfg.timeout();
        let bearer = Self::bearer_for(cfg);
        match self {
            McpTransport::Stdio(t) => t.notify(method, params).map_err(McpTransportError::msg),
            McpTransport::Http(t) => t
                .notify(bearer.as_deref(), method, params)
                .map_err(McpTransportError::msg),
            McpTransport::Sse(t) => t
                .notify(timeout, bearer.as_deref(), method, params)
                .map_err(McpTransportError::msg),
        }
    }

    fn request(
        &mut self,
        cfg: &McpServerConfig,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, McpTransportError> {
        let timeout = cfg.timeout();
        let oauth = cfg.oauth_enabled();
        let bearer = Self::bearer_for(cfg);
        match self {
            McpTransport::Stdio(t) => t
                .request(timeout, id, method, params)
                .map_err(McpTransportError::msg),
            McpTransport::Http(t) => t.request(oauth, bearer.as_deref(), id, method, params),
            McpTransport::Sse(t) => {
                t.request(timeout, oauth, bearer.as_deref(), id, method, params)
            }
        }
    }
}

#[derive(Debug)]
struct McpClient {
    config: McpServerConfig,
    /// App-proxy config revision at spawn time. The transport's reqwest client and
    /// the stdio child process env are both fixed at spawn, so ensure_client uses
    /// this to rebuild the connection after the proxy config changes.
    proxy_revision: u64,
    transport: McpTransport,
    next_id: u64,
    initialized: bool,
}

/// Compose an "authorization required" error carrying a stable marker: the frontend
/// and diagnostics use the marker to guide the user to Connect in MCP Hub.
fn oauth_required_error(cfg: &McpServerConfig, reason: &str) -> String {
    format!(
        "MCP server `{}` requires OAuth authorization ({}). Run Connect on this server in MCP Hub to complete authorization. Reason: {reason}",
        cfg.id.trim(),
        crate::services::mcp_oauth::AUTH_REQUIRED_MARKER
    )
}

impl McpClient {
    fn spawn(config: McpServerConfig) -> Result<Self, String> {
        // Read the revision before building the transport: if the proxy config
        // changes during spawn, the recorded stale value will trigger a rebuild on
        // the next ensure_client — better to rebuild once too often.
        let proxy_revision = crate::services::system_proxy::revision();
        let transport = match config.transport().trim() {
            "http" => McpTransport::Http(HttpTransport::spawn(&config)?),
            "sse" => McpTransport::Sse(SseTransport::spawn(&config)?),
            _ => McpTransport::Stdio(StdioTransport::spawn(&config)?),
        };

        Ok(Self {
            config,
            proxy_revision,
            transport,
            next_id: 1,
            initialized: false,
        })
    }

    fn next_rpc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }

    /// Passive 401 refresh (allowed only once per call site). On success the
    /// transport's next request gets the new token via `bearer_for`; on failure it
    /// returns an "authorization required" marker error.
    fn recover_unauthorized(&mut self) -> Result<(), String> {
        let url = self
            .config
            .url_trimmed()
            .ok_or_else(|| oauth_required_error(&self.config, "server has no URL configured"))?;
        crate::services::mcp_oauth::refresh_after_unauthorized(self.config.id.trim(), url)
            .map(|_| ())
            .map_err(|reason| oauth_required_error(&self.config, &reason))
    }

    fn ensure_initialized(&mut self) -> Result<(), String> {
        if self.initialized {
            return Ok(());
        }

        let candidates = [
            "2025-11-25",
            "2025-06-18",
            "2025-03-26",
            "2024-11-05",
            "2024-10-07",
        ];
        let mut last_err: Option<String> = None;
        // The whole initialize attempt sequence shares a single passive refresh
        // allowance: a 401 is unrelated to the protocol version, so retry the current
        // version after refreshing; another 401 or a refresh failure is immediately
        // judged "authorization required" without spinning through the other versions.
        let mut auth_retry_used = false;

        for v in candidates {
            let init_params = json!({
                "protocolVersion": v,
                "clientInfo": { "name": "ReactorPro", "version": crate::app_version() },
                "capabilities": {}
            });

            loop {
                let id = self.next_rpc_id();
                match self
                    .transport
                    .request(&self.config, id, "initialize", init_params.clone())
                {
                    Ok(_) => {
                        // Some servers require this notification before accepting further requests.
                        let _ = self.transport.notify(
                            &self.config,
                            "notifications/initialized",
                            json!({}),
                        );
                        self.initialized = true;
                        return Ok(());
                    }
                    Err(McpTransportError::Unauthorized) => {
                        if auth_retry_used {
                            return Err(oauth_required_error(&self.config, "still returned 401 after refresh"));
                        }
                        auth_retry_used = true;
                        self.recover_unauthorized()?;
                        continue;
                    }
                    Err(McpTransportError::Message(msg)) => {
                        last_err = Some(msg);
                        break;
                    }
                    Err(McpTransportError::SessionExpired404) => {
                        last_err = Some("Session expired during initialize (404)".to_string());
                        break;
                    }
                }
            }
        }

        Err(last_err.unwrap_or_else(|| "initialize failed".to_string()))
    }

    fn request_with_retry(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_rpc_id();
        match self
            .transport
            .request(&self.config, id, method, params.clone())
        {
            Ok(v) => Ok(v),
            Err(McpTransportError::SessionExpired404) => {
                // Streamable HTTP: session expired, clear session and re-initialize once, then retry.
                self.transport.reset_session();
                self.initialized = false;
                self.ensure_initialized()?;

                let retry_id = self.next_rpc_id();
                match self
                    .transport
                    .request(&self.config, retry_id, method, params)
                {
                    Ok(v) => Ok(v),
                    Err(McpTransportError::Message(msg)) => Err(msg),
                    Err(McpTransportError::Unauthorized) => {
                        Err(oauth_required_error(&self.config, "returned 401 after session rebuild"))
                    }
                    Err(McpTransportError::SessionExpired404) => Err(
                        "MCP session still returned 404 after retry (the server may be unhealthy)"
                            .to_string(),
                    ),
                }
            }
            Err(McpTransportError::Unauthorized) => {
                // Token expired/revoked: one passive refresh, then retry the original request.
                self.recover_unauthorized()?;

                let retry_id = self.next_rpc_id();
                match self
                    .transport
                    .request(&self.config, retry_id, method, params)
                {
                    Ok(v) => Ok(v),
                    Err(McpTransportError::Message(msg)) => Err(msg),
                    Err(McpTransportError::Unauthorized) => {
                        Err(oauth_required_error(&self.config, "still returned 401 after refresh"))
                    }
                    Err(McpTransportError::SessionExpired404) => Err(
                        "MCP session returned 404 right after refresh (the server may be unhealthy)"
                            .to_string(),
                    ),
                }
            }
            Err(McpTransportError::Message(msg)) => Err(msg),
        }
    }

    fn tools_list(&mut self) -> Result<Vec<McpToolInfo>, String> {
        self.ensure_initialized()?;
        let result = self.request_with_retry("tools/list", json!({}))?;
        let tools = result
            .get("tools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut out: Vec<McpToolInfo> = Vec::new();
        for t in tools {
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
            if name.is_empty() {
                continue;
            }
            let description = t
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let input_schema = t
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object" }));

            out.push(McpToolInfo {
                server_id: self.config.id.clone(),
                server_label: self.config.id.clone(),
                name: name.to_string(),
                description,
                input_schema,
            });
        }

        Ok(out)
    }

    fn runtime_status(&mut self) -> McpRuntimeStatus {
        let last_error = self.transport.ensure_running().err();
        McpRuntimeStatus {
            server_id: self.config.id.clone(),
            running: last_error.is_none(),
            initialized: self.initialized,
            transport: self.config.transport().to_string(),
            last_error,
        }
    }

    fn stderr_tail(&self) -> Option<String> {
        self.transport.stderr_tail()
    }

    fn tools_call(
        &mut self,
        tool_name: &str,
        arguments: Value,
    ) -> Result<McpCallToolResponse, String> {
        self.ensure_initialized()?;
        let result = self.request_with_retry(
            "tools/call",
            json!({
                "name": tool_name,
                "arguments": arguments
            }),
        )?;

        let is_error = result
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut content_out: Vec<McpContent> = Vec::new();
        if let Some(items) = result.get("content").and_then(|v| v.as_array()) {
            for item in items {
                let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match ty {
                    "text" => {
                        let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            content_out.push(McpContent::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                    "image" => {
                        let data = item.get("data").and_then(|v| v.as_str()).unwrap_or("");
                        let mime_type = item
                            .get("mimeType")
                            .and_then(|v| v.as_str())
                            .unwrap_or("application/octet-stream");
                        if !data.is_empty() {
                            content_out.push(McpContent::Image {
                                data: data.to_string(),
                                mime_type: mime_type.to_string(),
                            });
                        }
                    }
                    _ => {
                        // Unknown content type: keep a JSON preview as text to avoid losing info.
                        content_out.push(McpContent::Text {
                            text: item.to_string(),
                        });
                    }
                }
            }
        }

        if content_out.is_empty() {
            content_out.push(McpContent::Text {
                text: result.to_string(),
            });
        }

        Ok(McpCallToolResponse {
            content: content_out,
            is_error,
            details: result,
        })
    }
}

fn to_diagnostic_tools(
    tools: Vec<McpToolInfo>,
    include_schema: bool,
) -> Vec<McpDiagnosticToolInfo> {
    tools
        .into_iter()
        .map(|tool| McpDiagnosticToolInfo {
            server_id: tool.server_id,
            server_label: tool.server_label,
            name: tool.name,
            description: tool.description,
            input_schema: include_schema.then_some(tool.input_schema),
        })
        .collect()
}

fn validate_runtime_config(cfg: &McpServerConfig) -> Result<(), String> {
    let id = cfg.id.trim();
    if id.is_empty() {
        return Err("MCP server name cannot be empty".to_string());
    }

    match cfg.transport() {
        "http" | "sse" => {
            let u = cfg.url_trimmed().unwrap_or("");
            if u.is_empty() {
                return Err(format!(
                    "MCP server({id}) transport={} requires url",
                    cfg.transport()
                ));
            }
        }
        _ => {
            if cfg.command.trim().is_empty() {
                return Err(format!("MCP server({id}) transport=stdio requires command"));
            }
        }
    }

    Ok(())
}

fn classify_start_failure(error: &str) -> &'static str {
    if error.contains("failed to start MCP server")
        || error.contains("Failed to start")
        || error.contains("No such file")
        || error.contains("os error 2")
    {
        "spawn"
    } else {
        "config"
    }
}

fn run_client_test(
    id: String,
    transport: String,
    start: Instant,
    client: &mut McpClient,
    include_schema: bool,
) -> McpRuntimeTestResponse {
    let oauth = oauth_diag(&client.config);
    let mut phase = "tools_list".to_string();
    let tools = match client.tools_list() {
        Ok(tools) => tools,
        Err(error) => {
            let initialized = client.initialized;
            let running = client.transport.ensure_running().is_ok();
            let stderr_tail = client.stderr_tail();
            if !initialized {
                phase = "initialize".to_string();
            }
            // After a 401 → "authorization required" marker error occurs, fetch the
            // status once more so fresh state such as expired becomes visible.
            let oauth = oauth_diag(&client.config);
            return McpRuntimeTestResponse {
                server_id: id,
                ok: false,
                phase,
                transport,
                duration_ms: start.elapsed().as_millis(),
                running,
                initialized,
                tools_count: 0,
                tools: Vec::new(),
                error: Some(error),
                stderr_tail,
                oauth,
            };
        }
    };
    let tools_count = tools.len();
    let initialized = client.initialized;
    let running = client.transport.ensure_running().is_ok();
    let stderr_tail = client.stderr_tail();
    McpRuntimeTestResponse {
        server_id: id,
        ok: true,
        phase: "tools_list".to_string(),
        transport,
        duration_ms: start.elapsed().as_millis(),
        running,
        initialized,
        tools_count,
        tools: to_diagnostic_tools(tools, include_schema),
        error: None,
        stderr_tail,
        oauth,
    }
}

impl McpRuntimeManager {
    // Lock discipline: the clients-map lock is only ever held for a get/insert
    // and is never held while locking an individual client or spawning one.
    // Holding the map lock across a busy client (long tools/call) or a slow
    // spawn would stall every other server's commands behind it. Two threads
    // racing with an identical config can briefly double-spawn; the loser's
    // client is dropped (and its transport killed) when the Arc goes away,
    // which is the correct trade-off versus global head-of-line blocking.
    fn ensure_client(&self, cfg: McpServerConfig) -> Result<Arc<Mutex<McpClient>>, String> {
        let id = cfg.id.trim().to_string();
        validate_runtime_config(&cfg)?;

        let existing = self
            .clients
            .lock()
            .map_err(|_| "MCP state lock failed".to_string())?
            .get(&id)
            .cloned();
        if let Some(existing) = existing.as_ref() {
            // Restart if config changed. Same-id calls serialize on the client
            // lock (protocol streams cannot be shared), other servers do not.
            // An app-proxy config change (revision change) also counts as a config
            // change and rebuilds the connection.
            let proxy_revision = crate::services::system_proxy::revision();
            let same_config = existing
                .lock()
                .map(|client| client.config == cfg && client.proxy_revision == proxy_revision)
                .unwrap_or(false);
            if same_config {
                return Ok(existing.clone());
            }
        }

        let client = match McpClient::spawn(cfg) {
            Ok(client) => client,
            Err(error) => {
                // A failed rebuild must evict the old client already judged stale:
                // mcp_call_tool reads the map directly without going through this
                // function, so keeping the old client would let calls under an
                // invalid config (e.g. a broken app proxy) continue on the old
                // channel, violating the fail-fast, never-silently-direct semantics.
                // Remove only when the map still holds the same Arc, to avoid
                // killing a new client swapped in concurrently.
                if let Some(stale) = existing {
                    if let Ok(mut map) = self.clients.lock() {
                        if map
                            .get(&id)
                            .is_some_and(|current| Arc::ptr_eq(current, &stale))
                        {
                            map.remove(&id);
                        }
                    }
                }
                return Err(error);
            }
        };
        let arc = Arc::new(Mutex::new(client));
        self.clients
            .lock()
            .map_err(|_| "MCP state lock failed".to_string())?
            .insert(id, arc.clone());
        Ok(arc)
    }

    fn stop_client(&self, server_id: &str) -> Result<bool, String> {
        let id = server_id.trim();
        if id.is_empty() {
            return Err("server_id cannot be empty".to_string());
        }
        let mut map = self
            .clients
            .lock()
            .map_err(|_| "MCP state lock failed".to_string())?;
        Ok(map.remove(id).is_some())
    }

    fn runtime_status(&self, server_id: &str) -> Result<McpRuntimeStatus, String> {
        let id = server_id.trim().to_string();
        if id.is_empty() {
            return Err("server_id cannot be empty".to_string());
        }
        let map = self
            .clients
            .lock()
            .map_err(|_| "MCP state lock failed".to_string())?;
        let Some(client) = map.get(&id).cloned() else {
            return Ok(McpRuntimeStatus {
                server_id: id,
                running: false,
                initialized: false,
                transport: "unknown".to_string(),
                last_error: None,
            });
        };
        drop(map);
        let mut locked = client
            .lock()
            .map_err(|_| "MCP client lock failed".to_string())?;
        Ok(locked.runtime_status())
    }

    fn test_client(
        &self,
        cfg: McpServerConfig,
        include_schema: bool,
        restart: bool,
        persist: bool,
    ) -> Result<McpRuntimeTestResponse, String> {
        let id = cfg.id.trim().to_string();
        if id.is_empty() {
            return Err("MCP server name cannot be empty".to_string());
        }
        let transport = cfg.transport().to_string();
        let start = Instant::now();

        if restart && persist {
            let _ = self.stop_client(&id);
        }

        if !persist {
            if let Err(error) = validate_runtime_config(&cfg) {
                return Ok(McpRuntimeTestResponse {
                    server_id: id,
                    ok: false,
                    phase: "config".to_string(),
                    transport,
                    duration_ms: start.elapsed().as_millis(),
                    running: false,
                    initialized: false,
                    tools_count: 0,
                    tools: Vec::new(),
                    error: Some(error),
                    stderr_tail: None,
                    oauth: oauth_diag(&cfg),
                });
            }
            let mut client = match McpClient::spawn(cfg) {
                Ok(client) => client,
                Err(error) => {
                    let phase = classify_start_failure(&error);
                    return Ok(McpRuntimeTestResponse {
                        server_id: id,
                        ok: false,
                        phase: phase.to_string(),
                        transport,
                        duration_ms: start.elapsed().as_millis(),
                        running: false,
                        initialized: false,
                        tools_count: 0,
                        tools: Vec::new(),
                        error: Some(error),
                        stderr_tail: None,
                        oauth: None,
                    });
                }
            };
            return Ok(run_client_test(
                id,
                transport,
                start,
                &mut client,
                include_schema,
            ));
        }

        let client = match self.ensure_client(cfg) {
            Ok(client) => client,
            Err(error) => {
                let phase = classify_start_failure(&error);
                return Ok(McpRuntimeTestResponse {
                    server_id: id,
                    ok: false,
                    phase: phase.to_string(),
                    transport,
                    duration_ms: start.elapsed().as_millis(),
                    running: false,
                    initialized: false,
                    tools_count: 0,
                    tools: Vec::new(),
                    error: Some(error),
                    stderr_tail: None,
                    oauth: None,
                });
            }
        };

        let mut locked = client
            .lock()
            .map_err(|_| "MCP client lock failed".to_string())?;
        Ok(run_client_test(
            id,
            transport,
            start,
            &mut locked,
            include_schema,
        ))
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_list_tools(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    servers: Vec<McpServerConfig>,
) -> Result<Vec<McpToolInfo>, String> {
    // IMPORTANT: tool listing can block (process spawn / network / pipes). Offload.
    let manager = state.inner().clone();
    run_blocking("mcp_list_tools", move || {
        let mut out: Vec<McpToolInfo> = Vec::new();

        let mut succeeded = 0usize;
        let mut failures: Vec<String> = Vec::new();
        for cfg in servers.into_iter().filter(|s| s.enabled) {
            let server_id = cfg.id.clone();
            let tools = match manager.ensure_client(cfg.clone()) {
                Ok(client) => {
                    let mut locked = client.lock().map_err(|_| "MCP client lock failed".to_string())?;
                    locked.tools_list()
                }
                Err(err) => Err(err),
            };

            match tools {
                Ok(tools) => {
                    succeeded += 1;
                    out.extend(tools);
                }
                Err(err) => {
                    eprintln!(
                        "[MCP] Skipping tools/list for server `{}`, continuing the conversation flow: {}",
                        server_id, err
                    );
                    failures.push(format!("{server_id}: {err}"));
                }
            }
        }

        // Partial failures keep the skip semantics; a total wipeout (e.g. a broken
        // app-proxy config taking down every server at once) must be visible to the
        // frontend (onLoadError/throw), otherwise tools silently vanish with no way
        // to diagnose.
        if succeeded == 0 && !failures.is_empty() {
            return Err(format!(
                "All enabled MCP servers are unavailable:\n{}",
                failures.join("\n")
            ));
        }

        Ok(out)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_call_tool(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    run_registry: tauri::State<'_, Arc<ShellRunRegistry>>,
    server_id: String,
    tool_name: String,
    arguments: Value,
    run_id: Option<String>,
) -> Result<McpCallToolResponse, String> {
    // IMPORTANT: tool call can block (network / pipes / SSE). Offload.
    let manager = state.inner().clone();
    let normalized_run_id = run_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let cancel_token = normalized_run_id
        .as_deref()
        .map(|id| run_registry.register(id));
    let registered_token = cancel_token.clone();
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        let id = server_id.trim().to_string();
        if id.is_empty() {
            return Err("server_id cannot be empty".to_string());
        }

        let map = manager
            .clients
            .lock()
            .map_err(|_| "Failed to lock MCP state".to_string())?;
        let client = map.get(&id).cloned().ok_or_else(|| {
            format!(
                "Unknown MCP server: {id} (it may have been reconfigured or stopped; \
                 the tool list refreshes on the next conversation turn)"
            )
        })?;
        drop(map);

        let mut locked = client
            .lock()
            .map_err(|_| "Failed to lock MCP client".to_string())?;
        locked.tools_call(tool_name.trim(), arguments)
    });
    let result = if let Some(cancel_token) = cancel_token {
        tokio::select! {
            join = &mut task => {
                join.map_err(|error| format!("mcp_call_tool join failed: {error}"))?
            }
            _ = cancel_token.cancelled() => Err("Cancelled".to_string()),
        }
    } else {
        task.await
            .map_err(|error| format!("mcp_call_tool join failed: {error}"))?
    };
    if let (Some(run_id), Some(token)) = (normalized_run_id.as_deref(), registered_token.as_ref()) {
        run_registry.unregister(run_id, token);
    }
    result
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_runtime_status(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server_id: String,
) -> Result<McpRuntimeStatus, String> {
    let manager = state.inner().clone();
    run_blocking("mcp_runtime_status", move || {
        manager.runtime_status(&server_id)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_stop_server(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server_id: String,
) -> Result<McpStopServerResponse, String> {
    let manager = state.inner().clone();
    run_blocking("mcp_stop_server", move || {
        let id = server_id.trim().to_string();
        let stopped = manager.stop_client(&id)?;
        Ok(McpStopServerResponse {
            server_id: id,
            stopped,
        })
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_test_server(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server: McpServerConfig,
    include_schema: Option<bool>,
    persist: Option<bool>,
) -> Result<McpRuntimeTestResponse, String> {
    let manager = state.inner().clone();
    run_blocking("mcp_test_server", move || {
        manager.test_client(
            server,
            include_schema.unwrap_or(false),
            false,
            persist.unwrap_or(true),
        )
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_restart_server(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server: McpServerConfig,
    include_schema: Option<bool>,
    persist: Option<bool>,
) -> Result<McpRuntimeTestResponse, String> {
    let manager = state.inner().clone();
    run_blocking("mcp_restart_server", move || {
        manager.test_client(
            server,
            include_schema.unwrap_or(false),
            true,
            persist.unwrap_or(true),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_content_image_serializes_camel_case() {
        // The TS side (pi-ai's data URL assembly, UI preview) reads `mimeType`. If the
        // field goes out as snake_case, the frontend gets undefined and builds
        // `data:undefined;base64,…` — the image cannot enter the model context, and it
        // also makes the next provider request fail entirely.
        let image = McpContent::Image {
            data: "aW1n".to_string(),
            mime_type: "image/png".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&image).expect("serialize image block"),
            serde_json::json!({ "type": "image", "data": "aW1n", "mimeType": "image/png" }),
        );

        let text = McpContent::Text {
            text: "hi".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&text).expect("serialize text block"),
            serde_json::json!({ "type": "text", "text": "hi" }),
        );
    }

    fn stdio_config(id: &str, command: &str) -> McpServerConfig {
        McpServerConfig {
            id: id.to_string(),
            enabled: true,
            transport: Some("stdio".to_string()),
            command: command.to_string(),
            args: Vec::new(),
            env: None,
            cwd: None,
            url: None,
            headers: None,
            timeout_ms: Some(1_000),
            message_url: None,
            auth: None,
        }
    }

    fn url_config(id: &str, transport: &str, url: Option<&str>) -> McpServerConfig {
        McpServerConfig {
            id: id.to_string(),
            enabled: true,
            transport: Some(transport.to_string()),
            command: String::new(),
            args: Vec::new(),
            env: None,
            cwd: None,
            url: url.map(|value| value.to_string()),
            headers: None,
            timeout_ms: Some(1_000),
            message_url: None,
            auth: None,
        }
    }

    #[test]
    fn bearer_overrides_static_authorization_header() {
        let mut static_headers = HeaderMap::new();
        static_headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer stale"));
        static_headers.insert("x-extra", HeaderValue::from_static("keep"));

        let merged = headers_with_bearer(&static_headers, Some("fresh"));
        let values: Vec<_> = merged.get_all(AUTHORIZATION).iter().collect();
        assert_eq!(
            values.len(),
            1,
            "the OAuth Bearer must overwrite the static Authorization, not append"
        );
        assert_eq!(values[0], "Bearer fresh");
        assert_eq!(
            merged.get("x-extra").unwrap(),
            "keep",
            "other static headers are preserved"
        );

        // With no bearer, pass through unchanged (current behavior including the static Authorization).
        let untouched = headers_with_bearer(&static_headers, None);
        assert_eq!(untouched.get(AUTHORIZATION).unwrap(), "Bearer stale");
    }

    #[test]
    fn oauth_enabled_requires_remote_transport_and_oauth_type() {
        let mut cfg = url_config("srv", "http", Some("https://mcp.example.com/mcp"));
        assert!(!cfg.oauth_enabled(), "no auth config = current behavior");

        cfg.auth = Some(McpAuthConfig {
            auth_type: "none".to_string(),
            scope: None,
            client_id: None,
        });
        assert!(!cfg.oauth_enabled(), "type=none = current behavior");

        cfg.auth = Some(McpAuthConfig {
            auth_type: "oauth".to_string(),
            scope: Some(" mcp.read ".to_string()),
            client_id: Some("".to_string()),
        });
        assert!(cfg.oauth_enabled());
        let server = cfg.oauth_server().expect("oauth server");
        assert_eq!(server.id, "srv");
        assert_eq!(server.scope_override.as_deref(), Some("mcp.read"));
        assert_eq!(server.static_client_id, None, "an empty client_id is treated as unconfigured");

        // Configuring oauth on stdio is meaningless and must not take effect.
        let mut stdio = stdio_config("local", "server-bin");
        stdio.auth = Some(McpAuthConfig {
            auth_type: "oauth".to_string(),
            scope: None,
            client_id: None,
        });
        assert!(!stdio.oauth_enabled());
    }

    #[test]
    fn server_config_deserializes_with_and_without_auth() {
        let legacy: McpServerConfig = serde_json::from_value(json!({
            "id": "srv",
            "enabled": true,
            "transport": "http",
            "command": "",
            "args": [],
            "url": "https://mcp.example.com/mcp"
        }))
        .expect("legacy config");
        assert_eq!(legacy.auth, None);

        let with_auth: McpServerConfig = serde_json::from_value(json!({
            "id": "srv",
            "enabled": true,
            "transport": "http",
            "command": "",
            "args": [],
            "url": "https://mcp.example.com/mcp",
            "auth": { "type": "oauth", "scope": "a b", "clientId": "cid" }
        }))
        .expect("auth config");
        let auth = with_auth.auth.expect("auth present");
        assert_eq!(auth.auth_type, "oauth");
        assert_eq!(auth.scope.as_deref(), Some("a b"));
        assert_eq!(auth.client_id.as_deref(), Some("cid"));
    }

    #[test]
    fn runtime_status_reports_missing_server_without_starting() {
        let manager = McpRuntimeManager::default();
        let status = manager
            .runtime_status("missing")
            .expect("runtime status should succeed");
        assert_eq!(status.server_id, "missing");
        assert!(!status.running);
        assert!(!status.initialized);
    }

    #[test]
    fn stop_client_reports_whether_server_was_running() {
        let manager = McpRuntimeManager::default();
        assert!(!manager.stop_client("missing").expect("stop missing"));
    }

    #[test]
    fn test_client_rejects_invalid_stdio_config_as_config_phase() {
        let manager = McpRuntimeManager::default();
        let result = manager
            .test_client(stdio_config("bad", ""), false, false, true)
            .expect("test client response");
        assert!(!result.ok);
        assert_eq!(result.phase, "config");
        assert_eq!(result.tools_count, 0);
        assert!(result.error.unwrap().contains("command"));
    }

    #[test]
    fn test_client_rejects_missing_http_and_sse_url_as_config_phase() {
        let manager = McpRuntimeManager::default();
        for transport in ["http", "sse"] {
            let result = manager
                .test_client(url_config(transport, transport, None), false, false, true)
                .expect("test client response");
            assert!(!result.ok);
            assert_eq!(result.phase, "config");
            assert_eq!(result.tools_count, 0);
            assert!(result.error.unwrap().contains("url"));
        }
    }

    #[test]
    fn stderr_tail_is_truncated_to_recent_lines() {
        let tail = Arc::new(Mutex::new(Vec::new()));
        for index in 0..(STDERR_TAIL_MAX_LINES + 5) {
            append_stderr_tail(&tail, format!("line-{index}"));
        }
        let locked = tail.lock().expect("tail lock");
        assert_eq!(locked.len(), STDERR_TAIL_MAX_LINES);
        assert_eq!(locked.first().map(String::as_str), Some("line-5"));
        assert_eq!(
            locked.last(),
            Some(&format!("line-{}", STDERR_TAIL_MAX_LINES + 4))
        );
    }

    // http transport spawn only parses the URL and builds a client, so real
    // pool entries can be constructed offline.
    fn offline_http_config(id: &str) -> McpServerConfig {
        url_config(id, "http", Some("http://127.0.0.1:9/mcp"))
    }

    #[test]
    fn ensure_client_reuses_same_config_and_replaces_changed_config() {
        let manager = McpRuntimeManager::default();
        let first = manager
            .ensure_client(offline_http_config("srv"))
            .expect("first ensure");
        let second = manager
            .ensure_client(offline_http_config("srv"))
            .expect("second ensure");
        assert!(Arc::ptr_eq(&first, &second));

        let changed = manager
            .ensure_client(url_config("srv", "http", Some("http://127.0.0.1:9/mcp2")))
            .expect("changed ensure");
        assert!(!Arc::ptr_eq(&first, &changed));
    }

    #[test]
    fn ensure_client_evicts_stale_client_when_respawn_fails() {
        let manager = McpRuntimeManager::default();
        manager
            .ensure_client(offline_http_config("srv"))
            .expect("initial ensure");

        // Switch to a config that is guaranteed to fail spawn (the URL passes the
        // presence check but fails to parse): the old client must be evicted, or
        // mcp_call_tool reading the map directly would keep using the invalid channel.
        manager
            .ensure_client(url_config("srv", "http", Some("::not-a-url::")))
            .expect_err("respawn must fail");
        assert!(
            !manager
                .clients
                .lock()
                .expect("clients lock")
                .contains_key("srv"),
            "stale client must be evicted after failed respawn"
        );
    }

    #[test]
    fn busy_client_does_not_block_other_servers() {
        use std::sync::Barrier;
        use std::time::Duration;

        let manager = Arc::new(McpRuntimeManager::default());
        let client_a = manager
            .ensure_client(offline_http_config("server-a"))
            .expect("seed server-a");

        let barrier = Arc::new(Barrier::new(3));
        // Holder simulates a long-running tools/call on server A.
        let holder = {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let _guard = client_a.lock().expect("hold server-a");
                barrier.wait();
                std::thread::sleep(Duration::from_millis(800));
            })
        };
        // Contender blocks on server A's client lock inside ensure_client. The
        // old implementation did this while holding the pool map lock, which
        // stalled every other server's commands behind it.
        let contender = {
            let manager = manager.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                manager.ensure_client(offline_http_config("server-a"))
            })
        };

        barrier.wait();
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        manager
            .ensure_client(offline_http_config("server-b"))
            .expect("ensure server-b");
        let status = manager.runtime_status("server-b").expect("status server-b");
        assert_eq!(status.server_id, "server-b");
        assert!(manager.stop_client("server-b").expect("stop server-b"));
        assert!(
            started.elapsed() < Duration::from_millis(400),
            "server-b commands stalled behind server-a's busy client"
        );

        contender
            .join()
            .expect("join contender")
            .expect("contender ensure eventually succeeds");
        holder.join().expect("join holder");
    }

    #[test]
    fn detects_windows_batch_programs_by_extension() {
        assert!(is_windows_batch_program(Path::new(
            r"C:\Program Files\nodejs\npx.cmd"
        )));
        assert!(is_windows_batch_program(Path::new(r"C:\tools\run.BAT")));
        assert!(!is_windows_batch_program(Path::new(
            r"C:\Program Files\nodejs\node.exe"
        )));
        assert!(!is_windows_batch_program(Path::new("npx")));
    }

    #[test]
    fn windows_cmd_quote_arg_doubles_embedded_quotes() {
        // cmd.exe does not recognize the `\"` escape; doubling keeps quotes paired.
        assert_eq!(windows_cmd_quote_arg("-y"), r#""-y""#);
        assert_eq!(windows_cmd_quote_arg(r#"a"b"#), r#""a""b""#);
        assert_eq!(windows_cmd_quote_arg("with space"), r#""with space""#);
    }

    #[test]
    fn windows_cmd_quote_arg_doubles_backslashes_before_quotes() {
        // Backslashes before an embedded quote are padded to 2n; after re-parsing they
        // resolve back to n backslashes plus a literal quote.
        assert_eq!(windows_cmd_quote_arg(r#"a\"b"#), r#""a\\""b""#);
        // If trailing backslashes were not doubled they would escape the closing quote
        // and merge with the next argument.
        assert_eq!(windows_cmd_quote_arg(r"C:\data\"), r#""C:\data\\""#);
        // Backslashes not adjacent to a quote are left as-is (path separators are unaffected).
        assert_eq!(windows_cmd_quote_arg(r"C:\a\b"), r#""C:\a\b""#);
        assert_eq!(windows_cmd_quote_arg(""), r#""""#);
    }

    #[test]
    fn windows_cmd_quote_arg_neutralizes_percent_expansion() {
        // The `%%cd:~,` no-op breaks up the %VAR% pairing, so after cmd expands it the
        // child still receives the original text.
        assert_eq!(windows_cmd_quote_arg("%PATH%"), r#""%%cd:~,%PATH%%cd:~,%""#);
        assert_eq!(windows_cmd_quote_arg("100%"), r#""100%%cd:~,%""#);
        assert_eq!(windows_cmd_quote_arg("a\rb"), "\"a%%cd:~,\rb\"");
    }

    #[test]
    fn windows_cmd_c_argument_wraps_whole_line_for_slash_s() {
        // `/S` semantics: after cmd strips the leading/trailing quotes, the full
        // executable command line must be recovered.
        let program = Path::new(r"C:\Program Files\nodejs\npx.cmd");
        let args = vec!["-y".to_string(), "@playwright/mcp".to_string()];
        assert_eq!(
            windows_cmd_c_argument(program, &args),
            r#"""C:\Program Files\nodejs\npx.cmd" "-y" "@playwright/mcp"""#
        );
    }

    #[test]
    fn windows_cmd_c_argument_without_args_still_quotes_program() {
        let program = Path::new(r"C:\tools\npx.cmd");
        assert_eq!(
            windows_cmd_c_argument(program, &[]),
            r#"""C:\tools\npx.cmd"""#
        );
    }

    #[test]
    fn windows_cmd_c_argument_survives_trailing_backslash_arg() {
        // A common way filesystem-type MCP servers are invoked: a directory argument with a trailing backslash.
        let program = Path::new(r"C:\Program Files\nodejs\npx.cmd");
        let args = vec![
            "-y".to_string(),
            "@modelcontextprotocol/server-filesystem".to_string(),
            r"C:\Users\me\docs\".to_string(),
        ];
        assert_eq!(
            windows_cmd_c_argument(program, &args),
            r#"""C:\Program Files\nodejs\npx.cmd" "-y" "@modelcontextprotocol/server-filesystem" "C:\Users\me\docs\\"""#
        );
    }
}
