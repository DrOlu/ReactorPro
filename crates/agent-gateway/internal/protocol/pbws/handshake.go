package pbws

import (
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/liveagent/agent-gateway/internal/auth"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// helloVerdict is the handshake validation result; when ok=false, message is client-facing.
type helloVerdict struct {
	ok      bool
	message string
}

// vetHello validates the ClientHello protocol version, role, and browser credentials.
// Role-credential binding: the browser role only accepts the gateway token; the Agent
// role must declare agent_id. Agent credentials are validated exactly once by
// authenticateAgentHello under the store lock, and both the main path and the terminal
// data path reuse that entry point. Credential failures always report "unauthorized" to
// prevent Agent ID enumeration.
func (s *Server) vetHello(hello *gatewayv2.ClientHello, wantRole gatewayv2.ClientRole) helloVerdict {
	if hello == nil {
		return helloVerdict{message: "hello frame is required"}
	}
	if hello.GetProtocolVersion() != ProtocolVersion {
		return helloVerdict{message: "unsupported protocol version"}
	}
	role := hello.GetRole()
	// A hello with no explicit role is filled in with the endpoint's expected role (the
	// path already distinguishes them); an explicitly wrong role is rejected so agent
	// frames cannot be processed as browser frames.
	if role != gatewayv2.ClientRole_CLIENT_ROLE_UNSPECIFIED && role != wantRole {
		return helloVerdict{message: "unexpected client role"}
	}
	switch wantRole {
	case gatewayv2.ClientRole_CLIENT_ROLE_AGENT:
		if strings.TrimSpace(hello.GetAgentId()) == "" {
			return helloVerdict{message: "agent_id is required"}
		}
	default:
		if !auth.ValidateToken(hello.GetToken(), s.cfg.Token) {
			return helloVerdict{message: "unauthorized"}
		}
	}
	return helloVerdict{ok: true}
}

// authenticateAgentHello performs the single independent token lookup, shared-token
// determination, auto-registration, and per-Agent credential epoch snapshot inside the
// Store. Callers must validate the returned epoch when registering the transport.
func (s *Server) authenticateAgentHello(hello *gatewayv2.ClientHello) (uint64, error) {
	return s.tokens.AuthenticateAndRegister(
		hello.GetAgentId(),
		hello.GetToken(),
		auth.ValidateToken(hello.GetToken(), s.cfg.Token),
	)
}

// serverHello builds the handshake response; sessionID is only used by the agent role,
// and maxMessageBytes reports the actual read limit per link (no longer uniform after
// each link tightened its own).
func (s *Server) serverHello(ok bool, message string, sessionID string, maxMessageBytes int64) *gatewayv2.ServerHello {
	return &gatewayv2.ServerHello{
		Ok:                     ok,
		Message:                strings.TrimSpace(message),
		SessionId:              strings.TrimSpace(sessionID),
		ServerTime:             time.Now().Unix(),
		HeartbeatPeriodSeconds: uint32(s.heartbeatPeriod() / time.Second),
		MaxMessageBytes:        uint64(maxMessageBytes),
		Capabilities: []string{
			gatewayv2.ChatIngressV1Capability,
		},
	}
}

// closeUnauthorized closes the connection with the auth-failure code (the caller has
// already written the failure hello).
func closeUnauthorized(conn *websocket.Conn, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	_ = conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(closeCodeUnauthorized, "unauthorized"),
		deadline,
	)
	_ = conn.Close()
}
