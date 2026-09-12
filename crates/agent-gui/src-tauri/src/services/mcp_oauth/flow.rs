//! Authorization-code flow machinery (docs/design/mcp-oauth.md §4.1/§6).
//!
//! PKCE(S256)/state generation, `127.0.0.1:random port` loopback callback (RFC 8252,
//! one-shot, 5-minute timeout, state equality check), authorize URL assembly, and token
//! exchange/refresh (RFC 8707 `resource` parameter binding the audience).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

pub const CALLBACK_PATH: &str = "/callback";
pub const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(300);

pub fn random_b64url(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("failed to obtain random entropy: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn new_pkce() -> Result<Pkce, String> {
    // RFC 7636: 32 bytes of entropy → a 43-character base64url verifier; challenge = S256(verifier).
    let verifier = random_b64url(32)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Ok(Pkce { verifier, challenge })
}

pub fn build_authorize_url(
    authorization_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
    resource: &str,
    scope: Option<&str>,
) -> Result<String, String> {
    let mut url = Url::parse(authorization_endpoint)
        .map_err(|e| format!("invalid authorization_endpoint: {authorization_endpoint} ({e})"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("state", state)
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("resource", resource);
        if let Some(scope) = scope.map(str::trim).filter(|s| !s.is_empty()) {
            query.append_pair("scope", scope);
        }
    }
    Ok(url.to_string())
}

/// The authorization URL may only be opened in the system browser as https or loopback http
/// (blocking `javascript:` and similar injection surfaces, see design §6).
pub fn is_safe_browser_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")),
        _ => false,
    }
}

// ---- loopback callback ----

pub struct Loopback {
    listener: TcpListener,
    port: u16,
}

const CALLBACK_OK_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>ReactorPro</title></head><body style=\"font-family:system-ui;display:flex;align-items:center;justify-content:center;height:90vh\"><div style=\"text-align:center\"><h2>Authorization complete</h2><p>You can close this page and return to ReactorPro.</p></div></body></html>";

const CALLBACK_FAIL_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>ReactorPro</title></head><body style=\"font-family:system-ui;display:flex;align-items:center;justify-content:center;height:90vh\"><div style=\"text-align:center\"><h2>Authorization failed</h2><p>Return to ReactorPro for details and retry.</p></div></body></html>";

impl Loopback {
    pub fn bind() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("failed to bind the loopback callback port: {e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("failed to set the loopback listener to non-blocking: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("failed to read the loopback port: {e}"))?
            .port();
        Ok(Self { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{}", self.port, CALLBACK_PATH)
    }

    /// Blocks waiting for the browser callback and returns the authorization code. One-shot:
    /// it returns as soon as a result is obtained, and the listener closes when self drops.
    /// Requests with a mismatched state get a 400 and the wait continues (guarding against a
    /// CSRF race).
    pub fn wait_for_code(&self, expected_state: &str, timeout: Duration) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err("timed out waiting for the browser authorization callback (5 minutes)".to_string());
            }
            let (stream, peer) = match self.listener.accept() {
                Ok(pair) => pair,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(e) => return Err(format!("loopback accept failed: {e}")),
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            match handle_callback_connection(stream, expected_state) {
                CallbackOutcome::Code(code) => return Ok(code),
                CallbackOutcome::OauthError(message) => return Err(message),
                CallbackOutcome::Ignored => continue,
            }
        }
    }
}

enum CallbackOutcome {
    Code(String),
    OauthError(String),
    Ignored,
}

