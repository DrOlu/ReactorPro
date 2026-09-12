package websocket_test

// v2 browser-path integration test: a real httptest server plus binary proto frames, covering handshake
// authentication, local operations, passthrough forwarding (allowlist/limits/correlation-id namespacing),
// chat subscription, and event push.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/klauspost/compress/zstd"
	"google.golang.org/protobuf/proto"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestV2HelloRejectsBadToken(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "hello-bad",
		Payload: &gatewayv2.WebClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Token:           "wrong-token",
			},
		},
	})
	frame := receiveWebFrameRaw(t, conn)
	hello := frame.GetHello()
	if hello == nil || hello.GetOk() {
		t.Fatalf("hello reply = %#v, want ok=false", frame)
	}
	// The server should close the connection afterwards.
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("connection stayed open after rejected hello")
	}
}

func TestV2HelloRejectsWrongVersion(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		Payload: &gatewayv2.WebClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{ProtocolVersion: 99, Token: "ws-token"},
		},
	})
	frame := receiveWebFrameRaw(t, conn)
	if hello := frame.GetHello(); hello == nil || hello.GetOk() {
		t.Fatalf("hello reply = %#v, want ok=false for wrong version", frame)
	}
}

func TestV2StatusGet(t *testing.T) {
	t.Parallel()

	_, _, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "status-1",
		AgentId:   "desktop-agent",
		Payload:   &gatewayv2.WebClientFrame_StatusGet{StatusGet: &gatewayv2.StatusGetRequest{}},
	})
	frame := receiveWebFrameWithID(t, conn, "status-1")
	status := frame.GetStatus()
	if status == nil {
		t.Fatalf("status.get reply = %#v, want status payload", frame)
	}
	if !status.GetOnline() || status.GetAgentId() != "desktop-agent" {
		t.Fatalf("status = %#v, want online desktop-agent", status)
	}
}

func TestV2AgentRequestPassthroughRoundtrip(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	// An out-of-range page_size should be clamped by the gateway to the protocol upper bound (200).
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "hist-1",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				RequestId: "hist-1",
				Payload: &gatewayv2.GatewayEnvelope_HistoryList{
					HistoryList: &gatewayv2.HistoryListRequest{PageSize: 999},
				},
			},
		},
	})

	outbound := readOutboundEnvelope(t, agentSession)
	if !strings.HasSuffix(outbound.GetRequestId(), ":hist-1") ||
		outbound.GetRequestId() == "hist-1" {
		t.Fatalf("agent request id = %q, want per-connection namespaced hist-1", outbound.GetRequestId())
	}
	if got := outbound.GetHistoryList().GetPageSize(); got != 200 {
		t.Fatalf("page_size = %d, want clamped to 200", got)
	}
	if got := outbound.GetHistoryList().GetPage(); got != 1 {
		t.Fatalf("page = %d, want defaulted to 1", got)
	}

	sm.DispatchFromAgent("desktop-agent", &gatewayv2.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Payload: &gatewayv2.AgentEnvelope_HistoryListResp{
			HistoryListResp: &gatewayv2.HistoryListResponse{TotalCount: 3},
		},
	})

	frame := receiveWebFrameWithID(t, conn, "hist-1")
	response := frame.GetAgentResponse()
	if response == nil {
		t.Fatalf("passthrough reply = %#v, want agent_response", frame)
	}
	// The return envelope's correlation id has had the namespace prefix stripped.
	if response.GetRequestId() != "hist-1" {
		t.Fatalf("agent_response request_id = %q, want hist-1", response.GetRequestId())
	}
	if response.GetHistoryListResp().GetTotalCount() != 3 {
		t.Fatalf("history list resp = %#v, want total_count 3", response)
	}
}

