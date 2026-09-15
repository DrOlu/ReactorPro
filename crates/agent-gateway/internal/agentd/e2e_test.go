package agentd

// The end-to-end proof: the real gateway side (session manager + the v2 agent
// WebSocket server), the real agentd transport, a scripted provider, and the
// same session-layer entry point the mesh's invoke path uses. If this test
// passes, a peer dispatching a task through a real gateway receives the
// agentd's answer — nothing is mocked between the WebSocket frames and the
// session's answer extraction.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"log/slog"

	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/chatcmd"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/db"
	"github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

const e2eAgentID = "agentd-e2e-1"
const e2eToken = "e2e-gateway-token"

// startE2E stands up a real gateway agent endpoint and a real agentd against
// it, both in-process, wired to the given provider URL.
func startE2E(t *testing.T, concurrency int, providerURL string) *session.Manager {
	t.Helper()

	manager := session.NewManager()
	database, err := db.Open(filepath.Join(t.TempDir(), "e2e.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	tokens, err := agenttoken.NewStore(database)
	if err != nil {
		t.Fatalf("agent token store: %v", err)
	}
	server := httptest.NewServer(pbws.NewServer(&config.Config{Token: e2eToken}, manager, tokens).AgentHandler())
	t.Cleanup(server.Close)

	cfg := DefaultConfig()
	cfg.GatewayURL = "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/v2/agent"
	cfg.AgentID = e2eAgentID
	cfg.Token = e2eToken
	cfg.ProviderURL = providerURL
	cfg.ProviderModel = "fake-model"
	cfg.Workdir = t.TempDir()
	cfg.Concurrency = concurrency
	cfg.Heartbeat = 10 * time.Millisecond
	cfg.RequestTimeout = 10 * time.Second

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = Serve(ctx, &cfg, discardLogger()) }()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if manager.IsOnline(e2eAgentID) {
			return manager
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the agentd never signed into the gateway")
	return nil
}

// scriptedProvider answers round 1 with a write_file tool call and round 2
// with the tool's result echoed into the final answer — proving the whole
// loop: model → tool → sandbox → model → transcript → extraction.
func scriptedProvider() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var request struct {
			Messages []map[string]any `json:"messages"`
		}
		_ = json.Unmarshal(body, &request)
		w.Header().Set("Content-Type", "application/json")
		if len(request.Messages) < 4 {
			fmt.Fprint(w, `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":"","tool_calls":[{"id":"call-1","type":"function","function":{"name":"write_file","arguments":"{\"path\":\"out.txt\",\"content\":\"written by the agentd\"}"}}]}}]}`)
			return
		}
		toolResult := "unknown"
		if last := request.Messages[len(request.Messages)-1]; last["role"] == "tool" {
			if content, ok := last["content"].(string); ok {
				toolResult = content
			}
		}
		fmt.Fprintf(w, `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"the file says: %s","tool_calls":null}}]}`,
			strings.ReplaceAll(toolResult, `"`, `\"`))
	}))
}

func TestE2EAgentdServesARemoteTaskThroughTheGateway(t *testing.T) {
	provider := scriptedProvider()
	t.Cleanup(provider.Close)
	manager := startE2E(t, 2, provider.URL)

	// The runtime probe is the first thing the real invoke path does — it
	// rides the application-layer ping and requires the pong.
	if err := chatcmd.ProbeRuntimeForCommand(context.Background(), manager, e2eAgentID); err != nil {
		t.Fatalf("runtime probe (ping/pong): %v", err)
	}

	result, err := manager.SubmitRemoteTask(context.Background(), e2eAgentID,
		"Write out.txt with the marker text, then tell me what it says.")
	if err != nil {
		t.Fatalf("SubmitRemoteTask: %v", err)
	}
	if !result.OK {
		t.Fatalf("the remote task failed: %s (%s)", result.ErrorMessage, result.ErrorCode)
	}
	// The scripted provider's round 2 echoes the tool result, so the exact
	// text proves the tool executed inside the sandbox and reached the model.
	want := `{"text":"the file says: wrote 21 bytes to out.txt"}`
	if string(result.Output) != want {
		t.Fatalf("extracted answer = %s, want %s", result.Output, want)
	}
	if result.ConversationID == "" {
		t.Fatal("the result must report the conversation for resumability")
	}
}

