package meshstate

// Task storage against real SQLite: the composite (caller, task_id) key, the
// row-value cursor under timestamp ties, and pruning. The in-memory fake in the
// mesh package covers the manager's policy; these tests exist because SQL is
// where a subtle ordering or scoping bug would otherwise hide.

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/db"
	"github.com/liveagent/agent-gateway/internal/mesh"
)

func taskAt(caller, taskID string, state mesh.TaskState, at time.Time) mesh.Task {
	return mesh.Task{
		TaskID:    taskID,
		Caller:    caller,
		State:     state,
		CreatedAt: at.UTC(),
		UpdatedAt: at.UTC(),
		Result:    []byte(`{"text":"done"}`),
		Arguments: []byte(`{"prompt":"hi"}`),
		Operation: mesh.OperationTask,
		Agent:     "agent-1",
		TraceID:   "trace-1",
	}
}

func TestTaskRoundTripAndCallerScoping(t *testing.T) {
	store := newTestStore(t)
	task := taskAt("acme/lagos/edge-1", "run-1", mesh.TaskWorking, time.Now())
	if err := store.SaveTask(task); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	got, ok, err := store.GetTask("acme/lagos/edge-1", "run-1")
	if err != nil || !ok {
		t.Fatalf("GetTask: ok=%v err=%v", ok, err)
	}
	if string(got.Result) != `{"text":"done"}` || got.State != mesh.TaskWorking {
		t.Fatalf("round trip lost data: %+v", got)
	}
	// The composite key: another tenant's identical task id is a different
	// row, and invisible to this one.
	if _, ok, _ := store.GetTask("rival/berlin/edge-1", "run-1"); ok {
		t.Fatal("a task id must be scoped by caller, not global")
	}
	other := taskAt("rival/berlin/edge-1", "run-1", mesh.TaskCompleted, time.Now())
	if err := store.SaveTask(other); err != nil {
		t.Fatalf("SaveTask second tenant: %v", err)
	}
	if _, ok, _ := store.GetTask("acme/lagos/edge-1", "run-1"); !ok {
		t.Fatal("saving another tenant's task must not displace the first")
	}
}

// TestTaskStreamFlagSurvivesTheRoundTrip pins the bug the live validation
// caught: v1.5.16 carried Task.Stream in the struct but not the SQL, so a
// streamed task's own record read stream:false.
func TestTaskStreamFlagSurvivesTheRoundTrip(t *testing.T) {
	store := newTestStore(t)
	now := time.Now().UTC()
	streamed := taskAt("caller/1", "streamed-1", mesh.TaskWorking, now)
	streamed.Stream = true
	if err := store.SaveTask(streamed); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	got, ok, err := store.GetTask("caller/1", "streamed-1")
	if err != nil || !ok {
		t.Fatalf("GetTask: ok=%v err=%v", ok, err)
	}
	if !got.Stream {
		t.Fatal("the stream flag was dropped by the store round trip")
	}
	plain := taskAt("caller/1", "plain-1", mesh.TaskWorking, now)
	if err := store.SaveTask(plain); err != nil {
		t.Fatalf("SaveTask plain: %v", err)
	}
	if plainAgain, _, _ := store.GetTask("caller/1", "plain-1"); plainAgain.Stream {
		t.Fatal("a non-streaming task must read stream:false")
	}
}

