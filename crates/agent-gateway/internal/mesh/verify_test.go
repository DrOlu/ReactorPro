package mesh

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestErrorCodesMatchSpec pins the wire codes to the Synapse protocol table.
// These values cross a process boundary, so a silent change would be a breaking
// protocol change that no compiler catches.
func TestErrorCodesMatchSpec(t *testing.T) {
	spec := map[string]struct {
		code      int
		retryable bool
	}{
		"INVALID_ENVELOPE":  {CodeInvalidEnvelope, false},
		"INVALID_MANIFEST":  {CodeInvalidManifest, false},
		"SKILL_NOT_FOUND":   {CodeSkillNotFound, false},
		"AGENT_UNAVAILABLE": {CodeAgentUnavailable, true},
		"IDENTITY_MISMATCH": {CodeIdentityMismatch, false},
		"OVERLOADED":        {CodeOverloaded, true},
		"RATE_LIMITED":      {CodeRateLimited, true},
		"GOVERNANCE_DENIED": {CodeGovernanceDenied, false},
		"APPROVAL_REQUIRED": {CodeApprovalRequired, true},
		"INTERNAL_ERROR":    {CodeInternalError, true},
	}
	want := map[string]int{
		"INVALID_ENVELOPE":  2001,
		"INVALID_MANIFEST":  2002,
		"SKILL_NOT_FOUND":   3001,
		"AGENT_UNAVAILABLE": 3002,
		"IDENTITY_MISMATCH": 3004,
		"OVERLOADED":        4001,
		"RATE_LIMITED":      4002,
		"GOVERNANCE_DENIED": 4003,
		"APPROVAL_REQUIRED": 4004,
		"INTERNAL_ERROR":    5001,
	}
	for name, entry := range spec {
		if entry.code != want[name] {
			t.Errorf("%s = %d, want %d", name, entry.code, want[name])
		}
		if got := retryableCode(entry.code); got != entry.retryable {
			t.Errorf("retryableCode(%s) = %v, want %v", name, got, entry.retryable)
		}
	}
}

// signedRequest builds a request envelope signed by identity.
func signedRequest(t *testing.T, identity *Identity, to string) *Envelope {
	t.Helper()
	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeRequest,
		TS:      timestamp(),
		From:    identity.AgentID,
		To:      to,
		Payload: json.RawMessage(`{"skill":"ping"}`),
	}
	if err := identity.Sign(envelope); err != nil {
		t.Fatalf("sign: %v", err)
	}
	return envelope
}

func newTestGuard(t *testing.T, mutate func(*Config)) (*inboundGuard, *Identity) {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = "nats://127.0.0.1:4222"
	cfg.AgentID = "drolu/reactorpro"
	if mutate != nil {
		mutate(&cfg)
	}
	identity, err := GenerateIdentity("drolu/reactorpro")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	return newInboundGuard(cfg, cfg.AgentID, nil), identity
}

// TestVerifyModeMatrix is the core table: what each mode does with a signed,
// tampered, and unsigned envelope.
func TestVerifyModeMatrix(t *testing.T) {
	cases := []struct {
		mode      string
		state     string
		wantError bool
	}{
		{VerifyOff, "signed", false},
		{VerifyOff, "unsigned", false},
		{VerifyOff, "tampered", false}, // off means off: signing is not consulted

		{VerifyPrefer, "signed", false},
		{VerifyPrefer, "unsigned", false}, // the whole point of prefer
		{VerifyPrefer, "tampered", true},

		{VerifyRequire, "signed", false},
		{VerifyRequire, "unsigned", true},
		{VerifyRequire, "tampered", true},
	}

	for _, testCase := range cases {
		t.Run(testCase.mode+"/"+testCase.state, func(t *testing.T) {
			guard, identity := newTestGuard(t, func(cfg *Config) {
				cfg.VerifyMode = testCase.mode
				cfg.TrustOnFirstUse = true
			})
			envelope := signedRequest(t, identity, guard.agentID)

			switch testCase.state {
			case "unsigned":
				envelope.Signature = ""
				envelope.PublicKey = ""
				envelope.Fingerprint = ""
			case "tampered":
				// Change a covered field after signing.
				envelope.Payload = json.RawMessage(`{"skill":"deploy"}`)
			}

			rejection := guard.check(envelope)
			if testCase.wantError && rejection == nil {
				t.Fatal("expected a rejection")
			}
			if !testCase.wantError && rejection != nil {
				t.Fatalf("unexpected rejection: %s", rejection.reason)
			}
		})
	}
}

