package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/mesh"
)

// MeshStatus reports the bridge's health, identity and peers.
func MeshStatus(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, m.Status())
	}
}

// MeshHealth is the synapse_health tool as an endpoint.
func MeshHealth(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, m.Health())
	}
}

// MeshRegister refreshes this agent's registration with the registry.
func MeshRegister(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		manifest, err := m.Register(r.Context())
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, manifest)
	}
}

// MeshDiscover lists peers, optionally filtered by capability or skill.
func MeshDiscover(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		filter := mesh.DiscoverFilter{
			Capabilities: splitQueryList(r.URL.Query().Get("capabilities")),
			SkillIDs:     splitQueryList(r.URL.Query().Get("skillIds")),
			Availability: strings.TrimSpace(r.URL.Query().Get("availability")),
		}
		agents, err := m.Discover(r.Context(), filter)
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"count": len(agents), "agents": agents})
	}
}

type meshDispatchRequest struct {
	Target    string `json:"target"`
	Skill     string `json:"skill"`
	Input     any    `json:"input"`
	TimeoutMs int    `json:"timeoutMs"`
}

// MeshDispatch sends a skill request to another agent.
func MeshDispatch(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request meshDispatchRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if strings.TrimSpace(request.Target) == "" || strings.TrimSpace(request.Skill) == "" {
			writeError(w, http.StatusBadRequest, "target and skill are required")
			return
		}
		timeout := time.Duration(request.TimeoutMs) * time.Millisecond
		response, err := m.Dispatch(r.Context(), request.Target, request.Skill, request.Input, timeout)
		if err != nil {
			// A reply envelope may accompany a skill-level failure; return it so
			// the caller can read the mesh error code.
			if response != nil {
				writeJSON(w, http.StatusBadGateway, map[string]any{
					"error":    err.Error(),
					"response": response,
				})
				return
			}
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

type meshMailboxRequest struct {
	Target string `json:"target"`
	Skill  string `json:"skill"`
	Input  any    `json:"input"`
	TaskID string `json:"taskId"`
}

// MeshMailbox leaves a skill invocation in a peer's durable mailbox.
//
// Distinct from MeshDispatch on purpose: this returns as soon as the message is
// stored, not when the work is done, because a mailbox message cannot be
// answered. The 202 says so rather than implying a result is coming.
func MeshMailbox(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request meshMailboxRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if strings.TrimSpace(request.Target) == "" || strings.TrimSpace(request.Skill) == "" {
			writeError(w, http.StatusBadRequest, "target and skill are required")
			return
		}
		sequence, err := m.SendMailbox(r.Context(), request.Target, request.Skill, request.Input, request.TaskID)
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"accepted": true,
			"sequence": sequence,
			"target":   request.Target,
			"note":     "queued in the peer's durable mailbox; it is not answered, and is delivered at least once",
		})
	}
}

type meshEmitRequest struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// MeshEmit publishes an event onto the mesh.
func MeshEmit(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request meshEmitRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if strings.TrimSpace(request.Type) == "" {
			writeError(w, http.StatusBadRequest, "type is required")
			return
		}
		if err := m.Emit(r.Context(), request.Type, request.Data); err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"emitted": mesh.SubjectEventPrefix + request.Type})
	}
}

type meshSubscribeRequest struct {
	Subject string `json:"subject"`
}

// MeshSubscribe attaches an event subscription.
func MeshSubscribe(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request meshSubscribeRequest
		if r.Body != nil {
			// An empty body means "the whole event wildcard".
			_ = json.NewDecoder(r.Body).Decode(&request)
		}
		subscription, err := m.Subscribe(r.Context(), request.Subject)
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, subscription)
	}
}

// MeshEvents returns the recent event history.
func MeshEvents(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		events := m.Events()
		writeJSON(w, http.StatusOK, map[string]any{"count": len(events), "events": events})
	}
}

