//! MCP OAuth 2.1 service (docs/design/mcp-oauth.md, roadmap P1-3).
//!
//! Layers:
//! - `discovery` discovery chain (RFC 9728/8414 + legacy-spec fallback)
//! - `register` RFC 7591 dynamic registration
//! - `flow` PKCE/loopback/token endpoint machinery
//! - `store` keychain storage + file fallback + in-process cache
//!
//! This module orchestrates two paths:
//! 1. **Interactive authorization** (`authorize`) -- triggered only by an explicit user gesture
//!    (MCP Hub Connect), opening the system browser; mutually exclusive per server within the process.
//! 2. **Runtime token supply** (`ensure_bearer` / `refresh_after_unauthorized`) -- the transport
//!    fetches a Bearer on every request, proactively refreshes on near-expiry and reactively on
//!    401; it never opens a browser.

pub mod discovery;
pub mod flow;
pub mod register;
pub mod store;

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use store::TokenRecord;

/// Stable marker: an error message containing it means "the user must complete authorization
/// in MCP Hub", and the frontend guides accordingly.
pub const AUTH_REQUIRED_MARKER: &str = "MCP_OAUTH_AUTHORIZATION_REQUIRED";

#[derive(Debug, Clone)]
pub struct OauthServer {
    pub id: String,
    pub url: String,
    /// Scope override from configuration (takes precedence over PRM scopes_supported).
    pub scope_override: Option<String>,
    /// Static client_id (enterprise AS scenario; dynamic registration is skipped once configured).
    pub static_client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OauthStatusInfo {
    /// "none" | "authorized" | "expired" (when expired and refreshable, the runtime self-heals).
    pub state: String,
    pub refreshable: bool,
    /// "keychain" | "file" | "unknown"
    pub storage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

fn none_status() -> OauthStatusInfo {
    OauthStatusInfo {
        state: "none".to_string(),
        refreshable: false,
        storage: store::storage_label().to_string(),
        expires_at_ms: None,
        issuer: None,
        scope: None,
    }
}

fn status_of(record: &TokenRecord) -> OauthStatusInfo {
    let now = store::now_ms();
    OauthStatusInfo {
        state: if record.is_expired(now) {
            "expired".to_string()
        } else {
            "authorized".to_string()
        },
        refreshable: record.refresh_token.is_some(),
        storage: store::storage_label().to_string(),
        expires_at_ms: (record.expires_at_ms != 0).then_some(record.expires_at_ms),
        issuer: Some(record.issuer.clone()),
        scope: record.scope.clone(),
    }
}

/// Loads a record and verifies its server_url matches the current configuration; a mismatch is
/// treated as no token (prevents cross-use).
fn load_matching(server_id: &str, url: &str) -> Option<TokenRecord> {
    let record = store::load(server_id)?;
    let canonical = discovery::canonical_resource(url).ok()?;
    (record.server_url == canonical).then_some(record)
}

pub fn status(server: &OauthServer) -> OauthStatusInfo {
    match load_matching(&server.id, &server.url) {
        Some(record) => status_of(&record),
        None => none_status(),
    }
}

/// Called when uninstalling a server / when the user disconnects authorization: clears the
/// keychain and file-fallback entries.
pub fn clear(server_id: &str) -> Result<(), String> {
    clear_client_suspect(server_id);
    store::delete(server_id)
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    // Egress discipline: uses the app proxy like the MCP transport, and fails fast on proxy misconfiguration.
    crate::services::system_proxy::blocking_client_builder()
        .map_err(|e| format!("Failed to create OAuth HTTP client: {e}"))?
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to create OAuth HTTP client: {e}"))
}

// ---- Interactive authorization (mutually exclusive per server within the process) ----

fn authorize_guard() -> &'static Mutex<HashSet<String>> {
    static GUARD: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(HashSet::new()))
}

struct AuthorizeSlot(String);

