package agentd

// Regression tests for the runner's conversation-slot discipline. The
// invariant: at most ONE accepted-but-unsettled run per conversation, whatever
// the interleaving of submits, cancels and drops. Two concurrent runs for one
// conversation each write their own ingress sequence numbers from one, and the
// gateway's reliable ingress rejects the second set as duplicates — so a race
// here is not a performance wart, it is a run that can never settle.
//
// These tests drive the Runner directly and execute queued jobs by hand, so
// every ordering is deterministic: no worker-pool timing, no sleeps.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/proto/v2"
)

// recordingSink captures every ingress record the runner emits, by run.
// failDeltas, when > 0, fails the next that-many delta sends — the hook for
// pinning the disable-on-failure posture.
type recordingSink struct {
	mu          sync.Mutex
	records     map[string][]*gatewayv2.ChatIngressRecord
	failDeltas  int
}

func (s *recordingSink) SendIngress(runID, conversationID string, seq uint64, record *gatewayv2.ChatIngressRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records[runID] = append(s.records[runID], record)
	if record.GetDelta() != nil && s.failDeltas > 0 {
		s.failDeltas--
		return fmt.Errorf("delta send failed (test)")
	}
	return nil
}

// terminalState returns the one terminal state a run ended in, or "".
func (s *recordingSink) terminalState(runID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, record := range s.records[runID] {
		if terminal := record.GetTerminal(); terminal != nil {
			return terminal.GetState()
		}
	}
	return ""
}

// recordsFor returns the run's captured records in wire order.
func (s *recordingSink) recordsFor(runID string) []*gatewayv2.ChatIngressRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*gatewayv2.ChatIngressRecord{}, s.records[runID]...)
}

func (s *recordingSink) count(runID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.records[runID])
}

// countingProvider answers every completion with plain text and counts how
// many provider calls were spent — the budget a cancelled-before-start run
// must never touch.
func countingProvider(hits *atomic.Int32) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done","tool_calls":null}}]}`)
	}))
}

func chatCommand(conversationID, message string) *gatewayv2.ChatCommandRequest {
	return &gatewayv2.ChatCommandRequest{
		Request: &gatewayv2.ChatRequest{
			ConversationId: conversationID,
			Message:        message,
		},
	}
}

// newTestRunner builds a runner whose queued jobs are executed by hand. The
// heartbeat is stretched past the test's lifetime so the captured record
// stream holds exactly what the turn itself produced.
func newTestRunner(t *testing.T, providerURL string) (*Runner, *recordingSink) {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Heartbeat = time.Hour
	cfg.MaxRounds = 2
	tools := NewToolset(t.TempDir(), false, false, nil)
	sink := &recordingSink{records: map[string][]*gatewayv2.ChatIngressRecord{}}
	return NewRunner(&cfg, NewProvider(providerURL, "test-key", "test-model", 64, 5*time.Second), tools, sink, slog.Default()), sink
}

// A second command for a conversation with a queued (not yet running) run
// must be refused at submit time. Before the conversation slot existed, the
// busy check and the worker's registration were separate steps: two rapid
// commands both passed the check, both queued, and both ran — each writing
// ingress sequence numbers the other had already used.
func TestRunnerRefusesASecondConcreateCommandForAConversation(t *testing.T) {
	var hits atomic.Int32
	provider := countingProvider(&hits)
	t.Cleanup(provider.Close)
	runner, sink := newTestRunner(t, provider.URL)

	runner.SubmitChatCommand("run-1", chatCommand("conv-1", "first"))
	runner.SubmitChatCommand("run-2", chatCommand("conv-1", "second"))

	if queued := len(runner.jobs); queued != 1 {
		t.Fatalf("the second concurrent command was queued: %d jobs waiting", queued)
	}
	runner.execute(context.Background(), <-runner.jobs)

	if hits.Load() != 1 {
		t.Fatalf("expected exactly one provider call, got %d", hits.Load())
	}
	if got := sink.terminalState("run-1"); got != "completed" {
		t.Fatalf("run-1 terminal state = %q, want completed", got)
	}
	if sink.count("run-2") != 0 {
		t.Fatalf("the refused run-2 reported records: %d", sink.count("run-2"))
	}

	// The slot is released when the run settles: the same conversation must
	// accept a new command at once.
	runner.SubmitChatCommand("run-3", chatCommand("conv-1", "third"))
	if queued := len(runner.jobs); queued != 1 {
		t.Fatalf("the conversation stayed busy after its run completed: %d jobs waiting", queued)
	}
	runner.execute(context.Background(), <-runner.jobs)
	if hits.Load() != 2 || sink.terminalState("run-3") != "completed" {
		t.Fatalf("a fresh command for the settled conversation did not run cleanly (hits=%d)", hits.Load())
	}
}

