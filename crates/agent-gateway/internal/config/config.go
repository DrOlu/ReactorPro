package config

import (
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/mesh"
)

const DefaultMaxMessageBytes = 64 * 1024 * 1024

// Default concurrent connection limits for the three v2 link types; browser/terminal
// usage scales by "a few sessions per Agent" (100 Agents x several browser tabs/terminal pages).
const (
	DefaultMaxAgentConnections    = 256
	DefaultMaxBrowserConnections  = 128
	DefaultMaxTerminalConnections = 512
)

type Config struct {
	Token string
	// AgentDB is the path to the per-Agent credential SQLite database; created automatically in the user config directory by default.
	AgentDB string
	// Concurrent connection limits for the three v2 link types (checked before upgrade, over-limit returns 503); 0/negative falls back to defaults.
	// Defaults are rounded to the target scale of 100+ desktop Agents.
	MaxAgentConnections      int
	MaxBrowserConnections    int
	MaxTerminalConnections   int
	HTTPAddr                 string
	TLSCert                  string
	TLSKey                   string
	RequestTimeout           time.Duration
	ChatPrepareTimeout       time.Duration
	ChatDeliveryTimeout      time.Duration
	ChatStartTimeout         time.Duration
	ChatRenderStartTimeout   time.Duration
	HeartbeatPeriod          time.Duration
	WebSocketHeartbeatPeriod time.Duration
	WebSocketHeartbeatGrace  time.Duration
	WebSocketWriteTimeout    time.Duration
	WebSocketWriteQueueSize  int
	MaxMessageBytes          int
	RelayBufferSeconds       int

	// NATS event mesh / Synapse bridge. Disabled by default: while MeshEnabled is
	// false nothing connects anywhere, and a half-configured bridge is refused.
	MeshEnabled      bool
	MeshURL          string
	MeshAgentID      string
	MeshIdentityPath string
	MeshToken        string
	MeshUser         string
	MeshPassword     string
	MeshDisplayName  string
	// MeshCredsFile points at a NATS credentials file (NKey/JWT). It takes
	// precedence over token and user/password, and is the only way to use the
	// stronger NATS auth modes.
	MeshCredsFile string

	// Mesh trust policy.
	MeshVerifyMode       string
	MeshClockSkew        time.Duration
	MeshTrustedPeers     string // comma-separated fingerprints
	MeshTrustOnFirstUse  bool
	MeshMaxEnvelopeBytes int
	MeshRateLimitPerSec  float64
	MeshRateLimitBurst   int
}