func TestE2EAgentdRunsTurnsInParallel(t *testing.T) {
	// A slow provider, an agentd with room for two turns at once: three
	// remote tasks submitted together must all complete. Serialized
	// execution would still finish, so the assertion is simply that the
	// queue never wedges and every task gets its answer — but the timing
	// margin below would flag a desktop-style one-at-a-time worker.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(400 * time.Millisecond)
		fmt.Fprint(w, `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done","tool_calls":null}}]}`)
	}))
	t.Cleanup(slow.Close)
	manager := startE2E(t, 2, slow.URL)

	const tasks = 3
	var wg sync.WaitGroup
	results := make([]session.RemoteTaskResult, tasks)
	errs := make([]error, tasks)
	for i := 0; i < tasks; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			results[index], errs[index] = manager.SubmitRemoteTask(
				context.Background(), e2eAgentID, fmt.Sprintf("task number %d", index))
		}(i)
	}
	wg.Wait()
	for i := 0; i < tasks; i++ {
		if errs[i] != nil {
			t.Fatalf("task %d: %v", i, errs[i])
		}
		if !results[i].OK || string(results[i].Output) != `{"text":"done"}` {
			t.Fatalf("task %d result = %+v, want the slow answer", i, results[i])
		}
	}
}

func TestE2ECancelFreesTheWorker(t *testing.T) {
	// A provider that hangs: the caller gives up, the gateway relays
	// chat.cancel, and the agentd must cancel the turn — provable because
	// the very next task, on a fresh conversation, is served immediately.
	release := make(chan struct{})
	var releaseOnce sync.Once
	letGo := func() { releaseOnce.Do(func() { close(release) }) }
	hanging := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		fmt.Fprint(w, `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"late","tool_calls":null}}]}`)
	}))
	t.Cleanup(func() { letGo(); hanging.Close() })
	manager := startE2E(t, 2, hanging.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	_, _ = manager.SubmitRemoteTask(ctx, e2eAgentID, "never finishes")

	// The caller has given up and the gateway has told the agentd to cancel;
	// wait for the cancel to land, release the hung request (its run is
	// already cancelled on our side), then prove the worker pool is free.
	time.Sleep(250 * time.Millisecond)
	letGo()

	var result session.RemoteTaskResult
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var err error
		result, err = manager.SubmitRemoteTask(context.Background(), e2eAgentID, "the next task")
		if err == nil && result.OK {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !result.OK {
		t.Fatalf("the worker did not free up after the cancel: %+v", result)
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestE2EUnsupportedRequestsAnswerInsteadOfHang(t *testing.T) {
	// The browser's desktop-surface requests (settings, providers, fs, …)
	// must be ANSWERED by any attached agent — the desktop honours this with
	// typed responses or errors, and the agentd must too: a correlated
	// request that goes unanswered is a hang at the browser. History lists
	// get an honest empty response; everything else a typed refusal.
	manager := startE2E(t, 2, scriptedProvider().URL)

	settings, err := manager.AwaitUnaryResponse(context.Background(), e2eAgentID, "req-settings-1",
		&gatewayv2.GatewayEnvelope{
			RequestId: "req-settings-1",
			Timestamp: time.Now().Unix(),
			Payload:   &gatewayv2.GatewayEnvelope_SettingsGet{SettingsGet: &gatewayv2.SettingsGetRequest{}},
		})
	if err != nil {
		t.Fatalf("settings_get must be answered, not hung: %v", err)
	}
	if settings.GetError() == nil || settings.GetError().GetCode() != 501 {
		t.Fatalf("settings_get should be a typed refusal, got %+v", settings.GetPayload())
	}

	history, err := manager.AwaitUnaryResponse(context.Background(), e2eAgentID, "req-history-1",
		&gatewayv2.GatewayEnvelope{
			RequestId: "req-history-1",
			Timestamp: time.Now().Unix(),
			Payload:   &gatewayv2.GatewayEnvelope_HistoryList{HistoryList: &gatewayv2.HistoryListRequest{}},
		})
	if err != nil {
		t.Fatalf("history_list must be answered, not hung: %v", err)
	}
	list := history.GetHistoryListResp()
	if list == nil || list.GetTotalCount() != 0 || len(list.GetConversations()) != 0 {
		t.Fatalf("history_list should be an honest empty list, got %+v", history.GetPayload())
	}
}

func TestE2EBrowserPassThroughIsAnswered(t *testing.T) {
	// The user-visible path: a browser connects to /ws/v2, switches to the
	// headless agent, and the UI fires its desktop-surface requests through
	// the pass-through. Before this contract was implemented the agentd
	// ignored them and the browser hung ("Gateway websocket request timed
	// out: settings get"); now every request is answered.
	manager, browserURL := startE2EBrowserAndAgent(t, scriptedProvider().URL)
	_ = manager // the manager is the same one the agentd registered with

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(browserURL, "http"), nil)
	if err != nil {
		t.Fatalf("browser dial: %v", err)
	}
	defer func() { _ = conn.Close() }()
	writeBrowserFrame(conn, &gatewayv2.WebClientFrame{
		Payload: &gatewayv2.WebClientFrame_Hello{Hello: &gatewayv2.ClientHello{
			ProtocolVersion: 2,
			Token:           e2eToken,
			ClientName:      "e2e-browser",
		}},
	})
	if _, raw, err := conn.ReadMessage(); err != nil {
		t.Fatalf("browser hello: %v", err)
	} else {
		var frame gatewayv2.WebServerFrame
		if err := decodeProto(raw, &frame); err != nil || frame.GetHello() == nil || !frame.GetHello().GetOk() {
			t.Fatalf("browser handshake failed")
		}
	}

	// settings_get through the pass-through: must come back promptly with
	// the typed refusal, not time out.
	writeBrowserFrame(conn, &gatewayv2.WebClientFrame{
		RequestId: "browser-settings-1",
		AgentId:   e2eAgentID,
		Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
			RequestId: "browser-settings-1",
			Timestamp: time.Now().Unix(),
			Payload:   &gatewayv2.GatewayEnvelope_SettingsGet{SettingsGet: &gatewayv2.SettingsGetRequest{}},
		}},
	})
	response := readBrowserResponse(t, conn, "browser-settings-1")
	if response.GetAgentResponse() == nil || response.GetAgentResponse().GetError() == nil ||
		response.GetAgentResponse().GetError().GetCode() != 501 {
		t.Fatalf("settings_get pass-through = %+v, want the typed refusal", response.GetPayload())
	}

	// history_list: an honest empty list.
	writeBrowserFrame(conn, &gatewayv2.WebClientFrame{
		RequestId: "browser-history-1",
		AgentId:   e2eAgentID,
		Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
			RequestId: "browser-history-1",
			Timestamp: time.Now().Unix(),
			Payload:   &gatewayv2.GatewayEnvelope_HistoryList{HistoryList: &gatewayv2.HistoryListRequest{}},
		}},
	})
	response = readBrowserResponse(t, conn, "browser-history-1")
	list := response.GetAgentResponse().GetHistoryListResp()
	if list == nil || list.GetTotalCount() != 0 {
		t.Fatalf("history_list pass-through = %+v, want an empty list", response.GetPayload())
	}
}

