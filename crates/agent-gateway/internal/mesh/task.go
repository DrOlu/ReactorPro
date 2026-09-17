package mesh

// The mesh task lifecycle.
//
// Dispatch today is an opaque request→reply: the caller holds a connection for
// the whole turn and receives one final answer. That caps the mesh at
// "ask a peer and wait", which breaks down exactly where the mesh is most
// useful — a real agent turn takes minutes, no serverless platform permits a
// ten-minute HTTP call, and a caller who times out learns nothing about what
// the peer did with the work.
//
// Tasks change the unit of work from "a reply" to "an object with a state":
//
//	CREATE (async invoke, caller-minted task id)
//	  → queued → working → completed | failed | canceled | rejected
//	              ↘ input-required ↗
//
// The creating caller can disconnect the moment it holds the handle, ask
// `task.get` later (only its own tasks — the caller id is part of the key, and
// it comes from the guard, never the payload), list its tasks page by page, and
// cancel. Every transition is published as a state-only event on
// `mesh.event.task.<id>`, so a caller that stays connected can watch progress
// without polling; the result itself never rides an event, because events are
// broadcast to whoever subscribes and results are the caller's business.
//
// Idempotency is the point of the caller-minted id: CREATE with a task id this
// caller already used returns the existing task instead of running the work
// twice. A retry can no longer duplicate a side effect — the property the
// durable mailbox refuses `invoke` for lacking.

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Task states, aligned with the A2A task model so the vocabulary is one the
// wider ecosystem already agrees on.
type TaskState string

const (
	// TaskQueued: accepted, not yet started. Brief — the run begins immediately
	// unless the edge is starting up.
	TaskQueued TaskState = "queued"
	// TaskWorking: the peer's agent is running the turn.
	TaskWorking TaskState = "working"
	// TaskInputRequired: the turn needs input from the creating caller before it
	// can proceed. Surfacing the executor's approval/clarify gates is the
	// reason this state exists.
	TaskInputRequired TaskState = "input-required"
	// TaskCompleted: terminal, success. The result is in Result.
	TaskCompleted TaskState = "completed"
	// TaskFailed: terminal, the turn ran and did not succeed.
	TaskFailed TaskState = "failed"
	// TaskCanceled: terminal, the creating caller (or the operator) stopped it.
	TaskCanceled TaskState = "canceled"
	// TaskRejected: terminal without running — a policy or gate refusal at task
	// level (unknown operation, agent offline at creation, governance).
	TaskRejected TaskState = "rejected"
)

// TaskTerminal reports whether a state admits no further transitions.
func TaskTerminal(state TaskState) bool {
	switch state {
	case TaskCompleted, TaskFailed, TaskCanceled, TaskRejected:
		return true
	}
	return false
}

// taskTransitions is the whole state machine: where an edge may go from here.
// Everything else is refused, so a redelivered or racing update cannot move a
// finished task backwards.
var taskTransitions = map[TaskState][]TaskState{
	TaskQueued:        {TaskWorking, TaskInputRequired, TaskCanceled, TaskRejected},
	TaskWorking:       {TaskInputRequired, TaskCompleted, TaskFailed, TaskCanceled},
	TaskInputRequired: {TaskWorking, TaskCanceled, TaskFailed},
	// Terminal states map to nothing.
}

