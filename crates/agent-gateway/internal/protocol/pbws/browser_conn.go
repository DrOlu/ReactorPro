package pbws

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// browserConnSeq assigns a request_id namespace prefix to each browser connection,
// eliminating the possibility of association id collisions on the agent side when
// multiple tabs run concurrently.
var browserConnSeq atomic.Uint64

// browserConn is a single browser connection on /ws/v2.
type browserConn struct {
	cfg *config.Config
	sm  *session.Manager
	srv *Server

	conn *websocket.Conn
	core *wscore.Conn
	done <-chan struct{}

	// idPrefix + the original request_id form the association id forwarded to the
	// desktop; it is stripped on the return path.
	idPrefix string

	terminalInterest *shared.TerminalInterestTracker

	// dispatchLimiter caps the number of in-flight dispatches (an upper bound on
	// slow-request goroutines); rateLimiter caps the inbound frame rate (an upper
	// bound on fast-frame CPU). Together they bound a single connection's resource use.
	dispatchLimiter *wscore.DispatchLimiter
	rateLimiter     *wscore.InboundRateLimiter

	chatStreamsMu sync.Mutex
	chatStreams   map[string]func() // agent_id + conversation_id -> subscription cancel

	workspaceSubsMu sync.Mutex
	workspaceSubs   map[string]*workspaceSubscription
}

// BrowserHandler returns the HTTP handler for /ws/v2.
func (s *Server) BrowserHandler() http.Handler {
	upgrader := s.upgrader()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		release, ok := acquireConnSlot(&s.browserConns, s.maxBrowserConnections())
		if !ok {
			http.Error(w, "too many browser connections", http.StatusServiceUnavailable)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			release()
			return
		}
		defer release()
		conn.SetReadLimit(browserReadLimit)

		c := &browserConn{
			cfg:              s.cfg,
			sm:               s.sm,
			srv:              s,
			conn:             conn,
			idPrefix:         browserIDPrefix(),
			terminalInterest: shared.NewTerminalInterestTracker(),
			dispatchLimiter:  wscore.NewDispatchLimiter(maxInflightDispatches),
			rateLimiter: wscore.NewInboundRateLimiter(
				browserInboundFramesPerSecond, browserInboundBurst, browserRateLimitMaxViolations,
			),
		}
		c.core = wscore.NewConn(conn, wscore.Config{
			WriteTimeout: s.cfg.WebSocketWriteTimeout,
			QueueSize:    s.cfg.WebSocketWriteQueueSize,
			// The chat_subscribed replay is a single FrameResponse that can
			// carry a near-full event ring (8 MiB approx-counted, JSON-marshal
			// expansion ~1.5x) plus a projection snapshot (≤4 MiB); size the
			// data-queue byte budget with headroom so a legitimate replay
			// never trips the frame_too_large connection close.
			QueueBytes:      24 * 1024 * 1024,
			HeartbeatPeriod: s.cfg.WebSocketHeartbeatPeriod,
			HeartbeatGrace:  s.cfg.WebSocketHeartbeatGrace,
			Remote:          r.RemoteAddr,
			OnClose:         c.releaseSubscriptions,
		})
		c.done = c.core.Done()
		// WS control-frame pongs are answered by the browser network stack (even for
		// background-throttled tabs), so they must count as liveness evidence.
		conn.SetPongHandler(func(string) error {
			c.core.TouchInboundActivity()
			return nil
		})
		_ = conn.SetReadDeadline(time.Now().Add(c.core.IdleTimeout()))
		defer c.core.Close()
		c.serve()
	})
}

func browserIDPrefix() string {
	// The prefix only needs to be short and unique within the process; the peer
	// simply echoes it back verbatim.
	return "b" + strconv.FormatUint(browserConnSeq.Add(1), 10) + ":"
}

