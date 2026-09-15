package mesh

// Task execution and the task skills.
//
// The executor side lives here: an async invoke becomes a Task record, the
// run happens on a background context the caller has no hold over, and every
// transition is persisted and published as a state-only event. The caller side
// (stubs, refresh, cancel-by-dispatch) is here too, because both sides share
// the store and the state machine, and keeping them apart would mean exporting
// the internals.
//
// Two invariants do most of the work:
//
//   - The caller identity on a task comes from the guard (meta.From /
//     meta.CallerFingerprint), never from the payload. A task is only ever
//     readable by the identity that created it; another caller asking for the
//     same task id gets "not found", because existence of another tenant's
//     task is itself information.
//   - Terminal writes re-read the current state and refuse illegal
//     transitions, so a run finishing concurrently with a cancel can never
//     overwrite a canceled task with "completed".

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/observability"
)

// taskRunTimeout returns how long one background task may run. A caller may
// narrow it (input timeout_ms, as with synchronous invoke) but never extend
// it: how long this edge is willing to hold work open is the edge's decision.
func (m *Manager) taskRunTimeout(request InvokeInput) time.Duration {
	config := m.Config()
	timeout := config.TaskMaxRuntime
	if timeout <= 0 {
		timeout = DefaultTaskMaxRuntime
	}
	if request.TimeoutMS > 0 {
		if requested := time.Duration(request.TimeoutMS) * time.Millisecond; requested < timeout {
			timeout = requested
		}
	}
	return timeout
}

// mintTaskID returns a task id for callers that did not bring one.
func mintTaskID() string { return newID() }

// startAsyncTask records a queued task and launches its run.
//
// The store is load-bearing here: with no store configured the task cannot be
// promised to anyone, so the create fails rather than returning a handle that
// no one — including this edge — could honour.
func (m *Manager) startAsyncTask(request InvokeInput, meta RequestMeta, agent LocalAgent) (TaskHandle, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return TaskHandle{}, coded(CodeInternalError,
			"this edge has no task store configured; it cannot accept async tasks")
	}
	taskID := strings.TrimSpace(request.TaskID)
	if taskID == "" {
		taskID = mintTaskID()
	}
	if err := validateTaskID(taskID); err != nil {
		return TaskHandle{}, coded(CodeInvalidEnvelope, "%v", err)
	}

	// Idempotency, which is the reason the id is caller-minted: a retried
	// CREATE returns the task that already exists instead of running the work
	// a second time. This is what makes async invoke retry-safe where the
	// mailbox's at-least-once redelivery made it dangerous.
	if existing, ok, err := store.GetTask(meta.From, taskID); err != nil {
		return TaskHandle{}, coded(CodeInternalError, "task store lookup failed: %v", err)
	} else if ok {
		return handleFor(existing), nil
	}

	now := time.Now().UTC()
	traceID := ""
	if meta.Trace != nil {
		// A trace is optional on the wire; an envelope without one must not
		// break the task record.
		traceID = meta.Trace.TraceID
	}
	task := Task{
		TaskID:            taskID,
		Caller:            meta.From,
		CallerFingerprint: meta.CallerFingerprint,
		Agent:             agent.ID,
		Operation:         request.Operation,
		Arguments:         request.Arguments,
		State:             TaskQueued,
		TraceID:           traceID,
		Stream:            request.Stream,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := store.SaveTask(task); err != nil {
		return TaskHandle{}, coded(CodeInternalError, "task store write failed: %v", err)
	}
	observability.Usage.MeshTaskCreatedTotal.Add(1)
	m.publishTaskEvent(task)

	// Streaming is a task property: register the emitter before the run
	// starts so the very first growth delta has somewhere to go.
	if request.Stream {
		m.startTaskStream(meta.From, taskID)
	}

	runCtx, cancel := context.WithTimeout(context.Background(), m.taskRunTimeout(request))
	m.mu.Lock()
	if m.taskRuns == nil {
		m.taskRuns = map[string]context.CancelFunc{}
	}
	m.taskRuns[taskKey(meta.From, taskID)] = cancel
	m.mu.Unlock()

	go m.executeTask(runCtx, task)
	return handleFor(task), nil
}

