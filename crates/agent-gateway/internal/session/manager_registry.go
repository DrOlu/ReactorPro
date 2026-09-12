package session

import (
	"context"
	"sort"
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// RecordAuthentication records the authentication result for a named agent;
// subsequent connections with the same agent_id reuse that entry (entries
// survive disconnects). An empty id never creates a session entry.
func (m *Manager) RecordAuthentication(agentID, agentVersion, sessionID string) AuthSnapshot {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return AuthSnapshot{}
	}
	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	entry := m.registry.entryLocked(agentID)
	entry.lastAuth = AuthSnapshot{
		AgentID:      agentID,
		AgentVersion: strings.TrimSpace(agentVersion),
		SessionID:    strings.TrimSpace(sessionID),
	}
	entry.authValid = true
	return entry.lastAuth
}

// LatestAuthSnapshot returns the most recent auth snapshot for the given
// agent_id; an empty or unknown id returns an empty snapshot.
func (m *Manager) LatestAuthSnapshot(agentID string) AuthSnapshot {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	entry := m.registry.agents[strings.TrimSpace(agentID)]
	if entry == nil {
		return AuthSnapshot{}
	}
	return entry.lastAuth
}

// IsOnline reports whether the named agent_id is online; an empty id always
// returns false.
func (m *Manager) IsOnline(agentID string) bool {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return false
	}
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	entry := m.registry.agents[agentID]
	return entry != nil && entry.session != nil
}

// AnyAgentOnline is used only for global health and background liveness checks;
// it does not perform agent addressing.
func (m *Manager) AnyAgentOnline() bool {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	for _, entry := range m.registry.agents {
		if entry.session != nil {
			return true
		}
	}
	return false
}

// SetSession registers a session under its agent_id's entry, replacing only
// that id's previous session; sessions of different agent_ids do not affect
// each other.
func (m *Manager) SetSession(s *AgentSession) {
	m.setSession(s, nil, false)
}

// SetAuthenticatedSessionIfCurrent commits the auth result and the session as a
// single registration action. isCurrent runs under the registry write lock; when
// it returns false no offline entry is created.
func (m *Manager) SetAuthenticatedSessionIfCurrent(
	s *AgentSession,
	isCurrent func() bool,
) bool {
	return m.setSession(s, isCurrent, true)
}

func (m *Manager) setSession(
	s *AgentSession,
	isCurrent func() bool,
	recordAuthentication bool,
) bool {
	if s == nil || strings.TrimSpace(s.AgentID) == "" {
		if s != nil {
			s.Close()
		}
		return false
	}
	s.AgentID = strings.TrimSpace(s.AgentID)
	m.registry.mu.Lock()
	if isCurrent != nil && !isCurrent() {
		m.registry.mu.Unlock()
		s.Close()
		return false
	}
	entry := m.registry.entryLocked(s.AgentID)
	if recordAuthentication {
		entry.lastAuth = AuthSnapshot{
			AgentID:      s.AgentID,
			AgentVersion: strings.TrimSpace(s.AgentVersion),
			SessionID:    strings.TrimSpace(s.SessionID),
		}
		entry.authValid = true
	}
	previous := entry.session
	if entry.authValid {
		s.AgentID = entry.lastAuth.AgentID
		s.AgentVersion = entry.lastAuth.AgentVersion
		s.SessionID = entry.lastAuth.SessionID
	}
	sessionChanged := previous != s
	if sessionChanged {
		entry.sessionEpoch += 1
		clearRuntimeStatusLocked(entry)
	}
	entry.session = s
	agentID := entry.id
	m.registry.mu.Unlock()

	if sessionChanged {
		m.clearTerminalSessionSnapshot(agentID)
	}
	if previous != nil && previous != s {
		previous.Close()
	}
	if s != nil && sessionChanged {
		// Replay the watched-workdir set: a freshly connected agent starts
		// with an empty watch set and only learns a non-empty one from this
		// push. An empty set needs no replay.
		if m.hasWorkspaceWatchInterest(agentID) {
			go m.pushWorkspaceWatchSet(agentID)
		}
	}
	if sessionChanged {
		m.broadcastStatus(agentID)
	}
	return true
}

// clearSessionEntry removes the online session from the entry it belongs to; it
// is a no-op when the session has already been replaced. It returns the entry id
// and whether a removal actually happened.
func (m *Manager) clearSessionEntry(session *AgentSession) (string, bool) {
	m.registry.mu.Lock()
	entry := m.registry.entryForSessionLocked(session)
	if entry == nil {
		m.registry.mu.Unlock()
		return "", false
	}
	entry.session = nil
	clearRuntimeStatusLocked(entry)
	agentID := entry.id
	m.registry.mu.Unlock()
	return agentID, true
}

