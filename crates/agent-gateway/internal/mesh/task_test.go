package mesh

// Unit coverage for the task lifecycle: the state machine, the idempotency
// contract, caller isolation, the cancel/completion race, and the startup
// sweep. Everything that needs a NATS server lives in task_integration_test.go;
// everything here runs without one, which is most of the policy.

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTaskStore is an in-memory TaskStore: enough store to exercise the
// manager's read-modify-write cycles, and no SQLite in unit tests.
type fakeTaskStore struct {
	mu    sync.Mutex
	tasks map[string]Task // key: caller + "\x00" + taskID
	stubs map[string]TaskStub
}

func newFakeTaskStore() *fakeTaskStore {
	return &fakeTaskStore{tasks: map[string]Task{}, stubs: map[string]TaskStub{}}
}

func taskStoreKey(caller, taskID string) string { return caller + "\x00" + taskID }

func (s *fakeTaskStore) SaveTask(task Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tasks[taskStoreKey(task.Caller, task.TaskID)] = task
	return nil
}

func (s *fakeTaskStore) GetTask(caller, taskID string) (Task, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.tasks[taskStoreKey(caller, taskID)]
	return task, ok, nil
}

func (s *fakeTaskStore) ListTasks(filter TaskFilter) ([]Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Task
	for _, task := range s.tasks {
		if filter.Caller != "" && task.Caller != filter.Caller {
			continue
		}
		if !filter.Before.IsZero() && !task.CreatedAt.Before(filter.Before) {
			continue
		}
		out = append(out, task)
	}
	return out, nil
}

func (s *fakeTaskStore) PruneTasks(cutoff time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var pruned int64
	for key, task := range s.tasks {
		if TaskTerminal(task.State) && task.UpdatedAt.Before(cutoff) {
			delete(s.tasks, key)
			pruned++
		}
	}
	return pruned, nil
}

func (s *fakeTaskStore) SaveTaskStub(stub TaskStub) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stubs[stub.TaskID] = stub
	return nil
}

func (s *fakeTaskStore) GetTaskStub(taskID string) (TaskStub, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	stub, ok := s.stubs[taskID]
	return stub, ok, nil
}

func (s *fakeTaskStore) ListTaskStubs(before time.Time, limit int) ([]TaskStub, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []TaskStub
	for _, stub := range s.stubs {
		if !before.IsZero() && !stub.CreatedAt.Before(before) {
			continue
		}
		out = append(out, stub)
	}
	return out, nil
}

func (s *fakeTaskStore) CountTaskStubs() (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return int64(len(s.stubs)), nil
}

// taskTestManager is a manager with a task store, a directory and an invoker,
// but no NATS connection — publishTaskEvent becomes a no-op, which is exactly
// the unit-test scope: the store and state policy, not the wire.
func taskTestManager(t *testing.T, invoker LocalInvoker, mutate func(*Config)) (*Manager, *fakeTaskStore) {
	t.Helper()
	manager := invokeTestManager(t, invokeAgents(), mutate)
	store := newFakeTaskStore()
	manager.SetTaskStore(store)
	manager.SetLocalInvoker(invoker)
	return manager, store
}

// asyncInput is the invoke input that asks for a task instead of a reply.
func asyncInput(taskID string) InvokeInput {
	return InvokeInput{
		Target:    "agent-1",
		Operation: OperationTask,
		Arguments: json.RawMessage(`{"prompt":"summarise Q3"}`),
		Async:     true,
		TaskID:    taskID,
	}
}

// pollTask waits for a task to reach a wanted state, failing the test on
// timeout instead of sleeping blindly — a hung goroutine must be a failure,
// not a slow test.
func pollTask(t *testing.T, store *fakeTaskStore, caller, taskID string, want TaskState) Task {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		task, ok, _ := store.GetTask(caller, taskID)
		if ok && task.State == want {
			return task
		}
		time.Sleep(5 * time.Millisecond)
	}
	task, _, _ := store.GetTask(caller, taskID)
	t.Fatalf("task %s never reached %s (last state %s)", taskID, want, task.State)
	return Task{}
}

