# Skills and MCP

## Management Entry Points and Sidebar Shortcuts

Desktop and WebUI both provide Skills, MCP, Cron, Memory, and Hooks under "Settings → Resources & Automation". Skills/MCP reuse the full Hub management interface, including installed resources and the store.

"Settings → System Settings → Sidebar Shortcuts" shows or hides Skills, MCP, Cron, and Memory independently; all are shown by default. The toggles only affect entry visibility — they do not disable resources, delete configurations, or stop scheduled tasks; after hiding, the management pages are still reachable from Settings.

When opening these four resource types from the main sidebar, only the right-hand content area is switched, preserving the desktop sidebar and the current chat draft; narrow screens keep the existing sidebar auto-collapse behavior. All four pages share a compact top layout.

Visibility is stored in `customSettings.sidebarShortcuts` (`skills`, `mcp`, `cron`, `memory`), synced bidirectionally via Gateway between desktop and WebUI connected to that desktop Agent, and written to each side's local storage so it survives refresh. Missing fields in old configurations are treated as shown; when an older version's sync message does not carry the field, the current state is retained.

## Skills Architecture

| Layer | Path | Responsibility |
|---|---|---|
| builtin source | `crates/agent-gui/src-tauri/prompt/skills/<skill-name>` | Builtin skills source files. |
| runtime root | `~/.liveagent/skills` | User runtime skills root directory. |
| Rust service | `src-tauri/src/services/skills/*` | seed builtin, list/read/manage/install/create/validate/package/ClawHub. The write side is serialized by the process-level `skills_write_guard()` (four writers: agent calls, gateway forwarding, UI background install threads, builtin seeding); installation uses stage-then-swap: content (including `_meta.json`) is fully built in `<root>/.staging/` first, then atomically renamed into place, so readers never see a half-built result. |
| Frontend lib | `crates/agent-ui/src/lib/skills/*` | discover skills (managed list only, via `SkillsManager list`), build prompt, ClawHub client, install status. |
| Tool | `src/lib/tools/skillTools.ts` | `SkillsManager`. |
| Hub UI | `crates/agent-ui/src/pages/skills-hub/SkillsHubPage.tsx` | Two views, Installed/Store: select, scan, preview, install; the host only supplies capability adapters. |

## Builtin Skills

| Skill | Description |
|---|---|
| `skills-creator` | Guides the model in creating new Skills. |
| `skills-installer` | Guides the model in installing local/GitHub/archive/ClawHub Skills. |

These two builtin skills are handled in the frontend `lib/skills/builtin.ts` as always enabled names, and can be seeded to the runtime root by `system_ensure_builtin_skills` on Rust startup or scan.

## SkillsManager

| Action | Description |
|---|---|
| `read` | Reads a Skill entry file, e.g. `SKILL.md`, `skill.json`, `README.md`. |
| `list` | Lists the enabled Skills visible to the current conversation. |
| `install` | Imports from a local directory, `.zip/.skill`, HTTP(S), or GitHub repo/tree/blob. |
| `create` | Creates a new Skill from a workflow summary. |
| `validate` | Validates an installed Skill. |
| `package` | Packages into a `.skill` archive. |
| `clawhub_search` | Searches/browses ClawHub. |
| `clawhub_install` | Downloads and installs by ClawHub slug. |

There are also UI-only background install job actions (not part of the agent tool schema): `install_start` starts a background install thread with progress, `install_status` polls a snapshot, and `install_cancel` cancels cooperatively (the download and per-skill install loop check the cancel flag, ending in the terminal state `phase: "cancelled"`).

## ClawHub Compatibility Boundaries

| Scenario | Handling Rule |
|---|---|
| Store identity | A ClawHub Skill is uniquely identified by `ownerHandle + slug`; the React key, install tasks, installed state, and `_meta.json` read-back must not merge by slug alone. |
| list missing owner | When an `/api/v1/skills` entry lacks a publisher, the owner is lazily resolved before detail/install via an exact search on `updatedAt`, version, downloads, and similar fields; if no unique match is found it fails explicitly rather than guessing a publisher. |
| Download/detail | All resolved details and `/api/v1/download` requests carry `ownerHandle`, avoiding HTTP 409 from duplicate slugs. |
| Non-portable names | The Agent Skills lowercase naming rule is still strictly enforced; ClawHub's official semantics separate the slug from the directory display name, neither derived from the other, so an illegal `name` in a single-Skill package is always repaired rather than rejected: prefer rewriting to the registry slug (falling back to parsing the download URL query when the payload lacks a slug), and when the slug is unavailable fall back to the normalized `name`; the original name, normalized name, and conversion type are written to `_meta.json`. |
| Original content | Name compatibility conversion only happens in the download temp directory and never modifies the registry download package; a legal `name` is kept as-is even if it differs from the slug; when neither the slug nor the normalized `name` is available (e.g. a Windows reserved name), it is still rejected under strict validation. |

