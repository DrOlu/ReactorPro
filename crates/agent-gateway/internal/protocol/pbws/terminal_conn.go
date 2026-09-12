package pbws

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Terminal data plane (/ws/v2/terminal): both ends share one path, and the
// role is distinguished by hello. The browser role maintains attach/detach
// subscriptions and validates input/resize; the Agent role registers a data
// channel and broadcasts inbound frames. Both ends exchange proto
// TerminalStreamFrame directly.

const terminalWriteQueueSize = 1024

// TerminalHandler returns the HTTP handler for /ws/v2/terminal.
func (s *Server) TerminalHandler() http.Handler {
	upgrader := s.upgrader()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		release, ok := acquireConnSlot(&s.terminalConns, s.maxTerminalConnections())
		if !ok {
			http.Error(w, "too many terminal connections", http.StatusServiceUnavailable)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			release()
			return
		}
		defer release()
		// Before the role is known, apply the stricter browser limit; relax
		// it once hello identifies the Agent role.
		conn.SetReadLimit(terminalBrowserReadLimit)
		s.serveTerminal(conn)
	})
}

func (s *Server) serveTerminal(conn *websocket.Conn) {
	defer func() { _ = conn.Close() }()

	frame, ok := readTerminalFrame(conn)
	if !ok {
		return
	}
	hello := frame.GetHello()
	// The terminal path is shared by both ends: validate against the role
	// declared in hello (treat an unspecified role as browser).
	wantRole := hello.GetRole()
	if wantRole == gatewayv2.ClientRole_CLIENT_ROLE_UNSPECIFIED {
		wantRole = gatewayv2.ClientRole_CLIENT_ROLE_BROWSER
	}
	verdict := s.vetHello(hello, wantRole)
	if verdict.ok && strings.TrimSpace(hello.GetAgentId()) == "" {
		verdict = helloVerdict{message: "agent_id is required"}
	}
	if !verdict.ok {
		_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.TerminalServerFrame{
			Payload: &gatewayv2.TerminalServerFrame_Hello{
				Hello: s.serverHello(false, verdict.message, "", terminalBrowserReadLimit),
			},
		})
		closeUnauthorized(conn, s.writeTimeout())
		return
	}

	boundAgentID := strings.TrimSpace(hello.GetAgentId())
	var (
		authEpoch uint64
		toAgent   chan *gatewayv2.TerminalStreamFrame
		agentCtx  context.Context
		cancel    context.CancelFunc
		cleanup   func()
	)
	if wantRole == gatewayv2.ClientRole_CLIENT_ROLE_AGENT {
		var err error
		authEpoch, err = s.authenticateAgentHello(hello)
		if err != nil {
			message := "gateway storage unavailable"
			if errors.Is(err, agenttoken.ErrUnauthorized) {
				message = "unauthorized"
			}
			_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.TerminalServerFrame{
				Payload: &gatewayv2.TerminalServerFrame_Hello{
					Hello: s.serverHello(false, message, "", terminalAgentReadLimit),
				},
			})
			if errors.Is(err, agenttoken.ErrUnauthorized) {
				closeUnauthorized(conn, s.writeTimeout())
			}
			return
		}

		agentCtx, cancel = context.WithCancel(context.Background())
		defer cancel()
		go func() {
			<-agentCtx.Done()
			_ = conn.Close()
		}()
		toAgent = make(chan *gatewayv2.TerminalStreamFrame, 4096)
		var registered bool
		cleanup, registered = s.sm.RegisterTerminalStreamToAgentIfCurrent(
			boundAgentID,
			toAgent,
			cancel,
			func() bool {
				return s.tokens.AuthenticationCurrent(boundAgentID, authEpoch)
			},
		)
		if !registered {
			_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.TerminalServerFrame{
				Payload: &gatewayv2.TerminalServerFrame_Hello{
					Hello: s.serverHello(false, "unauthorized", "", terminalAgentReadLimit),
				},
			})
			closeUnauthorized(conn, s.writeTimeout())
			return
		}
		defer cleanup()
	}

	// Once the role is known, adjust the read limit per link and report
	// the actual value in hello.
	roleReadLimit := int64(terminalBrowserReadLimit)
	if wantRole == gatewayv2.ClientRole_CLIENT_ROLE_AGENT {
		roleReadLimit = terminalAgentReadLimit
	}
	conn.SetReadLimit(roleReadLimit)
	if err := writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.TerminalServerFrame{
		Payload: &gatewayv2.TerminalServerFrame_Hello{
			Hello: s.serverHello(true, "", "", roleReadLimit),
		},
	}); err != nil {
		return
	}

	if wantRole == gatewayv2.ClientRole_CLIENT_ROLE_AGENT {
		observability.Usage.V2TerminalConnectsTotal.Add(1)
		s.serveTerminalAgent(conn, boundAgentID, agentCtx, cancel, toAgent)
		return
	}
	observability.Usage.V2TerminalConnectsTotal.Add(1)
	s.serveTerminalBrowser(conn, boundAgentID)
}