func TestTaskStateMachinePinsTheVocabulary(t *testing.T) {
	legal := map[TaskState][]TaskState{
		TaskQueued:        {TaskWorking, TaskInputRequired, TaskCanceled, TaskRejected},
		TaskWorking:       {TaskInputRequired, TaskCompleted, TaskFailed, TaskCanceled},
		TaskInputRequired: {TaskWorking, TaskCanceled, TaskFailed},
	}
	for from, destinations := range legal {
		for _, to := range destinations {
			if !CanTransitionTask(from, to) {
				t.Errorf("transition %s -> %s should be legal", from, to)
			}
		}
	}
	for _, terminal := range []TaskState{TaskCompleted, TaskFailed, TaskCanceled, TaskRejected} {
		if !TaskTerminal(terminal) {
			t.Errorf("%s should be terminal", terminal)
		}
		for _, from := range []TaskState{TaskQueued, TaskWorking, TaskInputRequired, terminal} {
			if CanTransitionTask(from, terminal) && from != terminal {
				// legal only if listed above
				if !containsState(legal[from], terminal) {
					t.Errorf("unlisted transition %s -> %s reported legal", from, terminal)
				}
			}
		}
	}
	// The moves that would rewrite history are refused outright.
	for _, from := range []TaskState{TaskCompleted, TaskFailed, TaskCanceled, TaskRejected} {
		for _, to := range []TaskState{TaskQueued, TaskWorking, TaskInputRequired, TaskCompleted, TaskFailed, TaskCanceled, TaskRejected} {
			if CanTransitionTask(from, to) {
				t.Errorf("terminal task %s must not transition to %s", from, to)
			}
		}
	}
}

func TestShouldApplyStubStateRefusesToRegressATerminalStub(t *testing.T) {
	// The CI flake: SubmitTaskInput writes the working snapshot from the
	// task.input reply after ConsumeTaskEvents has already applied completed.
	if shouldApplyStubState(TaskCompleted, TaskWorking) {
		t.Fatal("a completed stub must not take the working snapshot from task.input")
	}
	if shouldApplyStubState(TaskFailed, TaskWorking) {
		t.Fatal("a failed stub must not take working")
	}
	if shouldApplyStubState(TaskCanceled, TaskCompleted) {
		t.Fatal("a canceled stub must not be un-canceled")
	}
	if !shouldApplyStubState(TaskInputRequired, TaskWorking) {
		t.Fatal("answering input-required should move the stub to working")
	}
	if !shouldApplyStubState(TaskWorking, TaskCompleted) {
		t.Fatal("a working stub should accept completed")
	}
	if !shouldApplyStubState(TaskCompleted, TaskCompleted) {
		t.Fatal("same-state refresh must still apply")
	}
}

func containsState(states []TaskState, want TaskState) bool {
	for _, state := range states {
		if state == want {
			return true
		}
	}
	return false
}

func TestValidateTaskIDKeepsTheEventSubjectOneToken(t *testing.T) {
	for _, id := range []string{"abc", "task-17", "run_01", "acme/edge:9", "0123456789abcdef"} {
		if err := validateTaskID(id); err != nil {
			t.Errorf("id %q should be accepted: %v", id, err)
		}
	}
	for _, id := range []string{"", "   ", "a.b", "a b", "a*b", "a>b", strings.Repeat("x", 200)} {
		if err := validateTaskID(id); err == nil {
			t.Errorf("id %q should be rejected", id)
		}
	}
}

