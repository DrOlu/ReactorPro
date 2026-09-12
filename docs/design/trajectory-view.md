# Trajectory View Design and Implementation

The trajectory view is a second projection alongside the conversation body: it unfolds an Agent session as "input → model request → tool execution → subagent → compaction", to answer the following questions:

- What System Prompt and tool catalog the model actually saw this turn;
- When the first model-side output appeared, and whether time went to TTFT or decoding;
- Which provider/model actually completed the request, and whether failover occurred;
- The start, end, error, and interruption relationships of tools, subagents, and context compaction;
- Whether diagnostic data remains consistent with authoritative history after WebUI reconnect, history pagination, and edit-resend.

The information architecture references the trajectory view of deepseek-harness, but event collection, lifecycle, persistence, remote transport, and host capabilities are all reimplemented according to ReactorPro's own runtime, rather than copying the harness's frontend components in isolation.

## Current Decision Summary

| Item | Implementation |
|---|---|
| Instrumentation granularity | turn, provider step, first output, retry, tool, subagent, compaction, runtime context. |
| Prompt snapshot | Segmented hashing by stable slots; the header stores only sectionId references. |
| Body | Does not duplicate event writes; joined from the currently loaded transcript window by stable messageId / turn / step. |
| Desktop live | The recorder synchronously publishes to a local bounded live store. |
| Web live | `ChatEvent(type=trajectory)` is split off before the transcript seq gate and deduplicated by event identity. |
| Disconnect recovery | After the connection goes false→true, re-fetch the latest `trajectory.fetch` window and idempotently merge with live data. |
| Legacy sessions | Derive structure by degrading from messages; do not fabricate times. |
| Persistence | Events go with `chatHistorySegment`; Prompt segments are stored in `chatTrajectorySection`. |
| History lifecycle | Branching, edit-resend, truncation, and session deletion all handle trajectory and segment references in sync. |
| Subagent | Events record only runId; the view reads targeted, batched runIds actually referenced. |
| Mount point | GUI and WebUI share the "Conversation / Trajectory" tab and the same set of shared components. |

## Layering

```text
crates/agent-ui/src/lib/trajectory/
  types.ts             wire format, ledger, visual record types
  sections.ts          Prompt segmentation, content hashing, exact reconstruction
  eventLog.ts          event stream → normalized ledger
  contentIndex.ts      loaded body → turn/step/call index
  fromMessages.ts      legacy session degradation derivation
  layout.ts            ledger + body + subagent → visual records
  timeline.ts          sequence / duration three-lane projection
  liveStore.ts         idempotent, bounded, LRU live event cache
  searchIndex.ts       search index
  subagentRuns.ts      subagent message skeleton parsing

crates/agent-ui/src/components/trajectory/
  TrajectoryView.tsx   data convergence and view shell
  TrajectoryTimeline   timeline
  TrajectoryTable      virtualizable list
  details/*            detail tabs

crates/agent-gui/src/lib/trajectory/
  recorder.ts          main runtime instrumentation
  recorderRegistry.ts  cross-turn recorder lifecycle
  persistenceQueue.ts  batched, sequential persistence
  liveTrajectory.ts    desktop-side local live bridge

crates/agent-gui/src-tauri/src/commands/history/chat_history/
  trajectory.rs            event and Prompt segment persistence
  trajectory_window.rs     segment window reads
  trajectory_lifecycle.rs  branch / edit-resend trimming
  trajectory_subagents.rs  targeted subagent batch reads

crates/agent-gateway/web/src/lib/trajectory/
  liveTrajectory.ts    WebUI live splitting and caching
```

Shared pure logic does not depend on Tauri or the Gateway; the differences between the two sides are injected only through the `TrajectoryHost` capability object.

## Event Model

Events are compact JSON. `k` is the discriminant, `at` is Unix milliseconds, `t` is the absolute turn, and `s` is the provider step.

