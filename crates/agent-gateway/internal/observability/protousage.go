package observability

import "sync/atomic"

// ProtoUsage tracks v2 protocol link usage: in-process atomic counters, exposed
// via the protocol_usage field of /api/status.
type ProtoUsage struct {
	V2BrowserConnectionsTotal            atomic.Int64
	V2BrowserConnectionsActive           atomic.Int64
	V2BrowserRequestsTotal               atomic.Int64
	V2AgentConnectsTotal                 atomic.Int64
	V2AgentActive                        atomic.Int64
	V2AgentInboundOverflowsTotal         atomic.Int64
	V2TerminalConnectsTotal              atomic.Int64
	ChatIngressGapsTotal                 atomic.Int64
	ChatIngressCheckpointRequestsTotal   atomic.Int64
	ChatIngressCheckpointsCommittedTotal atomic.Int64
	ChatIngressReplayRequestsTotal       atomic.Int64
	ChatIngressTerminalsCommittedTotal   atomic.Int64
	ChatIngressFragmentRejectsTotal      atomic.Int64
	WebSocketWriterClosesTotal           atomic.Int64
	WebSocketQueueByteOverflowsTotal     atomic.Int64
}

// Usage is a process-level singleton; each protocol layer increments it directly.
var Usage ProtoUsage

// Snapshot exports the current counts (keys are the external JSON field names).
func (u *ProtoUsage) Snapshot() map[string]int64 {
	return map[string]int64{
		"v2_browser_connections_total":             u.V2BrowserConnectionsTotal.Load(),
		"v2_browser_connections_active":            u.V2BrowserConnectionsActive.Load(),
		"v2_browser_requests_total":                u.V2BrowserRequestsTotal.Load(),
		"v2_agent_connects_total":                  u.V2AgentConnectsTotal.Load(),
		"v2_agent_active":                          u.V2AgentActive.Load(),
		"v2_agent_inbound_overflows_total":         u.V2AgentInboundOverflowsTotal.Load(),
		"v2_terminal_connects_total":               u.V2TerminalConnectsTotal.Load(),
		"chat_ingress_gaps_total":                  u.ChatIngressGapsTotal.Load(),
		"chat_ingress_checkpoint_requests_total":   u.ChatIngressCheckpointRequestsTotal.Load(),
		"chat_ingress_checkpoints_committed_total": u.ChatIngressCheckpointsCommittedTotal.Load(),
		"chat_ingress_replay_requests_total":       u.ChatIngressReplayRequestsTotal.Load(),
		"chat_ingress_terminals_committed_total":   u.ChatIngressTerminalsCommittedTotal.Load(),
		"chat_ingress_fragment_rejects_total":      u.ChatIngressFragmentRejectsTotal.Load(),
		"websocket_writer_closes_total":            u.WebSocketWriterClosesTotal.Load(),
		"websocket_queue_byte_overflows_total":     u.WebSocketQueueByteOverflowsTotal.Load(),
	}
}
