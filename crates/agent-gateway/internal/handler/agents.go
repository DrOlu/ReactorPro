package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Agent directory and credential management API (mounted under the admin token middleware):
//   GET    /api/agents?page=&page_size=&status=all|online|offline — paginated, filtered Agent directory
//   POST   /api/agents/{id}/token         — issue/rotate credentials and immediately kick the agent offline (the plaintext appears only in this response)
//   PATCH  /api/agents/{id}               — change the optional name
//   DELETE /api/agents/{id}               — delete the whole record and disconnect active sessions

// agentDirectoryEntry merges the persisted registration, standalone credential info, and live session
// state.
type agentDirectoryEntry struct {
	AgentID        string `json:"agent_id"`
	Online         bool   `json:"online"`
	HasToken       bool   `json:"has_token"`
	RegisteredAt   string `json:"registered_at"`
	TokenCreatedAt string `json:"token_created_at,omitempty"`
	Name           string `json:"name"`

	AgentVersion   string `json:"agent_version,omitempty"`
	ConnectedSince int64  `json:"connected_since,omitempty"`
}

// ListAgents returns the persisted Agent directory filtered by status and paginated, while merging
// the current page's live state.
func ListAgents(sm *session.Manager, tokens *agenttoken.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		statusFilter, err := agenttoken.ParseStatusFilter(r.URL.Query().Get("status"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid status filter")
			return
		}

		// The same status snapshot is used both for database filtering and current-page state merging,
		// avoiding a race between two reads.
		statusesByAgentID, onlineAgentIDs := sm.AgentDirectoryStatusSnapshot()

		page, err := tokens.List(agenttoken.PageParams{
			Page:           atoiDefault(r.URL.Query().Get("page"), 0),
			PageSize:       atoiDefault(r.URL.Query().Get("page_size"), 0),
			Status:         statusFilter,
			OnlineAgentIDs: onlineAgentIDs,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "list agents failed")
			return
		}

		agents := make([]agentDirectoryEntry, 0, len(page.Entries))
		for _, entry := range page.Entries {
			row := agentDirectoryEntry{
				AgentID:      entry.AgentID,
				HasToken:     entry.HasToken,
				RegisteredAt: entry.RegisteredAt.UTC().Format(time.RFC3339),
				Name:         entry.Name,
			}
			if entry.HasToken {
				row.TokenCreatedAt = entry.TokenCreatedAt.UTC().Format(time.RFC3339)
			}
			if status, ok := statusesByAgentID[entry.AgentID]; ok {
				row.Online = status.Online
				row.AgentVersion = status.AgentVersion
				row.ConnectedSince = status.ConnectedSince
			}
			agents = append(agents, row)
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"agents":    agents,
			"page":      page.Page,
			"page_size": page.PageSize,
			"total":     page.Total,
			"has_more":  page.HasMore,
		})
	}
}

// atoiDefault parses a non-negative integer query parameter, falling back to fallback when invalid/
// absent (clamping is left to the Store).
func atoiDefault(raw string, fallback int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	if n, err := strconv.Atoi(raw); err == nil && n >= 0 {
		return n
	}
	return fallback
}

func IssueAgentToken(sm *session.Manager, tokens *agenttoken.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		agentID, err := agenttoken.NormalizeAgentID(r.PathValue("id"))
		if err != nil {
			writeAgentStoreError(w, err)
			return
		}
		name, err := decodeAgentName(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		token, err := tokens.Issue(agentID, name)
		if err != nil {
			writeAgentStoreError(w, err)
			return
		}
		disconnected := sm != nil && sm.DisconnectAgent(agentID)
		// The plaintext appears only in this response; after rotation the old credential is immediately
		// unusable for the next connection.
		writeJSON(w, http.StatusOK, map[string]any{
			"agent_id":     agentID,
			"token":        token,
			"disconnected": disconnected,
		})
	}
}

func UpdateAgentName(tokens *agenttoken.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		agentID := strings.TrimSpace(r.PathValue("id"))
		if agentID == "" {
			writeAgentStoreError(w, agenttoken.ErrAgentIDRequired)
			return
		}
		name, err := decodeAgentName(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		if err := tokens.UpdateName(agentID, name); err != nil {
			writeAgentStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"agent_id": agentID, "name": strings.TrimSpace(name)})
	}
}

func DeleteAgent(sm *session.Manager, tokens *agenttoken.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		agentID := strings.TrimSpace(r.PathValue("id"))
		if agentID == "" {
			writeAgentStoreError(w, agenttoken.ErrAgentIDRequired)
			return
		}
		deleted, err := tokens.Delete(agentID)
		if err != nil {
			writeAgentStoreError(w, err)
			return
		}
		if !deleted {
			writeAgentStoreError(w, agenttoken.ErrAgentNotFound)
			return
		}
		disconnected := sm.ForgetAgent(agentID)
		writeJSON(w, http.StatusOK, map[string]any{
			"agent_id":     agentID,
			"deleted":      true,
			"disconnected": disconnected,
		})
	}
}

type agentNameRequest struct {
	Name string `json:"name"`
}

func decodeAgentName(r *http.Request) (string, error) {
	if r.Body == nil || r.ContentLength == 0 {
		return "", nil
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4097))
	decoder.DisallowUnknownFields()
	var payload agentNameRequest
	if err := decoder.Decode(&payload); err != nil {
		if errors.Is(err, io.EOF) {
			return "", nil
		}
		return "", errors.New("invalid request body")
	}
	return payload.Name, nil
}

func writeAgentStoreError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, agenttoken.ErrAgentIDRequired),
		errors.Is(err, agenttoken.ErrInvalidAgentID),
		errors.Is(err, agenttoken.ErrAgentNameTooLong):
		status = http.StatusBadRequest
	case errors.Is(err, agenttoken.ErrAgentNotFound):
		status = http.StatusNotFound
	}
	writeJSON(w, status, map[string]any{"error": err.Error()})
}
