# Tool System

## Tool Registration Entry Point

`src/lib/tools/builtinRegistry.ts` is the composition entry point of the local tool system. `buildBuiltinToolRegistry()` accepts parameters such as workdir, provider, skills, MCP settings, runtime scope, selected system tools, and subagent runtime (`SubagentRuntimeConfig`), and returns:

| Field | Description |
|---|---|
| `tools` | The list of tool schemas exposed to the model. |
| `executeToolCall` | Dispatches to the specific executor based on tool name. |
| `metadataByName` | Tool metadata used by the UI and traces. |
| `hasTool` | Determines whether a tool is available. |

## Builtin Tool Bundle

| Bundle | Main paths | Tools/capabilities |
|---|---|---|
| File system | `fsTools.ts`, `fileToolState.ts` | File capabilities such as Read/List/Glob/Grep/Write/Edit/Delete/Image, constrained by the project root directory, skills root, and project attached-directory authorization policy. |
| Edit fault-tolerant matching | Rust `commands/workspace/edit_match.rs` | Edit's `old_string` location is attempted in order of decreasing strictness: exact match → CRLF/LF line-ending normalization (including BOM tolerance; replacement is re-rendered using the file's dominant line-ending style) → whole-line trailing-whitespace tolerance → whole-line uniform indentation offset (replacement text is reflowed using the file's real indentation). The first matching pass takes effect; when a non-exact pass matches, the result returns `matchStrategy` to hint the model. Note: line-level passes (trailing whitespace / indentation offset) rewrite the entire matched line window using `new_string` as a whole, so the original trailing whitespace of context lines within that window is normalized away along with it. |
| Shell | `shellTools.ts`, `bashTimeoutPolicy.ts` | Bash/Shell execution; chat scope can enable ManagedProcess. |
| SkillsManager | `skillTools.ts` | read/list/install/create/validate/package/clawhub_search/clawhub_install. |
| CronTaskManager | `cronTools.ts` | Create, read, update, and delete cron tasks; view logs. |
| McpManager | `mcpManagerTools.ts` | MCP server CRUD, enable/disable, test/restart/stop, tools/list. |
| Dynamic MCP tools | `mcpTools.ts` | Expose tools of enabled MCP servers as `mcp_<server>_<tool>`. |
| Custom system tools | `customSystemTools.ts` | System tools such as HTTP test, controlled by selectedSystemTools in Settings. |
| MemoryManager | `memoryTools.ts` | list/read/search/write/update/delete/accept, supporting global/project/daily semantics. |
| Task tools | `taskTools.ts`, `taskState.ts` | `TaskCreate`/`TaskUpdate`/`TaskList` incrementally maintain the authoritative task state of the current Run by stable numeric ID; the state is persisted via `context_meta_json` and survives across compaction checkpoints. Available only when `runtimeScope=chat` and not included in the subagent registry. |
| Subagent | `src/lib/subagents/*` (adaptation layer `agentTool.ts`, `sendMessageTool.ts`) | Built-in `Agent`/`SendMessage` tools: delegated persistent subagents, isolated worktrees, Message Bus. |

## Long-Running Bash Sessions

Bash in the Chat runtime uses a resumable session: after the initial wait window ends, an unfinished command returns a `session_id` and an absolute `cursor`; the model waits via `ProcessWait` and incrementally reads the same process, and terminates the full process tree via `ProcessStop`. Non-Chat runtimes continue to use the original synchronous Shell path.

Both GUI and WebUI display `Bash`, `ProcessWait`, and `ProcessStop` independently in call order, preserving each call's parameters, state snapshot, and incremental output, without merging across rounds or hiding the session control tools.

| Field/Status | Semantics |
|---|---|
| `session_duration_ms` | Cumulative duration measured from the initial Bash launch; values from different responses must not be added together. The underlying compatible details still use `duration_ms`. |
| `completed` | The command ended normally with exit code 0. |
| `failed` | The command failed to start or execute. |
| `cancelled` | Cancelled by `ProcessStop`, Chat Stop, or the application lifecycle. |
| `timed_out` | An explicit hard timeout was triggered. |
| `output_truncated` | The session ring buffer has evicted historical output requested by the caller. |

### Acceptance Prompt

The prompt below verifies single launch, cursor continuation, cumulative duration semantics, and the pre/post Git baseline all at once:

```text
Please run one long-running Bash session verification in the current ReactorPro repository.

1. Before starting, run a read-only `git status --porcelain=v1` once and record it in full as the pre-test baseline.
2. Start `cargo test -p liveagent -- --test-threads=1` only once; do not launch this test command repeatedly.
3. If Bash returns status=running:
   - record the session_id and cursor;
   - do not re-run cargo test, and do not execute Bash sleep or polling scripts;
   - use ProcessWait to wait on the same session, passing the latest cursor from the previous response each time;
   - use yield_time_ms=60000 for long tasks expected to be quiet.
4. Keep waiting until completed, failed, cancelled, or timed_out. session_duration_ms is the cumulative duration measured from the initial Bash launch; do not add the values from multiple responses together.
5. After completion, run `git status --porcelain=v1` again and compare line by line whether the pre-test and post-test baselines are exactly identical.
6. Report the number of test command launches, number of ProcessWait calls, session_id, cursor progression, final status, exit_code, final session_duration_ms, output_truncated, test statistics, and the Git baseline comparison result.
```

## Execution Boundaries

| End | Executes tools? | Description |
|---|---|---|
| GUI local Chat | Yes | Tools run on the desktop side, directly invoking Tauri invoke or frontend local logic. |
| WebUI Chat | Indirect execution | WebUI sends Chat Commands to the Gateway; the actual tools still run in the desktop GUI/Tauri. |
| Gateway | No | The Gateway does not execute business tools; it only forwards requests/events and maintains buffers. |

## Project Attached Directories

| Capability | Description |
|---|---|
| Path format | The model accesses attached directories authorized in project settings via `root://<alias>/...`; ordinary relative paths are still rooted at the project root directory. |
| Permissions | Each attached directory is independently configured as read-only or writable; read-only directories reject Write/Edit/Delete. When a directory becomes invalid, its path drifts, or a symlink target changes, fail-closed applies and re-authorization is required. |
| Subagents | A subagent only inherits the read-only capability of the parent's attached directories; even if the parent is authorized as writable, no privilege is escalated to the subagent. |
| Shell/processes | Bash, Shell, and ManagedProcess do not inherit attached-directory capabilities and still only use the project root directory and its original policy. |
| Lifecycle | Authorizations are stored in Desktop and revoked by project ID when the project or worktree is deleted; authorizations are not synced as ordinary Settings content or persisted by the Gateway. |

## MCP Dynamic Tools

| Stage | Description |
|---|---|
| Configuration | Settings/MCP Hub maintains the server list, transport, command/url/env/headers, etc. |
| Loading | `createMcpTools()` filters enabled servers and calls the Tauri `mcp_list_tools`. |
| Naming | Dynamic tool names are normalized to `mcp_<server>_<tool>`; if too long, they are truncated with a hash suffix. |
| Invocation | After the model invokes a dynamic tool, the frontend executor calls the Tauri `mcp_call_tool`. |
| Diagnostics | `McpManager` can perform runtime_status/test/restart/stop/tools/list. |

## Skills Tool Boundaries

| Capability | Description |
|---|---|
| Fixed root | The Skills runtime root is `~/.liveagent/skills`. |
| always-on | `skills-creator` and `skills-installer` are builtin always enabled skills. |
| File access | Files inside an enabled skill can be accessed via relative paths with `root="skills"` in the FS tools. |
| Management operations | Creation, installation, ClawHub installation, validate, and package should go through `SkillsManager`. |
| Access policy | `SkillAccessPolicy` controls whether the model can access/modify the skills root. |

## Memory Tool Boundaries

| Operation | Description |
|---|---|
| read/list/search | Can be used for the model to recall complete memories on demand. |
| write/update/delete/accept | Modifies the Markdown source of truth and the SQLite index, subject to scope/type validation. |
| daily append | The daily type maintains diary-style memories via append mode and does not count toward the ordinary quota. |
| silent extraction | During implicit memory extraction, the model is not directly asked to call mutations; instead, the plan is parsed and then applied by ReactorPro. |

## Subagent (Agent / SendMessage)

The subagent domain as a whole lives in `src/lib/subagents/`, organized in strict layers:

| Layer | Files | Responsibility |
|---|---|---|
| L1 pure domain | `types.ts`, `protocol.ts`, `errors.ts`, `validate.ts`, `policy.ts`, `prompts.ts`, `bus.ts`, `roster.ts`, `utils.ts` | Types and constants, UI wire protocol, structured errors, batch validation, readonly/worktree tool selection and apply/cleanup decisions, system prompt construction, Message Bus rendering, roster/template aggregation. No IPC, no side effects. |
| L2 ipc | `ipc/store.ts`, `ipc/worktree.ts` | Tauri invoke ports for persistence and worktrees (`subagent_*` commands), null→absent normalization, serialized writes within the same run; tests can inject doubles. |
| L3 runtime | `scheduler.ts`, `store.ts`, `run.ts` | `SubagentScheduler` semaphore-based concurrent scheduling; `SubagentConversationStore` is the single source of truth at the conversation level (roster, latest run, hydrated private-context LRU, Message Bus); `run.ts` is the single-run state machine (worktree creation → tool loop → apply/cleanup → persistence). |
| L4 tool adaptation | `agentTool.ts`, `sendMessageTool.ts`, `cards.ts`, `index.ts` | Generates the tool schemas and executors for `Agent`/`SendMessage`, per-agent card tool call/result, and the public export surface. |

`Agent` tool semantics:

| Capability | Description |
|---|---|
| Structured parameters | An `agents` array (each item has `id/prompt/name/role/identity/template/mode/apply_policy/allowed_output_paths/resume/retain_worktree`) + a top-level `concurrency`; up to 8 agents in parallel per call. |
| Stable id and reuse | Reusing an id within the same conversation resumes that subagent's private context; `name/role/identity/template` only take effect when the id is first created, and passing different values for an existing id is rejected. `resume=false` starts a brand-new private context for the same id. |
| mode | `readonly` (the default for new agents, read-only tools) is used for research/review; `worktree` provides file + shell tools inside an isolated git worktree. A resumed agent uses the previous mode by default. |
| apply_policy | `none` (default, no write-back)/`auto` (automatically apply the patch)/`explicit` (apply only when all changed files hit `allowed_output_paths`; paths must resolve into the workspace). `retain_worktree=true` keeps a safely cleanable worktree for review. |
| Atomic validation | When validation fails, no agent is started; a structured error is returned along with the current roster and enabled template list; `AgentPromptTemplate.enabled` takes effect, and `template` can only reference enabled templates (resolved by id or name). |
| SendMessage | `to=parent` (parent-private)/`to=*` (shared broadcast)/`to=<agent id>` (direct); recipients are validated against the roster, and unknown recipients are rejected outright; channel is direct/shared/decision/question, and messages are delivered at the next turn boundary. |
| Persistence | A run is incrementally written to disk via `subagent_run_save` at each turn boundary; an interrupted run can resume from the last completed round; run status includes `cancelled`. identity/run/message/worktree each have their own Tauri command families (see architecture/gui.md). |
| UI protocol | details kind is `subagent_batch`/`subagent_card`/`subagent_message`; per-agent cards are rendered as a synthetic tool call marked with `subagent_card: true`, and rejected Agent calls are also rendered visibly; the single source of truth for the protocol is at `crates/agent-ui/src/lib/subagents/protocol.ts`. |

## Tool Refactoring Checklist

| Change | Must check |
|---|---|
| Adding a builtin tool | schema, executor, metadata, UI trace details, agent-dev observability. |
| Adding a Tauri-backed tool | Rust invoke command, frontend invoke parameters, error messages, permission boundaries. |
| Modifying MCP configuration | Both GUI/WebUI Settings/MCP Hub ends, Gateway settings sync redaction. Tool-side writes must go through `settings/mcpOps.ts`'s `McpSettingsOp` id-level merge (`applyMcpOps`), and full replacement of `settings.mcp` is forbidden; reads must go through the `getMcpSettings` live getter (authoritative `settingsRef`), and turn-level snapshots are forbidden; the read-modify-write decision and commit must be within the same synchronous section (re-read after await). |
| Modifying Skills behavior | services/skills/*, `crates/agent-ui/src/lib/skills`, Skills Hub installed state. All writes to active targets under the skills root must hold `skills_write_guard()`; installation uses stage-then-swap (build under `<root>/.staging` + atomic placement via `fs::rename`), and writing file-by-file directly into the active directory is forbidden. |
| Modifying Memory behavior | MemoryStore, MemoryManager, shared Settings Memory, both platform adapters, Gateway memory.manage. |