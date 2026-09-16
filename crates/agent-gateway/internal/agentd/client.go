package agentd

// The gateway link. One outbound WebSocket to the gateway's /ws/v2/agent
// endpoint, binary protobuf frames, application-layer pings — the exact
// contract the desktop speaks, as a second implementation. The client is dumb
// on purpose: every decision about the work lives in the runner; this file
// only keeps the line open and the frames flowing both ways.

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// Client is the agent link to one gateway.
type Client struct {
	cfg    *Config
	logger *slog.Logger

	// onCommand receives chat.submit envelopes (run id from the envelope,
	// the command itself from its payload).
	onCommand func(runID string, command *gatewayv2.ChatCommandRequest)
	// onCancel receives chat.cancel envelopes by conversation id.
	onCancel func(conversationID string)
	// onDisconnect is called once per broken link, before reconnecting —
	// the runner drops its live runs there.
	onDisconnect func()
	// activeRuns feeds the periodic runtime status event.
	activeRuns func() int

	writeMu sync.Mutex
	conn    *websocket.Conn
}

// NewClient wires the transport to the runner's hooks. activeRuns may be nil.
func NewClient(cfg *Config, logger *slog.Logger,
	onCommand func(runID string, command *gatewayv2.ChatCommandRequest),
	onCancel func(conversationID string),
	onDisconnect func(),
	activeRuns func() int,
) *Client {
	return &Client{
		cfg:          cfg,
		logger:       logger,
		onCommand:    onCommand,
		onCancel:     onCancel,
		onDisconnect: onDisconnect,
		activeRuns:   activeRuns,
	}
}

// Run holds the link open for the caller's lifetime, reconnecting with
// bounded backoff; it returns only when ctx ends. Each reconnection is a
// fresh session to the gateway — the agentd re-registers and keeps serving;
// runs that were live across the drop are cancelled locally (onDisconnect) and
// fail honestly at their budget on the gateway side.
func (c *Client) Run(ctx context.Context) error {
	backoff := c.cfg.ReconnectMin
	for {
		err := c.runOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if backoff > c.cfg.ReconnectMax {
			backoff = c.cfg.ReconnectMax
		}
		c.logger.Warn("agentd gateway link dropped; reconnecting",
			"backoff", backoff.String(), "error", errStringOf(err))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff *= 2
	}
}

// runOnce performs dial, handshake and the frame loop until the link breaks.
func (c *Client) runOnce(ctx context.Context) error {
	dialer := websocket.Dialer{HandshakeTimeout: c.cfg.ConnectTimeout}
	dialCtx, dialCancel := context.WithTimeout(ctx, c.cfg.ConnectTimeout)
	conn, response, err := dialer.DialContext(dialCtx, c.cfg.GatewayURL, http.Header{
		"User-Agent": {"reactorpro-agentd/" + Version},
	})
	dialCancel()
	if err != nil {
		status := ""
		if response != nil {
			status = response.Status
		}
		return fmt.Errorf("dial %s: %v (%s)", c.cfg.GatewayURL, err, status)
	}
	defer func() {
		_ = conn.Close()
		c.setConn(nil)
	}()
	c.setConn(conn)

	// Handshake: hello out, ServerHello back. An auth failure closes with
	// 4401 and lands in the read error below, reported plainly.
	hello := &gatewayv2.ClientHello{
		ProtocolVersion: 2,
		Role:            gatewayv2.ClientRole_CLIENT_ROLE_AGENT,
		Token:           c.cfg.Token,
		AgentId:         c.cfg.AgentID,
		AgentVersion:    Version,
		ClientName:      "reactorpro-agentd",
		ClientVersion:   Version,
		// The wire protocol capability plus the headless-worker marker: the
		// gateway keys its headless conveniences on "agentd" — serving the
		// management UI's history arms from the conversation store and
		// rehydrating resumed conversations into the turn's prompt. The
		// desktop never declares it, so the marker is unambiguous.
		Capabilities: []string{
			gatewayv2.ChatIngressV1Capability,
			"task",
			"agentd",
		},
	}
	if err := c.writeFrame(&gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Hello{Hello: hello},
	}); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(c.cfg.ConnectTimeout)); err != nil {
		return fmt.Errorf("hello deadline: %w", err)
	}
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("read hello: %w", err)
	}
	var helloFrame gatewayv2.AgentServerFrame
	if err := decodeProto(raw, &helloFrame); err != nil {
		return fmt.Errorf("hello frame is not a server frame: %w", err)
	}
	serverHello := helloFrame.GetHello()
	if serverHello == nil || !serverHello.GetOk() {
		message := "the gateway refused the handshake"
		if serverHello != nil {
			message = serverHello.GetMessage()
		}
		return fmt.Errorf("handshake refused: %s", message)
	}
	// The frame loop below reads unbounded again; the hello deadline was
	// only for the handshake window.
	_ = conn.SetReadDeadline(time.Time{})
	c.logger.Info("agentd signed into the gateway",
		"agent_id", c.cfg.AgentID, "session", serverHello.GetSessionId(),
		"capabilities", strings.Join(serverHello.GetCapabilities(), ","))

	// Runtime status events: presence the gateway can show, refreshed on a
	// ticker for the life of this connection.
	statusCtx, statusCancel := context.WithCancel(ctx)
	defer statusCancel()
	go c.statusLoop(statusCtx)

	err = c.frameLoop(ctx)
	statusCancel()
	if c.onDisconnect != nil {
		c.onDisconnect()
	}
	return err
}

