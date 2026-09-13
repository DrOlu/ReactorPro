package main

import (
	"context"
	"errors"
	"time"

	"github.com/nats-io/nuid"

	"github.com/liveagent/agent-gateway/internal/mesh"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

// meshInvokeRequestPrefix namespaces the request ids this edge generates for
// remote invocations.
//
// The browser pass-through generates request ids on the same agent links and
// they share one correlation table per session, so an unprefixed id could
// collide and deliver a desktop's answer to whichever waiter registered first.
const meshInvokeRequestPrefix = "mesh-invoke-"

// desktopMeshInvoker forwards a verified remote invocation to a desktop agent
// over the existing /ws/v2/agent link.
//
// Deliberately thin. Every policy question — who may invoke, from which
// organisation, and which operation — is answered in the mesh package, because
// that is where the verified caller identity lives. This type knows only how to
// reach an agent, which is the boundary the mesh was built to keep: the routing
// decision and the transport are separable, so hardening one does not mean
// rewriting the other.
type desktopMeshInvoker struct {
	manager *session.Manager
}

// InvokeLocalAgent sends the invocation and waits for the correlated answer.
//
// Cancellation and the deadline come from ctx, which the mesh package derives
// from its own configured timeout narrowed by the caller's request. That means a
// desktop that never answers cannot hold the edge open: the wait ends when the
// deadline does, and AwaitUnaryResponse unregisters its stream via cleanup.
func (i desktopMeshInvoker) InvokeLocalAgent(ctx context.Context, request mesh.LocalInvokeRequest) (mesh.LocalInvokeResult, error) {
	requestID := meshInvokeRequestPrefix + nuid.Next()

	envelope := &gatewayv2.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().UnixMilli(),
		Payload: &gatewayv2.GatewayEnvelope_MeshInvoke{
			MeshInvoke: &gatewayv2.MeshInvokeRequest{
				TaskId: request.TaskID,
				// Caller and CallerFingerprint are the values the edge verified,
				// passed through unchanged, so the desktop audits the identity this
				// edge actually established rather than the peer's own claim.
				Caller:            request.Caller,
				CallerFingerprint: request.CallerFingerprint,
				Target:            request.AgentID,
				Operation:         request.Operation,
				ArgumentsJson:     request.Arguments,
				DeadlineUnixMs:    time.Now().Add(request.Timeout).UnixMilli(),
			},
		},
	}

	response, err := i.manager.AwaitUnaryResponse(ctx, request.AgentID, requestID, envelope)
	if err != nil {
		return mesh.LocalInvokeResult{}, translateInvokeError(err)
	}

	invoke := response.GetMeshInvokeResp()
	if invoke == nil {
		// The desktop answered, but not with the frame that was asked for. Treating
		// this as a result would mean reporting an unrelated frame's contents as the
		// task's output.
		return mesh.LocalInvokeResult{}, errors.New("desktop answered a mesh invocation with an unrelated frame")
	}
	return mesh.LocalInvokeResult{
		OK:           invoke.GetOk(),
		Result:       invoke.GetResultJson(),
		ErrorCode:    invoke.GetErrorCode(),
		ErrorMessage: invoke.GetErrorMessage(),
	}, nil
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
