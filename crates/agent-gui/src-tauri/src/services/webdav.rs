// WebDAV transport layer: pure HTTP, with no sync orchestration or config storage.
//
// Only four WebDAV actions are used: PROPFIND (probe), MKCOL (create directory),
// PUT, and GET. We deliberately avoid a WebDAV client library and do not parse
// XML -- the multistatus response bodies differ wildly between servers, and this
// feature only needs the boolean "does the directory exist", so the status code
// is enough.

use std::time::Duration;

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Client, Method, Response, StatusCode};

use crate::services::system_proxy;

/// Timeout for metadata operations (PROPFIND / MKCOL).
const WEBDAV_META_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout for transfer operations (PUT / GET). Payloads are small, but the user's
/// network may be very slow.
const WEBDAV_TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);

/// Character set that path segments need to escape.
///
/// `NON_ALPHANUMERIC` cannot be used: it would also encode `-` `_` `.` `~`, which
/// is legal but makes remote file names hard to recognize. Only RFC 3986
/// delimiters and control characters are escaped here.
const PATH_SEGMENT_ESCAPE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'/')
    .add(b'\\');

#[derive(Debug, Clone)]
pub struct WebdavCredentials {
    pub base_url: String,
    pub username: String,
    pub password: String,
}

fn method_propfind() -> Method {
    Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid HTTP method token")
}

fn method_mkcol() -> Method {
    Method::from_bytes(b"MKCOL").expect("MKCOL is a valid HTTP method token")
}

/// Builds the client. It **must** go through the application proxy settings,
/// otherwise a user-configured proxy has no effect on WebDAV.
///
/// **Does not follow redirects**, consistent with the egress clients for
/// `provider_usage` / `tunnel`. reqwest's default `Policy::limited(10)` silently
/// swallows 3xx, causing two problems: first, all the 3xx handling in this file
/// (`describe_status_error`'s "the address may not be at the WebDAV root path"
/// hint, and `ensure_remote_dirs`'s may_already_exist) becomes dead code -- when a
/// user mistakenly enters a portal address as the WebDAV address, a 302->200 makes
/// test connection/MKCOL/PUT all report success while nothing is actually stored;
/// second, 307/308 would resend `config.json` (containing all plaintext provider
/// API keys) verbatim to a host the user never configured.
fn build_client(timeout: Duration) -> Result<Client, String> {
    system_proxy::async_client_builder()?
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| "Failed to create WebDAV HTTP client".to_string())
}

/// Joins a remote URL: the base has its trailing slash removed, and each segment is
/// percent-encoded and joined with `/`.
///
/// Empty segments are skipped, avoiding double slashes when a user enters paths
/// like `dav//backup/` -- some servers treat `//` as a different resource, causing
/// "upload succeeds but download returns 404".
pub fn join_url(base: &str, segments: &[&str]) -> String {
    let mut url = base.trim_end_matches('/').to_string();
    for segment in segments {
        for part in segment.split('/') {
            if part.is_empty() {
                continue;
            }
            url.push('/');
            url.push_str(&utf8_percent_encode(part, PATH_SEGMENT_ESCAPE).to_string());
        }
    }
    url
}

/// Directory URLs need a trailing slash: most servers use it to distinguish a collection from an ordinary resource.
pub fn dir_url(base: &str, segments: &[&str]) -> String {
    format!("{}/", join_url(base, segments))
}

/// Log redaction: strips userinfo and the entire query string.
///
/// userinfo may embed a password (`https://user:pass@host/`), and the query may
/// carry a one-time token; neither should end up in logs or error messages.
pub fn redact_url_for_log(url: &str) -> String {
    let (scheme, rest) = match url.split_once("://") {
        Some((scheme, rest)) => (Some(scheme), rest),
        None => (None, url),
    };
    // userinfo is only valid in the authority portion before the first '/'.
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let (authority, path) = rest.split_at(authority_end);
    let host = match authority.rsplit_once('@') {
        Some((_userinfo, host)) => host,
        None => authority,
    };
    let path = path.split('?').next().unwrap_or("");
    match scheme {
        Some(scheme) => format!("{scheme}://{host}{path}"),
        None => format!("{host}{path}"),
    }
}

