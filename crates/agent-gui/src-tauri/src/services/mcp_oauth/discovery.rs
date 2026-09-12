//! OAuth discovery chain (docs/design/mcp-oauth.md §4.1/§4.3).
//!
//! The 401 `WWW-Authenticate` `resource_metadata` (RFC 9728) → PRM
//! `authorization_servers[0]` → RFC 8414 AS metadata (path-aware candidates + OIDC
//! fallback); when none of that is available, fall back to the 2025-03-26 legacy spec
//! (AS = server origin, using the default `/authorize` `/token` `/register` endpoints
//! when metadata is missing).

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::StatusCode;
use reqwest::Url;
use serde::Deserialize;
use serde_json::json;

/// Discovery result: all endpoints and scope hints the authorization flow needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovered {
    /// RFC 8707 resource parameter value (canonicalized server URL).
    pub resource: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    /// PRM `scopes_supported` (the default scope source for authorization requests).
    pub scopes_supported: Vec<String>,
    /// The legacy default endpoints were used (no AS metadata was obtained).
    pub legacy_default_endpoints: bool,
}

#[derive(Debug, Default, Deserialize)]
struct ProtectedResourceMetadata {
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AuthServerMetadata {
    #[serde(default)]
    issuer: Option<String>,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    registration_endpoint: Option<String>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

/// The MCP spec's canonical resource: lowercase scheme/host, drop the default port,
/// drop the fragment, and omit the trailing slash on the root path. `Url` serialization
/// naturally covers the first three.
pub fn canonical_resource(raw: &str) -> Result<String, String> {
    let mut url =
        Url::parse(raw.trim()).map_err(|e| format!("invalid MCP server URL: {raw} ({e})"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("MCP server URL must be http/https: {raw}"));
    }
    url.set_fragment(None);
    let mut out = url.to_string();
    if url.path() == "/" && url.query().is_none() {
        out.truncate(out.trim_end_matches('/').len());
    }
    Ok(out)
}

/// Parse the `resource_metadata` auth-param from a `WWW-Authenticate` challenge (RFC 9728 §5.1).
pub fn parse_resource_metadata_param(header: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();
    let key_at = lower.find("resource_metadata")?;
    let rest = &header[key_at + "resource_metadata".len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    if let Some(quoted) = rest.strip_prefix('"') {
        let end = quoted.find('"')?;
        let value = quoted[..end].trim();
        return (!value.is_empty()).then(|| value.to_string());
    }
    let end = rest
        .find([',', ' ', '\t'])
        .unwrap_or(rest.len());
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Probe the MCP endpoint without credentials and collect the 401's
/// `WWW-Authenticate` resource_metadata. Returns None for a non-401 (even success) —
/// the upper layer then falls back to well-known derivation.
fn probe_resource_metadata_url(client: &Client, server_url: &Url) -> Option<String> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "clientInfo": { "name": "ReactorPro", "version": crate::app_version() },
            "capabilities": {}
        }
    });
    let resp = client
        .post(server_url.clone())
        .header(ACCEPT, "application/json, text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .ok()?;
    if resp.status() != StatusCode::UNAUTHORIZED {
        return None;
    }
    resp.headers()
        .get_all(WWW_AUTHENTICATE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(parse_resource_metadata_param)
}

fn origin_of(url: &Url) -> Url {
    let mut origin = url.clone();
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    origin
}

/// RFC 9728 well-known candidates: for a server with a path, try the path-insertion form first, then the root form.
pub fn prm_well_known_candidates(server_url: &Url) -> Vec<String> {
    let mut out = Vec::new();
    let origin = origin_of(server_url).to_string();
    let base = origin.trim_end_matches('/');
    let path = server_url.path().trim_end_matches('/');
    if !path.is_empty() {
        out.push(format!("{base}/.well-known/oauth-protected-resource{path}"));
    }
    out.push(format!("{base}/.well-known/oauth-protected-resource"));
    out
}

/// The RFC 8414 + OIDC AS metadata candidate sequence (design §4.3).
pub fn as_metadata_candidates(issuer: &str) -> Vec<String> {
    let Ok(url) = Url::parse(issuer.trim()) else {
        return Vec::new();
    };
    if !matches!(url.scheme(), "http" | "https") {
        return Vec::new();
    }
    let origin = origin_of(&url).to_string();
    let base = origin.trim_end_matches('/').to_string();
    let path = url.path().trim_end_matches('/');

    if path.is_empty() {
        vec![
            format!("{base}/.well-known/oauth-authorization-server"),
            format!("{base}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{base}/.well-known/oauth-authorization-server{path}"),
            format!("{base}/.well-known/openid-configuration{path}"),
            format!("{base}{path}/.well-known/openid-configuration"),
        ]
    }
}

fn fetch_json<T: for<'de> Deserialize<'de>>(client: &Client, url: &str) -> Result<T, String> {
    let resp = client
        .get(url)
        .header(ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("request to {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("request to {url} returned {}", resp.status()));
    }
    let body = resp
        .text()
        .map_err(|e| format!("failed to read response from {url}: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("failed to parse JSON from {url}: {e}"))
}

fn fetch_as_metadata(client: &Client, issuer: &str) -> Option<AuthServerMetadata> {
    as_metadata_candidates(issuer)
        .iter()
        .find_map(|candidate| fetch_json::<AuthServerMetadata>(client, candidate).ok())
}

/// The complete discovery chain. `server_url_raw` is the MCP endpoint from the config.
pub fn discover(client: &Client, server_url_raw: &str) -> Result<Discovered, String> {
    let resource = canonical_resource(server_url_raw)?;
    let server_url = Url::parse(&resource).map_err(|e| format!("URL parse failed: {e}"))?;

    // 1) PRM: prefer the resource_metadata from the 401 challenge, fall back to well-known derivation.
    let mut prm_urls: Vec<String> = Vec::new();
    if let Some(from_challenge) = probe_resource_metadata_url(client, &server_url) {
        prm_urls.push(from_challenge);
    }
    prm_urls.extend(prm_well_known_candidates(&server_url));

    let prm = prm_urls
        .iter()
        .find_map(|url| fetch_json::<ProtectedResourceMetadata>(client, url).ok());

    // 2) issuer: prefer what PRM declares, else fall back to the legacy spec (AS = server origin).
    let (issuer, scopes_supported, legacy_issuer) = match prm {
        Some(doc) if !doc.authorization_servers.is_empty() => {
            (doc.authorization_servers[0].clone(), doc.scopes_supported, false)
        }
        Some(doc) => {
            let origin = origin_of(&server_url).to_string();
            (
                origin.trim_end_matches('/').to_string(),
                doc.scopes_supported,
                true,
            )
        }
        None => {
            let origin = origin_of(&server_url).to_string();
            (origin.trim_end_matches('/').to_string(), Vec::new(), true)
        }
    };

    // 3) AS metadata; when all attempts fail and we are on the legacy branch, use the default endpoints.
    match fetch_as_metadata(client, &issuer) {
        Some(meta) => {
            // The MCP spec requires confirming S256 support; a missing field (legacy AS)
            // passes, but a declared list must include it.
            if !meta.code_challenge_methods_supported.is_empty()
                && !meta
                    .code_challenge_methods_supported
                    .iter()
                    .any(|m| m == "S256")
            {
                return Err(format!(
                    "authorization server {issuer} does not support PKCE S256 (code_challenge_methods_supported={:?}); the MCP spec requires S256",
                    meta.code_challenge_methods_supported
                ));
            }
            let scopes = if scopes_supported.is_empty() {
                meta.scopes_supported
            } else {
                scopes_supported
            };
            Ok(Discovered {
                resource,
                issuer: meta.issuer.unwrap_or(issuer),
                authorization_endpoint: meta.authorization_endpoint,
                token_endpoint: meta.token_endpoint,
                registration_endpoint: meta.registration_endpoint,
                scopes_supported: scopes,
                legacy_default_endpoints: false,
            })
        }
        None if legacy_issuer => Ok(Discovered {
            resource,
            authorization_endpoint: format!("{issuer}/authorize"),
            token_endpoint: format!("{issuer}/token"),
            registration_endpoint: Some(format!("{issuer}/register")),
            issuer,
            scopes_supported,
            legacy_default_endpoints: true,
        }),
        None => Err(format!(
            "failed to obtain authorization server metadata: {issuer} (tried {:?})",
            as_metadata_candidates(&issuer)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_resource_normalizes_case_port_and_root_slash() {
        assert_eq!(
            canonical_resource("HTTPS://MCP.Example.COM:443/").expect("root"),
            "https://mcp.example.com"
        );
        assert_eq!(
            canonical_resource("https://mcp.example.com:8443/mcp#frag").expect("path"),
            "https://mcp.example.com:8443/mcp"
        );
        assert_eq!(
            canonical_resource(" https://mcp.example.com/mcp/ ").expect("trim"),
            "https://mcp.example.com/mcp/"
        );
        assert!(canonical_resource("ftp://x.example.com").is_err());
        assert!(canonical_resource("not a url").is_err());
    }

    #[test]
    fn parses_resource_metadata_from_challenge_variants() {
        assert_eq!(
            parse_resource_metadata_param(
                r#"Bearer realm="mcp", resource_metadata="https://s.example.com/.well-known/oauth-protected-resource""#
            ),
            Some("https://s.example.com/.well-known/oauth-protected-resource".to_string())
        );
        assert_eq!(
            parse_resource_metadata_param(
                "Bearer resource_metadata=https://s.example.com/prm, error=\"invalid_token\""
            ),
            Some("https://s.example.com/prm".to_string())
        );
        assert_eq!(
            parse_resource_metadata_param(r#"Bearer RESOURCE_METADATA="https://s.example.com/x""#),
            Some("https://s.example.com/x".to_string())
        );
        assert_eq!(parse_resource_metadata_param("Bearer realm=\"mcp\""), None);
        assert_eq!(parse_resource_metadata_param("Bearer resource_metadata=\"\""), None);
    }

    #[test]
    fn prm_candidates_prefer_path_insertion() {
        let url = Url::parse("https://mcp.example.com/v1/mcp").expect("url");
        assert_eq!(
            prm_well_known_candidates(&url),
            vec![
                "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp".to_string(),
                "https://mcp.example.com/.well-known/oauth-protected-resource".to_string(),
            ]
        );

        let root = Url::parse("https://mcp.example.com/").expect("url");
        assert_eq!(
            prm_well_known_candidates(&root),
            vec!["https://mcp.example.com/.well-known/oauth-protected-resource".to_string()]
        );
    }

    #[test]
    fn as_candidates_cover_pathless_and_tenant_issuers() {
        assert_eq!(
            as_metadata_candidates("https://auth.example.com"),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server".to_string(),
                "https://auth.example.com/.well-known/openid-configuration".to_string(),
            ]
        );
        assert_eq!(
            as_metadata_candidates("https://auth.example.com/tenant1"),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant1"
                    .to_string(),
                "https://auth.example.com/.well-known/openid-configuration/tenant1".to_string(),
                "https://auth.example.com/tenant1/.well-known/openid-configuration".to_string(),
            ]
        );
        assert!(as_metadata_candidates("::bad::").is_empty());
    }
}
