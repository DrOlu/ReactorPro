package session

import (
	"context"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// AwaitUnaryResponse sends an envelope to the target agent with single request-response
// semantics and waits for the first correlated response; cancellation/timeout is controlled by
// the caller's ctx; agentID must be explicit and non-empty.
func (m *Manager) AwaitUnaryResponse(
	ctx context.Context,
	agentID string,
	requestID string,
	envelope *gatewayv2.GatewayEnvelope,
) (*gatewayv2.AgentEnvelope, error) {
	ch, done, cleanup, err := m.RegisterStreamAndSendContext(ctx, agentID, requestID, envelope)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-done:
		return nil, ErrAgentOffline
	case env, ok := <-ch:
		if !ok {
			return nil, ErrAgentOffline
		}
		return env, nil
	}
}