/// Nutstore needs special handling: its error-code semantics differ from generic
/// WebDAV servers, and passing the status code through directly leaves the user
/// unable to recover (especially 401 -- the real cause is needing an app password
/// rather than the login password).
///
/// The international edition uses `nutstore` domains other than
/// `dav.jianguoyun.com`, with the same backend and the same error semantics, so it
/// must be recognized as well; otherwise international users only see the generic text.
fn is_jianguoyun(url: &str) -> bool {
    let host = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    // Match only on domain boundaries: `jianguoyun.com.evil.test` must not hit.
    ["jianguoyun.com", "nutstore.net", "nutstore.com"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

/// Translates a status code into text the user can act on.
fn describe_status_error(url: &str, status: StatusCode, action: &str) -> String {
    let jianguoyun = is_jianguoyun(url);
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            if jianguoyun {
                "Authentication failed: Nutstore requires an app password generated in \"Third-Party App Management\", not the account login password; also make sure the server address is https://dav.jianguoyun.com/dav/".to_string()
            } else {
                format!("Authentication failed ({status}): check the username and password")
            }
        }
        StatusCode::NOT_FOUND => {
            if jianguoyun {
                "Path not found: Nutstore's WebDAV writable directory must be under /dav/; verify the server address and remote directory".to_string()
            } else {
                format!("Path not found ({status}): check the server address and remote directory")
            }
        }
        StatusCode::CONFLICT => {
            if jianguoyun {
                "Failed to create directory: Nutstore does not allow creating top-level folders automatically over WebDAV; create the directory manually in the web UI first".to_string()
            } else {
                format!("Failed to create directory ({status}): the parent directory may not exist")
            }
        }
        StatusCode::INSUFFICIENT_STORAGE => "Remote storage is full".to_string(),
        status if status.is_redirection() => {
            if jianguoyun {
                format!("Server returned a redirect ({status}): Nutstore's WebDAV address should be https://dav.jianguoyun.com/dav/; do not use the web UI address")
            } else {
                format!("Server returned a redirect ({status}): the address may not be a WebDAV endpoint")
            }
        }
        status => format!("{action} failed: server returned {status}"),
    }
}

fn map_request_error(url: &str, action: &str, error: &reqwest::Error) -> String {
    let redacted = redact_url_for_log(url);
    if error.is_timeout() {
        return format!("{action} timed out: {redacted}");
    }
    if error.is_connect() {
        return format!("{action} failed: cannot connect to {redacted}");
    }
    format!("{action} failed: {redacted}")
}

/// PROPFIND Depth=0 probe for whether a resource is accessible.
///
/// The response body is not parsed -- as long as the server accepts this method
/// and returns 2xx or 207, the address, credentials, and accessibility are all fine.
async fn propfind_ok(creds: &WebdavCredentials, url: &str) -> Result<bool, String> {
    let client = build_client(WEBDAV_META_TIMEOUT)?;
    let response = client
        .request(method_propfind(), url)
        .basic_auth(&creds.username, Some(&creds.password))
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| map_request_error(url, "Connect to WebDAV server", &e))?;

    let status = response.status();
    if status.is_success() || status == StatusCode::MULTI_STATUS {
        return Ok(true);
    }
    if status == StatusCode::NOT_FOUND {
        return Ok(false);
    }
    Err(describe_status_error(url, status, "Connect to WebDAV server"))
}

/// Tests the connection: probes whether base_url itself is reachable.
pub async fn test_connection(creds: &WebdavCredentials) -> Result<(), String> {
    let url = dir_url(&creds.base_url, &[]);
    if propfind_ok(creds, &url).await? {
        Ok(())
    } else {
        Err(describe_status_error(
            &url,
            StatusCode::NOT_FOUND,
            "Connect to WebDAV server",
        ))
    }
}

/// Flattens each segment on `/` into per-level directory names, using the same
/// rules as `join_url`.
///
/// `remote_dir` may be written as a multi-level path like `a/b`. If iterated by
/// the passed **elements**, `a/b` would be treated as one level, the intermediate
/// `a/` would never be MKCOL'd, and the server could only return 409 (missing
/// parent), making nested remote directories completely unusable.
fn dir_ladder<'a>(segments: &[&'a str]) -> Vec<&'a str> {
    segments
        .iter()
        .flat_map(|segment| segment.split('/'))
        .filter(|part| !part.is_empty())
        .collect()
}

