package pbws

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// Subscription lifecycle for browser connections, nine-channel broadcast forwarding, and
// post-connect snapshot replay:
// Broadcast frames may be dropped (errWriteQueueFull skips and continues); when a chat
// conversation stream drops a frame, a subscription reset signal is sent so the client can
// resume from after_seq.

// workspaceSubscription is an active subscription for a workdir.
type workspaceSubscription struct {
	cancel func()
	done   chan struct{}
	once   sync.Once
}

func (s *workspaceSubscription) close() {
	s.once.Do(func() {
		close(s.done)
		s.cancel()
	})
}

// releaseSubscriptions is called by the core close callback (exactly once) to release
// chat/workspace subscriptions; each of the nine broadcast forwarders listens on done to exit
// and defers cleanup.
func (c *browserConn) releaseSubscriptions() {
	c.chatStreamsMu.Lock()
	for subKey, cancel := range c.chatStreams {
		cancel()
		delete(c.chatStreams, subKey)
	}
	c.chatStreamsMu.Unlock()

	c.workspaceSubsMu.Lock()
	for workdir, sub := range c.workspaceSubs {
		sub.close()
		delete(c.workspaceSubs, workdir)
	}
	c.workspaceSubsMu.Unlock()
}

// ---------------------------------------------------------------------------
// chat conversation stream subscriptions
// ---------------------------------------------------------------------------

// handleChatSubscribe handles chat.subscribe (executed inline in the read loop to preserve frame ordering).
func (c *browserConn) handleChatSubscribe(requestID, agentID string, req *gatewayv2.ChatSubscribeRequest) {
	agentID = strings.TrimSpace(agentID)
	conversationID := strings.TrimSpace(req.GetConversationId())
	if conversationID == "" {
		_ = c.sendLocalError(requestID, "conversation_id is required")
		return
	}

	sub := c.sm.SubscribeConversationStream(agentID, conversationID, req.GetAfterSeq(), req.GetStreamEpoch())
	if sub == nil {
		_ = c.sendLocalError(requestID, "agent_id and conversation_id are required")
		return
	}
	subKey := agentID + "\x00" + conversationID

	events := make([][]byte, 0, len(sub.Events))
	for _, event := range sub.Events {
		payload, err := json.Marshal(event.Payload)
		if err != nil {
			continue
		}
		events = append(events, payload)
	}
	result := &gatewayv2.ChatSubscribeResult{
		ConversationId: sub.ConversationID,
		StreamEpoch:    sub.StreamEpoch,
		LatestSeq:      sub.LatestSeq,
		Reset_:         sub.Reset,
		Activity:       chatRunActivity(sub.Activity),
		Snapshot:       chatRunSnapshot(sub.Snapshot),
		EventsJson:     events,
	}

	// Register first (replacing any previous subscription for the same conversation) and then acknowledge, so events published after the replay boundary are not missed.
	c.chatStreamsMu.Lock()
	if c.chatStreams == nil {
		c.chatStreams = make(map[string]func())
	}
	if previous := c.chatStreams[subKey]; previous != nil {
		previous()
	}
	c.chatStreams[subKey] = sub.Cleanup
	c.chatStreamsMu.Unlock()

	if err := c.send(wscore.FrameResponse, "chat_subscribed", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   sub.AgentID,
		Payload:   &gatewayv2.WebServerFrame_ChatSubscribed{ChatSubscribed: result},
	}); err != nil {
		sub.Cleanup()
		c.chatStreamsMu.Lock()
		// Cleanup is idempotent: only deregister if the entry still points to this subscription.
		delete(c.chatStreams, subKey)
		c.chatStreamsMu.Unlock()
		// A dropped subscription response would leave the client waiting until timeout with nobody resubscribing; a reset signal on the control queue re-arms its recovery loop.
		if errors.Is(err, wscore.ErrWriteQueueFull) {
			c.sendSubscriptionResetOrClose(sub.AgentID, conversationID)
		}
		return
	}

	go c.forwardConversationEvents(sub.AgentID, conversationID, sub)
}

