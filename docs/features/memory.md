# Memory System

## Overall Model

ReactorPro's memory system uses the Rust `MemoryStore` as the local source of truth; the frontend TypeScript memory domain is spread across shared packages and the desktop runtime, providing Settings management, Chat prompt injection, the `MemoryManager` tool, post-turn silent extraction, and the offline organizer. Gateway/WebUI does not own an independent memory store; it only forwards WebUI memory requests to the desktop side.

| Layer | Path | Responsibility |
|---|---|---|
| Rust Store | `src-tauri/src/services/memory/` | Markdown file read/write, SQLite FTS index, search, quota, daily, organize run, audit; `mutations/evidence.rs` is the single implementation point for the confidence contract and evidence frontmatter. |
| Tauri commands | `src-tauri/src/commands/integration/memory.rs` | Entry points such as `memory_list/read/search/write/update/delete/accept/apply_batch/quota_summary/organize_*`. |
| Single source-of-truth schema | `crates/agent-ui/src/lib/memory/schema.ts` | scope/type/confidence/action enums, plan/decision shapes, `CONFIDENCE_CONTRACT` constants. |
| Config constants | `crates/agent-ui/src/lib/memory/config.ts` | All magic numbers for the memory domain (throttling, windows, cluster size, quota ladder thresholds, etc.). |
| Frontend API | `crates/agent-ui/src/lib/memory/api.ts` | TypeScript wrapper for memory commands; the concrete transport is adapted by the host. |
| Prompts | `src/lib/memory/prompts/{shared,injection,extraction,organizer,managerTool}.ts` | Split by audience: injection index, extraction instructions, organizer prompt, tool description; single source for policy wording. |
| Extraction engine | `src/lib/chat/memory/extractionEngine.ts` | Post-turn hidden LLM turn: compact context → `SubmitMemoryPlan` tool submission → single `memory_apply_batch`. |
| Extraction controller | `src/lib/chat/memory/extractionController.ts` | Session-level lifecycle: synchronous atomic claim, independent AbortController, coalesce queue, dispose cleanup. |
| Tool | `src/lib/tools/memoryTools.ts` | Exposes `MemoryManager` (ro/rw) to the model; evidence is passed directly to Rust as structured fields. |
| Organizer | `src/lib/memory/organizer/{pipeline,runRecord,quota,service}.ts` + `src/components/memory/useMemoryOrganizer.ts` | Pure-function pipeline + typed v4 run records + quota ladder + plain TS scheduling service (React only mounts it). |
| Settings UI | `crates/agent-ui/src/pages/settings/memory/` + each platform's `platform.tsx` | Memory management, organizer settings/history/manual apply, quota banner. |

## Storage Structure

| Data | Location | Notes |
|---|---|---|
| Markdown source of truth | `~/.liveagent/memory/...` | Canonical source for memory content and frontmatter. |
| SQLite index | `~/.liveagent/memory/memory-index.sqlite3` | `memory_meta`, `memory_fts`, `memory_fts_tri`, `memory_audit_log`, `memory_organize_runs` (schema v4, v3→v4 incremental migration preserves history). |
| Settings | Persisted by `settings_save_memory` | summary model, organizer schedule/scope/mode, etc. |
| Organize run records | `memory_organize_runs` | v4 columns include `phase/final_count/compression_ratio/token_usage_total/quota_headroom_at_start`; the `report` field stores a typed v4 report (parsed only via `runRecord.ts`). |

## Scope and Types

| Dimension | Value | Notes |
|---|---|---|
| scope | `global` | Cross-project user preferences, identity facts, long-term feedback. |
| scope | `project` | Project memory bound to the current workdir; writes are constrained by the project-domain gate. |
| type | `user` | User identity, preferences, habits. |
| type | `feedback` | Long-term user feedback on Agent behavior. |
| type | `project` | Project knowledge, architecture conventions, workflows. |
| type | `reference` | Referenceable material. |
| type | `daily` | Journal/diary-type memory, scope fixed to global, appended by date; cannot be exposed as a writable type. |

## Evidence and Confidence Contract

Evidence for writes/updates (confidence, source_quote, reasoning, aliases, supersedes, conflicts_with, override_reject) is passed from TS to Rust as **structured fields** (`MemoryEvidenceArgs`); Rust's `mutations/evidence.rs` renders the canonical frontmatter and enforces the contract:

- `high` requires a verbatim quote of ≥5 characters, otherwise it is downgraded to `medium`; `medium` requires a non-empty quote, otherwise it is downgraded to `low`; downgrades record `auto_downgraded: true`.
- Mutation responses return `appliedConfidence/autoDowngraded`, and the `MemoryManager` tool result includes a downgrade hint.
- Across the whole system, only Rust writes frontmatter in one place and reads it back in one place (index reconcile); TS performs no serialization at all.

## Quota Semantics and Ladder

| Item | Notes |
|---|---|
| ordinary memory | Non-daily global/project memory; capped at 500 per scope. |
| `memory_quota_summary` | Returns used/limit/headroom/archived/unreviewed/oldest unreviewed days per scope. |
| Quota ladder | `organizer/quota.ts` grades by the headroom of the tightest scope: normal(>100)/notice(≤100)/degraded(≤50)/critical(≤20)/exhausted(≤5); when not normal, the settings drawer shows a banner and the organizer prompt injects a compression target (no silent auto-archiving). |
| daily | Not counted against the ordinary quota. |

## Recall Paths

| Path | Notes |
|---|---|
| Overview injection | Chat calls `memory_index_overview` every turn, and `prompts/injection.ts` renders a compact Memory Index (30/bucket, 16KB cap) into the system prompt. |
| MemoryManager | The model can explicitly `list/read/search` to recall more entries, and mutate when necessary. |
| Search | SQLite FTS5/BM25 plus trigram assist Chinese/short-word retrieval; results are then ranked by scope, review, daily decay, etc. |
| Project shadow | Current project memory can override global memory with the same slug/same semantics in the overview. |