func TestV2GuardRejectsNonWhitelistedArms(t *testing.T) {
	t.Parallel()

	_, _, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	// chat_command must go through a gateway-orchestrated frame and is not allowed to pass through.
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "bad-1",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_ChatCommand{
					ChatCommand: &gatewayv2.ChatCommandRequest{Type: "chat.submit"},
				},
			},
		},
	})
	frame := receiveWebFrameWithID(t, conn, "bad-1")
	if frame.GetLocalError() == nil {
		t.Fatalf("chat_command passthrough reply = %#v, want local_error", frame)
	}

	// The internal push arms behave likewise.
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "bad-2",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_Ping{
					Ping: &gatewayv2.PingRequest{},
				},
			},
		},
	})
	frame = receiveWebFrameWithID(t, conn, "bad-2")
	if frame.GetLocalError() == nil {
		t.Fatalf("ping passthrough reply = %#v, want local_error", frame)
	}
}

func TestV2ChatSubscribeAndStreamEvents(t *testing.T) {
	t.Parallel()

	sm, _, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "sub-1",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_ChatSubscribe{
			ChatSubscribe: &gatewayv2.ChatSubscribeRequest{ConversationId: "conv-1"},
		},
	})
	frame := receiveWebFrameWithID(t, conn, "sub-1")
	subscribed := frame.GetChatSubscribed()
	if subscribed == nil || subscribed.GetConversationId() != "conv-1" {
		t.Fatalf("chat_subscribe reply = %#v, want chat_subscribed conv-1", frame)
	}

	dispatchStarted(sm, "run-1", "conv-1")
	tokenData, _ := json.Marshal(map[string]any{"type": "token", "text": "hello"})
	sm.DispatchFromAgent("desktop-agent", &gatewayv2.AgentEnvelope{
		RequestId: "ingress-1",
		Payload: &gatewayv2.AgentEnvelope_ChatIngressBatch{
			ChatIngressBatch: &gatewayv2.ChatIngressBatch{
				RunId:          "run-1",
				ConversationId: "conv-1",
				FirstSeq:       1,
				Records: []*gatewayv2.ChatIngressRecord{{
					Payload: &gatewayv2.ChatIngressRecord_Delta{
						Delta: &gatewayv2.ChatIngressDelta{EventJson: string(tokenData)},
					},
				}},
			},
		},
	})

	// Both stream events, started and token, should be received in order.
	sawToken := false
	for attempt := 0; attempt < 8 && !sawToken; attempt++ {
		frame := receiveWebFrame(t, conn)
		event := frame.GetChatEvent()
		if event == nil {
			continue
		}
		if event.GetConversationId() != "conv-1" {
			t.Fatalf("chat_event conversation = %q, want conv-1", event.GetConversationId())
		}
		var payload map[string]any
		if err := json.Unmarshal(event.GetPayloadJson(), &payload); err != nil {
			t.Fatalf("chat_event payload_json invalid: %v", err)
		}
		if payload["type"] == "token" {
			sawToken = true
		}
	}
	if !sawToken {
		t.Fatal("timed out waiting for token chat_event")
	}
}