// handleChatUnsubscribe handles chat.unsubscribe.
func (c *browserConn) handleChatUnsubscribe(requestID, agentID string, req *gatewayv2.ChatUnsubscribeRequest) {
	agentID = strings.TrimSpace(agentID)
	conversationID := strings.TrimSpace(req.GetConversationId())
	if conversationID == "" {
		_ = c.sendLocalError(requestID, "conversation_id is required")
		return
	}
	subKey := agentID + "\x00" + conversationID

	c.chatStreamsMu.Lock()
	if cancel := c.chatStreams[subKey]; cancel != nil {
		cancel()
		delete(c.chatStreams, subKey)
	}
	c.chatStreamsMu.Unlock()

	_ = c.sendAck(requestID)
}

func (c *browserConn) sendAck(requestID string) error {
	return c.send(wscore.FrameResponse, "ack", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload:   &gatewayv2.WebServerFrame_Ack{Ack: &gatewayv2.AckResult{Ok: true}},
	})
}

// forwardConversationEvents pushes live conversation events after subscription; when the
// subscription channel overflows or the write queue stays congested, it notifies the client to
// resubscribe (after_seq replays the gap from the buffer); congestion sacrifices only that
// subscription, never the connection.
func (c *browserConn) forwardConversationEvents(
	agentID string,
	conversationID string,
	sub *session.ConversationSubscription,
) {
	defer sub.Cleanup()
	for {
		select {
		case <-c.done:
			return
		case event, ok := <-sub.EventCh:
			if !ok {
				if sub.Overflowed() {
					c.sendSubscriptionResetOrClose(agentID, conversationID)
				}
				return
			}
			payload, err := json.Marshal(event.Payload)
			if err != nil {
				continue
			}
			if err := c.send(wscore.FrameData, "chat_event", &gatewayv2.WebServerFrame{
				AgentId: agentID,
				Payload: &gatewayv2.WebServerFrame_ChatEvent{
					ChatEvent: &gatewayv2.ChatStreamEvent{
						ConversationId: conversationID,
						Seq:            event.Seq,
						PayloadJson:    payload,
					},
				},
			}); err != nil {
				if errors.Is(err, wscore.ErrWriteQueueFull) || errors.Is(err, wscore.ErrWriteFrameTooLarge) {
					// The reset frame goes through the control queue, bypassing the congested backlog; after resyncing, the client deduplicates in-flight old events by seq.
					// An oversized single frame likewise sacrifices only that subscription: resubscribe replay/snapshot and history convergence fill in the missing content.
					c.sendSubscriptionResetOrClose(agentID, conversationID)
				}
				return
			}
		}
	}
}

// sendSubscriptionResetOrClose sends the only signal that can recover a dropped subscription;
// when even the control queue cannot accept it, the connection is closed, and resubscription
// after reconnect (after_seq) is the only remaining lossless path.
func (c *browserConn) sendSubscriptionResetOrClose(agentID string, conversationID string) {
	if err := c.send(wscore.FrameControl, "chat_subscription_reset", &gatewayv2.WebServerFrame{
		AgentId: agentID,
		Payload: &gatewayv2.WebServerFrame_ChatSubscriptionReset{
			ChatSubscriptionReset: &gatewayv2.ChatSubscriptionReset{ConversationId: conversationID},
		},
	}); err != nil {
		c.core.Close()
	}
}

// ---------------------------------------------------------------------------
// workspace activity subscriptions
// ---------------------------------------------------------------------------

