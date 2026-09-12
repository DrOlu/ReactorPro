package session

import (
	"sync"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// clarifyDeltaHub routes streaming clarification deltas from the desktop app to the
// browser that initiated the turn.
// Kept separate from unary waits: a delta must not consume the first correlated
// response of AwaitUnaryResponse.
type clarifyDeltaHub struct {
	mu   sync.Mutex
	subs map[string]func(*gatewayv2.ClarifyTurnDelta)
}

func newClarifyDeltaHub() *clarifyDeltaHub {
	return &clarifyDeltaHub{subs: make(map[string]func(*gatewayv2.ClarifyTurnDelta))}
}

// WatchClarifyDeltas subscribes to clarification deltas for the given
// (already namespaced) request_id.
// Returns an unsubscribe function; subscribing again to the same id overwrites the
// previous callback.
func (m *Manager) WatchClarifyDeltas(requestID string, fn func(*gatewayv2.ClarifyTurnDelta)) func() {
	if requestID == "" || fn == nil {
		return func() {}
	}
	m.clarifyDeltas.mu.Lock()
	m.clarifyDeltas.subs[requestID] = fn
	m.clarifyDeltas.mu.Unlock()
	return func() {
		m.clarifyDeltas.mu.Lock()
		delete(m.clarifyDeltas.subs, requestID)
		m.clarifyDeltas.mu.Unlock()
	}
}

func (m *Manager) forwardClarifyTurnDelta(requestID string, delta *gatewayv2.ClarifyTurnDelta) {
	if delta == nil || requestID == "" {
		return
	}
	m.clarifyDeltas.mu.Lock()
	fn := m.clarifyDeltas.subs[requestID]
	m.clarifyDeltas.mu.Unlock()
	if fn != nil {
		fn(delta)
	}
}
