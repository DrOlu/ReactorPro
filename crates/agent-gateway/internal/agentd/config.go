// Package agentd implements the ReactorPro headless agent runtime: a single
// static binary that signs into a reactorpro-gateway as an attached agent —
// exactly the way the desktop app does, over the same /ws/v2/agent WebSocket —
// and serves remote chat turns with real tool use.
//
// Why this exists: the desktop is a person's machine. It runs one turn at a
// time, behind the human's own conversation, and only while the app is
// launched. The agentd runs as a service on a server, holds its own provider
// key, and runs several turns in parallel — the concurrency the mesh's task
// lifecycle was built to feed. From the gateway's point of view the two are
// indistinguishable: both are rows in the local agent directory, addressed by
// name or capability, governed by the same gates, recorded by the same audit
// trail. No gateway or mesh protocol change is needed for any of this — the
// v2 agent link is the contract, and this package is simply a second
// implementation of it.
package agentd

import (
	"flag"
	"os"
	"strings"
	"time"
)

// Version is the agentd's own version line, independent of the gateway's —
// a gateway on any v1.5.x speaks to any agentd, because the wire contract is
// the gateway's v2 protocol, not either product's version.
const Version = "0.3.0"

// Config is the whole operating surface of one agentd process. It is
// deliberately small: an agentd is a worker, not a policy point — every
// decision about who may reach it stays at the gateway.
type Config struct {
	// GatewayURL is the agent WebSocket endpoint, e.g.
	// ws://127.0.0.1:3000/ws/v2/agent (wss:// in production).
	GatewayURL string
	// AgentID is this worker's identity in the gateway's local directory.
	// Stable across restarts; a partner addresses it by this id or name.
	AgentID string
	// Token is the gateway token or a per-agent token issued by
	// POST /api/agents/{id}/token.
	Token string
	// Name is the friendly name shown in the directory.
	Name string
	// Capabilities are what this worker advertises (invoke's `capability`
	// addressing matches against these). "task" is required to serve the
	// mesh's task operation.
	Capabilities []string

	// ProviderURL / ProviderKey / ProviderModel configure an
	// OpenAI-compatible chat-completions endpoint. The agentd holds its own
	// model key — the gateway's "no model keys, ever" property is untouched.
	ProviderURL   string
	ProviderKey   string
	ProviderModel string
	// MaxTokens caps one completion request.
	MaxTokens int
	// MaxRounds bounds one turn's tool-use loop.
	MaxRounds int

	// Workdir is the sandbox root: every file tool operates under it and
	// every shell command runs with it as the working directory.
	Workdir string
	// Concurrency is how many turns may execute at once. The desktop's
	// answer is 1; the agentd's default is deliberately higher, because
	// unattended parallel turns are its reason to exist. Extra commands
	// queue rather than fail.
	Concurrency int
	// SkillsDir points at a library of SKILL.md collections (e.g.
	// ~/.agents/skills). When set, the skills are listed in every turn's
	// system prompt and served read-only through the read_skill tools.
	// Empty disables the skill surface entirely.
	SkillsDir string
	// ShellEnabled / FetchEnabled toggle the two tools with the widest
	// blast radius, so an operator can ship a read-only worker.
	ShellEnabled bool
	FetchEnabled bool

	// NeuralOSInstancesDir points at a directory of neuralOS instances —
	// folders each holding needle_menu.json + bridge.py over a live data
	// source. Empty disables the neuralOS tools entirely: the on-device
	// needle engine only ever selects a probe; the instance's own bridge
	// executes it and holds its credentials, so nothing here widens the
	// blast radius beyond reading the named directory.
	NeuralOSInstancesDir string
	// NeuralOSEngine / NeuralOSCact / NeuralOSPython override the needle
	// engine binary, the needle3.cact weights, and the python interpreter
	// used to run instance bridges. Empty falls back to "needle" on PATH,
	// needle3.cact beside the engine, and "python3" respectively.
	NeuralOSEngine string
	NeuralOSCact   string
	NeuralOSPython string
	// CommandTimeout bounds one shell command; RequestTimeout is the
	// provider's idle timeout — the longest one streamed round may stay
	// silent between bytes before it is declared stalled (a per-round hard
	// cap backstops providers that trickle keepalives forever).
	CommandTimeout time.Duration
	RequestTimeout time.Duration

	// ContextBudgetTokens bounds the ESTIMATED token count of the
	// model-visible history within one turn. Above it the worker compacts
	// mechanically: old tool results are elided in place (marked, newest
	// kept verbatim), then whole middle exchanges drop. The transcript the
	// checkpoints publish is never rewritten. 0 disables the module.
	ContextBudgetTokens int
	// ContextKeepToolResults is how many of the newest tool results stay
	// verbatim when the budget fires. It also protects that many newest
	// exchanges from the drop-middle stage — the current round is always
	// among them.
	ContextKeepToolResults int
	// ContextSummarize is a reserved seam for provider-side summarization
	// of over-budget regions. v0.2 ships the mechanical ladder only; the
	// flag is accepted and reported so configurations written against this
	// agentd stay valid when the seam is honoured.
	ContextSummarize bool

	// Heartbeat is how often a running turn emits an ingress heartbeat
	// record (the gateway's stale-run reaper is what a silent long run
	// would otherwise meet).
	Heartbeat time.Duration
	// StreamDeltas emits the provider's content deltas as chat-ingress
	// delta records while a round streams, coalesced to the mesh chunk
	// grain — a live viewer watches the answer grow instead of waiting
	// for the round's checkpoint. Best-effort: checkpoints and the
	// terminal remain the authoritative records.
	StreamDeltas bool
	// ConnectTimeout bounds one dial; ReconnectMin/Max bound the reconnect
	// backoff.
	ConnectTimeout time.Duration
	ReconnectMin   time.Duration
	ReconnectMax   time.Duration
}

