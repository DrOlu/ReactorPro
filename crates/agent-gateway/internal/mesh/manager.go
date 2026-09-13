package mesh

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// maxEventLog bounds the in-memory event history surfaced to the UI.
const maxEventLog = 200

// EventRecord is one observed mesh event, kept for the UI.
type EventRecord struct {
	Subject string       `json:"subject"`
	Event   EventPayload `json:"event"`
	At      time.Time    `json:"at"`
}

// Subscription describes an active event subscription.
type Subscription struct {
	Subject   string    `json:"subject"`
	CreatedAt time.Time `json:"createdAt"`
	Received  int       `json:"received"`
}

// Status is the manager's health snapshot.
type Status struct {
	Enabled       bool           `json:"enabled"`
	Connected     bool           `json:"connected"`
	AgentID       string         `json:"agentId"`
	Fingerprint   string         `json:"fingerprint"`
	URL           string         `json:"url"`
	Serving       bool           `json:"serving"`
	Skills        []string       `json:"skills"`
	Manifest      Manifest       `json:"manifest"`
	Subscriptions []Subscription `json:"subscriptions"`
	Reputation    []Reputation   `json:"reputation"`
	Pending       []Approval     `json:"pendingApprovals"`
	LastError     string         `json:"lastError,omitempty"`
	// LocalAgents is the directory this edge publishes to the mesh.
	LocalAgents []LocalAgent `json:"localAgents,omitempty"`
	// IDCollision names a peer seen using this edge's own agent id, which makes
	// that id ambiguous on the mesh. Empty when none has been observed.
	IDCollision string `json:"idCollision,omitempty"`
}

// Manager owns the mesh lifecycle and implements the bridge's operations.
//
// It is safe to construct without a connection: every operation returns
// ErrNotConnected until Start succeeds, and the zero configuration leaves the
// bridge disabled so nothing leaves the machine.
type Manager struct {
	mu         sync.RWMutex
	config     Config
	logger     *slog.Logger
	identity   *Identity
	agent      *Agent
	reputation *ReputationStore
	governor   *Governor
	subs       map[string]*Subscription
	events     []EventRecord
	lastErr    string
	// startedAt is when the current connection came up, for the served
	// `status` skill. Zero while the bridge is not running.
	startedAt time.Time
	// localAgents supplies the directory published in the manifest. Held here so
	// it can be installed before Start.
	localAgents LocalAgentProvider
}

// NewManager builds a manager from configuration.
func NewManager(config Config, logger *slog.Logger) *Manager {
	if logger == nil {
		logger = slog.Default()
	}
	return &Manager{
		config:     config,
		logger:     logger,
		reputation: NewReputationStore(config.Reputation),
		governor:   NewGovernor(config.Governance),
		subs:       map[string]*Subscription{},
	}
}

// Config returns the active configuration.
func (m *Manager) Config() Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.config
}