// A cancel that lands while the job is still queued must settle the run as
// cancelled without spending a provider call — the queued job is work the
// caller has already given up on, not work to start and then stop.
func TestRunnerCancelWhileQueuedSettlesCancelledWithoutRunning(t *testing.T) {
	var hits atomic.Int32
	provider := countingProvider(&hits)
	t.Cleanup(provider.Close)
	runner, sink := newTestRunner(t, provider.URL)

	runner.SubmitChatCommand("run-1", chatCommand("conv-1", "slow work"))
	runner.CancelConversation("conv-1") // lands before any worker picks the job up
	runner.execute(context.Background(), <-runner.jobs)

	if hits.Load() != 0 {
		t.Fatalf("a cancelled-while-queued run spent %d provider calls; want 0", hits.Load())
	}
	if got := sink.terminalState("run-1"); got != "cancelled" {
		t.Fatalf("run-1 terminal state = %q, want cancelled", got)
	}
	if records := sink.count("run-1"); records != 1 {
		t.Fatalf("expected exactly the terminal record, got %d records", records)
	}

	// And the conversation is free again immediately.
	runner.SubmitChatCommand("run-2", chatCommand("conv-1", "again"))
	if queued := len(runner.jobs); queued != 1 {
		t.Fatalf("the conversation stayed busy after a queued cancel: %d jobs waiting", queued)
	}
}

// DropAll (the gateway connection was lost) cancels queued work without
// wedging the conversation: the map is cleared at once so a post-reconnect
// submit can re-claim it, and the stale queued job — carrying its slot by
// pointer — still refuses to run when a worker finally reaches it.
func TestRunnerDropAllCancelsQueuedWorkAndFreesTheConversation(t *testing.T) {
	var hits atomic.Int32
	provider := countingProvider(&hits)
	t.Cleanup(provider.Close)
	runner, sink := newTestRunner(t, provider.URL)

	runner.SubmitChatCommand("run-1", chatCommand("conv-1", "doomed"))
	runner.DropAll("connection lost")

	// The conversation is re-claimable immediately after the drop…
	runner.SubmitChatCommand("run-2", chatCommand("conv-1", "fresh"))
	if queued := len(runner.jobs); queued != 2 {
		t.Fatalf("expected the stale and the fresh job in the queue, got %d", queued)
	}

	// …and the FIFO order hands the worker the stale job first: it settles
	// cancelled without a provider call, while the fresh job runs normally.
	runner.execute(context.Background(), <-runner.jobs)
	if hits.Load() != 0 || sink.terminalState("run-1") != "cancelled" {
		t.Fatalf("the stale job was not cleanly cancelled (hits=%d, state=%q)",
			hits.Load(), sink.terminalState("run-1"))
	}
	runner.execute(context.Background(), <-runner.jobs)
	if hits.Load() != 1 || sink.terminalState("run-2") != "completed" {
		t.Fatalf("the fresh job did not run cleanly (hits=%d, state=%q)",
			hits.Load(), sink.terminalState("run-2"))
	}
}


