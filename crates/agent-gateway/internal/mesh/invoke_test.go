package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// invokeTestManager builds a manager with a fixed directory and no network.
//
// The invoke path is deliberately testable without NATS: the routing decision and
// the transport are separate, so the policy can be exercised directly rather than
// only through an integration test that has to stand up a server first.
func invokeTestManager(t *testing.T, agents []LocalAgent, mutate func(*Config)) *Manager {
	t.Helper()
	config := DefaultConfig()
	config.Enabled = true
	config.AgentID = "test/edge"
	if mutate != nil {
		mutate(&config)
	}
	manager := NewManager(config, slog.New(slog.NewTextHandler(io.Discard, nil)))
	manager.SetLocalAgentsProvider(func() []LocalAgent { return agents })
	return manager
}

// verifiedCaller is the meta produced when the guard established the sender's
// identity — the only shape that may reach a desktop agent when the floor is on.
func verifiedCaller() RequestMeta {
	return RequestMeta{
		TaskID:            "task-1",
		From:              "acme/lagos/edge-1",
		Verified:          true,
		CallerFingerprint: "sha256:aaaa1111bbbb2222",
	}
}

// unverifiedCaller is the meta produced when the envelope passed the guard but
// nothing about its sender was proven: unsigned under the prefer mode, or any
// envelope under verify-off.
func unverifiedCaller() RequestMeta {
	return RequestMeta{TaskID: "task-1", From: "acme/lagos/edge-1"}
}

// codeOf asserts an error carries a specific mesh code, since a plain error
// would reach the peer as 5001 and lose the distinction that matters.
func codeOf(t *testing.T, err error) int {
	t.Helper()
	if err == nil {
		t.Fatal("want an error, got nil")
	}
	var refusal *codedError
	if !errors.As(err, &refusal) {
		t.Fatalf("error %v is %T, want *codedError so the peer receives a specific code", err, err)
	}
	return refusal.code
}

// recordingInvoker captures what the mesh asked the transport to do.
type recordingInvoker struct {
	requests []LocalInvokeRequest
	result   LocalInvokeResult
	err      error
	// block makes the invoker wait for its context, so deadline behaviour can be
	// tested without a real desktop.
	block bool
}

func (r *recordingInvoker) InvokeLocalAgent(ctx context.Context, request LocalInvokeRequest) (LocalInvokeResult, error) {
	r.requests = append(r.requests, request)
	if r.block {
		<-ctx.Done()
		return LocalInvokeResult{}, ctx.Err()
	}
	return r.result, r.err
}

// invokeAgents is a directory with a mix of online, offline and capability shapes.
// Sorted order (online first, then by id) is agent-1, agent-2, agent-3.
func invokeAgents() []LocalAgent {
	return []LocalAgent{
		{ID: "agent-2", Name: "reception", Online: true, Capabilities: []string{OperationTask}},
		{ID: "agent-1", Name: "Billing", Online: true, Capabilities: []string{OperationTask, "billing"}},
		{ID: "agent-3", Name: "nightshift", Online: false, Capabilities: []string{OperationTask, "nightly"}},
	}
}

// ---------------------------------------------------------------------------
// End-to-end through the handler
// ---------------------------------------------------------------------------

func TestSkillInvokeReachesTheAddressedAgent(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{
		OK:     true,
		Result: json.RawMessage(`{"summary":"done"}`),
	}}
	manager := invokeTestManager(t, invokeAgents(), nil)
	manager.SetLocalInvoker(invoker)

	output, err := manager.skillInvoke(t.Context(), map[string]any{
		"target":    "agent-2",
		"operation": OperationTask,
		"arguments": map[string]any{"prompt": "file the report"},
	}, verifiedCaller())
	if err != nil {
		t.Fatalf("skillInvoke: %v", err)
	}

	result, ok := output.(InvokeOutput)
	if !ok {
		t.Fatalf("output = %T, want InvokeOutput", output)
	}
	if result.Agent != "agent-2" || result.Operation != OperationTask {
		t.Fatalf("output = %+v, want agent-2/%s", result, OperationTask)
	}
	if string(result.Result) != `{"summary":"done"}` {
		t.Fatalf("result = %s, want the agent's payload", result.Result)
	}

	if len(invoker.requests) != 1 {
		t.Fatalf("invoker saw %d requests, want 1", len(invoker.requests))
	}
	sent := invoker.requests[0]
	if sent.AgentID != "agent-2" {
		t.Fatalf("invoker agent = %q, want agent-2", sent.AgentID)
	}
	// The verified identity must travel, because it is what the desktop audits.
	if sent.Caller != "acme/lagos/edge-1" || sent.CallerFingerprint != "sha256:aaaa1111bbbb2222" {
		t.Fatalf("invoker caller = %q/%q, want the verified identity",
			sent.Caller, sent.CallerFingerprint)
	}
	if sent.TaskID != "task-1" {
		t.Fatalf("invoker task = %q, want task-1", sent.TaskID)
	}
	if !json.Valid(sent.Arguments) || string(sent.Arguments) != `{"prompt":"file the report"}` {
		t.Fatalf("invoker arguments = %s, want the caller's arguments", sent.Arguments)
	}
}

