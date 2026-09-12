#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcsProviderImportItem {
    pub source_id: String,
    pub app_type: String,
    pub provider_type: String,
    pub name: String,
    pub base_url: String,
    pub is_full_url: bool,
    pub models_url: String,
    pub api_key: String,
    pub request_format: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcsProvidersResponse {
    pub status: String,
    pub message: String,
    pub providers: Vec<CcsProviderImportItem>,
}

#[tauri::command]
pub async fn settings_list_ccswitch_providers() -> Result<CcsProvidersResponse, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let candidates = ccswitch_db_candidates();
        let path = candidates.iter().find(|path| path.exists());
        let providers = match path {
            Some(path) => list_ccswitch_liveagent_providers_from_db(path)?,
            None => Vec::new(),
        };
        let message = if providers.is_empty() {
            let checked = candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join("; ");
            format!("No ccswitch ReactorPro providers found; checked: {checked}")
        } else {
            format!("Found {} ccswitch ReactorPro providers", providers.len())
        };
        Ok(CcsProvidersResponse {
            status: "success".to_string(),
            message,
            providers,
        })
    })
    .await
    .map_err(|e| format!("settings_list_ccswitch_providers join failed: {e}"))?
}

/// ccswitch (Tauri app id `com.ccswitch.desktop`) lets users migrate the whole
/// data directory to a custom path (for example syncing to OneDrive); after
/// migration the database actually in use is no longer under the default
/// `~/.cc-switch/` but recorded in `app_paths.json` in its own config directory
/// (the `app_config_dir_override` field). Prefer that override directory here
/// and fall back to the default directory when it is not found.
fn ccswitch_db_candidates() -> Vec<PathBuf> {
    let filename = format!("{}-{}.db", "cc", "switch");
    let mut candidates = Vec::new();
    if let Some(override_dir) = ccswitch_override_config_dir() {
        candidates.push(override_dir.join(&filename));
    }
    candidates.push(ccswitch_legacy_config_dir().join(&filename));
    // On Windows, `HOME` may be injected by Git/MSYS and differ from the real
    // user directory; ccswitch v3.10.3 used it to write the database to
    // `%HOME%\.cc-switch\`, and upstream still keeps that location as a read
    // fallback (see get_app_config_dir in its config.rs), so include it as a
    // candidate here as well.
    #[cfg(windows)]
    if let Ok(home_env) = std::env::var("HOME") {
        let trimmed = home_env.trim();
        if !trimmed.is_empty() {
            let legacy = PathBuf::from(trimmed)
                .join(format!(".{}-{}", "cc", "switch"))
                .join(&filename);
            if !candidates.contains(&legacy) {
                candidates.push(legacy);
            }
        }
    }
    candidates
}

fn ccswitch_legacy_config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(format!(".{}-{}", "cc", "switch"))
}

fn ccswitch_override_config_dir() -> Option<PathBuf> {
    let app_paths_file = dirs::config_dir()?
        .join("com.ccswitch.desktop")
        .join("app_paths.json");
    let content = fs::read_to_string(app_paths_file).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    let override_dir = value.get("app_config_dir_override")?.as_str()?.trim();
    if override_dir.is_empty() {
        return None;
    }
    Some(expand_home_prefix(override_dir))
}

