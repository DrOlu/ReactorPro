//! RFC 7591 dynamic client registration (docs/design/mcp-oauth.md §3).
//!
//! Hosted MCP servers generally expose DCR; register as a public client
//! (`token_endpoint_auth_method: "none"`), and if the AS insists on issuing a secret, use
//! the auth method it returns. The registration result is stored in the keychain alongside the TokenRecord.

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredClient {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub token_endpoint_auth_method: String,
}

#[derive(Debug, Deserialize)]
struct RegistrationResponse {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
}

pub fn dynamic_register(
    client: &Client,
    registration_endpoint: &str,
    redirect_uri: &str,
    scope: Option<&str>,
) -> Result<RegisteredClient, String> {
    let mut body = json!({
        "client_name": "ReactorPro",
        "client_uri": "https://github.com/DrOlu/ReactorPro",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    if let Some(scope) = scope.map(str::trim).filter(|s| !s.is_empty()) {
        body["scope"] = json!(scope);
    }

    let resp = client
        .post(registration_endpoint)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .map_err(|e| format!("Dynamic registration request failed ({registration_endpoint}): {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| format!("Failed to read dynamic registration response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Dynamic registration rejected ({registration_endpoint} returned {status}): {}",
            truncate_for_error(&text)
        ));
    }

    let parsed: RegistrationResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse dynamic registration response: {e} ({})", truncate_for_error(&text)))?;
    let client_id = parsed.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("Dynamic registration response is missing client_id".to_string());
    }

    Ok(RegisteredClient {
        client_id,
        client_secret: parsed.client_secret.filter(|s| !s.trim().is_empty()),
        token_endpoint_auth_method: parsed
            .token_endpoint_auth_method
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "none".to_string()),
    })
}

fn truncate_for_error(text: &str) -> String {
    const MAX: usize = 300;
    let trimmed = text.trim();
    if trimmed.len() <= MAX {
        return trimmed.to_string();
    }
    let mut cut = MAX;
    while cut > 0 && !trimmed.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &trimmed[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_long_error_bodies_at_char_boundary() {
        let long = "€".repeat(200);
        let out = truncate_for_error(&long);
        assert!(out.ends_with('…'));
        assert!(out.len() <= 310);
        assert_eq!(truncate_for_error("  short  "), "short");
    }
}