// TestV2EndToEndBinaryPath exercises the first fully binary path: a fake agent connects
// via /ws/v2/agent, the browser sends passthrough requests via /ws/v2, and Protobuf
// binary frames are used throughout.
func TestV2EndToEndBinaryPath(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	store := newAgentTokenStore(t)
	agentToken, err := store.Issue("desktop-agent", "")
	if err != nil {
		t.Fatalf("issue desktop agent token: %v", err)
	}
	srv := pbws.NewServer(newV2TestConfig(), sm, store)

	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())
	mux.Handle("/ws/v2/agent", srv.AgentHandler())

	// ---- Fake agent comes online ----
	agentConn, agentCleanup := dialV2Path(t, mux, "/ws/v2/agent")
	defer agentCleanup()
	sendProtoFrame(t, agentConn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_AGENT,
				Token:           agentToken,
				AgentId:         "desktop-agent",
				AgentVersion:    "1.0.0",
			},
		},
	})
	agentHello := receiveAgentServerFrame(t, agentConn).GetHello()
	if agentHello == nil || !agentHello.GetOk() || agentHello.GetSessionId() == "" {
		t.Fatalf("agent hello reply = %#v, want ok with session id", agentHello)
	}

	// ---- Browser connects and issues a passthrough request ----
	browserConn, browserCleanup := dialV2Path(t, mux, "/ws/v2")
	defer browserCleanup()
	helloV2(t, browserConn, "ws-token")

	sendProtoFrame(t, browserConn, &gatewayv2.WebClientFrame{
		RequestId: "e2e-1",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_SettingsGet{
					SettingsGet: &gatewayv2.SettingsGetRequest{},
				},
			},
		},
	})

	// The agent side should receive the passthrough envelope (skipping heartbeat Pings).
	var inbound *gatewayv2.GatewayEnvelope
	for attempt := 0; attempt < 8; attempt++ {
		envelope := receiveAgentServerFrame(t, agentConn).GetEnvelope()
		if envelope == nil || envelope.GetPing() != nil {
			continue
		}
		inbound = envelope
		break
	}
	if inbound == nil || inbound.GetSettingsGet() == nil {
		t.Fatalf("agent inbound = %#v, want settings_get", inbound)
	}

	sendProtoFrame(t, agentConn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Envelope{
			Envelope: &gatewayv2.AgentEnvelope{
				RequestId: inbound.GetRequestId(),
				Payload: &gatewayv2.AgentEnvelope_SettingsGetResp{
					SettingsGetResp: &gatewayv2.SettingsGetResponse{SettingsJson: `{"ok":true}`},
				},
			},
		},
	})

	frame := receiveWebFrameWithID(t, browserConn, "e2e-1")
	response := frame.GetAgentResponse()
	if response == nil || response.GetSettingsGetResp().GetSettingsJson() != `{"ok":true}` {
		t.Fatalf("e2e reply = %#v, want settings_get_resp", frame)
	}
}

func TestV2ChatIngressRepeatedGapEscalatesToCheckpoint(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	store := newAgentTokenStore(t)
	agentToken, err := store.Issue("desktop-agent", "")
	if err != nil {
		t.Fatalf("issue desktop agent token: %v", err)
	}
	srv := pbws.NewServer(newV2TestConfig(), sm, store)

	mux := http.NewServeMux()
	mux.Handle("/ws/v2/agent", srv.AgentHandler())
	agentConn, agentCleanup := dialV2Path(t, mux, "/ws/v2/agent")
	defer agentCleanup()
	sendProtoFrame(t, agentConn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_AGENT,
				Token:           agentToken,
				AgentId:         "desktop-agent",
				AgentVersion:    "1.0.0",
			},
		},
	})
	agentHello := receiveAgentServerFrame(t, agentConn).GetHello()
	if agentHello == nil || !agentHello.GetOk() {
		t.Fatalf("agent hello reply = %#v, want ok", agentHello)
	}

	sendBatch := func(requestID string, firstSeq uint64, text string) {
		t.Helper()
		sendProtoFrame(t, agentConn, &gatewayv2.AgentClientFrame{
			Payload: &gatewayv2.AgentClientFrame_Envelope{
				Envelope: &gatewayv2.AgentEnvelope{
					RequestId: requestID,
					Payload: &gatewayv2.AgentEnvelope_ChatIngressBatch{
						ChatIngressBatch: &gatewayv2.ChatIngressBatch{
							RunId:          "run-gap",
							ConversationId: "conv-gap",
							FirstSeq:       firstSeq,
							Records: []*gatewayv2.ChatIngressRecord{{
								Payload: &gatewayv2.ChatIngressRecord_Delta{
									Delta: &gatewayv2.ChatIngressDelta{EventJson: `{"type":"token","text":"` + text + `"}`},
								},
							}},
						},
					},
				},
			},
		})
	}

	sendBatch("ingress-1", 1, "one")
	first := receiveAgentChatIngressAck(t, agentConn, "ingress-1")
	if first.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || first.GetExpectedNext() != 2 {
		t.Fatalf("first ack = %#v, want CONTINUE expected_next=2", first)
	}

	sendBatch("ingress-gap-1", 3, "three")
	firstGap := receiveAgentChatIngressAck(t, agentConn, "ingress-gap-1")
	if firstGap.GetAction() != gatewayv2.ChatIngressAck_REPLAY_FROM_EXPECTED || firstGap.GetExpectedNext() != 2 {
		t.Fatalf("first gap ack = %#v, want REPLAY_FROM_EXPECTED expected_next=2", firstGap)
	}

	sendBatch("ingress-gap-2", 3, "three")
	secondGap := receiveAgentChatIngressAck(t, agentConn, "ingress-gap-2")
	if secondGap.GetAction() != gatewayv2.ChatIngressAck_SEND_CHECKPOINT || secondGap.GetExpectedNext() != 2 {
		t.Fatalf("repeated gap ack = %#v, want SEND_CHECKPOINT expected_next=2", secondGap)
	}

	projectionJSON := []byte(`[]`)
	encoder, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatalf("create projection encoder: %v", err)
	}
	defer encoder.Close()
	projectionHash := sha256.Sum256(projectionJSON)
	sendProtoFrame(t, agentConn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Envelope{
			Envelope: &gatewayv2.AgentEnvelope{
				RequestId: "ingress-checkpoint",
				Payload: &gatewayv2.AgentEnvelope_ChatIngressBatch{
					ChatIngressBatch: &gatewayv2.ChatIngressBatch{
						RunId:          "run-gap",
						ConversationId: "conv-gap",
						FirstSeq:       4,
						Records: []*gatewayv2.ChatIngressRecord{{
							Payload: &gatewayv2.ChatIngressRecord_Checkpoint{
								Checkpoint: &gatewayv2.ChatIngressCheckpoint{
									CoversThroughSeq:     3,
									Revision:             1,
									CompressedProjection: encoder.EncodeAll(projectionJSON, nil),
									UncompressedBytes:    uint64(len(projectionJSON)),
									Sha256:               hex.EncodeToString(projectionHash[:]),
								},
							},
						}},
					},
				},
			},
		},
	})
	checkpoint := receiveAgentChatIngressAck(t, agentConn, "ingress-checkpoint")
	if checkpoint.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || checkpoint.GetCommittedThrough() != 4 || checkpoint.GetExpectedNext() != 5 {
		t.Fatalf("checkpoint ack = %#v, want CONTINUE committed_through=4 expected_next=5", checkpoint)
	}

	sendBatch("ingress-after-checkpoint", 5, "five")
	afterCheckpoint := receiveAgentChatIngressAck(t, agentConn, "ingress-after-checkpoint")
	if afterCheckpoint.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || afterCheckpoint.GetCommittedThrough() != 5 || afterCheckpoint.GetExpectedNext() != 6 {
		t.Fatalf("post-checkpoint ack = %#v, want CONTINUE committed_through=5 expected_next=6", afterCheckpoint)
	}
}

