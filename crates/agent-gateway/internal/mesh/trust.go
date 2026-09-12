package mesh

import (
	"errors"
	"sort"
	"strings"
	"sync"
)

// ErrPeerNotTrusted is returned when a peer presents a valid identity that the
// local policy does not accept — either it is unknown and trust-on-first-use is
// off, or it presents no identity at all while verification is required.
var ErrPeerNotTrusted = errors.New("mesh peer is not trusted")

// PeerPin is a recorded agent-id-to-fingerprint binding.
type PeerPin struct {
	AgentID     string `json:"agentId"`
	Fingerprint string `json:"fingerprint"`
}

// trustStore records which identity each agent id has presented.
//
// A verified signature on its own proves only that the sender holds the private
// key for the public key carried in the same envelope. Because that key travels
// with the message, anyone can mint a keypair and sign an envelope claiming to
// be a different agent — the signature is valid, and it is valid *for an
// attacker's key*. What closes that hole is remembering which key an agent id
// used the first time and refusing a different one afterwards. That is the whole
// purpose of this type, and the reason the fingerprint is covered by the
// signature in SigningPayload.
//
// Trust-on-first-use is on by default because it needs no coordination between
// operators. Turning it off makes the store strict: only fingerprints listed in
// config may ever be learned, which is the right posture for a closed fleet.
type trustStore struct {
	trustOnFirstUse bool

	mu        sync.RWMutex
	pins      map[string]string // agent id -> fingerprint
	pinnedFPs map[string]struct{}
}

func newTrustStore(cfg Config) *trustStore {
	store := &trustStore{
		trustOnFirstUse: cfg.TrustOnFirstUse,
		pins:            make(map[string]string),
		pinnedFPs:       make(map[string]struct{}),
	}
	for _, fingerprint := range cfg.TrustedPeers {
		if trimmed := strings.TrimSpace(fingerprint); trimmed != "" {
			store.pinnedFPs[trimmed] = struct{}{}
		}
	}
	return store
}

// seed installs previously persisted pins. Used when the store is rehydrated
// from durable storage at start-up; explicit configuration still wins, because
// a configured pin is an operator decision and a stored one is an observation.
func (s *trustStore) seed(pins []PeerPin) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, pin := range pins {
		if pin.AgentID == "" || pin.Fingerprint == "" {
			continue
		}
		if _, configured := s.pinnedFPs[pin.Fingerprint]; configured {
			continue
		}
		if _, exists := s.pins[pin.AgentID]; !exists {
			s.pins[pin.AgentID] = pin.Fingerprint
		}
	}
}

// allow decides whether a peer's proven identity may be served, and records it
// when trust-on-first-use is enabled.
//
// fingerprint is the value the envelope's key actually proves for agentID — as
// returned by EnvelopeFingerprint — never a value the sender merely asserted.
func (s *trustStore) allow(agentID, fingerprint string) error {
	if s == nil {
		return nil
	}
	if agentID == "" {
		return errors.New("mesh envelope has no sender")
	}
	if fingerprint == "" {
		return ErrPeerNotTrusted
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if known, pinned := s.pins[agentID]; pinned {
		if known != fingerprint {
			// The identity changed under a name we already know. This is the
			// signal that matters: either the peer was rebuilt with a new key, or
			// something is speaking as it.
			return ErrIdentityMismatch
		}
		return nil
	}

	if _, trusted := s.pinnedFPs[fingerprint]; trusted {
		s.pins[agentID] = fingerprint
		return nil
	}

	if !s.trustOnFirstUse {
		return ErrPeerNotTrusted
	}

	s.pins[agentID] = fingerprint
	return nil
}

// peers returns the recorded pins, ordered by agent id.
func (s *trustStore) peers() []PeerPin {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]PeerPin, 0, len(s.pins))
	for agentID, fingerprint := range s.pins {
		out = append(out, PeerPin{AgentID: agentID, Fingerprint: fingerprint})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AgentID < out[j].AgentID })
	return out
}