func TestAsyncCreateRunsTheWorkOnceAndIsIdempotent(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true, Result: json.RawMessage(`{"text":"Q3 is up."}`)}}
	manager, store := taskTestManager(t, invoker, nil)
	meta := verifiedCaller()
	request := asyncInput("report-1")

	handle, err := manager.startAsyncTask(request, meta, LocalAgent{ID: "agent-1"})
	if err != nil {
		t.Fatalf("startAsyncTask: %v", err)
	}
	if handle.TaskID != "report-1" || handle.GetTask != SkillTaskGet {
		t.Fatalf("unexpected handle: %+v", handle)
	}
	// A retried CREATE with the same id must not run the work twice.
	retry, err := manager.startAsyncTask(request, meta, LocalAgent{ID: "agent-1"})
	if err != nil {
		t.Fatalf("idempotent recreate: %v", err)
	}
	if retry.TaskID != handle.TaskID {
		t.Fatalf("recreate returned a different task: %s", retry.TaskID)
	}

	task := pollTask(t, store, meta.From, "report-1", TaskCompleted)
	if string(task.Result) != `{"text":"Q3 is up."}` {
		t.Fatalf("result not recorded: %s", task.Result)
	}
	if len(invoker.requests) != 1 {
		t.Fatalf("the invoker ran %d times; idempotency exists so it runs once", len(invoker.requests))
	}
	if invoker.requests[0].Caller != meta.From || invoker.requests[0].CallerFingerprint != meta.CallerFingerprint {
		t.Fatalf("caller identity did not reach the invoker: %+v", invoker.requests[0])
	}
}

func TestTaskGetIsScopedToTheCreatingCaller(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true}}
	manager, store := taskTestManager(t, invoker, nil)
	owner := verifiedCaller()
	if _, err := manager.startAsyncTask(asyncInput("report-2"), owner, LocalAgent{ID: "agent-1"}); err != nil {
		t.Fatalf("startAsyncTask: %v", err)
	}
	pollTask(t, store, owner.From, "report-2", TaskCompleted)
	if _, ok, _ := store.GetTask(owner.From, "report-2"); !ok {
		t.Fatal("the owner's own task should exist")
	}

	// Another tenant asking for the same id learns nothing — not even that it
	// exists, because existence is the owner's information to give.
	other := RequestMeta{From: "rival/berlin/edge-1", Verified: true, CallerFingerprint: "sha256:dead0000beef0000"}
	_, err := manager.skillTaskGet(context.Background(), map[string]any{"task_id": "report-2"}, other)
	if codeOf(t, err) != CodeSkillNotFound {
		t.Fatalf("a rival caller should get 3001, got %v", err)
	}
	// And the owner reads it fine.
	got, err := manager.skillTaskGet(context.Background(), map[string]any{"task_id": "report-2"}, owner)
	if err != nil {
		t.Fatalf("owner task.get: %v", err)
	}
	task, ok := got.(Task)
	if !ok || task.TaskID != "report-2" {
		t.Fatalf("unexpected task.get result: %#v", got)
	}
}

// lateSuccessInvoker ignores its context and returns a success result only
// when released — the shape of a run that finishes after a cancel.
type lateSuccessInvoker struct {
	release  chan struct{}
	requests []LocalInvokeRequest
}

func (l *lateSuccessInvoker) InvokeLocalAgent(ctx context.Context, request LocalInvokeRequest) (LocalInvokeResult, error) {
	l.requests = append(l.requests, request)
	<-l.release
	return LocalInvokeResult{OK: true, Result: json.RawMessage(`{"text":"late"}`)}, nil
}

func TestCancelWinsTheRaceAgainstALateCompletion(t *testing.T) {
	invoker := &lateSuccessInvoker{release: make(chan struct{})}
	manager, store := taskTestManager(t, invoker, func(c *Config) { c.TaskMaxRuntime = time.Hour })
	meta := verifiedCaller()
	if _, err := manager.startAsyncTask(asyncInput("slow-1"), meta, LocalAgent{ID: "agent-1"}); err != nil {
		t.Fatalf("startAsyncTask: %v", err)
	}
	pollTask(t, store, meta.From, "slow-1", TaskWorking)

	canceled, err := manager.cancelTask(meta.From, "slow-1")
	if err != nil {
		t.Fatalf("cancelTask: %v", err)
	}
	if canceled.State != TaskCanceled {
		t.Fatalf("cancel should record canceled, got %s", canceled.State)
	}

	// The run finishes now, with a success result. Canceled is terminal, so
	// the late result must be refused, not recorded over the decision.
	close(invoker.release)
	time.Sleep(50 * time.Millisecond) // let executeTask observe the result
	task, _, _ := store.GetTask(meta.From, "slow-1")
	if task.State != TaskCanceled {
		t.Fatalf("a late completion overwrote the cancel: state is %s", task.State)
	}
	if len(task.Result) != 0 {
		t.Fatalf("a canceled task must not carry the late result: %s", task.Result)
	}
}