func (m *Manager) ClearSession(session *AgentSession) {
	if session == nil {
		return
	}
	agentID, cleared := m.clearSessionEntry(session)
	if !cleared {
		return
	}

	session.Close()
	m.clearTerminalSessionSnapshot(agentID)
	go m.onAgentSessionCleared(agentID)
}

func (m *Manager) ClearSessionIfHeartbeatStale(session *AgentSession, timeout time.Duration) bool {
	if session == nil || timeout <= 0 {
		return false
	}

	now := time.Now()
	m.registry.mu.Lock()
	entry := m.registry.entryForSessionLocked(session)
	if entry == nil {
		m.registry.mu.Unlock()
		return false
	}
	if lastPing := entry.session.LastPing; !lastPing.IsZero() && now.Sub(lastPing) <= timeout {
		m.registry.mu.Unlock()
		return false
	}
	entry.session = nil
	clearRuntimeStatusLocked(entry)
	agentID := entry.id
	m.registry.mu.Unlock()

	session.Close()
	m.clearTerminalSessionSnapshot(agentID)
	go m.onAgentSessionCleared(agentID)
	return true
}

// DisconnectAgent removes agent_id's control session and terminal data plane
// within the same registry critical section; it returns whether any transport
// was disconnected. The actual close runs outside the lock so callbacks do not
// block the registry.
func (m *Manager) DisconnectAgent(agentID string) bool {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return false
	}
	m.registry.mu.Lock()
	var session *AgentSession
	var terminalRevoke func()
	if entry := m.registry.agents[agentID]; entry != nil {
		session = entry.session
		if session != nil {
			entry.session = nil
			clearRuntimeStatusLocked(entry)
		}
		entry.terminalStreamMu.Lock()
		terminalRevoke = entry.terminalStreamRevoke
		entry.terminalStreamToAgent = nil
		entry.terminalStreamRevoke = nil
		entry.terminalStreamMu.Unlock()
	}
	m.registry.mu.Unlock()

	if session != nil {
		session.Close()
		go m.onAgentSessionCleared(agentID)
	}
	if terminalRevoke != nil {
		terminalRevoke()
	}
	if session != nil || terminalRevoke != nil {
		m.clearTerminalSessionSnapshot(agentID)
	}
	return session != nil || terminalRevoke != nil
}

// ForgetAgent removes agent_id from the process directory and closes its current
// session. Call this method after the persisted directory is deleted so a removed
// client does not keep showing up as an offline entry in agent_list.
func (m *Manager) ForgetAgent(agentID string) bool {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return false
	}
	m.registry.mu.Lock()
	entry := m.registry.agents[agentID]
	if entry == nil {
		m.registry.mu.Unlock()
		m.purgeAgentTunnels(agentID)
		return false
	}
	delete(m.registry.agents, agentID)
	session := entry.session
	entry.terminalStreamMu.Lock()
	terminalRevoke := entry.terminalStreamRevoke
	entry.terminalStreamToAgent = nil
	entry.terminalStreamRevoke = nil
	entry.terminalStreamMu.Unlock()
	m.registry.mu.Unlock()

	if session != nil {
		session.Close()
		go m.onAgentSessionCleared(agentID)
	}
	if terminalRevoke != nil {
		terminalRevoke()
	}
	m.purgeAgentTunnels(agentID)
	return session != nil || terminalRevoke != nil
}

// Status returns the status for the named agent_id; an empty or unknown id
// returns the zero value.
func (m *Manager) Status(agentID string) Status {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return Status{}
	}
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	entry := m.registry.agents[agentID]
	if entry == nil {
		return Status{}
	}
	return statusLocked(entry, time.Now())
}

// AgentStatuses returns the statuses of all entries (including offline ones, for
// directory rendering), sorted by agent_id.
func (m *Manager) AgentStatuses() []Status {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()

	now := time.Now()
	statuses := make([]Status, 0, len(m.registry.agents))
	for _, entry := range m.registry.agents {
		statuses = append(statuses, statusLocked(entry, now))
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].AgentID < statuses[j].AgentID })
	return statuses
}

// AgentDirectoryStatusSnapshot produces a point-in-time status index and online
// IDs for admin directory queries. The return values need no sorting, avoiding an
// extra full O(n log n) sort for paged database requests.
func (m *Manager) AgentDirectoryStatusSnapshot() (map[string]Status, []string) {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()

	now := time.Now()
	statuses := make(map[string]Status, len(m.registry.agents))
	onlineAgentIDs := make([]string, 0, len(m.registry.agents))
	for _, entry := range m.registry.agents {
		status := statusLocked(entry, now)
		statuses[status.AgentID] = status
		if status.Online {
			onlineAgentIDs = append(onlineAgentIDs, status.AgentID)
		}
	}
	return statuses, onlineAgentIDs
}

