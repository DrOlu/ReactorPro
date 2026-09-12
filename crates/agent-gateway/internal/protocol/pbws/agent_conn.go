package pbws

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

const (
	agentInboundQueueFrames = 512
	// Must admit any single frame the read limit allows (64 MiB default):
	// interactive responses (fs reads, history payloads) arrive on this same
	// queue, and an over-budget frame kills the session. The byte budget
	// bounds queue memory, not frame size.
	agentInboundQueueBytes = int64(64 * 1024 * 1024)
)

type queuedAgentEnvelope struct {
	envelope     *gatewayv2.AgentEnvelope
	encodedBytes int64
}

// AgentHandler returns the HTTP handler for /ws/v2/agent: the hello frame completes
// authentication and session registration together, after which the bidirectional envelope stream begins.
func (s *Server) AgentHandler() http.Handler {
	upgrader := s.upgrader()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		release, ok := acquireConnSlot(&s.agentConns, s.maxAgentConnections())
		if !ok {
			http.Error(w, "too many agent connections", http.StatusServiceUnavailable)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			release()
			return
		}
		defer release()
		conn.SetReadLimit(s.readLimit())
		s.serveAgent(conn)
	})
}

func (s *Server) serveAgent(conn *websocket.Conn) {
	defer func() { _ = conn.Close() }()

	// ---- Handshake: hello completes authentication and session registration together ----
	frame, _, ok := readAgentFrame(conn)
	if !ok {
		return
	}
	hello := frame.GetHello()
	verdict := s.vetHello(hello, gatewayv2.ClientRole_CLIENT_ROLE_AGENT)
	if !verdict.ok {
		_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.AgentServerFrame{
			Payload: &gatewayv2.AgentServerFrame_Hello{
				Hello: s.serverHello(false, verdict.message, "", s.readLimit()),
			},
		})
		closeUnauthorized(conn, s.writeTimeout())
		return
	}
	authEpoch, err := s.authenticateAgentHello(hello)
	if err != nil {
		message := "gateway storage unavailable"
		if errors.Is(err, agenttoken.ErrUnauthorized) {
			message = "unauthorized"
		}
		_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.AgentServerFrame{
			Payload: &gatewayv2.AgentServerFrame_Hello{
				Hello: s.serverHello(false, message, "", s.readLimit()),
			},
		})
		if errors.Is(err, agenttoken.ErrUnauthorized) {
			closeUnauthorized(conn, s.writeTimeout())
		}
		return
	}

	sessionID := uuid.NewString()
	authSnapshot := session.AuthSnapshot{
		AgentID:      hello.GetAgentId(),
		AgentVersion: hello.GetAgentVersion(),
		SessionID:    sessionID,
	}
	sess := session.NewAgentSession(authSnapshot)
	sess.SetCapabilities(hello.GetCapabilities())
	toAgent := sess.Outbound()
	if !s.sm.SetAuthenticatedSessionIfCurrent(sess, func() bool {
		return s.tokens.AuthenticationCurrent(hello.GetAgentId(), authEpoch)
	}) {
		_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.AgentServerFrame{
			Payload: &gatewayv2.AgentServerFrame_Hello{
				Hello: s.serverHello(false, "unauthorized", "", s.readLimit()),
			},
		})
		closeUnauthorized(conn, s.writeTimeout())
		return
	}
	defer s.sm.ClearSession(sess)
	if err := writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.AgentServerFrame{
		Payload: &gatewayv2.AgentServerFrame_Hello{
			Hello: s.serverHello(true, "", sessionID, s.readLimit()),
		},
	}); err != nil {
		return
	}

	observability.Usage.V2AgentConnectsTotal.Add(1)
	observability.Usage.V2AgentActive.Add(1)
	defer observability.Usage.V2AgentActive.Add(-1)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-ctx.Done():
		case <-sess.Done():
			cancel()
		}
	}()
	// When ctx ends, close the underlying connection to unblock the read loop.
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()

	go s.agentHeartbeatLoop(ctx, conn, sess)

	inbound := make(chan queuedAgentEnvelope, agentInboundQueueFrames)
	var inboundBytes atomic.Int64
	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case <-sess.Done():
				return
			case queued := <-inbound:
				if queued.envelope != nil {
					s.sm.DispatchFromAgentForSession(sess, queued.envelope)
				}
				releaseAgentInboundBytes(&inboundBytes, queued.encodedBytes)
			}
		}
	}()

	// WS control-frame pong counts toward desktop liveness (the counterpart of h2 keepalive).
	conn.SetPongHandler(func(string) error {
		s.sm.TouchHeartbeat(sess)
		return nil
	})

	// ---- Outbound pump: the heartbeat-only channel takes priority, so congestion can never starve keepalive ----
	go func() {
		defer cancel()
		pings := sess.Pings()
		for {
			select {
			case ping := <-pings:
				if !s.writeAgentEnvelope(conn, ping) {
					return
				}
				continue
			default:
			}
			select {
			case <-ctx.Done():
				return
			case <-sess.Done():
				return
			case ping := <-pings:
				if !s.writeAgentEnvelope(conn, ping) {
					return
				}
			case outbound := <-toAgent:
				if outbound == nil || outbound.GatewayEnvelope == nil {
					continue
				}
				select {
				case <-outbound.Context().Done():
					outbound.Ack(outbound.Context().Err())
					continue
				default:
				}
				if !s.writeAgentEnvelope(conn, outbound.GatewayEnvelope) {
					outbound.Ack(context.Canceled)
					return
				}
				outbound.Ack(nil)
			}
		}
	}()

	// ---- Inbound loop ----
	for {
		frame, encodedBytes, ok := readAgentFrame(conn)
		if !ok {
			cancel()
			return
		}
		env := frame.GetEnvelope()
		if env == nil {
			// Duplicate hello or empty frame: ignore (still counts toward liveness).
			s.sm.TouchHeartbeat(sess)
			continue
		}
		// Any inbound envelope proves the desktop is alive; an agent in the middle of an active stream must never be judged heartbeat-expired.
		s.sm.TouchHeartbeat(sess)
		// A single bounded dispatcher preserves envelope ordering while decoupling
		// protobuf reads from business processing. When the frame-count or byte
		// watermark saturates, the current session is discarded immediately; the
		// agent replays reliable chat on a new connection, so a slow handler must
		// not block the reader and heartbeat in reverse.
		queuedBytes := int64(encodedBytes)
		if !reserveAgentInboundBytes(&inboundBytes, queuedBytes) {
			noteAgentInboundOverflow(sess, queuedBytes, "byte_limit")
			cancel()
			return
		}
		select {
		case <-ctx.Done():
			releaseAgentInboundBytes(&inboundBytes, queuedBytes)
			return
		case <-sess.Done():
			releaseAgentInboundBytes(&inboundBytes, queuedBytes)
			return
		case inbound <- queuedAgentEnvelope{envelope: env, encodedBytes: queuedBytes}:
		default:
			releaseAgentInboundBytes(&inboundBytes, queuedBytes)
			noteAgentInboundOverflow(sess, queuedBytes, "frame_limit")
			cancel()
			return
		}
	}
}