/// Aligned with upstream ccswitch's `resolve_path`: supports the three forms
/// `~`, `~/`, and `~\` (Windows users tend to write migrated paths with a
/// backslash, and ccswitch itself can parse these forms).
fn expand_home_prefix(path: &str) -> PathBuf {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    } else if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn list_ccswitch_liveagent_providers_from_db(
    path: &std::path::Path,
) -> Result<Vec<CcsProviderImportItem>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("failed to open ccswitch database {}: {e}", path.display()))?;
    // meta is a separate column of the ccswitch providers table (TEXT NOT NULL
    // DEFAULT '{}'); Claude Desktop's access mode, upstream format, and model
    // routes are all stored here rather than in settings_config. Very old v0
    // databases have not yet migrated out of the meta column (ReactorPro opens
    // read-only and does not trigger a ccswitch migration); such databases also
    // predate Claude Desktop support, so fall back to an empty meta query.
    let has_meta_column = ccswitch_providers_has_meta_column(&conn);
    let meta_select = if has_meta_column { "meta" } else { "NULL" };
    let sql = format!(
        "SELECT id, app_type, name, settings_config, {meta_select} AS meta
         FROM providers
         WHERE app_type IN (
           'codex',
           'claude', 'claude-code', 'claude_code',
           'claude-desktop', 'claude_desktop', 'claudeDesktop',
           'gemini',
           'grokbuild', 'grok-build', 'grok_build', 'grok', 'xai',
           'deepseek'
         )
         ORDER BY
           CASE app_type
             WHEN 'claude' THEN 0
             WHEN 'claude-code' THEN 0
             WHEN 'claude_code' THEN 0
             WHEN 'claude-desktop' THEN 0
             WHEN 'claude_desktop' THEN 0
             WHEN 'claudeDesktop' THEN 0
             WHEN 'codex' THEN 1
             WHEN 'gemini' THEN 2
             WHEN 'grokbuild' THEN 3
             WHEN 'grok-build' THEN 3
             WHEN 'grok_build' THEN 3
             WHEN 'grok' THEN 3
             WHEN 'xai' THEN 3
             WHEN 'deepseek' THEN 4
             ELSE 5
           END,
           COALESCE(sort_index, 999999), created_at ASC, id ASC"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("failed to read ccswitch providers table: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| format!("failed to query ccswitch providers: {e}"))?;

    let mut providers = Vec::new();
    for row in rows {
        let (source_id, app_type, name, settings_config, meta_str) =
            row.map_err(|e| format!("failed to read ccswitch provider row: {e}"))?;
        let Ok(config) = serde_json::from_str::<Value>(&settings_config) else {
            continue;
        };
        // A failed meta parse is treated as empty and does not affect import of
        // the row's other fields.
        let meta = meta_str
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or(Value::Null);
        if let Some(provider) =
            ccs_provider_from_value(&source_id, &app_type, &name, &config, &meta)
        {
            providers.push(provider);
        }
    }
    Ok(providers)
}

fn ccswitch_providers_has_meta_column(conn: &Connection) -> bool {
    let Ok(mut stmt) = conn.prepare("PRAGMA table_info(providers)") else {
        return false;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return false;
    };
    for name in rows.flatten() {
        if name == "meta" {
            return true;
        }
    }
    false
}