// frameLoop reads until the link breaks or ctx ends.
func (c *Client) frameLoop(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			return err
		}
		var frame gatewayv2.AgentServerFrame
		if err := decodeProto(raw, &frame); err != nil {
			// One undecodable frame is noise, not a broken link — but a
			// link that only produces noise should be visible.
			c.logger.Warn("agentd received an undecodable frame", "error", err)
			continue
		}
		switch payload := frame.GetPayload().(type) {
		case *gatewayv2.AgentServerFrame_Hello:
			c.logger.Warn("agentd received a second server hello")
		case *gatewayv2.AgentServerFrame_Envelope:
			c.handleGatewayEnvelope(payload.Envelope)
		default:
			// Unknown arms (features from a newer gateway) are ignored on
			// purpose: forward compatibility without negotiation.
		}
	}
}

// handleGatewayEnvelope dispatches the arms the agentd cares about.
func (c *Client) handleGatewayEnvelope(envelope *gatewayv2.GatewayEnvelope) {
	switch payload := envelope.GetPayload().(type) {
	case *gatewayv2.GatewayEnvelope_Ping:
		// The gateway's liveness probe: answer, or be judged dead. The
		// request id is echoed, which is how the gateway correlates.
		_ = c.writeFrame(&gatewayv2.AgentClientFrame{
			Payload: &gatewayv2.AgentClientFrame_Envelope{
				Envelope: &gatewayv2.AgentEnvelope{
					RequestId: envelope.GetRequestId(),
					Timestamp: time.Now().Unix(),
					Payload: &gatewayv2.AgentEnvelope_Pong{
						Pong: &gatewayv2.PongResponse{Timestamp: time.Now().Unix()},
					},
				},
			},
		})
	case *gatewayv2.GatewayEnvelope_ChatCommand:
		command := payload.ChatCommand
		switch strings.TrimSpace(command.GetType()) {
		case "chat.submit":
			if c.onCommand != nil {
				c.onCommand(envelope.GetRequestId(), command)
			}
		case "chat.cancel":
			if c.onCancel != nil {
				c.onCancel(strings.TrimSpace(command.GetCancel().GetConversationId()))
			}
		default:
			c.logger.Warn("agentd received an unknown chat command type", "type", command.GetType())
		}
	case *gatewayv2.GatewayEnvelope_ChatIngressAck:
		ack := payload.ChatIngressAck
		if code := strings.TrimSpace(ack.GetErrorCode()); code != "" {
			// A refused record means the run's next record will fail the
			// same way; the runner's turn ends honestly. Diagnose loudly.
			c.logger.Warn("agentd ingress record refused",
				"run", ack.GetRunId(), "code", code, "message", ack.GetErrorMessage())
		}
	case *gatewayv2.GatewayEnvelope_HistoryList:
		// The agentd keeps no conversation history — its runs are remote
		// turns recorded by whoever dispatched them. An empty list is the
		// honest answer, and it keeps the UI from waiting on a timeout.
		_ = c.writeFrame(&gatewayv2.AgentClientFrame{
			Payload: &gatewayv2.AgentClientFrame_Envelope{
				Envelope: &gatewayv2.AgentEnvelope{
					RequestId: envelope.GetRequestId(),
					Timestamp: time.Now().Unix(),
					Payload: &gatewayv2.AgentEnvelope_HistoryListResp{
						HistoryListResp: &gatewayv2.HistoryListResponse{
							Conversations: nil,
							TotalCount:    0,
						},
					},
				},
			},
		})
	default:
		// Everything else is desktop territory (settings, providers, fs,
		// history details, …) — but every correlated request MUST be
		// answered, the same contract the desktop honours with its own
		// error responses. Ignoring made the browser time out ("Gateway
		// websocket request timed out: settings get"); a typed refusal is
		// the honest, immediate answer instead.
		_ = c.writeFrame(&gatewayv2.AgentClientFrame{
			Payload: &gatewayv2.AgentClientFrame_Envelope{
				Envelope: &gatewayv2.AgentEnvelope{
					RequestId: envelope.GetRequestId(),
					Timestamp: time.Now().Unix(),
					Payload: &gatewayv2.AgentEnvelope_Error{
						Error: &gatewayv2.ErrorResponse{
							Code: 501,
							Message: fmt.Sprintf(
								"the headless agent runtime (reactorpro-agentd %s) does not implement this operation; it is an executor, not a desktop — chat commands and skills are served, desktop settings and history are not", Version),
						},
					},
				},
			},
		})
	}
}

