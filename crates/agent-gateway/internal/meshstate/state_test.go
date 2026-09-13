package meshstate

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/db"
	"github.com/liveagent/agent-gateway/internal/mesh"
)

// newTestStore opens a real SQLite database in a temp directory, so the SQL is
// exercised rather than mocked.
func newTestStore(t *testing.T) *Store {
	t.Helper()
	database, err := db.Open(filepath.Join(t.TempDir(), "mesh-state.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	store, err := NewStore(database)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return store
}

func TestNewStoreRequiresADatabase(t *testing.T) {
	if _, err := NewStore(nil); err == nil {
		t.Fatal("a nil database must be refused rather than panicking later")
	}
}

func TestTrustPinRoundTrip(t *testing.T) {
	store := newTestStore(t)

	if pins, err := store.LoadTrustPins(); err != nil || len(pins) != 0 {
		t.Fatalf("fresh store: pins=%v err=%v, want empty", pins, err)
	}

	pin := mesh.PeerPin{AgentID: "acme/lagos/edge-1", Fingerprint: "sha256:aaaa1111"}
	if err := store.SaveTrustPin(pin); err != nil {
		t.Fatalf("SaveTrustPin: %v", err)
	}
	if err := store.SaveTrustPin(mesh.PeerPin{AgentID: "globex/berlin/edge-1", Fingerprint: "sha256:bbbb2222"}); err != nil {
		t.Fatalf("SaveTrustPin: %v", err)
	}

	pins, err := store.LoadTrustPins()
	if err != nil {
		t.Fatalf("LoadTrustPins: %v", err)
	}
	if len(pins) != 2 {
		t.Fatalf("pins = %v, want 2", pins)
	}
	// Ordered by agent id, so the result is stable rather than map-random.
	if pins[0].AgentID != "acme/lagos/edge-1" || pins[0].Fingerprint != "sha256:aaaa1111" {
		t.Fatalf("pins[0] = %+v, want the acme pin", pins[0])
	}
}

// A pin is evidence: re-observing the same binding must not rewrite when it was
// first seen, or its age becomes meaningless.
func TestTrustPinKeepsFirstSeenAndUpdatesOnChange(t *testing.T) {
	store := newTestStore(t)
	pin := mesh.PeerPin{AgentID: "acme/lagos/edge-1", Fingerprint: "sha256:aaaa1111"}

	if err := store.SaveTrustPin(pin); err != nil {
		t.Fatalf("SaveTrustPin: %v", err)
	}
	var firstSeen string
	if err := store.pool.QueryRow(
		`SELECT first_seen FROM mesh_trust_pins WHERE agent_id = ?`, pin.AgentID).Scan(&firstSeen); err != nil {
		t.Fatalf("read first_seen: %v", err)
	}

	time.Sleep(5 * time.Millisecond)
	if err := store.SaveTrustPin(pin); err != nil {
		t.Fatalf("re-save: %v", err)
	}
	var afterRepeat string
	if err := store.pool.QueryRow(
		`SELECT first_seen FROM mesh_trust_pins WHERE agent_id = ?`, pin.AgentID).Scan(&afterRepeat); err != nil {
		t.Fatalf("read first_seen: %v", err)
	}
	if afterRepeat != firstSeen {
		t.Fatalf("first_seen changed on re-observation: %q -> %q", firstSeen, afterRepeat)
	}

	// A genuinely different fingerprint is the impersonation signal; it must land.
	rotated := mesh.PeerPin{AgentID: pin.AgentID, Fingerprint: "sha256:cccc3333"}
	if err := store.SaveTrustPin(rotated); err != nil {
		t.Fatalf("rotated save: %v", err)
	}
	pins, err := store.LoadTrustPins()
	if err != nil || len(pins) != 1 {
		t.Fatalf("pins=%v err=%v, want exactly one row", pins, err)
	}
	if pins[0].Fingerprint != "sha256:cccc3333" {
		t.Fatalf("fingerprint = %q, want the rotated value", pins[0].Fingerprint)
	}
}

func TestTrustPinRejectsIncompletePins(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveTrustPin(mesh.PeerPin{AgentID: "acme/edge-1"}); err == nil {
		t.Fatal("a pin without a fingerprint must be refused")
	}
	if err := store.SaveTrustPin(mesh.PeerPin{Fingerprint: "sha256:aaaa"}); err == nil {
		t.Fatal("a pin without an agent id must be refused")
	}
}

func TestReputationRoundTrip(t *testing.T) {
	store := newTestStore(t)
	updated := time.Now().UTC().Truncate(time.Microsecond)

	record := mesh.Reputation{
		AgentID:   "acme/lagos/edge-1",
		Score:     72.5,
		Successes: 11,
		Failures:  3,
		UpdatedAt: updated,
	}
	if err := store.SaveReputation(record); err != nil {
		t.Fatalf("SaveReputation: %v", err)
	}

	records, err := store.LoadReputation()
	if err != nil || len(records) != 1 {
		t.Fatalf("records=%v err=%v, want 1", records, err)
	}
	got := records[0]
	if got.AgentID != record.AgentID || got.Score != record.Score ||
		got.Successes != record.Successes || got.Failures != record.Failures {
		t.Fatalf("record = %+v, want %+v", got, record)
	}
	// The decay clock depends on this surviving the round trip.
	if !got.UpdatedAt.Equal(updated) {
		t.Fatalf("UpdatedAt = %v, want %v", got.UpdatedAt, updated)
	}

	// A second write for the same agent updates rather than duplicating.
	record.Score = 40
	record.Failures = 4
	if err := store.SaveReputation(record); err != nil {
		t.Fatalf("re-save: %v", err)
	}
	records, _ = store.LoadReputation()
	if len(records) != 1 || records[0].Score != 40 || records[0].Failures != 4 {
		t.Fatalf("records = %+v, want one updated row", records)
	}
}

func TestApprovalRoundTripAndBound(t *testing.T) {
	store := newTestStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	decided := now.Add(time.Second)

	approval := mesh.Approval{
		ID:          "appr-1",
		Requester:   "acme/lagos/edge-1",
		Target:      "globex/berlin/edge-1",
		Skill:       "invoke",
		Input:       map[string]any{"prompt": "ship it"},
		Status:      mesh.StatusApproved,
		DecidedBy:   "operator",
		Reason:      "looks right",
		RequestedAt: now,
		DecidedAt:   &decided,
	}
	if err := store.SaveApproval(approval, 10); err != nil {
		t.Fatalf("SaveApproval: %v", err)
	}

	loaded, err := store.LoadApprovals(10)
	if err != nil || len(loaded) != 1 {
		t.Fatalf("loaded=%v err=%v, want 1", loaded, err)
	}
	got := loaded[0]
	if got.ID != approval.ID || got.Status != approval.Status || got.DecidedBy != approval.DecidedBy {
		t.Fatalf("approval = %+v, want %+v", got, approval)
	}
	if got.DecidedAt == nil || !got.DecidedAt.Equal(decided) {
		t.Fatalf("DecidedAt = %v, want %v", got.DecidedAt, decided)
	}
	// The arguments are worth keeping: an audit trail that omits what was
	// approved is not much of a trail.
	input, ok := got.Input.(map[string]any)
	if !ok || input["prompt"] != "ship it" {
		t.Fatalf("Input = %#v, want the stored arguments", got.Input)
	}
}

// The bound is the point of this phase: without it the table grows for the life
// of the deployment.
func TestApprovalHistoryIsBoundedOnDisk(t *testing.T) {
	store := newTestStore(t)
	base := time.Now().UTC().Add(-time.Hour)

	const keep = 3
	for i := 0; i < 10; i++ {
		requested := base.Add(time.Duration(i) * time.Minute)
		decided := requested.Add(time.Second)
		approval := mesh.Approval{
			ID:          "appr-" + string(rune('a'+i)),
			Requester:   "acme/lagos/edge-1",
			Target:      "globex/berlin/edge-1",
			Skill:       "invoke",
			Status:      mesh.StatusApproved,
			RequestedAt: requested,
			DecidedAt:   &decided,
		}
		if err := store.SaveApproval(approval, keep); err != nil {
			t.Fatalf("SaveApproval %d: %v", i, err)
		}
	}

	var rows int
	if err := store.pool.QueryRow(`SELECT COUNT(*) FROM mesh_approvals`).Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if rows != keep {
		t.Fatalf("stored rows = %d, want %d", rows, keep)
	}

	// Newest first, and the survivors are the most recent ones.
	loaded, err := store.LoadApprovals(0)
	if err != nil {
		t.Fatalf("LoadApprovals: %v", err)
	}
	if len(loaded) != keep {
		t.Fatalf("loaded = %d, want %d", len(loaded), keep)
	}
	if loaded[0].ID != "appr-j" {
		t.Fatalf("newest = %q, want appr-j", loaded[0].ID)
	}
	for i := 1; i < len(loaded); i++ {
		if loaded[i].RequestedAt.After(loaded[i-1].RequestedAt) {
			t.Fatalf("not newest-first: %v after %v", loaded[i].RequestedAt, loaded[i-1].RequestedAt)
		}
	}
}

func TestLoadApprovalsHonoursLimit(t *testing.T) {
	store := newTestStore(t)
	base := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < 5; i++ {
		requested := base.Add(time.Duration(i) * time.Minute)
		approval := mesh.Approval{
			ID: "appr-" + string(rune('a'+i)), Requester: "r", Target: "t",
			Skill: "invoke", Status: mesh.StatusApproved, RequestedAt: requested,
		}
		if err := store.SaveApproval(approval, 0); err != nil {
			t.Fatalf("SaveApproval: %v", err)
		}
	}
	loaded, err := store.LoadApprovals(2)
	if err != nil {
		t.Fatalf("LoadApprovals: %v", err)
	}
	if len(loaded) != 2 {
		t.Fatalf("loaded = %d, want 2", len(loaded))
	}
}

// A negative keep means "no bound" — the explicit opt-out.
func TestApprovalBoundCanBeDisabled(t *testing.T) {
	store := newTestStore(t)
	base := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < 5; i++ {
		requested := base.Add(time.Duration(i) * time.Minute)
		if err := store.SaveApproval(mesh.Approval{
			ID: "appr-" + string(rune('a'+i)), Requester: "r", Target: "t",
			Skill: "invoke", Status: mesh.StatusApproved, RequestedAt: requested,
		}, -1); err != nil {
			t.Fatalf("SaveApproval: %v", err)
		}
	}
	var rows int
	if err := store.pool.QueryRow(`SELECT COUNT(*) FROM mesh_approvals`).Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if rows != 5 {
		t.Fatalf("stored rows = %d, want all 5 kept", rows)
	}
}

func TestSaveApprovalRejectsMissingID(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveApproval(mesh.Approval{Requester: "r"}, 10); err == nil {
		t.Fatal("an approval without an id must be refused")
	}
}