// handleWorkspaceSubscribe handles workspace.subscribe (inline in the read loop). Subscriptions
// are scoped by (agent, workdir); the dispatch layer guarantees agent_id is non-empty.
func (c *browserConn) handleWorkspaceSubscribe(requestID, agentID string, req *gatewayv2.WorkspaceSubscribeRequest) {
	workdir := strings.TrimSpace(req.GetWorkdir())
	if workdir == "" {
		_ = c.sendLocalError(requestID, "workdir is required")
		return
	}
	requestedAgentID := strings.TrimSpace(agentID)
	resolvedAgentID, err := c.sm.ResolveAgentID(requestedAgentID)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	subKey := requestedAgentID + "\x00" + workdir

	events, cancel := c.sm.SubscribeWorkspaceActivity(resolvedAgentID, workdir)
	sub := &workspaceSubscription{
		cancel: cancel,
		done:   make(chan struct{}),
	}

	c.workspaceSubsMu.Lock()
	if c.workspaceSubs == nil {
		c.workspaceSubs = make(map[string]*workspaceSubscription)
	}
	if previous := c.workspaceSubs[subKey]; previous != nil {
		previous.close()
	}
	c.workspaceSubs[subKey] = sub
	c.workspaceSubsMu.Unlock()

	if err := c.sendAck(requestID); err != nil {
		sub.close()
		c.workspaceSubsMu.Lock()
		if c.workspaceSubs[subKey] == sub {
			delete(c.workspaceSubs, subKey)
		}
		c.workspaceSubsMu.Unlock()
		return
	}

	go func() {
		for {
			select {
			case <-c.done:
				return
			case <-sub.done:
				return
			case event, ok := <-events:
				if !ok {
					return
				}
				if err := c.send(wscore.FrameData, "workspace_activity", &gatewayv2.WebServerFrame{
					AgentId: resolvedAgentID,
					Payload: &gatewayv2.WebServerFrame_WorkspaceActivity{WorkspaceActivity: event},
				}); err != nil {
					if errors.Is(err, wscore.ErrWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

// handleWorkspaceUnsubscribe handles workspace.unsubscribe.
func (c *browserConn) handleWorkspaceUnsubscribe(requestID, agentID string, req *gatewayv2.WorkspaceUnsubscribeRequest) {
	subKey := strings.TrimSpace(agentID) + "\x00" + strings.TrimSpace(req.GetWorkdir())

	c.workspaceSubsMu.Lock()
	if sub := c.workspaceSubs[subKey]; sub != nil {
		sub.close()
		delete(c.workspaceSubs, subKey)
	}
	c.workspaceSubsMu.Unlock()

	_ = c.sendAck(requestID)
}

// ---------------------------------------------------------------------------
// broadcast event fan-out and snapshot replay
// ---------------------------------------------------------------------------

// startEventForwarders starts the nine broadcast forwarders;
// the generic forward unifies the droppable-frame broadcast skeleton, and each channel only
// supplies a subscription and a frame builder. Broadcast frames carry the source agent_id (the
// server does not filter; the client filters by active agent); feature gating is decided by the
// source agent.
func (c *browserConn) startEventForwarders() {
	forward(c, c.sm.SubscribeHistorySync, func(event session.Tagged[*gatewayv2.HistorySyncEvent]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_HistoryEvent{HistoryEvent: event.Event},
		}, true
	}, "history_event")

	forward(c, c.sm.SubscribeSettingsSync, func(event session.Tagged[*gatewayv2.SettingsSyncEvent]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_SettingsEvent{SettingsEvent: event.Event},
		}, true
	}, "settings_event")

	forward(c, c.sm.SubscribeTerminalEvents, func(event session.Tagged[*gatewayv2.TerminalEvent]) (*gatewayv2.WebServerFrame, bool) {
		if !shared.TerminalEventAllowed(c.sm.AgentView(event.AgentID), event.Event) || !c.terminalInterest.ShouldForward(event.Event) {
			return nil, false
		}
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_TerminalEvent{TerminalEvent: event.Event},
		}, true
	}, "terminal_event")

	forward(c, c.sm.SubscribeSftpEvents, func(event session.Tagged[*gatewayv2.SftpEvent]) (*gatewayv2.WebServerFrame, bool) {
		if !c.sm.WebSshTerminalEnabled(event.AgentID) {
			return nil, false
		}
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_SftpEvent{SftpEvent: event.Event},
		}, true
	}, "sftp_event")

	forward(c, c.sm.SubscribeChatQueueEvents, func(event session.Tagged[*gatewayv2.ChatQueueEvent]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_ChatQueueEvent{ChatQueueEvent: event.Event},
		}, true
	}, "chat_queue_event")

	forward(c, c.sm.SubscribeChatActivity, func(event session.ConversationActivityEvent) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_ChatActivity{ChatActivity: chatActivityEvent(event)},
		}, true
	}, "chat_activity")

	forward(c, c.sm.SubscribeTunnelState, func(event session.Tagged[*gatewayv2.TunnelStateSnapshot]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_TunnelState{TunnelState: event.Event},
		}, true
	}, "tunnel_state")

	forward(c, c.sm.SubscribeManagedProcessState, func(event session.Tagged[*gatewayv2.ManagedProcessSnapshot]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_ProcessState{ProcessState: event.Event},
		}, true
	}, "process_state")

	forward(c, c.sm.SubscribeStatus, func(status session.Tagged[session.Status]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: status.AgentID,
			Payload: &gatewayv2.WebServerFrame_Status{Status: statusEvent(status.Event)},
		}, true
	}, "status")
}

