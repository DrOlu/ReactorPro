# Durable task progress

## Goal

ReactorPro's task checklist must belong to the current Agent Run, not to the frontend process or to a segment of model context. Within a single Run, no matter how many context compactions occur, the IDs, order, content, and status of tasks remain stable; they are cleared only when the next user message starts a new Run.

## Authoritative state

| Layer | Design |
|---|---|
| Tool protocol | `TaskCreate` creates a single task, `TaskUpdate` updates by stable `taskId`, `TaskList` returns a complete snapshot; there is no whole-table replacement interface. |
| Identity | The executor assigns monotonically increasing numeric IDs via `nextTaskId`; the model cannot specify or reuse an ID. |
| Concurrency | The three task tools share a serial queue, avoiding duplicate ID assignment when the same tool creates tasks concurrently in one turn. |
| Persistence | `TaskListState` is written to `StoredChatContextMeta.taskList` and atomically persisted alongside the existing `context_meta_json` and compaction checkpoints; task commits go through the non-terminal persistence channel, and a mid-flight disk write failure belongs only to that tool call and must not report a successfully completed Run as `history_persist_failed`. |
| Compaction recovery | Every model request dynamically injects the same authoritative `runId/revision/tasks` JSON from the current session state, rather than recovering tasks from a free-text summary; injection is gated by `runId` on the same terms as the tools, and state from a different Run is treated as nonexistent. |
| Run boundary | `useSendChatTurn` clears the previous Run's `taskList` before appending a new user message; the historical state restored by edit-resend is likewise cleared; compaction, tool turns, and mid-stream recovery do not clear it. |
| Checkpoint transaction | When appending a new Segment, the just-sealed previous active Segment is first refreshed within the same SQLite transaction, then the new Segment with its summary is inserted, ensuring tool messages, task state, and the total message count advance in sync. |

## UI projection

The GUI and Gateway WebUI read only the complete canonical snapshot from successful `TaskCreate`, `TaskUpdate`, and `TaskList` results. The projection does not read streaming arguments, does not guess identity from text or position, and performs no delayed-sequence compatibility. Task tool blocks remain standalone in the transcript and are uniformly hidden, and the progress indicator above the input box uses `task.id` as its React key.

The indicator permanently hosts only one content-shrinking step pill; the task checklist is an absolutely positioned hover overlay that collapses when the pointer leaves or focus departs, so in any state it occupies no transcript layout height and does not participate in the composer's height reservation.

## Invariants

| Invariant | How it is guaranteed |
|---|---|
| Compaction cannot create a new plan | The authoritative state lives in session metadata; compaction summaries do not own the task lifecycle. |
| An update cannot change another task's identity | `TaskUpdate` must provide an existing `taskId` and modifies only the explicitly given fields. |
| At most one in-progress task | The executor rejects updates that would produce more than one `in_progress`. |
| A successful tool must be recoverable | Persist first, apply to runtime state only after success; on failure the state was never changed and an error is returned directly. |
| Corrupt data does not block the session | A failed parse of a historical `taskList` is downgraded to a drop with a warning, and must never prevent the entire session window from opening. |
| A successful compaction must already be persisted | When checkpoint persistence returns `false`, it is treated as a compaction failure, and switching the runtime Segment or publishing the checkpoint is forbidden. |
| Consistent display across both clients | The shared `taskProgress.ts` accepts only canonical result details, and the GUI/WebUI use the same projection and components. |

## Verification

- Task tool tests cover schema, stable IDs, concurrent creation, update by ID, a single in-progress task, read-only listing, and persistence failure.
- History tests cover strict parsing and recovery of task state in `context_meta_json`, and degradation of a corrupt task list to a drop without blocking the window from opening.
- Compaction controller tests cover that `runId/revision/tasks` are fully identical after two consecutive checkpoints.
- History persistence tests cover the checkpoint atomically refreshing the sealed segment and appending a new segment, and not switching the runtime Segment when persistence is rejected.
- GUI/WebUI projection tests cover successful-result priority, ignoring partial arguments/failed results, user Run boundaries, and transcript filtering.
- Full frontend tests for both GUI and WebUI, TypeScript for both clients, production builds, image checks, and UI boundary checks are all merge gates.