fn handle_callback_connection(stream: TcpStream, expected_state: &str) -> CallbackOutcome {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_nonblocking(false);
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return CallbackOutcome::Ignored;
    }

    let target = match parse_request_target(&request_line) {
        Some(target) => target,
        None => {
            respond(reader.into_inner(), "400 Bad Request", CALLBACK_FAIL_HTML);
            return CallbackOutcome::Ignored;
        }
    };

    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        respond(reader.into_inner(), "400 Bad Request", CALLBACK_FAIL_HTML);
        return CallbackOutcome::Ignored;
    };
    if url.path() != CALLBACK_PATH {
        respond(reader.into_inner(), "404 Not Found", CALLBACK_FAIL_HTML);
        return CallbackOutcome::Ignored;
    }

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    let mut error_description: Option<String> = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => error_description = Some(value.into_owned()),
            _ => {}
        }
    }

    if state.as_deref() != Some(expected_state) {
        // CSRF/cross-talk: neither accept nor terminate; keep waiting for the real callback.
        respond(reader.into_inner(), "400 Bad Request", CALLBACK_FAIL_HTML);
        return CallbackOutcome::Ignored;
    }

    if let Some(error) = error {
        respond(reader.into_inner(), "200 OK", CALLBACK_FAIL_HTML);
        let detail = error_description
            .map(|d| format!(": {d}"))
            .unwrap_or_default();
        return CallbackOutcome::OauthError(format!("authorization server returned an error {error}{detail}"));
    }

    match code {
        Some(code) if !code.trim().is_empty() => {
            respond(reader.into_inner(), "200 OK", CALLBACK_OK_HTML);
            CallbackOutcome::Code(code)
        }
        _ => {
            respond(reader.into_inner(), "400 Bad Request", CALLBACK_FAIL_HTML);
            CallbackOutcome::Ignored
        }
    }
}

fn parse_request_target(request_line: &str) -> Option<String> {
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let target = parts.next()?;
    if !target.starts_with('/') {
        return None;
    }
    Some(target.to_string())
}

fn respond(mut stream: TcpStream, status: &str, body: &str) {
    let payload = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
}

// ---- token endpoint ----

#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OauthErrorBody {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

pub struct ClientCredentials<'a> {
    pub client_id: &'a str,
    pub client_secret: Option<&'a str>,
    /// "none" | "client_secret_post" | "client_secret_basic"
    pub auth_method: &'a str,
}

