package session

import "testing"

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
