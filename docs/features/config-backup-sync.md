# Configuration Backup and Sync

## Overall Model

Pack six domains — "providers / MCP / system preferences / prompt templates / model failover / STT" — into a single JSON snapshot, supporting export to a local file, or syncing to the user's own WebDAV cloud drive for sharing across multiple devices.

This is a **desktop-exclusive capability**. Both collecting and applying the snapshot directly touch SQLite and the local file system, consistent with the core invariant that "the desktop is the only place that executes tools and the only place that persists data". There is no such partition on the WebUI side, and the Gateway does not participate in any step.

| Layer | Path | Responsibility |
|---|---|---|
| Snapshot collection/validation/application | `src-tauri/src/commands/config/settings/backup_snapshot.rs` | `collect_backup_snapshot` / `validate_backup_manifest` / `apply_backup_snapshot`; automatically backs up to `~/.liveagent/backups/` before applying. |
| Local import/export | `src-tauri/src/commands/config/settings/backup_io.rs` | rfd file dialog + parse validation + write. |
| WebDAV orchestration | `src-tauri/src/commands/config/settings/webdav_sync.rs` | Sync config storage/retrieval, remote path assembly, upload/download, checksum verification. |
| WebDAV transport | `src-tauri/src/services/webdav.rs` | PROPFIND / MKCOL / PUT / GET, tiered timeouts, response body size caps, log redaction, and targeted error messages for providers such as Nutstore. |
| Automatic sync | `src-tauri/src/services/webdav_auto_sync.rs` | Debounced upload jobs, suppression guard. |
| Frontend IPC | `crates/agent-gui/src/lib/backup/index.ts` | Command wrappers + status event types. |
| Settings UI | `crates/agent-gui/src/pages/settings/BackupSyncSection.tsx` | Local backup group + WebDAV sync group. |

## Backup Scope (schema v2)

**In scope**:

- Provider configuration (including API keys)
- MCP servers
- System preferences — only the `SYSTEM_PORTABLE_BACKUP_KEYS` allowlist: executionMode, toolPolicies, commandSafetyMode, browserAutomationMode
- Prompt templates (`agent_prompt_templates`)
- Model failover (`model_failover_settings`)
- STT speech recognition configuration (`stt_settings`, including keys)

**Out of scope**: conversation history, memory stores, uploaded files, SSH private keys, skills, the WebDAV credentials themselves, and device-local state in the system domain (workdir, workspaceProjects and their derived keys, systemProxy).

All six domains live in SQLite; collection and application are completed entirely in the backend, and the frontend does not participate in assembling the snapshot content.

### Why the system domain carries only portable preferences

workdir and workspaceProjects are all absolute paths; a path on machine A most likely does not exist on machine B, and syncing it over just pollutes the config; systemProxy is configured per machine / per network environment, so pushing A's proxy password to B is meaningless and adds another exposure surface. The apply side **merges** by allowlist (rather than overwriting the whole domain): portable keys in the snapshot overwrite the local machine, while keys outside the allowlist keep their local values — so device-local keys mixed into old v1 backups are naturally filtered out too.

### Why the skills domain was removed (v1 → v2)

Skills themselves are directories on disk (`~/.liveagent/skills/`); v1 synced only the `{enabled, selected}` toggles: on a new device the skills that `selected` points to simply do not exist, so what gets synced is a list pointing at nothing. v2 removes this domain outright; v1 backups can still be imported, with the skills field ignored by serde.

> **WebDAV credentials must be excluded from the snapshot.** If they circulate with the snapshot, machine A's credentials would overwrite machine B's, forming a sync loop. For this reason the sync configuration lives in a separate table `backup_sync_settings` rather than `system_settings` — the latter's `save_system` uses the pattern "DELETE the whole table → re-INSERT by a fixed key allowlist", so any key not in the allowlist is silently wiped on the next system settings save.

## Security Trade-offs

**The provider API keys and STT keys in the snapshot are plaintext**, consistent with cc-switch's approach.

This does not violate the "Gateway never holds real keys" invariant — that invariant constrains the untrusted Gateway↔WebUI link, whereas the WebDAV endpoint is held and authenticated by the user themselves.

Supporting mitigations:

1. The WebDAV account password itself **never** enters any snapshot.
2. The system proxy password is excluded from the snapshot along with device-local state.
3. The manifest reserves an `encryption` field (currently always `"none"`), leaving a non-breaking upgrade path for future encryption.

The UI does not separately warn that "keys are plaintext" — aligned with cc-switch: the export and upload descriptions only state the scope of the synced content, and the confirmation dialog for enabling automatic sync talks about traffic consumption.