func Load() *Config {
	cfg := &Config{}

	flag.StringVar(&cfg.Token, "token", getenv("LIVEAGENT_GATEWAY_TOKEN", ""), "gateway authentication token")
	flag.StringVar(&cfg.AgentDB, "agent-db", getenv("LIVEAGENT_GATEWAY_AGENT_DB", defaultAgentDBPath()), "per-agent token SQLite database path (auto-created by default)")
	flag.IntVar(&cfg.MaxAgentConnections, "max-agent-connections", getenvInt("LIVEAGENT_GATEWAY_MAX_AGENT_CONNECTIONS", DefaultMaxAgentConnections), "maximum concurrent desktop agent connections")
	flag.IntVar(&cfg.MaxBrowserConnections, "max-browser-connections", getenvInt("LIVEAGENT_GATEWAY_MAX_BROWSER_CONNECTIONS", DefaultMaxBrowserConnections), "maximum concurrent browser connections")
	flag.IntVar(&cfg.MaxTerminalConnections, "max-terminal-connections", getenvInt("LIVEAGENT_GATEWAY_MAX_TERMINAL_CONNECTIONS", DefaultMaxTerminalConnections), "maximum concurrent terminal data-plane connections")
	flag.StringVar(&cfg.HTTPAddr, "http-addr", getenv("LIVEAGENT_GATEWAY_HTTP_ADDR", defaultHTTPAddr()), "HTTP listen address")
	flag.StringVar(&cfg.TLSCert, "tls-cert", getenv("LIVEAGENT_GATEWAY_TLS_CERT", ""), "TLS certificate path")
	flag.StringVar(&cfg.TLSKey, "tls-key", getenv("LIVEAGENT_GATEWAY_TLS_KEY", ""), "TLS private key path")
	// NATS event mesh / Synapse bridge (disabled unless explicitly enabled).
	flag.BoolVar(&cfg.MeshEnabled, "mesh-enabled", getenvBool("LIVEAGENT_GATEWAY_MESH_ENABLED", false), "enable the NATS event mesh and Synapse bridge")
	flag.StringVar(&cfg.MeshURL, "mesh-url", getenv("LIVEAGENT_GATEWAY_MESH_URL", ""), "NATS server URL for the mesh bridge")
	flag.StringVar(&cfg.MeshAgentID, "mesh-agent-id", getenv("LIVEAGENT_GATEWAY_MESH_AGENT_ID", mesh.DefaultAgentID), "Synapse agent id (fixed once the identity file exists)")
	flag.StringVar(&cfg.MeshIdentityPath, "mesh-identity-path", getenv("LIVEAGENT_GATEWAY_MESH_IDENTITY_PATH", defaultMeshIdentityPath()), "mesh identity file path (minted on first use)")
	flag.StringVar(&cfg.MeshToken, "mesh-token", getenv("LIVEAGENT_GATEWAY_MESH_TOKEN", ""), "NATS token authentication")
	flag.StringVar(&cfg.MeshUser, "mesh-user", getenv("LIVEAGENT_GATEWAY_MESH_USER", ""), "NATS user authentication")
	flag.StringVar(&cfg.MeshPassword, "mesh-password", getenv("LIVEAGENT_GATEWAY_MESH_PASSWORD", ""), "NATS password authentication")
	flag.StringVar(&cfg.MeshDisplayName, "mesh-name", getenv("LIVEAGENT_GATEWAY_MESH_NAME", "ReactorPro Gateway"), "mesh manifest display name")
	flag.StringVar(&cfg.MeshCredsFile, "mesh-creds-file", getenv("LIVEAGENT_GATEWAY_MESH_CREDS_FILE", ""), "NATS credentials file for the mesh bridge (NKey/JWT; takes precedence over token and user/password)")
	flag.StringVar(&cfg.MeshVerifyMode, "mesh-verify-mode", getenv("LIVEAGENT_GATEWAY_MESH_VERIFY_MODE", mesh.VerifyPrefer), "inbound envelope verification: off, prefer (verify when signed), or require (reject unsigned)")
	flag.DurationVar(&cfg.MeshClockSkew, "mesh-clock-skew", getenvDuration("LIVEAGENT_GATEWAY_MESH_CLOCK_SKEW", mesh.DefaultClockSkew), "how far an envelope timestamp may drift before it is refused")
	flag.StringVar(&cfg.MeshTrustedPeers, "mesh-trusted-peers", getenv("LIVEAGENT_GATEWAY_MESH_TRUSTED_PEERS", ""), "comma-separated fingerprints (sha256:<hex>) of peers to trust without first-use learning")
	flag.BoolVar(&cfg.MeshTrustOnFirstUse, "mesh-trust-on-first-use", getenvBool("LIVEAGENT_GATEWAY_MESH_TRUST_ON_FIRST_USE", true), "record a peer's identity fingerprint on its first verified message")
	flag.IntVar(&cfg.MeshMaxEnvelopeBytes, "mesh-max-envelope-bytes", getenvInt("LIVEAGENT_GATEWAY_MESH_MAX_ENVELOPE_BYTES", mesh.DefaultMaxEnvelopeBytes), "maximum size of a single inbound mesh envelope in bytes")
	flag.Float64Var(&cfg.MeshRateLimitPerSec, "mesh-rate-limit-per-second", getenvFloat("LIVEAGENT_GATEWAY_MESH_RATE_LIMIT_PER_SECOND", 50), "sustained inbound mesh messages per second allowed from one sender (0 disables)")
	flag.IntVar(&cfg.MeshRateLimitBurst, "mesh-rate-limit-burst", getenvInt("LIVEAGENT_GATEWAY_MESH_RATE_LIMIT_BURST", 100), "inbound mesh burst allowance per sender")
	flag.DurationVar(&cfg.RequestTimeout, "request-timeout", getenvDuration("LIVEAGENT_GATEWAY_REQUEST_TIMEOUT", 2*time.Minute), "request timeout for non-streaming API calls")
	flag.DurationVar(&cfg.ChatPrepareTimeout, "chat-prepare-timeout", getenvDuration("LIVEAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT", 2*time.Second), "timeout for the pre-submit desktop agent liveness probe")
	flag.DurationVar(&cfg.ChatDeliveryTimeout, "chat-delivery-timeout", getenvDuration("LIVEAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT", 5*time.Second), "timeout delivering an accepted chat command to the desktop agent stream")
	flag.DurationVar(&cfg.ChatStartTimeout, "chat-start-timeout", getenvDuration("LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT", 5*time.Second), "initial timeout waiting for a delivered remote chat request to start")
	flag.DurationVar(&cfg.ChatRenderStartTimeout, "chat-render-start-timeout", getenvDuration("LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT", 10*time.Second), "additional timeout waiting for the desktop app to start a delivered remote chat request")
	flag.DurationVar(&cfg.HeartbeatPeriod, "heartbeat-period", getenvDuration("LIVEAGENT_GATEWAY_HEARTBEAT_PERIOD", 30*time.Second), "ping interval for agent connection")
	flag.DurationVar(&cfg.WebSocketHeartbeatPeriod, "websocket-heartbeat-period", getenvDuration("LIVEAGENT_GATEWAY_WS_HEARTBEAT_PERIOD", 15*time.Second), "ping interval for browser WebSocket connections")
	flag.DurationVar(&cfg.WebSocketHeartbeatGrace, "websocket-heartbeat-grace", getenvDuration("LIVEAGENT_GATEWAY_WS_HEARTBEAT_GRACE", 5*time.Second), "extra slack added to the browser WebSocket idle timeout (idle = 3x period + grace)")
	flag.DurationVar(&cfg.WebSocketWriteTimeout, "websocket-write-timeout", getenvDuration("LIVEAGENT_GATEWAY_WS_WRITE_TIMEOUT", 10*time.Second), "write timeout for browser WebSocket connections")
	flag.IntVar(&cfg.WebSocketWriteQueueSize, "websocket-write-queue-size", getenvInt("LIVEAGENT_GATEWAY_WS_WRITE_QUEUE_SIZE", 512), "write queue buffer size for browser WebSocket connections")
	flag.IntVar(
		&cfg.MaxMessageBytes,
		"max-message-bytes",
		getenvInt(
			"LIVEAGENT_GATEWAY_MAX_MESSAGE_BYTES",
			getenvInt("LIVEAGENT_GATEWAY_GRPC_MAX_MESSAGE_BYTES", DefaultMaxMessageBytes),
		),
		"maximum WebSocket protobuf message size in bytes",
	)
	flag.IntVar(&cfg.RelayBufferSeconds, "relay-buffer-seconds", getenvInt("LIVEAGENT_GATEWAY_RELAY_BUFFER_SECONDS", 30), "seconds of chat events to buffer for brief reconnections")
	os.Args = normalizeLegacyArgs(os.Args)
	flag.Parse()

	cfg.Token = strings.TrimSpace(cfg.Token)
	cfg.AgentDB = strings.TrimSpace(cfg.AgentDB)
	// The Agent credential database is a base capability always enabled on the gateway; even if
	// the startup arg is explicitly empty, it falls back to the automatic path and cannot be disabled with an empty value.
	if cfg.AgentDB == "" {
		cfg.AgentDB = defaultAgentDBPath()
	}
	cfg.TLSCert = strings.TrimSpace(cfg.TLSCert)
	cfg.TLSKey = strings.TrimSpace(cfg.TLSKey)

	if cfg.Token == "" {
		flag.Usage()
		panic("gateway token is required")
	}
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = DefaultMaxMessageBytes
	}
	if cfg.MaxAgentConnections <= 0 {
		cfg.MaxAgentConnections = DefaultMaxAgentConnections
	}
	if cfg.MaxBrowserConnections <= 0 {
		cfg.MaxBrowserConnections = DefaultMaxBrowserConnections
	}
	if cfg.MaxTerminalConnections <= 0 {
		cfg.MaxTerminalConnections = DefaultMaxTerminalConnections
	}
	if cfg.ChatPrepareTimeout <= 0 {
		cfg.ChatPrepareTimeout = 2 * time.Second
	}
	if cfg.ChatDeliveryTimeout <= 0 {
		cfg.ChatDeliveryTimeout = 5 * time.Second
	}
	if cfg.ChatStartTimeout <= 0 {
		cfg.ChatStartTimeout = 5 * time.Second
	}
	if cfg.ChatRenderStartTimeout <= 0 {
		cfg.ChatRenderStartTimeout = 10 * time.Second
	}
	if cfg.WebSocketHeartbeatPeriod <= 0 {
		cfg.WebSocketHeartbeatPeriod = 15 * time.Second
	}
	if cfg.WebSocketHeartbeatGrace <= 0 {
		cfg.WebSocketHeartbeatGrace = 5 * time.Second
	}
	if cfg.WebSocketWriteTimeout <= 0 {
		cfg.WebSocketWriteTimeout = 10 * time.Second
	}
	if cfg.WebSocketWriteQueueSize <= 0 {
		cfg.WebSocketWriteQueueSize = 512
	}
	if cfg.RelayBufferSeconds <= 0 {
		cfg.RelayBufferSeconds = 30
	}

	return cfg
}