| `k` | Payload | Semantics |
|---|---|---|
| `user` | `t, at, mi?, id?, tx?` | Opens a turn. `mi` is the whole-session messageIndex, `id` is the stable message ID. |
| `context` | `t, at, src?, tx?` | Dynamic context injection; `tx` stores only a bounded preview, full text goes to a runtime section. |
| `header` | `at, hid, sec, ch, prev?` | Prompt / tool snapshot at the request boundary. |
| `step_start` | `t, s, at, hid?` | A real provider request begins. |
| `first_token` | `t, s, at` | First model-side output: text, thinking, tool call/delta, hosted search, or final-only assistant. |
| `step_end` | `t, s, at, st, u?, p?, m?, api?, sr?, err?` | Request end and actual provider/model/api. |
| `retry` | `t, s, at, n, max?, delay?, err?` | Retry of the same request. |
| `tool_start` | `t, s, at, id, n, a?` | The tool actually begins executing; the parameter is a bounded preview. |
| `tool_end` | `at, id, err?, sum?, run?` | Tool terminal state; `run` is the derived subagent runId. |
| `compaction_start` | `t, at` | Context compaction begins; `t=null` means manual compaction between turns. |
| `compaction_end` | `t, at, st, before?, after?, err?` | Compaction terminal state and before/after token values. |
| `turn_end` | `t, at, st, err?` | Turn terminal state. |

`st` is `running | complete | error | aborted`. Events only add fields; they do not change the semantics of old fields.

### Why user stores both `mi` and `id`

A tail history window may load only the messages after real Turn 93. If user messages were re-counted only from the current array, the body would incorrectly start at Turn 1. Now the body preferentially aligns using the stable `messageId` and the absolute turn in the event. Early development versions stored only the whole-session `mi`; when reading a trajectory window, SQLite looks up the stable message ID matching the historical body across segments by global index, then hands the enhanced events to the shared UI. The UI `messageRef.messageIndex` cannot be used directly, because it is a segment-local index.

## Prompt Segmentation and Legacy Data Compatibility

The slot order in the wire format is already persisted, so it can only be appended at the end, never reordered:

| Wire format index | Slot | Source |
|---:|---|---|
| 0 | `base` | Session base System Prompt. |
| 1 | `agent` | Current Agent Prompt. |
| 2 | `skills` | Skills Prompt. |
| 3 | `memory` | Memory Prompt. |
| 4 | `toolsSuffix` | Tool operating rules appended at the provider boundary. |
| 5 | `toolCatalog` | Serialized tool schema; it is a request parameter and does not enter the System Prompt string. |
| 6 | `runtime` | Dynamic runtime context such as roster, parent message bus, and current run task-list. |

Legacy records have only the first six items; when read, items 4/5 are still `toolsSuffix/toolCatalog` respectively. `runtime` is appended as item 6, ensuring legacy data is not misaligned.

The Prompt reconstruction order the model actually sees is:

```text
base → agent → skills → memory → runtime → toolsSuffix
```

Core segments use the chat context builder's `trim + "\n\n"` rule; `toolsSuffix` uses the provider boundary rule for appending. Before each request these segments are reconstructed and compared character by character with `context.systemPrompt`. If an unsectioned injection is added in the future and causes a mismatch, the recorder will warn and save the exact full text at the provider boundary as a diagnostic fallback, rather than displaying a Prompt that looks complete but is actually wrong.

sectionId is:

```text
s_ + first 16 hex characters of sha256(content)
```

Segment content is isolated per session, and is reclaimed in bulk via foreign keys when a session is deleted.

## Persistence and Migration

The history database schema version is **v3**. Upgrading from an existing v2 idempotently fills in:

```sql
ALTER TABLE chatHistorySegment
  ADD COLUMN trajectory_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE chatHistorySegment
  ADD COLUMN trajectory_truncated INTEGER NOT NULL DEFAULT 0;
```

and creates:

```sql
CREATE TABLE IF NOT EXISTS chatTrajectorySection (
  conversation_id TEXT NOT NULL,
  section_id      TEXT NOT NULL,
  slot            TEXT NOT NULL,
  content         TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, section_id),
  FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
);
```

Key principles:

- The trajectory segment must already exist; append will not secretly create an orphan segment;
- A single segment is capped at 8 MiB of events; on hitting the cap, existing events are retained and a truncated flag is persisted;
- A single section is capped at 1 MiB; an oversized section may be diagnostically degraded without affecting chat;
- Section writes validate SHA-256 content addressing and valid slots;
- When reading a single corrupted segment, only that window is marked incomplete; the remaining segments are still returned;
- Branching copies only the sections referenced by the retained prefix; edit-resend cleans up sections that lose their references.

## Body Joining