/// Creates directories level by level.
///
/// Optimistic MKCOL: rather than checking existence first (an extra RTT), create
/// directly and, on an "already exists" style error, confirm with PROPFIND.
/// 405 = method not allowed (usually already exists), 409 = missing parent,
/// 3xx = the server redirected an already-existing collection -- all three may
/// mean "it actually already exists".
pub async fn ensure_remote_dirs(
    creds: &WebdavCredentials,
    segments: &[&str],
) -> Result<(), String> {
    let client = build_client(WEBDAV_META_TIMEOUT)?;
    let ladder = dir_ladder(segments);
    let mut accumulated: Vec<&str> = Vec::with_capacity(ladder.len());

    for part in ladder {
        accumulated.push(part);
        let url = dir_url(&creds.base_url, &accumulated);
        let response = client
            .request(method_mkcol(), &url)
            .basic_auth(&creds.username, Some(&creds.password))
            .send()
            .await
            .map_err(|e| map_request_error(&url, "Create remote directory", &e))?;

        let status = response.status();
        if status.is_success() {
            continue;
        }
        let may_already_exist = status == StatusCode::METHOD_NOT_ALLOWED
            || status == StatusCode::CONFLICT
            || status.is_redirection();
        if may_already_exist && propfind_ok(creds, &url).await? {
            continue;
        }
        return Err(describe_status_error(&url, status, "Create remote directory"));
    }
    Ok(())
}

/// Streams the response body, checking the limit as it accumulates.
///
/// `Content-Length` cannot be trusted alone: it may be absent or lie. A malicious
/// or malfunctioning server could exhaust memory with an unbounded response body.
async fn read_body_capped(
    mut response: Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| format!("Failed to read {label}: connection interrupted"))?
    {
        if buffer.len() + chunk.len() > max_bytes {
            return Err(format!("{label} exceeds the size limit ({max_bytes} bytes)"));
        }
        buffer.extend_from_slice(&chunk);
    }
    Ok(buffer)
}

pub async fn put_bytes(
    creds: &WebdavCredentials,
    segments: &[&str],
    body: Vec<u8>,
    content_type: &str,
) -> Result<(), String> {
    let url = join_url(&creds.base_url, segments);
    let client = build_client(WEBDAV_TRANSFER_TIMEOUT)?;
    let response = client
        .put(&url)
        .basic_auth(&creds.username, Some(&creds.password))
        .header("Content-Type", content_type)
        .body(body)
        .send()
        .await
        .map_err(|e| map_request_error(&url, "Upload", &e))?;

    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(describe_status_error(&url, status, "Upload"))
    }
}