// Start loads the identity and connects. A disabled or invalid configuration is
// not an error: Start reports that the bridge stays off.
func (m *Manager) Start(ctx context.Context) error {
	m.mu.Lock()
	config := m.config
	m.mu.Unlock()

	if err := config.Validate(); err != nil {
		m.setLastError(err.Error())
		return err
	}
	if !config.Enabled {
		m.logger.Info("mesh bridge disabled; nothing will connect")
		return nil
	}

	identity, created, err := LoadIdentity(config.IdentityPath, config.AgentID)
	if err != nil {
		m.setLastError(err.Error())
		return err
	}
	if created {
		m.logger.Info("minted mesh identity",
			"agentId", identity.AgentID, "fingerprint", identity.Fingerprint, "path", config.IdentityPath)
	}
	// An edge still on the shared default cannot federate: peers address agents by
	// id, so two of them collide and discovery drops each other as "self". The
	// identity is already minted under that id, so this is a warning rather than a
	// startup failure — changing it means minting a new identity, which is the
	// operator's call, and a single-edge deployment is unaffected.
	if UsesLegacyAgentID(identity.AgentID) {
		m.logger.Warn("mesh agent id is the shared default; this edge cannot federate",
			"agentId", identity.AgentID,
			"impact", "any peer using the same default is dropped as self, and routing to this id is ambiguous",
			"fix", "set -mesh-agent-id to a unique value such as <org>/<site>/<edge>, then remove the identity file to mint a new identity")
	}

	agent := NewAgent(config, identity, m.logger)
	m.mu.RLock()
	provider := m.localAgents
	m.mu.RUnlock()
	agent.SetLocalAgentsProvider(provider)
	// Register skills before connecting so they appear in the manifest the first
	// registration publishes. A peer that discovers this agent immediately knows
	// what it can ask for.
	if err := m.registerBuiltinSkills(agent); err != nil {
		m.logger.Warn("mesh built-in skill registration failed", "error", err)
	}
	if err := agent.Start(ctx); err != nil {
		m.setLastError(err.Error())
		return err
	}

	m.mu.Lock()
	m.identity = identity
	m.agent = agent
	m.lastErr = ""
	m.startedAt = time.Now().UTC()
	m.mu.Unlock()

	for _, subject := range config.EventSubscriptions {
		if _, err := m.Subscribe(ctx, subject); err != nil {
			m.logger.Warn("mesh auto-subscription failed", "subject", subject, "error", err)
		}
	}
	return nil
}

// Stop disconnects the bridge.
func (m *Manager) Stop(ctx context.Context) error {
	m.mu.Lock()
	agent := m.agent
	m.agent = nil
	m.startedAt = time.Time{}
	m.mu.Unlock()
	if agent == nil {
		return nil
	}
	return agent.Stop(ctx)
}

// Restart applies a new configuration.
func (m *Manager) Restart(ctx context.Context, config Config) error {
	if err := m.Stop(ctx); err != nil {
		m.logger.Warn("mesh stop during restart failed", "error", err)
	}
	m.mu.Lock()
	m.config = config
	m.reputation = NewReputationStore(config.Reputation)
	m.governor = NewGovernor(config.Governance)
	m.subs = map[string]*Subscription{}
	m.mu.Unlock()
	return m.Start(ctx)
}

// Status reports the current health of the bridge.
func (m *Manager) Status() Status {
	m.mu.RLock()
	agent := m.agent
	identity := m.identity
	config := m.config
	lastErr := m.lastErr
	subs := make([]Subscription, 0, len(m.subs))
	for _, sub := range m.subs {
		subs = append(subs, *sub)
	}
	m.mu.RUnlock()

	status := Status{
		Enabled:       config.Enabled,
		URL:           config.URL,
		Skills:        []string{},
		Reputation:    m.reputation.Snapshot(),
		Pending:       m.governor.Pending(),
		Subscriptions: subs,
		LastError:     lastErr,
	}
	if identity != nil {
		status.AgentID = identity.AgentID
		status.Fingerprint = identity.Fingerprint
	}
	if agent != nil {
		status.Connected = agent.Connected()
		status.Serving = agent.Connected()
		status.Manifest = agent.Manifest()
		status.Skills = agent.Skills()
		status.LocalAgents = status.Manifest.LocalAgents
		status.IDCollision = agent.Collision()
	}
	return status
}

// LocalAgents returns the directory this edge publishes, whether or not the
// bridge is connected. Available offline so the Settings UI can show what would
// be advertised.
func (m *Manager) LocalAgents() []LocalAgent {
	agents, _ := directorySnapshot(m.localAgentsSnapshot())
	return agents
}

func (m *Manager) localAgentsSnapshot() LocalAgentProvider {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.localAgents
}

// SetLocalAgentsProvider installs the directory supplier. Callable before Start;
// if the bridge is already running the manifest is rebuilt and re-registered so
// peers see the change immediately rather than after the next heartbeat.
func (m *Manager) SetLocalAgentsProvider(provider LocalAgentProvider) {
	m.mu.Lock()
	m.localAgents = provider
	agent := m.agent
	m.mu.Unlock()
	if agent != nil {
		agent.SetLocalAgentsProvider(provider)
	}
}