// DefaultConfig is the shipping configuration: a ready worker with the
// curated tool set, four parallel turns, and polite reconnect behaviour.
func DefaultConfig() Config {
	return Config{
		GatewayURL:     "ws://127.0.0.1:3000/ws/v2/agent",
		AgentID:        "",
		Token:          "",
		Name:           "ReactorPro Agentd",
		Capabilities:   []string{"task", "agentd"},
		MaxTokens:      4096,
		MaxRounds:      16,
		Workdir:        "",
		Concurrency:    4,
		ShellEnabled:   true,
		FetchEnabled:   true,
		// 3m: neuralOS engine selection is on-device model inference (~20s of
		// CPU) and a loaded host can give a child well under half a core — 60s
		// produced spurious SIGKILLs exactly when the machine was busiest.
		CommandTimeout: 3 * time.Minute,
		RequestTimeout: 120 * time.Second,
		// The default budget never fires for the large-context models this
		// worker is typically pointed at; for a small-window model it
		// degrades a tool-heavy turn instead of failing it.
		ContextBudgetTokens:    65536,
		ContextKeepToolResults: 4,
		Heartbeat:              2 * time.Second,
		StreamDeltas:           true,
		ConnectTimeout:         10 * time.Second,
		ReconnectMin:           500 * time.Millisecond,
		ReconnectMax:           30 * time.Second,
	}
}

// RegisterFlags binds every setting to a flag with an environment twin, the
// gateway's convention (LIVEAGENT_AGENTD_*). Values already set on the Config
// are the defaults, so a caller can pre-seed and still override.
func (c *Config) RegisterFlags(fs *flag.FlagSet) {
	fs.StringVar(&c.GatewayURL, "gateway", getenv("LIVEAGENT_AGENTD_GATEWAY", c.GatewayURL),
		"agent WebSocket endpoint of the gateway (ws:// or wss://)")
	fs.StringVar(&c.AgentID, "agent-id", getenv("LIVEAGENT_AGENTD_ID", c.AgentID),
		"this worker's agent id in the gateway's directory")
	fs.StringVar(&c.Token, "token", getenv("LIVEAGENT_AGENTD_TOKEN", c.Token),
		"gateway token or per-agent token")
	fs.StringVar(&c.Name, "name", getenv("LIVEAGENT_AGENTD_NAME", c.Name),
		"friendly name shown in the agent directory")
	fs.StringVar(&c.ProviderURL, "provider-url", getenv("LIVEAGENT_AGENTD_PROVIDER_URL", c.ProviderURL),
		"OpenAI-compatible chat-completions base URL (e.g. https://api.openai.com/v1)")
	fs.StringVar(&c.ProviderKey, "provider-key", getenv("LIVEAGENT_AGENTD_PROVIDER_KEY", c.ProviderKey),
		"provider API key held by this worker")
	fs.StringVar(&c.ProviderModel, "provider-model", getenv("LIVEAGENT_AGENTD_PROVIDER_MODEL", c.ProviderModel),
		"model id passed to the provider")
	fs.IntVar(&c.MaxTokens, "max-tokens", getenvInt("LIVEAGENT_AGENTD_MAX_TOKENS", c.MaxTokens),
		"token cap for one completion request")
	fs.IntVar(&c.MaxRounds, "max-rounds", getenvInt("LIVEAGENT_AGENTD_MAX_ROUNDS", c.MaxRounds),
		"bound on one turn's tool-use rounds")
	fs.StringVar(&c.Workdir, "workdir", getenv("LIVEAGENT_AGENTD_WORKDIR", c.Workdir),
		"sandbox root for the file tools and shell working directory")
	fs.IntVar(&c.Concurrency, "concurrency", getenvInt("LIVEAGENT_AGENTD_CONCURRENCY", c.Concurrency),
		"how many turns may execute at once (extra commands queue)")
	fs.BoolVar(&c.ShellEnabled, "shell", getenvBool("LIVEAGENT_AGENTD_SHELL", c.ShellEnabled),
		"enable the run_command tool")
	fs.BoolVar(&c.FetchEnabled, "fetch", getenvBool("LIVEAGENT_AGENTD_FETCH", c.FetchEnabled),
		"enable the fetch_url tool")
	fs.StringVar(&c.SkillsDir, "skills-dir", getenv("LIVEAGENT_AGENTD_SKILLS_DIR", c.SkillsDir),
		"directory of SKILL.md collections exposed to the worker (read-only; empty disables skills)")
	fs.StringVar(&c.NeuralOSInstancesDir, "neuralos-instances", getenv("LIVEAGENT_AGENTD_NEURALOS_INSTANCES", c.NeuralOSInstancesDir),
		"directory of neuralOS instances (needle_menu.json + bridge.py each); empty disables the neuralOS tools")
	fs.StringVar(&c.NeuralOSEngine, "neuralos-engine", getenv("LIVEAGENT_AGENTD_NEURALOS_ENGINE", c.NeuralOSEngine),
		"path to the needle engine binary (default: \"needle\" on PATH)")
	fs.StringVar(&c.NeuralOSCact, "neuralos-cact", getenv("LIVEAGENT_AGENTD_NEURALOS_CACT", c.NeuralOSCact),
		"path to needle3.cact weights (default: needle3.cact beside the engine)")
	fs.StringVar(&c.NeuralOSPython, "neuralos-python", getenv("LIVEAGENT_AGENTD_NEURALOS_PYTHON", c.NeuralOSPython),
		"python interpreter that runs instance bridges (default: python3)")
	fs.DurationVar(&c.CommandTimeout, "command-timeout", getenvDuration("LIVEAGENT_AGENTD_COMMAND_TIMEOUT", c.CommandTimeout),
		"timeout for one shell command")
	fs.DurationVar(&c.RequestTimeout, "request-timeout", getenvDuration("LIVEAGENT_AGENTD_REQUEST_TIMEOUT", c.RequestTimeout),
		"idle timeout for one streamed provider request (max silence between bytes; rounds are hard-capped at 15m)")
	fs.IntVar(&c.ContextBudgetTokens, "context-budget-tokens", getenvInt("LIVEAGENT_AGENTD_CONTEXT_BUDGET_TOKENS", c.ContextBudgetTokens),
		"estimated-token budget for one turn's model-visible history; above it old tool results are elided and middle exchanges drop (0 disables)")
	fs.IntVar(&c.ContextKeepToolResults, "context-keep-tool-results", getenvInt("LIVEAGENT_AGENTD_CONTEXT_KEEP_TOOL_RESULTS", c.ContextKeepToolResults),
		"how many of the newest tool results stay verbatim when the context budget fires")
	fs.BoolVar(&c.ContextSummarize, "context-summarize", getenvBool("LIVEAGENT_AGENTD_CONTEXT_SUMMARIZE", c.ContextSummarize),
		"reserved: summarize over-budget regions via the provider instead of eliding (not yet implemented; the mechanical ladder applies)")
	fs.BoolVar(&c.StreamDeltas, "stream-deltas", getenvBool("LIVEAGENT_AGENTD_STREAM_DELTAS", c.StreamDeltas),
		"emit the provider's streamed content deltas as chat-ingress token records (best-effort; checkpoints and the terminal stay authoritative)")
}

