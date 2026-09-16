package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/observability"
)

// SkillInvoke is the reserved skill a peer calls to reach a desktop agent behind
// this edge.
//
// The other served skills are read-only introspection; this one is the
// deliberate exception, and it exists because reaching an agent in another
// organisation is what the mesh is for. It is separable because it does not
// execute anything itself: it routes to a desktop agent, and every gate on what
// may be routed sits in front of it (see the Config fields and skillInvoke).
const SkillInvoke = "invoke"

// OperationTask asks a desktop agent to run a task with its own tool surface.
// This is the cross-organisation case: agent in org A asks agent in org B to do
// something, rather than merely asking what it is.
//
// It is the only operation shipped enabled. More can be added by name via
// -mesh-invoke-operations as the desktop grows handlers for them; the edge treats
// the name as opaque and never assumes a shape.
const OperationTask = "task"

// ErrAgentOffline reports that the target agent is not currently attached, so an
// invocation never reached it. Defined here rather than reused from the session
// package so the mesh keeps its independence from the desktop layers: the
// invoker translates its own errors into this one.
var ErrAgentOffline = errors.New("local agent is offline")

// DefaultInvokeTimeout bounds one remote invocation when none is configured.
//
// A zero timeout would mean "expire immediately", so every invocation against a
// Config built from literals rather than DefaultConfig would fail instantly and
// look like a broken desktop. Falling back to a real deadline keeps the failure
// mode honest.
//
// 3 minutes, not 1: the invocation is a synchronous agent turn, and the mesh's
// own guidance is that a real turn takes 10–60s+ — a 60s ceiling 4001'd turns
// that were still working fine (a skill load plus a tool round plus a provider
// call routinely crosses it, measured live on production edges). Callers can
// still narrow it per invoke with timeout_ms; hours-long work belongs to the
// async task API, not this path.
const DefaultInvokeTimeout = 3 * time.Minute

// InvokeInput is the payload of the invoke skill.
//
// Addressing is explicit and never defaulted. A caller names either one agent
// (target) or one capability, and an edge that has to guess which laptop to run
// a task on should refuse rather than choose.
type InvokeInput struct {
	// Target names an attached agent by id, or by the name an operator
	// configured, since that is what a caller from another organisation will
	// have seen in the directory.
	Target string `json:"target"`
	// Capability selects any online attached agent advertising it.
	Capability string `json:"capability"`
	// Operation names what to run, e.g. "task". Matched against the edge's
	// allowlist; an unknown name is refused.
	Operation string `json:"operation"`
	// Arguments is passed through to the operation untouched. The shape belongs
	// to the operation, so the edge does not model it.
	Arguments json.RawMessage `json:"arguments,omitempty"`
	// TimeoutMS optionally narrows the edge's own invocation timeout. It can only
	// tighten it, never extend it: a remote caller does not get to decide how long
	// this edge is willing to wait.
	TimeoutMS int64 `json:"timeout_ms,omitempty"`
	// Async turns the invoke into a task CREATE: the edge replies immediately
	// with a task handle and the run continues on its own. The caller may
	// disconnect; task.get and the task events are how it finds out what
	// happened. Text-based peers ignore the field, exactly as they ignore the
	// rest of the invoke input.
	Async bool `json:"async,omitempty"`
	// Stream, with Async, publishes the run's assistant-text growth as
	// ordered chunks on mesh.event.task.<id>.chunk (and answers tails through
	// task.get). Opt-in: the chunks share the plaintext posture of the rest of
	// the mesh — a dispatch's prompt and reply are already visible to whoever
	// can subscribe — but a task that does not ask streams nothing but states.
	Stream bool `json:"stream,omitempty"`
	// TaskID is the caller-minted task id. It is the idempotency key: a retried
	// CREATE with the same id returns the existing task instead of running the
	// work twice. Empty lets the edge mint one.
	TaskID string `json:"task_id,omitempty"`
	// AllowInput, with Async, opts the task into the input-request protocol:
	// the prompt tells the agent it may ask, and a reply ending in the
	// [[INPUT_REQUIRED: …]] marker pauses the task as input-required instead
	// of completing it. The caller then answers with task.input and the run
	// resumes. Opt-in for the same reason streaming is: an agent that has not
	// been told the convention must not have its questions reinterpreted.
	AllowInput bool `json:"allow_input,omitempty"`
	// ConversationID continues an existing conversation instead of starting
	// a fresh one — the session-persistence path. Pass the conversation_id a
	// previous reply returned and the run picks up where the last one ended:
	// the desktop continues its own conversation, and a headless worker is
	// rehydrated with the prior turns by the edge. Empty (the default)
	// starts a new conversation, exactly as before.
	ConversationID string `json:"conversation_id,omitempty"`
}