// normalizeLegacyArgs uniformly cleans up removed arguments before entering the new FlagSet.
// Old names are no longer registered, do not appear in help, and will not restore v1/gRPC or
// the offline command queue; genuinely unknown arguments are still rejected by flag as usual.
// The message size argument still has corresponding semantics, so it is converted to the new
// name; an explicit new name takes precedence.
func normalizeLegacyArgs(args []string) []string {
	if len(args) == 0 {
		return args
	}

	hasCurrentMessageLimit := false
	for _, arg := range args[1:] {
		if arg == "-max-message-bytes" || arg == "--max-message-bytes" ||
			strings.HasPrefix(arg, "-max-message-bytes=") ||
			strings.HasPrefix(arg, "--max-message-bytes=") {
			hasCurrentMessageLimit = true
			break
		}
	}

	normalized := make([]string, 0, len(args))
	normalized = append(normalized, args[0])
	for index := 1; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			normalized = append(normalized, args[index:]...)
			break
		}
		switch {
		case arg == "-grpc-addr" || arg == "--grpc-addr" ||
			arg == "-command-queue-timeout" || arg == "--command-queue-timeout":
			if index+1 < len(args) {
				index++
			}
		case strings.HasPrefix(arg, "-grpc-addr=") ||
			strings.HasPrefix(arg, "--grpc-addr=") ||
			strings.HasPrefix(arg, "-command-queue-timeout=") ||
			strings.HasPrefix(arg, "--command-queue-timeout="):
			continue
		case arg == "-grpc-max-message-bytes" || arg == "--grpc-max-message-bytes":
			if index+1 < len(args) {
				if !hasCurrentMessageLimit {
					normalized = append(normalized, "-max-message-bytes", args[index+1])
				}
				index++
			}
		case strings.HasPrefix(arg, "-grpc-max-message-bytes=") ||
			strings.HasPrefix(arg, "--grpc-max-message-bytes="):
			if !hasCurrentMessageLimit {
				value := strings.SplitN(arg, "=", 2)[1]
				normalized = append(normalized, "-max-message-bytes="+value)
			}
		default:
			normalized = append(normalized, arg)
		}
	}
	return normalized
}

