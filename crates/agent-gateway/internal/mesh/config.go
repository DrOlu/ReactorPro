package mesh

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nuid"
)

// DefaultAgentID is the identity ReactorPro registers under. It is only a
// default: once the identity file exists, the id it contains wins and cannot be
// reassigned without failing the fingerprint check.
const DefaultAgentID = "drolu/reactorpro"

// Config controls the mesh bridge.
//
// The bridge ships disabled and unconfigured: with Enabled false, or with no
// NATS URL, nothing connects anywhere.
type Config struct {
	Enabled bool `json:"enabled"`

	// Connection
	URL        string `json:"url"`
	Token      string `json:"token"`
	User       string `json:"user"`
	Password   string `json:"password"`
	CredsFile  string `json:"credsFile"`
	NamePrefix string `json:"namePrefix"`

	// Identity
	AgentID      string `json:"agentId"`
	IdentityPath string `json:"identityPath"`

	// Manifest
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Capabilities []string `json:"capabilities"`

	// Timing
	HeartbeatInterval time.Duration `json:"-"`
	// RequestTimeout bounds a skill dispatch waiting for a peer's reply.
	RequestTimeout time.Duration `json:"-"`
	// DiscoveryWindow is how long discovery collects replies. Agents answer
	// discovery individually as well as the registry, so the only way to know
	// every peer has replied is to wait a fixed window — it must be short,
	// because it is also how long the caller waits.
	DiscoveryWindow time.Duration `json:"-"`

	// AcceptedVersions, when non-empty, is the only set of protocol versions
	// inbound envelopes may declare. Empty accepts any version.
	//
	// Enforcing a fixed version by default is wrong for a live mesh: peers in the
	// wild declare "1.0" and "0.3.0" alike, and a version string we do not
	// recognise is not evidence that a peer is incompatible — the envelope shape
	// is what actually matters, and it is validated field by field. Pin this only
	// on a closed fleet, where an unexpected version really is a fault.
	AcceptedVersions []string `json:"acceptedVersions"`

	// Trust controls how inbound envelopes are authenticated. See the Verify*
	// constants; the modes exist so enforcement can be switched on without
	// locking out peers that do not sign yet.
	VerifyMode string `json:"verifyMode"`
	// ClockSkew is how far an envelope's timestamp may drift from local time
	// before it is treated as a replay or a broken clock.
	ClockSkew time.Duration `json:"-"`
	// TrustedPeers pins known peers by fingerprint ("sha256:<hex16>").
	TrustedPeers []string `json:"trustedPeers"`
	// TrustOnFirstUse records a peer's fingerprint on its first verified
	// message. With it off, only TrustedPeers may be served.
	TrustOnFirstUse bool `json:"trustOnFirstUse"`

	// MaxEnvelopeBytes caps a single inbound envelope. Separate from the
	// gateway's -max-message-bytes, which governs the desktop protocol.
	MaxEnvelopeBytes int `json:"maxEnvelopeBytes"`
	// MaxSeenIDs bounds the replay cache.
	MaxSeenIDs int `json:"maxSeenIds"`
	// MaxSenderStates bounds the per-sender rate-limiter map, so a flood from
	// many distinct senders cannot grow memory without limit.
	MaxSenderStates int `json:"maxSenderStates"`
	// RateLimit throttles inbound traffic per sender.
	RateLimit RateLimitConfig `json:"rateLimit"`

	// Extensions
	Reputation ReputationConfig `json:"reputation"`
	Governance GovernanceConfig `json:"governance"`

	// SkillsEnabled exposes the built-in read-only introspection skills
	// (ping, describe, status) so peers can call this agent instead of getting
	// SKILL_NOT_FOUND. On by default: the bridge itself is off by default, so
	// nothing is reachable until the mesh is enabled.
	SkillsEnabled bool `json:"skillsEnabled"`
	// SkillAllowlist, when non-empty, restricts which built-in skills are
	// served. An unknown id is rejected at startup rather than silently
	// disabling a skill the operator expected to be exposed.
	SkillAllowlist []string `json:"skillAllowlist"`

	// Events to subscribe to automatically once connected.
	EventSubscriptions []string `json:"eventSubscriptions"`
}

// servesSkill reports whether a built-in skill may be served. An empty
// allowlist means all of them.
func (c Config) servesSkill(id string) bool {
	if len(c.SkillAllowlist) == 0 {
		return true
	}
	for _, allowed := range c.SkillAllowlist {
		if strings.TrimSpace(allowed) == id {
			return true
		}
	}
	return false
}

// Verification modes for inbound envelopes.
const (
	// VerifyOff accepts any envelope, signed or not. Signing stays decorative.
	VerifyOff = "off"
	// VerifyPrefer verifies envelopes that carry a signature and rejects ones
	// that fail, but still accepts unsigned envelopes. This is the transitional
	// mode: it closes the door on tampering and impersonation for peers that
	// sign, without locking out peers that cannot sign yet.
	VerifyPrefer = "prefer"
	// VerifyRequire rejects any unsigned envelope. Correct for a closed fleet
	// where every peer holds an identity.
	VerifyRequire = "require"
)

// fingerprintPrefix is the only fingerprint shape accepted in TrustedPeers.
const fingerprintPrefix = "sha256:"

// RateLimitConfig throttles inbound mesh traffic per sender.
type RateLimitConfig struct {
	Enabled bool `json:"enabled"`
	// PerSecond is the sustained rate allowed from one sender.
	PerSecond float64 `json:"perSecond"`
	// Burst is how many messages may arrive back to back before the sustained
	// rate applies.
	Burst int `json:"burst"`
}