The event stream deliberately does not duplicate assistant bodies, full tool output, and attachment binaries. The trajectory view builds from the loaded transcript window:

- `userByTurn`
- `assistantByStep(turn, step)`
- `toolByCallId`

Stable message IDs map the tail window back to absolute turns; tools align by callId. When paginating forward, the visual `index` changes, but `recordId` is composed of business identity, so selection, React keys, and collapse state do not jump wrongly when history is prepended.

Multiple context/input entries produced in the same millisecond no longer use only the timestamp as ID; instead they combine turn, messageId/messageIndex, source, text, and ordinal to avoid detail mappings overwriting each other.

## Live Path and Disconnect Convergence

### Desktop

Each recorder emit simultaneously:

1. Enters the sequential persistence queue;
2. Publishes to the desktop local live store;
3. Enters chat ingress when the Gateway is available.

So while the trajectory page stays open, steps, tools, and compactions appear immediately, without switching sessions to remount.

### WebUI

Trajectory events are not part of the chat transcript. They are split off before the transcript's `lastSeq` dedup gate, because runtime snapshots do not include trajectories; if the transcript cursor were advanced first, low-seq trajectory events in a disconnect replay would be mistakenly deleted.

The live store uses the complete normalized event as identity, so exact replay is a no-op. Resource limits are:

- At most 20,000 live events per session;
- At most 100,000 globally;
- At most 64 session buckets;
- On overflow, trim old events per session and reclaim via global LRU.

After a connection recovers from disconnect, the Web Host triggers `TrajectoryView` to re-read the latest tail `trajectory.fetch` window; the current view is retained during the request, and on success the persisted tail is replaced with the authoritative window, then idempotently merged with live events. A failed re-fetch only marks incomplete and does not clear the last usable diagnostic data.

## Compaction Instrumentation

The four compaction paths pre-send, mid-stream, post-tool, and manual all go through the `CompactionController` observer:

- `publishRunning` is the single start point;
- `settleCompleted` / `settleFailed` / abort teardown are the end points;
- Each start corresponds strictly to one `complete | error | aborted` terminal state;
- User cancellation, forced unbinding, and a late summarizer completion do not produce duplicate terminal states;
- `tokensBefore/tokensAfter` are cleared after the terminal state and cannot pollute the next compaction.

The observer is a diagnostic channel; a throwing callback does not affect the main compaction path.

## Subagent

The main event stream stores the runId only in the parent tool's `tool_end.run`, and does not carry full subagent messages.

The trajectory view scans the runIds actually referenced by the current ledger and requests only those not yet loaded:

- The Web Host batches at most 128 IDs;
- The backend handles at most 256 unique IDs per request;
- The backend is scoped by parent conversation and batch-reads run headers and segments with two SQL queries;
- The return order matches the request ID order;
- Missing runs are skipped and do not mix in same-named/adjacent runs from other sessions;
- It no longer depends on the "most recent 64 runs" list interface, and there is no N+1 `load`.

The layout layer still receives only pure `subagentRuns` data and expands it into SUBTOOL rows.

## File Navigation

Markdown file links and user attachments in details reuse ReactorPro's existing `ChatFileLink` secure navigation path:

- Only structured `path/source/line/endLine/column` is passed;
- Relative paths resolve in the current session workdir;
- Desktop and WebUI use the same open, preview, and file-tree reveal behavior as the chat body;
- When the host does not provide `openFileLink`, attachment details remain read-only and do not render fake interactions.

## UI

| Component | Responsibility |
|---|---|
| `ConversationViewTabs` | Conversation / Trajectory switching. |
| `TrajectoryToolbar` | Duration, Turn/Call collapse, search. |
| `TrajectoryTimeline` | Input / Model / Tools three lanes. |
| `TrajectoryTable` | Long-list virtualization, selection, and focus. |
| `DetailsPanel` | System Prompt, tool catalog, diff, input/output, timing, usage, raw data, and other details. |

Projection modes:

- `sequence`: equal width per record, showing structural order;
- `duration`: widths by real elapsed time, compressing idle intervals covered by no operation.

Assistant blocks are segmented internally by the TTFT-to-decoding ratio; legacy sessions without reliable times are forced to use sequence.

## Legacy Session Degradation

When there are no real trajectory events, `fromMessages.ts` derives turn, step, tool, and usage from loaded messages. All time fields remain `null`; message timestamp differences are not used to fabricate tool or model durations.