func TestAsyncGateRefusalsAreRecordedAsRejectedTasks(t *testing.T) {
	invoker := &recordingInvoker{}
	manager, store := taskTestManager(t, invoker, nil)
	meta := verifiedCaller()

	// The operation is not served: with async the caller still holds an object.
	_, err := manager.skillInvoke(context.Background(), map[string]any{
		"target": "agent-1", "operation": "not-an-operation", "async": true, "task_id": "bad-1",
	}, meta)
	if err != nil {
		t.Fatalf("skillInvoke: %v", err)
	}
	task, ok, _ := store.GetTask(meta.From, "bad-1")
	if !ok || task.State != TaskRejected {
		t.Fatalf("refusal should be a rejected task, got %+v", task)
	}
	if len(invoker.requests) != 0 {
		t.Fatal("a rejected task must not reach the invoker")
	}

	// An unusable target likewise: an offline agent is a rejected task.
	_, err = manager.skillInvoke(context.Background(), map[string]any{
		"target": "agent-3", "operation": OperationTask, "async": true, "task_id": "bad-2",
	}, meta)
	if err != nil {
		t.Fatalf("skillInvoke: %v", err)
	}
	task, ok, _ = store.GetTask(meta.From, "bad-2")
	if !ok || task.State != TaskRejected {
		t.Fatalf("offline target should be a rejected task, got %+v", task)
	}
}

func TestAsyncInvokeNeedsAStoreToPromiseAnything(t *testing.T) {
	manager := invokeTestManager(t, invokeAgents(), nil)
	// No SetTaskStore: the honest refusal, not a handle nothing can honour.
	_, err := manager.startAsyncTask(asyncInput("no-store-1"), verifiedCaller(), LocalAgent{ID: "agent-1"})
	if codeOf(t, err) != CodeInternalError {
		t.Fatalf("expected the no-store refusal, got %v", err)
	}
}

func TestSweepMarksOrphansFailedAndPrunesOldTerminalTasks(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true}}
	manager, store := taskTestManager(t, invoker, nil)
	now := time.Now().UTC()

	oldDone := Task{TaskID: "old-1", Caller: "acme/lagos/edge-1", State: TaskCompleted,
		CreatedAt: now.Add(-DefaultTaskRetention - time.Hour), UpdatedAt: now.Add(-DefaultTaskRetention - time.Hour)}
	freshDone := Task{TaskID: "new-1", Caller: "acme/lagos/edge-1", State: TaskFailed,
		CreatedAt: now.Add(-time.Hour), UpdatedAt: now.Add(-time.Hour)}
	running := Task{TaskID: "run-1", Caller: "acme/lagos/edge-1", State: TaskWorking,
		CreatedAt: now.Add(-time.Minute), UpdatedAt: now.Add(-time.Minute)}
	for _, task := range []Task{oldDone, freshDone, running} {
		if err := store.SaveTask(task); err != nil {
			t.Fatalf("SaveTask: %v", err)
		}
	}

	manager.SweepTasks()

	if _, ok, _ := store.GetTask(oldDone.Caller, oldDone.TaskID); ok {
		t.Error("a terminal task past retention should have been pruned")
	}
	if _, ok, _ := store.GetTask(freshDone.Caller, freshDone.TaskID); !ok {
		t.Error("a terminal task inside retention must stay queryable")
	}
	swept, ok, _ := store.GetTask(running.Caller, running.TaskID)
	if !ok || swept.State != TaskFailed {
		t.Fatalf("an orphaned run should be swept to failed, got %+v", swept)
	}
	if swept.ErrorCode != "edge-restarted" {
		t.Fatalf("the sweep should say why: %+v", swept)
	}
}