// rejectAsyncTask records a task that failed a gate before it could run, so
// the caller holds a durable rejection rather than a vanishing error string.
func (m *Manager) rejectAsyncTask(request InvokeInput, meta RequestMeta, code int, reason string) (TaskHandle, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return TaskHandle{}, coded(code, "%s", reason)
	}
	taskID := strings.TrimSpace(request.TaskID)
	if taskID == "" {
		taskID = mintTaskID()
	}
	if err := validateTaskID(taskID); err != nil {
		return TaskHandle{}, coded(code, "%s", reason)
	}
	if existing, ok, err := store.GetTask(meta.From, taskID); err == nil && ok {
		return handleFor(existing), nil
	}
	now := time.Now().UTC()
	task := Task{
		TaskID:       taskID,
		Caller:       meta.From,
		State:        TaskRejected,
		ErrorCode:    fmt.Sprintf("%d", code),
		ErrorMessage: reason,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := store.SaveTask(task); err != nil {
		m.logger.Warn("could not persist a rejected task", "task", taskID, "error", err)
		return TaskHandle{}, coded(code, "%s", reason)
	}
	m.publishTaskEvent(task)
	return handleFor(task), nil
}

// executeTask runs one task to a terminal state on its own background context.
func (m *Manager) executeTask(runCtx context.Context, task Task) {
	key := taskKey(task.Caller, task.TaskID)
	defer func() {
		m.mu.Lock()
		delete(m.taskRuns, key)
		m.mu.Unlock()
	}()

	if err := m.transitionTask(task.Caller, task.TaskID, TaskWorking, nil); err != nil {
		// The move to working was refused: the task was canceled (or already
		// terminal) between create and start, so the run never begins.
		return
	}
	if err := runCtx.Err(); err != nil {
		m.finishTask(task, TaskFailed, "deadline", "the task's runtime budget expired before the run started")
		return
	}

	invoker := m.localInvokerSnapshot()
	if invoker == nil {
		m.finishTask(task, TaskFailed, "no-invoker", "no local agent invoker is configured on this edge")
		return
	}
	arguments := task.Arguments
	if len(arguments) == 0 {
		arguments = json.RawMessage("null")
	}
	timeout := m.taskRunTimeout(InvokeInput{})
	// The live view: a task that opted into streaming feeds the transport's
	// growth deltas into its emitter. The emitter coalesces and publishes; the
	// terminal chunk is closed by finishTask, so every stream ends exactly once.
	var progress func(string)
	if stream := m.taskStreamFor(task.Caller, task.TaskID); stream != nil {
		progress = func(delta string) {
			stream.feed(delta, func(seq int, text string, last bool) {
				m.emitTaskChunk(task.Caller, task.TaskID, seq, text, last)
			})
		}
	}
	result, err := invoker.InvokeLocalAgent(runCtx, LocalInvokeRequest{
		AgentID:           task.Agent,
		TaskID:            task.TaskID,
		Caller:            task.Caller,
		CallerFingerprint: task.CallerFingerprint,
		Operation:         task.Operation,
		Arguments:         arguments,
		Timeout:           timeout,
		Progress:          progress,
	})

	switch {
	case runCtx.Err() != nil:
		// The context ended: canceled by the caller, or the budget expired.
		// The state is already terminal (canceled or failed by whoever ended
		// it) — finishTask refuses to overwrite a terminal task, so this is
		// at most a harmless no-op.
		m.finishTask(task, TaskFailed, "timeout", "the task's runtime budget expired")
	case err != nil:
		code, reason := "5001", err.Error()
		var refusal *codedError
		if errors.As(err, &refusal) {
			code, reason = fmt.Sprintf("%d", refusal.code), refusal.reason
		}
		m.finishTask(task, TaskFailed, code, reason)
	case !result.OK:
		m.finishTask(task, TaskFailed, result.ErrorCode, strings.TrimSpace(result.ErrorMessage))
	default:
		m.finishTask(task, TaskCompleted, "", "", result.Result)
	}
}

// transitionTask moves a task to a non-terminal state, refusing illegal moves.
// Returns nil when the transition happened.
func (m *Manager) transitionTask(caller, taskID string, to TaskState, mutate func(*Task)) error {
	store := m.taskStoreSnapshot()
	if store == nil {
		return errors.New("no task store")
	}
	m.taskMu.Lock()
	defer m.taskMu.Unlock()
	task, ok, err := store.GetTask(caller, taskID)
	if err != nil || !ok {
		return fmt.Errorf("task %q not found", taskID)
	}
	if !CanTransitionTask(task.State, to) {
		return ErrTaskState
	}
	task.State = to
	task.UpdatedAt = time.Now().UTC()
	if mutate != nil {
		mutate(&task)
	}
	if err := store.SaveTask(task); err != nil {
		return err
	}
	m.publishTaskEvent(task)
	return nil
}