fn encode_form(pairs: &[(&'static str, String)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn token_request(
    client: &Client,
    token_endpoint: &str,
    credentials: &ClientCredentials<'_>,
    params: Vec<(&'static str, String)>,
) -> Result<TokenResponse, String> {
    let mut form = params;
    form.push(("client_id", credentials.client_id.to_string()));

    let mut builder = client
        .post(token_endpoint)
        .header(ACCEPT, "application/json");
    match (credentials.auth_method, credentials.client_secret) {
        ("client_secret_basic", Some(secret)) => {
            builder = builder.basic_auth(credentials.client_id, Some(secret));
        }
        (_, Some(secret)) => {
            // An unknown method that holds a secret is treated as client_secret_post.
            form.push(("client_secret", secret.to_string()));
        }
        _ => {}
    }

    let resp = builder
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(encode_form(&form))
        .send()
        .map_err(|e| format!("token request failed ({token_endpoint}): {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| format!("failed to read the token response: {e}"))?;

    if !status.is_success() {
        if let Ok(err) = serde_json::from_str::<OauthErrorBody>(&text) {
            let detail = err
                .error_description
                .map(|d| format!(": {d}"))
                .unwrap_or_default();
            return Err(format!("token endpoint returned {} ({}{detail})", status, err.error));
        }
        return Err(format!("token endpoint returned {status}"));
    }

    let parsed: TokenResponse =
        serde_json::from_str(&text).map_err(|e| format!("failed to parse the token response: {e}"))?;
    if parsed.access_token.trim().is_empty() {
        return Err("token response is missing access_token".to_string());
    }
    if let Some(token_type) = parsed.token_type.as_deref() {
        if !token_type.eq_ignore_ascii_case("bearer") {
            return Err(format!("unsupported token_type: {token_type} (only Bearer is supported)"));
        }
    }
    Ok(parsed)
}

#[allow(clippy::too_many_arguments)]
pub fn exchange_code(
    client: &Client,
    token_endpoint: &str,
    credentials: &ClientCredentials<'_>,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
    resource: &str,
) -> Result<TokenResponse, String> {
    token_request(
        client,
        token_endpoint,
        credentials,
        vec![
            ("grant_type", "authorization_code".to_string()),
            ("code", code.to_string()),
            ("redirect_uri", redirect_uri.to_string()),
            ("code_verifier", code_verifier.to_string()),
            ("resource", resource.to_string()),
        ],
    )
}

pub fn refresh_grant(
    client: &Client,
    token_endpoint: &str,
    credentials: &ClientCredentials<'_>,
    refresh_token: &str,
    resource: &str,
) -> Result<TokenResponse, String> {
    token_request(
        client,
        token_endpoint,
        credentials,
        vec![
            ("grant_type", "refresh_token".to_string()),
            ("refresh_token", refresh_token.to_string()),
            ("resource", resource.to_string()),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_s256() {
        let pkce = new_pkce().expect("pkce");
        assert!(pkce.verifier.len() >= 43, "32 bytes of entropy should produce a verifier of ≥43 characters");
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(pkce.verifier.as_bytes()));
        assert_eq!(pkce.challenge, expected);
        // Not repeated (the entropy source is effective).
        assert_ne!(new_pkce().expect("pkce2").verifier, pkce.verifier);
    }

    #[test]
    fn authorize_url_contains_required_oauth_params() {
        let url = build_authorize_url(
            "https://auth.example.com/authorize?audience=x",
            "client-1",
            "http://127.0.0.1:23456/callback",
            "state-1",
            "challenge-1",
            "https://mcp.example.com/mcp",
            Some("mcp.read"),
        )
        .expect("url");
        let parsed = Url::parse(&url).expect("parse");
        let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("audience").map(String::as_str), Some("x"));
        assert_eq!(pairs.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(pairs.get("client_id").map(String::as_str), Some("client-1"));
        assert_eq!(
            pairs.get("redirect_uri").map(String::as_str),
            Some("http://127.0.0.1:23456/callback")
        );
        assert_eq!(pairs.get("code_challenge_method").map(String::as_str), Some("S256"));
        assert_eq!(
            pairs.get("resource").map(String::as_str),
            Some("https://mcp.example.com/mcp")
        );
        assert_eq!(pairs.get("scope").map(String::as_str), Some("mcp.read"));
    }

    #[test]
    fn browser_url_safety_blocks_non_https_non_loopback() {
        assert!(is_safe_browser_url("https://auth.example.com/authorize"));
        assert!(is_safe_browser_url("http://127.0.0.1:8080/authorize"));
        assert!(is_safe_browser_url("http://localhost/authorize"));
        assert!(!is_safe_browser_url("http://auth.example.com/authorize"));
        assert!(!is_safe_browser_url("javascript:alert(1)"));
        assert!(!is_safe_browser_url("file:///etc/passwd"));
    }

    #[test]
    fn request_target_parser_accepts_get_only() {
        assert_eq!(
            parse_request_target("GET /callback?code=1 HTTP/1.1\r\n"),
            Some("/callback?code=1".to_string())
        );
        assert_eq!(parse_request_target("POST /callback HTTP/1.1\r\n"), None);
        assert_eq!(parse_request_target("GET http://evil/ HTTP/1.1\r\n"), None);
        assert_eq!(parse_request_target("garbage"), None);
    }

    #[test]
    fn loopback_roundtrip_returns_code_and_rejects_wrong_state() {
        let loopback = Loopback::bind().expect("bind");
        let uri = loopback.redirect_uri();
        let port = Url::parse(&uri).expect("uri").port().expect("port");

        let hit = std::thread::spawn(move || {
            // First send a request with a mismatched state (which should be rejected with 400
            // without terminating the wait), then the correct callback.
            let send = |path: &str| {
                let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
                s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
                    .expect("write");
                let mut buf = String::new();
                let _ = BufReader::new(s).read_line(&mut buf);
                buf
            };
            std::thread::sleep(Duration::from_millis(50));
            let first = send("/callback?code=evil&state=wrong");
            std::thread::sleep(Duration::from_millis(50));
            let second = send("/callback?code=good-code&state=expected");
            (first, second)
        });

        let code = loopback
            .wait_for_code("expected", Duration::from_secs(5))
            .expect("code");
        assert_eq!(code, "good-code");
        let (first, second) = hit.join().expect("join");
        assert!(first.contains("400"), "a state mismatch must be 400: {first}");
        assert!(second.contains("200"), "the correct callback must be 200: {second}");
    }

    #[test]
    fn loopback_reports_oauth_error_from_callback() {
        let loopback = Loopback::bind().expect("bind");
        let uri = loopback.redirect_uri();
        let port = Url::parse(&uri).expect("uri").port().expect("port");

        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            s.write_all(
                b"GET /callback?error=access_denied&error_description=nope&state=expected HTTP/1.1\r\nHost: x\r\n\r\n",
            )
            .expect("write");
            let mut buf = String::new();
            let _ = BufReader::new(s).read_line(&mut buf);
        });

        let err = loopback
            .wait_for_code("expected", Duration::from_secs(5))
            .expect_err("must fail");
        assert!(err.contains("access_denied"));
        assert!(err.contains("nope"));
    }
}
