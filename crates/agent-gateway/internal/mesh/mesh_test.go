package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGenerateIdentityBindsIDToKey(t *testing.T) {
	identity, err := GenerateIdentity("drolu/reactorpro")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	if identity.AgentID != "drolu/reactorpro" {
		t.Fatalf("agent id = %q", identity.AgentID)
	}
	if identity.Fingerprint != FingerprintFor("drolu/reactpro", identity.PublicKey()) &&
		identity.Fingerprint == "" {
		t.Fatal("fingerprint must not be empty")
	}
	if want := FingerprintFor("drolu/reactorpro", identity.PublicKey()); identity.Fingerprint != want {
		t.Fatalf("fingerprint = %q, want %q", identity.Fingerprint, want)
	}
}

func TestGenerateIdentityRequiresAgentID(t *testing.T) {
	if _, err := GenerateIdentity("   "); err == nil {
		t.Fatal("expected an error for an empty agent id")
	}
}

// The agent id is part of the fingerprint, so editing it must invalidate the
// identity. This is what makes the id unchangeable.
func TestParseIdentityRejectsRetypedAgentID(t *testing.T) {
	identity, err := GenerateIdentity("drolu/reactorpro")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	raw, err := json.Marshal(identity)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var mutated map[string]any
	if err := json.Unmarshal(raw, &mutated); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	mutated["identity"] = "someone/else"
	tampered, err := json.Marshal(mutated)
	if err != nil {
		t.Fatalf("marshal tampered: %v", err)
	}
	if _, err := ParseIdentity(tampered); !errors.Is(err, ErrIdentityTampered) {
		t.Fatalf("err = %v, want ErrIdentityTampered", err)
	}
}

func TestParseIdentityRejectsMismatchedKeyPair(t *testing.T) {
	first, err := GenerateIdentity("drolu/reactorpro")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	second, err := GenerateIdentity("drolu/reactorpro")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	// Keep the fingerprint of the first but swap in the second's public key.
	mixed := &Identity{
		AgentID:       first.AgentID,
		PrivateKeyPEM: first.PrivateKeyPEM,
		PublicKeyPEM:  second.PublicKeyPEM,
		Fingerprint:   FingerprintFor(first.AgentID, second.PublicKey()),
	}
	raw, err := json.Marshal(mixed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if _, err := ParseIdentity(raw); err == nil {
		t.Fatal("expected a mismatched keypair to be rejected")
	}
}

func TestLoadIdentityCreatesThenReuses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "reactorpro-identity.json")

	first, created, err := LoadIdentity(path, "drolu/reactorpro")
	if err != nil {
		t.Fatalf("LoadIdentity: %v", err)
	}
	if !created {
		t.Fatal("expected the first call to mint an identity")
	}
	second, createdAgain, err := LoadIdentity(path, "drolu/reactorpro")
	if err != nil {
		t.Fatalf("LoadIdentity reload: %v", err)
	}
	if createdAgain {
		t.Fatal("expected the second call to reuse the identity")
	}
	if first.Fingerprint != second.Fingerprint {
		t.Fatalf("fingerprints differ: %q vs %q", first.Fingerprint, second.Fingerprint)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("identity permissions = %o, want 600 (private key material)", perm)
	}
}

func TestLoadIdentityRefusesReassignment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	if _, _, err := LoadIdentity(path, "drolu/reactorpro"); err != nil {
		t.Fatalf("LoadIdentity: %v", err)
	}
	_, _, err := LoadIdentity(path, "drolu/someone-else")
	if err == nil {
		t.Fatal("expected reassigning the agent id to fail")
	}
	if !strings.Contains(err.Error(), "cannot be reassigned") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSignAndVerifyEnvelope(t *testing.T) {
	identity, err := GenerateIdentity("drolu/reactorpro")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeRequest,
		TS:      timestamp(),
		From:    identity.AgentID,
		Payload: json.RawMessage(`{"skill":"ping"}`),
	}
	if err := identity.Sign(envelope); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if err := VerifyEnvelope(envelope); err != nil {
		t.Fatalf("VerifyEnvelope: %v", err)
	}

	// Any mutation of a covered field must break verification.
	envelope.Payload = json.RawMessage(`{"skill":"tampered"}`)
	if err := VerifyEnvelope(envelope); err == nil {
		t.Fatal("expected a tampered payload to fail verification")
	}
}