// serve is the read loop: the first frame must be hello, after which frames are
// dispatched by payload arm. chat/workspace subscription lifecycle frames are executed
// inline in the read loop to preserve frame order (a re-subscription sends
// [unsubscribe, subscribe] back-to-back, and concurrent dispatch would let the old
// unsubscribe cancel the new subscription); all other requests are handled in their
// own goroutine.
func (c *browserConn) serve() {
	if !c.handshake() {
		return
	}

	observability.Usage.V2BrowserConnectionsTotal.Add(1)
	observability.Usage.V2BrowserConnectionsActive.Add(1)
	defer observability.Usage.V2BrowserConnectionsActive.Add(-1)

	for {
		frame, ok := c.readFrame()
		if !ok {
			return
		}
		c.core.TouchInboundActivity()

		// Inbound rate limiting: frames over the limit are dropped with an error;
		// repeated violations mark the client as out of control and close the connection.
		if allowed, exceeded := c.rateLimiter.Allow(); !allowed {
			if exceeded {
				return
			}
			_ = c.sendLocalError(frame.GetRequestId(), "too many requests")
			continue
		}

		switch payload := frame.GetPayload().(type) {
		case *gatewayv2.WebClientFrame_Pong:
			continue
		case *gatewayv2.WebClientFrame_Hello:
			_ = c.sendLocalError(frame.GetRequestId(), "already authenticated")
			continue
		case *gatewayv2.WebClientFrame_ChatSubscribe,
			*gatewayv2.WebClientFrame_ChatUnsubscribe,
			*gatewayv2.WebClientFrame_WorkspaceSubscribe,
			*gatewayv2.WebClientFrame_WorkspaceUnsubscribe:
			c.dispatch(frame)
		case nil:
			_ = c.sendLocalError(frame.GetRequestId(), "frame payload is required")
			continue
		default:
			_ = payload
			// A failed try-acquire means immediate rejection: never block the read loop
			// waiting for a slot (that would starve pong/liveness detection).
			if !c.dispatchLimiter.TryAcquire() {
				_ = c.sendLocalError(frame.GetRequestId(), "too many concurrent requests")
				continue
			}
			go func(frame *gatewayv2.WebClientFrame) {
				defer c.dispatchLimiter.Release()
				c.dispatch(frame)
			}(frame)
		}
	}
}

// readFrame reads and decodes one frame; a decode failure means the frame stream is
// corrupted, so the connection is closed immediately.
func (c *browserConn) readFrame() (*gatewayv2.WebClientFrame, bool) {
	for {
		messageType, data, err := c.conn.ReadMessage()
		if err != nil {
			return nil, false
		}
		if messageType != websocket.BinaryMessage {
			// Text frames are meaningless on the v2 link; tolerate and ignore them
				// (they still count toward liveness).
			c.core.TouchInboundActivity()
			continue
		}
		var frame gatewayv2.WebClientFrame
		if err := proto.Unmarshal(data, &frame); err != nil {
			return nil, false
		}
		return &frame, true
	}
}

// handshake handles the first hello frame; on failure it writes a failure response
// and closes.
func (c *browserConn) handshake() bool {
	frame, ok := c.readFrame()
	if !ok {
		return false
	}
	hello := frame.GetHello()
	verdict := c.srv.vetHello(hello, gatewayv2.ClientRole_CLIENT_ROLE_BROWSER)
	if !verdict.ok {
		_ = writeDirectMessage(c.conn, c.srv.writeTimeout(), &gatewayv2.WebServerFrame{
			RequestId: frame.GetRequestId(),
			Payload: &gatewayv2.WebServerFrame_Hello{
				Hello: c.srv.serverHello(false, verdict.message, "", browserReadLimit),
			},
		})
		closeUnauthorized(c.conn, c.srv.writeTimeout())
		return false
	}

	c.core.SetAuthorized()
	// The read deadline before the handshake is deliberately not refreshed; it is
	// renewed immediately after success.
	c.core.TouchInboundActivity()
	c.core.StartWriteLoop()
	c.startEventForwarders()
	c.core.StartHeartbeat(c.buildHeartbeatPing)

	// The hello response goes through the data queue (FrameResponse): FIFO with the
	// snapshot replay in the same queue, ensuring the client receives hello before the
	// replay frames (across queues there is only priority, no ordering guarantee).
	if err := c.send(wscore.FrameResponse, "hello", &gatewayv2.WebServerFrame{
		RequestId: frame.GetRequestId(),
		Payload: &gatewayv2.WebServerFrame_Hello{
			Hello: c.srv.serverHello(true, "", "", browserReadLimit),
		},
	}); err != nil {
		c.core.Close()
		return false
	}
	c.replaySnapshots()
	return true
}