## Unreviewed and Review

| State | Semantics |
|---|---|
| reviewed | Ordinary high-confidence memory that can enter recall ranking directly. |
| unreviewed | Unreviewed but usable working memory; the overview annotates confidence as `*:h/m/l/?`. |
| recent rejections | The extraction validation layer rejects rewriting slugs recently rejected by the user, unless the plan item carries `override_reject`. |
| accept | `MemoryManager`, Settings, or an accept item in an extraction plan can turn unreviewed into reviewed. |

## Post-Turn Extraction (SubmitMemoryPlan Protocol)

| Phase | Notes |
|---|---|
| Trigger | Both turn runners call `memoryExtraction.requestExtraction` at the end of the turn; agent-dev mode waits and displays, while other modes run in the background. |
| Controller | Gating (empty message/too short/greeting/thanks/30s interval/same-message dedup) and claiming complete synchronously before the first await; each run has its own AbortController, decoupled from the chat request signal—a new user turn will not cut off an in-flight extraction; new requests during a run enter the coalesce queue; `dispose` cleans up on session deletion. |
| Context | Self-contained compact input: last 4 user turns verbatim window (2000 chars/turn, 12000 chars/window) + `<workspace-mutations-this-turn>` deterministic change summary (project-domain gate evidence) + candidates(30)/rejections(7d)/already-written blocks. Does not reuse the chat system prompt. |
| Output protocol | The model submits a plan via a single `SubmitMemoryPlan` tool call (write/update/accept/delete/append_daily). identify→match→plan serves only as in-prompt reasoning guidance. If nothing is submitted on the first turn, retry with an appended turn exposing only that tool; if still missing, record as noop—never drop a turn. |
| Validation | `planTool.ts` validates item by item (missing fields/domain gate/rejected slug/duplicate/overlong); bad entries are rejected with a code and the rest are applied as usual. |
| Apply | A single `memory_apply_batch` (upsert/update/delete/accept + dailyAppend), sharing the same persistence path as the organizer and manual apply; `op=update` supports evidence-only updates. |
| Status display | Status lines are rendered via i18n (`chat.memoryExtraction.done/noop/partial`), no longer hard-coded Chinese sentinels. |

## Organizer (scan → cluster → plan → gate → apply)

| Phase | Notes |
|---|---|
| Scheduling | `organizer/service.ts` wakes via a one-shot `setTimeout` from `organizerNextRunAt`; when disabled or frequency=none no timer is armed; Run Now goes through `pokeMemoryOrganizer()` (the window event bus has been removed). |
| scan | `memory_quota_summary` + full list/read; records `quota_headroom_at_start`. |
| cluster | LLM topic clustering when >8 entries (`SubmitMemoryTopicClusters`), falling back to structural clustering on failure (scope:hash:type × 8). |
| plan | Each cluster submits via the `SubmitMemoryOrganizePlan` tool (keep/merge_into/delete/mark_review/rewrite_hint), with a global manifest and quota compression target; cluster-level failures are isolated. |
| gate | `pipeline.ts` independently recomputes risk (cross_scope→high, low confidence→high, reviewed→≥medium, etc.), deciding auto-apply or queueing by trigger×mode×risk×confidence; rejections are recorded in buckets. |
| apply | scheduled auto-applies low risk; manual stores a v4 report pending panel review (`memory_apply_batch` guarantees merge writes before deletes by groupId). |
| Records | Each phase updates the run row; on completion it writes `final_count/compression_ratio/token_usage_total` and a typed `report` (v4); older-version reports degrade to read-only summaries in the panel. |

## Gateway/WebUI Boundary

| Scenario | Implementation |
|---|---|
| Shared discipline | schema, config, API, organizer pure logic, and Settings components live in `crates/agent-ui`; the local organizer wake capability only goes into each platform's `agent-ui-adapters/memoryOrganizer.ts`. |
| WebUI MemoryPanel | Forwards to the desktop side via `memory.manage`; the desktop bridge's `handle_memory_manage_sync` is an explicit match (new commands require adding an arm). |
| WebUI organizer | Run Now creates a pending run (`pokeMemoryOrganizer` is always false → QueuedRemote hint); actual execution depends on desktop-side claiming. |
| Extraction/organize execution | Desktop-only (`prompts/*`, `extraction/*`, `organizer/{pipeline,service}`, `memoryTools` do not enter the WebUI host). |
| Project scope | WebUI requests must carry a workdir, and the Gateway bridge passes it through to Rust, avoiding project memory distortion. |

## Common Troubleshooting Entry Points

| Problem | Check First |
|---|---|
| Memory not written | Controller skip reason (console.debug), whether `SubmitMemoryPlan` submitted, `planTool` rejection code, `memory_apply_batch` warnings, MemoryStore audit log. |
| Extraction skipped | `extractionSkipReason` gating (too short/greeting/throttled/same message), coalesce queue. |
| Memory not searchable | Whether `memory-index.sqlite3` was reconciled, whether FTS rows exist, whether scope/workdir are correct. |
| WebUI project memory misplaced | Whether the `memory.manage` payload carries a workdir, whether the Gateway bridge passes it through. |
| Quota display incorrect | `memory_quota_summary`, `deriveQuotaLadder` thresholds, panel banner. |
| organizer 0 merges | Run record `report.rejectionBuckets` buckets, mode injection, `shouldQueueDecision` matrix. |
| daily title abnormal | `daily_slug_local_date`, `daily_title_for_meta`, Settings Journal rendering. |