package session

// Headless workers in the management UI and in conversation resumes.
//
// A headless worker (reactorpro-agentd) keeps no history of its own: every
// turn runs from a blank slate and whatever transcript exists lives in THIS
// gateway's conversation store, committed by the reliable ingress. The desktop
// serves its own history through the pass-through; for a headless worker that
// path would always answer "empty", which made the worker invisible in the
// management interface even while its conversations sat fully recorded in the
// gateway.
//
// This file gives the gateway the two pieces the worker cannot provide:
//
//   - HeadlessConversationList / HeadlessConversationGet answer the browser's
//     history_list / history_get pass-throughs from the conversation store,
//     so the management UI shows a headless worker's conversations and can
//     open them like any desktop's.
//   - HeadlessResumePrompt rehydrates the prior turns of a conversation into
//     the prompt of an invoke that continues it, which is what gives a
//     stateless worker memory between sends.
//
// The honest limit: the conversation store is in-memory with a retention
// window, so a headless worker's history reaches back only as far as the
// gateway's conversation streams do (and not past a gateway restart). That is
// the same window the stream replay itself has; serving the list from
// anywhere else would invent durability the system does not have.

import (
	"encoding/json"
	"sort"
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// HeadlessWorkerCapability is the marker a headless worker declares in its
// ClientHello. The desktop declares a large capability surface of its own and
// never this one, so the presence of "agentd" is unambiguous: the agent
// behind the WebSocket is a worker that serves runs, not a chat client with
// its own history.
const HeadlessWorkerCapability = "agentd"

// HeadlessSettingsJSON is the settings_get answer the gateway serves for a
// headless worker. Two requirements drove the exact shape: the webui merges
// the payload into its settings with the incoming system object as the base,
// so workspaceProjects must be present (the merge maps over it
// unconditionally); and the execution mode must read "text" so the webui
// scopes the sidebar to "all conversations" — a worker that reports no
// workspace would otherwise leave the sidebar scoped to "none", an empty
// list that never even asks the gateway. Everything else the webui
// normalizes to its defaults on merge.
const HeadlessSettingsJSON = `{"system":{"executionMode":"text","workspaceProjects":[],"activeWorkspaceProjectId":""}}`

// headlessHistoryMaxPageSize bounds one history_list page served for a
// headless worker.
const headlessHistoryMaxPageSize = 200

// headlessResumeTurns caps how many prior turns are rehydrated into a resume
// prompt: enough for a working conversation, small enough that the prompt
// stays a prompt and not an archive.
const headlessResumeTurns = 16

// headlessResumePromptCap bounds the rehydrated transcript in bytes.
const headlessResumePromptCap = 24 * 1024

// headlessTranscriptEntry mirrors one entry of a conversation's projection.
type headlessTranscriptEntry struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// headlessTurn is one conversational turn extracted from a projection.
type headlessTurn struct {
	Kind string // "user" | "assistant"
	Text string
}

// AgentSupportsCapability reports whether the attached agent declared the
// capability in its hello. An unknown or offline agent supports nothing.
func (m *Manager) AgentSupportsCapability(agentID string, capability string) bool {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return false
	}
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	entry := m.registry.agents[agentID]
	return entry != nil && entry.session != nil && entry.session.SupportsCapability(capability)
}

// HeadlessConversationList answers a history_list for a headless worker from
// the gateway's conversation store: the conversations it ran recently, newest
// first. Page is 1-based like the browser's request; pageSize of 0 uses the
// caller's default.
func (m *Manager) HeadlessConversationList(agentID string, page, pageSize int32) *gatewayv2.HistoryListResponse {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 80
	}
	if pageSize > headlessHistoryMaxPageSize {
		pageSize = headlessHistoryMaxPageSize
	}
	summaries := m.convStreams.headlessConversationSummaries(agentID)
	total := int32(len(summaries))
	start := (page - 1) * pageSize
	if start < 0 || start >= total {
		summaries = nil
	} else if end := start + pageSize; end >= total {
		summaries = summaries[start:]
	} else {
		summaries = summaries[start:end]
	}
	return &gatewayv2.HistoryListResponse{
		Conversations: summaries,
		TotalCount:    total,
	}
}

