package pbws

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/liveagent/agent-gateway/internal/chatcmd"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// Local operations answered directly from gateway state (or orchestrated by the
// gateway); chat orchestration reuses internal/chatcmd.

// handleStatusGet handles status.get for the given Agent.
func (c *browserConn) handleStatusGet(requestID, agentID string) {
	status := c.sm.Status(agentID)
	_ = c.send(wscore.FrameResponse, "status", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   status.AgentID,
		Payload: &gatewayv2.WebServerFrame_Status{
			Status: statusEvent(status),
		},
	})
}

// handleAgentList returns the status directory of all registered Agents
// (including offline entries); the persisted directory fills in Agents that have
// not reconnected since a gateway restart, so the webui can render the full list.
func (c *browserConn) handleAgentList(requestID string) {
	registered, err := c.srv.tokens.Registered()
	if err != nil {
		_ = c.sendLocalError(requestID, "agent directory unavailable")
		return
	}
	registeredByID := make(map[string]string, len(registered))
	for _, entry := range registered {
		registeredByID[entry.AgentID] = entry.Name
	}

	statuses := c.sm.AgentStatuses()
	known := make(map[string]bool, len(statuses))
	agents := make([]*gatewayv2.StatusEvent, 0, len(statuses)+len(registered))
	for _, status := range statuses {
		known[status.AgentID] = true
		event := statusEvent(status)
		event.Name = registeredByID[status.AgentID]
		agents = append(agents, event)
	}
	for _, entry := range registered {
		if !known[entry.AgentID] {
			agents = append(agents, &gatewayv2.StatusEvent{AgentId: entry.AgentID, Name: entry.Name})
		}
	}
	sort.Slice(agents, func(i, j int) bool { return agents[i].GetAgentId() < agents[j].GetAgentId() })
	_ = c.send(wscore.FrameResponse, "agent_list", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_AgentList{
			AgentList: &gatewayv2.AgentListResult{Agents: agents},
		},
	})
}

// handleChatPrepare handles chat.prepare: after probing/waking the target desktop
// runtime it returns a status isomorphic to status_get (clients share a single
// status normalizer).
func (c *browserConn) handleChatPrepare(requestID, agentID string, _ *gatewayv2.ChatPrepareRequest) {
	if c.sm.IsOnline(agentID) && !c.sm.ChatIngressV1Ready(agentID) {
		status := c.sm.Status(agentID)
		_ = c.send(wscore.FrameControl, "status", &gatewayv2.WebServerFrame{
			RequestId: requestID,
			AgentId:   status.AgentID,
			Payload: &gatewayv2.WebServerFrame_Status{
				Status: statusEvent(status),
			},
		})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), chatcmd.PrepareTimeout(c.cfg))
	defer cancel()
	if err := chatcmd.ProbeRuntime(ctx, c.sm, agentID); err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	status := c.sm.Status(agentID)
	// Send the response on the control queue so a data backlog cannot starve it.
	_ = c.send(wscore.FrameControl, "status", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   status.AgentID,
		Payload: &gatewayv2.WebServerFrame_Status{
			Status: statusEvent(status),
		},
	})
}

// handleChatActivities handles chat.activities: answered purely from gateway
// state, so it works even when the desktop is offline.
func (c *browserConn) handleChatActivities(requestID string) {
	activities := c.sm.ActiveConversationActivities()
	running := make([]*gatewayv2.ChatRunActivity, 0, len(activities))
	for _, activity := range activities {
		running = append(running, chatRunActivityListItem(activity))
	}
	_ = c.send(wscore.FrameResponse, "chat_activities", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_ChatActivities{
			ChatActivities: &gatewayv2.ChatActivitiesResult{RunningConversations: running},
		},
	})
}