// TestTaskStoreMigratesTheStreamColumn exercises the upgrade path: a database
// whose mesh_tasks table predates the stream column (the v1.5.16 shape) is
// migrated by NewStore, and the flag then round-trips.
func TestTaskStoreMigratesTheStreamColumn(t *testing.T) {
	database, err := db.Open(filepath.Join(t.TempDir(), "mesh-tasks.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	// Recreate the v1.5.16 table exactly: no stream column.
	oldSchema := `
CREATE TABLE mesh_tasks (
	caller_id          TEXT NOT NULL,
	task_id            TEXT NOT NULL,
	caller_fingerprint TEXT NOT NULL DEFAULT '',
	agent              TEXT NOT NULL DEFAULT '',
	operation          TEXT NOT NULL DEFAULT '',
	arguments_json     TEXT,
	state              TEXT NOT NULL,
	result_json        TEXT,
	error_code         TEXT NOT NULL DEFAULT '',
	error_message      TEXT NOT NULL DEFAULT '',
	trace_id           TEXT NOT NULL DEFAULT '',
	created_at         TEXT NOT NULL,
	updated_at         TEXT NOT NULL,
	PRIMARY KEY (caller_id, task_id)
)`
	if _, err := database.Pool().Exec(oldSchema); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}

	// NewStore must migrate rather than fail: CREATE IF NOT EXISTS leaves the
	// old table alone, and the column check adds what is missing.
	store, err := NewStore(database)
	if err != nil {
		t.Fatalf("NewStore over a legacy schema: %v", err)
	}
	now := time.Now().UTC()
	streamed := taskAt("caller/1", "migrated-1", mesh.TaskWorking, now)
	streamed.Stream = true
	if err := store.SaveTask(streamed); err != nil {
		t.Fatalf("SaveTask after migration: %v", err)
	}
	got, ok, err := store.GetTask("caller/1", "migrated-1")
	if err != nil || !ok {
		t.Fatalf("GetTask after migration: ok=%v err=%v", ok, err)
	}
	if !got.Stream {
		t.Fatal("the stream flag did not survive the migrated schema")
	}
}

func TestTaskCursorPaginationIsExactUnderTies(t *testing.T) {
	store := newTestStore(t)
	base := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	// Five tasks, two sharing one timestamp: the tie is the interesting case,
	// because a time-only cursor would skip the second of the pair.
	times := []time.Time{base, base.Add(time.Nanosecond), base.Add(time.Nanosecond), base.Add(2 * time.Nanosecond), base.Add(3 * time.Nanosecond)}
	ids := []string{"t-5", "t-4a", "t-4b", "t-2", "t-1"}
	for i, id := range ids {
		if err := store.SaveTask(taskAt("caller/1", id, mesh.TaskCompleted, times[i])); err != nil {
			t.Fatalf("SaveTask %s: %v", id, err)
		}
	}

	var seen []string
	var before time.Time
	var beforeID string
	for page := 0; page < 5; page++ {
		rows, err := store.ListTasks(mesh.TaskFilter{Caller: "caller/1", Limit: 1, Before: before, BeforeTaskID: beforeID})
		if err != nil {
			t.Fatalf("ListTasks page %d: %v", page, err)
		}
		if len(rows) == 0 {
			break
		}
		seen = append(seen, rows[0].TaskID)
		before, beforeID = rows[0].CreatedAt, rows[0].TaskID
	}
	want := []string{"t-1", "t-2", "t-4b", "t-4a", "t-5"} // newest first, task_id DESC within the tie
	if len(seen) != len(want) {
		t.Fatalf("pages produced %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("page order %v, want %v", seen, want)
		}
	}
}

func TestStubRoundTripAndListing(t *testing.T) {
	store := newTestStore(t)
	now := time.Now().UTC()
	if err := store.SaveTaskStub(mesh.TaskStub{
		TaskID: "stub-1", Target: "acme/edge", State: mesh.TaskWorking,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("SaveTaskStub: %v", err)
	}
	stub, ok, err := store.GetTaskStub("stub-1")
	if err != nil || !ok {
		t.Fatalf("GetTaskStub: ok=%v err=%v", ok, err)
	}
	if stub.Target != "acme/edge" || stub.State != mesh.TaskWorking {
		t.Fatalf("stub round trip: %+v", stub)
	}
	if err := store.SaveTaskStub(mesh.TaskStub{
		TaskID: "stub-2", Target: "other/edge", State: mesh.TaskCompleted,
		Result: []byte(`{"ok":true}`), CompletedSync: false,
		CreatedAt: now.Add(time.Second), UpdatedAt: now.Add(time.Second),
	}); err != nil {
		t.Fatalf("SaveTaskStub 2: %v", err)
	}
	rows, err := store.ListTaskStubs(time.Time{}, 10)
	if err != nil {
		t.Fatalf("ListTaskStubs: %v", err)
	}
	if len(rows) != 2 || rows[0].TaskID != "stub-2" {
		t.Fatalf("listing order wrong: %+v", rows)
	}
	count, err := store.CountTaskStubs()
	if err != nil || count != 2 {
		t.Fatalf("CountTaskStubs = %d, %v", count, err)
	}
}

func TestPruneTasksRemovesOnlyOldTerminalTasks(t *testing.T) {
	store := newTestStore(t)
	now := time.Now().UTC()
	old := now.Add(-8 * 24 * time.Hour)
	if err := store.SaveTask(taskAt("caller/1", "old-done", mesh.TaskCompleted, old)); err != nil {
		t.Fatalf("save old-done: %v", err)
	}
	if err := store.SaveTask(taskAt("caller/1", "old-working", mesh.TaskWorking, old)); err != nil {
		t.Fatalf("save old-working: %v", err)
	}
	if err := store.SaveTask(taskAt("caller/1", "new-done", mesh.TaskFailed, now)); err != nil {
		t.Fatalf("save new-done: %v", err)
	}
	pruned, err := store.PruneTasks(now.Add(-7 * 24 * time.Hour))
	if err != nil {
		t.Fatalf("PruneTasks: %v", err)
	}
	if pruned != 1 {
		t.Fatalf("pruned %d, want 1 (old terminal only)", pruned)
	}
	if _, ok, _ := store.GetTask("caller/1", "old-working"); !ok {
		t.Fatal("a non-terminal task must never be pruned, however old")
	}
	if _, ok, _ := store.GetTask("caller/1", "new-done"); !ok {
		t.Fatal("a terminal task inside the window must stay")
	}
}

// TestTaskInputFieldsSurviveTheRoundTrip pins the v1.5.19 input-protocol
// columns: the opt-in, the pending question, the resume conversation, and the
// question mirrored onto a caller stub.
func TestTaskInputFieldsSurviveTheRoundTrip(t *testing.T) {
	store := newTestStore(t)
	now := time.Now().UTC()
	paused := taskAt("caller/1", "asking-1", mesh.TaskInputRequired, now)
	paused.AllowInput = true
	paused.PendingInput = "which quarter?"
	paused.Conversation = "remote-task-conv-abc"
	if err := store.SaveTask(paused); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	got, ok, err := store.GetTask("caller/1", "asking-1")
	if err != nil || !ok {
		t.Fatalf("GetTask: ok=%v err=%v", ok, err)
	}
	if !got.AllowInput || got.PendingInput != "which quarter?" ||
		got.Conversation != "remote-task-conv-abc" {
		t.Fatalf("input fields were dropped: allow=%v pending=%q conversation=%q",
			got.AllowInput, got.PendingInput, got.Conversation)
	}

	stub := mesh.TaskStub{TaskID: "asking-1", Target: "acme/berlin/edge-1",
		State: mesh.TaskInputRequired, PendingInput: "which quarter?",
		CreatedAt: now, UpdatedAt: now}
	if err := store.SaveTaskStub(stub); err != nil {
		t.Fatalf("SaveTaskStub: %v", err)
	}
	stubAgain, ok, err := store.GetTaskStub("asking-1")
	if err != nil || !ok {
		t.Fatalf("GetTaskStub: ok=%v err=%v", ok, err)
	}
	if stubAgain.PendingInput != "which quarter?" {
		t.Fatalf("the stub dropped the pending question: %q", stubAgain.PendingInput)
	}
}

// TestTaskStoreMigratesTheInputColumns exercises the upgrade path from the
// v1.5.18 shape (stream and notify_url present, no input-protocol columns).
func TestTaskStoreMigratesTheInputColumns(t *testing.T) {
	database, err := db.Open(filepath.Join(t.TempDir(), "mesh-input-migration.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	oldTasks := `
CREATE TABLE mesh_tasks (
	caller_id          TEXT NOT NULL,
	task_id            TEXT NOT NULL,
	caller_fingerprint TEXT NOT NULL DEFAULT '',
	agent              TEXT NOT NULL DEFAULT '',
	operation          TEXT NOT NULL DEFAULT '',
	arguments_json     TEXT,
	state              TEXT NOT NULL,
	result_json        TEXT,
	error_code         TEXT NOT NULL DEFAULT '',
	error_message      TEXT NOT NULL DEFAULT '',
	trace_id           TEXT NOT NULL DEFAULT '',
	stream             INTEGER NOT NULL DEFAULT 0,
	created_at         TEXT NOT NULL,
	updated_at         TEXT NOT NULL,
	PRIMARY KEY (caller_id, task_id)
)`
	oldStubs := `
CREATE TABLE mesh_task_stubs (
	task_id        TEXT PRIMARY KEY,
	target         TEXT NOT NULL,
	skill          TEXT NOT NULL DEFAULT '',
	state          TEXT NOT NULL,
	result_json    TEXT,
	error_message  TEXT NOT NULL DEFAULT '',
	notify_url     TEXT NOT NULL DEFAULT '',
	completed_sync INTEGER NOT NULL DEFAULT 0,
	created_at     TEXT NOT NULL,
	updated_at     TEXT NOT NULL
)`
	for _, statement := range []string{oldTasks, oldStubs} {
		if _, err := database.Pool().Exec(statement); err != nil {
			t.Fatalf("create legacy table: %v", err)
		}
	}

	store, err := NewStore(database)
	if err != nil {
		t.Fatalf("NewStore over the v1.5.18 schema: %v", err)
	}
	now := time.Now().UTC()
	paused := taskAt("caller/1", "migrated-ask-1", mesh.TaskInputRequired, now)
	paused.AllowInput = true
	paused.PendingInput = "which plan?"
	paused.Conversation = "remote-task-conv-legacy"
	if err := store.SaveTask(paused); err != nil {
		t.Fatalf("SaveTask after migration: %v", err)
	}
	got, ok, err := store.GetTask("caller/1", "migrated-ask-1")
	if err != nil || !ok {
		t.Fatalf("GetTask after migration: ok=%v err=%v", ok, err)
	}
	if !got.AllowInput || got.PendingInput != "which plan?" ||
		got.Conversation != "remote-task-conv-legacy" {
		t.Fatalf("input fields did not survive the migrated schema: %+v", got)
	}

	stub := mesh.TaskStub{TaskID: "migrated-ask-1", Target: "acme/berlin/edge-1",
		State: mesh.TaskInputRequired, PendingInput: "which plan?",
		CreatedAt: now, UpdatedAt: now}
	if err := store.SaveTaskStub(stub); err != nil {
		t.Fatalf("SaveTaskStub after migration: %v", err)
	}
	if stubAgain, ok, _ := store.GetTaskStub("migrated-ask-1"); !ok ||
		stubAgain.PendingInput != "which plan?" {
		t.Fatalf("the stub's pending question did not survive migration: ok=%v pending=%q",
			ok, stubAgain.PendingInput)
	}
}
