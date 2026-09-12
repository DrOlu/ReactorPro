use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::runtime::platform::{expand_tilde_path, strip_windows_verbatim_prefix};

const DEFAULT_HTTP_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestInput {
    pub id: String,
    pub url: String,
    pub method: String,
    pub headers: Option<BTreeMap<String, String>>,
    pub body: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpExecutionResult {
    pub id: String,
    pub url: String,
    pub method: String,
    pub status: u16,
    pub response_body: String,
    pub duration_ms: u128,
}

#[derive(Debug, Clone)]
pub struct HttpExecutionFailure {
    pub duration_ms: u128,
    message: String,
}

impl HttpExecutionFailure {
    fn new(duration_ms: u128, message: String) -> Self {
        Self {
            duration_ms,
            message,
        }
    }
}

impl std::fmt::Display for HttpExecutionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for HttpExecutionFailure {}

pub(crate) fn resolve_workdir(workdir: Option<String>) -> Result<PathBuf, String> {
    let raw = workdir.unwrap_or_default();
    let base = if raw.trim().is_empty() {
        std::env::current_dir().map_err(|e| format!("Failed to read app cwd: {e}"))?
    } else {
        let path = expand_tilde_path(raw.trim());
        if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|e| format!("Failed to read app cwd: {e}"))?
                .join(path)
        }
    };

    let metadata = fs::metadata(&base).map_err(|e| format!("Invalid Hook working directory: {e}"))?;
    if !metadata.is_dir() {
        return Err("Hook working directory must be a directory".to_string());
    }
    // The resolved path is stringified into PromptRunRequest.workdir and used
    // as a child-process cwd: keep it in classic Win32 form, not `\\?\`.
    fs::canonicalize(base)
        .map(strip_windows_verbatim_prefix)
        .map_err(|e| format!("Failed to resolve Hook working directory: {e}"))
}

fn build_header_map(headers: &Option<BTreeMap<String, String>>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    let Some(headers) = headers else {
        return Ok(map);
    };

    for (key, value) in headers {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("Invalid Hook header name: {key}"))?;
        let value =
            HeaderValue::from_str(value).map_err(|_| format!("Invalid Hook header value: {key}"))?;
        map.insert(name, value);
    }

    Ok(map)
}

/// `timeout_ms` bounds every request made by the returned client; `None`
/// keeps the legacy 10s default used by hooks.
///
/// Hook / Cron HTTP follows the same policy as other app egress points: when the app
/// proxy is enabled, traffic goes out through the proxy (loopback addresses exempt)
/// and misconfiguration fails fast; when disabled, it connects directly and ignores
/// environment proxies, so an OS-level HTTP(S)_PROXY cannot silently hijack automation requests.
pub(crate) fn build_http_client(timeout_ms: Option<u64>) -> Result<Client, String> {
    crate::services::system_proxy::blocking_client_builder()
        .map_err(|e| format!("Failed to create Hook HTTP client: {e}"))?
        .timeout(Duration::from_millis(
            timeout_ms.unwrap_or(DEFAULT_HTTP_TIMEOUT_MS).max(1),
        ))
        .build()
        .map_err(|e| format!("Failed to create Hook HTTP client: {e}"))
}

pub(crate) fn run_single_http_request(
    client: &Client,
    request: HttpRequestInput,
) -> Result<HttpExecutionResult, HttpExecutionFailure> {
    let method_raw = request.method.trim().to_uppercase();
    let method = Method::from_bytes(method_raw.as_bytes()).map_err(|_| {
        HttpExecutionFailure::new(0, format!("Invalid Hook HTTP method: {method_raw}"))
    })?;
    let url = request.url.trim().to_string();
    if url.is_empty() {
        return Err(HttpExecutionFailure::new(
            0,
            "Hook HTTP request URL must not be empty".to_string(),
        ));
    }
    Url::parse(&url)
        .map_err(|e| HttpExecutionFailure::new(0, format!("Invalid Hook HTTP URL: {url} ({e})")))?;

    let headers = build_header_map(&request.headers)
        .map_err(|message| HttpExecutionFailure::new(0, message))?;
    let start = Instant::now();
    let mut builder = client.request(method.clone(), &url);
    if !headers.is_empty() {
        builder = builder.headers(headers);
    }
    if matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        if let Some(body) = &request.body {
            builder = builder.json(body);
        }
    }

    let response = builder.send().map_err(|e| {
        HttpExecutionFailure::new(
            start.elapsed().as_millis(),
            format!("Hook HTTP request failed: {} {} ({e})", method, url),
        )
    })?;
    let status = response.status();
    let response_body = response.text().map_err(|e| {
        HttpExecutionFailure::new(
            start.elapsed().as_millis(),
            format!("Failed to read Hook HTTP response: {} {} ({e})", method, url),
        )
    })?;
    let duration_ms = start.elapsed().as_millis();

    if !status.is_success() {
        let preview = response_body.trim();
        return Err(HttpExecutionFailure::new(
            duration_ms,
            if preview.is_empty() {
                format!("Hook HTTP request failed: {} {} -> {}", method, url, status)
            } else {
                format!(
                    "Hook HTTP request failed: {} {} -> {}\n{}",
                    method, url, status, preview
                )
            },
        ));
    }

    Ok(HttpExecutionResult {
        id: request.id,
        url,
        method: method_raw,
        status: status.as_u16(),
        response_body,
        duration_ms,
    })
}
