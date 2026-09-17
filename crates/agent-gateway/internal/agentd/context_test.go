package agentd

// Tests for the within-turn context manager. Everything here pins the
// compactMessages ladder as a pure function: under budget nothing moves,
// elision is oldest-first with the newest kept verbatim, drop-middle never
// touches the system prompt, the first user message or the current round,
// and the token estimator behaves sanely for CJK and Western text.

import (
	"fmt"
	"strings"
	"testing"

	"github.com/liveagent/agent-gateway/internal/proto/v2"
)

// turnFixture builds a plausible turn history: system, user, then n
// assistant(tool_calls)+tool exchanges whose results are large enough to
// matter, with a final bare assistant answer not yet sent.
func turnFixture(n int, resultBytes int) []Message {
	messages := []Message{
		{Role: "system", Content: "system prompt"},
		{Role: "user", Content: "the task"},
	}
	for i := 0; i < n; i++ {
		call := ToolCall{ID: fmt.Sprintf("call-%d", i), Type: "function"}
		call.Function.Name = fmt.Sprintf("tool_%d", i)
		call.Function.Arguments = "{}"
		assistant := Message{Role: "assistant", Content: fmt.Sprintf("assistant text %d", i)}
		assistant.ToolCalls = append(assistant.ToolCalls, call)
		messages = append(messages, assistant, Message{
			Role:       "tool",
			ToolCallID: call.ID,
			Content:    strings.Repeat(fmt.Sprintf("result %d ", i), resultBytes/10),
		})
	}
	return messages
}

func TestCompactMessagesIsANoOpUnderBudget(t *testing.T) {
	messages := turnFixture(3, 400)
	before := messages
	result := compactMessages(messages, contextBudget{maxTokens: 1 << 30, keepToolResults: 4})
	if len(result.messages) != len(before) {
		t.Fatalf("under budget the message list changed: %d -> %d", len(before), len(result.messages))
	}
	if result.elidedToolResults != 0 || result.droppedExchanges != 0 {
		t.Fatalf("under budget the ladder fired: elided=%d dropped=%d", result.elidedToolResults, result.droppedExchanges)
	}
	if result.estimatedAfter != result.estimatedBefore {
		t.Fatalf("estimates drifted without changes: %d -> %d", result.estimatedBefore, result.estimatedAfter)
	}
}

func TestCompactMessagesDisabledReturnsInput(t *testing.T) {
	messages := turnFixture(8, 4096)
	result := compactMessages(messages, contextBudget{maxTokens: 0, keepToolResults: 4})
	if len(result.messages) != len(messages) || result.elidedToolResults != 0 || result.droppedExchanges != 0 {
		t.Fatalf("a disabled budget (maxTokens=0) must be a complete no-op")
	}
}

func TestCompactMessagesElidesOldestToolResultsAndKeepsTheNewestVerbatim(t *testing.T) {
	messages := turnFixture(6, 8000)
	// Budget high enough that elision alone must suffice (no drops).
	budget := contextBudget{maxTokens: estimateMessagesTokens(messages) - 2*2000, keepToolResults: 2}
	result := compactMessages(messages, budget)

	if result.droppedExchanges != 0 {
		t.Fatalf("elision alone should have met the budget; %d exchanges dropped", result.droppedExchanges)
	}
	if result.elidedToolResults != 4 {
		t.Fatalf("expected the 4 oldest of 6 tool results elided, got %d", result.elidedToolResults)
	}
	if len(result.messages) != len(messages) {
		t.Fatalf("elision must not change the message count")
	}

	// Newest two tool results verbatim.
	if result.messages[len(result.messages)-2].Content != messages[len(messages)-2].Content ||
		result.messages[len(result.messages)-1].Content != messages[len(messages)-1].Content {
		t.Fatalf("the newest keepToolResults tool results must stay verbatim")
	}
	// Exactly the 4 old tool results carry the marker; the newest two are
	// plain content (checked above), and every assistant record is intact.
	marked, plainTool := 0, 0
	for _, m := range result.messages {
		if m.Role != "tool" {
			continue
		}
		if strings.HasPrefix(m.Content, elisionMarkerPrefix) {
			marked++
		} else {
			plainTool++
		}
	}
	if marked != 4 || plainTool != 2 {
		t.Fatalf("expected 4 marked and 2 verbatim tool results, got %d/%d", marked, plainTool)
	}
	// Markers name the tool and the call they elided (exchanges are
	// numbered oldest-first in the fixture).
	toolOrdinal := 0
	for _, m := range result.messages {
		if m.Role != "tool" {
			continue
		}
		toolOrdinal++
		if toolOrdinal > 4 {
			break // the newest two are verbatim, checked already
		}
		if !strings.Contains(m.Content, fmt.Sprintf("call-%d", toolOrdinal-1)) ||
			!strings.Contains(m.Content, fmt.Sprintf("tool_%d", toolOrdinal-1)) {
			t.Fatalf("marker lost its reference: %.90s", m.Content)
		}
	}
	// The assistant tool-call records are untouched — the model still sees
	// what was asked of which tool.
	for i, m := range result.messages {
		if m.Role == "assistant" && len(m.ToolCalls) > 0 {
			if len(m.ToolCalls) != len(messages[i].ToolCalls) {
				t.Fatalf("assistant tool-call records were modified at %d", i)
			}
		}
	}
}