// streamingProvider answers with plain text in small SSE content deltas —
// the shape the token-delta coalescer consumes.
func streamingProvider() *httptest.Server {
	events := make([]string, 0, 30)
	for i := 0; i < 20; i++ {
		payload, _ := json.Marshal(map[string]any{
			"choices": []map[string]any{{"delta": map[string]any{"content": "chunk-0123 "}}},
		})
		events = append(events, "data: "+string(payload))
	}
	events = append(events,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		"data: [DONE]")
	return httptest.NewServer(sseHandler(events...))
}

// A streamed turn emits its token deltas AHEAD of the checkpoint that
// contains them — the viewer watches the answer grow, then the snapshot
// lands. The coalescer keeps every record at the mesh chunk grain, rounds
// are 1-based like the desktop's, and the delta text concatenates to
// exactly the answer.
func TestRunnerStreamsTokenDeltasAheadOfTheCheckpoint(t *testing.T) {
	provider := streamingProvider()
	t.Cleanup(provider.Close)
	runner, sink := newTestRunner(t, provider.URL)

	runner.SubmitChatCommand("run-1", chatCommand("conv-1", "answer at length"))
	runner.execute(context.Background(), <-runner.jobs)

	if sink.terminalState("run-1") != "completed" {
		t.Fatalf("terminal = %q, want completed", sink.terminalState("run-1"))
	}
	records := sink.recordsFor("run-1")
	var concatenated strings.Builder
	deltas, checkpoints := 0, 0
	for _, record := range records {
		if record.GetCheckpoint() != nil {
			checkpoints++
		}
		if delta := record.GetDelta(); delta != nil {
			deltas++
			if checkpoints < 1 {
				t.Fatal("a delta arrived before the run's first checkpoint")
			}
			var event map[string]any
			if err := json.Unmarshal([]byte(delta.GetEventJson()), &event); err != nil {
				t.Fatalf("delta event_json is not JSON: %v", err)
			}
			if event["type"] != "token" {
				t.Fatalf("delta type = %v, want token", event["type"])
			}
			if event["round"] != float64(1) {
				t.Fatalf("round = %v, want 1 (1-based, matching the desktop)", event["round"])
			}
			text, _ := event["text"].(string)
			concatenated.WriteString(text)
			if runes := len([]rune(text)); runes > deltaFlushRunes+8 {
				t.Fatalf("a coalesced record carried %d runes — over the grain", runes)
			}
		}
	}
	if deltas == 0 {
		t.Fatal("the turn emitted no token deltas (StreamDeltas defaults on)")
	}
	if checkpoints < 2 {
		t.Fatalf("expected the initial checkpoint and the answer checkpoint, got %d", checkpoints)
	}
	if concatenated.Len() == 0 {
		t.Fatal("no delta text reached the records")
	}
}

// A failing delta send must never fail the turn: the deltas die (disabled on
// first failure), checkpoints and the terminal carry on — the progress path
// is subordinate to the authoritative records.
func TestRunnerSurvivesAFailingDeltaPath(t *testing.T) {
	provider := streamingProvider()
	t.Cleanup(provider.Close)
	runner, sink := newTestRunner(t, provider.URL)
	sink.failDeltas = 1 // one failure poisons every later delta for the run

	runner.SubmitChatCommand("run-1", chatCommand("conv-1", "answer anyway"))
	runner.execute(context.Background(), <-runner.jobs)

	if sink.terminalState("run-1") != "completed" {
		t.Fatalf("terminal = %q, want completed — a dead delta path must not fail the turn",
			sink.terminalState("run-1"))
	}
	deltas := 0
	for _, record := range sink.recordsFor("run-1") {
		if record.GetDelta() != nil {
			deltas++
		}
	}
	if deltas > 1 {
		t.Fatalf("the failing delta path kept sending: %d delta records", deltas)
	}
}
