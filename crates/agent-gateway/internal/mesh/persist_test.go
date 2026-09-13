package mesh

import (
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

// recordingStore is a StateStore that remembers what it was asked to save.
//
// It is deliberately a plain in-memory implementation rather than a mock of the
// interface: the point is to prove that the mesh writes the right things and
// reads them back, not that specific methods were called in a specific order.
type recordingStore struct {
	mu sync.Mutex

	pins       []PeerPin
	reputation []Reputation
	approvals  []Approval

	// saveErr makes every write fail, so the "storage is broken" path can be
	// exercised without a real database.
	saveErr error
	// loadErr makes every read fail.
	loadErr error

	// seeded state returned by the Load* methods.
	storedPins       []PeerPin
	storedReputation []Reputation
	storedApprovals  []Approval
}

func (s *recordingStore) LoadTrustPins() ([]PeerPin, error) {
	if s.loadErr != nil {
		return nil, s.loadErr
	}
	return s.storedPins, nil
}

func (s *recordingStore) SaveTrustPin(pin PeerPin) error {
	if s.saveErr != nil {
		return s.saveErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pins = append(s.pins, pin)
	return nil
}

func (s *recordingStore) LoadReputation() ([]Reputation, error) {
	if s.loadErr != nil {
		return nil, s.loadErr
	}
	return s.storedReputation, nil
}

func (s *recordingStore) SaveReputation(record Reputation) error {
	if s.saveErr != nil {
		return s.saveErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reputation = append(s.reputation, record)
	return nil
}

func (s *recordingStore) LoadApprovals(limit int) ([]Approval, error) {
	if s.loadErr != nil {
		return nil, s.loadErr
	}
	out := s.storedApprovals
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *recordingStore) SaveApproval(approval Approval, keep int) error {
	if s.saveErr != nil {
		return s.saveErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.approvals = append(s.approvals, approval)
	return nil
}

func (s *recordingStore) savedPins() []PeerPin {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]PeerPin(nil), s.pins...)
}

func (s *recordingStore) savedReputation() []Reputation {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Reputation(nil), s.reputation...)
}

func (s *recordingStore) savedApprovals() []Approval {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Approval(nil), s.approvals...)
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// --- trust pins -------------------------------------------------------------

// The security-relevant one: a learned pin must reach storage, or a restart
// re-opens the window where whoever speaks first becomes the pinned identity.
func TestLearnedTrustPinIsPersisted(t *testing.T) {
	cfg := DefaultConfig()
	cfg.TrustOnFirstUse = true
	store := newTrustStore(cfg)

	recorder := &recordingStore{}
	store.setPinRecorder(func(p PeerPin) { _ = recorder.SaveTrustPin(p) })

	if err := store.allow("acme/lagos/edge-1", "sha256:aaaa1111"); err != nil {
		t.Fatalf("allow: %v", err)
	}
	pins := recorder.savedPins()
	if len(pins) != 1 || pins[0].AgentID != "acme/lagos/edge-1" || pins[0].Fingerprint != "sha256:aaaa1111" {
		t.Fatalf("persisted pins = %+v, want the learned binding", pins)
	}

	// Re-observing the same identity is not new information.
	if err := store.allow("acme/lagos/edge-1", "sha256:aaaa1111"); err != nil {
		t.Fatalf("allow repeat: %v", err)
	}
	if got := len(recorder.savedPins()); got != 1 {
		t.Fatalf("persisted %d pins after a repeat, want 1 — re-observing is not a new pin", got)
	}

	// A changed identity must be refused, and must not be written as a new pin.
	if err := store.allow("acme/lagos/edge-1", "sha256:cccc3333"); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("allow changed identity = %v, want ErrIdentityMismatch", err)
	}
	if got := len(recorder.savedPins()); got != 1 {
		t.Fatalf("persisted %d pins after an identity mismatch, want 1", got)
	}
}

