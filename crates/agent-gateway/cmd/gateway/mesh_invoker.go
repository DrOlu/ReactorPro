package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/liveagent/agent-gateway/internal/chatcmd"
	"github.com/liveagent/agent-gateway/internal/mesh"
	"github.com/liveagent/agent-gateway/internal/session"
)

// desktopMeshInvoker forwards a verified remote invocation to a desktop agent by
// submitting a chat command to it, exactly as the browser does.
//
// The desktop has no execution surface of its own: its agent loop, provider
// client and tool registry all live in the WebView's TypeScript runtime. The way
// to make it do something is therefore the path that already works — a chat
// command runs a real tool-using turn, and the answer returns through the
// existing reliable chat ingress. This adapter is deliberately thin: it decodes
// the task arguments, checks the desktop is awake, and hands the prompt to the
// session layer. Every policy question — who may invoke, from which organisation,
// and which operation — stays in the mesh package, where the verified caller
// identity lives.
type desktopMeshInvoker struct {
	manager *session.Manager
}

// remoteTaskArguments is the argument shape of the "task" operation. The mesh
// treats arguments as opaque, so the shape is owned here.
type remoteTaskArguments struct {
	Prompt string `json:"prompt"`
}

// InvokeLocalAgent runs one remote task and returns its result.
//
// Cancellation and the deadline come from ctx, which the mesh package derives
// from its own configured timeout narrowed by the caller's request, so a desktop
// that never answers cannot hold the edge open.
func (i desktopMeshInvoker) InvokeLocalAgent(ctx context.Context, request mesh.LocalInvokeRequest) (mesh.LocalInvokeResult, error) {
	if strings.TrimSpace(request.Operation) != mesh.OperationTask {
		// The mesh allowlist already gates operations, so this is a defensive
		// backstop rather than the primary check.
		return refuseRemoteTask("unsupported_operation",
			"the desktop transport serves only the task operation"), nil
	}

	arguments, err := decodeRemoteTaskArguments(request.Arguments)
	if err != nil {
		return refuseRemoteTask("invalid_request", err.Error()), nil
	}
	prompt := arguments.Prompt
	if prompt == "" {
		return refuseRemoteTask("invalid_request", "task arguments require a non-empty prompt"), nil
	}
	// The input-request convention is taught, not configured: a task that
	// opted in carries the instruction, so the agent knows the one line that
	// pauses the task instead of completing it.
	if request.AllowInput {
		prompt += mesh.TaskInputInstruction
	}

	// Wake the Chat WebView runtime before submitting, exactly as the browser
	// does. Without this a command can be delivered to a sleeping runtime and
	// never start, which would look like a timeout rather than a refusal.
	if err := chatcmd.ProbeRuntimeForCommand(ctx, i.manager, request.AgentID); err != nil {
		return mesh.LocalInvokeResult{}, translateInvokeError(err)
	}

	// A streaming task gets the live view: growth deltas as the desktop commits
	// snapshots. The transport is unchanged otherwise — an ordinary invoke
	// answers whole, and the mesh's streamer is what makes deltas into chunks.
	// A resumed task names its conversation: the answer continues the one the
	// question was asked in, so the agent keeps its own context.
	var result session.RemoteTaskResult
	switch {
	case request.ConversationID != "" && request.Progress != nil:
		result, err = i.manager.SubmitRemoteTaskInConversation(ctx, request.AgentID,
			request.ConversationID, prompt, request.Progress)
	case request.ConversationID != "":
		result, err = i.manager.SubmitRemoteTaskInConversation(ctx, request.AgentID,
			request.ConversationID, prompt, nil)
	case request.Progress != nil:
		result, err = i.manager.SubmitRemoteTaskProgress(ctx, request.AgentID, prompt, request.Progress)
	default:
		result, err = i.manager.SubmitRemoteTask(ctx, request.AgentID, prompt)
	}
	if err != nil {
		return mesh.LocalInvokeResult{}, translateInvokeError(err)
	}
	return mesh.LocalInvokeResult{
		OK:             result.OK,
		Result:         result.Output,
		ErrorCode:       result.ErrorCode,
		ErrorMessage:    result.ErrorMessage,
		ConversationID:  result.ConversationID,
	}, nil
}

// decodeRemoteTaskArguments decodes the opaque mesh arguments into the task
// shape. An absent prompt is refused rather than defaulted: a remote caller that
// did not say what to run must not have the edge guess.
func decodeRemoteTaskArguments(raw json.RawMessage) (remoteTaskArguments, error) {
	var arguments remoteTaskArguments
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return arguments, errors.New("task arguments require a prompt")
	}
	if err := json.Unmarshal(raw, &arguments); err != nil {
		return arguments, errors.New("task arguments must be a JSON object with a prompt")
	}
	arguments.Prompt = strings.TrimSpace(arguments.Prompt)
	return arguments, nil
}

// refuseRemoteTask builds a desktop-side refusal the mesh maps onto its own code
// table, so an adapter-level refusal reaches the peer with a meaningful code
// rather than a generic internal error.
func refuseRemoteTask(code, message string) mesh.LocalInvokeResult {
	return mesh.LocalInvokeResult{OK: false, ErrorCode: code, ErrorMessage: message}
}

// translateInvokeError maps a transport failure onto the mesh's own sentinel.
//
// Needed so the mesh package can classify "the agent is not attached" without
// importing the session package — the same decoupling that keeps the mesh's
// policy independent of the desktop transport.
func translateInvokeError(err error) error {
	if errors.Is(err, session.ErrAgentOffline) {
		return mesh.ErrAgentOffline
	}
	return err
}