// MeshConfig projects the gateway settings onto the mesh bridge configuration.
// A disabled gateway yields a disabled bridge.
func (c *Config) MeshConfig() mesh.Config {
	cfg := mesh.DefaultConfig()
	cfg.Enabled = c.MeshEnabled
	cfg.URL = c.MeshURL
	cfg.AgentID = c.MeshAgentID
	cfg.IdentityPath = c.MeshIdentityPath
	cfg.Token = c.MeshToken
	cfg.User = c.MeshUser
	cfg.Password = c.MeshPassword
	cfg.CredsFile = c.MeshCredsFile
	if strings.TrimSpace(c.MeshDisplayName) != "" {
		cfg.Name = c.MeshDisplayName
	}

	if mode := strings.TrimSpace(c.MeshVerifyMode); mode != "" {
		cfg.VerifyMode = mode
	}
	if c.MeshClockSkew > 0 {
		cfg.ClockSkew = c.MeshClockSkew
	}
	cfg.TrustedPeers = splitList(c.MeshTrustedPeers)
	cfg.TrustOnFirstUse = c.MeshTrustOnFirstUse
	if c.MeshMaxEnvelopeBytes > 0 {
		cfg.MaxEnvelopeBytes = c.MeshMaxEnvelopeBytes
	}
	// A zero rate means "no limit", which is why this is not guarded by > 0 the
	// way the other numeric settings are.
	cfg.RateLimit = mesh.RateLimitConfig{
		Enabled:   c.MeshRateLimitPerSec > 0,
		PerSecond: c.MeshRateLimitPerSec,
		Burst:     c.MeshRateLimitBurst,
	}
	return cfg
}

