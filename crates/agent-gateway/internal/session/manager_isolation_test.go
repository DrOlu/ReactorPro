package session

import (
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// dispatchFor ingests an envelope under the agent's authenticated session
// identity (simulating the protocol layer's DispatchFromAgentForSession
// call path).
func dispatchFor(m *Manager, sess *AgentSession, env *gatewayv2.AgentEnvelope) {
	m.DispatchFromAgentForSession(sess, env)
}

func TestBroadcastEventsCarrySourceAgentTag(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	b := newTestSession(m, "agent-b", "session-b")
	m.SetSession(b)
	t.Cleanup(func() { m.ClearSession(a); m.ClearSession(b) })

	events, cleanup := m.SubscribeHistorySync()
	defer cleanup()

	// A and B each emit one history event: the subscriber must be able to
	// distinguish the source by tag.
	dispatchFor(m, a, &gatewayv2.AgentEnvelope{
		Payload: &gatewayv2.AgentEnvelope_HistorySync{
			HistorySync: &gatewayv2.HistorySyncEvent{Kind: "upsert", ConversationId: "conv-a"},
		},
	})
	dispatchFor(m, b, &gatewayv2.AgentEnvelope{
		Payload: &gatewayv2.AgentEnvelope_HistorySync{
			HistorySync: &gatewayv2.HistorySyncEvent{Kind: "upsert", ConversationId: "conv-b"},
		},
	})

	for _, want := range []struct{ agentID, convID string }{
		{"agent-a", "conv-a"},
		{"agent-b", "conv-b"},
	} {
		select {
		case tagged := <-events:
			if tagged.AgentID != want.agentID || tagged.Event.GetConversationId() != want.convID {
				t.Fatalf("tagged event = %s/%s, want %s/%s",
					tagged.AgentID, tagged.Event.GetConversationId(), want.agentID, want.convID)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for %s event", want.agentID)
		}
	}
}

func TestDisplacedSessionEventsAreDropped(t *testing.T) {
	m := NewManager()
	old := newTestSession(m, "agent-a", "session-old")
	m.SetSession(old)
	replacement := newTestSession(m, "agent-a", "session-new")
	m.SetSession(replacement)
	t.Cleanup(func() { m.ClearSession(replacement) })

	events, cleanup := m.SubscribeHistorySync()
	defer cleanup()

	// A late event from a displaced connection must be dropped and must
	// not be recorded as if it came from the new session.
	dispatchFor(m, old, &gatewayv2.AgentEnvelope{
		Payload: &gatewayv2.AgentEnvelope_HistorySync{
			HistorySync: &gatewayv2.HistorySyncEvent{Kind: "upsert", ConversationId: "stale"},
		},
	})
	select {
	case tagged := <-events:
		t.Fatalf("stale session event was broadcast: %#v", tagged)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestTunnelFrameFromWrongAgentIsRejected(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	b := newTestSession(m, "agent-b", "session-b")
	m.SetSession(b)
	t.Cleanup(func() { m.ClearSession(a); m.ClearSession(b) })

	// A declares a tunnel and has a visitor stream.
	m.ApplyDesiredState("agent-a", &gatewayv2.TunnelDesiredState{
		Tunnels: []*gatewayv2.TunnelSpec{{Id: "tun-a", TargetUrl: "http://localhost:3000"}},
	})
	slug := m.TunnelStateSnapshot("agent-a").GetTunnels()[0].GetSlug()
	lease, err := m.AcquireTunnel(slug, "s-1")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer lease.Release()
	if lease.AgentID() != "agent-a" {
		t.Fatalf("lease agent = %q, want agent-a", lease.AgentID())
	}

	// B forges A's stream_id to inject data: it must be dropped.
	m.dispatchTunnelFrame("agent-b", &gatewayv2.TunnelFrame{
		StreamId: "s-1",
		Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_BODY,
		Body:     []byte("forged"),
	})
	select {
	case frame := <-lease.Frames():
		t.Fatalf("forged cross-agent frame was delivered: %#v", frame)
	case <-time.After(50 * time.Millisecond):
	}

	// A's own frame is delivered normally.
	m.dispatchTunnelFrame("agent-a", &gatewayv2.TunnelFrame{
		StreamId: "s-1",
		Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_BODY,
		Body:     []byte("legit"),
	})
	select {
	case frame := <-lease.Frames():
		if string(frame.GetBody()) != "legit" {
			t.Fatalf("frame data = %q", frame.GetBody())
		}
	case <-time.After(time.Second):
		t.Fatal("legitimate frame was not delivered")
	}
}

func TestSettingsGatesAreScopedPerAgent(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	b := newTestSession(m, "agent-b", "session-b")
	m.SetSession(b)
	t.Cleanup(func() { m.ClearSession(a); m.ClearSession(b) })

	m.ApplySettingsJSON("agent-a", `{"remote":{"enableWebTerminal":true}}`)
	m.ApplySettingsJSON("agent-b", `{"remote":{"enableWebTerminal":false}}`)

	if !m.WebTerminalEnabled("agent-a") {
		t.Fatal("agent-a web terminal should be enabled")
	}
	if m.WebTerminalEnabled("agent-b") {
		t.Fatal("agent-b web terminal must stay disabled — gates must not leak across agents")
	}
}

func TestTerminalSnapshotsAreScopedPerAgent(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	b := newTestSession(m, "agent-b", "session-b")
	m.SetSession(b)
	t.Cleanup(func() { m.ClearSession(a); m.ClearSession(b) })

	m.ApplyTerminalResponseSnapshot("agent-a", "create", "", &gatewayv2.TerminalResponse{
		Action:  "create",
		Session: &gatewayv2.TerminalSession{Id: "term-a", Running: true},
	})

	if got := len(m.TerminalSessionSnapshot("agent-a", "")); got != 1 {
		t.Fatalf("agent-a terminal snapshot = %d entries, want 1", got)
	}
	if got := len(m.TerminalSessionSnapshot("agent-b", "")); got != 0 {
		t.Fatalf("agent-b terminal snapshot = %d entries, want 0 (isolation)", got)
	}

	// A session replacement for A only clears A's snapshot.
	m.SetSession(newTestSession(m, "agent-a", "session-a2"))
	if got := len(m.TerminalSessionSnapshot("agent-a", "")); got != 0 {
		t.Fatalf("agent-a snapshot after displacement = %d, want 0", got)
	}
}

func TestConversationEpochUsesSourceAgentSession(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	b1 := newTestSession(m, "agent-b", "session-b1")
	m.SetSession(b1)
	b2 := newTestSession(m, "agent-b", "session-b2")
	m.SetSession(b2)
	t.Cleanup(func() { m.ClearSession(a); m.ClearSession(b2) })

	wantEpoch := m.sessionEpochOf("agent-b")
	if wantEpoch < 2 {
		t.Fatalf("agent-b session epoch = %d, want replacement epoch", wantEpoch)
	}
	dispatchFor(m, b2, &gatewayv2.AgentEnvelope{
		RequestId: "run-b",
		Payload: &gatewayv2.AgentEnvelope_ChatControl{
			ChatControl: startedControl("run-b", "conv-b"),
		},
	})

	m.convStreams.mu.Lock()
	stream := m.convStreams.streams[conversationStreamKey("agent-b", "conv-b")]
	gotEpoch := uint64(0)
	if stream != nil {
		gotEpoch = stream.agentEpoch
	}
	m.convStreams.mu.Unlock()
	if gotEpoch != wantEpoch {
		t.Fatalf("conversation agent epoch = %d, want source agent epoch %d", gotEpoch, wantEpoch)
	}
}

func TestRuntimeStatusReconcilesOnlySourceAgentRuns(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	b := newTestSession(m, "agent-b", "session-b")
	m.SetSession(b)
	t.Cleanup(func() { m.ClearSession(a); m.ClearSession(b) })

	dispatchFor(m, a, &gatewayv2.AgentEnvelope{
		RequestId: "run-a",
		Payload: &gatewayv2.AgentEnvelope_ChatControl{
			ChatControl: startedControl("run-a", "conv-a"),
		},
	})
	dispatchFor(m, b, &gatewayv2.AgentEnvelope{
		RequestId: "run-b",
		Payload: &gatewayv2.AgentEnvelope_ChatControl{
			ChatControl: startedControl("run-b", "conv-b"),
		},
	})

	m.convStreams.onRuntimeStatus("agent-a", runsReport(nil, nil), time.Now().Add(20*time.Second))
	activities := m.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].AgentID != "agent-b" || activities[0].RunID != "run-b" {
		t.Fatalf("activities after agent-a empty report = %#v, want only agent-b/run-b", activities)
	}
}

func TestConversationStreamsAreScopedByAgent(t *testing.T) {
	m := NewManager()
	subA := m.SubscribeConversationStream("agent-a", "conv-shared", 0, "")
	defer subA.Cleanup()
	subB := m.SubscribeConversationStream("agent-b", "conv-shared", 0, "")
	defer subB.Cleanup()

	m.ingestChatControl("agent-a", "run-shared", startedControl("run-shared", "conv-shared"))
	m.ingestChatEvent("agent-a", "run-shared", tokenEvent("conv-shared", "from-a"))
	eventsA := drainEvents(t, subA.EventCh, 2)
	if got := eventsA[1].Payload["text"]; got != "from-a" {
		t.Fatalf("agent-a token = %#v, want from-a", got)
	}
	select {
	case event := <-subB.EventCh:
		t.Fatalf("agent-b received agent-a event: %#v", event)
	case <-time.After(50 * time.Millisecond):
	}

	m.ingestChatControl("agent-b", "run-shared", startedControl("run-shared", "conv-shared"))
	m.ingestChatEvent("agent-b", "run-shared", tokenEvent("conv-shared", "from-b"))
	eventsB := drainEvents(t, subB.EventCh, 2)
	if got := eventsB[1].Payload["text"]; got != "from-b" {
		t.Fatalf("agent-b token = %#v, want from-b", got)
	}
	select {
	case event := <-subA.EventCh:
		t.Fatalf("agent-a received agent-b event: %#v", event)
	case <-time.After(50 * time.Millisecond):
	}

	replayA := m.SubscribeConversationStream("agent-a", "conv-shared", 0, "")
	defer replayA.Cleanup()
	replayB := m.SubscribeConversationStream("agent-b", "conv-shared", 0, "")
	defer replayB.Cleanup()
	if len(replayA.Events) != 2 || replayA.Events[1].Payload["text"] != "from-a" {
		t.Fatalf("agent-a replay leaked or lost events: %#v", replayA.Events)
	}
	if len(replayB.Events) != 2 || replayB.Events[1].Payload["text"] != "from-b" {
		t.Fatalf("agent-b replay leaked or lost events: %#v", replayB.Events)
	}
}

func TestConversationCancelAndWatchdogAreScopedByAgent(t *testing.T) {
	m := NewManager()
	m.ingestChatControl("agent-a", "run-shared", startedControl("run-shared", "conv-shared"))
	m.ingestChatControl("agent-b", "run-shared", startedControl("run-shared", "conv-shared"))

	runID, ok := m.MarkConversationCancelling("agent-a", "conv-shared", "run-shared")
	if !ok || runID != "run-shared" {
		t.Fatalf("agent-a cancel mark = %q/%v", runID, ok)
	}
	subA := m.SubscribeConversationStream("agent-a", "conv-shared", 0, "")
	defer subA.Cleanup()
	subB := m.SubscribeConversationStream("agent-b", "conv-shared", 0, "")
	defer subB.Cleanup()
	if subA.Activity == nil || subA.Activity.State != RunActivityCancelling {
		t.Fatalf("agent-a activity = %#v, want cancelling", subA.Activity)
	}
	if subB.Activity == nil || subB.Activity.State != RunActivityRunning {
		t.Fatalf("agent-b activity = %#v, want running", subB.Activity)
	}

	m.ForceFinishRun("agent-a", "run-shared", "cancelled", "cancel_timeout", "watchdog")
	activities := m.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].AgentID != "agent-b" || activities[0].RunID != "run-shared" {
		t.Fatalf("cross-agent watchdog affected wrong run: %#v", activities)
	}
}

func TestChatCommandDedupeIsScopedByAgent(t *testing.T) {
	m := NewManager()
	startA := m.StartChatCommand("agent-a", "run-shared", "conv-shared", "", "client-shared", nil)
	startB := m.StartChatCommand("agent-b", "run-shared", "conv-shared", "", "client-shared", nil)
	if startA.Deduped || startB.Deduped {
		t.Fatalf("cross-agent client_request_id was deduped: a=%#v b=%#v", startA, startB)
	}
	lookupA, okA := m.LookupChatCommand("agent-a", "client-shared")
	lookupB, okB := m.LookupChatCommand("agent-b", "client-shared")
	if !okA || lookupA.AgentID != "agent-a" || lookupA.RunID != "run-shared" {
		t.Fatalf("agent-a lookup = %#v/%v", lookupA, okA)
	}
	if !okB || lookupB.AgentID != "agent-b" || lookupB.RunID != "run-shared" {
		t.Fatalf("agent-b lookup = %#v/%v", lookupB, okB)
	}
}
