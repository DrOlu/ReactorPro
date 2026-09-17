package session

// The headless history contract: a conversation stays visible and servable
// for as long as the stream lives, not merely for as long as its event log
// survives trimming. The store trims conversation events on a retention clock
// shorter than a stream's idle life; a finished conversation whose events are
// gone still serves from its latest snapshot — the same hydration the
// subscription path gives late joiners.

import (
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestHeadlessHistorySurvivesEventTrimming(t *testing.T) {
	manager := NewManager()
	// The headless retention rule, as the manager wires it for
	// agentd-capable agents (wired directly here: this test exercises the
	// store's behavior, not the capability lookup).
	manager.convStreams.retainFinishedSnapshot = func(string) bool { return true }
	// A finished headless run: a user entry (with the attachments array the
	// webui requires) and its answer.
	projection := reliableIngressProjection(t,
		`[{"id":"u1","kind":"user","text":"the question","attachments":[]},{"id":"a1","kind":"assistant","text":"the answer"}]`)
	batch := &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressTerminal(projection, 0, "completed")},
	}
	if ack := manager.ingestChatIngressBatch("agentd-1", batch); !ack.GetTerminalCommitted() {
		t.Fatalf("the terminal did not commit: %#v", ack)
	}

	// Before trimming the history serves the transcript.
	list := manager.HeadlessConversationList("agentd-1", 1, 80)
	if list.GetTotalCount() != 1 {
		t.Fatalf("list total = %d, want 1", list.GetTotalCount())
	}
	if list.GetConversations()[0].GetTitle() != "the question" {
		t.Fatalf("title = %q, want the user entry's text", list.GetConversations()[0].GetTitle())
	}
	detail := manager.HeadlessConversationGet("agentd-1", "conv-1", 0)
	if !strings.Contains(detail.GetMessagesJson(), "the answer") {
		t.Fatalf("the transcript was not served before trimming: %q", detail.GetMessagesJson())
	}

	// Simulate the reaper's event trimming: the log expires while the stream
	// — and its latest snapshot — live on.
	manager.convStreams.mu.Lock()
	stream := manager.convStreams.streams[agentScopedKey("agentd-1", "conv-1")]
	if stream == nil {
		manager.convStreams.mu.Unlock()
		t.Fatal("the stream disappeared before trimming")
	}
	stream.events = nil
	manager.convStreams.mu.Unlock()

	list = manager.HeadlessConversationList("agentd-1", 1, 80)
	if list.GetTotalCount() != 1 {
		t.Fatalf("a trimmed stream vanished from the history list: total %d", list.GetTotalCount())
	}
	if list.GetConversations()[0].GetTitle() != "the question" {
		t.Fatalf("title after trimming = %q", list.GetConversations()[0].GetTitle())
	}
	detail = manager.HeadlessConversationGet("agentd-1", "conv-1", 0)
	if !strings.Contains(detail.GetMessagesJson(), "the answer") {
		t.Fatalf("the trimmed stream's snapshot transcript was not served: %q", detail.GetMessagesJson())
	}
}

// The transcript VIEW must survive the event clock, not just the list. The
// pane renders from the conversation stream's replay; once the reaper has
// trimmed the log past a finished run's final projection, the replay alone
// would be empty. The retained projection (with a synthesized, faithful
// run_finished) lets the client rebuild the turn — and the message must carry
// the REAL terminal status, not an invented one.
func TestTrimmedFinishedRunReplaysFromRetainedSnapshot(t *testing.T) {
	manager := NewManager()
	manager.convStreams.retainFinishedSnapshot = func(string) bool { return true }
	projection := reliableIngressProjection(t,
		`[{"id":"u1","kind":"user","text":"the question","attachments":[]},{"id":"a1","kind":"assistant","text":"the answer"}]`)
	batch := &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressTerminal(projection, 0, "failed")},
	}
	if ack := manager.ingestChatIngressBatch("agentd-1", batch); !ack.GetTerminalCommitted() {
		t.Fatalf("the terminal did not commit: %#v", ack)
	}

	// A fresh open sees the full log: no snapshot hydration needed.
	fresh := manager.SubscribeConversationStream("agentd-1", "conv-1", 0, "")
	fresh.Cleanup()
	if fresh.Snapshot != nil {
		t.Fatal("an untrimmed log must replay its events, not hydrate from the snapshot")
	}
	for _, event := range fresh.Events {
		if event.Type == StreamEventRunFinished && event.Payload["status"] != "failed" {
			t.Fatalf("the real run_finished status was not %q: %#v", "failed", event.Payload)
		}
	}

	// Simulate the reaper's trimming: the log expires while the retained
	// projection (and the remembered finish) live on.
	manager.convStreams.mu.Lock()
	stream := manager.convStreams.streams[agentScopedKey("agentd-1", "conv-1")]
	if stream == nil {
		manager.convStreams.mu.Unlock()
		t.Fatal("the stream disappeared")
	}
	snapshot := stream.latestSnapshot
	if snapshot == nil || snapshot.RunID == "" {
		manager.convStreams.mu.Unlock()
		t.Fatal("the finished run's projection was not retained")
	}
	stream.events = nil
	stream.evictedThroughSeq = stream.lastSeq
	manager.convStreams.mu.Unlock()

	trimmed := manager.SubscribeConversationStream("agentd-1", "conv-1", 0, "")
	trimmed.Cleanup()
	if trimmed.Snapshot == nil {
		t.Fatal("a trimmed finished run must hydrate from the retained snapshot")
	}
	if !strings.Contains(trimmed.Snapshot.EntriesJSON, "the answer") {
		t.Fatalf("the hydrated snapshot lost the transcript: %q", trimmed.Snapshot.EntriesJSON)
	}
	if len(trimmed.Events) != 1 || trimmed.Events[0].Type != StreamEventRunFinished {
		t.Fatalf("the trimmed replay must carry exactly the synthesized run_finished, got %d events", len(trimmed.Events))
	}
	finished := trimmed.Events[0]
	if finished.Seq != trimmed.Snapshot.AsOfSeq+1 {
		t.Fatalf("the synthesized terminal's seq %d must be the snapshot's seq + 1", finished.Seq)
	}
	if finished.Payload["status"] != "failed" {
		t.Fatalf("the synthesized run_finished must carry the REAL status, got %#v", finished.Payload["status"])
	}
	if finished.Payload["run_id"] != "run-1" || finished.Payload["type"] != StreamEventRunFinished {
		t.Fatalf("the synthesized event is not wire-shaped: %#v", finished.Payload)
	}

	// A client that already holds the snapshot must not get it again.
	resumed := manager.SubscribeConversationStream("agentd-1", "conv-1", trimmed.Snapshot.AsOfSeq+1, "")
	resumed.Cleanup()
	if resumed.Snapshot != nil || len(resumed.Events) != 0 {
		t.Fatalf("a resume past the snapshot must not re-hydrate: snapshot=%v events=%d", resumed.Snapshot, len(resumed.Events))
	}
}
