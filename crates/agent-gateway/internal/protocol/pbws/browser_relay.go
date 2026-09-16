package pbws

import (
	"context"
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
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

	// A headless worker keeps no history of its own — its conversations live
	// in THIS gateway's conversation store, committed by the reliable ingress.
	// Serving the history arms from the store makes the worker's runs visible
	// in the management interface instead of the empty list the worker itself
	// would answer. The desktop is untouched: it declares a large capability
	// surface and never the headless marker, so its own history keeps serving
	// the pass-through exactly as before.
	if c.sm.AgentSupportsCapability(agentID, session.HeadlessWorkerCapability) {
		if history := env.GetHistoryList(); history != nil {
			list := c.sm.HeadlessConversationList(agentID, history.GetPage(), history.GetPageSize())
			c.sendHeadlessHistory(requestID, agentID, &gatewayv2.AgentEnvelope{
				Payload: &gatewayv2.AgentEnvelope_HistoryListResp{HistoryListResp: list},
			})
			return
		}
		if get := env.GetHistoryGet(); get != nil {
			detail := c.sm.HeadlessConversationGet(agentID, get.GetConversationId(), get.GetMaxMessages())
			c.sendHeadlessHistory(requestID, agentID, &gatewayv2.AgentEnvelope{
				Payload: &gatewayv2.AgentEnvelope_HistoryGetResp{HistoryGetResp: detail},
			})
			return
		}
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

// sendHeadlessHistory answers a history arm locally on the gateway's behalf:
// the frame is the AgentEnvelope shape the browser expects from the relay,
// but its payload is the conversation store's answer rather than a round
// trip to an agent that has no history to serve. No request-id namespacing
// is needed — nothing is being forwarded.
func (c *browserConn) sendHeadlessHistory(requestID, agentID string, response *gatewayv2.AgentEnvelope) {
	response.RequestId = requestID
	response.Timestamp = time.Now().Unix()
	_ = c.send(wscore.FrameResponse, "agent_response", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   agentID,
		Payload:   &gatewayv2.WebServerFrame_AgentResponse{AgentResponse: response},
	})
}