// ConnectedAgentIDs returns the list of currently online agent_ids, in
// lexicographic order.
func (m *Manager) ConnectedAgentIDs() []string {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()

	ids := make([]string, 0, len(m.registry.agents))
	for _, entry := range m.registry.agents {
		if entry.session != nil {
			ids = append(ids, entry.id)
		}
	}
	sort.Strings(ids)
	return ids
}

func statusLocked(entry *agentEntry, now time.Time) Status {
	status := Status{}
	if entry.authValid {
		status.AgentID = entry.lastAuth.AgentID
		status.AgentVersion = entry.lastAuth.AgentVersion
		status.SessionID = entry.lastAuth.SessionID
	}
	if entry.session == nil {
		if status.AgentID == "" {
			status.AgentID = entry.id
		}
		return status
	}
	status.Online = true
	status.AgentReady = true
	status.AgentID = entry.session.AgentID
	status.AgentVersion = entry.session.AgentVersion
	status.SessionID = entry.session.SessionID
	status.ConnectedSince = entry.session.ConnectedAt.Unix()
	status.LastHeartbeat = entry.session.LastPing.Unix()
	if !entry.session.SupportsCapability(gatewayv2.ChatIngressV1Capability) {
		status.RuntimeState = "protocol_incompatible"
	} else {
		status.RuntimeState = entry.runtimeState
	}
	status.RuntimeWorkerID = entry.runtimeWorkerID
	status.RuntimeVisible = entry.runtimeVisible
	status.RuntimeActiveRunCount = entry.runtimeActiveRunCount
	if !entry.runtimeLastHeartbeat.IsZero() {
		status.RuntimeLastHeartbeat = entry.runtimeLastHeartbeat.Unix()
	}
	status.ChatRuntimeReady = runtimeReadyLocked(entry, now)
	return status
}

func (m *Manager) ChatRuntimeReady(agentID string) bool {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	entry, err := m.registry.resolveOnlineLocked(agentID)
	if err != nil {
		return false
	}
	return runtimeReadyLocked(entry, time.Now())
}

func (m *Manager) ChatIngressV1Ready(agentID string) bool {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	entry, err := m.registry.resolveOnlineLocked(agentID)
	return err == nil && entry.session.SupportsCapability(gatewayv2.ChatIngressV1Capability)
}

func (m *Manager) SupportsCapability(agentID string, capability string) bool {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	entry, err := m.registry.resolveOnlineLocked(agentID)
	return err == nil && entry.session.SupportsCapability(capability)
}

// ChatRuntimeProbeEpoch returns the session epoch of the target agent; after the
// probe completes, call RecordChatRuntimeProbe with the same agent_id + epoch to
// bind the result to the connection that initiated the probe.
func (m *Manager) ChatRuntimeProbeEpoch(agentID string) (uint64, bool) {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	entry, err := m.registry.resolveOnlineLocked(agentID)
	if err != nil {
		return 0, false
	}
	return entry.sessionEpoch, true
}

func (m *Manager) RecordChatRuntimeProbe(agentID string, sessionEpoch uint64) bool {
	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	entry, err := m.registry.resolveOnlineLocked(agentID)
	if err != nil || sessionEpoch == 0 || entry.sessionEpoch != sessionEpoch {
		return false
	}
	entry.chatRuntimeProbeAt = time.Now()
	return true
}

func (m *Manager) ChatRuntimeProbeFresh(agentID string, maxAge time.Duration) bool {
	if maxAge <= 0 {
		return false
	}
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	entry, err := m.registry.resolveOnlineLocked(agentID)
	return err == nil &&
		!entry.chatRuntimeProbeAt.IsZero() &&
		time.Since(entry.chatRuntimeProbeAt) <= maxAge
}