func defaultMeshIdentityPath() string {
	if dataDir := strings.TrimSpace(os.Getenv("LIVEAGENT_GATEWAY_DATA_DIR")); dataDir != "" {
		return filepath.Join(dataDir, "mesh", "reactorpro-identity.json")
	}
	if configDir, err := os.UserConfigDir(); err == nil && strings.TrimSpace(configDir) != "" {
		return filepath.Join(configDir, "liveagent", "mesh", "reactorpro-identity.json")
	}
	return filepath.Join(".", "reactorpro-mesh-identity.json")
}

func getenvBool(key string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	switch value {
	case "":
		return fallback
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func defaultAgentDBPath() string {
	if dataDir := strings.TrimSpace(os.Getenv("LIVEAGENT_GATEWAY_DATA_DIR")); dataDir != "" {
		return filepath.Join(dataDir, "gateway.db")
	}
	if configDir, err := os.UserConfigDir(); err == nil && strings.TrimSpace(configDir) != "" {
		return filepath.Join(configDir, "liveagent", "gateway.db")
	}
	return filepath.Join(".", "liveagent-gateway.db")
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func defaultHTTPAddr() string {
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		return ":443"
	}
	if strings.HasPrefix(port, ":") {
		return port
	}
	return ":" + port
}

func getenvDuration(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getenvInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

// getenvFloat differs from getenvInt in one deliberate way: zero is a valid
// value, not a signal to fall back. Rate limits use zero to mean "disabled", so
// treating it as unset would silently re-enable the limit.
func getenvFloat(key string, fallback float64) float64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || parsed < 0 {
		return fallback
	}
	return parsed
}

// splitList parses a comma-separated setting, dropping empty entries so a
// trailing comma is not an error.
func splitList(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
