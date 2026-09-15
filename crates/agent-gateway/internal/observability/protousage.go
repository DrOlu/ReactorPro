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

	// Mesh inbound policy. Refusals are counted separately by cause so an
	// operator can distinguish a misconfigured peer from an attack without
	// grepping logs.
	MeshInboundTotal          atomic.Int64
	MeshOutboundTotal         atomic.Int64
	MeshVerifyFailedTotal     atomic.Int64
	MeshReplayRejectedTotal   atomic.Int64
	MeshRateLimitedTotal      atomic.Int64
	MeshTrustMismatchTotal    atomic.Int64
	MeshOversizedTotal        atomic.Int64
	MeshDispatchTotal         atomic.Int64
	MeshDispatchFailedTotal   atomic.Int64
	MeshGovernanceDeniedTotal atomic.Int64
	// Mesh remote invocation. MeshInvokeTotal counts invocations that passed
	// every gate and were forwarded to a desktop agent; MeshInvokeDeniedTotal
	// counts refusals by this edge's policy, and MeshInvokeFailedTotal counts
	// forwarded invocations that then failed or were refused by the agent.
	// A rising denied count with a flat total is the signal that a peer is being
	// held off, which is exactly what an operator needs to see.
	MeshInvokeTotal       atomic.Int64
	MeshInvokeDeniedTotal atomic.Int64
	MeshInvokeFailedTotal atomic.Int64
	// Mesh task lifecycle. Created counts accepted async tasks (including the
	// ones later rejected by a gate, because the caller held an object); the
	// terminal counters count how each task ended. Canceled counts both a
	// caller cancel and the startup sweep's "edge restarted" failures are
	// failed, not canceled — the distinction is who decided.
	MeshTaskCreatedTotal   atomic.Int64
	MeshTaskCompletedTotal atomic.Int64
	MeshTaskFailedTotal    atomic.Int64
	MeshTaskCanceledTotal  atomic.Int64
	// MeshTaskInputRequiredTotal counts runs that paused to ask the caller a
	// question — the state an operator watches for when tasks cross
	// organisations, because it is the one waiting on a human elsewhere.
	MeshTaskInputRequiredTotal atomic.Int64
	// Mesh task webhooks. Total counts notifications actually dispatched
	// (after dedup); Failed counts deliveries abandoned after their retries —
	// a webhook is best-effort, and the task record stays queryable regardless.
	MeshTaskWebhookTotal       atomic.Int64
	MeshTaskWebhookFailedTotal atomic.Int64
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
		"mesh_inbound_total":                       u.MeshInboundTotal.Load(),
		"mesh_outbound_total":                      u.MeshOutboundTotal.Load(),
		"mesh_verify_failed_total":                 u.MeshVerifyFailedTotal.Load(),
		"mesh_replay_rejected_total":               u.MeshReplayRejectedTotal.Load(),
		"mesh_rate_limited_total":                  u.MeshRateLimitedTotal.Load(),
		"mesh_trust_mismatch_total":                u.MeshTrustMismatchTotal.Load(),
		"mesh_oversized_total":                     u.MeshOversizedTotal.Load(),
		"mesh_dispatch_total":                      u.MeshDispatchTotal.Load(),
		"mesh_dispatch_failed_total":               u.MeshDispatchFailedTotal.Load(),
		"mesh_governance_denied_total":             u.MeshGovernanceDeniedTotal.Load(),
		"mesh_invoke_total":                        u.MeshInvokeTotal.Load(),
		"mesh_invoke_denied_total":                 u.MeshInvokeDeniedTotal.Load(),
		"mesh_invoke_failed_total":                 u.MeshInvokeFailedTotal.Load(),
		"mesh_task_created_total":                  u.MeshTaskCreatedTotal.Load(),
		"mesh_task_completed_total":                u.MeshTaskCompletedTotal.Load(),
		"mesh_task_failed_total":                   u.MeshTaskFailedTotal.Load(),
		"mesh_task_canceled_total":                 u.MeshTaskCanceledTotal.Load(),
		"mesh_task_input_required_total":          u.MeshTaskInputRequiredTotal.Load(),
		"mesh_task_webhook_total":                  u.MeshTaskWebhookTotal.Load(),
		"mesh_task_webhook_failed_total":           u.MeshTaskWebhookFailedTotal.Load(),
	}
}