// HeadlessConversationGet answers a history_get for a headless worker: the
// transcript of one conversation, newest entries last, as the projection
// entries the stream already serves. The entries are passed through raw —
// including fields this package does not model (the webui's entry validation
// requires an attachments array on user entries, for one), so anything the
// worker commits survives the round trip. MaxMessages of 0 returns everything
// retained.
func (m *Manager) HeadlessConversationGet(agentID, conversationID string, maxMessages int32) *gatewayv2.HistoryGetResponse {
	agentID = strings.TrimSpace(agentID)
	conversationID = strings.TrimSpace(conversationID)
	response := &gatewayv2.HistoryGetResponse{ConversationId: conversationID}
	if agentID == "" || conversationID == "" {
		return response
	}
	rawEntries, entries, updatedAt := m.convStreams.headlessConversationRawEntries(agentID, conversationID)
	if rawEntries == nil {
		return response
	}
	if maxMessages > 0 && int32(len(rawEntries)) > maxMessages {
		rawEntries = rawEntries[len(rawEntries)-int(maxMessages):]
	}
	raw, err := json.Marshal(rawEntries)
	if err != nil {
		// Entries are strings all the way down; a marshal failure means the
		// store is holding something unrepresentable, and an empty answer is
		// the honest fallback.
		return response
	}
	response.MessagesJson = string(raw)
	response.TotalMessageCount = int32(len(rawEntries))
	response.ReturnedMessageCount = int32(len(rawEntries))
	response.Conversation = headlessConversationSummary(conversationID, entries, time.Unix(updatedAt, 0))
	return response
}

// HeadlessResumePrompt rehydrates the prior turns of a conversation into the
// prompt of a run that continues it. When the conversation has nothing
// retained the prompt is returned unchanged: a resume with no memory is just
// a fresh start on the same conversation id, not an error.
func (m *Manager) HeadlessResumePrompt(agentID, conversationID, prompt string) string {
	agentID = strings.TrimSpace(agentID)
	conversationID = strings.TrimSpace(conversationID)
	if agentID == "" || conversationID == "" {
		return prompt
	}
	_, entries, _ := m.convStreams.headlessConversationRawEntries(agentID, conversationID)
	turns := headlessTurnsFromEntries(entries)
	if len(turns) == 0 {
		return prompt
	}
	return renderHeadlessResumePrompt(prompt, turns)
}

// renderHeadlessResumePrompt is the pure shape of a resume prompt: bounded to
// the newest turns, oldest dropped first, the new message last so the answer
// extraction (assistant entries after the final user entry) is unaffected.
func renderHeadlessResumePrompt(prompt string, turns []headlessTurn) string {
	if len(turns) > headlessResumeTurns {
		turns = turns[len(turns)-headlessResumeTurns:]
	}
	var builder strings.Builder
	builder.WriteString("You are continuing an existing conversation with the same requester. ")
	builder.WriteString("The transcript of the conversation so far:\n\n")
	budget := headlessResumePromptCap
	for _, turn := range turns {
		line := turn.Kind + ": " + strings.TrimSpace(turn.Text) + "\n\n"
		if len(line) > budget {
			// Keep the newest turns whole; drop whole oldest lines rather
			// than truncating a message mid-sentence.
			break
		}
		builder.WriteString(line)
		budget -= len(line)
	}
	builder.WriteString("The requester's new message: ")
	builder.WriteString(strings.TrimSpace(prompt))
	return builder.String()
}

// headlessTurnsFromEntries keeps only the conversational kinds. Tool traffic
// is context the worker can re-derive; what it needs to remember is what was
// asked and what was answered.
func headlessTurnsFromEntries(entries []headlessTranscriptEntry) []headlessTurn {
	turns := make([]headlessTurn, 0, len(entries))
	for _, entry := range entries {
		kind := strings.ToLower(strings.TrimSpace(entry.Kind))
		if kind != "user" && kind != "assistant" {
			continue
		}
		text := strings.TrimSpace(entry.Text)
		if text == "" || strings.Contains(entry.ID, ":err:") {
			continue
		}
		turns = append(turns, headlessTurn{Kind: kind, Text: text})
	}
	return turns
}

// headlessConversationSummary derives the summary the UI renders from the
// entries the store holds.
func headlessConversationSummary(conversationID string, entries []headlessTranscriptEntry, updatedAt time.Time) *gatewayv2.ConversationSummary {
	summary := &gatewayv2.ConversationSummary{
		Id:        conversationID,
		Title:     headlessConversationTitle(entries),
		UpdatedAt: updatedAt.Unix(),
	}
	if len(entries) > 0 {
		summary.MessageCount = int32(len(entries))
	}
	return summary
}

// headlessConversationTitle is the first user message, one line, bounded: the
// title of a remote-task conversation is what was asked.
func headlessConversationTitle(entries []headlessTranscriptEntry) string {
	for _, entry := range entries {
		if strings.EqualFold(strings.TrimSpace(entry.Kind), "user") {
			title := strings.TrimSpace(entry.Text)
			if line, _, found := strings.Cut(title, "\n"); found {
				title = line
			}
			if len(title) > 96 {
				title = title[:96]
			}
			return title
		}
	}
	return ""
}

