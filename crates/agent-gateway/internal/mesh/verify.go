package mesh

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/liveagent/agent-gateway/internal/observability"
)

// replayCache remembers recently seen envelope ids so a captured message cannot
// be replayed.
//
// Memory has to be bounded — the ids are chosen by the sender — so the cache
// evicts in insertion order once it is full. That is an explicit trade: an
// attacker who can push `capacity` distinct ids within the remaining validity of
// a target envelope can evict that target and replay it. The timestamp window
// below is the backstop, and the per-sender rate limiter is what makes reaching
// that volume costly. Bounded memory that is occasionally imperfect beats
// unbounded memory that is not.
type replayCache struct {
	ttl    time.Duration
	seen   map[string]time.Time
	ring   []string
	cursor int
	now    func() time.Time

	mu sync.Mutex
}

func newReplayCache(capacity int, ttl time.Duration) *replayCache {
	if capacity <= 0 {
		capacity = DefaultMaxSeenIDs
	}
	if ttl <= 0 {
		ttl = 2 * DefaultClockSkew
	}
	return &replayCache{
		ttl:  ttl,
		seen: make(map[string]time.Time, capacity),
		ring: make([]string, capacity),
		now:  func() time.Time { return time.Now().UTC() },
	}
}

// observe records an envelope id, reporting false when it is a replay.
// An empty id is accepted: deduplication is impossible, but the timestamp
// window still bounds how long a message is replayable.
func (c *replayCache) observe(id string) bool {
	if c == nil || id == "" {
		return true
	}
	now := c.now()

	c.mu.Lock()
	defer c.mu.Unlock()

	if seenAt, ok := c.seen[id]; ok && now.Sub(seenAt) <= c.ttl {
		return false
	}
	if evicted := c.ring[c.cursor]; evicted != "" && evicted != id {
		delete(c.seen, evicted)
	}
	c.ring[c.cursor] = id
	c.cursor = (c.cursor + 1) % len(c.ring)
	c.seen[id] = now
	return true
}

// guardRejection is a refusal with the wire code the sender should receive.
type guardRejection struct {
	code   int
	reason string
}

func (e *guardRejection) Error() string { return e.reason }

// inboundGuard applies every inbound policy in one place, so no call path can
// accidentally skip one. Both the request handler and the event subscriber go
// through it.
type inboundGuard struct {
	config  Config
	agentID string
	trust   *trustStore
	replay  *replayCache
	limiter *senderLimiter
	logger  *slog.Logger
}

func newInboundGuard(cfg Config, agentID string, logger *slog.Logger) *inboundGuard {
	if logger == nil {
		logger = slog.Default()
	}
	return &inboundGuard{
		config:  cfg,
		agentID: agentID,
		trust:   newTrustStore(cfg),
		replay:  newReplayCache(cfg.MaxSeenIDs, 2*cfg.ClockSkew),
		limiter: newSenderLimiter(cfg.RateLimit, cfg.MaxSenderStates),
		logger:  logger,
	}
}

// reject builds a rejection, counting it so operators can see refusals without
// instrumenting the mesh themselves.
func (g *inboundGuard) reject(counter *atomic.Int64, wireCode int, reason string, args ...any) *guardRejection {
	counter.Add(1)
	message := fmt.Sprintf(reason, args...)
	g.logger.Warn("mesh inbound refused", "reason", message, "code", wireCode)
	return &guardRejection{code: wireCode, reason: message}
}

// checkBytes enforces the envelope size cap before any decoding happens. It
// returns a rejection the caller drops rather than answers: an oversized payload
// has not been parsed, so there is no verified sender to reply to.
func (g *inboundGuard) checkBytes(size int) *guardRejection {
	if size <= g.config.MaxEnvelopeBytes {
		return nil
	}
	return g.reject(&observability.Usage.MeshOversizedTotal, CodeInvalidEnvelope,
		"envelope of %d bytes exceeds the %d byte limit", size, g.config.MaxEnvelopeBytes)
}