func TestVerifyEnvelopeRejectsUnsigned(t *testing.T) {
	if err := VerifyEnvelope(&Envelope{Version: ProtocolVersion}); err == nil {
		t.Fatal("expected an unsigned envelope to be rejected")
	}
}

func TestConfigValidate(t *testing.T) {
	disabled := DefaultConfig()
	if err := disabled.Validate(); err != nil {
		t.Fatalf("a disabled bridge must be valid: %v", err)
	}

	enabledNoURL := DefaultConfig()
	enabledNoURL.Enabled = true
	if err := enabledNoURL.Validate(); err == nil {
		t.Fatal("expected enabled-without-URL to fail")
	}

	userNoPassword := DefaultConfig()
	userNoPassword.Enabled = true
	userNoPassword.URL = "nats://localhost:4222"
	userNoPassword.User = "reactorpro"
	if err := userNoPassword.Validate(); err == nil {
		t.Fatal("expected user-without-password to fail")
	}

	valid := DefaultConfig()
	valid.Enabled = true
	valid.URL = "nats://localhost:4222"
	valid.Token = "secret"
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected a valid config: %v", err)
	}
}

func TestNATSOptionsPrecedence(t *testing.T) {
	config := DefaultConfig()
	config.CredsFile = "/tmp/creds"
	config.Token = "token"
	config.User = "user"
	config.Password = "pass"
	options, err := config.natsOptions()
	if err != nil {
		t.Fatalf("natsOptions: %v", err)
	}
	// Name + reconnect options + one auth option.
	if len(options) != 4 {
		t.Fatalf("option count = %d, want 4 (auth precedence must pick exactly one)", len(options))
	}
}

func TestSubjectHelpers(t *testing.T) {
	if got := AgentInboxSubject("drolu/reactorpro"); got != "mesh.agent.drolu/reactorpro.inbox" {
		t.Fatalf("AgentInboxSubject = %q", got)
	}
	if got := HeartbeatSubject("drolu/reactorpro"); got != "mesh.heartbeat.drolu/reactorpro" {
		t.Fatalf("HeartbeatSubject = %q", got)
	}
}