## Skills Selection and Prompt Injection

| Stage | Description |
|---|---|
| Scan | `discoverSkills()` calls the Tauri or Gateway skill APIs to read Skill metadata from the runtime root. |
| Selection | Settings/Skills Hub manage `settings.skills.selected`; builtin always-on skills are merged automatically. |
| Injection | In Chat tools mode, `useChatSkills` and `lib/skills/index.ts` generate the skills prompt visible to the current conversation. |
| Access | Model maintenance of files inside a Skill should be done through the FS tools' skills root capability together with `SkillsManager`. |

## MCP Architecture

| Layer | Path | Responsibility |
|---|---|---|
| MCP settings | `settings.mcp.servers`, `settings.mcp.selected` | Server configuration and enable selection. |
| MCP Hub UI | `crates/agent-ui/src/pages/mcp-hub/*` | server form, registry browser, preview drawer, install draft. |
| Registry client | `crates/agent-ui/src/lib/mcpRegistry/index.ts` | Normalization of the official registry, Smithery, Glama, and other registries. |
| Rust runtime | `src-tauri/src/commands/integration/mcp.rs` | stdio/http/sse server lifecycle, tools/list, call_tool, test/restart/stop/status. |
| Dynamic tools | `src/lib/tools/mcpTools.ts` | Exposes tools from enabled MCP servers to the model. |
| Manager tool | `src/lib/tools/mcpManagerTools.ts` | MCP configuration CRUD, diagnostics, and lifecycle control. |
| Write path | `src/lib/settings/mcpOps.ts` | The single MCP configuration write path: `McpSettingsOp` (upsert/patch/remove/setEnabled) plus the pure reducer `applyMcpOps`, merged by id into `setSettings(prev => ...)`; tools read through the live `getMcpSettings` getter (authoritative `settingsRef`) rather than taking turn-level snapshots, so read-modify-write decisions and commits happen within the same synchronous section, eliminating multi-writer overwrites at the root. |

## MCP Dynamic Tool Lifecycle

| Stage | Description |
|---|---|
| Configuration | The user adds a server in MCP Hub/Settings, supporting stdio/http/sse and other transports. |
| Selection | Only enabled and selected servers enter runtime tool loading. |
| List tools | The frontend calls Tauri `mcp_list_tools`; the Rust side starts/syncs the server and returns tool info. |
| Naming | The frontend normalizes server/tool names to `mcp_<server>_<tool>`, avoiding conflicts and excessive length. |
| Call tool | The model calls a dynamic tool; the frontend executor calls Tauri `mcp_call_tool`, and the result enters the tool trace. |
| Management | `McpManager` does add/update/delete/enable/disable/status/test/restart/stop/tools/list. Write operations always commit the configuration first, then best-effort stop the old runtime (a stop failure degrades to a warning, self-healed by the next `ensure_client` config equality check). Non-chat scopes (such as cron) forbid write operations and restart/stop; test/tools/diagnose force `persist=false` to use a transient connection and never touch the shared connection pool. |
| Runtime pool | `McpRuntimeManager`'s clients map lock is only held briefly for get/insert and never locks an individual client or spawns while holding the map lock — calls to the same id serialize on the client lock, while different servers never block each other. |

## MCP Registry

| Source | Purpose |
|---|---|
| official registry | Reads the official server list and package metadata from `registry.modelcontextprotocol.io`. |
| Smithery | Searches Smithery servers and attempts to resolve an install draft or manual draft. |
| Glama | Searches the Glama MCP server list. |

Registry cards are normalized into a unified `McpRegistryCard`, where `installDraft` means a server config can be generated directly, and `manualDraft` means the user must complete it by hand.

## GUI/WebUI Parity Points

| Area | Notes |
|---|---|
| Skills Hub | The shared page provides installed/store, preview drawer, and install job status, and derives ClawHub install identity from `ownerHandle + slug`; each side injects its own capabilities. |
| MCP Hub | The shared page provides server form, registry browser, preview drawer, and install draft; each side injects its own runtime capabilities. |
| i18n | Both sides have their own `i18n/config.ts`; new copy must be kept in sync. |
| settings sync | Skills/MCP settings sync from GUI to WebUI via Gateway, and WebUI changes are written back to GUI. |
| shims | WebUI's Tauri invoke actually goes through Gateway; it should not be assumed that the browser has local permissions. |