// finishTask writes a terminal state. Every terminal write re-reads the task
// under the task lock and refuses an illegal transition, so a run completing
// after a cancel lands on "canceled", not "completed" — the cancel already
// decided the outcome, and the late result is not allowed to un-decide it.
func (m *Manager) finishTask(task Task, to TaskState, errorCode, errorMessage string, result ...json.RawMessage) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return
	}
	m.taskMu.Lock()
	current, ok, err := store.GetTask(task.Caller, task.TaskID)
	m.taskMu.Unlock()
	if err != nil || !ok {
		m.logger.Warn("task vanished before it could be finished", "task", task.TaskID)
		return
	}
	if !CanTransitionTask(current.State, to) {
		return
	}
	current.State = to
	current.UpdatedAt = time.Now().UTC()
	current.ErrorCode = errorCode
	current.ErrorMessage = errorMessage
	if len(result) == 1 {
		current.Result = result[0]
	}
	m.taskMu.Lock()
	err = store.SaveTask(current)
	m.taskMu.Unlock()
	if err != nil {
		m.logger.Warn("could not persist a finished task", "task", task.TaskID, "error", err)
		return
	}
	switch to {
	case TaskCompleted:
		observability.Usage.MeshTaskCompletedTotal.Add(1)
	case TaskFailed:
		observability.Usage.MeshTaskFailedTotal.Add(1)
	case TaskCanceled:
		observability.Usage.MeshTaskCanceledTotal.Add(1)
	}
	m.publishTaskEvent(current)
	// A stream ends exactly once, on the same transition that ended the task:
	// the completed case closes it with the result's tail; every other
	// terminal closes it without content. A listener that saw the last chunk
	// never waits for a state event that may not be the one it gets.
	if to == TaskCompleted {
		// The invoker's result is {"text": ...}; the canonical text is what the
		// terminal chunk must extend.
		resultText := ""
		if len(current.Result) > 0 {
			var decoded struct {
				Text string `json:"text"`
			}
			if json.Unmarshal(current.Result, &decoded) == nil {
				resultText = decoded.Text
			}
		}
		m.closeTaskStream(current.Caller, current.TaskID, resultText)
	} else {
		m.closeTaskStream(current.Caller, current.TaskID, "")
	}
}

// publishTaskEvent announces a state change. State only — never the result:
// events are broadcast to whoever subscribes, and a task's output belongs to
// the caller that created it.
func (m *Manager) publishTaskEvent(task Task) {
	agent, err := m.requireAgent()
	if err != nil {
		return
	}
	event := taskEvent{
		TaskID:       task.TaskID,
		Caller:       task.Caller,
		State:        task.State,
		UpdatedAt:    task.UpdatedAt,
		ErrorCode:    task.ErrorCode,
		ErrorMessage: task.ErrorMessage,
	}
	if err := agent.Emit(context.Background(), "task."+task.TaskID, event); err != nil {
		m.logger.Warn("could not publish a task state event", "task", task.TaskID, "error", err)
	}
}

// cancelTask stops a running task and marks it canceled. Idempotent: a
// cancel of an already-terminal task reports the task's real state instead
// of erroring, because a retried cancel is normal usage.
func (m *Manager) cancelTask(caller, taskID string) (Task, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return Task{}, coded(CodeInternalError, "this edge has no task store configured")
	}
	m.taskMu.Lock()
	task, ok, err := store.GetTask(caller, taskID)
	if err != nil || !ok {
		m.taskMu.Unlock()
		return Task{}, coded(CodeSkillNotFound, "no task %q for this caller", taskID)
	}
	if TaskTerminal(task.State) {
		m.taskMu.Unlock()
		return task, nil
	}
	task.State = TaskCanceled
	task.UpdatedAt = time.Now().UTC()
	if err := store.SaveTask(task); err != nil {
		m.taskMu.Unlock()
		return Task{}, coded(CodeInternalError, "task store write failed: %v", err)
	}
	m.taskMu.Unlock()

	m.mu.Lock()
	cancel := m.taskRuns[taskKey(caller, taskID)]
	delete(m.taskRuns, taskKey(caller, taskID))
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	observability.Usage.MeshTaskCanceledTotal.Add(1)
	m.publishTaskEvent(task)
	return task, nil
}

// TaskSkills returns the ids of the task skills this edge serves, in a stable
// order for manifests and tests.
func TaskSkills() []string { return []string{SkillTaskGet, SkillTaskCancel, SkillTaskRetry} }

// skillTaskGet serves task.get: the creating caller's task, and nobody else's.
//
// An optional tail ({"task_id": ..., "tail": 20}) returns the task plus its
// recent chunk tail — how a reconnecting client catches up on a streaming
// task without having been subscribed at the time.
func (m *Manager) skillTaskGet(_ context.Context, input any, meta RequestMeta) (any, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return nil, coded(CodeInternalError, "this edge has no task store configured")
	}
	taskID, tail, err := taskInputFrom(input)
	if err != nil {
		return nil, err
	}
	task, ok, err := store.GetTask(meta.From, taskID)
	if err != nil {
		return nil, coded(CodeInternalError, "task store lookup failed: %v", err)
	}
	if !ok {
		// Caller-scoped on purpose: another caller's task is indistinguishable
		// from a nonexistent one, because its existence is that caller's
		// information to give, not this one's to take.
		return nil, coded(CodeSkillNotFound, "no task %q for this caller", taskID)
	}
	if tail > 0 {
		return TaskWithChunks{Task: task, Chunks: m.taskTail(meta.From, taskID, tail)}, nil
	}
	return task, nil
}