/// Download. Returns `Ok(None)` when the resource does not exist, letting the
/// caller distinguish "the remote has no backup yet" from a real error.
pub async fn get_bytes(
    creds: &WebdavCredentials,
    segments: &[&str],
    max_bytes: usize,
    label: &str,
) -> Result<Option<Vec<u8>>, String> {
    let url = join_url(&creds.base_url, segments);
    let client = build_client(WEBDAV_TRANSFER_TIMEOUT)?;
    let response = client
        .get(&url)
        .basic_auth(&creds.username, Some(&creds.password))
        .send()
        .await
        .map_err(|e| map_request_error(&url, "Download", &e))?;

    let status = response.status();
    if status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(describe_status_error(&url, status, "Download"));
    }
    Ok(Some(read_body_capped(response, max_bytes, label).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_url_trims_and_skips_empty_segments() {
        assert_eq!(
            join_url("https://example.com/dav/", &["liveagent", "v1"]),
            "https://example.com/dav/liveagent/v1"
        );
        // Duplicate slashes entered by the user must not produce `//`: some servers treat it as a different resource.
        assert_eq!(
            join_url("https://example.com/dav", &["//liveagent//", "/v1/"]),
            "https://example.com/dav/liveagent/v1"
        );
        assert_eq!(
            join_url("https://example.com/dav/", &[]),
            "https://example.com/dav"
        );
    }

    #[test]
    fn dir_ladder_flattens_multi_level_segments() {
        // When remote_dir is written as `a/b`, each level must be created, otherwise
        // the intermediate `a/` was never MKCOL'd and the server only returns 409 for `a/b`.
        assert_eq!(
            dir_ladder(&["a/b", "v1", "default"]),
            ["a", "b", "v1", "default"]
        );
        // Flattening rules match join_url: empty segments are always discarded.
        assert_eq!(dir_ladder(&["//a//", "/b/"]), ["a", "b"]);
    }

    #[test]
    fn join_url_percent_encodes_spaces_and_non_ascii() {
        assert_eq!(
            join_url("https://example.com/dav", &["my backup"]),
            "https://example.com/dav/my%20backup"
        );
        assert_eq!(
            join_url("https://example.com/dav", &["café"]),
            "https://example.com/dav/caf%C3%A9"
        );
        // Common filename characters stay readable and are not over-encoded.
        assert_eq!(
            join_url("https://example.com/dav", &["config-v1.2_final~x.json"]),
            "https://example.com/dav/config-v1.2_final~x.json"
        );
        // A '?' inside a segment must be encoded, otherwise it is treated as the start of the query.
        assert_eq!(
            join_url("https://example.com/dav", &["a?b"]),
            "https://example.com/dav/a%3Fb"
        );
    }

    #[test]
    fn dir_url_keeps_trailing_slash() {
        assert_eq!(
            dir_url("https://example.com/dav/", &["v1"]),
            "https://example.com/dav/v1/"
        );
        assert_eq!(
            dir_url("https://example.com/dav/", &[]),
            "https://example.com/dav/"
        );
    }

    #[test]
    fn redact_url_strips_userinfo_and_query() {
        assert_eq!(
            redact_url_for_log("https://alice:s3cret@example.com/dav/x?token=abc"),
            "https://example.com/dav/x"
        );
        assert_eq!(
            redact_url_for_log("https://example.com/dav/x"),
            "https://example.com/dav/x"
        );
        // An '@' appearing in the path must not be mistaken for a userinfo delimiter.
        assert_eq!(
            redact_url_for_log("https://example.com/dav/a@b"),
            "https://example.com/dav/a@b"
        );
        assert_eq!(redact_url_for_log("example.com/dav?x=1"), "example.com/dav");
    }

    #[test]
    fn detects_jianguoyun_hosts() {
        assert!(is_jianguoyun("https://dav.jianguoyun.com/dav/"));
        assert!(is_jianguoyun("https://DAV.JianGuoYun.com/dav/"));
        // The international edition uses nutstore domains, with the same error semantics as the domestic edition.
        assert!(is_jianguoyun(
            "https://dav.jianguoyun.com.nutstore.net/dav/"
        ));
        assert!(is_jianguoyun("https://app.nutstore.net/dav/"));
        assert!(!is_jianguoyun("https://example.com/dav/"));
        // Hosts with a similar suffix but a different domain must not be misidentified.
        assert!(!is_jianguoyun("https://jianguoyun.com.evil.test/dav/"));
        assert!(!is_jianguoyun("https://nutstore.net.evil.test/dav/"));
        // A mere substring match must not hit either.
        assert!(!is_jianguoyun("https://mynutstore.example/dav/"));
    }

    #[test]
    fn jianguoyun_errors_mention_app_password_and_manual_folder() {
        let url = "https://dav.jianguoyun.com/dav/liveagent/";
        let unauthorized = describe_status_error(url, StatusCode::UNAUTHORIZED, "Connect");
        assert!(unauthorized.contains("app password"), "{unauthorized}");

        let conflict = describe_status_error(url, StatusCode::CONFLICT, "Create remote directory");
        assert!(conflict.contains("manually in the web UI"), "{conflict}");

        let not_found = describe_status_error(url, StatusCode::NOT_FOUND, "Download");
        assert!(not_found.contains("/dav/"), "{not_found}");

        let redirect = describe_status_error(url, StatusCode::FOUND, "Connect");
        assert!(redirect.contains("dav.jianguoyun.com"), "{redirect}");
    }

    #[test]
    fn generic_errors_stay_generic() {
        let url = "https://example.com/dav/";
        let unauthorized = describe_status_error(url, StatusCode::UNAUTHORIZED, "Connect");
        assert!(!unauthorized.contains("Nutstore"), "{unauthorized}");
        assert!(unauthorized.contains("username and password"), "{unauthorized}");

        let storage = describe_status_error(url, StatusCode::INSUFFICIENT_STORAGE, "Upload");
        assert!(storage.contains("storage is full"), "{storage}");

        // Status codes without special handling fall back to generic text, including the action name.
        let teapot = describe_status_error(url, StatusCode::IM_A_TEAPOT, "Upload");
        assert!(teapot.contains("Upload failed"), "{teapot}");
    }

    #[test]
    fn error_text_never_leaks_credentials() {
        let url = "https://alice:s3cret@dav.jianguoyun.com/dav/x?token=abc";
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::NOT_FOUND,
            StatusCode::CONFLICT,
            StatusCode::IM_A_TEAPOT,
        ] {
            let message = describe_status_error(url, status, "Upload");
            assert!(!message.contains("s3cret"), "{message}");
            assert!(!message.contains("token=abc"), "{message}");
        }
    }

    /// Real-server connectivity test. **Not run by default** (`#[ignore]`).
    ///
    /// Credentials are read only from environment variables and never land in the repo:
    /// ```text
    /// LIVEAGENT_WEBDAV_URL=https://dav.jianguoyun.com/dav/ \
    /// LIVEAGENT_WEBDAV_USER=... \
    /// LIVEAGENT_WEBDAV_PASS=... \
    /// cargo test --lib services::webdav::tests::live -- --ignored --nocapture
    /// ```
    /// If any of the three variables is missing, it is skipped, avoiding failures on CI.
    ///
    /// The four stages are combined into one test case rather than four: they share
    /// the same remote directory, and running them in parallel would trample each
    /// other (the order of creating directories / writing files / deleting files is undefined).
    #[tokio::test]
    #[ignore = "requires a real WebDAV account, provided via LIVEAGENT_WEBDAV_* environment variables"]
    async fn live_webdav_end_to_end() {
        let (Ok(base_url), Ok(username), Ok(password)) = (
            std::env::var("LIVEAGENT_WEBDAV_URL"),
            std::env::var("LIVEAGENT_WEBDAV_USER"),
            std::env::var("LIVEAGENT_WEBDAV_PASS"),
        ) else {
            eprintln!("Skipped: LIVEAGENT_WEBDAV_URL / _USER / _PASS not set");
            return;
        };

        let creds = WebdavCredentials {
            base_url,
            username,
            password,
        };

        // (1) Test connection succeeds (AC6 positive)
        test_connection(&creds)
            .await
            .expect("test_connection should succeed");
        eprintln!("(1) test_connection: ok");

        // (2) A wrong password hits the Nutstore special-case text (AC6 negative + error mapping)
        let bad = WebdavCredentials {
            password: "definitely-not-the-password".to_string(),
            ..creds.clone()
        };
        let err = test_connection(&bad).await.expect_err("a wrong password should fail authentication");
        assert!(err.contains("Authentication failed"), "{err}");
        assert!(
            !err.contains("definitely-not-the-password"),
            "the error text must not echo credentials: {err}"
        );
        eprintln!("(2) wrong password: {err}");

        // (3) Create directory -> PUT -> GET round trip (transport basis for AC8/AC9)
        let dir = format!("liveagent-livetest-{}", std::process::id());
        ensure_remote_dirs(&creds, &[&dir])
            .await
            .expect("ensure_remote_dirs should succeed");
        // Repeated calls must be idempotent (exercising the MKCOL 405/409 -> PROPFIND fallback branch)
        ensure_remote_dirs(&creds, &[&dir])
            .await
            .expect("ensure_remote_dirs should be idempotent");
        eprintln!("(3) ensure_remote_dirs (with idempotent retry): ok");

        // Payload deliberately contains non-ASCII characters: verify UTF-8 bytes are
        // not rewritten by the server across the PUT/GET round trip.
        let body = r#"{"hello":"webdav","utf8":"café"}"#.as_bytes().to_vec();
        put_bytes(
            &creds,
            &[&dir, "probe.json"],
            body.clone(),
            "application/json",
        )
        .await
        .expect("put_bytes should succeed");
        let fetched = get_bytes(&creds, &[&dir, "probe.json"], 1024 * 1024, "probe")
            .await
            .expect("get_bytes should succeed")
            .expect("the file just uploaded must exist");
        assert_eq!(fetched, body, "downloaded bytes must exactly match uploaded bytes");
        eprintln!("(4) put/get round trip {} bytes: identical", body.len());

        // (5) A missing file returns Ok(None), not Err -- the basis for deciding
        // "the remote has no backup yet"
        let missing = get_bytes(&creds, &[&dir, "no-such-file.json"], 1024, "probe")
            .await
            .expect("404 should not error");
        assert!(missing.is_none(), "a missing file should return Ok(None)");
        eprintln!("(5) missing file: Ok(None)");
    }
}