func (c *browserConn) dispatch(frame *gatewayv2.WebClientFrame) {
	observability.Usage.V2BrowserRequestsTotal.Add(1)
	requestID := strings.TrimSpace(frame.GetRequestId())
	// Target-scoped requests must explicitly declare an Agent; directory and global
	// session queries do not need a target id.
	agentID := strings.TrimSpace(frame.GetAgentId())

	switch payload := frame.GetPayload().(type) {
	case *gatewayv2.WebClientFrame_AgentRequest:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleAgentRequest(requestID, agentID, payload.AgentRequest)
	case *gatewayv2.WebClientFrame_StatusGet:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleStatusGet(requestID, agentID)
	case *gatewayv2.WebClientFrame_ChatCommand:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleChatCommand(requestID, agentID, payload.ChatCommand)
	case *gatewayv2.WebClientFrame_ChatPrepare:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleChatPrepare(requestID, agentID, payload.ChatPrepare)
	case *gatewayv2.WebClientFrame_ChatSubscribe:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleChatSubscribe(requestID, agentID, payload.ChatSubscribe)
	case *gatewayv2.WebClientFrame_ChatUnsubscribe:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleChatUnsubscribe(requestID, agentID, payload.ChatUnsubscribe)
	case *gatewayv2.WebClientFrame_ChatActivities:
		c.handleChatActivities(requestID)
	case *gatewayv2.WebClientFrame_WorkspaceSubscribe:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleWorkspaceSubscribe(requestID, agentID, payload.WorkspaceSubscribe)
	case *gatewayv2.WebClientFrame_WorkspaceUnsubscribe:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleWorkspaceUnsubscribe(requestID, agentID, payload.WorkspaceUnsubscribe)
	case *gatewayv2.WebClientFrame_AgentList:
		c.handleAgentList(requestID)
	default:
		_ = c.sendLocalError(requestID, "unsupported frame payload")
	}
}

func (c *browserConn) requireAgentID(requestID, agentID string) bool {
	if agentID != "" {
		return true
	}
	_ = c.sendLocalError(requestID, "agent_id is required")
	return false
}

// send encodes and delivers one frame (the congestion policy is declared by the
// frame class and enforced uniformly by wscore).
func (c *browserConn) send(class wscore.FrameClass, kind string, frame *gatewayv2.WebServerFrame) error {
	data, err := proto.Marshal(frame)
	if err != nil {
		return err
	}
	return c.core.Enqueue(wscore.Frame{
		Class:       class,
		RequestID:   frame.GetRequestId(),
		Kind:        kind,
		MessageType: websocket.BinaryMessage,
		Data:        data,
	})
}

// sendLocalError sends back a structured gateway-local error through the control
// queue to guarantee reachability under congestion.
func (c *browserConn) sendLocalError(requestID string, message string) error {
	return c.send(wscore.FrameControl, "local_error", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_LocalError{
			LocalError: &gatewayv2.ErrorResponse{Message: message},
		},
	})
}

// buildHeartbeatPing constructs an application-layer PingFrame for the shared
// heartbeat loop.
func (c *browserConn) buildHeartbeatPing() (wscore.Frame, bool) {
	data, err := proto.Marshal(&gatewayv2.WebServerFrame{
		Payload: &gatewayv2.WebServerFrame_Ping{
			Ping: &gatewayv2.PingFrame{Timestamp: time.Now().Unix()},
		},
	})
	if err != nil {
		return wscore.Frame{}, false
	}
	return wscore.Frame{
		Class:       wscore.FramePing,
		Kind:        "ping",
		MessageType: websocket.BinaryMessage,
		Data:        data,
	}, true
}
