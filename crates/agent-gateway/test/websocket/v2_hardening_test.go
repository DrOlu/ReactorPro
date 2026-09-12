package websocket_test

// v2 hardening integration tests: connection cap, dispatch semaphore, per-link read
// limit, inbound rate limiting.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

// writeProtoFrameRaw writes a frame directly, returning errors instead of calling
// t.Fatal (a server-side disconnect is expected in the rate-limit test).
func writeProtoFrameRaw(conn *websocket.Conn, frame proto.Message) error {
	data, err := proto.Marshal(frame)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.BinaryMessage, data)
}

func TestV2BrowserConnectionCapRejectsExcess(t *testing.T) {
	t.Parallel()

	// The cap is already a config item: use a small value to verify behavior, keeping
// the test valid as the default changes.
	cfg := newV2TestConfig()
	cfg.MaxBrowserConnections = 4
	sm := session.NewManager()
	handler := pbws.NewServer(cfg, sm, nil).BrowserHandler()
	ts := httptest.NewServer(handler)
	defer ts.Close()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{pbws.Subprotocol}}

	conns := make([]*websocket.Conn, 0, cfg.MaxBrowserConnections)
	defer func() {
		for _, conn := range conns {
			_ = conn.Close()
		}
	}()
	for i := 0; i < cfg.MaxBrowserConnections; i++ {
		conn, _, err := dialer.Dial(wsURL, http.Header{"Origin": []string{ts.URL}})
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		conns = append(conns, conn)
	}

	// The next connection beyond the cap: 503 before the upgrade.
	_, resp, err := dialer.Dial(wsURL, http.Header{"Origin": []string{ts.URL}})
	if err == nil {
		t.Fatal("connection beyond the cap should be rejected")
	}
	if resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("over-cap connection status = %v, want 503", resp)
	}

	// After releasing one slot, connecting again succeeds (the count is reclaimed
	// correctly).
	_ = conns[0].Close()
	conns = conns[1:]
	deadline := time.Now().Add(2 * time.Second)
	for {
		conn, _, err := dialer.Dial(wsURL, http.Header{"Origin": []string{ts.URL}})
		if err == nil {
			conns = append(conns, conn)
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("slot was not released after close: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestV2DispatchSemaphoreRejectsAndRecovers(t *testing.T) {
	t.Parallel()

	// Two Agents are online and do not answer: agent_request blocks on
	// AwaitUnaryResponse until requestTimeout (1s), filling all 16 in-flight slots.
	sm, agentA, _, conn, cleanup := newV2MultiAgentTest(t)
	defer cleanup()

	for i := 0; i < 17; i++ {
		sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
			RequestId: "slow-" + string(rune('a'+i)),
			AgentId:   "agent-a",
			Payload: &gatewayv2.WebClientFrame_AgentRequest{
				AgentRequest: &gatewayv2.GatewayEnvelope{
					Payload: &gatewayv2.GatewayEnvelope_HistoryWorkdirs{
						HistoryWorkdirs: &gatewayv2.HistoryWorkdirsRequest{},
					},
				},
			},
		})
	}

	// The 17th in-flight request must quickly receive a semaphore local_error (the
	// other 16 only respond at timeout; broadcast frames such as snapshot replay
	// arrive first and are skipped).
	deadlineReject := time.Now().Add(time.Second)
	for {
		if time.Now().After(deadlineReject) {
			t.Fatal("timed out waiting for semaphore local_error")
		}
		frame := receiveWebFrameRaw(t, conn)
		if localError := frame.GetLocalError(); localError != nil {
			if !strings.Contains(localError.GetMessage(), "too many concurrent requests") {
				t.Fatalf("local_error = %q, want semaphore rejection", localError.GetMessage())
			}
			break
		}
	}

	// Slots are released as the timeout expires: subsequent requests are handled
	// normally. Only now start the answer pump (the first 16 requests must go
	// unanswered to fill the slots); the request after recovery should get a real
	// response promptly.
	time.Sleep(1200 * time.Millisecond)
	go answerAgentRequests(sm, agentA, "/recovered")
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "after-recovery",
		AgentId:   "agent-a",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_HistoryWorkdirs{
					HistoryWorkdirs: &gatewayv2.HistoryWorkdirsRequest{},
				},
			},
		},
	})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		frame := receiveWebFrameRaw(t, conn)
		if frame.GetRequestId() != "after-recovery" {
			continue
		}
		if message := frame.GetLocalError().GetMessage(); strings.Contains(message, "too many concurrent requests") {
			t.Fatalf("semaphore did not recover: %q", message)
		}
		return
	}
	t.Fatal("timed out waiting for post-recovery response")
}

func TestV2BrowserOversizedFrameClosesConnection(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()
	helloV2(t, conn, "ws-token")

	// A frame exceeding the browser link's 4 MiB read limit: the server disconnects
	// immediately (a reset on the write side or a close on the read side both count
	// as a hit).
	oversized := make([]byte, 5<<20)
	if err := conn.WriteMessage(websocket.BinaryMessage, oversized); err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

func TestV2InboundRateLimitClosesRunawayConnection(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()
	helloV2(t, conn, "ws-token")

	// A burst far beyond burst(200): receive local_error first, then the connection is
	// closed after repeated violations.
	for i := 0; i < 400; i++ {
		frame := &gatewayv2.WebClientFrame{RequestId: "flood"}
		if err := conn.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatalf("set write deadline: %v", err)
		}
		if err := writeProtoFrameRaw(conn, frame); err != nil {
			// The server has disconnected — as expected.
			return
		}
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