// A caller that names a capability rather than an agent is asking "any machine
// that can do this", and must land on a deterministic, online one.
func TestSkillInvokeByCapability(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true, Result: json.RawMessage(`{}`)}}
	manager := invokeTestManager(t, invokeAgents(), nil)
	manager.SetLocalInvoker(invoker)

	if _, err := manager.skillInvoke(t.Context(), map[string]any{
		"capability": "billing",
		"operation":  OperationTask,
	}, verifiedCaller()); err != nil {
		t.Fatalf("skillInvoke by capability: %v", err)
	}

	if len(invoker.requests) != 1 || invoker.requests[0].AgentID != "agent-1" {
		t.Fatalf("requests = %+v, want the only online agent advertising billing", invoker.requests)
	}
}

// An agent that advertises a capability but is offline must not be chosen: the
// invocation would only fail after the caller had waited out the deadline.
func TestSkillInvokeSkipsOfflineAgentsForCapability(t *testing.T) {
	manager := invokeTestManager(t, invokeAgents(), nil)
	manager.SetLocalInvoker(&recordingInvoker{result: LocalInvokeResult{OK: true}})

	_, err := manager.skillInvoke(t.Context(), map[string]any{
		"capability": "nightly",
		"operation":  OperationTask,
	}, verifiedCaller())

	if code := codeOf(t, err); code != CodeAgentUnavailable {
		t.Fatalf("code = %d, want %d (AGENT_UNAVAILABLE)", code, CodeAgentUnavailable)
	}
}

// The caller's identity is established by this edge's guard and is carried to the
// desktop from meta. Nothing in the request payload can influence it, so a peer
// cannot forge the identity that ends up in another organisation's audit log.
func TestSkillInvokeCannotForgeTheCallerIdentity(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true, Result: json.RawMessage(`{}`)}}
	manager := invokeTestManager(t, invokeAgents(), nil)
	manager.SetLocalInvoker(invoker)

	// A hostile payload naming itself as a different, more privileged caller.
	if _, err := manager.skillInvoke(t.Context(), map[string]any{
		"target":             "agent-1",
		"operation":          OperationTask,
		"caller":             "globex/berlin/edge-1",
		"caller_fingerprint": "sha256:deadbeefdeadbeef",
	}, verifiedCaller()); err != nil {
		t.Fatalf("skillInvoke: %v", err)
	}

	sent := invoker.requests[0]
	if sent.Caller != "acme/lagos/edge-1" {
		t.Fatalf("caller = %q, want the verified caller, not the payload's claim", sent.Caller)
	}
	if sent.CallerFingerprint != "sha256:aaaa1111bbbb2222" {
		t.Fatalf("fingerprint = %q, want the verified fingerprint, not the payload's claim", sent.CallerFingerprint)
	}
}