func TestCompactMessagesNeverTouchesSystemOrFirstUserOrCurrentRound(t *testing.T) {
	messages := turnFixture(8, 6000)
	// A tiny budget forces the drop-middle stage too.
	result := compactMessages(messages, contextBudget{maxTokens: 500, keepToolResults: 2})

	if result.messages[0].Role != "system" || result.messages[0].Content != "system prompt" {
		t.Fatalf("the system prompt was touched: %+v", result.messages[0])
	}
	if result.messages[1].Role != "user" || result.messages[1].Content != "the task" {
		t.Fatalf("the first user message (the task) was touched: %+v", result.messages[1])
	}
	if result.droppedExchanges == 0 {
		t.Fatalf("a tiny budget must reach the drop-middle stage")
	}
	// The current round — the newest exchange — must survive whole.
	last := result.messages[len(result.messages)-1]
	if last.Role != "tool" || !strings.HasPrefix(last.Content, "result 7") {
		t.Fatalf("the newest exchange was dropped or elided: role=%s %.40s", last.Role, last.Content)
	}
	// And it must be verbatim, not a marker.
	if strings.HasPrefix(last.Content, elisionMarkerPrefix) {
		t.Fatalf("the current round's tool result was elided")
	}
	// Structure stays valid: every tool message follows its assistant.
	for i, m := range result.messages {
		if m.Role == "tool" && i > 0 && result.messages[i-1].Role != "assistant" &&
			result.messages[i-1].Role != "tool" {
			t.Fatalf("tool message at %d dangles after a %s", i, result.messages[i-1].Role)
		}
	}
}

func TestCompactMessagesDoesNotMutateTheInput(t *testing.T) {
	messages := turnFixture(5, 8000)
	snapshot := make([]Message, len(messages))
	copy(snapshot, messages)
	compactMessages(messages, contextBudget{maxTokens: 100, keepToolResults: 1})
	for i := range messages {
		if messages[i].Content != snapshot[i].Content {
			t.Fatalf("compactMessages mutated the caller's slice at %d", i)
		}
	}
}

func TestCompactMessagesSingleExchangeIsNeverDroppedOrElided(t *testing.T) {
	// One exchange only: it IS the current round, and its result is inside
	// the keep window. Neither stage may touch it — the model needs that
	// result to act, and the ladder protects the working edge even when
	// that means staying over budget (the log line says so honestly).
	messages := turnFixture(1, 100000)
	result := compactMessages(messages, contextBudget{maxTokens: 200, keepToolResults: 4})
	if result.droppedExchanges != 0 {
		t.Fatalf("the only exchange (the current round) was dropped")
	}
	if result.elidedToolResults != 0 {
		t.Fatalf("the current round's tool result was elided")
	}
	if len(result.messages) != len(messages) {
		t.Fatalf("the message list changed")
	}
}

func TestEstimateTextTokensIsCJKAware(t *testing.T) {
	western := estimateTextTokens(strings.Repeat("a", 4000)) // ~1000 tokens
	if western < 900 || western > 1100 {
		t.Fatalf("4000 western chars should estimate near 1000 tokens, got %.0f", western)
	}
	cjk := estimateTextTokens(strings.Repeat("世", 1000)) // 0.7/char = 700
	if cjk < 650 || cjk > 750 {
		t.Fatalf("1000 CJK chars should estimate near 700 tokens, got %.0f", cjk)
	}
	mixed := estimateTextTokens(strings.Repeat("a", 400) + strings.Repeat("世", 100))
	want := 100.0 + 70.0 // 400/4 + 100*0.7
	if mixed < want*0.9 || mixed > want*1.1 {
		t.Fatalf("mixed text estimate drifted: %.0f (want ~%.0f)", mixed, want)
	}
}

func TestEstimateMessageTokensCountsToolCalls(t *testing.T) {
	plain := estimateMessageTokens(Message{Role: "user", Content: strings.Repeat("a", 400)})
	withCalls := estimateMessageTokens(Message{Role: "assistant", Content: strings.Repeat("a", 400), ToolCalls: []ToolCall{{ID: "x"}}})
	if withCalls <= plain {
		t.Fatalf("tool calls must add to the estimate: %.0f vs %.0f", withCalls, plain)
	}
}

func TestIngressDeltaEmitsRecordAndDiesAfterFirstFailure(t *testing.T) {
	var seqs []uint64
	var fail bool
	send := func(seq uint64, record *gatewayv2.ChatIngressRecord) error {
		if fail {
			return fmt.Errorf("send failed")
		}
		seqs = append(seqs, seq)
		return nil
	}
	i := newIngress("run", "conv", send)

	if err := i.delta(map[string]any{"type": "tool_status", "status": "compacting", "isCompaction": true}, "worker"); err != nil {
		t.Fatalf("first delta should send: %v", err)
	}
	// A checkpoint still goes through the ordinary path and takes the next seq.
	if err := i.checkpoint(nil); err != nil {
		t.Fatalf("checkpoint after a delta failed: %v", err)
	}
	fail = true
	if err := i.delta(map[string]any{"type": "token", "text": "x"}, "worker"); err == nil {
		t.Fatalf("the failing delta must report its error")
	}
	fail = false
	if err := i.delta(map[string]any{"type": "token", "text": "y"}, "worker"); err != nil {
		t.Fatalf("post-disable deltas are no-ops, not errors: %v", err)
	}
	if len(seqs) != 2 {
		t.Fatalf("seq discipline broken: %v", seqs)
	}
	// Heartbeats survive the delta death — liveness is not progress.
	if err := i.heartbeat(); err != nil {
		t.Fatalf("heartbeat after delta death failed: %v", err)
	}
}