// A pin admitted by the configured allowlist is still an observation worth
// keeping: configuration lists fingerprints, never which id owns one.
func TestAllowlistedTrustPinIsPersisted(t *testing.T) {
	cfg := DefaultConfig()
	cfg.TrustOnFirstUse = false
	cfg.TrustedPeers = []string{"sha256:aaaa1111"}
	store := newTrustStore(cfg)

	recorder := &recordingStore{}
	store.setPinRecorder(func(p PeerPin) { _ = recorder.SaveTrustPin(p) })

	if err := store.allow("acme/lagos/edge-1", "sha256:aaaa1111"); err != nil {
		t.Fatalf("allow: %v", err)
	}
	if got := len(recorder.savedPins()); got != 1 {
		t.Fatalf("persisted %d pins, want 1 — the id-to-key binding is learned even when the key is configured", got)
	}

	// An unknown fingerprint with trust-on-first-use off is still refused.
	if err := store.allow("globex/berlin/edge-1", "sha256:dddd4444"); !errors.Is(err, ErrPeerNotTrusted) {
		t.Fatalf("allow unknown = %v, want ErrPeerNotTrusted", err)
	}
	if got := len(recorder.savedPins()); got != 1 {
		t.Fatalf("persisted %d pins after a refusal, want 1", got)
	}
}

// --- reputation -------------------------------------------------------------

func TestReputationChangesArePersisted(t *testing.T) {
	records := &recordingStore{}
	store := NewReputationStore(DefaultReputationConfig())
	store.setRecorder(func(r Reputation) { _ = records.SaveReputation(r) })

	store.RecordSuccess("acme/lagos/edge-1")
	store.RecordFailure("acme/lagos/edge-1")

	saved := records.savedReputation()
	if len(saved) != 2 {
		t.Fatalf("persisted %d records, want one per change", len(saved))
	}
	if saved[0].Successes != 1 || saved[1].Failures != 1 {
		t.Fatalf("saved = %+v, want the success then the failure recorded", saved)
	}
	if saved[1].UpdatedAt.IsZero() {
		t.Fatal("persisted record has no UpdatedAt, so the decay clock cannot survive a restart")
	}
}

func TestReputationRestoreReplacesMemory(t *testing.T) {
	store := NewReputationStore(DefaultReputationConfig())
	store.restore([]Reputation{
		{AgentID: "acme/lagos/edge-1", Score: 0.9, Successes: 9, UpdatedAt: time.Now()},
		{AgentID: "", Score: 0.5}, // skipped: no id
	})

	if got := store.Score("acme/lagos/edge-1"); got < 0.8 {
		t.Fatalf("restored score = %v, want the persisted value, not the initial score", got)
	}
	if got := store.Score("never-seen"); got != DefaultReputationConfig().InitialScore {
		t.Fatalf("unknown agent score = %v, want the initial score", got)
	}

	// A persisted score outside the configured range is clamped, not trusted. A
	// stored value is an input like any other, and the score scale is an invariant
	// the rest of the scoring maths relies on.
	store.restore([]Reputation{{AgentID: "out-of-range", Score: 88, UpdatedAt: time.Now()}})
	config := DefaultReputationConfig()
	if got := store.Score("out-of-range"); got > config.MaxScore {
		t.Fatalf("restored score = %v, want it clamped to MaxScore %v", got, config.MaxScore)
	}
}

// --- approvals --------------------------------------------------------------