// Validate refuses a configuration the agentd cannot honour honestly: better
// a loud start-up failure than a worker that accepts turns it cannot run.
func (c *Config) Validate() error {
	if strings.TrimSpace(c.GatewayURL) == "" {
		return errString("the gateway endpoint is required")
	}
	if !strings.Contains(c.GatewayURL, "://") {
		return errString("the gateway endpoint must be a ws:// or wss:// URL")
	}
	if strings.TrimSpace(c.AgentID) == "" {
		return errString("an agent id is required — this is the worker's address in the directory")
	}
	if strings.TrimSpace(c.Token) == "" {
		return errString("a gateway or per-agent token is required")
	}
	if strings.TrimSpace(c.ProviderURL) == "" || strings.TrimSpace(c.ProviderModel) == "" {
		return errString("a provider base URL and model are required — the agentd executes real turns")
	}
	if strings.TrimSpace(c.Workdir) == "" {
		return errString("a workdir is required — it is the sandbox root for the tools")
	}
	if c.Concurrency < 1 {
		return errString("concurrency must be at least 1")
	}
	if c.MaxRounds < 1 {
		return errString("max-rounds must be at least 1")
	}
	if c.ContextBudgetTokens < 0 {
		return errString("context-budget-tokens must be 0 (off) or a positive token estimate")
	}
	if c.ContextBudgetTokens > 0 && c.ContextKeepToolResults < 1 {
		return errString("context-keep-tool-results must be at least 1 when the context budget is on")
	}
	return nil
}

type errString string

func (e errString) Error() string { return string(e) }

// The environment helpers mirror the gateway's config package: absent means
// "keep the default", which is what lets an operator set one flag in a unit
// file without restating everything.

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func getenvInt(key string, fallback int) int {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		if parsed, err := parseInt(value); err == nil {
			return parsed
		}
	}
	return fallback
}

func getenvBool(key string, fallback bool) bool {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		switch strings.ToLower(value) {
		case "1", "true", "yes", "on":
			return true
		case "0", "false", "no", "off":
			return false
		}
	}
	return fallback
}

func getenvDuration(key string, fallback time.Duration) time.Duration {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil {
			return parsed
		}
	}
	return fallback
}
