//! Public response DTOs and internal data types for the Skills module.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemListSkillFilesResponse {
    pub root_dir: String,
    pub paths: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct SystemReadSkillTextResponse {
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemReadSkillMetadataResponse {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillSourceMetadata {
    pub registry: String,
    pub slug: String,
    pub owner_handle: Option<String>,
    pub version: Option<String>,
    pub published_at: Option<u64>,
    pub original_name: Option<String>,
    pub normalized_name: Option<String>,
    pub compatibility_transform: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemClawHubSkillCard {
    pub slug: String,
    pub display_name: String,
    pub summary: String,
    pub latest_version: Option<String>,
    pub downloads: u64,
    pub stars: u64,
    pub installs_current: u64,
    pub updated_at: Option<u64>,
    pub owner_handle: Option<String>,
    pub web_url: Option<String>,
    pub download_url: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillSummary {
    pub name: String,
    pub description: String,
    pub target: String,
    pub skill_file: String,
    pub base_dir: String,
    pub built_in: bool,
    pub installed_at: Option<u64>,
    pub source: Option<SystemSkillSourceMetadata>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillInvalidEntry {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillInstallResult {
    pub name: String,
    pub target: String,
    pub backup: Option<String>,
    pub skill_file: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillValidationResponse {
    pub name: String,
    pub target: String,
    pub ok: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillPackageResponse {
    pub name: String,
    pub target: String,
    pub archive: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillDeleteResponse {
    pub name: String,
    pub target: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemBuiltinSkillSeedResponse {
    pub name: String,
    pub target: String,
    pub action: String,
    pub backup: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemExternalSkillEntry {
    pub name: String,
    pub description: String,
    /// Absolute path of the skill directory, usable directly as the `source` of an install action.
    pub base_dir: String,
    pub skill_file: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemExternalToolScan {
    pub tool: String,
    pub root_dir: String,
    pub exists: bool,
    pub skills: Vec<SystemExternalSkillEntry>,
    pub errors: Vec<String>,
}

/// A single MCP server parsed from an external tool config file (fields aligned with the
/// frontend McpServerConfig; missing entries are filled with defaults by the frontend on import).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemExternalMcpServerEntry {
    pub id: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub env: std::collections::BTreeMap<String, String>,
    pub headers: std::collections::BTreeMap<String, String>,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    /// Source scope: "user" or a project path (Claude Code's project-level config).
    pub origin: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemExternalMcpToolScan {
    pub tool: String,
    pub config_path: String,
    pub exists: bool,
    pub servers: Vec<SystemExternalMcpServerEntry>,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillInstallJobSnapshot {
    pub job_id: String,
    pub phase: String,
    pub source: String,
    pub label: Option<String>,
    pub slug: Option<String>,
    pub owner_handle: Option<String>,
    pub version: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub message: Option<String>,
    pub error: Option<String>,
    pub installed: Option<Vec<SystemSkillInstallResult>>,
    pub started_at: u64,
    pub updated_at: u64,
    pub finished_at: Option<u64>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemManageSkillResponse {
    pub action: String,
    pub root_dir: String,
    pub path: Option<String>,
    pub content: Option<String>,
    pub truncated: Option<bool>,
    pub start_line: Option<usize>,
    pub num_lines: Option<usize>,
    pub skills: Option<Vec<SystemSkillSummary>>,
    pub invalid: Option<Vec<SystemSkillInvalidEntry>>,
    pub installed: Option<Vec<SystemSkillInstallResult>>,
    pub created: Option<SystemSkillInstallResult>,
    pub validation: Option<SystemSkillValidationResponse>,
    pub package: Option<SystemSkillPackageResponse>,
    pub deleted: Option<SystemSkillDeleteResponse>,
    pub install_job: Option<SystemSkillInstallJobSnapshot>,
    pub clawhub_results: Option<Vec<SystemClawHubSkillCard>>,
    pub clawhub_next_cursor: Option<String>,
    pub clawhub_slug: Option<String>,
    pub clawhub_download_url: Option<String>,
    pub external: Option<Vec<SystemExternalToolScan>>,
    pub external_mcp: Option<Vec<SystemExternalMcpToolScan>>,
}

impl SystemManageSkillResponse {
    pub(crate) fn base(action: String, root_dir: String) -> Self {
        Self {
            action,
            root_dir,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SkillMetadata {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) metadata_file: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct GithubSource {
    pub(crate) owner: String,
    pub(crate) repo: String,
    pub(crate) git_ref: String,
    pub(crate) subpath: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SkillValidationResult {
    pub(crate) ok: bool,
    pub(crate) errors: Vec<String>,
    pub(crate) metadata: Option<SkillMetadata>,
}