// The deadline is this edge's decision. A caller may narrow it, never extend it.
func TestSkillInvokeDeadlineCanBeNarrowedButNotExtended(t *testing.T) {
	t.Run("narrows", func(t *testing.T) {
		invoker := &recordingInvoker{block: true}
		manager := invokeTestManager(t, invokeAgents(), func(cfg *Config) {
			cfg.InvokeTimeout = 30 * time.Second
		})
		manager.SetLocalInvoker(invoker)

		_, err := manager.skillInvoke(t.Context(), map[string]any{
			"target":     "agent-1",
			"operation":  OperationTask,
			"timeout_ms": 5,
		}, verifiedCaller())

		if code := codeOf(t, err); code != CodeOverloaded {
			t.Fatalf("code = %d, want %d (OVERLOADED, retryable) for a timed-out invocation",
				code, CodeOverloaded)
		}
		if len(invoker.requests) != 1 {
			t.Fatalf("invoker saw %d requests, want 1", len(invoker.requests))
		}
		if got := invoker.requests[0].Timeout; got >= 30*time.Second {
			t.Fatalf("timeout = %s, want the caller's narrower 5ms", got)
		}
	})

	t.Run("cannot extend", func(t *testing.T) {
		invoker := &recordingInvoker{result: LocalInvokeResult{OK: true, Result: json.RawMessage(`{}`)}}
		manager := invokeTestManager(t, invokeAgents(), func(cfg *Config) {
			cfg.InvokeTimeout = 2 * time.Second
		})
		manager.SetLocalInvoker(invoker)

		if _, err := manager.skillInvoke(t.Context(), map[string]any{
			"target":     "agent-1",
			"operation":  OperationTask,
			"timeout_ms": int64(time.Hour / time.Millisecond),
		}, verifiedCaller()); err != nil {
			t.Fatalf("skillInvoke: %v", err)
		}

		if got := invoker.requests[0].Timeout; got != 2*time.Second {
			t.Fatalf("timeout = %s, want the edge's own 2s despite the caller asking for an hour", got)
		}
	})
}

// A zero InvokeTimeout (a Config built from literals) must not mean "expire
// immediately", which would make every invocation look like a broken desktop.
func TestSkillInvokeFallsBackToADefaultDeadline(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{OK: true, Result: json.RawMessage(`{}`)}}
	manager := invokeTestManager(t, invokeAgents(), func(cfg *Config) {
		cfg.InvokeTimeout = 0
	})
	manager.SetLocalInvoker(invoker)

	if _, err := manager.skillInvoke(t.Context(), map[string]any{
		"target":    "agent-1",
		"operation": OperationTask,
	}, verifiedCaller()); err != nil {
		t.Fatalf("skillInvoke with an unset timeout: %v", err)
	}
	if got := invoker.requests[0].Timeout; got != DefaultInvokeTimeout {
		t.Fatalf("timeout = %s, want the default %s", got, DefaultInvokeTimeout)
	}
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

