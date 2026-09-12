//! Skills service module (split from the original single-file skills.rs, code migrated verbatim, behavior unchanged).
//!
//! - [`types`]: external `System*` response DTOs and internal data types
//! - [`util`]: temp directory, timestamp, and payload field utilities
//! - [`paths`]: skills root directory resolution, path echoing, and path / name sanitization
//! - [`metadata`]: frontmatter / skill.json metadata parsing and metadata file location
//! - [`library`]: installed Skill library (discover / list / read / delete / package / `_meta.json`)
//! - [`sources`]: install source preparation (GitHub / HTTP / local / archive), download, and safe extraction
//! - [`install`]: backup, conflict-policy copies, and install payload orchestration
//! - [`jobs`]: background install task registry and the install_start worker thread
//! - [`clawhub`]: ClawHub registry search and install
//! - [`create`]: SKILL.md template rendering and create orchestration
//! - [`validate`]: Skill directory validation
//! - [`builtin`]: built-in Agent Skill definitions, modification protection, and seed writing
//! - [`manager`]: `system_manage_skill_sync` action dispatch entry point

mod builtin;
mod clawhub;
mod create;
mod external;
mod external_mcp;
mod install;
mod jobs;
mod library;
mod manager;
mod metadata;
mod paths;
mod sources;
#[cfg(test)]
mod tests;
mod types;
mod util;
mod validate;

pub use builtin::ensure_builtin_agent_skills_sync;
pub(crate) use builtin::*;
pub(crate) use clawhub::*;
pub(crate) use create::*;
pub(crate) use external::*;
pub(crate) use external_mcp::*;
pub(crate) use install::*;
pub(crate) use jobs::*;
pub(crate) use library::*;
pub use library::{
    system_list_skill_files_sync, system_read_skill_metadata_sync, system_read_skill_text_sync,
};
pub use manager::system_manage_skill_sync;
pub(crate) use metadata::*;
pub use paths::skills_root_dir;
pub(crate) use paths::*;
pub(crate) use sources::*;
pub use types::*;
pub(crate) use util::*;
pub(crate) use validate::*;

/// Skill limit constants shared across submodules.
pub(crate) const MAX_SKILL_DESCRIPTION_LENGTH: usize = 1024;
pub(crate) const MAX_SKILL_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Process-wide write lock for the Skills root directory.
///
/// Four writer paths (agent sync call, gateway forwarding, UI background install thread, built-in Skill seeding)
/// share the same directory tree; every change to the live target directory (swap/delete/package/seed write) must
/// hold this lock. Downloads and staged builds do not hold it -- only the millisecond-scale placement step is under the lock.
static SKILLS_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn skills_write_guard() -> std::sync::MutexGuard<'static, ()> {
    SKILLS_WRITE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
