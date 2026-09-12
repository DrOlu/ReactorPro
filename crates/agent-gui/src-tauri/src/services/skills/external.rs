//! Scan Skills installed by other local CLI tools (Claude Code / Codex / CodeBuddy) and
//! under the AGENTS convention, for the UI to display and let the user select for import
//! (the import itself reuses the existing install action, source = the skill directory).

use super::library::discover_skill_dirs;
use super::metadata::{read_skill_metadata_from_dir, standard_metadata_file_for};
use super::types::{SystemExternalSkillEntry, SystemExternalToolScan};
use crate::runtime::platform::expand_tilde_path;

const EXTERNAL_TOOL_ROOTS: &[(&str, &str)] = &[
    ("claude-code", "~/.claude/skills"),
    ("codex", "~/.codex/skills"),
    // CodeBuddy's skill marketplace cache directory: may contain uninstalled skills, which the UI flags to the user.
    ("codebuddy", "~/.codebuddy/skills-marketplace/skills"),
    // The generic global skills directory defined by the AGENTS convention, not tied to any single coding tool.
    ("agents", "~/.agents/skills"),
];

pub(crate) fn scan_external_skills() -> Vec<SystemExternalToolScan> {
    EXTERNAL_TOOL_ROOTS
        .iter()
        .map(|(tool, raw_root)| {
            let root = expand_tilde_path(raw_root);
            let exists = root.is_dir();
            let mut skills = Vec::new();
            let mut errors = Vec::new();
            if exists {
                for dir in discover_skill_dirs(&root) {
                    // Only accept skills with standard metadata (skill.json / SKILL.md / skill.md):
                    // a directory name that falls back to a plain README would inevitably fail
                    // install's staging-directory validation.
                    if standard_metadata_file_for(&dir).is_none() {
                        errors.push(format!(
                            "No SKILL.md, skill.md, or skill.json found in {}",
                            dir.display()
                        ));
                        continue;
                    }
                    match read_skill_metadata_from_dir(&dir) {
                        Ok(meta) => skills.push(SystemExternalSkillEntry {
                            name: meta.name,
                            description: meta.description,
                            base_dir: dir.display().to_string(),
                            skill_file: meta.metadata_file.display().to_string(),
                        }),
                        Err(err) => errors.push(err),
                    }
                }
                skills.sort_by_key(|a| a.name.to_lowercase());
            }
            SystemExternalToolScan {
                tool: (*tool).to_string(),
                root_dir: (*raw_root).to_string(),
                exists,
                skills,
                errors,
            }
        })
        .collect()
}
