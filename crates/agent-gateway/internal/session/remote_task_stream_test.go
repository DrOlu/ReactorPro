package session

import (
	"strings"
	"testing"
)

// The delta streamer's whole policy is append-only growth: a snapshot that
// extends the previously seen text yields its growth; anything else yields
// nothing and re-anchors, because the terminal result — not the stream — is
// the canonical text.
func TestRemoteTaskDeltaStreamEmitsAppendOnlyGrowth(t *testing.T) {
	var stream remoteTaskDeltaStream

	if got := stream.delta("Q3 revenue was up 12%."); got != "Q3 revenue was up 12%." {
		t.Fatalf("first snapshot should emit in full, got %q", got)
	}
	if got := stream.delta("Q3 revenue was up 12%. Margins improved 2 points."); got != " Margins improved 2 points." {
		t.Fatalf("growth should emit as a delta, got %q", got)
	}
	if got := stream.delta("Q3 revenue was up 12%. Margins improved 2 points."); got != "" {
		t.Fatalf("an unchanged snapshot must not re-emit, got %q", got)
	}
	if got := stream.delta("A completely different projection"); got != "" {
		t.Fatalf("a rewrite must not emit a duplicate delta, got %q", got)
	}
	// After the rewrite the streamer is re-anchored on the new text.
	if got := stream.delta("A completely different projection, continued."); got != ", continued." {
		t.Fatalf("growth after a rewrite should emit, got %q", got)
	}
	// A shrink is a rewrite for these purposes: no delta, re-anchor.
	if got := stream.delta("Short"); got != "" {
		t.Fatalf("a shrink must not emit, got %q", got)
	}
}

// A run that streams token events feeds its deltas to the listener verbatim,
// and the snapshots that follow — containing exactly the text the tokens
// already delivered — must NOT feed the stream a second time. The snapshots
// still update the accumulator's entries: the terminal result stays
// canonical, the delta stream a progress view.
func TestRemoteTaskAccumulatorTokenEventsFeedWithoutDoubleCount(t *testing.T) {
	var deltas []string
	acc := remoteTaskAccumulator{runID: "run-1", onDelta: func(delta string) {
		deltas = append(deltas, delta)
	}}

	fullAnswer := "Hello, streaming world."
	acc.observe(&ConversationEvent{
		Type: "token", RunID: "run-1",
		Payload: map[string]any{"text": "Hello, "},
	})
	acc.observe(&ConversationEvent{
		Type: "token", RunID: "run-1",
		Payload: map[string]any{"text": "streaming world."},
	})
	// The snapshot that contains the whole answer: entries update, the
	// stream does not see it again.
	acc.observe(&ConversationEvent{
		Type: StreamEventContentSnapshot, RunID: "run-1",
		Payload: map[string]any{"entries_json": `[{"id":"a1","kind":"assistant","text":"Hello, streaming world."}]`},
	})
	acc.observe(&ConversationEvent{
		Type: StreamEventRunFinished, RunID: "run-1",
		Payload: map[string]any{"status": "completed"},
	})

	joined := strings.Join(deltas, "")
	if joined != fullAnswer {
		t.Fatalf("token deltas = %q, want the full answer %q", joined, fullAnswer)
	}
	// Two token events in, two token events out — plus NOTHING from the
	// snapshot that followed.
	if len(deltas) != 2 {
		t.Fatalf("the snapshot re-delivered text the tokens already fed: %+v", deltas)
	}
	result := acc.result()
	if !result.OK {
		t.Fatalf("the run settled wrongly: %s (%s)", result.ErrorMessage, result.ErrorCode)
	}
	if !strings.Contains(string(result.Output), fullAnswer) {
		t.Fatalf("the canonical result lost the answer: %s", result.Output)
	}
}

// A run that never streams tokens keeps the snapshot-growth behaviour,
// byte-for-byte the pre-token era: the regression guard for this change.
func TestRemoteTaskAccumulatorSnapshotGrowthWithoutTokens(t *testing.T) {
	var deltas []string
	acc := remoteTaskAccumulator{runID: "run-1", onDelta: func(delta string) {
		deltas = append(deltas, delta)
	}}

	acc.observe(&ConversationEvent{
		Type: StreamEventContentSnapshot, RunID: "run-1",
		Payload: map[string]any{"entries_json": `[{"id":"a1","kind":"assistant","text":"first part."}]`},
	})
	acc.observe(&ConversationEvent{
		Type: StreamEventContentSnapshot, RunID: "run-1",
		Payload: map[string]any{"entries_json": `[{"id":"a1","kind":"assistant","text":"first part. second part."}]`},
	})
	acc.observe(&ConversationEvent{
		Type: StreamEventRunFinished, RunID: "run-1",
		Payload: map[string]any{"status": "completed"},
	})

	if strings.Join(deltas, "") != "first part. second part." {
		t.Fatalf("snapshot growth = %q, want the whole answer exactly once", strings.Join(deltas, ""))
	}
}

// Token events of another run must not feed this accumulator's stream, and a
// blank token is ignored without flipping the source.
func TestRemoteTaskAccumulatorIgnoresForeignAndEmptyTokens(t *testing.T) {
	var deltas []string
	acc := remoteTaskAccumulator{runID: "run-1", onDelta: func(delta string) {
		deltas = append(deltas, delta)
	}}

	acc.observe(&ConversationEvent{
		Type: "token", RunID: "run-other",
		Payload: map[string]any{"text": "not mine"},
	})
	acc.observe(&ConversationEvent{
		Type: "token", RunID: "run-1",
		Payload: map[string]any{"text": "   "},
	})
	// Still on snapshot growth: the run's own first meaningful snapshot
	// feeds the stream as before.
	acc.observe(&ConversationEvent{
		Type: StreamEventContentSnapshot, RunID: "run-1",
		Payload: map[string]any{"entries_json": `[{"id":"a1","kind":"assistant","text":"snapshot-fed"}]`},
	})
	if len(deltas) != 1 || deltas[0] != "snapshot-fed" {
		t.Fatalf("foreign or blank tokens disturbed the stream: %+v", deltas)
	}
}