// IDCollision reports a peer using this edge's own agent id, if one has been
// seen. Surfaced by the HTTP status so the condition is visible without reading
// logs.
func (m *Manager) IDCollision() string {
	agent, err := m.requireAgent()
	if err != nil {
		return ""
	}
	return agent.Collision()
}

// Health is the synapse_health tool.
func (m *Manager) Health() map[string]any {
	status := m.Status()
	return map[string]any{
		"enabled":       status.Enabled,
		"connected":     status.Connected,
		"agent_id":      status.AgentID,
		"fingerprint":   status.Fingerprint,
		"url":           status.URL,
		"serving":       status.Serving,
		"skills":        status.Skills,
		"subscriptions": len(status.Subscriptions),
		"last_error":    status.LastError,
	}
}

// Register refreshes this agent's registration (synapse_register).
func (m *Manager) Register(ctx context.Context) (Manifest, error) {
	agent, err := m.requireAgent()
	if err != nil {
		return Manifest{}, err
	}
	if err := agent.Register(ctx); err != nil {
		m.setLastError(err.Error())
		return Manifest{}, err
	}
	return agent.Manifest(), nil
}

// Discover lists matching peers (synapse_discover).
func (m *Manager) Discover(ctx context.Context, filter DiscoverFilter) ([]Manifest, error) {
	agent, err := m.requireAgent()
	if err != nil {
		return nil, err
	}
	agents, err := agent.Discover(ctx, filter)
	if err != nil {
		m.setLastError(err.Error())
		return nil, err
	}
	return agents, nil
}

// Dispatch sends a skill request, applying governance before it leaves and
// reputation after it returns (synapse_dispatch).
func (m *Manager) Dispatch(ctx context.Context, targetAgent, skill string, input any, timeout time.Duration) (*Envelope, error) {
	agent, err := m.requireAgent()
	if err != nil {
		return nil, err
	}

	// EXT-GOVERNANCE: gate the call before it is sent.
	if m.governor.RequiresApproval(skill) {
		approvalID := m.governor.Request(agent.AgentID(), targetAgent, skill, input)
		m.logger.Info("mesh dispatch awaiting approval", "approvalId", approvalID, "skill", skill)
		if _, err := m.governor.Wait(approvalID); err != nil {
			m.reputation.RecordFailure(targetAgent)
			return nil, fmt.Errorf("%w: %v", ErrApprovalDenied, err)
		}
	}

	response, err := agent.Dispatch(ctx, targetAgent, skill, input, timeout)
	if err != nil {
		m.reputation.RecordFailure(targetAgent)
		return response, err
	}
	m.reputation.RecordSuccess(targetAgent)
	return response, nil
}

// Emit publishes an event (synapse_emit).
func (m *Manager) Emit(ctx context.Context, eventType string, data any) error {
	agent, err := m.requireAgent()
	if err != nil {
		return err
	}
	if eventType == "" {
		return errors.New("event type is required")
	}
	return agent.Emit(ctx, eventType, data)
}

// Subscribe attaches an event subscription (synapse_subscribe).
func (m *Manager) Subscribe(ctx context.Context, subject string) (*Subscription, error) {
	agent, err := m.requireAgent()
	if err != nil {
		return nil, err
	}
	key := normalizeEventSubject(subject)
	m.mu.Lock()
	if existing, ok := m.subs[key]; ok {
		m.mu.Unlock()
		return existing, nil
	}
	m.mu.Unlock()

	if _, err := agent.Subscribe(ctx, subject, m.recordEvent); err != nil {
		return nil, err
	}

	record := &Subscription{Subject: key, CreatedAt: now()}
	m.mu.Lock()
	m.subs[key] = record
	m.mu.Unlock()
	return record, nil
}

// recordEvent stores an observed event for the UI.
func (m *Manager) recordEvent(_ context.Context, subject string, event EventPayload) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, EventRecord{Subject: subject, Event: event, At: now()})
	if len(m.events) > maxEventLog {
		m.events = m.events[len(m.events)-maxEventLog:]
	}
	if sub, ok := m.subs[subject]; ok {
		sub.Received++
	} else if sub, ok := m.subs[SubjectEventWildcard]; ok {
		sub.Received++
	}
}