func TestResolveTaskInputOnlyAnswersAnInputRequiredTask(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true}}
	manager, store := taskTestManager(t, invoker, nil)
	meta := verifiedCaller()
	if _, err := manager.startAsyncTask(asyncInput("input-1"), meta, LocalAgent{ID: "agent-1"}); err != nil {
		t.Fatalf("startAsyncTask: %v", err)
	}
	pollTask(t, store, meta.From, "input-1", TaskCompleted)

	// A task not waiting for input refuses the endpoint.
	if _, err := manager.ResolveTaskInput(meta.From, "input-1", json.RawMessage(`{"answer":"yes"}`)); err == nil {
		t.Fatal("input on a completed task should be refused")
	} else if codeOf(t, err) != CodeGovernanceDenied {
		t.Fatalf("expected a policy refusal, got %v", err)
	}

	// Another caller's task id is indistinguishable from a nonexistent one.
	waiting := Task{TaskID: "input-2", Caller: meta.From, State: TaskInputRequired,
		PendingInput: "which quarter?", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if err := store.SaveTask(waiting); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	if _, err := manager.ResolveTaskInput("someone/else", "input-2", json.RawMessage(`"yes"`)); err == nil {
		t.Fatal("input on another caller's task should be refused")
	} else if codeOf(t, err) != CodeSkillNotFound {
		t.Fatalf("expected a scoped not-found, got %v", err)
	}

	// A string answer resumes the task as working, with the answer rendered
	// as the prompt the resumed conversation continues with.
	updated, err := manager.ResolveTaskInput(meta.From, "input-2", json.RawMessage(`"yes"`))
	if err != nil {
		t.Fatalf("ResolveTaskInput: %v", err)
	}
	if updated.State != TaskWorking {
		t.Fatalf("expected the resumed task working, got %s", updated.State)
	}
	if string(updated.Arguments) != `{"prompt":"yes"}` {
		t.Fatalf("expected the answer rendered as a prompt, got %s", updated.Arguments)
	}
	if updated.PendingInput != "" {
		t.Fatalf("the question should clear on resume, got %q", updated.PendingInput)
	}
	// The relaunch runs: the resumed task completes under the scripted result.
	pollTask(t, store, meta.From, "input-2", TaskCompleted)

	// An object answer is labelled JSON, not silently flattened to prose.
	waitingObject := Task{TaskID: "input-3", Caller: meta.From, State: TaskInputRequired,
		PendingInput: "which region?", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if err := store.SaveTask(waitingObject); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	updated, err = manager.ResolveTaskInput(meta.From, "input-3", json.RawMessage(`{"answer":"yes"}`))
	if err != nil {
		t.Fatalf("ResolveTaskInput (object): %v", err)
	}
	if !strings.Contains(string(updated.Arguments), `"prompt":"The requester answered with the following JSON:`) {
		t.Fatalf("expected a labelled JSON answer, got %s", updated.Arguments)
	}
	pollTask(t, store, meta.From, "input-3", TaskCompleted)

	// Empty input is refused before anything runs.
	if _, err := manager.ResolveTaskInput(meta.From, "input-4", json.RawMessage(`""`)); err == nil {
		t.Fatal("an empty answer should be refused")
	} else if codeOf(t, err) != CodeInvalidEnvelope {
		t.Fatalf("expected a malformed-input refusal, got %v", err)
	}
}

// scriptedInvoker hands out one result per call and records every request, so
// a pause→resume cycle can be driven end to end.
type scriptedInvoker struct {
	mu       sync.Mutex
	requests []LocalInvokeRequest
	results  []LocalInvokeResult
}

func (s *scriptedInvoker) InvokeLocalAgent(_ context.Context, request LocalInvokeRequest) (LocalInvokeResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, request)
	if len(s.results) == 0 {
		return LocalInvokeResult{OK: true, Result: json.RawMessage(`{"text":"done"}`)}, nil
	}
	result := s.results[0]
	s.results = s.results[1:]
	return result, nil
}

