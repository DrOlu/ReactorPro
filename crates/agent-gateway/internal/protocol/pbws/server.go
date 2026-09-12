// Package pbws implements the three links of the v2 unified wire protocol (WebSocket+Protobuf)
// server (see proto/v2/gateway_ws.proto): /ws/v2 browser passthrough, /ws/v2/agent desktop envelope
// stream, and /ws/v2/terminal terminal data plane.
// This package only does frame encoding/decoding, auth handshake, passthrough whitelisting, and
// event fan-out; session state reuses session, the transport runtime reuses wscore, and cross-
// protocol-domain logic reuses shared and chatcmd.
package pbws

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Subprotocol is the v2 WebSocket subprotocol name; the server must echo it, otherwise the browser
// actively aborts the handshake.
const Subprotocol = "liveagent.v2.pb"

// ProtocolVersion is the protocol version implemented by this package (ClientHello.protocol_version).
const ProtocolVersion = 2

// closeCodeUnauthorized is the custom close code for authentication failure (4000-4999 is the
// application-reserved range).
const closeCodeUnauthorized = 4401

// Hardening limits: the damage from a single connection (a bug or a stolen credential) must be
// confined to that connection and must not escalate into a whole-gateway failure. The concurrent
// connection limits have become config items (config.DefaultMax*Connections are the defaults);
// the values below are fixed per-connection values, independent of the total count.
const (
	// In-flight dispatch limit per browser connection: passthrough requests can block on
	// AwaitUnaryResponse until requestTimeout (2 minutes by default), and without a limit a retry
	// storm is a goroutine leak.
	maxInflightDispatches = 16

	// Browser-link inbound rate limit (frames/second): a normal webui is far below this, so there
	// are no false positives.
	browserInboundFramesPerSecond = 100
	browserInboundBurst           = 200
	browserRateLimitMaxViolations = 3

	// Read limits are tightened per link: legitimate browser control frames are only a few hundred KB,
	// so the 64 MiB limit is a memory-amplification attack surface; the Agent link keeps the config
	// value (needed for uploads).
	browserReadLimit         = 4 << 20
	terminalBrowserReadLimit = 1 << 20
	terminalAgentReadLimit   = 16 << 20
)

// Server aggregates the dependencies of the three v2 links; the http routing layer constructs it
// once and reuses it for all connections.
type Server struct {
	cfg *config.Config
	sm  *session.Manager
	// tokens is the per-Agent credential store; it is always non-nil when a production gateway starts,
	// and nil is only for lightweight test construction.
	tokens *agenttoken.Store

	agentConns    atomic.Int64
	browserConns  atomic.Int64
	terminalConns atomic.Int64
}

// NewServer constructs the v2 protocol server; passing nil for tokens is only for unit tests that do
// not involve persistence.
func NewServer(cfg *config.Config, sm *session.Manager, tokens *agenttoken.Store) *Server {
	return &Server{cfg: cfg, sm: sm, tokens: tokens}
}

// acquireConnSlot occupies a connection slot before upgrade; returns false when over the limit (the
// caller responds 503).
func acquireConnSlot(counter *atomic.Int64, limit int64) (func(), bool) {
	if counter.Add(1) > limit {
		counter.Add(-1)
		return nil, false
	}
	released := &atomic.Bool{}
	return func() {
		if released.CompareAndSwap(false, true) {
			counter.Add(-1)
		}
	}, true
}

// Concurrent connection limits for the three links: take the config value, falling back to the
// default when unset (Load already provides a fallback; this additionally guards against tests
// constructing a zero-value Config directly).
func (s *Server) maxAgentConnections() int64 {
	if s.cfg != nil && s.cfg.MaxAgentConnections > 0 {
		return int64(s.cfg.MaxAgentConnections)
	}
	return config.DefaultMaxAgentConnections
}

func (s *Server) maxBrowserConnections() int64 {
	if s.cfg != nil && s.cfg.MaxBrowserConnections > 0 {
		return int64(s.cfg.MaxBrowserConnections)
	}
	return config.DefaultMaxBrowserConnections
}

func (s *Server) maxTerminalConnections() int64 {
	if s.cfg != nil && s.cfg.MaxTerminalConnections > 0 {
		return int64(s.cfg.MaxTerminalConnections)
	}
	return config.DefaultMaxTerminalConnections
}

func (s *Server) upgrader() websocket.Upgrader {
	return websocket.Upgrader{
		Subprotocols: []string{Subprotocol},
		CheckOrigin: func(r *http.Request) bool {
			return shared.OriginAllowed(r)
		},
	}
}

// readLimit reuses the MaxMessageBytes config (the historical name is kept; its semantics are the
// message size limit).
func (s *Server) readLimit() int64 {
	if s.cfg != nil && s.cfg.MaxMessageBytes > 0 {
		return int64(s.cfg.MaxMessageBytes)
	}
	return int64(config.DefaultMaxMessageBytes)
}

func (s *Server) heartbeatPeriod() time.Duration {
	if s.cfg != nil && s.cfg.WebSocketHeartbeatPeriod > 0 {
		return s.cfg.WebSocketHeartbeatPeriod
	}
	return 15 * time.Second
}

func (s *Server) writeTimeout() time.Duration {
	if s.cfg != nil && s.cfg.WebSocketWriteTimeout > 0 {
		return s.cfg.WebSocketWriteTimeout
	}
	return 10 * time.Second
}

func (s *Server) requestTimeout() time.Duration {
	if s.cfg != nil && s.cfg.RequestTimeout > 0 {
		return s.cfg.RequestTimeout
	}
	return 2 * time.Minute
}

// errorMessage maps internal errors to client-friendly messages.
func errorMessage(err error) string {
	if err == nil {
		return "request failed"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "request timed out"
	}
	if errors.Is(err, context.Canceled) {
		return "request canceled"
	}
	if errors.Is(err, session.ErrAgentOffline) {
		return "agent offline"
	}
	return err.Error()
}

// writeDirectMessage writes one binary frame directly before the write pump starts (handshake phase).
func writeDirectMessage(conn *websocket.Conn, timeout time.Duration, msg proto.Message) error {
	data, err := proto.Marshal(msg)
	if err != nil {
		return err
	}
	if timeout > 0 {
		if err := conn.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
			return err
		}
		defer func() {
			_ = conn.SetWriteDeadline(time.Time{})
		}()
	}
	return conn.WriteMessage(websocket.BinaryMessage, data)
}