// headlessConversationSummaries lists a headless worker's retained
// conversations, newest first.
func (s *conversationStreamStore) headlessConversationSummaries(agentID string) []*gatewayv2.ConversationSummary {
	s.mu.Lock()
	sources := make([]headlessConversationData, 0, 8)
	for _, stream := range s.streams {
		if stream.agentID != agentID || len(stream.events) == 0 {
			continue
		}
		if data := s.headlessDataLocked(stream); data != nil {
			sources = append(sources, *data)
		}
	}
	s.mu.Unlock()

	out := make([]*gatewayv2.ConversationSummary, 0, len(sources))
	for _, source := range sources {
		entries := source.mergedEntries()
		if entries == nil {
			// A conversation whose runs never checkpointed has nothing to
			// show; listing it would open onto an empty transcript.
			continue
		}
		summary := headlessConversationSummary(source.conversationID, entries, source.updatedAt)
		summary.CreatedAt = source.createdAt.Unix()
		out = append(out, summary)
	}
	// Newest first: the management interface is a "what has this worker been
	// doing" view.
	sort.Slice(out, func(i, j int) bool { return out[i].GetUpdatedAt() > out[j].GetUpdatedAt() })
	return out
}

// headlessConversationRawEntries returns the retained transcript of one
// conversation in two views: the raw entry objects (lossless, for serving)
// and the parsed light view (for summaries and prompts), plus its last update
// time. A nil raw result means nothing is retained.
func (s *conversationStreamStore) headlessConversationRawEntries(agentID, conversationID string) ([]json.RawMessage, []headlessTranscriptEntry, int64) {
	s.mu.Lock()
	var data *headlessConversationData
	if stream := s.streams[agentScopedKey(agentID, conversationID)]; stream != nil && len(stream.events) > 0 {
		data = s.headlessDataLocked(stream)
	}
	s.mu.Unlock()
	if data == nil {
		return nil, nil, 0
	}
	return data.mergedRawEntries(), data.mergedEntries(), data.updatedAt.Unix()
}

// headlessConversationData is a conversation's run-scoped projections,
// captured under the store lock and parsed outside it.
type headlessConversationData struct {
	conversationID string
	// runs is the run ids in first-appearance order; runEntries holds each
	// run's LAST projection (a run's checkpoints are cumulative within the
	// run, so only the last is authoritative).
	runs       []string
	runEntries map[string]string
	createdAt  time.Time
	updatedAt  time.Time
}

// headlessDataLocked collects a stream's content snapshots per run. A
// headless worker's projections are run-scoped — unlike the desktop's, which
// carry the whole conversation — so the conversation's transcript is the
// runs' latest projections concatenated in order.
func (s *conversationStreamStore) headlessDataLocked(stream *conversationStream) *headlessConversationData {
	data := &headlessConversationData{
		conversationID: stream.conversationID,
		runEntries:     map[string]string{},
		createdAt:      stream.events[0].ReceivedAt,
		updatedAt:      stream.updatedAt,
	}
	for _, event := range stream.events {
		if event.Type != StreamEventContentSnapshot {
			continue
		}
		if _, seen := data.runEntries[event.RunID]; !seen {
			data.runs = append(data.runs, event.RunID)
		}
		if raw, ok := event.Payload["entries_json"].(string); ok {
			data.runEntries[event.RunID] = raw
		}
	}
	if len(data.runs) == 0 && stream.latestSnapshot != nil && stream.latestSnapshot.RunID != "" {
		// A stream whose snapshot outlived its events (the log was evicted)
		// still has its newest projection to serve.
		data.runs = append(data.runs, stream.latestSnapshot.RunID)
		data.runEntries[stream.latestSnapshot.RunID] = stream.latestSnapshot.EntriesJSON
	}
	if len(data.runs) == 0 {
		return nil
	}
	return data
}

// mergedEntries concatenates the runs' latest projections, parsing off the
// store lock.
func (d headlessConversationData) mergedEntries() []headlessTranscriptEntry {
	var merged []headlessTranscriptEntry
	for _, runID := range d.runs {
		merged = append(merged, headlessParseEntries(d.runEntries[runID])...)
	}
	return merged
}

// mergedRawEntries is the lossless view of the same merge: the raw entry
// objects exactly as the worker committed them, so fields this package does
// not model survive serving.
func (d headlessConversationData) mergedRawEntries() []json.RawMessage {
	var merged []json.RawMessage
	for _, runID := range d.runs {
		trimmed := strings.TrimSpace(d.runEntries[runID])
		if trimmed == "" || trimmed == "[]" {
			continue
		}
		var raw []json.RawMessage
		if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
			continue
		}
		merged = append(merged, raw...)
	}
	return merged
}

// headlessParseEntries decodes a projection's entries; nil when there is
// nothing usable. Parsing happens off the store lock: the entries can be
// sizeable and no stream state is needed to decode them.
func headlessParseEntries(entriesJSON string) []headlessTranscriptEntry {
	trimmed := strings.TrimSpace(entriesJSON)
	if trimmed == "" || trimmed == "[]" {
		return nil
	}
	var entries []headlessTranscriptEntry
	if err := json.Unmarshal([]byte(trimmed), &entries); err != nil || len(entries) == 0 {
		return nil
	}
	return entries
}