// handleChatCommand handles chat.command: submit / edit_resend are orchestrated
// by the gateway (dedup, accept-as-receipt, watching command updates, starting
// the watchdog, delivery), while cancel is handled separately.
// agentID is the explicit target Agent already validated by the dispatch layer.
func (c *browserConn) handleChatCommand(requestID, agentID string, cmd *gatewayv2.ChatCommandRequest) {
	commandType := strings.TrimSpace(cmd.GetType())
	body := chatcmd.RequestBodyFromProto(cmd.GetRequest())
	baseMessageRef := chatcmd.MessageRefFromProto(cmd.GetBaseMessageRef())

	switch commandType {
	case "chat.submit":
		baseMessageRef = nil
	case "chat.edit_resend":
		if baseMessageRef == nil {
			_ = c.sendLocalError(requestID, "base_message_ref is required")
			return
		}
		if err := chatcmd.ValidateMessageRef(baseMessageRef); err != nil {
			_ = c.sendLocalError(requestID, err.Error())
			return
		}
	case "chat.cancel":
		c.handleChatCancel(requestID, agentID, cmd.GetCancel())
		return
	default:
		_ = c.sendLocalError(requestID, "unsupported chat command")
		return
	}

	if err := chatcmd.NormalizeRequestBody(&body); err != nil {
		_ = c.sendLocalError(requestID, err.Error())
		return
	}

	if existing, ok := c.sm.LookupChatCommand(agentID, body.ClientRequestID); ok {
		c.respondChatCommandDeduped(requestID, existing)
		return
	}

	if !c.sm.IsOnline(agentID) {
		_ = c.sendLocalError(requestID, "agent offline")
		return
	}
	if len(body.ReferencedConversations) > 0 &&
		!c.sm.SupportsCapability(agentID, gatewayv2.ConversationReferencesV1Capability) {
		_ = c.sendLocalError(
			requestID,
			session.ErrConversationReferencesProtocolIncompatible.Error(),
		)
		return
	}
	probeCtx, probeCancel := context.WithTimeout(
		context.Background(), chatcmd.PrepareTimeout(c.cfg),
	)
	probeErr := chatcmd.ProbeRuntimeForCommand(probeCtx, c.sm, agentID)
	probeCancel()
	if probeErr != nil {
		_ = c.sendLocalError(requestID, errorMessage(probeErr))
		return
	}

	runID := "chat-command-" + uuid.NewString()
	start := c.sm.StartChatCommand(
		agentID,
		runID,
		body.ConversationID,
		body.Workdir,
		body.ClientRequestID,
		chatcmd.BuildAcceptedCommandPayloads(body, baseMessageRef),
	)
	if start.Deduped {
		c.respondChatCommandDeduped(requestID, start)
		return
	}
	updates, cleanupWatch := c.sm.WatchChatCommand(start.AgentID, start.RunID)

	_ = c.sendChatCommandAccepted(requestID, start)

	go c.forwardChatCommandUpdates(updates, cleanupWatch)
	go chatcmd.DispatchAcceptedCommand(
		context.Background(), c.cfg, c.sm, agentID, cleanupWatch, start, body, baseMessageRef, chatcmd.NewTraceID(),
	)
}

// respondChatCommandDeduped answers a duplicate client_request_id with the
// existing run and forwards its (replayed) pre-stage updates; the update watch
// stream is closed by the watchdog window as a fallback.
func (c *browserConn) respondChatCommandDeduped(requestID string, start session.ChatCommandStart) {
	updates, cleanupWatch := c.sm.WatchChatCommand(start.AgentID, start.RunID)
	_ = c.sendChatCommandAccepted(requestID, start)
	go c.forwardChatCommandUpdates(updates, cleanupWatch)
	cleanupChatCommandWatchAfter(c.cfg, cleanupWatch)
}

