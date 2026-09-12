//! Single source of truth for the system proxy: written when settings are saved / at startup
//! initialization, and read on demand by shell env injection and the various reqwest egress
//! points (local reverse proxy, image reverse proxy, update checks, skill downloads,
//! MCP http/sse transport, Hook / Cron HTTP, network self-check, Image.url reads).
//! The reqwest side and shell env share NO_PROXY_DEFAULT: loopback addresses never go through a proxy.
//! Credentials never enter logs or error messages (only host:port is output).
//! Exception: when the app proxy is not enabled, the GitHub update path does not apply the
//! no_proxy() closure but falls back to reqwest's default proxy detection (OS proxy env
//! vars/system proxy settings), see `client_builder_with_os_proxy_fallback()`.

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::Value;
use std::net::Ipv6Addr;
use std::sync::{OnceLock, RwLock};

const SYSTEM_PROXY_TYPE_HTTP: &str = "http";
pub const SYSTEM_PROXY_TYPE_SOCKS5: &str = "socks5";
const NO_PROXY_DEFAULT: &str = "localhost,127.0.0.1,::1";

#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystemProxyConfig {
    pub enabled: bool,
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

impl SystemProxyConfig {
    fn scheme(&self) -> &'static str {
        if self.proxy_type == SYSTEM_PROXY_TYPE_SOCKS5 {
            "socks5h"
        } else {
            "http"
        }
    }

    fn proxy_url(&self) -> String {
        let credentials = if self.username.is_empty() && self.password.is_empty() {
            String::new()
        } else {
            format!(
                "{}:{}@",
                utf8_percent_encode(&self.username, NON_ALPHANUMERIC),
                utf8_percent_encode(&self.password, NON_ALPHANUMERIC)
            )
        };
        format!(
            "{}://{}{}:{}",
            self.scheme(),
            credentials,
            self.url_host(),
            self.port
        )
    }

    fn display_target(&self) -> String {
        format!("{}:{}", self.url_host(), self.port)
    }

    fn url_host(&self) -> String {
        let host = self.host.trim();
        if host.starts_with('[') && host.ends_with(']') {
            return host.to_string();
        }
        if host.parse::<Ipv6Addr>().is_ok() {
            return format!("[{host}]");
        }
        host.to_string()
    }
}

fn host_is_valid(host: &str) -> bool {
    let host = host.trim();
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '@' | '#' | '?' | '%'))
    {
        return false;
    }
    if host.starts_with('[') || host.ends_with(']') {
        return host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .is_some_and(|value| value.parse::<Ipv6Addr>().is_ok());
    }
    !host.contains(':') || host.parse::<Ipv6Addr>().is_ok()
}

#[derive(Clone, Debug, PartialEq)]
enum ProxyMode {
    Disabled,
    Enabled(SystemProxyConfig),
    Invalid(String),
}

#[derive(Clone, Debug)]
struct ProxySnapshot {
    revision: u64,
    mode: ProxyMode,
}

#[derive(Clone)]
struct CachedAsyncClient {
    revision: u64,
    client: reqwest::Client,
}

struct SystemProxyState {
    snapshot: RwLock<ProxySnapshot>,
    async_client: RwLock<Option<CachedAsyncClient>>,
}

fn state() -> &'static SystemProxyState {
    static STATE: OnceLock<SystemProxyState> = OnceLock::new();
    STATE.get_or_init(|| SystemProxyState {
        snapshot: RwLock::new(ProxySnapshot {
            revision: 0,
            mode: ProxyMode::Disabled,
        }),
        async_client: RwLock::new(None),
    })
}

fn parse_proxy_mode(raw: Option<&Value>) -> ProxyMode {
    let Some(raw) = raw else {
        return ProxyMode::Disabled;
    };
    let mut config = match serde_json::from_value::<SystemProxyConfig>(raw.clone()) {
        Ok(config) => config,
        Err(_) => return ProxyMode::Invalid("invalid app proxy config format".to_string()),
    };
    if !config.enabled {
        return ProxyMode::Disabled;
    }
    config.host = config.host.trim().to_string();
    config.username = config.username.trim().to_string();
    if !matches!(
        config.proxy_type.as_str(),
        SYSTEM_PROXY_TYPE_HTTP | SYSTEM_PROXY_TYPE_SOCKS5
    ) || config.port == 0
        || !host_is_valid(&config.host)
    {
        return ProxyMode::Invalid("app proxy is enabled but the address, port, or type is invalid".to_string());
    }
    match build_proxy(&config) {
        Ok(_) => ProxyMode::Enabled(config),
        Err(error) => ProxyMode::Invalid(error),
    }
}