impl AuthorizeSlot {
    fn acquire(server_id: &str) -> Result<Self, String> {
        let mut guard = authorize_guard()
            .lock()
            .map_err(|_| "Authorization mutex lock failed".to_string())?;
        if !guard.insert(server_id.to_string()) {
            return Err(format!(
                "Authorization for server `{server_id}` is already in progress; finish it or wait for it to time out"
            ));
        }
        Ok(Self(server_id.to_string()))
    }
}

impl Drop for AuthorizeSlot {
    fn drop(&mut self) {
        if let Ok(mut guard) = authorize_guard().lock() {
            guard.remove(&self.0);
        }
    }
}

/// Stored clients that failed during the browser phase/code exchange (a set of server ids,
/// in-process). A matched server skips reuse on the next authorization and self-heals via direct
/// dynamic re-registration; the keychain record is kept as-is -- an authorization failure may be
/// just a timeout or the user closing the page, and the stored token/refresh_token are still valid
/// at runtime, so usable credentials must not be destroyed over one incomplete Reauthorize.
fn suspect_clients() -> &'static Mutex<HashSet<String>> {
    static SUSPECTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SUSPECTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_client_suspect(server_id: &str) -> bool {
    suspect_clients()
        .lock()
        .map(|set| set.contains(server_id))
        .unwrap_or(false)
}

fn mark_client_suspect(server_id: &str) {
    if let Ok(mut set) = suspect_clients().lock() {
        set.insert(server_id.to_string());
    }
}

fn clear_client_suspect(server_id: &str) {
    if let Ok(mut set) = suspect_clients().lock() {
        set.remove(server_id);
    }
}

/// The full interactive authorization flow (blocks for minutes; must run inside spawn_blocking).
/// `open_url` is injected by the command layer (tauri-plugin-opener), keeping the service layer
/// free of Tauri dependencies.
pub fn authorize(
    server: &OauthServer,
    open_url: &dyn Fn(&str) -> Result<(), String>,
) -> Result<OauthStatusInfo, String> {
    let server_id = server.id.trim();
    if server_id.is_empty() {
        return Err("server id must not be empty".to_string());
    }
    let _slot = AuthorizeSlot::acquire(server_id)?;

    let client = http_client()?;
    let discovered = discovery::discover(&client, &server.url)?;

    // Bind the port before fixing redirect_uri, so dynamic registration carries the exact callback address.
    let loopback = flow::Loopback::bind()?;
    let redirect_uri = loopback.redirect_uri();

    // Client credentials: static config > stored keychain registration (reused only if the issuer
    // matches) > dynamic registration. A stored client that failed the previous authorization is
    // treated as suspect, so reuse is skipped and it is re-registered directly.
    let stored = load_matching(server_id, &server.url);
    let reused_stored_client = !is_client_suspect(server_id)
        && stored.as_ref().is_some_and(|record| {
            record.issuer == discovered.issuer && !record.client_id.is_empty()
        });
    let (client_id, client_secret, auth_method) = if let Some(static_id) = server
        .static_client_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        (static_id.to_string(), None, "none".to_string())
    } else if let (true, Some(record)) = (reused_stored_client, stored.as_ref()) {
        (
            record.client_id.clone(),
            record.client_secret.clone(),
            record.token_endpoint_auth_method.clone(),
        )
    } else {
        let endpoint = discovered.registration_endpoint.as_deref().ok_or_else(|| {
            format!(
                "Authorization server {} does not expose dynamic registration; provide an OAuth Client ID in the server configuration",
                discovered.issuer
            )
        })?;
        let registered = register::dynamic_register(
            &client,
            endpoint,
            &redirect_uri,
            server.scope_override.as_deref(),
        )?;
        (
            registered.client_id,
            registered.client_secret,
            registered.token_endpoint_auth_method,
        )
    };

    let scope = server
        .scope_override
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            (!discovered.scopes_supported.is_empty()).then(|| discovered.scopes_supported.join(" "))
        });

    let pkce = flow::new_pkce()?;
    let state = flow::random_b64url(32)?;
    let authorize_url = flow::build_authorize_url(
        &discovered.authorization_endpoint,
        &client_id,
        &redirect_uri,
        &state,
        &pkce.challenge,
        &discovered.resource,
        scope.as_deref(),
    )?;
    if !flow::is_safe_browser_url(&authorize_url) {
        return Err(format!("Refusing to open an unsafe authorization URL: {authorize_url}"));
    }
    open_url(&authorize_url)?;

    let code = match loopback.wait_for_code(&state, flow::AUTHORIZE_TIMEOUT) {
        Ok(code) => code,
        Err(error) => {
            // The failure reason cannot distinguish "the AS invalidated the reused client" from
            // unrelated faults like a timeout or the user closing the page, so only mark the client
            // suspect (re-register on the next authorization) and keep the stored token.
            if reused_stored_client && server.static_client_id.is_none() {
                mark_client_suspect(server_id);
            }
            return Err(error);
        }
    };

    let credentials = flow::ClientCredentials {
        client_id: &client_id,
        client_secret: client_secret.as_deref(),
        auth_method: &auth_method,
    };
    let tokens = flow::exchange_code(
        &client,
        &discovered.token_endpoint,
        &credentials,
        &code,
        &pkce.verifier,
        &redirect_uri,
        &discovered.resource,
    )
    .map_err(|error| {
        // A rejected code exchange (e.g. invalid_client) likewise only marks the client, deferring re-registration to the next authorization.
        if reused_stored_client && server.static_client_id.is_none() {
            mark_client_suspect(server_id);
        }
        error
    })?;

    let now = store::now_ms();
    let record = TokenRecord {
        version: 1,
        server_url: discovered.resource.clone(),
        issuer: discovered.issuer.clone(),
        authorization_endpoint: discovered.authorization_endpoint.clone(),
        token_endpoint: discovered.token_endpoint.clone(),
        registration_endpoint: discovered.registration_endpoint.clone(),
        client_id,
        client_secret,
        token_endpoint_auth_method: auth_method,
        scope: tokens.scope.clone().or(scope),
        resource: discovered.resource.clone(),
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token.clone(),
        expires_at_ms: tokens
            .expires_in
            .map(|secs| now.saturating_add(secs.saturating_mul(1000)))
            .unwrap_or(0),
    };
    store::save(server_id, &record)?;
    clear_client_suspect(server_id);
    Ok(status_of(&record))
}