// forward is the shared skeleton for droppable-frame broadcast forwarding: subscribe establishes
// the subscription (cleanup runs when the goroutine exits), build filters and constructs frames;
// dropped frames skip and continue, other write errors end forwarding.
func forward[T any](
	c *browserConn,
	subscribe func() (<-chan T, func()),
	build func(T) (*gatewayv2.WebServerFrame, bool),
	kind string,
) {
	events, cleanup := subscribe()
	go func() {
		defer cleanup()
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-events:
				if !ok {
					return
				}
				frame, send := build(event)
				if !send {
					continue
				}
				if err := c.send(wscore.FrameData, kind, frame); err != nil {
					if errors.Is(err, wscore.ErrWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

// replaySnapshots paints the current state onto a new connection after authentication,
// avoiding the first polling round. It replays each online agent's snapshot individually and
// tags it; each online agent also gets one status frame (for directory rendering). All replayed
// frames carry an explicit source; untagged single-agent compatibility frames are no longer sent.
func (c *browserConn) replaySnapshots() {
	for _, agentID := range c.sm.ConnectedAgentIDs() {
		view := c.sm.AgentView(agentID)
		// Terminal session snapshot: replayed one by one as created events (gated independently per agent).
		if shared.TerminalFeaturesEnabled(view) {
			for _, terminalSession := range view.TerminalSessionSnapshot("") {
				if !shared.TerminalSessionAllowed(view, terminalSession) {
					continue
				}
				if err := c.send(wscore.FrameData, "terminal_event", &gatewayv2.WebServerFrame{
					AgentId: agentID,
					Payload: &gatewayv2.WebServerFrame_TerminalEvent{
						TerminalEvent: &gatewayv2.TerminalEvent{
							Kind:           "created",
							SessionId:      terminalSession.GetId(),
							ProjectPathKey: terminalSession.GetProjectPathKey(),
							Session:        terminalSession,
						},
					},
				}); err != nil {
					return
				}
			}
		}
		// Process snapshots are replayed per agent.
		if processSnapshot := c.sm.ManagedProcessSnapshotCached(agentID); processSnapshot != nil {
			_ = c.send(wscore.FrameData, "process_state", &gatewayv2.WebServerFrame{
				AgentId: agentID,
				Payload: &gatewayv2.WebServerFrame_ProcessState{ProcessState: processSnapshot},
			})
		}
		// One status frame per agent: new clients render the agent directory from this without sending agent_list first.
		agentStatus := c.sm.Status(agentID)
		_ = c.send(wscore.FrameData, "status", &gatewayv2.WebServerFrame{
			AgentId: agentID,
			Payload: &gatewayv2.WebServerFrame_Status{Status: statusEvent(agentStatus)},
		})
	}

	// Each registered agent replays its own tunnel snapshot and tags it; offline agents also retain their tunnel directory.
	for _, status := range c.sm.AgentStatuses() {
		agentID := strings.TrimSpace(status.AgentID)
		if agentID == "" {
			continue
		}
		_ = c.send(wscore.FrameData, "tunnel_state", &gatewayv2.WebServerFrame{
			AgentId: agentID,
			Payload: &gatewayv2.WebServerFrame_TunnelState{
				TunnelState: c.sm.TunnelStateSnapshot(agentID),
			},
		})
	}
}