fn ccs_provider_from_value(
    source_id: &str,
    app_type: &str,
    name: &str,
    config: &Value,
    meta: &Value,
) -> Option<CcsProviderImportItem> {
    let mapped_provider_type = ccs_provider_type_from_app_type(app_type)?;

    // Claude Desktop (ccswitch app_type=claude-desktop) providers are grouped
    // under the Anthropic protocol tag, but only those in the native Anthropic
    // format can be imported directly as claude_code: upstreams declared by
    // proxy mode as openai_chat / openai_responses / gemini_native require local
    // protocol translation, and importing them as an Anthropic provider would
    // yield a broken config with a mismatched protocol, so skip them here.
    let is_claude_desktop = ccs_is_claude_desktop_app_type(app_type);
    if is_claude_desktop && !ccs_claude_desktop_is_anthropic(meta) {
        return None;
    }

    let mapped_base_url = ccs_extract_base_url(mapped_provider_type, config).unwrap_or_default();
    let provider_type = if mapped_provider_type == "codex"
        && ccs_is_chat_protocol(config)
        && is_official_deepseek_base_url(&mapped_base_url)
    {
        "deepseek"
    } else {
        mapped_provider_type
    };
    let base_url = ccs_extract_base_url(provider_type, config).unwrap_or_default();
    let api_key = ccs_extract_api_key(provider_type, config).unwrap_or_default();

    let mut models = ccs_extract_models(provider_type, config);
    if is_claude_desktop {
        // Claude Desktop models are not written in env but in
        // meta.claudeDesktopModelRoutes: in direct mode route_id is the model
        // name, while in mapped mode route.model holds the real upstream model.
        for model in ccs_extract_claude_desktop_models(meta) {
            if !models.iter().any(|item| item == &model) {
                models.push(model);
            }
        }
    }

    Some(CcsProviderImportItem {
        source_id: source_id.to_string(),
        app_type: app_type.to_string(),
        provider_type: provider_type.to_string(),
        name: strip_ccswitch_suffix(name).to_string(),
        base_url,
        is_full_url: config
            .get("meta")
            .and_then(|meta| meta.get("isFullUrl").or_else(|| meta.get("is_full_url")))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        models_url: config
            .get("meta")
            .and_then(|meta| meta.get("modelsUrl").or_else(|| meta.get("models_url")))
            .or_else(|| config.get("modelsUrl").or_else(|| config.get("models_url")))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        api_key,
        request_format: if provider_type == "deepseek" {
            "openai-completions".to_string()
        } else if provider_type == "xai" {
            // Grok / xAI is fixed to Responses in ReactorPro.
            "openai-responses".to_string()
        } else if provider_type == "codex" && ccs_is_chat_protocol(config) {
            "openai-completions".to_string()
        } else {
            "openai-responses".to_string()
        },
        models,
    })
}

fn ccs_provider_type_from_app_type(app_type: &str) -> Option<&'static str> {
    match app_type.trim().to_ascii_lowercase().as_str() {
        "codex" => Some("codex"),
        // Claude Desktop and the Claude Code CLI are both Anthropic protocol
        // providers.
        "claude" | "claude-code" | "claude_code" | "claude-desktop" | "claude_desktop"
        | "claudedesktop" => Some("claude_code"),
        "gemini" => Some("gemini"),
        "deepseek" => Some("deepseek"),
        // CC-Switch Grok Build app bucket (aligned with the upstream
        // AppType::GrokBuild aliases).
        "grokbuild" | "grok-build" | "grok_build" | "grok" | "xai" => Some("xai"),
        _ => None,
    }
}

fn ccs_is_claude_desktop_app_type(app_type: &str) -> bool {
    matches!(
        app_type.trim().to_ascii_lowercase().as_str(),
        "claude-desktop" | "claude_desktop" | "claudedesktop"
    )
}

/// Whether a Claude Desktop provider uses the native Anthropic upstream format.
///
/// ccswitch direct mode always writes meta.apiFormat = "anthropic"; mapped
/// (proxy) mode may declare formats such as openai_chat / openai_responses /
/// gemini_native, with protocol translation done by ccswitch's built-in
/// gateway. The default (historical data without apiFormat) is treated as
/// Anthropic, matching ccswitch's own default.
fn ccs_claude_desktop_is_anthropic(meta: &Value) -> bool {
    match meta.get("apiFormat").and_then(Value::as_str) {
        Some(format) => format.trim().eq_ignore_ascii_case("anthropic") || format.trim().is_empty(),
        None => true,
    }
}

/// Extract the Claude Desktop model list from meta.claudeDesktopModelRoutes.
///
/// The route table looks like { "<route_id>": { "model": "<upstream model>", ... } }:
/// in direct mode route_id is the model name (the model field has the same
/// value); in mapped mode the model field holds the real upstream model.
/// Uniformly prefer the model field and fall back to route_id when it is empty.
fn ccs_extract_claude_desktop_models(meta: &Value) -> Vec<String> {
    let Some(routes) = meta
        .get("claudeDesktopModelRoutes")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (route_id, route) in routes {
        let model = route
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| route_id.trim());
        if model.is_empty() || out.iter().any(|item| item == model) {
            continue;
        }
        out.push(model.to_string());
    }
    out.sort();
    out
}

