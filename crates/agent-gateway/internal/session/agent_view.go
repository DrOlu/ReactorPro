package session

import (
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// AgentView is a read-only adapter view bound to a single non-empty agent_id:
// it exposes Agent-scoped state through unified gating/snapshot methods, and
// the protocol layer and shared domain logic access it through this view.
type AgentView struct {
	m       *Manager
	agentID string
}

func (m *Manager) AgentView(agentID string) AgentView {
	return AgentView{m: m, agentID: strings.TrimSpace(agentID)}
}

func (v AgentView) resolvedID() string {
	return v.agentID
}

func (v AgentView) AgentID() string { return v.agentID }

// ResolvedAgentID returns the agent_id the view is bound to.
func (v AgentView) ResolvedAgentID() string { return v.resolvedID() }

func (v AgentView) WebTerminalEnabled() bool {
	return v.m.WebTerminalEnabled(v.resolvedID())
}

func (v AgentView) WebSshTerminalEnabled() bool {
	return v.m.WebSshTerminalEnabled(v.resolvedID())
}

func (v AgentView) WebGitEnabled() bool {
	return v.m.WebGitEnabled(v.resolvedID())
}

func (v AgentView) WebTunnelsEnabled() bool {
	return v.m.WebTunnelsEnabled(v.resolvedID())
}

func (v AgentView) TerminalSessionKind(sessionID string) string {
	return v.m.TerminalSessionKind(v.resolvedID(), sessionID)
}

func (v AgentView) TerminalSessionSnapshot(projectPathKey string) []*gatewayv2.TerminalSession {
	return v.m.TerminalSessionSnapshot(v.resolvedID(), projectPathKey)
}

func (v AgentView) ApplyTerminalResponseSnapshot(
	action string,
	projectPathKey string,
	resp *gatewayv2.TerminalResponse,
) {
	v.m.ApplyTerminalResponseSnapshot(v.resolvedID(), action, projectPathKey, resp)
}
