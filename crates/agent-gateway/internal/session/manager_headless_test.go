package session

// The headless history contract: a conversation stays visible and servable
// for as long as the stream lives, not merely for as long as its event log
// survives trimming. The store trims conversation events on a retention clock
// shorter than a stream's idle life; a finished conversation whose events are
// gone still serves from its latest snapshot — the same hydration the
// subscription path gives late joiners.

import (
	"fmt"
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

// The resume prompt's rendering contract, pinned as pure functions: the
// NEWEST turns win the budget (the pre-trim renderer iterated oldest-first
// and dropped everything newer than the first oversized line — backwards
// from its own comment), one straddling turn is trimmed head-and-tail
// instead of evicting its elders, and assistant turns carry a capped
// one-line tool trace so a resumed turn knows what already ran.

func TestRenderHeadlessResumePromptKeepsTheNewestTurnsWhole(t *testing.T) {
	turns := []headlessTurn{
		{Kind: "user", Text: "first question"},
		{Kind: "assistant", Text: strings.Repeat("old answer ", 2400)}, // ~26KB: over the cap
		{Kind: "user", Text: "second question"},
		{Kind: "assistant", Text: "the newest answer"},
	}
	prompt := renderHeadlessResumePrompt("what next?", turns)
	if !strings.Contains(prompt, "the newest answer") {
		t.Fatal("the newest turn must survive the budget")
	}
	if !strings.Contains(prompt, "second question") {
		t.Fatal("the second-newest turn must survive the budget")
	}
	if !strings.Contains(prompt, "first question") {
		t.Fatal("the oldest turn should still fit: only the huge middle turn is trimmed")
	}
	if !strings.Contains(prompt, "old answer") {
		t.Fatal("the huge turn's head should survive as a trimmed view")
	}
	if !strings.Contains(prompt, "[…trimmed ") {
		t.Fatal("the trimmed turn must carry its marker")
	}
}

func TestRenderHeadlessResumePromptTrimsRatherThanEvicts(t *testing.T) {
	// One turn alone exceeds the whole prompt cap; the renderer must keep
	// the newest turns, a trimmed view of the huge one, and — because the
	// trim takes only half the remaining budget — the oldest turn too.
	turns := []headlessTurn{
		{Kind: "user", Text: "old question"},
		{Kind: "user", Text: strings.Repeat("huge ", 20<<10)}, // ~100KB
		{Kind: "assistant", Text: "newest answer"},
	}
	prompt := renderHeadlessResumePrompt("continue", turns)
	if !strings.Contains(prompt, "newest answer") {
		t.Fatal("the newest turn must be whole")
	}
	if !strings.Contains(prompt, "[…trimmed ") {
		t.Fatal("the huge turn should appear as a trimmed view, not vanish")
	}
	if !strings.Contains(prompt, "old question") {
		t.Fatal("the trim must leave budget for the elders — that is its whole point")
	}
	if len(prompt) > headlessResumePromptCap+512 {
		t.Fatalf("the prompt blew its budget: %d bytes", len(prompt))
	}
}

func TestRenderHeadlessResumePromptBoundsTurnCount(t *testing.T) {
	turns := make([]headlessTurn, 0, headlessResumeTurns+10)
	for i := 0; i < headlessResumeTurns+10; i++ {
		turns = append(turns, headlessTurn{Kind: "user", Text: fmt.Sprintf("turn %d", i)})
	}
	prompt := renderHeadlessResumePrompt("next", turns)
	if strings.Contains(prompt, "turn 0") || strings.Contains(prompt, "turn 5") {
		t.Fatal("turns beyond the newest window must not be rehydrated")
	}
	if !strings.Contains(prompt, fmt.Sprintf("turn %d", headlessResumeTurns+9)) {
		t.Fatal("the newest turn must be rehydrated")
	}
}

func TestHeadlessTurnsFromEntriesAttachesTheToolTrace(t *testing.T) {
	entries := []headlessTranscriptEntry{
		{ID: "1", Kind: "user", Text: "write it"},
		{ID: "a1", Kind: "assistant", Text: "on it"},
		{ID: "t1", Kind: "tool_call", Text: "write_file(out.txt)"},
		{ID: "r1", Kind: "tool_result", Text: "wrote 21 bytes"},
		{ID: "t2", Kind: "tool_call", Text: "run_command(npm test)"},
		{ID: "r2", Kind: "tool_result", Text: "ok"},
		{ID: "a2", Kind: "assistant", Text: "done"},
	}
	turns := headlessTurnsFromEntries(entries)
	if len(turns) != 3 {
		t.Fatalf("user + 2 assistant turns, got %d", len(turns))
	}
	if len(turns[1].Tools) != 2 || turns[1].Tools[0] != "write_file(out.txt)" {
		t.Fatalf("tool calls must attach to their assistant turn: %+v", turns[1].Tools)
	}
	if len(turns[2].Tools) != 0 {
		t.Fatalf("the final assistant turn issued no tools: %+v", turns[2].Tools)
	}
	// Tool results stay out of the resume memory entirely.
	prompt := renderHeadlessResumePrompt("again", turns)
	if strings.Contains(prompt, "wrote 21 bytes") {
		t.Fatal("tool result bodies must not ride the resume prompt")
	}
	if !strings.Contains(prompt, "[tools used: write_file(out.txt); run_command(npm test)]") {
		t.Fatalf("the tool trace must ride the assistant turn: %q", prompt)
	}
}

func TestHeadlessToolsLineCapsTheTrace(t *testing.T) {
	tools := []string{"a(x)", "b(y)", "c(z)", "d(w)", "e(v)"}
	line := headlessToolsLine(tools)
	if !strings.Contains(line, "a(x)") || !strings.Contains(line, "c(z)") {
		t.Fatalf("the first three calls must be named: %q", line)
	}
	if strings.Contains(line, "d(w)") {
		t.Fatalf("beyond three the trace must count, not list: %q", line)
	}
	if !strings.Contains(line, "+2 more") {
		t.Fatalf("the dropped calls must be counted: %q", line)
	}
}
