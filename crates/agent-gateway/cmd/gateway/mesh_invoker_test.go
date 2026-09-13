package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/liveagent/agent-gateway/internal/mesh"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestDecodeRemoteTaskArguments(t *testing.T) {
	t.Run("valid prompt", func(t *testing.T) {
		arguments, err := decodeRemoteTaskArguments(json.RawMessage(`{"prompt":"  file it  "}`))
		if err != nil {
			t.Fatalf("decodeRemoteTaskArguments: %v", err)
		}
		if arguments.Prompt != "file it" {
			t.Fatalf("prompt = %q, want the trimmed prompt", arguments.Prompt)
		}
	})

	bad := []string{"", "null", "42", `"text"`, `{"prompt":42}`}
	for _, raw := range bad {
		if _, err := decodeRemoteTaskArguments(json.RawMessage(raw)); err == nil {
			t.Fatalf("arguments %q should be refused", raw)
		}
	}
}

func TestInvokeLocalAgentRefusesBeforeTouchingTheAgent(t *testing.T) {
	invoker := desktopMeshInvoker{manager: nil}

	cases := []struct {
		name     string
		request  mesh.LocalInvokeRequest
		wantCode string
	}{
		{
			name:     "unknown operation",
			request:  mesh.LocalInvokeRequest{Operation: "shell"},
			wantCode: "unsupported_operation",
		},
		{
			name:     "missing prompt",
			request:  mesh.LocalInvokeRequest{Operation: mesh.OperationTask, Arguments: json.RawMessage(`{}`)},
			wantCode: "invalid_request",
		},
		{
			name:     "malformed arguments",
			request:  mesh.LocalInvokeRequest{Operation: mesh.OperationTask, Arguments: json.RawMessage(`[1]`)},
			wantCode: "invalid_request",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := invoker.InvokeLocalAgent(context.Background(), testCase.request)
			if err != nil {
				t.Fatalf("InvokeLocalAgent: %v", err)
			}
			if result.OK || result.ErrorCode != testCase.wantCode {
				t.Fatalf("result = %+v, want a %q refusal", result, testCase.wantCode)
			}
		})
	}
}

// With no session attached, a well-formed task must surface the offline sentinel
// in the mesh's own vocabulary, so invokeErrorToMeshError can classify it.
func TestInvokeLocalAgentTranslatesOffline(t *testing.T) {
	invoker := desktopMeshInvoker{manager: nil}
	_, err := invoker.InvokeLocalAgent(context.Background(), mesh.LocalInvokeRequest{
		Operation: mesh.OperationTask,
		Arguments: json.RawMessage(`{"prompt":"do it"}`),
	})
	if !errors.Is(err, mesh.ErrAgentOffline) {
		t.Fatalf("error = %v, want mesh.ErrAgentOffline", err)
	}
}

func TestTranslateInvokeError(t *testing.T) {
	if err := translateInvokeError(session.ErrAgentOffline); !errors.Is(err, mesh.ErrAgentOffline) {
		t.Fatalf("offline error = %v, want mesh.ErrAgentOffline", err)
	}
	if err := translateInvokeError(context.DeadlineExceeded); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unrelated error = %v, want it passed through", err)
	}
}