pub fn set_config(raw: Option<&Value>) {
    let mode = parse_proxy_mode(raw);
    let mut snapshot = state()
        .snapshot
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Every settings save refreshes the proxy state; revision is bumped only when the config
    // actually changes, otherwise consumers that rebuild on revision (client cache, MCP runtime)
    // would be needlessly disturbed by unrelated saves.
    if snapshot.mode == mode {
        return;
    }
    snapshot.revision = snapshot.revision.wrapping_add(1);
    snapshot.mode = mode;
    drop(snapshot);
    *state()
        .async_client
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// Change counter for the current proxy config. Long-lived connections (e.g. an MCP client)
/// record it when established and compare against the current value before reuse to detect a
/// proxy config change and rebuild.
/// Copies the u64 directly under the read lock instead of cloning the whole snapshot (this
/// function is called frequently on the MCP command path).
pub fn revision() -> u64 {
    state()
        .snapshot
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .revision
}

fn current_snapshot() -> ProxySnapshot {
    state()
        .snapshot
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn shell_proxy_envs_for_mode(mode: &ProxyMode) -> Result<Vec<(String, String)>, String> {
    let config = match mode {
        ProxyMode::Disabled => return Ok(Vec::new()),
        ProxyMode::Invalid(error) => return Err(error.clone()),
        ProxyMode::Enabled(config) => config,
    };
    let proxy_url = config.proxy_url();
    let mut envs = Vec::with_capacity(8);
    for key in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        envs.push((key.to_string(), proxy_url.clone()));
    }
    for key in ["NO_PROXY", "no_proxy"] {
        envs.push((key.to_string(), NO_PROXY_DEFAULT.to_string()));
    }
    Ok(envs)
}

pub fn shell_proxy_envs() -> Result<Vec<(String, String)>, String> {
    shell_proxy_envs_for_mode(&current_snapshot().mode)
}

fn build_proxy(config: &SystemProxyConfig) -> Result<reqwest::Proxy, String> {
    reqwest::Proxy::all(config.proxy_url())
        // The loopback exemption must match the NO_PROXY injected into the shell env, otherwise
        // local upstreams (e.g. an MCP server on 127.0.0.1) would be wrongly sent through the proxy.
        .map(|proxy| proxy.no_proxy(reqwest::NoProxy::from_string(NO_PROXY_DEFAULT)))
        .map_err(|_| format!("invalid app proxy address: {}", config.display_target()))
}

fn async_client_builder_for_mode(mode: &ProxyMode) -> Result<reqwest::ClientBuilder, String> {
    let builder = reqwest::Client::builder().no_proxy();
    match mode {
        ProxyMode::Disabled => Ok(builder),
        ProxyMode::Invalid(error) => Err(error.clone()),
        ProxyMode::Enabled(config) => Ok(builder.proxy(build_proxy(config)?)),
    }
}

fn blocking_client_builder_for_mode(
    mode: &ProxyMode,
) -> Result<reqwest::blocking::ClientBuilder, String> {
    let builder = reqwest::blocking::Client::builder().no_proxy();
    match mode {
        ProxyMode::Disabled => Ok(builder),
        ProxyMode::Invalid(error) => Err(error.clone()),
        ProxyMode::Enabled(config) => Ok(builder.proxy(build_proxy(config)?)),
    }
}

pub fn cached_client() -> Result<reqwest::Client, String> {
    let snapshot = current_snapshot();
    {
        let cached = state()
            .async_client
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cached) = cached
            .as_ref()
            .filter(|client| client.revision == snapshot.revision)
        {
            return Ok(cached.client.clone());
        }
    }
    let client = async_client_builder_for_mode(&snapshot.mode)?
        .build()
        .map_err(|_| "failed to create the app proxy HTTP client".to_string())?;
    let current_revision = current_snapshot().revision;
    if current_revision == snapshot.revision {
        *state()
            .async_client
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(CachedAsyncClient {
            revision: snapshot.revision,
            client: client.clone(),
        });
    }
    Ok(client)
}