// MeshReputation returns the reputation snapshot.
func MeshReputation(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scores := m.Reputation()
		writeJSON(w, http.StatusOK, map[string]any{"count": len(scores), "agents": scores})
	}
}

type meshApprovalRequest struct {
	Target string `json:"target"`
	Skill  string `json:"skill"`
	Input  any    `json:"input"`
}

// MeshApprovals lists pending approvals, or opens a new one with POST.
func MeshApprovals(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			pending := m.PendingApprovals()
			writeJSON(w, http.StatusOK, map[string]any{"count": len(pending), "approvals": pending})
			return
		}
		var request meshApprovalRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if strings.TrimSpace(request.Target) == "" || strings.TrimSpace(request.Skill) == "" {
			writeError(w, http.StatusBadRequest, "target and skill are required")
			return
		}
		id := m.RequestApproval(request.Target, request.Skill, request.Input)
		writeJSON(w, http.StatusAccepted, map[string]any{"approvalId": id, "status": "pending"})
	}
}

type meshApprovalDecisionRequest struct {
	Approver string `json:"approver"`
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

// MeshApprovalDecision approves or denies a pending request.
func MeshApprovalDecision(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.PathValue("id"))
		if id == "" {
			writeError(w, http.StatusBadRequest, "approval id is required")
			return
		}
		var request meshApprovalDecisionRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if strings.TrimSpace(request.Approver) == "" {
			writeError(w, http.StatusBadRequest, "approver is required")
			return
		}
		if err := m.Approve(id, request.Approver, request.Decision, request.Reason); err != nil {
			// Deciding removes an approval from the pending set, so consult the
			// history first: an already-resolved id is a conflict, not a 404.
			if decided, ok := m.DecidedApproval(id); ok {
				writeError(w, http.StatusConflict, fmt.Sprintf("approval %q was already %s", id, decided.Status))
				return
			}
			if strings.Contains(err.Error(), "unknown approval") {
				writeError(w, http.StatusNotFound, err.Error())
				return
			}
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"approvalId": id, "status": "decided"})
	}
}

// MeshTrust lists the peer identities this gateway has accepted, so an operator
// can see who it will vouch for and spot an unexpected entry.
func MeshTrust(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		peers := m.TrustPeers()
		if peers == nil {
			// Encode an empty list rather than null: the UI iterates the field.
			peers = []mesh.PeerPin{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"count": len(peers), "peers": peers})
	}
}

// MeshApprovalHistory returns decided approvals: the audit trail of who approved
// or denied what, and why.
func MeshApprovalHistory(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		history := m.ApprovalHistory()
		if history == nil {
			history = []mesh.Approval{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"count": len(history), "approvals": history})
	}
}

type meshTaskCreateRequest struct {
	Target          string         `json:"target"`
	Skill           string         `json:"skill"`
	Input           map[string]any `json:"input"`
	TaskID          string         `json:"taskId"`
	Stream          bool           `json:"stream"`
	AllowInput      bool           `json:"allowInput"`
	NotifyURL       string         `json:"notifyUrl"`
	CreateTimeoutMs int64          `json:"createTimeoutMs"`
}

// MeshTaskCreate starts an async task on a peer and returns the handle.
//
// 202, not 200: like the mailbox, the reply is an acceptance, not a result —
// the caller is expected to poll, watch mesh.event.task.<id>, or pass
// refresh=true on the GET. A peer that has not adopted the task contract
// answers the old synchronous way, and that answer becomes an
// already-completed task, so every caller gets the same object shape.
func MeshTaskCreate(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request meshTaskCreateRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if strings.TrimSpace(request.Target) == "" {
			writeError(w, http.StatusBadRequest, "target is required")
			return
		}
		stub, err := m.CreateRemoteTask(r.Context(), mesh.CreateRemoteTaskParams{
			Target: request.Target,
			Skill:  request.Skill,
			Input:  request.Input,
			TaskID: request.TaskID,
			Stream: request.Stream,
			// The input opt-in rides to the peer exactly like the streaming
			// opt-in: the peer's agent is only told it may ask when the caller
			// can answer.
			AllowInput: request.AllowInput,
			// Operator input only: the URL is stored on the stub and never
			// carried to the peer, so a remote peer cannot aim this gateway's
			// POSTs anywhere.
			NotifyURL:     request.NotifyURL,
			CreateTimeout: time.Duration(request.CreateTimeoutMs) * time.Millisecond,
		})
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"task": stub,
			"note": "accepted: the task runs on the peer; poll GET /api/mesh/tasks/" +
				stub.TaskID + " (refresh=true fetches the current state from the peer)",
		})
	}
}