// Events returns the recent event history, newest last.
func (m *Manager) Events() []EventRecord {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]EventRecord, len(m.events))
	copy(out, m.events)
	return out
}

// AgentsSummary summarises known peers (synapse_agents_summary).
func (m *Manager) AgentsSummary(ctx context.Context) (map[string]any, error) {
	agents, err := m.Discover(ctx, DiscoverFilter{})
	if err != nil {
		return nil, err
	}
	byCapability := map[string]int{}
	for _, agent := range agents {
		for _, capability := range agent.Capabilities {
			byCapability[capability]++
		}
	}
	return map[string]any{
		"count":         len(agents),
		"agents":        agents,
		"by_capability": byCapability,
	}, nil
}

// Reputation returns the score snapshot (synapse_reputation).
func (m *Manager) Reputation() []Reputation { return m.reputation.Snapshot() }

// RequestApproval opens a governance approval (synapse_request_approval).
func (m *Manager) RequestApproval(target, skill string, input any) string {
	requester := ""
	if agent, err := m.requireAgent(); err == nil {
		requester = agent.AgentID()
	}
	return m.governor.Request(requester, target, skill, input)
}

// Approve resolves an approval (synapse_approve). An empty decision approves.
func (m *Manager) Approve(id, approver, decision, reason string) error {
	switch decision {
	case "", string(StatusApproved), "approve":
		return m.governor.Approve(id, approver, reason)
	case string(StatusDenied), "deny", "reject":
		return m.governor.Deny(id, approver, reason)
	default:
		return fmt.Errorf("unknown decision %q: use approve or deny", decision)
	}
}

// PendingApprovals lists undecided approvals.
func (m *Manager) PendingApprovals() []Approval { return m.governor.Pending() }

// DecidedApproval reports a previously resolved approval, so a caller can tell
// an unknown id apart from one that was already decided.
func (m *Manager) DecidedApproval(id string) (Approval, bool) { return m.governor.Decided(id) }

// Serving reports whether the agent is accepting inbound requests.
func (m *Manager) Serving() bool {
	m.mu.RLock()
	agent := m.agent
	m.mu.RUnlock()
	return agent != nil && agent.Connected()
}

// TrustPeers lists the identities this bridge has accepted, keyed by agent id.
// Empty when the bridge is not running, since the store lives on the agent.
func (m *Manager) TrustPeers() []PeerPin {
	agent, err := m.requireAgent()
	if err != nil {
		return nil
	}
	return agent.TrustPeers()
}

// SeedTrustedPeers installs previously persisted identity pins. Called at
// start-up so a peer trusted before a restart is not re-learned from scratch.
func (m *Manager) SeedTrustedPeers(pins []PeerPin) {
	if agent, err := m.requireAgent(); err == nil {
		agent.SeedTrustedPeers(pins)
	}
}

// ApprovalHistory returns decided approvals, oldest first: the audit trail for
// who approved what, and why.
func (m *Manager) ApprovalHistory() []Approval { return m.governor.History() }

// RegisterSkill exposes a skill over the mesh.
func (m *Manager) RegisterSkill(skillID string, handler Handler) error {
	agent, err := m.requireAgent()
	if err != nil {
		return err
	}
	agent.RegisterSkill(skillID, handler)
	return nil
}

func (m *Manager) requireAgent() (*Agent, error) {
	m.mu.RLock()
	agent := m.agent
	m.mu.RUnlock()
	if agent == nil {
		return nil, ErrNotConnected
	}
	return agent, nil
}

func (m *Manager) setLastError(message string) {
	m.mu.Lock()
	m.lastErr = message
	m.mu.Unlock()
}

// normalizeEventSubject maps a user-supplied subject to its canonical form.
func normalizeEventSubject(subject string) string {
	switch {
	case subject == "":
		return SubjectEventWildcard
	case len(subject) >= len(SubjectEventPrefix) && subject[:len(SubjectEventPrefix)] == SubjectEventPrefix:
		return subject
	default:
		return SubjectEventPrefix + subject
	}
}
