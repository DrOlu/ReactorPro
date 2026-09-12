package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/mesh"
)

// MeshStatus reports the bridge's health, identity and peers.
func MeshStatus(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, m.Status())
	}
}

// MeshHealth is the synapse_health tool as an endpoint.
func MeshHealth(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, m.Health())
	}
}

// MeshRegister refreshes this agent's registration with the registry.
func MeshRegister(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		manifest, err := m.Register(r.Context())
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, manifest)
	}
}

// MeshDiscover lists peers, optionally filtered by capability or skill.
func MeshDiscover(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		filter := mesh.DiscoverFilter{
			Capabilities: splitQueryList(r.URL.Query().Get("capabilities")),
			SkillIDs:     splitQueryList(r.URL.Query().Get("skillIds")),
			Availability: strings.TrimSpace(r.URL.Query().Get("availability")),
		}
		agents, err := m.Discover(r.Context(), filter)
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"count": len(agents), "agents": agents})
	}
}

type meshDispatchRequest struct {
	Target    string `json:"target"`
	Skill     string `json:"skill"`
	Input     any    `json:"input"`
	TimeoutMs int    `json:"timeoutMs"`
}

// MeshDispatch sends a skill request to another agent.
func MeshDispatch(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request meshDispatchRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if strings.TrimSpace(request.Target) == "" || strings.TrimSpace(request.Skill) == "" {
			writeError(w, http.StatusBadRequest, "target and skill are required")
			return
		}
		timeout := time.Duration(request.TimeoutMs) * time.Millisecond
		response, err := m.Dispatch(r.Context(), request.Target, request.Skill, request.Input, timeout)
		if err != nil {
			// A reply envelope may accompany a skill-level failure; return it so
			// the caller can read the mesh error code.
			if response != nil {
				writeJSON(w, http.StatusBadGateway, map[string]any{
					"error":    err.Error(),
					"response": response,
				})
				return
			}
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

type meshEmitRequest struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// MeshEmit publishes an event onto the mesh.
func MeshEmit(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request meshEmitRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if strings.TrimSpace(request.Type) == "" {
			writeError(w, http.StatusBadRequest, "type is required")
			return
		}
		if err := m.Emit(r.Context(), request.Type, request.Data); err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"emitted": mesh.SubjectEventPrefix + request.Type})
	}
}

type meshSubscribeRequest struct {
	Subject string `json:"subject"`
}

// MeshSubscribe attaches an event subscription.
func MeshSubscribe(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request meshSubscribeRequest
		if r.Body != nil {
			// An empty body means "the whole event wildcard".
			_ = json.NewDecoder(r.Body).Decode(&request)
		}
		subscription, err := m.Subscribe(r.Context(), request.Subject)
		if err != nil {
			writeMeshError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, subscription)
	}
}

// MeshEvents returns the recent event history.
func MeshEvents(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		events := m.Events()
		writeJSON(w, http.StatusOK, map[string]any{"count": len(events), "events": events})
	}
}

// MeshReputation returns the reputation snapshot.
func MeshReputation(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scores := m.Reputation()
		writeJSON(w, http.StatusOK, map[string]any{"count": len(scores), "agents": scores})
	}
}

type meshApprovalRequest struct {
	Target string `json:"target"`
	Skill  string `json:"skill"`
	Input  any    `json:"input"`
}

// MeshApprovals lists pending approvals, or opens a new one with POST.
func MeshApprovals(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			pending := m.PendingApprovals()
			writeJSON(w, http.StatusOK, map[string]any{"count": len(pending), "approvals": pending})
			return
		}
		var request meshApprovalRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if strings.TrimSpace(request.Target) == "" || strings.TrimSpace(request.Skill) == "" {
			writeError(w, http.StatusBadRequest, "target and skill are required")
			return
		}
		id := m.RequestApproval(request.Target, request.Skill, request.Input)
		writeJSON(w, http.StatusAccepted, map[string]any{"approvalId": id, "status": "pending"})
	}
}

type meshApprovalDecisionRequest struct {
	Approver string `json:"approver"`
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

// MeshApprovalDecision approves or denies a pending request.
func MeshApprovalDecision(m *mesh.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.PathValue("id"))
		if id == "" {
			writeError(w, http.StatusBadRequest, "approval id is required")
			return
		}
		var request meshApprovalDecisionRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if strings.TrimSpace(request.Approver) == "" {
			writeError(w, http.StatusBadRequest, "approver is required")
			return
		}
		if err := m.Approve(id, request.Approver, request.Decision, request.Reason); err != nil {
			// Deciding removes an approval from the pending set, so consult the
			// history first: an already-resolved id is a conflict, not a 404.
			if decided, ok := m.DecidedApproval(id); ok {
				writeError(w, http.StatusConflict, fmt.Sprintf("approval %q was already %s", id, decided.Status))
				return
			}
			if strings.Contains(err.Error(), "unknown approval") {
				writeError(w, http.StatusNotFound, err.Error())
				return
			}
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"approvalId": id, "status": "decided"})
	}
}

// writeMeshError maps mesh failures onto HTTP status codes.
func writeMeshError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, mesh.ErrNotConnected):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, mesh.ErrApprovalDenied), errors.Is(err, mesh.ErrApprovalExpired):
		writeError(w, http.StatusForbidden, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}

// splitQueryList parses a comma-separated query parameter into a list.
func splitQueryList(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
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