fn os_proxy_fallback_builder_for_mode(mode: &ProxyMode) -> Result<reqwest::ClientBuilder, String> {
    match mode {
        // Do not call no_proxy(): keep reqwest's default proxy detection (OS proxy env vars and
        // macOS/Windows system proxy settings, the system-proxy default feature); with no system
        // proxy it connects directly.
        ProxyMode::Disabled => Ok(reqwest::Client::builder()),
        mode => async_client_builder_for_mode(mode),
    }
}

/// For the GitHub update path only: when the app proxy is enabled it goes through the app proxy
/// like other egress points (an invalid config likewise fails fast); when disabled it falls back
/// to OS system proxy detection rather than forcing a direct connection, keeping the GitHub update
/// address reachable where possible. All other egress points still use the explicit no_proxy
/// semantics of `cached_client()`/`blocking_client_builder()`.
pub fn client_builder_with_os_proxy_fallback() -> Result<reqwest::ClientBuilder, String> {
    os_proxy_fallback_builder_for_mode(&current_snapshot().mode)
}

pub fn blocking_client_builder() -> Result<reqwest::blocking::ClientBuilder, String> {
    blocking_client_builder_for_mode(&current_snapshot().mode)
}

/// Lets custom TCP tunnels (e.g. SSH transport) reuse the app proxy: `Ok(None)` means disabled
/// (direct connection), `Err` means enabled but with an invalid config (the caller fails fast),
/// and `Ok(Some)` returns a copy of the config.
pub fn current_config() -> Result<Option<SystemProxyConfig>, String> {
    match current_snapshot().mode {
        ProxyMode::Disabled => Ok(None),
        ProxyMode::Invalid(error) => Err(error),
        ProxyMode::Enabled(config) => Ok(Some(config)),
    }
}

/// Async version of `blocking_client_builder()`: explicit no_proxy semantics, for egress points
/// that need custom options such as timeouts/redirects and cannot directly reuse `cached_client()`.
pub fn async_client_builder() -> Result<reqwest::ClientBuilder, String> {
    async_client_builder_for_mode(&current_snapshot().mode)
}

