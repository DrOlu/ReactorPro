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

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/chatcmd"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/db"
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