// InvokeOutput is returned to the caller on success.
type InvokeOutput struct {
	Agent     string          `json:"agent"`
	Operation string          `json:"operation"`
	Result    json.RawMessage `json:"result,omitempty"`
	// ConversationID is the conversation the run happened in. A caller that
	// wants the next invoke to continue this one passes it back as
	// conversation_id on the next request.
	ConversationID string `json:"conversation_id,omitempty"`
}

// codedError lets a skill choose the mesh error code a peer sees, instead of
// every failure collapsing into 5001.
//
// A peer branches on these codes — SKILL_NOT_FOUND and AGENT_UNAVAILABLE mean
// materially different things to an orchestrator than INTERNAL_ERROR — so the
// distinction has to survive the handler signature, which is why a handler can
// return one of these rather than only a plain error.
type codedError struct {
	code   int
	reason string
}

func (e *codedError) Error() string { return e.reason }

// coded builds a codedError for a handler to return.
func coded(code int, format string, args ...any) error {
	return &codedError{code: code, reason: fmt.Sprintf(format, args...)}
}

// LocalInvokeRequest is a verified remote invocation on its way to a desktop
// agent attached to this edge.
type LocalInvokeRequest struct {
	AgentID string
	TaskID  string
	// Caller is the verified mesh agent id of the requesting edge.
	Caller string
	// CallerFingerprint is the requesting edge's verified identity fingerprint.
	CallerFingerprint string
	Operation         string
	Arguments         json.RawMessage
	Timeout           time.Duration
	// AllowInput tells the transport the task opted into the input-request
	// protocol, so it appends TaskInputInstruction to the prompt it builds.
	AllowInput bool
	// ConversationID, when set, resumes the named desktop conversation instead
	// of minting a fresh one — the continuation path for an answered
	// input-required task. Empty starts a new conversation.
	ConversationID string
	// Progress, when set, receives the growth of the assistant's text as the
	// desktop commits conversation snapshots. Only a streaming task sets it;
	// the transport is free to ignore it (an ordinary invoke answers whole).
	Progress func(delta string)
}

// LocalInvokeResult is the desktop agent's answer.
type LocalInvokeResult struct {
	OK           bool
	Result       json.RawMessage
	ErrorCode    string
	ErrorMessage string
	// ConversationID is the desktop conversation the run happened in. The mesh
	// persists it on the task so an answered input-required task resumes in
	// place, with the agent's own question still in its context.
	ConversationID string
}

// LocalInvoker forwards an invocation to a desktop agent attached to this edge.
//
// Injected rather than imported, like LocalAgentProvider and for the same
// reason: the mesh package decides *whether* a remote caller may reach an agent,
// and knows nothing about *how* one is reached. Swapping the transport must not
// mean editing the policy.
type LocalInvoker interface {
	InvokeLocalAgent(ctx context.Context, request LocalInvokeRequest) (LocalInvokeResult, error)
}

// SetLocalInvoker installs the invoker used to reach desktop agents. Callable
// before Start; invocation stays unserved until it is set.
func (m *Manager) SetLocalInvoker(invoker LocalInvoker) {
	m.mu.Lock()
	m.localInvoker = invoker
	m.mu.Unlock()
}

func (m *Manager) localInvokerSnapshot() LocalInvoker {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.localInvoker
}

// registerInvokeSkill exposes remote invocation, subject to configuration.
//
// Kept in its own file and its own registration path rather than folded into
// registerBuiltinSkills: it is the only served skill with a side effect, and its
// gates should be readable in one place instead of lost among ping/describe.
func (m *Manager) registerInvokeSkill(agent *Agent) error {
	config := m.Config()
	if !config.AllowRemoteInvoke {
		return nil
	}
	// "Skills disabled" means this edge serves nothing, invocation included. That
	// flag is the operator's blunt instrument for taking the whole surface down,
	// and a skill with a side effect quietly surviving it would be the worst
	// possible exception to it.
	if !config.SkillsEnabled {
		return nil
	}
	// The skill allowlist is the operator's final say over what this edge serves.
	if !config.servesSkill(SkillInvoke) {
		return nil
	}
	agent.RegisterSkill(SkillInvoke, m.skillInvoke)
	return nil
}

