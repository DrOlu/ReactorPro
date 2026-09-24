package mesh

// Unit tests for the trust store's TOFU / pinning contract — the gate that
// decides whether a mesh caller may invoke an agent on this edge.

import (
	"errors"
	"testing"
)

func TestTrustOnFirstUseLearnsAndThenEnforcesThePin(t *testing.T) {
	var learned []PeerPin
	store := newTrustStore(Config{TrustOnFirstUse: true})
	store.setPinRecorder(func(pin PeerPin) { learned = append(learned, pin) })

	if err := store.allow("acme/lagos/edge-1", "sha256:aaaa"); err != nil {
		t.Fatalf("first contact should be learned under TOFU: %v", err)
	}
	if len(learned) != 1 || learned[0].AgentID != "acme/lagos/edge-1" {
		t.Fatalf("onLearn must record the new binding, got %v", learned)
	}

	// Same identity again: fine.
	if err := store.allow("acme/lagos/edge-1", "sha256:aaaa"); err != nil {
		t.Fatalf("known peer with the same fingerprint must pass: %v", err)
	}

	// The same name presenting a different key is exactly the signal the
	// trust store exists to catch.
	if err := store.allow("acme/lagos/edge-1", "sha256:bbbb"); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("expected ErrIdentityMismatch, got %v", err)
	}
}

func TestTrustWithoutTOFURejectsUnknownPeers(t *testing.T) {
	store := newTrustStore(Config{TrustOnFirstUse: false})
	if err := store.allow("unknown/peer", "sha256:cccc"); !errors.Is(err, ErrPeerNotTrusted) {
		t.Fatalf("without TOFU an unknown peer must be refused, got %v", err)
	}
}

func TestTrustedPeerFingerprintIsServedEvenWithoutTOFU(t *testing.T) {
	store := newTrustStore(Config{TrustOnFirstUse: false, TrustedPeers: []string{"sha256:dddd"}})
	if err := store.allow("org/edge/pinned", "sha256:dddd"); err != nil {
		t.Fatalf("a pinned fingerprint must be served without TOFU: %v", err)
	}
}

func TestTrustRejectsEmptySenderOrFingerprint(t *testing.T) {
	store := newTrustStore(Config{TrustOnFirstUse: true})
	if err := store.allow("", "sha256:eeee"); err == nil {
		t.Fatal("empty sender must be refused")
	}
	if err := store.allow("some/peer", ""); !errors.Is(err, ErrPeerNotTrusted) {
		t.Fatalf("empty fingerprint must be refused, got %v", err)
	}
}

func TestSeedKeepsExistingPins(t *testing.T) {
	store := newTrustStore(Config{TrustOnFirstUse: true})
	if err := store.allow("org/edge/one", "sha256:1111"); err != nil {
		t.Fatal(err)
	}
	// A persisted seed must not overwrite a binding learned in this session.
	store.seed([]PeerPin{{AgentID: "org/edge/one", Fingerprint: "sha256:9999"}})
	if err := store.allow("org/edge/one", "sha256:1111"); err != nil {
		t.Fatalf("seeded pin must not clobber the live binding: %v", err)
	}
}