func TestApprovalDecisionsArePersisted(t *testing.T) {
	records := &recordingStore{}
	governor := NewGovernor(GovernanceConfig{
		Enabled:            true,
		RequireApprovalFor: []string{"invoke"},
		ApprovalTimeout:    time.Minute,
		MaxHistory:         10,
	})
	governor.setRecorder(func(a Approval) { _ = records.SaveApproval(a, 10) })

	id := governor.Request("acme/lagos/edge-1", "globex/berlin/edge-1", "invoke", map[string]any{"a": 1})
	if err := governor.Approve(id, "operator", "fine"); err != nil {
		t.Fatalf("Approve: %v", err)
	}

	saved := records.savedApprovals()
	if len(saved) != 1 {
		t.Fatalf("persisted %d approvals, want 1", len(saved))
	}
	if saved[0].ID != id || saved[0].Status != StatusApproved || saved[0].DecidedBy != "operator" {
		t.Fatalf("saved approval = %+v", saved[0])
	}
	if saved[0].DecidedAt == nil {
		t.Fatal("persisted approval has no decision time")
	}
}

// The bound, in memory — the other half of which is enforced on disk.
func TestApprovalHistoryIsBoundedInMemory(t *testing.T) {
	governor := NewGovernor(GovernanceConfig{
		Enabled:            true,
		RequireApprovalFor: []string{"invoke"},
		ApprovalTimeout:    time.Minute,
		MaxHistory:         2,
	})

	for i := 0; i < 5; i++ {
		id := governor.Request("acme/lagos/edge-1", "globex/berlin/edge-1", "invoke", nil)
		if err := governor.Approve(id, "operator", "ok"); err != nil {
			t.Fatalf("Approve %d: %v", i, err)
		}
	}

	if got := len(governor.History()); got != 2 {
		t.Fatalf("history = %d entries, want the bound of 2", got)
	}
	if got := len(governor.Pending()); got != 0 {
		t.Fatalf("pending = %d, want 0 after every decision", got)
	}
}

// A zero bound takes the default rather than meaning "unbounded", so a Config
// built from literals cannot grow without limit.
func TestZeroApprovalBoundTakesTheDefault(t *testing.T) {
	governor := NewGovernor(GovernanceConfig{Enabled: true})
	if got := governor.config.MaxHistory; got != DefaultMaxApprovalHistory {
		t.Fatalf("MaxHistory = %d, want the default %d", got, DefaultMaxApprovalHistory)
	}

	unbounded := NewGovernor(GovernanceConfig{Enabled: true, MaxHistory: -1})
	if got := unbounded.config.MaxHistory; got != -1 {
		t.Fatalf("MaxHistory = %d, want the explicit opt-out to be preserved", got)
	}
}

func TestApprovalRestoreKeepsDecidedHistory(t *testing.T) {
	governor := NewGovernor(GovernanceConfig{Enabled: true, MaxHistory: 10})
	decided := time.Now()
	governor.restore([]Approval{
		{ID: "a1", Status: StatusApproved, RequestedAt: decided, DecidedAt: &decided},
		{ID: "", Status: StatusDenied}, // skipped: no id
	})

	history := governor.History()
	if len(history) != 1 || history[0].ID != "a1" {
		t.Fatalf("history = %+v, want the restored decision", history)
	}
	// Pending requests are deliberately not restored: their decision channel died
	// with the previous process, so they could never be answered again.
	if got := len(governor.Pending()); got != 0 {
		t.Fatalf("pending = %d, want 0 — a resurrected pending approval could never settle", got)
	}
}

// --- the seam itself --------------------------------------------------------

func TestRestoreStateRehydratesEverything(t *testing.T) {
	decided := time.Now()
	store := &recordingStore{
		storedPins:       []PeerPin{{AgentID: "globex/berlin/edge-1", Fingerprint: "sha256:bbbb2222"}},
		storedReputation: []Reputation{{AgentID: "globex/berlin/edge-1", Score: 0.9, Successes: 12, UpdatedAt: time.Now()}},
		storedApprovals:  []Approval{{ID: "a1", Status: StatusApproved, RequestedAt: decided, DecidedAt: &decided}},
	}

	cfg := DefaultConfig()
	manager := NewManager(cfg, quietLogger())
	manager.SetStateStore(store)
	agent := NewAgent(cfg, nil, quietLogger())

	manager.restoreState(agent)

	peers := agent.TrustPeers()
	if len(peers) != 1 || peers[0].Fingerprint != "sha256:bbbb2222" {
		t.Fatalf("trust peers = %+v, want the persisted pin restored into the agent", peers)
	}
	if got := manager.Reputation(); len(got) != 1 || got[0].Score < 0.8 {
		t.Fatalf("reputation = %+v, want the persisted record", got)
	}
	if got := manager.ApprovalHistory(); len(got) != 1 || got[0].ID != "a1" {
		t.Fatalf("approval history = %+v, want the persisted decision", got)
	}
}