func noteAgentInboundOverflow(sess *session.AgentSession, size int64, reason string) {
	agentID := ""
	sessionID := ""
	if sess != nil {
		agentID = strings.TrimSpace(sess.AgentID)
		sessionID = strings.TrimSpace(sess.SessionID)
	}
	observability.Usage.V2AgentInboundOverflowsTotal.Add(1)
	slog.Warn("agent_inbound_overflow",
		"agent_id", agentID,
		"session_id", sessionID,
		"lane", "agent_inbound",
		"size", size,
		"reason", reason,
	)
}

func readAgentFrame(conn *websocket.Conn) (*gatewayv2.AgentClientFrame, int, bool) {
	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			return nil, 0, false
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		var frame gatewayv2.AgentClientFrame
		if err := proto.Unmarshal(data, &frame); err != nil {
			return nil, 0, false
		}
		return &frame, len(data), true
	}
}

func reserveAgentInboundBytes(queuedBytes *atomic.Int64, frameBytes int64) bool {
	if frameBytes < 0 || frameBytes > agentInboundQueueBytes {
		return false
	}
	for {
		current := queuedBytes.Load()
		if frameBytes > agentInboundQueueBytes-current {
			return false
		}
		if queuedBytes.CompareAndSwap(current, current+frameBytes) {
			return true
		}
	}
}

func releaseAgentInboundBytes(queuedBytes *atomic.Int64, frameBytes int64) {
	for {
		current := queuedBytes.Load()
		next := current - frameBytes
		if next < 0 {
			next = 0
		}
		if queuedBytes.CompareAndSwap(current, next) {
			return
		}
	}
}

// writeAgentEnvelope serializes and writes one GatewayEnvelope frame (no mutex needed for a single writer; WriteControl is concurrency-safe with it).
func (s *Server) writeAgentEnvelope(conn *websocket.Conn, env *gatewayv2.GatewayEnvelope) bool {
	data, err := proto.Marshal(&gatewayv2.AgentServerFrame{
		Payload: &gatewayv2.AgentServerFrame_Envelope{Envelope: env},
	})
	if err != nil {
		return false
	}
	if timeout := s.writeTimeout(); timeout > 0 {
		if err := conn.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
			return false
		}
		defer func() { _ = conn.SetWriteDeadline(time.Time{}) }()
	}
	return conn.WriteMessage(websocket.BinaryMessage, data) == nil
}

// agentHeartbeatLoop: periodically sends application-layer Ping (over the dedicated heartbeat channel),
// evicts heartbeat-expired sessions; additionally sends a WS control-frame ping, with tokio-tungstenite's automatic pong handling transport-layer keepalive.
func (s *Server) agentHeartbeatLoop(ctx context.Context, conn *websocket.Conn, sess *session.AgentSession) {
	period := 30 * time.Second
	if s.cfg != nil && s.cfg.HeartbeatPeriod > 0 {
		period = s.cfg.HeartbeatPeriod
	}
	ticker := time.NewTicker(period)
	defer ticker.Stop()

	if !s.sendAgentHeartbeat(sess) {
		return
	}

	timeout := period * 3
	for {
		select {
		case <-ctx.Done():
			return
		case <-sess.Done():
			return
		case <-ticker.C:
			if s.sm.ClearSessionIfHeartbeatStale(sess, timeout) {
				return
			}
			deadline := time.Now().Add(s.writeTimeout())
			_ = conn.WriteControl(websocket.PingMessage, nil, deadline)
			if !s.sendAgentHeartbeat(sess) {
				return
			}
		}
	}
}

func (s *Server) sendAgentHeartbeat(sess *session.AgentSession) bool {
	return sess.SendPing(&gatewayv2.GatewayEnvelope{
		RequestId: "ping-" + uuid.NewString(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.GatewayEnvelope_Ping{
			Ping: &gatewayv2.PingRequest{
				Timestamp: time.Now().Unix(),
			},
		},
	}) == nil
}