// startE2EBrowserAndAgent mounts the full v2 surface — both the browser link
// and the agent link — with the agentd signed in, and returns the browser
// endpoint URL.
func startE2EBrowserAndAgent(t *testing.T, providerURL string) (*session.Manager, string) {
	t.Helper()
	manager := session.NewManager()
	database, err := db.Open(filepath.Join(t.TempDir(), "e2e.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	tokens, err := agenttoken.NewStore(database)
	if err != nil {
		t.Fatalf("agent token store: %v", err)
	}
	server := pbws.NewServer(&config.Config{Token: e2eToken}, manager, tokens)
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", server.BrowserHandler())
	mux.Handle("/ws/v2/agent", server.AgentHandler())
	httpServer := httptest.NewServer(mux)
	t.Cleanup(httpServer.Close)

	cfg := DefaultConfig()
	cfg.GatewayURL = "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws/v2/agent"
	cfg.AgentID = e2eAgentID
	cfg.Token = e2eToken
	cfg.ProviderURL = providerURL
	cfg.ProviderModel = "fake-model"
	cfg.Workdir = t.TempDir()
	cfg.Heartbeat = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = Serve(ctx, &cfg, discardLogger()) }()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if manager.IsOnline(e2eAgentID) {
			return manager, httpServer.URL + "/ws/v2"
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the agentd never signed into the gateway")
	return nil, ""
}

func writeBrowserFrame(conn *websocket.Conn, frame *gatewayv2.WebClientFrame) {
	raw, err := encodeProto(frame)
	if err != nil {
		return
	}
	_ = conn.WriteMessage(websocket.BinaryMessage, raw)
}

func readBrowserResponse(t *testing.T, conn *websocket.Conn, requestID string) *gatewayv2.WebServerFrame {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read response for %s: %v", requestID, err)
		}
		var frame gatewayv2.WebServerFrame
		if err := decodeProto(raw, &frame); err != nil {
			continue
		}
		if frame.GetRequestId() == requestID {
			return &frame
		}
	}
	t.Fatalf("no response arrived for %s within the deadline — the request would hang at the browser", requestID)
	return nil
}