func (s *scriptedInvoker) recorded() []LocalInvokeRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]LocalInvokeRequest, len(s.requests))
	copy(out, s.requests)
	return out
}

func TestAllowInputTaskPausesOnTheMarkerAndResumesInPlace(t *testing.T) {
	invoker := &scriptedInvoker{results: []LocalInvokeResult{
		// The first turn asks; the second turn, resumed with the answer,
		// finishes.
		{OK: true, ConversationID: "remote-task-conv-first",
			Result: json.RawMessage(`{"text":"I need one detail.\n[[INPUT_REQUIRED: which quarter?]]"}`)},
		{OK: true, ConversationID: "remote-task-conv-first",
			Result: json.RawMessage(`{"text":"Q3 revenue was 4.1M."}`)},
	}}
	manager, store := taskTestManager(t, invoker, nil)
	meta := verifiedCaller()
	request := asyncInput("ask-1")
	request.AllowInput = true
	if _, err := manager.startAsyncTask(request, meta, LocalAgent{ID: "agent-1"}); err != nil {
		t.Fatalf("startAsyncTask: %v", err)
	}

	paused := pollTask(t, store, meta.From, "ask-1", TaskInputRequired)
	if paused.PendingInput != "which quarter?" {
		t.Fatalf("expected the question recorded, got %q", paused.PendingInput)
	}
	if paused.Conversation != "remote-task-conv-first" {
		t.Fatalf("expected the run's conversation recorded, got %q", paused.Conversation)
	}
	if paused.Result != nil {
		t.Fatalf("a paused task holds no result, got %s", paused.Result)
	}
	first := invoker.recorded()[0]
	if !first.AllowInput || first.ConversationID != "" {
		t.Fatalf("the first run should carry the opt-in and no conversation: %+v", first)
	}

	// Answering resumes in the same conversation and completes.
	updated, err := manager.ResolveTaskInput(meta.From, "ask-1", json.RawMessage(`"Q3"`))
	if err != nil {
		t.Fatalf("ResolveTaskInput: %v", err)
	}
	if updated.State != TaskWorking {
		t.Fatalf("expected working after the answer, got %s", updated.State)
	}
	done := pollTask(t, store, meta.From, "ask-1", TaskCompleted)
	if string(done.Result) != `{"text":"Q3 revenue was 4.1M."}` {
		t.Fatalf("expected the resumed run's result, got %s", done.Result)
	}
	requests := invoker.recorded()
	if len(requests) != 2 {
		t.Fatalf("expected two invocations (ask, then resume), got %d", len(requests))
	}
	if requests[1].ConversationID != "remote-task-conv-first" {
		t.Fatalf("the resume must continue the recorded conversation, got %q", requests[1].ConversationID)
	}
	if !requests[1].AllowInput {
		t.Fatal("the resumed run keeps the input opt-in, so it may ask again")
	}
}

func TestMarkerNeverPausesATaskWithoutTheOptIn(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{
		OK: true, Result: json.RawMessage(`{"text":"unsure.\n[[INPUT_REQUIRED: which quarter?]]"}`)}}
	manager, store := taskTestManager(t, invoker, nil)
	meta := verifiedCaller()
	if _, err := manager.startAsyncTask(asyncInput("plain-1"), meta, LocalAgent{ID: "agent-1"}); err != nil {
		t.Fatalf("startAsyncTask: %v", err)
	}
	// Without the opt-in the marker is ordinary output: the task completes,
	// the question and all.
	done := pollTask(t, store, meta.From, "plain-1", TaskCompleted)
	if done.PendingInput != "" {
		t.Fatalf("no opt-in, no pause: pending_input should be empty, got %q", done.PendingInput)
	}
}

