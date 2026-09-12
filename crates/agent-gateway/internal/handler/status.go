package handler

import (
	"net/http"

	"github.com/liveagent/agent-gateway/internal/observability"
	"github.com/liveagent/agent-gateway/internal/session"
)

// statusResponse is the global auth check and Agent directory response; it does not handle addressing a specific Agent.
type statusResponse struct {
	Agents        []session.Status `json:"agents"`
	ProtocolUsage map[string]int64 `json:"protocol_usage"`
}

func Status(sm *session.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, statusResponse{
			Agents:        sm.AgentStatuses(),
			ProtocolUsage: observability.Usage.Snapshot(),
		})
	}
}
