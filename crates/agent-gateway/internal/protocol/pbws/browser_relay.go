package pbws

import (
	"context"
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// handleAgentRequest relays a browser-constructed GatewayEnvelope straight through:
// allowlist/limit checks → namespace the request_id per connection → wait for the
// correlated response via the session layer → shared post-processing for list-kind
// responses → restore the request_id and send back. The payload stays proto-passthrough
// between the browser and the Agent.
// agentID is the explicit target Agent already validated by the dispatch layer.
func (c *browserConn) handleAgentRequest(requestID, agentID string, env *gatewayv2.GatewayEnvelope) {
	if requestID == "" {
		_ = c.sendLocalError(requestID, "request id is required")
		return
	}
	view := c.sm.AgentView(agentID)
	if err := vetAgentRequest(view, env); err != nil {
		_ = c.sendLocalError(requestID, err.Error())
		return
	}

	// Namespace: multiple tabs share one desktop app, so passthrough ids must be
	// isolated per connection; strip the prefix on the way back to restore them.
	agentRequestID := c.idPrefix + requestID
	env.RequestId = agentRequestID
	if env.GetTimestamp() == 0 {
		env.Timestamp = time.Now().Unix()
	}

	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	if env.GetClarifyTurn() != nil {
		unwatch := c.sm.WatchClarifyDeltas(agentRequestID, func(delta *gatewayv2.ClarifyTurnDelta) {
			if delta == nil {
				return
			}
			_ = c.send(wscore.FrameResponse, "agent_response", &gatewayv2.WebServerFrame{
				RequestId: requestID,
				AgentId:   agentID,
				Payload: &gatewayv2.WebServerFrame_AgentResponse{
					AgentResponse: &gatewayv2.AgentEnvelope{
						RequestId: requestID,
						Timestamp: time.Now().Unix(),
						Payload: &gatewayv2.AgentEnvelope_ClarifyTurnDelta{
							ClarifyTurnDelta: delta,
						},
					},
				},
			})
		})
		defer unwatch()
	}

	response, err := c.sm.AwaitUnaryResponse(ctx, agentID, agentRequestID, env)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}

	// Merge/filter list-kind terminal responses and register interest (shared-domain
	// logic executed against the target Agent view).
	if terminalResp := response.GetTerminalResponse(); terminalResp != nil {
		req := env.GetTerminalRequest()
		finalized := shared.FinalizeTerminalResponse(
			view,
			c.terminalInterest,
			strings.TrimSpace(req.GetAction()),
			strings.TrimSpace(req.GetProjectPathKey()),
			terminalResp,
		)
		if finalized != terminalResp {
			response.Payload = &gatewayv2.AgentEnvelope_TerminalResponse{TerminalResponse: finalized}
		}
	}

	// Restore the correlation id and send back as-is; the error=99 arm keeps the
	// structured error code and leaves handling to the client.
	response.RequestId = requestID
	_ = c.send(wscore.FrameResponse, "agent_response", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   agentID,
		Payload:   &gatewayv2.WebServerFrame_AgentResponse{AgentResponse: response},
	})
}