fn ccs_extract_models(provider_type: &str, config: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut push_model = |value: String| {
        let model = value.trim().to_string();
        if !model.is_empty() && !out.iter().any(|item| item == &model) {
            out.push(model);
        }
    };

    match provider_type {
        "claude_code" => {
            for key in [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            ] {
                if let Some(model) = ccs_string_at_path(config, &["env", key]) {
                    push_model(model);
                }
            }
        }
        "gemini" => {
            for key in ["GEMINI_MODEL", "GOOGLE_GEMINI_MODEL", "GOOGLE_MODEL"] {
                if let Some(model) = ccs_string_at_path(config, &["env", key]) {
                    push_model(model);
                }
            }
        }
        "deepseek" => {
            for key in [
                "DEEPSEEK_MODEL",
                "DEEPSEEK_DEFAULT_MODEL",
                "DEEPSEEK_CHAT_MODEL",
                "DEEPSEEK_REASONER_MODEL",
            ] {
                if let Some(model) = ccs_string_at_path(config, &["env", key])
                    .or_else(|| ccs_string_at_path(config, &["config", key]))
                {
                    push_model(model);
                }
            }
        }
        "xai" => {
            // Grok Build: settings_config.config is TOML, where
            // [models].default and [model."<id>"].model hold model ids.
            if let Some(config_text) = config.get("config").and_then(Value::as_str) {
                if let Some(model) = ccs_extract_toml_string_value(config_text, "default") {
                    push_model(model);
                }
                if let Some(model) = ccs_extract_toml_string_value(config_text, "model") {
                    push_model(model);
                }
            }
        }
        _ => {}
    }

    for key in ["model", "default_model", "defaultModel"] {
        if let Some(model) = ccs_string_at(config, &[key]) {
            push_model(model);
        }
        if let Some(model) = config
            .get("config")
            .and_then(|value| ccs_string_at(value, &[key]))
        {
            push_model(model);
        }
    }
    if let Some(config_text) = config.get("config").and_then(Value::as_str) {
        if let Some(model) = ccs_extract_toml_string_value(config_text, "model") {
            push_model(model);
        }
    }
    out
}

fn ccs_extract_base_url(provider_type: &str, config: &Value) -> Option<String> {
    match provider_type {
        "claude_code" => ccs_string_at_path(config, &["env", "ANTHROPIC_BASE_URL"])
            .or_else(|| ccs_string_at_path(config, &["config", "ANTHROPIC_BASE_URL"])),
        "gemini" => ccs_string_at_path(config, &["env", "GEMINI_BASE_URL"])
            .or_else(|| ccs_string_at_path(config, &["env", "GOOGLE_GEMINI_BASE_URL"]))
            .or_else(|| ccs_string_at_path(config, &["config", "base_url"])),
        "deepseek" => ccs_string_at_path(config, &["env", "DEEPSEEK_BASE_URL"])
            .or_else(|| ccs_string_at_path(config, &["config", "DEEPSEEK_BASE_URL"]))
            .or_else(|| ccs_string_at(config, &["base_url", "baseURL"]))
            .or_else(|| {
                config
                    .get("config")
                    .and_then(|value| ccs_string_at(value, &["base_url", "baseURL"]))
            })
            .or_else(|| {
                config
                    .get("config")
                    .and_then(Value::as_str)
                    .and_then(|text| ccs_extract_toml_string_value(text, "base_url"))
            }),
        "xai" => ccs_string_at(config, &["base_url", "baseURL"])
            .or_else(|| {
                config
                    .get("config")
                    .and_then(|value| ccs_string_at(value, &["base_url", "baseURL"]))
            })
            .or_else(|| {
                // Grok Build: the config field is full TOML text.
                config
                    .get("config")
                    .and_then(Value::as_str)
                    .and_then(|text| ccs_extract_toml_string_value(text, "base_url"))
            }),
        _ => ccs_string_at(config, &["base_url", "baseURL"])
            .or_else(|| {
                config
                    .get("config")
                    .and_then(|value| ccs_string_at(value, &["base_url", "baseURL"]))
            })
            .or_else(|| {
                config
                    .get("config")
                    .and_then(Value::as_str)
                    .and_then(|text| ccs_extract_toml_string_value(text, "base_url"))
            }),
    }
    .map(|value| value.trim().trim_end_matches('/').to_string())
}