// Restored state must not be written straight back out.
func TestRestoreDoesNotRewriteState(t *testing.T) {
	store := &recordingStore{
		storedPins: []PeerPin{{AgentID: "globex/berlin/edge-1", Fingerprint: "sha256:bbbb2222"}},
	}
	cfg := DefaultConfig()
	manager := NewManager(cfg, quietLogger())
	manager.SetStateStore(store)
	agent := NewAgent(cfg, nil, quietLogger())

	manager.restoreState(agent)
	manager.wirePersistence(agent)

	if got := len(store.savedPins()); got != 0 {
		t.Fatalf("restore wrote %d pins back, want 0 — seeding is not learning", got)
	}
}

// Storage being broken must not break the mesh. This is the property that keeps
// a disk problem from becoming a connectivity problem.
func TestAFailingStoreDoesNotBreakTheMesh(t *testing.T) {
	store := &recordingStore{saveErr: errors.New("disk on fire"), loadErr: errors.New("disk on fire")}

	cfg := DefaultConfig()
	cfg.TrustOnFirstUse = true
	manager := NewManager(cfg, quietLogger())
	manager.SetStateStore(store)
	agent := NewAgent(cfg, nil, quietLogger())

	// Restore against a failing store must not panic and must leave the mesh able
	// to run; the pins simply stay empty.
	manager.restoreState(agent)
	manager.wirePersistence(agent)

	if err := agent.guard.trust.allow("acme/lagos/edge-1", "sha256:aaaa1111"); err != nil {
		t.Fatalf("verification failed because storage failed: %v", err)
	}
	manager.reputation.RecordSuccess("acme/lagos/edge-1")
	id := manager.governor.Request("acme/lagos/edge-1", "globex/berlin/edge-1", "invoke", nil)
	if err := manager.governor.Approve(id, "operator", "ok"); err != nil {
		t.Fatalf("approval failed because storage failed: %v", err)
	}

	// The in-memory state is correct regardless: persistence is a convenience,
	// never a precondition.
	if got := manager.reputation.Score("acme/lagos/edge-1"); got <= DefaultReputationConfig().InitialScore {
		t.Fatalf("score = %v, want the success to have counted in memory", got)
	}
	if got := len(manager.ApprovalHistory()); got != 1 {
		t.Fatalf("history = %d, want the decision recorded in memory", got)
	}
}

// Running without any store is a supported mode: the mesh behaves exactly as it
// did before persistence existed.
func TestNoStoreMeansNoPersistenceAndNoCallbacks(t *testing.T) {
	cfg := DefaultConfig()
	manager := NewManager(cfg, quietLogger())
	agent := NewAgent(cfg, nil, quietLogger())

	// Must be safe to call with no store installed.
	manager.restoreState(agent)
	manager.wirePersistence(agent)

	if err := agent.guard.trust.allow("acme/lagos/edge-1", "sha256:aaaa1111"); err != nil {
		t.Fatalf("allow: %v", err)
	}
	if got := len(agent.TrustPeers()); got != 1 {
		t.Fatalf("trust peers = %d, want the pin held in memory", got)
	}
	manager.reputation.RecordSuccess("acme/lagos/edge-1")
	if got := len(manager.Reputation()); got != 1 {
		t.Fatalf("reputation = %d, want the score held in memory", got)
	}
}
