package session

import (
	"sort"
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

type chatQueueSnapshotRecord struct {
	event        *gatewayv2.ChatQueueEvent
	sessionEpoch uint64
}

// SubscribeChatQueueEvents subscribes to prompt queue events and replays all
// existing snapshots for every Agent (snapshots are stored per Agent in their own
// entry; replayed frames carry a source label).
func (m *Manager) SubscribeChatQueueEvents() (<-chan Tagged[*gatewayv2.ChatQueueEvent], func()) {
	replay := make([]Tagged[*gatewayv2.ChatQueueEvent], 0)
	for _, agentID := range m.knownAgentIDs() {
		entry := m.entryFor(agentID)
		if entry == nil {
			continue
		}
		entry.chatQueueSnapshotsMu.Lock()
		conversationIDs := make([]string, 0, len(entry.chatQueueSnapshots))
		for conversationID := range entry.chatQueueSnapshots {
			conversationIDs = append(conversationIDs, conversationID)
		}
		sort.Strings(conversationIDs)
		for _, conversationID := range conversationIDs {
			replay = append(replay, Tagged[*gatewayv2.ChatQueueEvent]{
				AgentID: agentID,
				Event:   cloneChatQueueEvent(entry.chatQueueSnapshots[conversationID].event),
			})
		}
		entry.chatQueueSnapshotsMu.Unlock()
	}

	m.syncHub.chatQueueMu.Lock()
	ch := make(chan Tagged[*gatewayv2.ChatQueueEvent], 128+len(replay))
	subID := m.syncHub.nextChatQueueSubID
	m.syncHub.nextChatQueueSubID += 1
	m.syncHub.chatQueueSubscribers[subID] = ch
	m.syncHub.chatQueueMu.Unlock()

	for _, event := range replay {
		ch <- event
	}

	cleanup := func() {
		m.syncHub.chatQueueMu.Lock()
		delete(m.syncHub.chatQueueSubscribers, subID)
		m.syncHub.chatQueueMu.Unlock()
	}

	return ch, cleanup
}

// knownAgentIDs returns all registered entry ids (including offline ones), in
// lexicographic order.
func (m *Manager) knownAgentIDs() []string {
	m.registry.mu.RLock()
	ids := make([]string, 0, len(m.registry.agents))
	for id := range m.registry.agents {
		ids = append(ids, id)
	}
	m.registry.mu.RUnlock()
	sort.Strings(ids)
	return ids
}

func (m *Manager) ChatQueueSnapshot(agentID, conversationID string) (*gatewayv2.ChatQueueEvent, bool) {
	key := strings.TrimSpace(conversationID)
	if key == "" {
		return nil, false
	}
	entry := m.entryFor(agentID)
	if entry == nil {
		return nil, false
	}

	entry.chatQueueSnapshotsMu.Lock()
	defer entry.chatQueueSnapshotsMu.Unlock()

	record, ok := entry.chatQueueSnapshots[key]
	if !ok {
		return nil, false
	}
	return cloneChatQueueEvent(record.event), true
}

func (m *Manager) broadcastChatQueueEvent(agentID string, event *gatewayv2.ChatQueueEvent) {
	if event == nil {
		return
	}
	normalized := cloneChatQueueEvent(event)
	conversationID := strings.TrimSpace(normalized.GetConversationId())
	if conversationID != "" {
		normalized.ConversationId = conversationID
	}
	entry := m.entryOrCreate(agentID)
	if entry == nil {
		return
	}
	sessionEpoch := m.sessionEpochOf(agentID)

	if conversationID != "" {
		entry.chatQueueSnapshotsMu.Lock()
		if existing := entry.chatQueueSnapshots[conversationID]; existing.event != nil && existing.sessionEpoch == sessionEpoch {
			existingRevision := existing.event.GetRevision()
			incomingRevision := normalized.GetRevision()
			if existingRevision > 0 && (incomingRevision == 0 || incomingRevision < existingRevision) {
				entry.chatQueueSnapshotsMu.Unlock()
				return
			}
		}
		entry.chatQueueSnapshots[conversationID] = chatQueueSnapshotRecord{
			event:        cloneChatQueueEvent(normalized),
			sessionEpoch: sessionEpoch,
		}
		entry.chatQueueSnapshotsMu.Unlock()
	}

	m.syncHub.chatQueueMu.Lock()
	subscribers := make([]chan Tagged[*gatewayv2.ChatQueueEvent], 0, len(m.syncHub.chatQueueSubscribers))
	for _, ch := range m.syncHub.chatQueueSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.chatQueueMu.Unlock()

	for _, ch := range subscribers {
		select {
		case ch <- Tagged[*gatewayv2.ChatQueueEvent]{AgentID: agentID, Event: cloneChatQueueEvent(normalized)}:
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// sessionEpochOf returns the epoch of the current session for agent_id; 0 when offline.
func (m *Manager) sessionEpochOf(agentID string) uint64 {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	if entry := m.registry.agents[normalizeAgentKey(agentID)]; entry != nil && entry.session != nil {
		return entry.sessionEpoch
	}
	return 0
}

func cloneChatQueueEvent(event *gatewayv2.ChatQueueEvent) *gatewayv2.ChatQueueEvent {
	if event == nil {
		return nil
	}
	return &gatewayv2.ChatQueueEvent{
		ConversationId: event.GetConversationId(),
		SnapshotJson:   event.GetSnapshotJson(),
		Revision:       event.GetRevision(),
	}
}