// skillTaskCancel serves task.cancel, gated to the creating caller.
func (m *Manager) skillTaskCancel(_ context.Context, input any, meta RequestMeta) (any, error) {
	taskID, _, err := taskInputFrom(input)
	if err != nil {
		return nil, err
	}
	task, err := m.cancelTask(meta.From, taskID)
	if err != nil {
		return nil, err
	}
	return task, nil
}

// skillTaskRetry serves task.retry: the creating caller re-runs its own failed
// or canceled task. Same isolation as the other task skills — another caller
// asking for the same id is told it does not exist.
func (m *Manager) skillTaskRetry(_ context.Context, input any, meta RequestMeta) (any, error) {
	taskID, _, err := taskInputFrom(input)
	if err != nil {
		return nil, err
	}
	return m.RetryTask(meta.From, taskID)
}

// taskInputFrom reads the shared shape of the task skills: a task id, and for
// task.get an optional chunk-tail length.
func taskInputFrom(input any) (taskID string, tail int, err error) {
	if input == nil {
		return "", 0, coded(CodeInvalidEnvelope, "the task skills require an input object with a task_id")
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return "", 0, coded(CodeInvalidEnvelope, "task input is not encodable: %v", err)
	}
	var parsed struct {
		TaskID string `json:"task_id"`
		Tail   int    `json:"tail"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", 0, coded(CodeInvalidEnvelope, "task input is malformed: %v", err)
	}
	taskID = strings.TrimSpace(parsed.TaskID)
	if taskID == "" {
		return "", 0, coded(CodeInvalidEnvelope, "a task_id is required")
	}
	if parsed.Tail < 0 || parsed.Tail > taskChunkRingMax {
		parsed.Tail = 0
	}
	return taskID, parsed.Tail, nil
}

// pendingTaskEvent is a task state event that out-ran the stub it belongs to.
type pendingTaskEvent struct {
	event   taskEvent
	arrived time.Time
}

// pendingEventTTL bounds how long an unmatched event is remembered. It only
// needs to cover the create→save window (milliseconds); two minutes is a
// hundredfold margin, and the constant exists so the map cannot grow forever.
const pendingEventTTL = 2 * time.Minute

// pendingEventCap bounds the buffer. The window it exists for is the
// create→save race (microseconds), so a few hundred slots is generous; the
// cap exists because the ids are chosen by senders, and a flooding peer must
// not be able to grow the map even inside the TTL.
const pendingEventCap = 512

// stashPendingTaskEvent records an event whose stub does not exist yet.
func (m *Manager) stashPendingTaskEvent(update taskEvent) {
	m.taskMu.Lock()
	defer m.taskMu.Unlock()
	if m.taskPendingEvents == nil {
		m.taskPendingEvents = map[string]pendingTaskEvent{}
	}
	// Prune aged entries on the way in: insert-time pruning is enough because
	// events keep arriving in any live system, and a dormant one leaks at most
	// the events that arrived after its last insert.
	for id, entry := range m.taskPendingEvents {
		if time.Since(entry.arrived) > pendingEventTTL {
			delete(m.taskPendingEvents, id)
		}
	}
	if len(m.taskPendingEvents) >= pendingEventCap {
		return
	}
	m.taskPendingEvents[update.TaskID] = pendingTaskEvent{event: update, arrived: time.Now().UTC()}
}

// drainPendingTaskEvent returns and clears the buffered event for a task, if
// one arrived before the stub was saved.
func (m *Manager) drainPendingTaskEvent(taskID string) (taskEvent, bool) {
	m.taskMu.Lock()
	defer m.taskMu.Unlock()
	entry, ok := m.taskPendingEvents[taskID]
	if ok {
		delete(m.taskPendingEvents, taskID)
	}
	return entry.event, ok
}

// handleFor projects a task into the small reply a CREATE returns.
func handleFor(task Task) TaskHandle {
	note := "the task continues whether or not the caller stays connected; " +
		"query it with the task.get skill, or watch mesh.event.task." + task.TaskID
	if task.Stream {
		note += " and mesh.event.task." + task.TaskID + ".chunk for the streamed answer"
	}
	return TaskHandle{
		TaskID:    task.TaskID,
		State:     task.State,
		CreatedAt: task.CreatedAt,
		GetTask:   SkillTaskGet,
		Note:      note,
	}
}

// taskKey scopes the running-task registry the same way the store scopes
// records, so two callers using the same task id cannot cancel each other's
// runs.
func taskKey(caller, taskID string) string { return caller + "\x00" + taskID }

// ── caller side ────────────────────────────────────────────────────────────

// CreateRemoteTaskParams is one async CREATE addressed to a peer.
type CreateRemoteTaskParams struct {
	// Target is the peer's mesh agent id.
	Target string
	// Skill defaults to invoke; kept explicit so a caller can address a
	// peer's non-invoke entry point later without a protocol change.
	Skill string
	// Input is the skill's argument (an InvokeInput for a ReactorPro edge;
	// anything the peer understands otherwise).
	Input map[string]any
	// TaskID is caller-minted; empty mints one here.
	TaskID string
	// Stream opts the task into chunked streaming on the peer.
	Stream bool
	// NotifyURL is where the terminal state is POSTed, signed. Local operator
	// input only — never carried to the peer, never read from a remote
	// invoke's input, because a peer-supplied URL would be a request-forgery
	// vector. Empty falls back to the gateway's -mesh-task-webhook default.
	NotifyURL string
	// CreateTimeout bounds only the handle reply, not the run.
	CreateTimeout time.Duration
}

// CreateRemoteTask dispatches an async invoke and records a stub.
//
// Backward compatibility is the interesting part: a peer that has not adopted
// tasks answers the old way, with the finished result in one reply. That
// reply becomes an immediately-completed stub, so the caller always gets a
// task object no matter what the peer runs.
func (m *Manager) CreateRemoteTask(ctx context.Context, params CreateRemoteTaskParams) (TaskStub, error) {
	if strings.TrimSpace(params.Target) == "" {
		return TaskStub{}, coded(CodeInvalidEnvelope, "a remote task needs a target peer")
	}
	skill := params.Skill
	if skill == "" {
		skill = SkillInvoke
	}
	taskID := strings.TrimSpace(params.TaskID)
	if taskID == "" {
		taskID = mintTaskID()
	}
	if err := validateTaskID(taskID); err != nil {
		return TaskStub{}, coded(CodeInvalidEnvelope, "%v", err)
	}
	input := map[string]any{}
	for key, value := range params.Input {
		input[key] = value
	}
	input["async"] = true
	input["task_id"] = taskID
	if params.Stream {
		input["stream"] = true
	}
	timeout := params.CreateTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	envelope, err := m.Dispatch(ctx, params.Target, skill, input, timeout)
	if err != nil {
		return TaskStub{}, err
	}

	now := time.Now().UTC()
	stub := TaskStub{
		TaskID:    taskID,
		Target:    params.Target,
		Skill:     skill,
		NotifyURL: strings.TrimSpace(params.NotifyURL),
		CreatedAt: now,
		UpdatedAt: now,
	}
	var respond RespondPayload
	// Two synchronous dialects answer a CREATE, and both must complete the
	// task rather than leave it "working" forever:
	//   - an unupgraded ReactorPro edge wraps its answer as {output: {...}}
	//     (the skill reply shape);
	//   - the fleet's text-based bridges answer with the payload itself —
	//     {task_id, text, ...} and no output key at all. Not recognising the
	//     second dialect recorded real fleet peers' answers as eternal
	//     "working" tasks; discovered live against grip-cli-001.
	var dialect struct {
		Text    string `json:"text"`
		Message string `json:"message"`
	}
	if len(envelope.Payload) > 0 {
		_ = json.Unmarshal(envelope.Payload, &respond)
		_ = json.Unmarshal(envelope.Payload, &dialect)
	}
	handle, handleErr := decodeTaskHandle(respond.Output)
	switch {
	case handleErr == nil && handle.TaskID != "":
		stub.State = handle.State
	case respond.Output != nil:
		// The ReactorPro dialect: one reply, task complete.
		encoded, err := json.Marshal(respond.Output)
		if err == nil {
			stub.Result = encoded
		}
		stub.State = TaskCompleted
		stub.CompletedSync = true
	case dialect.Text != "" || dialect.Message != "":
		// The bridge dialect: the answer is the payload's top-level text.
		// Stored in the same {"text": ...} shape an async invoke result
		// arrives in, so a caller reads one shape whatever the peer runs.
		answer := dialect.Text
		if answer == "" {
			answer = dialect.Message
		}
		if encoded, err := json.Marshal(map[string]string{"text": answer}); err == nil {
			stub.Result = encoded
		}
		stub.State = TaskCompleted
		stub.CompletedSync = true
	default:
		stub.State = TaskWorking
	}

	if store := m.taskStoreSnapshot(); store != nil {
		if err := store.SaveTaskStub(stub); err != nil {
			m.logger.Warn("could not persist a task stub", "task", taskID, "error", err)
		}
		// A fast peer can finish — and announce — before this stub was saved,
		// in which case the event handler could not have matched it. The
		// buffered event, if any, is the state that outran us.
		if buffered, ok := m.drainPendingTaskEvent(taskID); ok {
			stub.State = buffered.State
			stub.ErrorMessage = buffered.ErrorMessage
			stub.UpdatedAt = time.Now().UTC()
			if err := store.SaveTaskStub(stub); err != nil {
				m.logger.Warn("could not persist a task stub after a buffered event", "task", taskID, "error", err)
			}
		}
		// A synchronous answer IS the terminal state: notify now, through the
		// same once-only gate every other terminal path uses.
		m.notifyTaskTerminal(stub)
	}
	return stub, nil
}

// decodeTaskHandle tells a task handle from a synchronous invoke output.
func decodeTaskHandle(output any) (TaskHandle, error) {
	if output == nil {
		return TaskHandle{}, errors.New("no output")
	}
	raw, err := json.Marshal(output)
	if err != nil {
		return TaskHandle{}, err
	}
	var handle TaskHandle
	if err := json.Unmarshal(raw, &handle); err != nil {
		return TaskHandle{}, err
	}
	if handle.TaskID == "" || handle.State == "" {
		return TaskHandle{}, errors.New("not a task handle")
	}
	return handle, nil
}

// TaskTail returns the recent chunk tail of one of this edge's executed
// tasks, for the REST surface.
func (m *Manager) TaskTail(caller, taskID string, limit int) []TaskChunk {
	return m.taskTail(caller, taskID, limit)
}

// RefreshTaskStub queries the owning peer for a task's current state and
// records what it learns. The stub is the caller's cache, never the truth;
// this is how it catches up when events were missed. A tail also asks the
// owner for the streamed chunk view, which only it holds.
func (m *Manager) RefreshTaskStub(ctx context.Context, taskID string, tail int) (TaskStub, TaskWithChunks, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return TaskStub{}, TaskWithChunks{}, coded(CodeInternalError, "this gateway has no task store configured")
	}
	stub, ok, err := store.GetTaskStub(taskID)
	if err != nil {
		return TaskStub{}, TaskWithChunks{}, coded(CodeInternalError, "task store lookup failed: %v", err)
	}
	if !ok {
		return TaskStub{}, TaskWithChunks{}, coded(CodeSkillNotFound, "no task %q", taskID)
	}
	// A sync-completed stub has no task.get to ask — its peer answered the
	// old way, and a task.get dispatched there would be spent as a real agent
	// turn for nothing. Everything else may fetch: task.get on a task-capable
	// edge is a store read, and a terminal stub with no cached result is a
	// cache miss, not a finished conversation — fetching the result is the
	// one thing refresh exists for. A tail widens the fetch only: a terminal
	// task's chunks are a read on the owner, not an agent turn.
	if stub.CompletedSync {
		return stub, TaskWithChunks{}, nil
	}
	if TaskTerminal(stub.State) && tail <= 0 && len(stub.Result) > 0 {
		return stub, TaskWithChunks{}, nil
	}
	input := map[string]any{"task_id": taskID}
	if tail > 0 {
		input["tail"] = tail
	}
	envelope, err := m.Dispatch(ctx, stub.Target, SkillTaskGet, input, 30*time.Second)
	if err != nil {
		return stub, TaskWithChunks{}, err
	}
	var respond RespondPayload
	if len(envelope.Payload) > 0 {
		_ = json.Unmarshal(envelope.Payload, &respond)
	}
	task, err := taskFromOutput(respond.Output)
	if err != nil {
		return stub, TaskWithChunks{}, err
	}
	stub.State = task.State
	stub.UpdatedAt = time.Now().UTC()
	if task.State == TaskCompleted {
		stub.Result = task.Result
	}
	stub.ErrorMessage = task.ErrorMessage
	if err := store.SaveTaskStub(stub); err != nil {
		m.logger.Warn("could not persist a refreshed task stub", "task", taskID, "error", err)
	}
	return stub, task, nil
}

// CancelTaskByStub cancels a task this gateway created on a peer, by
// dispatching task.cancel to the owning edge.
func (m *Manager) CancelTaskByStub(ctx context.Context, taskID string) (TaskStub, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return TaskStub{}, coded(CodeInternalError, "this gateway has no task store configured")
	}
	stub, ok, err := store.GetTaskStub(taskID)
	if err != nil || !ok {
		return TaskStub{}, coded(CodeSkillNotFound, "no task %q", taskID)
	}
	envelope, err := m.Dispatch(ctx, stub.Target, SkillTaskCancel, map[string]any{"task_id": taskID}, 30*time.Second)
	if err != nil {
		return stub, err
	}
	var respond RespondPayload
	if len(envelope.Payload) > 0 {
		_ = json.Unmarshal(envelope.Payload, &respond)
	}
	task, err := taskFromOutput(respond.Output)
	if err == nil {
		stub.State = task.State
		stub.UpdatedAt = time.Now().UTC()
		if err := store.SaveTaskStub(stub); err != nil {
			m.logger.Warn("could not persist a canceled task stub", "task", taskID, "error", err)
		}
	}
	return stub, nil
}

func taskFromOutput(output any) (TaskWithChunks, error) {
	if output == nil {
		return TaskWithChunks{}, coded(CodeInternalError, "the peer did not return a task object")
	}
	raw, err := json.Marshal(output)
	if err != nil {
		return TaskWithChunks{}, coded(CodeInternalError, "the peer's task object is not encodable: %v", err)
	}
	var task TaskWithChunks
	if err := json.Unmarshal(raw, &task); err != nil || task.TaskID == "" {
		return TaskWithChunks{}, coded(CodeInternalError, "the peer did not return a task object")
	}
	return task, nil
}

// ConsumeTaskEvents subscribes to every task event and files the ones that
// match this gateway's stubs. Events for other pairs' tasks are ignored —
// they are not this caller's business, and the stub table is the filter that
// keeps it that way.
func (m *Manager) ConsumeTaskEvents(ctx context.Context) error {
	agent, err := m.requireAgent()
	if err != nil {
		return err
	}
	_, err = agent.Subscribe(ctx, "task.>", func(_ context.Context, _ string, event EventPayload) {
		// Chunk events are a progress view for live listeners; the stub tracks
		// state only. A chunk's data carries no state field, so without this
		// branch it would parse as a state of "" and corrupt the stub. Task ids
		// cannot contain '.', so the suffix cannot collide with a state event.
		if strings.HasSuffix(event.EventType, ".chunk") {
			return
		}
		raw, err := json.Marshal(event.Data)
		if err != nil {
			return
		}
		var update taskEvent
		if err := json.Unmarshal(raw, &update); err != nil {
			return
		}
		if update.TaskID == "" {
			return
		}
		store := m.taskStoreSnapshot()
		if store == nil {
			return
		}
		stub, ok, err := store.GetTaskStub(update.TaskID)
		if err != nil {
			return
		}
		if !ok {
			// No stub yet: either another pair's task (ignored forever) or a
			// task this gateway created microseconds ago, whose event outran
			// the save. Buffer it — the create path drains it, and the buffer
			// ages out, so a stranger's events are held briefly, not tracked.
			m.stashPendingTaskEvent(update)
			return
		}
		stub.State = update.State
		stub.ErrorMessage = update.ErrorMessage
		stub.UpdatedAt = time.Now().UTC()
		if err := store.SaveTaskStub(stub); err != nil {
			m.logger.Warn("could not update a task stub from an event", "task", update.TaskID, "error", err)
		}
		// The event path is the normal notification trigger: the peer announced
		// a terminal state, the stub now says so, and anyone who asked to be
		// pushed is pushed. notifyTaskTerminal is a no-op for non-terminal
		// states and fires at most once per (task, URL).
		m.notifyTaskTerminal(stub)
	})
	return err
}

// ── operator surface (REST) ────────────────────────────────────────────────

// TaskStubByID returns one caller-side stub.
func (m *Manager) TaskStubByID(taskID string) (TaskStub, bool, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return TaskStub{}, false, coded(CodeInternalError, "this gateway has no task store configured")
	}
	return store.GetTaskStub(taskID)
}

// TaskStubs lists caller-side stubs, newest first.
func (m *Manager) TaskStubs(before time.Time, limit int) ([]TaskStub, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return nil, coded(CodeInternalError, "this gateway has no task store configured")
	}
	return store.ListTaskStubs(before, limit)
}

// ExecutorTasks lists tasks this edge ran for peers, newest first. The caller
// filter is the multi-tenant view: an operator can ask what one organisation's
// edge has been doing on this one.
func (m *Manager) ExecutorTasks(filter TaskFilter) ([]Task, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return nil, coded(CodeInternalError, "this gateway has no task store configured")
	}
	return store.ListTasks(filter)
}

// ExecutorTask returns one task this edge ran, by creating caller. The caller
// is required, not optional: without it, "fetch task X" would let a local
// operator — or anyone holding the gateway token — read any tenant's result,
// and the per-caller key exists precisely so that is not possible.
func (m *Manager) ExecutorTask(caller, taskID string) (Task, bool, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return Task{}, false, coded(CodeInternalError, "this gateway has no task store configured")
	}
	return store.GetTask(caller, taskID)
}

// CancelLocalTask cancels a task this edge is executing, by creating caller.
func (m *Manager) CancelLocalTask(caller, taskID string) (Task, error) {
	return m.cancelTask(caller, taskID)
}

// RetryTask re-runs a failed or canceled task this edge executed, keeping the
// same task id — the manual-resume primitive for long work that outlived a
// restart or a runtime budget.
//
// Only failed and canceled tasks may be retried: completed needs nothing,
// rejected would re-fail its gate for identical reasons, and a live task
// cannot be interrupted by anything but its cancel. The reset deliberately
// bypasses the state machine's terminal rule — this is an operator's explicit
// decision, not an organic transition — and the relaunch reuses the same
// launch path as the original create, so a retried task inherits every
// guarantee: idempotency by (caller, task id), the runtime budget, the
// streaming opt-in recorded on the task.
func (m *Manager) RetryTask(caller, taskID string) (Task, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return Task{}, coded(CodeInternalError, "this edge has no task store configured")
	}
	m.taskMu.Lock()
	task, ok, err := store.GetTask(caller, taskID)
	if err != nil || !ok {
		m.taskMu.Unlock()
		return Task{}, coded(CodeSkillNotFound, "no task %q for this caller", taskID)
	}
	if task.State != TaskFailed && task.State != TaskCanceled {
		m.taskMu.Unlock()
		return Task{}, coded(CodeGovernanceDenied,
			"only failed or canceled tasks can be retried; %s is %s", taskID, task.State)
	}
	task.State = TaskQueued
	task.Result = nil
	task.ErrorCode = ""
	task.ErrorMessage = ""
	task.UpdatedAt = time.Now().UTC()
	if err := store.SaveTask(task); err != nil {
		m.taskMu.Unlock()
		return Task{}, coded(CodeInternalError, "task store write failed: %v", err)
	}
	m.taskMu.Unlock()
	m.logger.Info("task retried", "task", taskID, "caller", caller,
		"agent", task.Agent, "operation", task.Operation)
	go m.executeTask(context.Background(), task)
	return task, nil
}

// ResolveTaskInput answers an input-required task with new input.
//
// Phase 1 scaffolding: no executor path puts a task into input-required yet
// (that arrives with streaming, when the desktop's approval and clarify gates
// surface), so this validates the transition and records the input, and
// refuses everything else. The API shape ships now so clients never change.
func (m *Manager) ResolveTaskInput(caller, taskID string, input json.RawMessage) (Task, error) {
	store := m.taskStoreSnapshot()
	if store == nil {
		return Task{}, coded(CodeInternalError, "this gateway has no task store configured")
	}
	if len(input) == 0 {
		return Task{}, coded(CodeInvalidEnvelope, "task input requires a non-empty input object")
	}
	var updated Task
	err := m.transitionTask(caller, taskID, TaskWorking, func(task *Task) {
		task.Arguments = input
		updated = *task
	})
	if err != nil {
		if errors.Is(err, ErrTaskState) {
			return Task{}, coded(CodeGovernanceDenied,
				"task %q is not waiting for input", taskID)
		}
		return Task{}, coded(CodeInternalError, "task input could not be recorded: %v", err)
	}
	return updated, nil
}

// TaskStoreConfigured reports whether task APIs can keep their promises.
func (m *Manager) TaskStoreConfigured() bool {
	return m.taskStoreSnapshot() != nil
}

// SweepTasks runs the housekeeping that must happen at startup: terminal
// tasks older than the retention window are deleted, and anything the
// previous run left mid-flight is marked failed — the run died with the
// process, and pretending a task is still working when nothing will ever
// finish it is the one dishonest state this module refuses to keep.
// tasks older than the retention window are deleted, and anything the
// previous run left mid-flight is marked failed — the run died with the
// process, and pretending a task is still working when nothing will ever
// finish it is the one dishonest state this module refuses to keep.
func (m *Manager) SweepTasks() {
	store := m.taskStoreSnapshot()
	if store == nil {
		return
	}
	config := m.Config()
	retention := config.TaskRetention
	if retention <= 0 {
		retention = DefaultTaskRetention
	}
	if pruned, err := store.PruneTasks(time.Now().UTC().Add(-retention)); err != nil {
		m.logger.Warn("could not prune old tasks", "error", err)
	} else if pruned > 0 {
		m.logger.Info("pruned old mesh tasks", "count", pruned)
	}

	tasks, err := store.ListTasks(TaskFilter{Limit: 1000})
	if err != nil {
		m.logger.Warn("could not list tasks for the startup sweep", "error", err)
		return
	}
	for _, task := range tasks {
		if TaskTerminal(task.State) {
			continue
		}
		m.finishTask(task, TaskFailed, "edge-restarted",
			"the edge restarted while this task was running; resumable execution is not implemented yet")
	}
}
