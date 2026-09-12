use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

use crate::runtime::project_path::project_path_key as normalize_project_path_key;
use crate::services::automation::AutomationScheduler;
use crate::services::gateway::GatewayController;

const DB_FILENAME: &str = "config.sqlite";
const DEFAULT_PROJECT_DIRNAME: &str = "default-project";
const PROVIDER_SETTINGS_TABLE: &str = "provider_settings";
const SYSTEM_SETTINGS_TABLE: &str = "system_settings";
const MCP_SETTINGS_TABLE: &str = "mcp_settings";
const AGENT_PROMPT_TEMPLATES_TABLE: &str = "agent_prompt_templates";
const SSH_SETTINGS_TABLE: &str = "ssh_settings";
const SSH_PROJECT_HOST_ASSOCIATIONS_TABLE: &str = "ssh_project_host_associations";
const SSH_KNOWN_HOSTS_TABLE: &str = "ssh_known_hosts";
const REMOTE_SETTINGS_TABLE: &str = "remote_settings";
const MEMORY_SETTINGS_TABLE: &str = "memory_settings";
const MODEL_FAILOVER_SETTINGS_TABLE: &str = "model_failover_settings";
// WebDAV sync configuration. Deliberately kept in its own table instead of living in system_settings — the latter's save_system
// deletes the whole table and rebuilds it from a fixed allowlist, so any key not on the allowlist is silently wiped.
// The separate table also incidentally ensures it is not captured into the config snapshot by load_system, preventing machine A's credentials from overwriting machine B's during sync.
const BACKUP_SYNC_SETTINGS_TABLE: &str = "backup_sync_settings";

const SYSTEM_EXECUTION_MODE_KEY: &str = "executionMode";
const SYSTEM_WORKDIR_KEY: &str = "workdir";
// Tool approval policy (keyed by tool name / `group:` / `server:` -> allow/ask/deny). It was previously not included in the
// save allowlist, which caused settings to be lost after restart; this key has now been added for persistence.
const SYSTEM_TOOL_POLICIES_KEY: &str = "toolPolicies";
// Command execution mode ("ask"/"auto"/"sandbox"/"sandboxOffline"), aligned with the frontend's
// SystemSettings.commandSafetyMode; sandbox* is mapped by the execution layer to OS sandbox parameters.
const SYSTEM_COMMAND_SAFETY_MODE_KEY: &str = "commandSafetyMode";
// Browser access mode ("auto"/"userProfile"/"isolated"), aligned with the frontend's
// SystemSettings.browserAutomationMode; the Browser tool passes it through per call to
// BrowserManager, deciding whether to use the extension bridge (the user's browser) or an isolated profile.
const SYSTEM_BROWSER_AUTOMATION_MODE_KEY: &str = "browserAutomationMode";
const SYSTEM_WORKSPACE_PROJECTS_KEY: &str = "workspaceProjects";
const SYSTEM_WORKSPACE_PROJECT_GROUPS_KEY: &str = "workspaceProjectGroups";
const SYSTEM_WORKSPACE_PROJECT_ORDER_KEY: &str = "workspaceProjectOrder";
const SYSTEM_SIDEBAR_PINNED_ORDER_KEY: &str = "sidebarPinnedOrder";
const SYSTEM_ACTIVE_WORKSPACE_PROJECT_ID_KEY: &str = "activeWorkspaceProjectId";
const SYSTEM_HIDDEN_WORKSPACE_PROJECT_PATHS_KEY: &str = "hiddenWorkspaceProjectPaths";
const SYSTEM_MISSING_WORKSPACE_PROJECT_PATHS_KEY: &str = "missingWorkspaceProjectPaths";
const SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY: &str = "archivedWorkspaceProjectPaths";
const SYSTEM_WORKSPACE_RESOURCE_SETTINGS_KEY: &str = "workspaceResourceSettings";
const SYSTEM_SYSTEM_PROXY_KEY: &str = "systemProxy";
// CUA self-targeting switch. Defaults to false — the cua-driver's tools by default can neither see nor click
// ReactorPro's own window: letting the model operate the host UI is equivalent to letting it click away its own approval dialogs,
// change its own settings, and shut itself down. Only setting this to true lifts the restriction (needed for scenarios such as using ReactorPro to
// automate testing ReactorPro).
const SYSTEM_CUA_ALLOW_SELF_TARGETING_KEY: &str = "cuaAllowSelfTargeting";
const DEFAULT_WORKSPACE_PROJECT_ID: &str = "default-project";
const DEFAULT_WORKSPACE_PROJECT_NAME: &str = "Default Project";
pub(crate) const PROVIDER_API_KEY_UPDATES_FIELD: &str = "providerApiKeyUpdates";
pub(crate) const PROVIDER_USAGE_QUERY_SECRET_UPDATES_FIELD: &str =
    "providerUsageQuerySecretUpdates";