// MeshTaskList lists tasks this gateway knows: its own outgoing tasks (the
// default) or the tasks it executed for peers (role=executor).
//
// Cursor pagination: pass the last row's created_at as `before` (plus its
// task_id as `beforeId` for executor listings) to fetch the next page.
// role=executor accepts `caller` to scope to one tenant's tasks.
func MeshTaskList(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		limit := 50
		if parsed, err := strconv.Atoi(query.Get("limit")); err == nil && parsed > 0 && parsed <= 500 {
			limit = parsed
		}
		var before time.Time
		if raw := query.Get("before"); raw != "" {
			parsed, err := time.Parse(time.RFC3339Nano, raw)
			if err != nil {
				writeError(w, http.StatusBadRequest, "before must be an RFC3339 timestamp")
				return
			}
			before = parsed
		}
		if query.Get("role") == "executor" {
			filter := mesh.TaskFilter{
				Before:       before,
				BeforeTaskID: query.Get("beforeId"),
				Limit:        limit,
			}
			if caller := strings.TrimSpace(query.Get("caller")); caller != "" {
				filter.Caller = caller
			}
			if states := splitQueryList(query.Get("status")); len(states) > 0 {
				for _, state := range states {
					filter.States = append(filter.States, mesh.TaskState(state))
				}
			}
			tasks, err := m.ExecutorTasks(filter)
			if err != nil {
				writeMeshError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"count": len(tasks), "tasks": tasks})
			return
		}
		stubs, err := m.TaskStubs(before, limit)
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"count": len(stubs), "tasks": stubs})
	}
}

// MeshTaskGet returns one task. A stub (a task this gateway created on a
// peer) is the default; `caller` selects one of this edge's executed tasks,
// because executor records are keyed per tenant and may not be read without
// naming one. `tail=N` returns the task plus its recent chunk tail — the
// streaming view, which only the owning edge holds, so a stub with a tail is
// fetched from the peer.
func MeshTaskGet(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		taskID := strings.TrimSpace(r.PathValue("id"))
		if taskID == "" {
			writeError(w, http.StatusBadRequest, "task id is required")
			return
		}
		tail := 0
		if parsed, err := strconv.Atoi(r.URL.Query().Get("tail")); err == nil && parsed > 0 {
			if parsed > 128 {
				parsed = 128
			}
			tail = parsed
		}
		if caller := strings.TrimSpace(r.URL.Query().Get("caller")); caller != "" {
			task, ok, err := m.ExecutorTask(caller, taskID)
			if err != nil {
				writeMeshError(w, err)
				return
			}
			if !ok {
				writeError(w, http.StatusNotFound, fmt.Sprintf("no task %q for caller %q", taskID, caller))
				return
			}
			response := mesh.TaskWithChunks{Task: task}
			if tail > 0 {
				response.Chunks = m.TaskTail(caller, taskID, tail)
			}
			writeJSON(w, http.StatusOK, map[string]any{"task": response})
			return
		}
		stub, ok, err := m.TaskStubByID(taskID)
		if err != nil {
			writeMeshError(w, err)
			return
		}
		if !ok {
			writeError(w, http.StatusNotFound, fmt.Sprintf("no task %q", taskID))
			return
		}
		// Ask the owning edge for the freshest state — and, when a tail is
		// requested, the chunk view. The stub is this gateway's cache; the
		// peer's task.get is the truth, and a missed event should not make a
		// caller wait for a poll that says the wrong thing. A tail implies the
		// fetch, because only the owner holds the streamed chunks.
		var chunks []mesh.TaskChunk
		if refresh := r.URL.Query().Get("refresh") == "true" || tail > 0; refresh {
			refreshed, refreshedTask, err := m.RefreshTaskStub(r.Context(), taskID, tail)
			if err == nil {
				stub = refreshed
				chunks = refreshedTask.Chunks
			}
		}
		response := map[string]any{"task": stub}
		if len(chunks) > 0 {
			response["chunks"] = chunks
		}
		writeJSON(w, http.StatusOK, response)
	}
}