// check applies every policy that needs a decoded envelope, in cheapest-first
// order so a flood is shed before any signature arithmetic runs.
func (g *inboundGuard) check(env *Envelope) *guardRejection {
	if env == nil {
		return g.reject(&observability.Usage.MeshVerifyFailedTotal, CodeInvalidEnvelope, "envelope is empty")
	}

	// 1. Rate limit. Cheapest and protects everything below it.
	if g.config.RateLimit.Enabled && !g.limiter.allow(env.From) {
		return g.reject(&observability.Usage.MeshRateLimitedTotal, CodeRateLimited,
			"rate limit exceeded for sender %q", env.From)
	}

	observability.Usage.MeshInboundTotal.Add(1)

	// 2. Protocol version. A peer speaking a different version may mean
	// something different by the same field.
	if env.Version != ProtocolVersion {
		return g.reject(&observability.Usage.MeshVerifyFailedTotal, CodeInvalidEnvelope,
			"unsupported protocol version %q (this agent speaks %q)", env.Version, ProtocolVersion)
	}

	// 3. Addressee. An empty To is a broadcast (events carry none) and
	// SubjectRegistry means "for whoever answers the registry", which every
	// agent does. Anything else must name us, or we are handling another
	// agent's traffic.
	if env.To != "" && env.To != g.agentID && env.To != SubjectRegistry {
		return g.reject(&observability.Usage.MeshVerifyFailedTotal, CodeInvalidEnvelope,
			"envelope is addressed to %q, not %q", env.To, g.agentID)
	}

	// 4. Timestamp freshness. This bounds how long a captured message stays
	// replayable even if its id has aged out of the replay cache.
	if err := g.checkTimestamp(env); err != nil {
		return err
	}

	// 5. Replay.
	if !g.replay.observe(env.ID) {
		return g.reject(&observability.Usage.MeshReplayRejectedTotal, CodeInvalidEnvelope,
			"envelope %s is a replay", env.ID)
	}

	// 6. Signature and identity binding.
	if err := g.checkSignature(env); err != nil {
		return err
	}

	return nil
}

func (g *inboundGuard) checkTimestamp(env *Envelope) *guardRejection {
	if env.TS == "" {
		return g.reject(&observability.Usage.MeshVerifyFailedTotal, CodeInvalidEnvelope, "envelope has no timestamp")
	}
	sent, err := time.Parse(time.RFC3339Nano, env.TS)
	if err != nil {
		return g.reject(&observability.Usage.MeshVerifyFailedTotal, CodeInvalidEnvelope,
			"envelope timestamp %q is not RFC3339", env.TS)
	}
	drift := time.Since(sent)
	if drift < 0 {
		drift = -drift
	}
	if drift > g.config.ClockSkew {
		return g.reject(&observability.Usage.MeshVerifyFailedTotal, CodeInvalidEnvelope,
			"envelope is %s outside the %s clock skew window", drift.Round(time.Second), g.config.ClockSkew)
	}
	return nil
}

// checkSignature applies the configured verification mode and then the trust
// policy. The order matters: identity is only established once the signature
// verifies, so trust is consulted last and never on an unproven claim.
func (g *inboundGuard) checkSignature(env *Envelope) *guardRejection {
	// Off means identity is not consulted at all. Checking signatures anyway
	// would be worse than useless: a mesh that claims not to verify would start
	// refusing peers whenever a stale or rotated key showed up.
	if g.config.VerifyMode == VerifyOff {
		return nil
	}

	signed := env.Signature != "" && env.PublicKey != ""
	if !signed {
		if g.config.VerifyMode == VerifyRequire {
			return g.reject(&observability.Usage.MeshVerifyFailedTotal, CodeIdentityMismatch,
				"sender %q is unsigned and this mesh requires signed envelopes", env.From)
		}
		// VerifyPrefer accepts unsigned traffic by policy; nothing can be
		// asserted about identity, so trust is not consulted.
		return nil
	}

	if err := VerifyEnvelope(env); err != nil {
		if strings.Contains(err.Error(), ErrIdentityMismatch.Error()) {
			return g.reject(&observability.Usage.MeshTrustMismatchTotal, CodeIdentityMismatch,
				"sender %q presented a signature that does not match its claimed identity", env.From)
		}
		return g.reject(&observability.Usage.MeshVerifyFailedTotal, CodeIdentityMismatch,
			"signature check failed for %q: %v", env.From, err)
	}

	// The key proved a fingerprint for env.From. Compare it against what we have
	// seen from that agent id before.
	fingerprint, err := EnvelopeFingerprint(env)
	if err != nil {
		return g.reject(&observability.Usage.MeshVerifyFailedTotal, CodeIdentityMismatch,
			"could not derive identity for %q: %v", env.From, err)
	}
	if err := g.trust.allow(env.From, fingerprint); err != nil {
		if err == ErrIdentityMismatch {
			return g.reject(&observability.Usage.MeshTrustMismatchTotal, CodeIdentityMismatch,
				"identity of %q changed: presented key proves %s, which is not the pinned identity",
				env.From, fingerprint)
		}
		return g.reject(&observability.Usage.MeshTrustMismatchTotal, CodeIdentityMismatch,
			"identity of %q (%s) is not trusted: %v", env.From, fingerprint, err)
	}
	return nil
}