// A signature proves the sender holds a key, not that the key belongs to the
// agent named in From. This is the check that closes that hole.
//
// The scenario is an attacker signing an envelope that claims to be a different
// agent: the signature is genuinely valid, over the attacker's own fingerprint,
// so only comparing that fingerprint against the claimed sender catches it.
// (Mutating From *after* signing would not test this — it would invalidate the
// signature first and fail for the wrong reason.)
func TestFingerprintBindsKeyToSender(t *testing.T) {
	guard, _ := newTestGuard(t, nil)

	attacker, err := GenerateIdentity("attacker")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeRequest,
		TS:      timestamp(),
		From:    guard.agentID, // claiming to be us
		To:      guard.agentID,
		Payload: json.RawMessage(`{"skill":"deploy"}`),
	}
	// Sign sets Fingerprint from the attacker's own identity, and covers it.
	if err := attacker.Sign(envelope); err != nil {
		t.Fatalf("sign: %v", err)
	}
	if envelope.Fingerprint == FingerprintFor(guard.agentID, attacker.PublicKey()) {
		t.Fatal("test setup is wrong: the fingerprints should differ")
	}

	if err := VerifyEnvelope(envelope); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("err = %v, want ErrIdentityMismatch", err)
	}

	// And the guard surfaces it as an identity failure, not a generic one.
	rejection := guard.check(envelope)
	if rejection == nil || rejection.code != CodeIdentityMismatch {
		t.Fatalf("rejection = %+v, want code %d", rejection, CodeIdentityMismatch)
	}
}

func TestVerifyEnvelopeRejectsTamperedFields(t *testing.T) {
	_, identity := newTestGuard(t, nil)

	// Every field the signature covers must break verification when changed.
	mutations := map[string]func(*Envelope){
		"version":     func(e *Envelope) { e.Version = "9.9.9" },
		"id":          func(e *Envelope) { e.ID = "other-id" },
		"type":        func(e *Envelope) { e.Type = TypeEmit },
		"ts":          func(e *Envelope) { e.TS = "2000-01-01T00:00:00Z" },
		"from":        func(e *Envelope) { e.From = "other" },
		"to":          func(e *Envelope) { e.To = "other" },
		"task_id":     func(e *Envelope) { e.TaskID = "other" },
		"in_reply_to": func(e *Envelope) { e.InReplyTo = "other" },
		"fingerprint": func(e *Envelope) { e.Fingerprint = "sha256:0000000000000000" },
		"trace":       func(e *Envelope) { e.Trace = &Trace{TraceID: "x", SpanID: "y"} },
		"error":       func(e *Envelope) { e.Error = &Error{Code: CodeInternalError, Message: "x"} },
		"payload":     func(e *Envelope) { e.Payload = json.RawMessage(`{"skill":"other"}`) },
	}

	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			envelope := signedRequest(t, identity, "target")
			envelope.Trace = &Trace{TraceID: "trace", SpanID: "span"}
			if err := identity.Sign(envelope); err != nil {
				t.Fatalf("re-sign: %v", err)
			}
			mutate(envelope)
			if err := VerifyEnvelope(envelope); err == nil {
				t.Fatalf("tampering with %s did not invalidate the signature", name)
			}
		})
	}
}

func TestClockSkewWindow(t *testing.T) {
	guard, identity := newTestGuard(t, func(cfg *Config) {
		cfg.VerifyMode = VerifyOff
		cfg.ClockSkew = 2 * time.Minute
	})

	fresh := signedRequest(t, identity, guard.agentID)
	if rejection := guard.check(fresh); rejection != nil {
		t.Fatalf("fresh envelope rejected: %s", rejection.reason)
	}

	for _, testCase := range []struct {
		name    string
		offset  time.Duration
		refused bool
	}{
		{"inside window", time.Minute, false},
		{"outside window", 10 * time.Minute, true},
		{"far future", -10 * time.Minute, true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			envelope := signedRequest(t, identity, guard.agentID)
			envelope.TS = time.Now().UTC().Add(-testCase.offset).Format(time.RFC3339Nano)
			rejection := guard.check(envelope)
			if testCase.refused && rejection == nil {
				t.Fatal("expected a rejection")
			}
			if !testCase.refused && rejection != nil {
				t.Fatalf("unexpected rejection: %s", rejection.reason)
			}
		})
	}
}