// dialV2Path dials the given path on a multi-route mux.
func dialV2Path(t *testing.T, handler http.Handler, path string) (*websocket.Conn, func()) {
	t.Helper()
	return dialV2(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = path
		handler.ServeHTTP(w, r)
	}))
}

func receiveAgentServerFrame(t *testing.T, conn *websocket.Conn) *gatewayv2.AgentServerFrame {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set agent read deadline: %v", err)
	}
	messageType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("receive agent frame: %v", err)
	}
	if messageType != websocket.BinaryMessage {
		t.Fatalf("agent frame message type = %d, want binary", messageType)
	}
	var frame gatewayv2.AgentServerFrame
	if err := proto.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal agent frame: %v", err)
	}
	return &frame
}

func receiveAgentChatIngressAck(t *testing.T, conn *websocket.Conn, requestID string) *gatewayv2.ChatIngressAck {
	t.Helper()
	for attempt := 0; attempt < 8; attempt++ {
		envelope := receiveAgentServerFrame(t, conn).GetEnvelope()
		if envelope == nil || envelope.GetPing() != nil {
			continue
		}
		if envelope.GetRequestId() != requestID {
			t.Fatalf("agent envelope request_id = %q, want %q", envelope.GetRequestId(), requestID)
		}
		if ack := envelope.GetChatIngressAck(); ack != nil {
			return ack
		}
		t.Fatalf("agent envelope = %#v, want chat_ingress_ack", envelope)
	}
	t.Fatalf("timed out waiting for chat_ingress_ack request_id=%q", requestID)
	return nil
}