func (m *Manager) UpdateRuntimeStatus(
	session *AgentSession,
	event *gatewayv2.RuntimeStatusEvent,
) {
	if event == nil {
		return
	}
	workerID := strings.TrimSpace(event.GetWorkerId())
	state := normalizeRuntimeState(event.GetState())
	now := time.Now()

	m.registry.mu.Lock()
	entry := m.registry.entryForSessionLocked(session)
	if entry == nil {
		m.registry.mu.Unlock()
		return
	}
	previousReady := runtimeReadyLocked(entry, now)
	changed := entry.runtimeState != state ||
		entry.runtimeWorkerID != workerID ||
		entry.runtimeVisible != event.GetVisible() ||
		entry.runtimeActiveRunCount != event.GetActiveRunCount()
	entry.runtimeState = state
	entry.runtimeWorkerID = workerID
	entry.runtimeLastHeartbeat = now
	entry.runtimeVisible = event.GetVisible()
	entry.runtimeActiveRunCount = event.GetActiveRunCount()
	changed = changed || previousReady != runtimeReadyLocked(entry, now)
	agentID := entry.id
	m.registry.mu.Unlock()

	// Runtime readiness is part of the public Status contract. Push semantic
	// transitions, but do not fan out a status frame for every heartbeat tick;
	// the low-frequency status poll reconciles timestamp-only changes.
	if changed {
		m.broadcastStatus(agentID)
	}
}

// touchRuntimeActivity refreshes the chat-runtime heartbeat when live chat
// traffic proves the desktop runtime is running, even while the webview's
// own status timer is throttled (hidden/occluded window). Only refreshes an
// already-reporting runtime: a zero heartbeat must not become readiness
// (normalizeRuntimeState("") defaults to "ready").
func (m *Manager) touchRuntimeActivity(session *AgentSession) {
	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	entry := m.registry.entryForSessionLocked(session)
	if entry == nil || entry.runtimeLastHeartbeat.IsZero() {
		return
	}
	entry.runtimeLastHeartbeat = time.Now()
}

func (m *Manager) TouchHeartbeat(session *AgentSession) {
	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	if entry := m.registry.entryForSessionLocked(session); entry != nil {
		entry.session.LastPing = time.Now()
	}
}

func clearRuntimeStatusLocked(entry *agentEntry) {
	entry.runtimeState = ""
	entry.runtimeWorkerID = ""
	entry.runtimeLastHeartbeat = time.Time{}
	entry.runtimeVisible = false
	entry.runtimeActiveRunCount = 0
	entry.chatRuntimeProbeAt = time.Time{}
}

func runtimeReadyLocked(entry *agentEntry, now time.Time) bool {
	if entry == nil || entry.session == nil {
		return false
	}
	if !entry.session.SupportsCapability(gatewayv2.ChatIngressV1Capability) {
		return false
	}
	if entry.session.LastPing.IsZero() || now.Sub(entry.session.LastPing) > agentSessionHeartbeatTTL {
		return false
	}
	if entry.runtimeLastHeartbeat.IsZero() ||
		now.Sub(entry.runtimeLastHeartbeat) > chatRuntimeReadyTTL {
		return false
	}
	switch normalizeRuntimeState(entry.runtimeState) {
	case "ready", "draining", "busy":
		return true
	default:
		return false
	}
}

func normalizeRuntimeState(state string) string {
	switch strings.TrimSpace(state) {
	case "ready", "draining", "busy", "suspended":
		return strings.TrimSpace(state)
	default:
		return defaultRuntimeReadyState
	}
}

// resolveSession resolves the online session exactly by a non-empty agentID.
func (m *Manager) resolveSession(agentID string) (*AgentSession, error) {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	entry, err := m.registry.resolveOnlineLocked(agentID)
	if err != nil {
		return nil, err
	}
	return entry.session, nil
}

func (m *Manager) SendToAgentContext(ctx context.Context, agentID string, env *gatewayv2.GatewayEnvelope) error {
	session, err := m.resolveSession(agentID)
	if err != nil {
		return err
	}
	return session.SendToAgentContext(ctx, env)
}

// RegisterStreamAndSendContext binds response correlation and request delivery
// to the same AgentSession instance. Calling RegisterStream followed by
// Manager.SendToAgentContext performs two independent current-session lookups;
// a seamless session replacement between them can register the stream on the
// old session while sending the request to the new one, making every response
// unmatchable. Capturing the session once closes that TOCTOU window.
func (m *Manager) RegisterStreamAndSendContext(
	ctx context.Context,
	agentID string,
	requestID string,
	env *gatewayv2.GatewayEnvelope,
) (<-chan *gatewayv2.AgentEnvelope, <-chan struct{}, func(), error) {
	session, err := m.resolveSession(agentID)
	if err != nil {
		return nil, nil, nil, err
	}

	stream, err := session.registerStream(requestID)
	if err != nil {
		return nil, nil, nil, err
	}
	cleanup := func() {
		session.unregisterStream(requestID, stream)
	}
	if err := session.SendToAgentContext(ctx, env); err != nil {
		cleanup()
		return nil, nil, nil, err
	}

	return stream.ch, stream.done, cleanup, nil
}