// ---- Runtime token supply ----

fn refresh_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn refresh_lock_for(server_id: &str) -> Arc<Mutex<()>> {
    let mut locks = match refresh_locks().lock() {
        Ok(locks) => locks,
        Err(poisoned) => poisoned.into_inner(),
    };
    locks
        .entry(server_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Refreshes and persists; single-flight: concurrent requests re-read after taking the lock and
/// reuse the result if someone else just finished refreshing.
fn refresh_record(server_id: &str, stale: &TokenRecord) -> Result<TokenRecord, String> {
    let lock = refresh_lock_for(server_id);
    let _guard = lock.lock().map_err(|_| "Refresh mutex lock failed".to_string())?;

    if let Some(current) = store::load(server_id) {
        if current.access_token != stale.access_token && !current.is_expiring(store::now_ms()) {
            return Ok(current);
        }
        let refresh_token = current
            .refresh_token
            .clone()
            .ok_or_else(|| "No refresh_token; re-authorization is required".to_string())?;

        let client = http_client()?;
        let credentials = flow::ClientCredentials {
            client_id: &current.client_id,
            client_secret: current.client_secret.as_deref(),
            auth_method: &current.token_endpoint_auth_method,
        };
        let tokens = flow::refresh_grant(
            &client,
            &current.token_endpoint,
            &credentials,
            &refresh_token,
            &current.resource,
        )?;

        let now = store::now_ms();
        let mut next = current.clone();
        next.access_token = tokens.access_token;
        // RFC 6749 §6: the AS may rotate refresh_token; if not returned, keep the old value.
        if let Some(rotated) = tokens.refresh_token {
            next.refresh_token = Some(rotated);
        }
        if let Some(scope) = tokens.scope {
            next.scope = Some(scope);
        }
        next.expires_at_ms = tokens
            .expires_in
            .map(|secs| now.saturating_add(secs.saturating_mul(1000)))
            .unwrap_or(0);
        store::save(server_id, &next)?;
        Ok(next)
    } else {
        Err("Token record no longer exists; re-authorization is required".to_string())
    }
}

/// The transport fetches a Bearer on every request: returns None when there is no record / the URL
/// does not match (the request goes out bare, and 401 takes the reactive path); proactively refreshes
/// when near expiry and refreshable, and still returns the old token as a fallback if the refresh fails.
pub fn ensure_bearer(server_id: &str, url: &str) -> Option<String> {
    let record = load_matching(server_id, url)?;
    if record.is_expiring(store::now_ms()) && record.refresh_token.is_some() {
        match refresh_record(server_id.trim(), &record) {
            Ok(next) => return Some(next.access_token),
            Err(error) => {
                eprintln!("[MCP OAuth] proactive refresh for server `{server_id}` failed; falling back to the old token: {error}");
            }
        }
    }
    Some(record.access_token)
}

/// 401 reactive refresh: returns the new Bearer on success; when infeasible (no record / no
/// refresh_token / refresh rejected) returns Err -- the caller should convert it into a user-visible
/// error carrying [`AUTH_REQUIRED_MARKER`].
pub fn refresh_after_unauthorized(server_id: &str, url: &str) -> Result<String, String> {
    let record = load_matching(server_id, url)
        .ok_or_else(|| "OAuth authorization not yet completed (no token record)".to_string())?;
    let refreshed = refresh_record(server_id.trim(), &record)?;
    Ok(refreshed.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_slot_blocks_concurrent_same_server() {
        let slot = AuthorizeSlot::acquire("dup-server").expect("first");
        let second = AuthorizeSlot::acquire("dup-server");
        assert!(second.is_err(), "concurrent authorization for the same server must be rejected");
        assert!(
            AuthorizeSlot::acquire("other-server").is_ok(),
            "other servers are unaffected"
        );
        drop(slot);
        assert!(
            AuthorizeSlot::acquire("dup-server").is_ok(),
            "authorization is possible again after release"
        );
    }

    #[test]
    fn suspect_marking_skips_reuse_without_touching_other_servers() {
        assert!(!is_client_suspect("suspect-a"));
        mark_client_suspect("suspect-a");
        assert!(is_client_suspect("suspect-a"), "after marking, the next authorization should skip reuse");
        assert!(!is_client_suspect("suspect-b"), "the mark only affects that server");
        clear_client_suspect("suspect-a");
        assert!(!is_client_suspect("suspect-a"), "the mark is cleared after a successful authorization/clear");
        // Repeated clear is idempotent.
        clear_client_suspect("suspect-a");
        assert!(!is_client_suspect("suspect-a"));
    }

    #[test]
    fn status_maps_expiry_and_refreshability() {
        let now = store::now_ms();
        let mut record = TokenRecord {
            version: 1,
            server_url: "https://mcp.example.com/mcp".to_string(),
            issuer: "https://auth.example.com".to_string(),
            authorization_endpoint: "https://auth.example.com/authorize".to_string(),
            token_endpoint: "https://auth.example.com/token".to_string(),
            registration_endpoint: None,
            client_id: "c".to_string(),
            client_secret: None,
            token_endpoint_auth_method: "none".to_string(),
            scope: Some("s".to_string()),
            resource: "https://mcp.example.com/mcp".to_string(),
            access_token: "at".to_string(),
            refresh_token: Some("rt".to_string()),
            expires_at_ms: now + 3_600_000,
        };
        let live = status_of(&record);
        assert_eq!(live.state, "authorized");
        assert!(live.refreshable);
        assert_eq!(live.expires_at_ms, Some(record.expires_at_ms));

        record.expires_at_ms = 1;
        record.refresh_token = None;
        let dead = status_of(&record);
        assert_eq!(dead.state, "expired");
        assert!(!dead.refreshable);
    }
}