func TestExtractTaskInputRequest(t *testing.T) {
	cases := []struct {
		name     string
		text     string
		question string
		found    bool
	}{
		{"marker at the end", "Some context first.\n[[INPUT_REQUIRED: which region?]]", "which region?", true},
		{"marker mid-reply is not a request", "before [[INPUT_REQUIRED: no]] after", "", false},
		{"last marker wins", "[[INPUT_REQUIRED: first?]]\nmore\n[[INPUT_REQUIRED: second?]]", "second?", true},
		{"empty question is not a request", "[[INPUT_REQUIRED: ]]", "", false},
		{"no marker", "a plain answer", "", false},
		{"lowercase spelling is not the marker", "[[input_required: which?]]", "", false},
		{"indented marker line counts", "  [[INPUT_REQUIRED: which plan?]]  ", "which plan?", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			question, found := extractTaskInputRequest(tc.text)
			if found != tc.found || question != tc.question {
				t.Fatalf("extractTaskInputRequest(%q) = (%q, %v), want (%q, %v)",
					tc.text, question, found, tc.question, tc.found)
			}
		})
	}
}

func TestTaskInputSkillIsCallerScoped(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true}}
	manager, store := taskTestManager(t, invoker, nil)
	meta := verifiedCaller()
	waiting := Task{TaskID: "scoped-1", Caller: meta.From, State: TaskInputRequired,
		PendingInput: "which?", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if err := store.SaveTask(waiting); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	// The creating caller may answer.
	if _, err := manager.skillTaskInput(context.Background(),
		map[string]any{"task_id": "scoped-1", "input": "yes"}, meta); err != nil {
		t.Fatalf("skillTaskInput: %v", err)
	}
	pollTask(t, store, meta.From, "scoped-1", TaskCompleted)

	// A different caller is told the task does not exist — scope, not refusal
	// with detail.
	err := store.SaveTask(Task{TaskID: "scoped-2", Caller: meta.From, State: TaskInputRequired,
		PendingInput: "which?", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()})
	if err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	other := verifiedCaller()
	other.From = "someone/else"
	_, err = manager.skillTaskInput(context.Background(),
		map[string]any{"task_id": "scoped-2", "input": "yes"}, other)
	if err == nil || codeOf(t, err) != CodeSkillNotFound {
		t.Fatalf("expected a scoped not-found for another caller, got %v", err)
	}
}

func TestSweepKeepsInputRequiredTasks(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true}}
	manager, store := taskTestManager(t, invoker, nil)
	meta := verifiedCaller()
	now := time.Now().UTC()
	if err := store.SaveTask(Task{TaskID: "waiting-1", Caller: meta.From, State: TaskInputRequired,
		PendingInput: "which?", Conversation: "remote-task-conv-x", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	if err := store.SaveTask(Task{TaskID: "running-1", Caller: meta.From, State: TaskWorking,
		CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	manager.SweepTasks()

	if task, ok, _ := store.GetTask(meta.From, "waiting-1"); !ok || task.State != TaskInputRequired {
		t.Fatalf("an input-required task is waiting, not running; it must survive the sweep (got ok=%v state=%s)",
			ok, task.State)
	}
	if task, ok, _ := store.GetTask(meta.From, "running-1"); !ok || task.State != TaskFailed {
		t.Fatalf("a working task died with the process; the sweep must fail it honestly (got ok=%v state=%s)",
			ok, task.State)
	}
}

func TestCancelIsIdempotentOnATerminalTask(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true}}
	manager, store := taskTestManager(t, invoker, nil)
	meta := verifiedCaller()
	if _, err := manager.startAsyncTask(asyncInput("done-1"), meta, LocalAgent{ID: "agent-1"}); err != nil {
		t.Fatalf("startAsyncTask: %v", err)
	}
	pollTask(t, store, meta.From, "done-1", TaskCompleted)
	// Canceling a finished task reports the real state, not an error, because
	// a retried cancel is normal usage.
	task, err := manager.cancelTask(meta.From, "done-1")
	if err != nil {
		t.Fatalf("cancel of a completed task errored: %v", err)
	}
	if task.State != TaskCompleted {
		t.Fatalf("cancel of a completed task should report completed, got %s", task.State)
	}
}