pub(crate) const SYSTEM_PROXY_PASSWORD_UPDATE_FIELD: &str = "systemProxyPasswordUpdate";
pub(crate) const SSH_SECRET_UPDATES_FIELD: &str = "sshSecretUpdates";
pub(crate) const SSH_PATCH_FIELD: &str = "sshPatch";

const PROVIDER_SETTINGS_SELECT_SQL: &str = "
    SELECT provider_id, payload_json
    FROM provider_settings
    ORDER BY sort_index ASC, provider_id ASC
";
const PROVIDER_SETTINGS_INSERT_SQL: &str = "
    INSERT INTO provider_settings (provider_id, payload_json, sort_index, updated_at)
    VALUES (?1, ?2, ?3, ?4)
";
const PROVIDER_SETTINGS_DELETE_SQL: &str = "DELETE FROM provider_settings";

const SYSTEM_SETTINGS_SELECT_SQL: &str = "
    SELECT setting_key, payload_json
    FROM system_settings
";
const SYSTEM_SETTINGS_INSERT_SQL: &str = "
    INSERT INTO system_settings (setting_key, payload_json, updated_at)
    VALUES (?1, ?2, ?3)
";
const SYSTEM_SETTINGS_DELETE_SQL: &str = "DELETE FROM system_settings";

const MCP_SETTINGS_SELECT_SQL: &str = "
    SELECT server_id, payload_json
    FROM mcp_settings
    ORDER BY sort_index ASC, server_id ASC
";
const MCP_SETTINGS_INSERT_SQL: &str = "
    INSERT INTO mcp_settings (server_id, payload_json, sort_index, updated_at)
    VALUES (?1, ?2, ?3, ?4)
";
const MCP_SETTINGS_DELETE_SQL: &str = "DELETE FROM mcp_settings";

const AGENT_PROMPT_TEMPLATES_SELECT_SQL: &str = "
    SELECT template_id, name, description, prompt, enabled
    FROM agent_prompt_templates
    ORDER BY sort_index ASC, template_id ASC
";
const AGENT_PROMPT_TEMPLATES_INSERT_SQL: &str = "
    INSERT INTO agent_prompt_templates
        (template_id, name, description, prompt, enabled, sort_index, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
";
const AGENT_PROMPT_TEMPLATES_DELETE_SQL: &str = "DELETE FROM agent_prompt_templates";

const SSH_SETTINGS_SELECT_SQL: &str = "
    SELECT
        host_id,
        name,
        description,
        host,
        port,
        username,
        auth_type,
        password,
        password_configured,
        private_key,
        private_key_path,
        private_key_configured,
        private_key_passphrase,
        private_key_passphrase_configured,
        proxy_json
    FROM ssh_settings
    ORDER BY sort_index ASC, host_id ASC
";
const SSH_SETTINGS_INSERT_SQL: &str = "
    INSERT INTO ssh_settings (
        host_id,
        name,
        description,
        host,
        port,
        username,
        auth_type,
        password,
        password_configured,
        private_key,
        private_key_path,
        private_key_configured,
        private_key_passphrase,
        private_key_passphrase_configured,
        proxy_json,
        sort_index,
        updated_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
";
const SSH_SETTINGS_DELETE_SQL: &str = "DELETE FROM ssh_settings";
const SSH_PROJECT_HOST_ASSOCIATIONS_SELECT_SQL: &str = "
    SELECT project_path_key, host_ids_json
    FROM ssh_project_host_associations
    ORDER BY project_path_key ASC
";
const SSH_PROJECT_HOST_ASSOCIATIONS_INSERT_SQL: &str = "
    INSERT INTO ssh_project_host_associations (project_path_key, host_ids_json, updated_at)
    VALUES (?1, ?2, ?3)
";
const SSH_PROJECT_HOST_ASSOCIATIONS_DELETE_SQL: &str = "DELETE FROM ssh_project_host_associations";
const SSH_KNOWN_HOSTS_DELETE_SQL: &str = "
    DELETE FROM ssh_known_hosts
    WHERE host = ?1 AND port = ?2
";

include!("types.rs");
include!("remote.rs");
include!("db.rs");
include!("json.rs");
include!("providers.rs");
include!("ccs_import.rs");
include!("cherry_import.rs");
include!("agents.rs");
include!("system.rs");
include!("mcp.rs");
include!("memory_settings.rs");
include!("model_failover.rs");
include!("gateway_sync.rs");
include!("backup_snapshot.rs");
include!("backup_io.rs");
include!("webdav_sync.rs");
include!("ssh/mod.rs");
include!("commands.rs");
include!("tests.rs");