func TestReplayCacheRejectsDuplicate(t *testing.T) {
	cache := newReplayCache(8, time.Minute)
	if !cache.observe("a") {
		t.Fatal("first sighting must be accepted")
	}
	if cache.observe("a") {
		t.Fatal("second sighting must be rejected as a replay")
	}
	if !cache.observe("b") {
		t.Fatal("a different id must be accepted")
	}
}

func TestReplayCacheIsBoundedAndEvictsOldest(t *testing.T) {
	const capacity = 4
	cache := newReplayCache(capacity, time.Hour)
	for i := 0; i < 100; i++ {
		cache.observe(string(rune('a'+i%26)) + newID())
	}
	if got := len(cache.seen); got > capacity {
		t.Fatalf("cache holds %d entries, want at most %d", got, capacity)
	}

	// Insertion-order eviction: the oldest entry is gone, the newest remains.
	evicting := newReplayCache(2, time.Hour)
	evicting.observe("first")
	evicting.observe("second")
	evicting.observe("third") // should evict "first"
	if !evicting.observe("first") {
		t.Fatal("the oldest entry should have been evicted, allowing reuse")
	}
}

func TestSenderLimiterBurstsThenThrottlesAndRecovers(t *testing.T) {
	limiter := newSenderLimiter(RateLimitConfig{Enabled: true, PerSecond: 10, Burst: 3}, 16)

	for i := 0; i < 3; i++ {
		if !limiter.allow("peer") {
			t.Fatalf("burst message %d should be allowed", i)
		}
	}
	if limiter.allow("peer") {
		t.Fatal("the message after the burst should be throttled")
	}
	// Another sender has its own bucket.
	if !limiter.allow("other") {
		t.Fatal("a different sender must not inherit the first sender's exhaustion")
	}

	// Advance the clock rather than sleeping, so the test is deterministic.
	base := limiter.now()
	limiter.now = func() time.Time { return base.Add(200 * time.Millisecond) }
	if !limiter.allow("peer") {
		t.Fatal("the bucket should have refilled")
	}
}

func TestSenderLimiterPopulationIsBounded(t *testing.T) {
	const max = 8
	limiter := newSenderLimiter(RateLimitConfig{Enabled: true, PerSecond: 1, Burst: 1}, max)

	allowed := 0
	for i := 0; i < 100; i++ {
		if limiter.allow(newID()) { // every sender is distinct
			allowed++
		}
	}
	if got := limiter.size(); got > max {
		t.Fatalf("tracked %d senders, want at most %d", got, max)
	}
	if allowed > max {
		t.Fatalf("admitted %d unknown senders past a cap of %d: the limiter did not fail closed", allowed, max)
	}
}

func TestTrustStoreLearnsThenPins(t *testing.T) {
	store := newTrustStore(DefaultConfig())

	if err := store.allow("peer", "sha256:aaaa"); err != nil {
		t.Fatalf("first contact should be learned: %v", err)
	}
	if err := store.allow("peer", "sha256:aaaa"); err != nil {
		t.Fatalf("the same identity should keep working: %v", err)
	}
	// The identity changed under a name we already know.
	if err := store.allow("peer", "sha256:bbbb"); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("err = %v, want ErrIdentityMismatch", err)
	}
	if err := store.allow("", "sha256:aaaa"); err == nil {
		t.Fatal("an envelope with no sender must be refused")
	}
	if err := store.allow("peer", ""); !errors.Is(err, ErrPeerNotTrusted) {
		t.Fatalf("err = %v, want ErrPeerNotTrusted", err)
	}
}

func TestTrustStoreStrictModeRefusesUnknownPeers(t *testing.T) {
	cfg := DefaultConfig()
	cfg.TrustOnFirstUse = false
	cfg.TrustedPeers = []string{"sha256:trusted"}
	store := newTrustStore(cfg)

	if err := store.allow("stranger", "sha256:unknown"); !errors.Is(err, ErrPeerNotTrusted) {
		t.Fatalf("err = %v, want ErrPeerNotTrusted", err)
	}
	if err := store.allow("known", "sha256:trusted"); err != nil {
		t.Fatalf("a configured fingerprint must be accepted: %v", err)
	}
	if len(store.peers()) != 1 {
		t.Fatalf("peers = %+v, want the configured peer recorded", store.peers())
	}
}