fn ccs_extract_api_key(provider_type: &str, config: &Value) -> Option<String> {
    match provider_type {
        "claude_code" => ccs_string_at_path(config, &["env", "ANTHROPIC_AUTH_TOKEN"])
            .or_else(|| ccs_string_at_path(config, &["env", "ANTHROPIC_API_KEY"])),
        "gemini" => ccs_string_at_path(config, &["env", "GEMINI_API_KEY"])
            .or_else(|| ccs_string_at_path(config, &["env", "GOOGLE_API_KEY"])),
        "deepseek" => ccs_string_at_path(config, &["env", "DEEPSEEK_API_KEY"])
            .or_else(|| ccs_string_at_path(config, &["config", "DEEPSEEK_API_KEY"]))
            .or_else(|| {
                config
                    .pointer("/auth/DEEPSEEK_API_KEY")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                config
                    .pointer("/env/OPENAI_API_KEY")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                config
                    .pointer("/auth/OPENAI_API_KEY")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| ccs_string_at(config, &["apiKey", "api_key"])),
        "xai" => config
            .pointer("/env/OPENAI_API_KEY")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                config
                    .pointer("/auth/OPENAI_API_KEY")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| ccs_string_at(config, &["apiKey", "api_key"]))
            .or_else(|| {
                config
                    .get("config")
                    .and_then(|value| ccs_string_at(value, &["apiKey", "api_key"]))
            })
            .or_else(|| {
                // Grok Build TOML: api_key = "..."
                config
                    .get("config")
                    .and_then(Value::as_str)
                    .and_then(|text| ccs_extract_toml_string_value(text, "api_key"))
            }),
        _ => config
            .pointer("/env/OPENAI_API_KEY")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                config
                    .pointer("/auth/OPENAI_API_KEY")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| ccs_string_at(config, &["apiKey", "api_key"]))
            .or_else(|| {
                config
                    .get("config")
                    .and_then(|value| ccs_string_at(value, &["apiKey", "api_key"]))
            }),
    }
}

fn ccs_is_chat_protocol(config: &Value) -> bool {
    ccs_string_at(config, &["api_format", "apiFormat"])
        .map(|value| ccs_matches_chat_protocol(&value))
        .unwrap_or(false)
        || config
            .get("config")
            .and_then(Value::as_str)
            .and_then(|text| ccs_extract_toml_string_value(text, "wire_api"))
            .map(|value| ccs_matches_chat_protocol(&value))
            .unwrap_or(false)
        || ccs_extract_base_url("codex", config)
            .map(|value| value.to_ascii_lowercase().ends_with("/chat/completions"))
            .unwrap_or(false)
}

fn ccs_matches_chat_protocol(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "chat" | "chat_completions" | "chat-completions" | "openai_chat" | "openai-chat"
    )
}

fn is_official_deepseek_base_url(value: &str) -> bool {
    reqwest::Url::parse(value.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "api.deepseek.com")
}

fn ccs_string_at(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::to_string)
}

fn ccs_string_at_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_string)
}

fn ccs_extract_toml_string_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix(key) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let rest = &rest[quote.len_utf8()..];
        let end = rest.find(quote)?;
        return Some(rest[..end].to_string());
    }
    None
}

fn strip_ccswitch_suffix(name: &str) -> &str {
    name.trim()
        // Fullwidth parentheses, written as escapes so the source stays ASCII.
        .strip_suffix("\u{ff08}ccswitch\u{ff09}")
        .or_else(|| name.trim().strip_suffix("(ccswitch)"))
        .unwrap_or_else(|| name.trim())
}