// CanTransitionTask reports whether from → to is a legal edge.
func CanTransitionTask(from, to TaskState) bool {
	for _, next := range taskTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// shouldApplyStubState reports whether a caller-side stub may take a
// peer-reported state. Same-state updates are allowed (they refresh
// timestamps and error text). Terminal stubs refuse every other state —
// finishTask already decided the outcome, and a racing task.input reply is
// a snapshot of "working" taken before launchTaskRun published completed.
func shouldApplyStubState(current, reported TaskState) bool {
	if current == reported {
		return true
	}
	if TaskTerminal(current) {
		return false
	}
	return CanTransitionTask(current, reported)
}

// ErrTaskState is the refusal an illegal transition returns.
var ErrTaskState = errors.New("task state transition is not allowed")

// ErrTaskNotFound is the scoped refusal for a task this caller has no record
// of — indistinguishable from "never existed", because another tenant's task
// existing is that tenant's information to give.
var ErrTaskNotFound = errors.New("no task for this caller")

// Task is one unit of remote work held by the edge that executes it.
//
// The primary key is (Caller, TaskID) — the caller's id from the guard's
// verification, and the caller-minted task id. Two callers may use the same
// task id without colliding, and a task is only ever read back by the caller
// that created it, which is what makes multi-tenant listing safe: every query
// is scoped by caller identity rather than trusting a caller-supplied filter.
type Task struct {
	TaskID            string          `json:"task_id"`
	Caller            string          `json:"caller"`
	CallerFingerprint string          `json:"caller_fingerprint,omitempty"`
	Agent             string          `json:"agent,omitempty"`
	Operation         string          `json:"operation,omitempty"`
	Arguments         json.RawMessage `json:"arguments,omitempty"`
	State             TaskState       `json:"state"`
	Result            json.RawMessage `json:"result,omitempty"`
	ErrorCode         string          `json:"error_code,omitempty"`
	ErrorMessage      string          `json:"error_message,omitempty"`
	TraceID           string          `json:"trace_id,omitempty"`
	// Stream records that this task opted into chunked streaming, so a task
	// record says where its progress view lives.
	Stream bool `json:"stream,omitempty"`
	// AllowInput records that the task opted into the input-request protocol:
	// the prompt told the agent it may ask, and a reply carrying the marker
	// pauses the task instead of completing it.
	AllowInput bool `json:"allow_input,omitempty"`
	// PendingInput is the question a paused task is waiting on. The caller
	// answers it with task.input / POST …/input; the run resumes in the same
	// desktop conversation, so the agent keeps its own context.
	PendingInput string `json:"pending_input,omitempty"`
	// Conversation is the desktop conversation the run lives in. It is what
	// makes an answered task resume in place rather than start over: the
	// desktop agent sees its own question and the requester's answer together.
	Conversation string    `json:"conversation,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// The input-request convention. A task created with allow_input carries the
// instruction in its prompt; an agent that cannot finish without asking ends
// its reply with the marker line, and the edge turns that into a paused task
// rather than a completed one. The line is deliberately machine-shaped — one
// exact spelling, its own line — so an agent asking a question in prose never
// pauses a task by accident.
const (
	// taskInputMarkerPrefix opens the marker line; the line closes with "]]".
	taskInputMarkerPrefix = "[[INPUT_REQUIRED:"
	// TaskInputInstruction is appended to a task's prompt when the task opted
	// into input. Exported because the local invoker appends it — the
	// convention belongs to the mesh, so the text lives in one place.
	TaskInputInstruction = "\n\n---\n" +
		"If you need more information from the requester before you can complete this task, " +
		"ask your question, then END your reply with this exact final line:\n" +
		"[[INPUT_REQUIRED: your question]]\n" +
		"The requester's answer will continue this task; do not use the line unless you " +
		"genuinely cannot proceed, and never place it mid-reply."
)

// extractTaskInputRequest finds the marker line in an agent's reply and returns
// the question it carries. The last marker wins: an agent that asked twice is
// waiting on its newest question. An empty question is not a request — an
// agent that emitted the bare marker is treated as having answered normally.
func extractTaskInputRequest(text string) (string, bool) {
	question, found := "", false
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, taskInputMarkerPrefix) || !strings.HasSuffix(trimmed, "]]") {
			continue
		}
		inner := strings.TrimSpace(
			strings.TrimSuffix(strings.TrimPrefix(trimmed, taskInputMarkerPrefix), "]]"))
		if inner != "" {
			question, found = inner, true
		}
	}
	return question, found
}

// TaskHandle is the immediate answer to an async CREATE — small on purpose,
// because it is all the caller needs to come back for the rest.
type TaskHandle struct {
	TaskID    string    `json:"task_id"`
	State     TaskState `json:"state"`
	CreatedAt time.Time `json:"created_at"`
	// GetTask names the skill to query the task, so a caller that does not know
	// the contract can still discover how to follow up.
	GetTask string `json:"get_task"`
	// Note carries the one operational fact a caller needs: the work continues
	// whether or not the caller stays connected.
	Note string `json:"note,omitempty"`
}

// TaskStub is the caller-side record: "a task I created on a peer". It is not
// the source of truth — the executing edge holds that — but it is what makes
// listing and pagination answerable locally, and what the task events keep
// fresh. Stubs survive restarts because they are the caller's only memory of
// work it handed to another organisation.
type TaskStub struct {
	TaskID       string          `json:"task_id"`
	Target       string          `json:"target"`
	Skill        string          `json:"skill,omitempty"`
	State        TaskState       `json:"state"`
	Result       json.RawMessage `json:"result,omitempty"`
	ErrorMessage string          `json:"error_message,omitempty"`
	// NotifyURL is where this task's terminal state is pushed. Local operator
	// input only — set through the REST create, never read from a remote
	// peer's invoke input, because a peer-supplied URL would let anyone who
	// can dispatch a task aim this gateway's POSTs at internal addresses.
	NotifyURL string `json:"notify_url,omitempty"`
	// CompletedSync records that the peer answered the old synchronous way —
	// an unupgraded edge or a text-based bridge — so the handle and the answer
	// arrived in one reply. The caller still gets a completed task object.
	CompletedSync bool `json:"completed_sync,omitempty"`
	// PendingInput mirrors the owning edge's question when the task is
	// input-required, so the caller can ask its human the right thing without
	// a second round trip.
	PendingInput string    `json:"pending_input,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// TaskFilter narrows a task listing. Cursor pagination: (Before, BeforeTaskID)
// is the previous page's last row; rows strictly older than that pair are
// returned. The two-part cursor is exact under ties, and stable under
// concurrent inserts, unlike OFFSET.
type TaskFilter struct {
	Caller string
	States []TaskState
	Before time.Time
	// BeforeTaskID is the task-id half of the cursor; empty compares on time
	// alone, which is correct for the first page.
	BeforeTaskID string
	Limit        int
}

// TaskStore is durable storage for tasks and stubs.
//
// Injected like StateStore, but with the opposite failure contract: this store
// is load-bearing, not a cache. Losing a trust pin re-learns; losing a task
// result loses the work. Creation therefore fails loudly when the store is
// unavailable rather than pretending the task will be findable later.
type TaskStore interface {
	// SaveTask inserts or updates a task, keyed by (caller, task id).
	SaveTask(task Task) error
	// GetTask returns one task by caller and task id.
	GetTask(caller, taskID string) (Task, bool, error)
	// ListTasks returns tasks newest-first, filtered and cursor-paginated.
	ListTasks(filter TaskFilter) ([]Task, error)
	// PruneTasks deletes terminal tasks last updated before the cutoff,
	// returning how many went.
	PruneTasks(cutoff time.Time) (int64, error)

	// SaveTaskStub inserts or updates a caller-side stub.
	SaveTaskStub(stub TaskStub) error
	// GetTaskStub returns one stub by task id.
	GetTaskStub(taskID string) (TaskStub, bool, error)
	// ListTaskStubs returns stubs newest-first, cursor-paginated.
	ListTaskStubs(before time.Time, limit int) ([]TaskStub, error)
	// CountTaskStubs reports how many stubs exist, for the status snapshot.
	CountTaskStubs() (int64, error)
}

// taskEvent is the state-only payload published on mesh.event.task.<id>.
// No result content: events go to whoever subscribes, results go to the
// caller that earned them.
type taskEvent struct {
	TaskID       string    `json:"task_id"`
	Caller       string    `json:"caller"`
	State        TaskState `json:"state"`
	UpdatedAt    time.Time `json:"updated_at"`
	ErrorCode    string    `json:"error_code,omitempty"`
	ErrorMessage string    `json:"error_message,omitempty"`
}

// validateTaskID keeps a caller-minted id from smuggling subject tokens or
// oversized junk into the event subject (mesh.event.task.<id> is addressable,
// so the id becomes part of a NATS subject). '.' is excluded on purpose: it
// would deepen the subject, and the subscription pattern matches one token.
func validateTaskID(taskID string) error {
	trimmed := strings.TrimSpace(taskID)
	if trimmed == "" {
		return errors.New("task id is required")
	}
	if len(trimmed) > 128 {
		return errors.New("task id is longer than 128 characters")
	}
	for _, r := range trimmed {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == ':', r == '/':
		default:
			return fmt.Errorf("task id contains a character not allowed in a subject token: %q", r)
		}
	}
	return nil
}

// TaskEventSubject is where a task's state events are published.
func TaskEventSubject(taskID string) string {
	return SubjectEventPrefix + "task." + taskID
}