func readTerminalFrame(conn *websocket.Conn) (*gatewayv2.TerminalClientFrame, bool) {
	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			return nil, false
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		var frame gatewayv2.TerminalClientFrame
		if err := proto.Unmarshal(data, &frame); err != nil {
			return nil, false
		}
		return &frame, true
	}
}

// ---------------------------------------------------------------------------
// Agent role
// ---------------------------------------------------------------------------

func (s *Server) serveTerminalAgent(
	conn *websocket.Conn,
	agentID string,
	ctx context.Context,
	cancel context.CancelFunc,
	toAgent <-chan *gatewayv2.TerminalStreamFrame,
) {
	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-toAgent:
				if frame == nil {
					continue
				}
				if !s.writeTerminalFrame(conn, frame) {
					return
				}
			}
		}
	}()

	for {
		frame, ok := readTerminalFrame(conn)
		if !ok {
			cancel()
			return
		}
		if streamFrame := frame.GetFrame(); streamFrame != nil {
			s.sm.BroadcastTerminalStreamFrame(agentID, streamFrame)
		}
	}
}

func (s *Server) writeTerminalFrame(conn *websocket.Conn, frame *gatewayv2.TerminalStreamFrame) bool {
	data, err := proto.Marshal(&gatewayv2.TerminalServerFrame{
		Payload: &gatewayv2.TerminalServerFrame_Frame{Frame: frame},
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

// ---------------------------------------------------------------------------
// Browser role
// ---------------------------------------------------------------------------

type terminalBrowserConn struct {
	srv  *Server
	sm   *session.Manager
	conn *websocket.Conn
	// agentID is the target Agent this connection explicitly binds to via
	// hello.agent_id; outbound is routed by it, and inbound only admits
	// same-origin frames.
	agentID string

	out  chan []byte
	done chan struct{}
	once sync.Once

	mu       sync.RWMutex
	attached map[string]struct{}
	streams  map[string]struct{}
}

func (s *Server) serveTerminalBrowser(conn *websocket.Conn, agentID string) {
	c := &terminalBrowserConn{
		srv:      s,
		sm:       s.sm,
		conn:     conn,
		agentID:  agentID,
		out:      make(chan []byte, terminalWriteQueueSize),
		done:     make(chan struct{}),
		attached: make(map[string]struct{}),
		streams:  make(map[string]struct{}),
	}
	defer c.close()

	go c.writeLoop()
	c.startForwarder()

	for {
		frame, ok := readTerminalFrame(conn)
		if !ok {
			return
		}
		streamFrame := frame.GetFrame()
		if streamFrame == nil {
			continue
		}
		c.handleFrame(streamFrame)
	}
}

func (c *terminalBrowserConn) handleFrame(frame *gatewayv2.TerminalStreamFrame) {
	kind := strings.TrimSpace(frame.GetKind())
	if !c.frameAllowed(frame) {
		c.enqueueFrame(terminalErrorFrame(frame, shared.TerminalPermissionError(kind)))
		return
	}

	switch kind {
	case "attach":
		c.remember(frame.GetSessionId(), frame.GetStreamId())
	case "detach":
		c.forget(frame.GetSessionId(), frame.GetStreamId())
	case "input", "resize":
		if !c.isAttached(frame.GetSessionId()) {
			c.enqueueFrame(terminalErrorFrame(frame, "terminal stream is not attached"))
			return
		}
	default:
		c.enqueueFrame(terminalErrorFrame(frame, "unsupported terminal stream frame"))
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.sm.SendTerminalFrameToAgent(ctx, c.agentID, frame); err != nil {
		message := "desktop agent is offline"
		if !errors.Is(err, session.ErrAgentOffline) {
			message = err.Error()
		}
		c.enqueueFrame(terminalErrorFrame(frame, message))
	}
}

func (c *terminalBrowserConn) frameAllowed(frame *gatewayv2.TerminalStreamFrame) bool {
	if frame == nil {
		return false
	}
	view := c.sm.AgentView(c.agentID)
	sessionID := strings.TrimSpace(frame.GetSessionId())
	switch view.TerminalSessionKind(sessionID) {
	case "ssh":
		return view.WebSshTerminalEnabled()
	case "local":
		return view.WebTerminalEnabled()
	default:
		return view.WebTerminalEnabled() || view.WebSshTerminalEnabled()
	}
}

func (c *terminalBrowserConn) startForwarder() {
	frames, cleanup := c.sm.SubscribeTerminalStreamFrames()
	go func() {
		defer cleanup()
		for {
			select {
			case <-c.done:
				return
			case frame, ok := <-frames:
				if !ok {
					c.close()
					return
				}
				if !c.fromBoundAgent(frame.AgentID) || !c.shouldForward(frame.Event) {
					continue
				}
				c.enqueueFrame(frame.Event)
			}
		}
	}()
}

// fromBoundAgent reports whether the frame originates from the Agent
// explicitly bound to this connection.
func (c *terminalBrowserConn) fromBoundAgent(frameAgentID string) bool {
	return frameAgentID == c.agentID
}

func (c *terminalBrowserConn) shouldForward(frame *gatewayv2.TerminalStreamFrame) bool {
	if frame == nil {
		return false
	}
	kind := strings.TrimSpace(frame.GetKind())
	if kind == "snapshot" || kind == "error" {
		return c.knowsStream(frame.GetStreamId())
	}
	if kind != "output" {
		return false
	}
	return c.isAttached(frame.GetSessionId())
}

func (c *terminalBrowserConn) remember(sessionID string, streamID string) {
	sessionID = strings.TrimSpace(sessionID)
	streamID = strings.TrimSpace(streamID)
	if sessionID == "" && streamID == "" {
		return
	}
	c.mu.Lock()
	if sessionID != "" {
		c.attached[sessionID] = struct{}{}
	}
	if streamID != "" {
		c.streams[streamID] = struct{}{}
	}
	c.mu.Unlock()
}

func (c *terminalBrowserConn) forget(sessionID string, streamID string) {
	sessionID = strings.TrimSpace(sessionID)
	streamID = strings.TrimSpace(streamID)
	if sessionID == "" && streamID == "" {
		return
	}
	c.mu.Lock()
	if sessionID != "" {
		delete(c.attached, sessionID)
	}
	if streamID != "" {
		delete(c.streams, streamID)
	}
	c.mu.Unlock()
}

func (c *terminalBrowserConn) isAttached(sessionID string) bool {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return false
	}
	c.mu.RLock()
	_, ok := c.attached[sessionID]
	c.mu.RUnlock()
	return ok
}

func (c *terminalBrowserConn) knowsStream(streamID string) bool {
	streamID = strings.TrimSpace(streamID)
	if streamID == "" {
		return false
	}
	c.mu.RLock()
	_, ok := c.streams[streamID]
	c.mu.RUnlock()
	return ok
}

// enqueueFrame closes the connection when the queue is full (terminal
// output tolerates no dropped frames; the client recovers after reconnect
// via attach + snapshot).
func (c *terminalBrowserConn) enqueueFrame(frame *gatewayv2.TerminalStreamFrame) {
	data, err := proto.Marshal(&gatewayv2.TerminalServerFrame{
		Payload: &gatewayv2.TerminalServerFrame_Frame{Frame: frame},
	})
	if err != nil {
		return
	}
	select {
	case <-c.done:
	case c.out <- data:
	default:
		c.close()
	}
}

func (c *terminalBrowserConn) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case payload := <-c.out:
			if timeout := c.srv.writeTimeout(); timeout > 0 {
				_ = c.conn.SetWriteDeadline(time.Now().Add(timeout))
			}
			if err := c.conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
				c.close()
				return
			}
			_ = c.conn.SetWriteDeadline(time.Time{})
		}
	}
}

func (c *terminalBrowserConn) close() {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

func terminalErrorFrame(source *gatewayv2.TerminalStreamFrame, message string) *gatewayv2.TerminalStreamFrame {
	return &gatewayv2.TerminalStreamFrame{
		Kind:           "error",
		StreamId:       strings.TrimSpace(source.GetStreamId()),
		SessionId:      strings.TrimSpace(source.GetSessionId()),
		ProjectPathKey: strings.TrimSpace(source.GetProjectPathKey()),
		Error:          strings.TrimSpace(message),
	}
}