// Default inbound limits. These are deliberately generous: they exist to stop a
// runaway peer or a hostile flood, not to shape normal traffic.
const (
	DefaultMaxEnvelopeBytes = 1 << 20 // 1 MiB
	DefaultMaxSeenIDs       = 32768
	DefaultMaxSenderStates  = 4096
	DefaultClockSkew        = 5 * time.Minute
)

// DefaultConfig returns a disabled configuration with sensible limits.
func DefaultConfig() Config {
	return Config{
		Enabled:           false,
		AgentID:           DefaultAgentID,
		Name:              "ReactorPro",
		Description:       "ReactorPro desktop agent and gateway",
		Capabilities:      []string{"agent", "reactorpro"},
		HeartbeatInterval: 30 * time.Second,
		RequestTimeout:    120 * time.Second,
		DiscoveryWindow:   2 * time.Second,
		VerifyMode:        VerifyPrefer,
		ClockSkew:         DefaultClockSkew,
		TrustOnFirstUse:   true,
		MaxEnvelopeBytes:  DefaultMaxEnvelopeBytes,
		MaxSeenIDs:        DefaultMaxSeenIDs,
		MaxSenderStates:   DefaultMaxSenderStates,
		RateLimit: RateLimitConfig{
			Enabled:   true,
			PerSecond: 50,
			Burst:     100,
		},
		SkillsEnabled: true,
		Reputation:    DefaultReputationConfig(),
		Governance:    DefaultGovernanceConfig(),
	}
}

// normalize fills unset limits with their defaults. A Config built by literals
// rather than DefaultConfig would otherwise enforce a zero-byte envelope cap and
// refuse all traffic.
func (c *Config) normalize() {
	if c.VerifyMode == "" {
		c.VerifyMode = VerifyPrefer
	}
	if c.ClockSkew <= 0 {
		c.ClockSkew = DefaultClockSkew
	}
	if c.MaxEnvelopeBytes <= 0 {
		c.MaxEnvelopeBytes = DefaultMaxEnvelopeBytes
	}
	if c.MaxSeenIDs <= 0 {
		c.MaxSeenIDs = DefaultMaxSeenIDs
	}
	if c.MaxSenderStates <= 0 {
		c.MaxSenderStates = DefaultMaxSenderStates
	}
	if c.RateLimit.Enabled && (c.RateLimit.PerSecond <= 0 || c.RateLimit.Burst <= 0) {
		c.RateLimit.PerSecond = 50
		c.RateLimit.Burst = 100
	}
}

// Validate reports why the bridge cannot start, or nil when it can.
//
// A disabled bridge is always valid — that is the shipping default.
func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	if strings.TrimSpace(c.URL) == "" {
		return errors.New("mesh is enabled but no NATS URL is configured")
	}
	if strings.TrimSpace(c.AgentID) == "" {
		return errors.New("mesh is enabled but no agent id is configured")
	}
	if c.User != "" && c.Password == "" {
		return errors.New("mesh user is set but the password is empty")
	}
	if c.HeartbeatInterval < 0 {
		return errors.New("mesh heartbeat interval cannot be negative")
	}
	// An unrecognised mode is rejected rather than silently downgraded: a typo
	// like "requre" must not quietly leave the mesh accepting unsigned traffic.
	switch c.VerifyMode {
	case "", VerifyOff, VerifyPrefer, VerifyRequire:
	default:
		return fmt.Errorf("mesh verify mode %q is not one of %q, %q, %q",
			c.VerifyMode, VerifyOff, VerifyPrefer, VerifyRequire)
	}
	if !c.TrustOnFirstUse && len(c.TrustedPeers) == 0 && c.VerifyMode != VerifyOff {
		return errors.New("mesh has trust-on-first-use disabled and no trusted peers configured: " +
			"no peer could ever be authenticated")
	}
	for _, peer := range c.TrustedPeers {
		if !strings.HasPrefix(strings.TrimSpace(peer), fingerprintPrefix) {
			return fmt.Errorf("trusted peer %q is not a fingerprint (expected %s<hex>)", peer, fingerprintPrefix)
		}
	}
	// Reject an unknown skill id rather than silently serving less than the
	// operator asked for: a typo would otherwise look like a skill that simply
	// never answers.
	for _, id := range c.SkillAllowlist {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			continue
		}
		known := false
		for _, builtin := range builtinSkillIDs {
			if builtin == trimmed {
				known = true
				break
			}
		}
		if !known {
			return fmt.Errorf("mesh skill %q is not a built-in skill (known: %s)",
				id, strings.Join(builtinSkillIDs, ", "))
		}
	}
	return nil
}

// natsOptions builds the client options for the configured auth mode.
//
// Precedence mirrors the NATS client conventions: a creds file wins, then
// token, then user/password.
func (c Config) natsOptions() ([]nats.Option, error) {
	options := []nats.Option{
		nats.Name(meshConnectionName(c.NamePrefix)),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2 * time.Second),
	}
	switch {
	case strings.TrimSpace(c.CredsFile) != "":
		options = append(options, nats.UserCredentials(strings.TrimSpace(c.CredsFile)))
	case strings.TrimSpace(c.Token) != "":
		options = append(options, nats.Token(strings.TrimSpace(c.Token)))
	case strings.TrimSpace(c.User) != "":
		options = append(options, nats.UserInfo(strings.TrimSpace(c.User), c.Password))
	}
	return options, nil
}

func meshConnectionName(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" {
		return "reactorpro-mesh"
	}
	return fmt.Sprintf("%s-%s", prefix, nuid.Next()[:8])
}

// newID returns a unique message id.
func newID() string { return nuid.Next() }