// SendIngress delivers one chat-ingress record as its own batch — one record
// per batch keeps the sequence discipline trivially contiguous.
func (c *Client) SendIngress(runID, conversationID string, seq uint64, record *gatewayv2.ChatIngressRecord) error {
	return c.writeFrame(&gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Envelope{
			Envelope: &gatewayv2.AgentEnvelope{
				RequestId: fmt.Sprintf("ingress-%s-%d", runID, seq),
				Timestamp: time.Now().Unix(),
				Payload: &gatewayv2.AgentEnvelope_ChatIngressBatch{
					ChatIngressBatch: &gatewayv2.ChatIngressBatch{
						RunId:          runID,
						ConversationId: conversationID,
						FirstSeq:       seq,
						Records:        []*gatewayv2.ChatIngressRecord{record},
					},
				},
			},
		},
	})
}

// statusLoop publishes runtime presence while the link lives.
func (c *Client) statusLoop(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			active := uint32(0)
			if c.activeRuns != nil {
				active = uint32(c.activeRuns())
			}
			_ = c.writeFrame(&gatewayv2.AgentClientFrame{
				Payload: &gatewayv2.AgentClientFrame_Envelope{
					Envelope: &gatewayv2.AgentEnvelope{
						RequestId: fmt.Sprintf("status-%d", time.Now().Unix()),
						Timestamp: time.Now().Unix(),
						Payload: &gatewayv2.AgentEnvelope_RuntimeStatus{
							RuntimeStatus: &gatewayv2.RuntimeStatusEvent{
								WorkerId:       c.cfg.AgentID,
								State:          "ready",
								Visible:        false,
								ActiveRunCount: active,
								Timestamp:      time.Now().Unix(),
							},
						},
					},
				},
			})
		}
	}
}

func (c *Client) writeFrame(frame *gatewayv2.AgentClientFrame) error {
	raw, err := encodeProto(frame)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.conn == nil {
		return fmt.Errorf("gateway link is down")
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
	if err := c.conn.WriteMessage(websocket.BinaryMessage, raw); err != nil {
		return err
	}
	return c.conn.SetWriteDeadline(time.Time{})
}

func (c *Client) setConn(conn *websocket.Conn) {
	c.writeMu.Lock()
	c.conn = conn
	c.writeMu.Unlock()
}