func TestConfigRejectsUnknownVerifyMode(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = "nats://localhost:4222"
	cfg.VerifyMode = "requre" // typo
	if err := cfg.Validate(); err == nil {
		t.Fatal("an unrecognised verify mode must be rejected, not silently downgraded")
	}
}

func TestConfigRejectsStrictModeWithoutPeers(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = "nats://localhost:4222"
	cfg.TrustOnFirstUse = false
	cfg.TrustedPeers = nil
	if err := cfg.Validate(); err == nil {
		t.Fatal("strict trust with no pinned peers would authenticate nobody")
	}
}

func TestConfigRejectsMalformedTrustedPeer(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = "nats://localhost:4222"
	cfg.TrustedPeers = []string{"not-a-fingerprint"}
	if err := cfg.Validate(); err == nil {
		t.Fatal("a trusted peer that is not a fingerprint must be rejected")
	}
}

func TestGuardRejectsOversizedEnvelope(t *testing.T) {
	guard, _ := newTestGuard(t, func(cfg *Config) {
		cfg.MaxEnvelopeBytes = 64
	})
	if rejection := guard.checkBytes(65); rejection == nil {
		t.Fatal("expected an oversized envelope to be refused")
	}
	if rejection := guard.checkBytes(64); rejection != nil {
		t.Fatal("an envelope exactly at the limit must be accepted")
	}
}

func TestGuardRejectsWrongAddresseeAndVersion(t *testing.T) {
	guard, identity := newTestGuard(t, func(cfg *Config) {
		cfg.VerifyMode = VerifyOff
	})

	wrongTo := signedRequest(t, identity, "somebody/else")
	if rejection := guard.check(wrongTo); rejection == nil {
		t.Fatal("an envelope addressed to another agent must not be served")
	}

	wrongVersion := signedRequest(t, identity, guard.agentID)
	wrongVersion.Version = "9.9.9"
	if rejection := guard.check(wrongVersion); rejection == nil {
		t.Fatal("an incompatible protocol version must be refused")
	}

	// Events carry no addressee; an empty To must still be accepted.
	broadcast := signedRequest(t, identity, "")
	if rejection := guard.check(broadcast); rejection != nil {
		t.Fatalf("a broadcast envelope must be accepted: %s", rejection.reason)
	}
}

// Register and discover envelopes are addressed to SubjectRegistry rather than
// to a named agent, because whoever answers the registry should handle them. An
// addressee check that only accepted our own agent id silently broke discovery
// between two agents — this is the regression guard for that.
func TestGuardAcceptsRegistryAddressedEnvelopes(t *testing.T) {
	guard, identity := newTestGuard(t, func(cfg *Config) {
		cfg.VerifyMode = VerifyOff
	})

	for _, messageType := range []MessageType{TypeRegister, TypeDiscover} {
		t.Run(string(messageType), func(t *testing.T) {
			envelope := signedRequest(t, identity, SubjectRegistry)
			envelope.Type = messageType
			if rejection := guard.check(envelope); rejection != nil {
				t.Fatalf("a registry-addressed %s must be accepted: %s", messageType, rejection.reason)
			}
		})
	}
}

// Start and Stop are documented as safe to call concurrently. Before the
// lifecycle mutex existed, Start assigned the connection without holding the
// field lock, which raced Stop and could panic on a reply during shutdown.
// Run with -race for this test to mean anything.
func TestAgentStartStopIsConcurrencySafe(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = "nats://127.0.0.1:1" // nothing listens; connect fails fast
	cfg.AgentID = "drolu/reactorpro"

	identity, err := GenerateIdentity(cfg.AgentID)
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	agent := NewAgent(cfg, identity, nil)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = agent.Start(t.Context())
			_ = agent.Stop(t.Context())
			_ = agent.Connected()
		}()
	}
	wg.Wait()
}

func TestRejectionReasonIsActionable(t *testing.T) {
	guard, identity := newTestGuard(t, func(cfg *Config) {
		cfg.VerifyMode = VerifyRequire
	})
	envelope := signedRequest(t, identity, guard.agentID)
	envelope.Signature = ""
	envelope.PublicKey = ""

	rejection := guard.check(envelope)
	if rejection == nil {
		t.Fatal("expected a rejection")
	}
	if !strings.Contains(rejection.reason, "unsigned") {
		t.Fatalf("reason %q should name the cause so an operator can act on it", rejection.reason)
	}
}