// MeshTaskCancel cancels a task. Outgoing (stub) tasks are canceled by
// dispatching task.cancel to the owning edge; executed tasks need `caller`,
// for the same reason as the GET.
func MeshTaskCancel(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		taskID := strings.TrimSpace(r.PathValue("id"))
		if taskID == "" {
			writeError(w, http.StatusBadRequest, "task id is required")
			return
		}
		if caller := strings.TrimSpace(r.URL.Query().Get("caller")); caller != "" {
			task, err := m.CancelLocalTask(caller, taskID)
			if err != nil {
				writeMeshError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"task": task})
			return
		}
		stub, err := m.CancelTaskByStub(r.Context(), taskID)
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"task": stub})
	}
}

type meshTaskInputRequest struct {
	Caller string          `json:"caller"`
	Input  json.RawMessage `json:"input"`
}

// MeshTaskInput answers an input-required task with new input.
//
// Two roles, like the cancel endpoint. With `caller` (body or query) this edge
// is the executor and the answer resumes the task it runs; without one, this
// edge is the caller and the answer is dispatched to the owning edge's
// task.input skill. Executor records are per-tenant, so the executor role
// requires the caller exactly as the executor GET, cancel and retry do.
func MeshTaskInput(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		taskID := strings.TrimSpace(r.PathValue("id"))
		if taskID == "" {
			writeError(w, http.StatusBadRequest, "task id is required")
			return
		}
		var request meshTaskInputRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		caller := strings.TrimSpace(request.Caller)
		if caller == "" {
			caller = strings.TrimSpace(r.URL.Query().Get("caller"))
		}
		if caller != "" {
			task, err := m.ResolveTaskInput(caller, taskID, request.Input)
			if err != nil {
				writeMeshError(w, err)
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{
				"task": task,
				"note": "resumed: the answer continues the task's conversation on the agent",
			})
			return
		}
		stub, err := m.SubmitTaskInput(r.Context(), taskID, request.Input)
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"task": stub,
			"note": "accepted: the answer was delivered to the owning edge; poll GET /api/mesh/tasks/" +
				stub.TaskID + " (refresh=true fetches the current state from the peer)",
		})
	}
}

// MeshTaskRetry re-runs one of this edge's failed or canceled tasks. Executor
// role only: the `caller` names the creating tenant, exactly as the executor
// GET and cancel do, because task records are keyed per caller and may not be
// acted on without naming one.
func MeshTaskRetry(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		taskID := strings.TrimSpace(r.PathValue("id"))
		if taskID == "" {
			writeError(w, http.StatusBadRequest, "task id is required")
			return
		}
		caller := strings.TrimSpace(r.URL.Query().Get("caller"))
		if caller == "" {
			writeError(w, http.StatusBadRequest, "caller is required (executor tasks are per-tenant)")
			return
		}
		task, err := m.RetryTask(caller, taskID)
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"task": task,
			"note": "requeued: the task runs again under its original id and settings",
		})
	}
}

// writeMeshError maps mesh failures onto HTTP status codes.
func writeMeshError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, mesh.ErrNotConnected):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, mesh.ErrApprovalDenied), errors.Is(err, mesh.ErrApprovalExpired):
		writeError(w, http.StatusForbidden, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}

// splitQueryList parses a comma-separated query parameter into a list.
func splitQueryList(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