func (c *browserConn) sendChatCommandAccepted(requestID string, start session.ChatCommandStart) error {
	// The accept receipt is latency-sensitive, so send it on the control queue.
	return c.send(wscore.FrameControl, "chat_accepted", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   start.AgentID,
		Payload: &gatewayv2.WebServerFrame_ChatAccepted{
			ChatAccepted: &gatewayv2.ChatCommandAccepted{
				RunId:          start.RunID,
				ConversationId: start.ConversationID,
				AcceptedSeq:    start.AcceptedSeq,
				Deduped:        start.Deduped,
			},
		},
	})
}

// forwardChatCommandUpdates pushes pre-stage results (bound / queued_in_gui /
// failed) to the connection that issued the command (on the control queue).
func (c *browserConn) forwardChatCommandUpdates(
	updates <-chan session.ChatCommandUpdate,
	cleanup func(),
) {
	if cleanup != nil {
		defer cleanup()
	}
	for {
		select {
		case <-c.done:
			return
		case update, ok := <-updates:
			if !ok {
				return
			}
			if err := c.send(wscore.FrameControl, "chat_command_update", &gatewayv2.WebServerFrame{
				AgentId: update.AgentID,
				Payload: &gatewayv2.WebServerFrame_ChatCommandUpdate{
					ChatCommandUpdate: chatCommandUpdate(update),
				},
			}); err != nil {
				return
			}
		}
	}
}

// cleanupChatCommandWatchAfter sets a fallback close window for the update watch
// stream of a deduped submit (AfterFunc does not hold a goroutine, and cleanup is
// idempotent).
func cleanupChatCommandWatchAfter(cfg *config.Config, cleanup func()) {
	if cleanup == nil {
		return
	}
	timeout := chatcmd.StartTimeout(cfg) + chatcmd.RenderStartTimeout(cfg)
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	time.AfterFunc(timeout, cleanup)
}

const chatCancelWatchdogTimeout = 15 * time.Second

// handleChatCancel handles chat.cancel. Cancellation only affects the Agent
// explicitly named in the request; even if another Agent happens to have a
// conversation_id with the same name, it is never cancelled across Agents.
func (c *browserConn) handleChatCancel(requestID, agentID string, cancelReq *gatewayv2.CancelChatRequest) {
	conversationID := strings.TrimSpace(cancelReq.GetConversationId())
	if conversationID == "" {
		_ = c.sendLocalError(requestID, "conversation_id is required")
		return
	}
	if !c.sm.IsOnline(agentID) {
		_ = c.sendLocalError(requestID, "agent offline")
		return
	}

	// Do not terminate the run: flip the activity state to cancelling and let the
	// desktop's terminal signal decide, with the watchdog forcing closure on timeout.
	runID, active := c.sm.MarkConversationCancelling(agentID, conversationID, strings.TrimSpace(cancelReq.GetRunId()))
	if !active {
		_ = c.sendChatCancelResult(requestID, true, "", conversationID)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), c.srv.writeTimeout())
	defer cancel()

	if err := c.sm.SendToAgentContext(ctx, agentID, &gatewayv2.GatewayEnvelope{
		RequestId: runID,
		Timestamp: time.Now().Unix(),
		Payload:   chatcmd.BuildCancelCommandPayload(conversationID),
	}); err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}

	go watchChatCancel(c.sm, agentID, runID)
	_ = c.sendChatCancelResult(requestID, true, runID, conversationID)
}

func (c *browserConn) sendChatCancelResult(requestID string, ok bool, runID, conversationID string) error {
	return c.send(wscore.FrameResponse, "chat_cancelled", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_ChatCancelled{
			ChatCancelled: &gatewayv2.ChatCancelResult{
				Ok:             ok,
				RunId:          runID,
				ConversationId: conversationID,
			},
		},
	})
}

func watchChatCancel(sm *session.Manager, agentID string, runID string) {
	time.Sleep(chatCancelWatchdogTimeout)
	sm.ForceFinishRun(agentID, runID, "cancelled", "cancel_timeout",
		"The desktop runtime did not confirm the cancellation in time.")
}