// TestSkillInvokeGates is the refusal table. Every row is a way an invocation
// must not reach a desktop agent, and the code the peer should see for it.
func TestSkillInvokeGates(t *testing.T) {
	success := LocalInvokeResult{OK: true, Result: json.RawMessage(`{}`)}

	cases := []struct {
		name    string
		mutate  func(*Config)
		input   any
		meta    RequestMeta
		invoker LocalInvoker
		want    int
	}{
		{
			name:    "invocation disabled on this edge",
			mutate:  func(cfg *Config) { cfg.AllowRemoteInvoke = false },
			input:   map[string]any{"target": "agent-1", "operation": OperationTask},
			meta:    verifiedCaller(),
			invoker: &recordingInvoker{result: success},
			want:    CodeGovernanceDenied,
		},
		{
			name:    "caller identity was not verified",
			input:   map[string]any{"target": "agent-1", "operation": OperationTask},
			meta:    unverifiedCaller(),
			invoker: &recordingInvoker{result: success},
			want:    CodeGovernanceDenied,
		},
		{
			name: "verification explicitly not required, so an unverified caller is allowed",
			mutate: func(cfg *Config) {
				cfg.RequireVerifiedInvoke = false
			},
			input:   map[string]any{"target": "agent-1", "operation": OperationTask},
			meta:    unverifiedCaller(),
			invoker: &recordingInvoker{result: success},
			want:    0, // reaching the invoker is the assertion
		},
		{
			name:    "operation is not exposed",
			input:   map[string]any{"target": "agent-1", "operation": "shell"},
			meta:    verifiedCaller(),
			invoker: &recordingInvoker{result: success},
			want:    CodeSkillNotFound,
		},
		{
			name: "operation exposed by configuration",
			mutate: func(cfg *Config) {
				cfg.InvokeOperations = []string{OperationTask, "shell"}
			},
			input:   map[string]any{"target": "agent-1", "operation": "shell"},
			meta:    verifiedCaller(),
			invoker: &recordingInvoker{result: success},
			want:    0,
		},
		{
			name:    "no target and no capability",
			input:   map[string]any{"operation": OperationTask},
			meta:    verifiedCaller(),
			invoker: &recordingInvoker{result: success},
			want:    CodeInvalidEnvelope,
		},
		{
			name:    "target and capability together",
			input:   map[string]any{"target": "agent-1", "capability": "billing", "operation": OperationTask},
			meta:    verifiedCaller(),
			invoker: &recordingInvoker{result: success},
			want:    CodeInvalidEnvelope,
		},
		{
			name:    "unknown target",
			input:   map[string]any{"target": "agent-nope", "operation": OperationTask},
			meta:    verifiedCaller(),
			invoker: &recordingInvoker{result: success},
			want:    CodeAgentUnavailable,
		},
		{
			name:    "target is offline",
			input:   map[string]any{"target": "agent-3", "operation": OperationTask},
			meta:    verifiedCaller(),
			invoker: &recordingInvoker{result: success},
			want:    CodeAgentUnavailable,
		},
		{
			name:    "no input at all",
			input:   nil,
			meta:    verifiedCaller(),
			invoker: &recordingInvoker{result: success},
			want:    CodeInvalidEnvelope,
		},
		{
			name:    "no invoker installed",
			input:   map[string]any{"target": "agent-1", "operation": OperationTask},
			meta:    verifiedCaller(),
			invoker: nil,
			want:    CodeInternalError,
		},
		{
			name:    "the agent refused the task",
			input:   map[string]any{"target": "agent-1", "operation": OperationTask},
			meta:    verifiedCaller(),
			invoker: &recordingInvoker{result: LocalInvokeResult{OK: false, ErrorCode: "unsupported_operation", ErrorMessage: "no handler"}},
			want:    CodeSkillNotFound,
		},
		{
			name:    "the agent could not be reached",
			input:   map[string]any{"target": "agent-1", "operation": OperationTask},
			meta:    verifiedCaller(),
			invoker: &recordingInvoker{err: ErrAgentOffline},
			want:    CodeAgentUnavailable,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			manager := invokeTestManager(t, invokeAgents(), testCase.mutate)
			manager.SetLocalInvoker(testCase.invoker)

			output, err := manager.skillInvoke(t.Context(), testCase.input, testCase.meta)
			if testCase.want == 0 {
				if err != nil {
					t.Fatalf("want the invocation to be allowed, got %v", err)
				}
				if _, ok := output.(InvokeOutput); !ok {
					t.Fatalf("output = %T, want InvokeOutput", output)
				}
				return
			}
			if code := codeOf(t, err); code != testCase.want {
				t.Fatalf("code = %d (%v), want %d", code, err, testCase.want)
			}
		})
	}
}

