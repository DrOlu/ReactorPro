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
