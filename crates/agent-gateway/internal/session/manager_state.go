package session

import (
	"strings"
	"sync"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// sessionRegistry maintains registration entries for multiple desktop Agents keyed by agent_id.
// An entry is retained after disconnection (auth/runtime snapshots survive reconnects); reconnecting
// with the same id only displaces that id's old session.
type sessionRegistry struct {
	mu     sync.RWMutex
	agents map[string]*agentEntry
}

// agentEntry is the registration entry for a single Agent; a nil session means it is currently offline.
// epoch is incremented on every session replacement and binds liveness probe results to a specific connection.
// Each snapshot is isolated per Agent and survives disconnects (the browser need not wait for a full re-push after reconnect).
type agentEntry struct {
	id           string
	session      *AgentSession
	sessionEpoch uint64
	lastAuth     AuthSnapshot
	authValid    bool

	runtimeState          string
	runtimeWorkerID       string
	runtimeLastHeartbeat  time.Time
	runtimeVisible        bool
	runtimeActiveRunCount uint32
	chatRuntimeProbeAt    time.Time

	// settingsSnapshot caches this Agent's most recent settings sync (the basis for feature gating).
	settingsSnapshotMu sync.RWMutex
	settingsSnapshot   map[string]any

	// terminalSessions caches this Agent's terminal session snapshot (replayed when a browser attaches).
	terminalSessionsMu sync.Mutex
	terminalSessions   map[string]*gatewayv2.TerminalSession

	// chatQueueSnapshots caches each of this Agent's sessions' prompt queue snapshots.
	chatQueueSnapshotsMu sync.Mutex
	chatQueueSnapshots   map[string]chatQueueSnapshotRecord

	// terminalStreamToAgent is the inbound channel of this Agent's terminal data-plane connection;
	// revoke closes the connection owning the channel, so credential rotation and deletion can
	// revoke both the control plane and the terminal data plane at once.
	terminalStreamMu      sync.Mutex
	terminalStreamToAgent chan *gatewayv2.TerminalStreamFrame
	terminalStreamRevoke  func()
}

func newAgentEntry(id string) *agentEntry {
	return &agentEntry{
		id:                 id,
		terminalSessions:   make(map[string]*gatewayv2.TerminalSession),
		chatQueueSnapshots: make(map[string]chatQueueSnapshotRecord),
	}
}

func newSessionRegistry() *sessionRegistry {
	return &sessionRegistry{agents: make(map[string]*agentEntry)}
}

// normalizeAgentKey normalizes the map key form of agent_id (trims whitespace).
func normalizeAgentKey(agentID string) string {
	return strings.TrimSpace(agentID)
}

// entryLocked gets or creates the registration entry for agent_id; an empty id creates no entry.
// The caller must hold the write lock.
func (r *sessionRegistry) entryLocked(agentID string) *agentEntry {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return nil
	}
	entry := r.agents[agentID]
	if entry == nil {
		entry = newAgentEntry(agentID)
		r.agents[agentID] = entry
	}
	return entry
}

// resolveOnlineLocked resolves the online registration entry exactly by a non-empty agent_id.
// The caller must hold the lock (a read lock suffices).
func (r *sessionRegistry) resolveOnlineLocked(agentID string) (*agentEntry, error) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return nil, ErrAgentIDRequired
	}
	if entry := r.agents[agentID]; entry != nil && entry.session != nil {
		return entry, nil
	}
	return nil, ErrAgentOffline
}

// entryForSessionLocked reverse-looks-up the registration entry owning a session; returns nil when
// the session has been displaced/cleared, so late heartbeats and runtime reports from an old
// connection do not pollute the new session.
func (r *sessionRegistry) entryForSessionLocked(session *AgentSession) *agentEntry {
	if session == nil {
		return nil
	}
	entry := r.agents[strings.TrimSpace(session.AgentID)]
	if entry == nil || entry.session != session {
		return nil
	}
	return entry
}

// entryFor returns the registration entry for a non-empty agent_id (possibly offline); returns nil
// when it does not exist or the id is empty. Snapshot reads/writes use the entry's own fine-grained
// lock; the registry lock only protects map lookups.
func (m *Manager) entryFor(agentID string) *agentEntry {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return nil
	}
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return m.registry.agents[agentID]
}

// entryOrCreate gets or creates the registration entry for a non-empty agent_id; returns nil for an empty id.
func (m *Manager) entryOrCreate(agentID string) *agentEntry {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return nil
	}
	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	return m.registry.entryLocked(agentID)
}

// resolveEntry resolves the online registration entry exactly by a non-empty agent_id.
func (m *Manager) resolveEntry(agentID string) (*agentEntry, error) {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return m.registry.resolveOnlineLocked(agentID)
}

// ResolveAgentID returns the online agent_id that the request explicitly targets; an empty id returns ErrAgentIDRequired.
func (m *Manager) ResolveAgentID(agentID string) (string, error) {
	entry, err := m.resolveEntry(agentID)
	if err != nil {
		return "", err
	}
	return entry.id, nil
}

// Tagged attaches a source agent_id to broadcast events. Hub subscriptions stay global (one
// subscription per browser connection), and consumers filter/frame events by tag; the tag always
// comes from the authenticated session's AgentID, the single source of truth for cross-Agent isolation.
type Tagged[T any] struct {
	AgentID string
	Event   T
}

type syncHub struct {
	historyMu          sync.Mutex
	nextHistorySubID   int
	historySubscribers map[int]chan Tagged[*gatewayv2.HistorySyncEvent]

	settingsMu          sync.Mutex
	nextSettingsSubID   int
	settingsSubscribers map[int]chan Tagged[*gatewayv2.SettingsSyncEvent]

	terminalMu          sync.Mutex
	nextTerminalSubID   int
	terminalSubscribers map[int]chan Tagged[*gatewayv2.TerminalEvent]

	terminalStreamMu          sync.Mutex
	nextTerminalStreamSubID   int
	terminalStreamSubscribers map[int]chan Tagged[*gatewayv2.TerminalStreamFrame]

	sftpMu          sync.Mutex
	nextSftpSubID   int
	sftpSubscribers map[int]chan Tagged[*gatewayv2.SftpEvent]

	chatQueueMu          sync.Mutex
	nextChatQueueSubID   int
	chatQueueSubscribers map[int]chan Tagged[*gatewayv2.ChatQueueEvent]
}

func newSyncHub() *syncHub {
	return &syncHub{
		historySubscribers:        make(map[int]chan Tagged[*gatewayv2.HistorySyncEvent]),
		settingsSubscribers:       make(map[int]chan Tagged[*gatewayv2.SettingsSyncEvent]),
		terminalSubscribers:       make(map[int]chan Tagged[*gatewayv2.TerminalEvent]),
		terminalStreamSubscribers: make(map[int]chan Tagged[*gatewayv2.TerminalStreamFrame]),
		sftpSubscribers:           make(map[int]chan Tagged[*gatewayv2.SftpEvent]),
		chatQueueSubscribers:      make(map[int]chan Tagged[*gatewayv2.ChatQueueEvent]),
	}
}