// Registration is a gate too: a skill that is never registered cannot be called
// even if a peer guesses its name.
func TestRegisterInvokeSkill(t *testing.T) {
	cases := []struct {
		name      string
		mutate    func(*Config)
		wantSkill bool
	}{
		{
			name:      "served by default",
			wantSkill: true,
		},
		{
			name:      "invocation disabled",
			mutate:    func(cfg *Config) { cfg.AllowRemoteInvoke = false },
			wantSkill: false,
		},
		{
			name:      "all skills disabled",
			mutate:    func(cfg *Config) { cfg.SkillsEnabled = false },
			wantSkill: false,
		},
		{
			name:      "allowlist excludes invoke",
			mutate:    func(cfg *Config) { cfg.SkillAllowlist = []string{SkillPing} },
			wantSkill: false,
		},
		{
			name:      "allowlist includes invoke",
			mutate:    func(cfg *Config) { cfg.SkillAllowlist = []string{SkillPing, SkillInvoke} },
			wantSkill: true,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			manager := invokeTestManager(t, invokeAgents(), testCase.mutate)
			agent := NewAgent(manager.Config(), nil, slog.New(slog.NewTextHandler(io.Discard, nil)))

			if err := manager.registerInvokeSkill(agent); err != nil {
				t.Fatalf("registerInvokeSkill: %v", err)
			}

			registered := false
			for _, id := range agent.Skills() {
				if id == SkillInvoke {
					registered = true
				}
			}
			if registered != testCase.wantSkill {
				t.Fatalf("invoke registered = %v, want %v (skills=%v)",
					registered, testCase.wantSkill, agent.Skills())
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

func TestResolveInvokeTarget(t *testing.T) {
	manager := invokeTestManager(t, invokeAgents(), nil)

	cases := []struct {
		name    string
		request InvokeInput
		wantID  string
		wantErr int
	}{
		{name: "by id", request: InvokeInput{Target: "agent-2"}, wantID: "agent-2"},
		{name: "by name", request: InvokeInput{Target: "reception"}, wantID: "agent-2"},
		{name: "by name case-insensitively", request: InvokeInput{Target: "BILLING"}, wantID: "agent-1"},
		{name: "by capability picks the first online match", request: InvokeInput{Capability: OperationTask}, wantID: "agent-1"},
		{name: "unknown capability", request: InvokeInput{Capability: "nope"}, wantErr: CodeAgentUnavailable},
		{name: "offline agent by id", request: InvokeInput{Target: "agent-3"}, wantErr: CodeAgentUnavailable},
		{name: "unknown id", request: InvokeInput{Target: "ghost"}, wantErr: CodeAgentUnavailable},
		{name: "neither", request: InvokeInput{}, wantErr: CodeInvalidEnvelope},
		{name: "both", request: InvokeInput{Target: "agent-1", Capability: "billing"}, wantErr: CodeInvalidEnvelope},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			agent, err := manager.resolveInvokeTarget(testCase.request)
			if testCase.wantErr != 0 {
				if code := codeOf(t, err); code != testCase.wantErr {
					t.Fatalf("code = %d, want %d", code, testCase.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveInvokeTarget: %v", err)
			}
			if agent.ID != testCase.wantID {
				t.Fatalf("agent = %q, want %q", agent.ID, testCase.wantID)
			}
		})
	}
}

func TestLocalAgentByCapability(t *testing.T) {
	agents := invokeAgents()

	if agent, ok := LocalAgentByCapability(agents, "billing"); !ok || agent.ID != "agent-1" {
		t.Fatalf("billing = %+v/%v, want agent-1", agent, ok)
	}
	// Case-insensitive, because a capability is a human-typed name.
	if agent, ok := LocalAgentByCapability(agents, "BILLING"); !ok || agent.ID != "agent-1" {
		t.Fatalf("BILLING = %+v/%v, want agent-1", agent, ok)
	}
	// Only the offline agent advertises this one.
	if _, ok := LocalAgentByCapability(agents, "nightly"); ok {
		t.Fatal("an offline agent must never be chosen by capability")
	}
	if _, ok := LocalAgentByCapability(agents, ""); ok {
		t.Fatal("an empty capability must not match")
	}
	if _, ok := LocalAgentByCapability(agents, "   "); ok {
		t.Fatal("a blank capability must not match")
	}
	if _, ok := LocalAgentByCapability(agents, "task "); !ok {
		t.Fatal("surrounding whitespace should be tolerated")
	}
}

func TestDecodeInvokeInput(t *testing.T) {
	t.Run("nil input", func(t *testing.T) {
		if _, err := decodeInvokeInput(nil); codeOf(t, err) != CodeInvalidEnvelope {
			t.Fatal("nil input must be refused with INVALID_ENVELOPE")
		}
	})

	t.Run("trims fields", func(t *testing.T) {
		request, err := decodeInvokeInput(map[string]any{
			"target":    "  agent-1  ",
			"operation": " task ",
		})
		if err != nil {
			t.Fatalf("decodeInvokeInput: %v", err)
		}
		if request.Target != "agent-1" || request.Operation != OperationTask {
			t.Fatalf("request = %+v, want trimmed values", request)
		}
	})

	t.Run("wrong types are refused rather than coerced", func(t *testing.T) {
		if _, err := decodeInvokeInput(map[string]any{"target": 42}); err == nil {
			t.Fatal("a numeric target must be refused")
		}
	})

	t.Run("unknown fields are ignored", func(t *testing.T) {
		request, err := decodeInvokeInput(map[string]any{
			"target":    "agent-1",
			"operation": OperationTask,
			"whatever":  "ignored",
		})
		if err != nil {
			t.Fatalf("decodeInvokeInput: %v", err)
		}
		if request.Target != "agent-1" {
			t.Fatalf("request = %+v", request)
		}
	})
}

func TestInvokeResponseCode(t *testing.T) {
	cases := map[string]int{
		"":                         CodeInternalError,
		"unsupported_operation":    CodeSkillNotFound,
		"skill_not_found":          CodeSkillNotFound,
		"agent_offline":            CodeAgentUnavailable,
		"offline":                  CodeAgentUnavailable,
		"denied":                   CodeGovernanceDenied,
		"governance_denied":        CodeGovernanceDenied,
		"overloaded":               CodeOverloaded,
		"busy":                     CodeOverloaded,
		"timeout":                  CodeOverloaded,
		"invalid_request":          CodeInvalidEnvelope,
		"  Unsupported_Operation ": CodeSkillNotFound,
		// An unknown code must not be passed through as if we understood it.
		"something_new": CodeInternalError,
	}

	for input, want := range cases {
		if got := invokeResponseCode(input); got != want {
			t.Fatalf("invokeResponseCode(%q) = %d, want %d", input, got, want)
		}
	}
}

func TestInvokeErrorToMeshError(t *testing.T) {
	agent := LocalAgent{ID: "agent-1"}
	cases := []struct {
		name string
		err  error
		want int
	}{
		{name: "offline", err: ErrAgentOffline, want: CodeAgentUnavailable},
		{name: "wrapped offline", err: fmt.Errorf("dial: %w", ErrAgentOffline), want: CodeAgentUnavailable},
		{name: "deadline", err: context.DeadlineExceeded, want: CodeOverloaded},
		{name: "cancelled", err: context.Canceled, want: CodeOverloaded},
		{name: "other", err: errors.New("boom"), want: CodeInternalError},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if code := codeOf(t, invokeErrorToMeshError(testCase.err, agent)); code != testCase.want {
				t.Fatalf("code = %d, want %d", code, testCase.want)
			}
		})
	}
}

// The floor depends on telling "verified" apart from "accepted without proof".
// This pins that the guard reports the difference, since a regression here would
// silently re-open invocation to unsigned peers.
func TestCallerIdentityDistinguishesVerifiedFromAccepted(t *testing.T) {
	t.Run("signed and trusted is verified", func(t *testing.T) {
		guard, identity := newTestGuard(t, nil)
		envelope := signedRequest(t, identity, "drolu/reactorpro")

		if rejection := guard.check(envelope); rejection != nil {
			t.Fatalf("a signed request from the pinned identity was refused: %v", rejection.reason)
		}
		fingerprint, verified := guard.callerIdentity(envelope)
		if !verified {
			t.Fatal("a signed, trusted envelope must report a verified caller")
		}
		if fingerprint != identity.Fingerprint {
			t.Fatalf("fingerprint = %q, want %q", fingerprint, identity.Fingerprint)
		}
	})

	t.Run("unsigned under prefer is accepted but not verified", func(t *testing.T) {
		guard, _ := newTestGuard(t, nil)
		envelope := &Envelope{
			Version: ProtocolVersion,
			ID:      newID(),
			Type:    TypeRequest,
			TS:      timestamp(),
			From:    "globex/berlin/edge-1",
			To:      "drolu/reactorpro",
			Payload: json.RawMessage(`{"skill":"invoke"}`),
		}
		// The guard accepts it, which is exactly the case that must not be
		// mistaken for an authenticated caller.
		if rejection := guard.check(envelope); rejection != nil {
			t.Fatalf("prefer mode refused an unsigned envelope: %v", rejection.reason)
		}
		if _, verified := guard.callerIdentity(envelope); verified {
			t.Fatal("an unsigned envelope must never report a verified caller")
		}
	})

	t.Run("verify-off never reports a verified caller", func(t *testing.T) {
		guard, identity := newTestGuard(t, func(cfg *Config) {
			cfg.VerifyMode = VerifyOff
		})
		envelope := signedRequest(t, identity, "drolu/reactorpro")

		if rejection := guard.check(envelope); rejection != nil {
			t.Fatalf("verify-off refused an envelope: %v", rejection.reason)
		}
		if _, verified := guard.callerIdentity(envelope); verified {
			t.Fatal("verify-off consults no identity, so none can be verified")
		}
	})
}

// ---------------------------------------------------------------------------
// The "task" operation end-to-end with a stub invoker
// ---------------------------------------------------------------------------

// The task operation is the one side-effecting skill. This pins the whole mesh
// contract the session-layer transport must satisfy: the verified caller's
// routing reaches the stub, the caller's prompt is passed through, and the
// agent's result comes back as the caller's result unchanged.
func TestInvokeTaskOperationReturnsTheAgentResult(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{
		OK:     true,
		Result: json.RawMessage(`{"text":"the report is filed"}`),
	}}
	manager := invokeTestManager(t, invokeAgents(), nil)
	manager.SetLocalInvoker(invoker)

	output, err := manager.skillInvoke(t.Context(), map[string]any{
		"target":    "agent-1",
		"operation": OperationTask,
		"arguments": map[string]any{"prompt": "file the report"},
	}, verifiedCaller())
	if err != nil {
		t.Fatalf("skillInvoke: %v", err)
	}

	result := output.(InvokeOutput)
	if result.Operation != OperationTask || result.Agent != "agent-1" {
		t.Fatalf("output = %+v, want agent-1/task", result)
	}
	if string(result.Result) != `{"text":"the report is filed"}` {
		t.Fatalf("result = %s, want the agent's task output", result.Result)
	}
	if len(invoker.requests) != 1 {
		t.Fatalf("invoker saw %d requests, want 1", len(invoker.requests))
	}
	sent := invoker.requests[0]
	if sent.Operation != OperationTask {
		t.Fatalf("operation = %q, want %q", sent.Operation, OperationTask)
	}
	if string(sent.Arguments) != `{"prompt":"file the report"}` {
		t.Fatalf("arguments = %s, want the caller's prompt", sent.Arguments)
	}
}

// A desktop refusal carries the session layer's code vocabulary; every spell it
// can emit must map onto a specific mesh code rather than collapsing to 5001.
func TestInvokeTaskRefusalCodesMapOntoMeshCodes(t *testing.T) {
	cases := []struct {
		agentCode string
		want      int
	}{
		{agentCode: "timeout", want: CodeOverloaded},
		{agentCode: "agent_offline", want: CodeAgentUnavailable},
		{agentCode: "invalid_request", want: CodeInvalidEnvelope},
		{agentCode: "denied", want: CodeGovernanceDenied},
		{agentCode: "overloaded", want: CodeOverloaded},
		{agentCode: "unsupported_operation", want: CodeSkillNotFound},
		{agentCode: "internal", want: CodeInternalError},
	}

	for _, testCase := range cases {
		t.Run(testCase.agentCode, func(t *testing.T) {
			manager := invokeTestManager(t, invokeAgents(), nil)
			manager.SetLocalInvoker(&recordingInvoker{result: LocalInvokeResult{
				OK:           false,
				ErrorCode:    testCase.agentCode,
				ErrorMessage: "the desktop agent refused the task",
			}})

			_, err := manager.skillInvoke(t.Context(), map[string]any{
				"target":    "agent-1",
				"operation": OperationTask,
				"arguments": map[string]any{"prompt": "do it"},
			}, verifiedCaller())

			if code := codeOf(t, err); code != testCase.want {
				t.Fatalf("code for %q = %d, want %d", testCase.agentCode, code, testCase.want)
			}
		})
	}
}

// conversation_id travels both ways of a synchronous invoke: the caller's
// continuation request reaches the transport intact, and the conversation the
// run happened in comes back so the next invoke can continue it — that pair is
// the whole session-persistence contract on the wire.
func TestSkillInvokeConversationIDTravelsBothWays(t *testing.T) {
	invoker := &recordingInvoker{result: LocalInvokeResult{
		OK:             true,
		Result:         json.RawMessage(`{"summary":"done"}`),
		ConversationID: "remote-task-conv-continue-1",
	}}
	manager := invokeTestManager(t, invokeAgents(), nil)
	manager.SetLocalInvoker(invoker)

	output, err := manager.skillInvoke(t.Context(), map[string]any{
		"target":          "agent-2",
		"operation":       OperationTask,
		"arguments":       map[string]any{"prompt": "continue where we left off"},
		"conversation_id": "  remote-task-conv-continue-1  ",
	}, verifiedCaller())
	if err != nil {
		t.Fatalf("skillInvoke: %v", err)
	}

	if sent := invoker.requests[0]; sent.ConversationID != "remote-task-conv-continue-1" {
		t.Fatalf("invoker conversation = %q, want the caller's (trimmed)", sent.ConversationID)
	}
	result, ok := output.(InvokeOutput)
	if !ok {
		t.Fatalf("output = %T, want InvokeOutput", output)
	}
	if result.ConversationID != "remote-task-conv-continue-1" {
		t.Fatalf("output conversation = %q, want the run's", result.ConversationID)
	}
}