## Remote Layout

```
{remote_dir}/v1/{profile}/
  ├── manifest.json   # metadata + size and sha256 of config.json
  └── config.json     # the snapshot itself
```

Defaults to `liveagent/v1/default/`.

The version segment `v1` sits in the middle rather than at the outermost layer, so that what the user sees in a WebDAV client is a clean top-level directory. When the protocol evolves incompatibly, this segment is changed so that old and new clients each read their own. Schema compatibility evolution (such as this v1→v2) goes through `schemaVersion` in the manifest: new clients can read old snapshots, and old clients reject new snapshots and prompt for an upgrade.

`profile` supports isolating multiple sets of configurations under the same account (such as work / personal).

**The upload order is "PUT config.json first, then PUT manifest.json"**, and this is intentional. The manifest is the signal that "this backup is usable", so it is written last; if a failure occurs midway, the remote side is left with an old manifest + a new config, and the sha256 check on the download side catches this inconsistency instead of applying the incomplete configuration as a valid snapshot.

All remote reads and writes are serialized by a single global mutex — an upload is a two-step PUT, and concurrent execution would make the two files come from different snapshots.

## Automatic Sync

**Upload only, never download.** Automatically pulling from the remote would overwrite the local configuration without the user noticing, and the failure direction is unacceptable, so pulling is always a manual action.

### Trigger and Debounce

Dirty marking is done entirely in the backend: `save_providers` / `save_mcp` / `save_system` / `save_agents` / `save_model_failover` / `save_stt` call `mark_dirty()` **after** `tx.commit()` (or the atomic UPSERT) succeeds, so rolled-back transactions do not falsely trigger it. These functions are the sole write choke points for each domain on the SQLite side, naturally covering writes initiated by the Gateway; once all six snapshot domains are persisted, the frontend no longer needs the explicit dirty-marking channel (which existed in the v1 era for skills in localStorage).

> Why not use SQLite's `update_hook`: `open_db()` creates a new `Connection` on every call (69 call sites across the repo), while `update_hook` is per-connection; moreover, only rusqlite's `bundled` feature is currently enabled.

The dirty signal goes through a channel with capacity 1 — when an unhandled signal already exists, new signals are simply dropped, since the debounce window would merge them into a single upload anyway. The window is 1s of silence + a 10s hard cap; without a cap, continuous editing (for example typing an API Key character by character) would keep refreshing the debounce window and postpone the upload indefinitely.

### Suppression

While downloading and applying a remote snapshot, `AutoSyncSuppressionGuard` (RAII reference counting) is held. Applying a snapshot goes exactly through each domain's `save_*`; without suppression, it would push the data just pulled from the remote straight back.

The local import path (`settings_backup_apply_import`) is **intentionally not suppressed** — a configuration the user actively imports from a file should propagate to the remote.

### Status Feedback

The result of background sync is pushed via the Tauri event `backup-sync-status-updated`, with payload `{ lastSyncAt, lastError }`. The success or failure of a manual sync is reported to the frontend synchronously via the command's return value and does not go through this event — so receiving the event means "background automatic sync".

## Tauri Commands

| Command | Description |
|---|---|
| `settings_backup_export` / `settings_backup_peek_import` / `settings_backup_apply_import` | Local import/export; peek only parses and validates without writing, for the confirmation dialog to display the source device and item count. |
| `settings_backup_load_sync_config` / `settings_backup_save_sync_config` | Sync config storage/retrieval. **The view returned to the frontend does not contain the password**; it only uses `hasPassword` to indicate whether one has been set. |
| `settings_backup_test_sync_connection` | PROPFIND Depth=0 liveness check without parsing XML. |
| `settings_backup_fetch_remote_info` | Fetches only the manifest, for the confirmation dialog before upload/download. Returns `null` when there is no remote backup. |
| `settings_backup_upload` / `settings_backup_download` | Manual sync. |

**Password backfill**: when the frontend has not modified the password, it passes `passwordTouched: false`, and the backend reuses the old value from the database. This is a real bug recorded by cc-switch — after the UI fills the password field with a masked placeholder and submits it as-is, the placeholder gets written to the database as the new password, and the user's next sync fails authentication.

**STT application detail**: when applying a snapshot, `allowIncomplete: true` is injected for the stt domain — the source device may be in an intentionally incomplete state such as "keys already cleared", and this data was already accepted by the source-side `save_stt` back then, so the apply side does not re-validate it by the standard of "the user is currently submitting a form".