After upgrading an old session, a mixed history of "old turns with no events, new turns with events" may appear. The view uses the first/subsequent stable messageId anchors to back-derive the absolute turn of visible old turns, and fills in degraded structure only for turns not covered by events; turns with events always take the real ledger as authoritative. Clicking "Load earlier trajectory" also requests the corresponding chat history body at the same time, avoiding an event skeleton with empty details. In this case Duration can still show the portions with real times, but the UI clearly indicates that old operations were omitted.

Available capabilities: structure, body, search, collapse, tool details. Unavailable capabilities: real Duration, TTFT, throughput, and System Prompt history snapshots.

## Errors and Degradation

| Scenario | Behavior |
|---|---|
| recorder / observer throws | Capture and warn; the main chat path continues. |
| Corrupted segment JSON | Drop only that segment and mark the window incomplete. |
| section fetch fails | The current details tab shows retry; other views work normally. |
| section missing/oversized | Keep the event skeleton; details show as unavailable. |
| turn / tool / compaction cancelled | Converge to `aborted`; do not leave running hanging. |
| WebUI replay overlaps persisted | Double-layer idempotent dedup in the live store and ledger. |
| WebUI connection restored | Reconcile with the latest `trajectory.fetch` window. |
| Current window lacks early body | Align the loaded portion by messageId; it fills in naturally after paginating forward. |

## Test Matrix

### TypeScript / Node

- Event out-of-order, duplicate, corrupted, tool_end arriving first, compaction pairing;
- Body alignment for the tail window of absolute Turn 93;
- Unique input recordId within the same millisecond;
- Legacy six-slot compatibility and exact seven-slot Prompt reconstruction;
- runtime context, tool-first TTFT, DeepSeek failover metadata;
- compaction abort exactly-once;
- Web low-seq replay still enters the trajectory; exact replay is idempotent;
- live store per-session/global/LRU limits;
- 300 subagent IDs split into 128/128/44;
- Attachment structured file targets and details click callbacks;
- Timeline, search, collapse, virtualization, details rendering.

### Rust / SQLite

- New database and v2→v3 migration;
- Append order, corrupted segment isolation, capacity limits;
- Section content addressing, session isolation, deletion reclamation;
- Branch/edit-resend trajectory trimming;
- Segment window pagination;
- Targeted batch reads of 70 subagent runs, parent session isolation, request order, dedup, missing IDs, and the 256 limit.

## Verification Gates

```text
pnpm build:gui
pnpm build:webui
pnpm lint:ui
pnpm lint:gui
pnpm lint:webui
pnpm test:gui
pnpm test:webui
pnpm check:ui-boundaries
cargo test / cargo check (when system dependencies are available)
go build ./...
go test ./...
make proto-check
git diff --check
```

A full Tauri crate also needs native dependencies such as the system `dbus-1` development package on Linux CI/servers; the pure trajectory SQLite harness can verify migration and the data layer without linking GUI system libraries.
## Implemented release invariants

The production implementation additionally enforces the following invariants discovered during integration testing:

- Existing `user_version = 2` databases migrate to schema v3 before any trajectory command runs; the migration adds both segment event columns and the content-addressed section table atomically.
- Transcript bodies and trajectory events use independent lazy windows. Body joins align the visible transcript tail to absolute ledger turn numbers instead of restarting at Turn 1.
- Desktop recorder events feed a bounded local live store. WebUI splits trajectory frames before the transcript sequence cursor. Both surfaces quietly reconcile against the persisted SQLite tail after terminal events, edit-resend rebases, and WebUI reconnects.
- Every compaction observer start has exactly one `complete`, `error`, or `aborted` end. A user cancellation never leaves a running interval behind.
- Prompt sections are accepted only when they reconstruct the exact sanitized provider request. Dynamic roster, message-bus, and task-list injections are folded into the final memory/runtime section; any future mismatch falls back to one exact content-addressed base section rather than displaying an approximate prompt.
- The first assistant-side output can be text, thinking, hosted search, or a tool-call delta. All four close TTFT through the same idempotent first-token marker.
- Provider/model/API metadata comes from the committed assistant response, so failover rounds identify the target that actually answered.
- Record identity is independent of display index and disambiguates same-millisecond context events. Edit-resend clears live tails only after the database rebase succeeds and then forces an authoritative reload.