/// Resolved proxy URL for consumers that configure their own HTTP client rather
/// than using `cached_client()`/`blocking_client_builder()` (e.g.
/// `tauri-plugin-updater`, which only accepts a `Url` on its builder).
/// `Ok(None)` means the app proxy is
/// disabled — the GitHub update path deliberately leaves its client on reqwest's
/// default proxy detection then (OS proxy env vars / system proxy settings),
/// mirroring `client_builder_with_os_proxy_fallback()`.
pub fn current_proxy_url() -> Result<Option<reqwest::Url>, String> {
    match current_snapshot().mode {
        ProxyMode::Disabled => Ok(None),
        ProxyMode::Invalid(error) => Err(error),
        ProxyMode::Enabled(config) => reqwest::Url::parse(&config.proxy_url())
            .map(Some)
            .map_err(|_| format!("invalid app proxy address: {}", config.display_target())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(value: Value) -> SystemProxyConfig {
        match parse_proxy_mode(Some(&value)) {
            ProxyMode::Enabled(config) => config,
            mode => panic!("expected enabled proxy config, got {mode:?}"),
        }
    }

    #[test]
    fn proxy_url_http_without_credentials() {
        let parsed = config(json!({
            "enabled": true, "type": "http", "host": "proxy.local", "port": 8080,
            "username": "", "password": ""
        }));
        assert_eq!(parsed.proxy_url(), "http://proxy.local:8080");
    }

    #[test]
    fn proxy_url_socks5_uses_socks5h_and_percent_encodes_credentials() {
        let parsed = config(json!({
            "enabled": true, "type": "socks5", "host": "10.0.0.1", "port": 1080,
            "username": "user@corp", "password": "p@ss:w0rd"
        }));
        assert_eq!(
            parsed.proxy_url(),
            "socks5h://user%40corp:p%40ss%3Aw0rd@10.0.0.1:1080"
        );
    }

    #[test]
    fn proxy_url_brackets_ipv6_hosts() {
        let parsed = config(json!({
            "enabled": true, "type": "http", "host": "::1", "port": 8080
        }));
        assert_eq!(parsed.proxy_url(), "http://[::1]:8080");
    }

    #[test]
    fn invalid_enabled_configs_fail_instead_of_becoming_disabled() {
        assert!(matches!(
            parse_proxy_mode(Some(&json!({
                "enabled": false, "type": "http", "host": "proxy.local", "port": 8080
            }))),
            ProxyMode::Disabled
        ));
        for value in [
            json!({
            "enabled": true, "type": "http", "host": "", "port": 8080
            }),
            json!({
            "enabled": true, "type": "http", "host": "proxy.local", "port": 0
            }),
            json!({
            "enabled": true, "type": "http", "host": "bad host/@", "port": 8080
            }),
            json!({
                "enabled": true, "type": "https", "host": "proxy.local", "port": 8080
            }),
        ] {
            let mode = parse_proxy_mode(Some(&value));
            assert!(matches!(mode, ProxyMode::Invalid(_)));
            assert!(async_client_builder_for_mode(&mode).is_err());
            assert!(blocking_client_builder_for_mode(&mode).is_err());
            // The update path's fallback builder must likewise not silently downgrade Invalid to a
            // direct connection/system proxy.
            assert!(os_proxy_fallback_builder_for_mode(&mode).is_err());
            assert!(shell_proxy_envs_for_mode(&mode).is_err());
        }
    }

    #[test]
    fn os_proxy_fallback_builder_accepts_disabled_and_enabled_modes() {
        assert!(os_proxy_fallback_builder_for_mode(&ProxyMode::Disabled).is_ok());
        let enabled = parse_proxy_mode(Some(&json!({
            "enabled": true, "type": "http", "host": "proxy.local", "port": 8080
        })));
        assert!(matches!(enabled, ProxyMode::Enabled(_)));
        assert!(os_proxy_fallback_builder_for_mode(&enabled).is_ok());
    }

    #[test]
    fn proxy_mode_equality_drives_set_config_dedupe() {
        let config = json!({
            "enabled": true, "type": "http", "host": "proxy.local", "port": 8080
        });
        // set_config decides whether to bump revision based on ProxyMode equality:
        // saving the same config repeatedly must compare equal, and a change in any field must
        // compare unequal.
        assert_eq!(
            parse_proxy_mode(Some(&config)),
            parse_proxy_mode(Some(&config))
        );
        let changed_port = json!({
            "enabled": true, "type": "http", "host": "proxy.local", "port": 8081
        });
        assert_ne!(
            parse_proxy_mode(Some(&config)),
            parse_proxy_mode(Some(&changed_port))
        );
        assert_eq!(parse_proxy_mode(None), ProxyMode::Disabled);
    }

    #[test]
    fn shell_proxy_envs_cover_all_variables() {
        let mode = parse_proxy_mode(Some(&json!({
            "enabled": true, "type": "socks5", "host": "127.0.0.2", "port": 1080,
            "username": "", "password": ""
        })));
        let envs = shell_proxy_envs_for_mode(&mode).expect("proxy envs");
        let map: std::collections::HashMap<_, _> = envs.iter().cloned().collect();
        assert_eq!(envs.len(), 8);
        for key in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            assert_eq!(
                map.get(key).map(String::as_str),
                Some("socks5h://127.0.0.2:1080")
            );
        }
        for key in ["NO_PROXY", "no_proxy"] {
            assert_eq!(map.get(key).map(String::as_str), Some(NO_PROXY_DEFAULT));
        }
        assert!(shell_proxy_envs_for_mode(&ProxyMode::Disabled)
            .expect("disabled proxy envs")
            .is_empty());
    }

    #[test]
    fn current_proxy_url_reflects_mode() {
        set_config(None);
        assert_eq!(current_proxy_url().expect("disabled proxy url"), None);

        set_config(Some(&json!({
            "enabled": true, "type": "http", "host": "proxy.local", "port": 8080
        })));
        assert_eq!(
            current_proxy_url()
                .expect("enabled proxy url")
                .map(|url| url.to_string()),
            Some("http://proxy.local:8080/".to_string())
        );

        set_config(Some(&json!({
            "enabled": true, "type": "http", "host": "bad host/@", "port": 8080
        })));
        assert!(current_proxy_url().is_err());

        // reset so other tests in this module observe the default disabled state
        set_config(None);
    }
}
