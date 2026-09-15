package mesh

// Durable state for the mesh bridge.
//
// Three things were in memory only and therefore reset on every restart: the
// trust store's pins, per-agent reputation, and the approval history. The trust
// store is the one that matters most. With trust-on-first-use, the *first* key
// an agent id presents is remembered and any different key is refused — which is
// what detects impersonation. Reset that memory on restart and the protection
// restarts with it: whoever speaks first after a bounce becomes the pinned
// identity. Persisting turns "first use" into "first use, once, ever".

// StateStore is durable storage for mesh state that must survive a restart.
//
// Injected rather than imported, for the same reason as LocalAgentProvider and
// LocalInvoker: the mesh package decides *what* is worth remembering and knows
// nothing about *where* it is kept.
//
// Every call is best-effort at the point of use, and deliberately so. A storage
// failure is logged and the mesh carries on: losing a reputation update is
// survivable, whereas failing an inbound message because a disk write did not
// land is not. Nothing in the deliver path may depend on this succeeding.
type StateStore interface {
	LoadTrustPins() ([]PeerPin, error)
	SaveTrustPin(pin PeerPin) error

	LoadReputation() ([]Reputation, error)
	SaveReputation(record Reputation) error

	// LoadApprovals returns at most limit decided approvals, newest first.
	LoadApprovals(limit int) ([]Approval, error)
	// SaveApproval records a decided approval and keeps the stored history
	// bounded, so the table cannot grow without limit.
	SaveApproval(approval Approval, keep int) error
}

// SetStateStore installs durable storage. Callable before Start; state is
// rehydrated when the bridge starts, since the agent does not exist until then.
func (m *Manager) SetStateStore(store StateStore) {
	m.mu.Lock()
	m.stateStore = store
	m.mu.Unlock()
}

// SetTaskStore installs durable task storage. Callable before Start; an edge
// without one serves no task skills and refuses async invocation, which is
// the honest failure: a task handle from an edge that forgets tasks on
// restart would be a promise nothing could keep.
func (m *Manager) SetTaskStore(store TaskStore) {
	m.mu.Lock()
	m.taskStore = store
	m.mu.Unlock()
}

func (m *Manager) taskStoreSnapshot() TaskStore {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.taskStore
}

func (m *Manager) stateStoreSnapshot() StateStore {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.stateStore
}

// restoreState rehydrates persisted state into the running bridge.
//
// Called after the agent exists, because trust pins are seeded into it. Each
// part is independent: a failure to load reputation must not prevent the trust
// pins from being restored, since those are the security-relevant ones.
func (m *Manager) restoreState(agent *Agent) {
	store := m.stateStoreSnapshot()
	if store == nil {
		return
	}

	// Trust pins first, and loudly on failure: these are the ones that stop an
	// impersonation, and silently starting with an empty pin set is the failure
	// mode this whole file exists to remove.
	if pins, err := store.LoadTrustPins(); err != nil {
		m.logger.Error("could not load persisted mesh trust pins; "+
			"the first key seen for each peer will be re-learned", "error", err)
	} else if len(pins) > 0 {
		if agent != nil {
			agent.SeedTrustedPeers(pins)
		}
		m.logger.Info("restored mesh trust pins", "count", len(pins))
	}

	if records, err := store.LoadReputation(); err != nil {
		m.logger.Warn("could not load persisted mesh reputation", "error", err)
	} else if len(records) > 0 {
		m.reputation.restore(records)
	}

	limit := m.Config().Governance.MaxHistory
	if approvals, err := store.LoadApprovals(limit); err != nil {
		m.logger.Warn("could not load persisted mesh approvals", "error", err)
	} else if len(approvals) > 0 {
		m.governor.restore(approvals)
	}
}

// wirePersistence arranges for state learned from now on to be written back.
//
// Installed after restore so that rehydrated state is not written straight back
// out, and skipped entirely when there is no store, which keeps the no-storage
// mode free of callbacks.
func (m *Manager) wirePersistence(agent *Agent) {
	if m.stateStoreSnapshot() == nil {
		return
	}
	m.reputation.setRecorder(m.persistReputation)
	m.governor.setRecorder(m.persistApproval)
	if agent != nil {
		agent.SetTrustPinRecorder(m.persistTrustPin)
	}
}

// persistTrustPin writes a newly learned pin through to storage.
//
// Only *learned* pins are persisted. A pin from configuration is an operator
// decision that already lives in config, and writing it here would duplicate it
// into a second source of truth that could drift.
func (m *Manager) persistTrustPin(pin PeerPin) {
	store := m.stateStoreSnapshot()
	if store == nil {
		return
	}
	if err := store.SaveTrustPin(pin); err != nil {
		m.logger.Warn("could not persist mesh trust pin",
			"agentId", pin.AgentID, "error", err)
	}
}

func (m *Manager) persistReputation(record Reputation) {
	store := m.stateStoreSnapshot()
	if store == nil {
		return
	}
	if err := store.SaveReputation(record); err != nil {
		m.logger.Warn("could not persist mesh reputation",
			"agentId", record.AgentID, "error", err)
	}
}

func (m *Manager) persistApproval(approval Approval) {
	store := m.stateStoreSnapshot()
	if store == nil {
		return
	}
	if err := store.SaveApproval(approval, m.Config().Governance.MaxHistory); err != nil {
		m.logger.Warn("could not persist mesh approval",
			"approvalId", approval.ID, "error", err)
	}
}
