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
	RequestTimeout    time.Duration `json:"-"`

	// Extensions
	Reputation ReputationConfig `json:"reputation"`
	Governance GovernanceConfig `json:"governance"`

	// Events to subscribe to automatically once connected.
	EventSubscriptions []string `json:"eventSubscriptions"`
}

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
		Reputation:        DefaultReputationConfig(),
		Governance:        DefaultGovernanceConfig(),
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