func TestManifestMatches(t *testing.T) {
	manifest := Manifest{
		ID:           "peer",
		Name:         "Peer",
		Capabilities: []string{"agent", "sre"},
		Skills:       []Skill{{ID: "ping"}, {ID: "restart"}},
		Availability: AvailabilityOnline,
	}
	cases := []struct {
		name   string
		filter DiscoverFilter
		want   bool
	}{
		{"empty filter matches", DiscoverFilter{}, true},
		{"capability subset matches", DiscoverFilter{Capabilities: []string{"sre"}}, true},
		{"missing capability fails", DiscoverFilter{Capabilities: []string{"billing"}}, false},
		{"skill subset matches", DiscoverFilter{SkillIDs: []string{"ping"}}, true},
		{"missing skill fails", DiscoverFilter{SkillIDs: []string{"deploy"}}, false},
		{"availability matches", DiscoverFilter{Availability: AvailabilityOnline}, true},
		{"availability mismatch fails", DiscoverFilter{Availability: "offline"}, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := manifestMatches(manifest, testCase.filter); got != testCase.want {
				t.Fatalf("manifestMatches = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestManifestMatchesRejectsIncomplete(t *testing.T) {
	if manifestMatches(Manifest{ID: "x"}, DiscoverFilter{}) {
		t.Fatal("a manifest without a name must not match: the SDK requires both id and name")
	}
}

func TestManifestsFromAcceptsBothReplyShapes(t *testing.T) {
	registryReply, err := json.Marshal(Envelope{
		Version: ProtocolVersion,
		Type:    TypeRespond,
		Payload: json.RawMessage(`{"agents":[{"id":"a","name":"A"}]}`),
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got := manifestsFrom(registryReply); len(got) != 1 || got[0].ID != "a" {
		t.Fatalf("registry reply = %+v", got)
	}

	directReply, err := json.Marshal(Envelope{
		Version: ProtocolVersion,
		Type:    TypeRegister,
		Payload: json.RawMessage(`{"id":"b","name":"B"}`),
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got := manifestsFrom(directReply); len(got) != 1 || got[0].ID != "b" {
		t.Fatalf("direct reply = %+v", got)
	}

	if got := manifestsFrom([]byte("not json")); got != nil {
		t.Fatalf("garbage should yield nothing, got %+v", got)
	}
}

func TestReplyEnvelopeCarriesCorrelation(t *testing.T) {
	identity, err := GenerateIdentity("drolu/reactorpro")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	agent := NewAgent(DefaultConfig(), identity, nil)
	request := &Envelope{
		From:   "peer",
		TaskID: "task-1",
		Trace:  &Trace{TraceID: "trace-1", SpanID: "span-1"},
	}
	reply := agent.replyEnvelope(request)
	if reply.To != "peer" || reply.TaskID != "task-1" || reply.Trace == nil || reply.Trace.TraceID != "trace-1" {
		t.Fatalf("reply correlation = %+v", reply)
	}
	if reply.Type != TypeRespond {
		t.Fatalf("reply type = %q", reply.Type)
	}
	if err := VerifyEnvelope(reply); err != nil {
		t.Fatalf("reply must be signed: %v", err)
	}
}

func TestAgentIDPrefersIdentity(t *testing.T) {
	identity, err := GenerateIdentity("drolu/reactorpro")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	config := DefaultConfig()
	config.AgentID = "configured-but-wrong"
	agent := NewAgent(config, identity, nil)
	if agent.AgentID() != "drolu/reactorpro" {
		t.Fatalf("agent id = %q, want the identity's id", agent.AgentID())
	}
}

func TestReputationScoringAndClamp(t *testing.T) {
	config := DefaultReputationConfig()
	store := NewReputationStore(config)

	if got := store.Score("unknown"); got != config.InitialScore {
		t.Fatalf("unknown agent score = %v, want %v", got, config.InitialScore)
	}

	store.RecordSuccess("peer")
	if got := store.Score("peer"); got <= config.InitialScore {
		t.Fatalf("a success must raise the score, got %v", got)
	}

	// Many failures must clamp at MinScore, never go negative.
	for i := 0; i < 100; i++ {
		store.RecordFailure("bad")
	}
	if got := store.Score("bad"); got != config.MinScore {
		t.Fatalf("score = %v, want the minimum %v", got, config.MinScore)
	}

	for i := 0; i < 100; i++ {
		store.RecordSuccess("great")
	}
	if got := store.Score("great"); got != config.MaxScore {
		t.Fatalf("score = %v, want the maximum %v", got, config.MaxScore)
	}
}

func TestReputationSnapshotIsOrderedBestFirst(t *testing.T) {
	store := NewReputationStore(DefaultReputationConfig())
	store.RecordFailure("worse")
	store.RecordSuccess("better")
	snapshot := store.Snapshot()
	if len(snapshot) != 2 {
		t.Fatalf("snapshot size = %d", len(snapshot))
	}
	if snapshot[0].AgentID != "better" {
		t.Fatalf("snapshot order = %v, want the higher score first", snapshot)
	}
}

func TestGovernanceApprovalFlow(t *testing.T) {
	config := DefaultGovernanceConfig()
	config.RequireApprovalFor = []string{"deploy"}
	governor := NewGovernor(config)

	if !governor.RequiresApproval("deploy") {
		t.Fatal("deploy should require approval")
	}
	if governor.RequiresApproval("ping") {
		t.Fatal("ping should not require approval")
	}

	id := governor.Request("me", "peer", "deploy", map[string]any{"env": "prod"})
	if len(governor.Pending()) != 1 {
		t.Fatalf("pending = %d, want 1", len(governor.Pending()))
	}
	go func() {
		time.Sleep(10 * time.Millisecond)
		if err := governor.Approve(id, "operator", "looks fine"); err != nil {
			t.Errorf("Approve: %v", err)
		}
	}()
	approval, err := governor.Wait(id)
	if err != nil {
		t.Fatalf("Wait after approval: %v", err)
	}
	if approval.Status != StatusApproved || approval.DecidedBy != "operator" {
		t.Fatalf("approval = %+v", approval)
	}
	if len(governor.Pending()) != 0 {
		t.Fatal("a decided approval must leave the pending set")
	}
	if len(governor.History()) != 1 {
		t.Fatal("a decided approval must appear in history")
	}
}

func TestGovernanceDenyReturnsError(t *testing.T) {
	config := DefaultGovernanceConfig()
	governor := NewGovernor(config)
	id := governor.Request("me", "peer", "deploy", nil)
	go func() {
		time.Sleep(10 * time.Millisecond)
		if err := governor.Deny(id, "operator", "not now"); err != nil {
			t.Errorf("Deny: %v", err)
		}
	}()
	if _, err := governor.Wait(id); !errors.Is(err, ErrApprovalDenied) {
		t.Fatalf("err = %v, want ErrApprovalDenied", err)
	}
}

func TestGovernanceTimeoutExpires(t *testing.T) {
	config := DefaultGovernanceConfig()
	config.ApprovalTimeout = 20 * time.Millisecond
	governor := NewGovernor(config)
	id := governor.Request("me", "peer", "deploy", nil)
	if _, err := governor.Wait(id); !errors.Is(err, ErrApprovalExpired) {
		t.Fatalf("err = %v, want ErrApprovalExpired", err)
	}
}

func TestGovernanceCannotDecideTwice(t *testing.T) {
	governor := NewGovernor(DefaultGovernanceConfig())
	id := governor.Request("me", "peer", "deploy", nil)
	if err := governor.Approve(id, "operator", ""); err != nil {
		t.Fatalf("first Approve: %v", err)
	}
	if err := governor.Approve(id, "operator", ""); err == nil {
		t.Fatal("a second decision must be rejected")
	}
	if err := governor.Deny("missing", "operator", ""); err == nil {
		t.Fatal("an unknown approval id must be rejected")
	}
}

func TestGovernanceDisabledNeverGates(t *testing.T) {
	config := DefaultGovernanceConfig()
	config.Enabled = false
	config.RequireApprovalFor = []string{"deploy"}
	governor := NewGovernor(config)
	if governor.RequiresApproval("deploy") {
		t.Fatal("a disabled governor must not gate anything")
	}
}

// The manager must be inert until it is both enabled and configured: the
// shipping default connects nowhere.
func TestManagerDisabledConnectNothing(t *testing.T) {
	manager := NewManager(DefaultConfig(), nil)
	if err := manager.Start(context.Background()); err != nil {
		t.Fatalf("disabled Start must not error: %v", err)
	}
	status := manager.Status()
	if status.Connected {
		t.Fatal("a disabled bridge must not report a connection")
	}
	if status.Enabled {
		t.Fatal("the default configuration must be disabled")
	}
	if _, err := manager.Discover(context.Background(), DiscoverFilter{}); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("err = %v, want ErrNotConnected", err)
	}
}

func TestManagerEnabledWithoutURLFails(t *testing.T) {
	config := DefaultConfig()
	config.Enabled = true
	manager := NewManager(config, nil)
	if err := manager.Start(context.Background()); err == nil {
		t.Fatal("expected Start to fail without a NATS URL")
	}
	if manager.Status().LastError == "" {
		t.Fatal("expected the failure to be recorded in status")
	}
}

func TestManagerApproveDecisions(t *testing.T) {
	manager := NewManager(DefaultConfig(), nil)
	id := manager.RequestApproval("peer", "deploy", nil)
	if err := manager.Approve(id, "operator", "maybe", ""); err == nil {
		t.Fatal("an unknown decision verb must be rejected")
	}
	if err := manager.Approve(id, "operator", "approve", "ok"); err != nil {
		t.Fatalf("Approve: %v", err)
	}
}

func TestNormalizeEventSubject(t *testing.T) {
	cases := map[string]string{
		"":             SubjectEventWildcard,
		"deploy.done":  "mesh.event.deploy.done",
		"mesh.event.x": "mesh.event.x",
	}
	for input, want := range cases {
		if got := normalizeEventSubject(input); got != want {
			t.Fatalf("normalizeEventSubject(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestHealthReportsDisabledState(t *testing.T) {
	manager := NewManager(DefaultConfig(), nil)
	health := manager.Health()
	if health["enabled"] != false {
		t.Fatalf("health = %+v", health)
	}
	if health["connected"] != false {
		t.Fatalf("health = %+v", health)
	}
}
