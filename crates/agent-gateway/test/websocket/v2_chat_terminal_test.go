package websocket_test

// Integration tests for v2 chat command orchestration and the terminal link.

import (
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

// TestV2ChatCommandAcceptedFlow covers submit orchestration: runtime liveness probe (gateway sends Ping, fake agent replies Pong)
// → accept receipt → command envelope delivered to the agent.
func TestV2ChatCommandAcceptedFlow(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "cmd-1",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_ChatCommand{
			ChatCommand: &gatewayv2.ChatCommandRequest{
				Type: "chat.submit",
				Request: &gatewayv2.ChatRequest{
					ConversationId:    "conv-cmd",
					ClientRequestId:   "client-cmd-1",
					Message:           "hello v2",
					CommandSafetyMode: "sandboxOffline",
				},
			},
		},
	})

	// The gateway first sends a runtime liveness probe; the fake agent replies Pong.
	answerChatRuntimeProbe(t, sm, agentSession)

	frame := receiveWebFrameWithID(t, conn, "cmd-1")
	accepted := frame.GetChatAccepted()
	if accepted == nil || accepted.GetConversationId() != "conv-cmd" || accepted.GetRunId() == "" {
		t.Fatalf("chat command reply = %#v, want chat_accepted", frame)
	}

	// The command envelope is then delivered to the agent.
	outbound := readOutboundEnvelope(t, agentSession)
	command := outbound.GetChatCommand()
	if command.GetType() != "chat.submit" || command.GetRequest().GetMessage() != "hello v2" {
		t.Fatalf("agent chat command = %#v, want chat.submit hello v2", command)
	}
	if got := command.GetRequest().GetCommandSafetyMode(); got != "sandboxOffline" {
		t.Fatalf("agent command_safety_mode = %q, want sandboxOffline", got)
	}
}

func TestV2TerminalBrowserRequiresAgentID(t *testing.T) {
	t.Parallel()

	handler := pbws.NewServer(newV2TestConfig(), session.NewManager(), nil).TerminalHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()
	sendProtoFrame(t, conn, &gatewayv2.TerminalClientFrame{
		Payload: &gatewayv2.TerminalClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
				Token:           "ws-token",
			},
		},
	})
	hello := receiveTerminalServerFrame(t, conn).GetHello()
	if hello == nil || hello.GetOk() || hello.GetMessage() != "agent_id is required" {
		t.Fatalf("terminal hello without agent_id = %v, want rejection", hello)
	}
}

// TestV2TerminalBrowserGating covers the terminal link browser role: under default settings attach is rejected by permission gating;
// after enabling the Web terminal, a failed attach forward (agent offline) is also reported as an error frame.
func TestV2TerminalBrowserGating(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, nil).TerminalHandler()

	dialTerminal := func() (*websocket.Conn, func()) {
		conn, cleanup := dialV2(t, handler)
		sendProtoFrame(t, conn, &gatewayv2.TerminalClientFrame{
			Payload: &gatewayv2.TerminalClientFrame_Hello{
				Hello: &gatewayv2.ClientHello{
					ProtocolVersion: pbws.ProtocolVersion,
					Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
					Token:           "ws-token",
					AgentId:         "desktop-agent",
				},
			},
		})
		hello := receiveTerminalServerFrame(t, conn).GetHello()
		if hello == nil || !hello.GetOk() {
			t.Fatalf("terminal hello reply = %#v, want ok", hello)
		}
		return conn, cleanup
	}

	attach := func(conn *websocket.Conn) {
		sendProtoFrame(t, conn, &gatewayv2.TerminalClientFrame{
			Payload: &gatewayv2.TerminalClientFrame_Frame{
				Frame: &gatewayv2.TerminalStreamFrame{
					Kind:      "attach",
					SessionId: "sess-1",
					StreamId:  "stream-1",
				},
			},
		})
	}

	// Default settings: Web terminal off → permission error.
	conn, cleanup := dialTerminal()
	attach(conn)
	frame := receiveTerminalServerFrame(t, conn).GetFrame()
	if frame.GetKind() != "error" || frame.GetError() == "" {
		t.Fatalf("gated attach reply = %#v, want error frame", frame)
	}
	cleanup()

	// Web terminal on: attach passes the gate, but the agent is offline → offline error.
	sm.ApplySettingsJSON("desktop-agent", `{"remote":{"enableWebTerminal":true}}`)
	conn, cleanup = dialTerminal()
	defer cleanup()
	attach(conn)
	frame = receiveTerminalServerFrame(t, conn).GetFrame()
	if frame.GetKind() != "error" || frame.GetError() != "desktop agent is offline" {
		t.Fatalf("offline attach reply = %#v, want agent offline error", frame)
	}
}

// TestV2AgentHelloRejectsBrowserRole confirms that a role mismatch is rejected.
func TestV2AgentHelloRejectsBrowserRole(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	srv := pbws.NewServer(newV2TestConfig(), sm, nil)
	mux := http.NewServeMux()
	mux.Handle("/ws/v2/agent", srv.AgentHandler())

	conn, cleanup := dialV2Path(t, mux, "/ws/v2/agent")
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
				Token:           "ws-token",
			},
		},
	})
	hello := receiveAgentServerFrame(t, conn).GetHello()
	if hello == nil || hello.GetOk() {
		t.Fatalf("agent hello with browser role = %#v, want ok=false", hello)
	}
}

func receiveTerminalServerFrame(t *testing.T, conn *websocket.Conn) *gatewayv2.TerminalServerFrame {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set terminal read deadline: %v", err)
	}
	messageType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("receive terminal frame: %v", err)
	}
	if messageType != websocket.BinaryMessage {
		t.Fatalf("terminal frame message type = %d, want binary", messageType)
	}
	var frame gatewayv2.TerminalServerFrame
	if err := proto.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal terminal frame: %v", err)
	}
	return &frame
}