// skillInvoke routes a verified remote invocation to a desktop agent.
//
// The gates are ordered cheapest-and-most-absolute first, and all of them fail
// closed. Note what is deliberately *not* here: nothing about the caller's claim
// to a name is trusted. meta.From and meta.CallerFingerprint are populated by
// this edge from the guard's verification, never from the payload, so a peer
// cannot forge the identity that a desktop agent will audit.
func (m *Manager) skillInvoke(ctx context.Context, input any, meta RequestMeta) (any, error) {
	config := m.Config()

	// Gate 1 — is the capability offered at all?
	if !config.AllowRemoteInvoke {
		return nil, coded(CodeGovernanceDenied, "this edge does not accept remote invocation")
	}

	// Gate 2 — was the caller's identity actually established?
	//
	// This is the gate that keeps "on by default" from meaning "open to anyone".
	// The shipping verify mode accepts unsigned envelopes, so without this check
	// a peer that never proved a key could drive a desktop machine.
	if config.RequireVerifiedInvoke && !meta.Verified {
		observability.Usage.MeshInvokeDeniedTotal.Add(1)
		m.logger.Warn("refused remote invocation from an unverified caller",
			"caller", meta.From, "task", meta.TaskID)
		return nil, coded(CodeGovernanceDenied,
			"caller %q did not present a verified identity, and this edge requires a signed, trusted caller to invoke an agent",
			meta.From)
	}

	request, err := decodeInvokeInput(input)
	if err != nil {
		return nil, err
	}

	// Gate 3 — is this operation exposed?
	if !config.servesOperation(request.Operation) {
		observability.Usage.MeshInvokeDeniedTotal.Add(1)
		if request.Async {
			// The caller asked for a durable object, so it gets one: the
			// refusal is recorded as a rejected task rather than evaporating
			// with the reply envelope.
			handle, herr := m.rejectAsyncTask(request, meta, CodeSkillNotFound,
				fmt.Sprintf("operation %q is not served by this edge", request.Operation))
			if herr != nil {
				return nil, herr
			}
			return handle, nil
		}
		return nil, coded(CodeSkillNotFound, "operation %q is not served by this edge", request.Operation)
	}

	// Gate 4 — which attached agent?
	agent, err := m.resolveInvokeTarget(request)
	if err != nil {
		if request.Async {
			// As above: an unusable target is a rejected task, not a lost one.
			code, reason := CodeAgentUnavailable, err.Error()
			var refusal *codedError
			if errors.As(err, &refusal) {
				code, reason = refusal.code, refusal.reason
			}
			handle, herr := m.rejectAsyncTask(request, meta, code, reason)
			if herr != nil {
				return nil, herr
			}
			return handle, nil
		}
		return nil, err
	}

	// The async branch: CREATE returns a handle in one reply and the run
	// continues on its own context, disconnected from the caller's. Everything
	// past this point is the original synchronous path.
	if request.Async {
		handle, herr := m.startAsyncTask(request, meta, agent)
		if herr != nil {
			return nil, herr
		}
		return handle, nil
	}

	invoker := m.localInvokerSnapshot()
	if invoker == nil {
		return nil, coded(CodeInternalError, "no local agent invoker is configured on this edge")
	}

	timeout := config.InvokeTimeout
	if timeout <= 0 {
		timeout = DefaultInvokeTimeout
	}
	// A caller may narrow the deadline but never extend it: how long this edge is
	// willing to wait is this edge's decision, not a remote peer's.
	if request.TimeoutMS > 0 {
		if requested := time.Duration(request.TimeoutMS) * time.Millisecond; requested < timeout {
			timeout = requested
		}
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	observability.Usage.MeshInvokeTotal.Add(1)
	result, err := invoker.InvokeLocalAgent(callCtx, LocalInvokeRequest{
		AgentID:           agent.ID,
		TaskID:            meta.TaskID,
		Caller:            meta.From,
		CallerFingerprint: meta.CallerFingerprint,
		Operation:         request.Operation,
		Arguments:         request.Arguments,
		Timeout:           timeout,
		ConversationID:    request.ConversationID,
	})
	if err != nil {
		observability.Usage.MeshInvokeFailedTotal.Add(1)
		m.logger.Warn("remote invocation failed",
			"agent", agent.ID, "caller", meta.From, "operation", request.Operation, "error", err)
		return nil, invokeErrorToMeshError(err, agent)
	}
	if !result.OK {
		observability.Usage.MeshInvokeFailedTotal.Add(1)
		m.logger.Info("remote invocation was refused by the agent",
			"agent", agent.ID, "caller", meta.From, "operation", request.Operation,
			"agent_error", result.ErrorCode)
		return nil, coded(invokeResponseCode(result.ErrorCode),
			"agent %q refused the task: %s", agent.ID, strings.TrimSpace(result.ErrorMessage))
	}

	m.logger.Info("remote invocation completed",
		"agent", agent.ID, "caller", meta.From, "operation", request.Operation, "task", meta.TaskID)

	return InvokeOutput{
		Agent:          agent.ID,
		Operation:      request.Operation,
		Result:         result.Result,
		ConversationID: result.ConversationID,
	}, nil
}

// decodeInvokeInput turns the skill payload into a typed request.
//
// The payload arrives as decoded JSON, so it is re-encoded to be decoded into a
// struct. That is the cost of a transport that models nothing about arguments;
// the alternative — reaching into a map[string]any — would silently ignore any
// field it did not know about.
func decodeInvokeInput(input any) (InvokeInput, error) {
	var request InvokeInput
	if input == nil {
		return request, coded(CodeInvalidEnvelope, "invoke requires an input object with an operation")
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return request, coded(CodeInvalidEnvelope, "invoke input is not encodable: %v", err)
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return request, coded(CodeInvalidEnvelope, "invoke input is malformed: %v", err)
	}
	request.Target = strings.TrimSpace(request.Target)
	request.Capability = strings.TrimSpace(request.Capability)
	request.Operation = strings.TrimSpace(request.Operation)
	request.ConversationID = strings.TrimSpace(request.ConversationID)
	return request, nil
}

// resolveInvokeTarget picks the attached agent an invocation is addressed to.
//
// Two modes, because they answer different questions: a target is "I know which
// machine", a capability is "any machine that can do this". Both being set is
// refused rather than resolved by precedence, because the caller meant one of
// them and silently ignoring the other would route the task somewhere they did
// not ask for.
func (m *Manager) resolveInvokeTarget(request InvokeInput) (LocalAgent, error) {
	agents := m.LocalAgents()

	switch {
	case request.Target != "" && request.Capability != "":
		return LocalAgent{}, coded(CodeInvalidEnvelope,
			"give either target or capability, not both")
	case request.Target != "":
		agent, ok := LocalAgentByID(agents, request.Target)
		if !ok {
			return LocalAgent{}, coded(CodeAgentUnavailable,
				"no agent %q is attached to this edge", request.Target)
		}
		if !agent.Online {
			return LocalAgent{}, coded(CodeAgentUnavailable, "agent %q is offline", agent.ID)
		}
		return agent, nil
	case request.Capability != "":
		agent, ok := LocalAgentByCapability(agents, request.Capability)
		if !ok {
			return LocalAgent{}, coded(CodeAgentUnavailable,
				"no online agent on this edge serves capability %q", request.Capability)
		}
		return agent, nil
	default:
		return LocalAgent{}, coded(CodeInvalidEnvelope,
			"invoke requires a target or a capability so the edge knows which agent to reach")
	}
}

// invokeErrorToMeshError maps a transport failure onto a mesh error code.
//
// A timeout becomes 4001 rather than 5001 so an orchestrator can tell "try
// again" from "this is broken", which is the whole point of the code table.
func invokeErrorToMeshError(err error, agent LocalAgent) error {
	switch {
	case errors.Is(err, ErrAgentOffline):
		return coded(CodeAgentUnavailable, "agent %q is not reachable", agent.ID)
	case errors.Is(err, context.DeadlineExceeded):
		return coded(CodeOverloaded, "agent %q did not answer within the invocation deadline", agent.ID)
	case errors.Is(err, context.Canceled):
		return coded(CodeOverloaded, "invocation of agent %q was cancelled", agent.ID)
	default:
		return coded(CodeInternalError, "agent %q could not be reached: %v", agent.ID, err)
	}
}

// invokeResponseCode maps a desktop-side failure code onto a mesh code.
//
// An unrecognised code becomes 5001 rather than being passed through: a peer
// should never receive a code this edge cannot justify, and inventing a
// plausible-looking one is worse than admitting the failure was internal.
func invokeResponseCode(code string) int {
	switch strings.ToLower(strings.TrimSpace(code)) {
	case "unsupported_operation", "skill_not_found", "unsupported":
		return CodeSkillNotFound
	case "agent_offline", "agent_unavailable", "offline":
		return CodeAgentUnavailable
	case "denied", "governance_denied", "forbidden":
		return CodeGovernanceDenied
	case "overloaded", "busy", "timeout":
		return CodeOverloaded
	case "invalid_request", "invalid":
		return CodeInvalidEnvelope
	case "internal":
		return CodeInternalError
	default:
		return CodeInternalError
	}
}
