package mesh

import (
	"context"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/observability"
)

// Built-in skill ids. These are wire contract: a peer addresses them by name, so
// they must not be renamed without a protocol change.
const (
	// SkillPing answers liveness.
	SkillPing = "ping"
	// SkillDescribe returns this agent's manifest.
	SkillDescribe = "describe"
	// SkillStatus returns a non-sensitive operational snapshot.
	SkillStatus = "status"
)

// builtinSkillIDs is the served set, in a stable order for the UI and tests.
var builtinSkillIDs = []string{SkillPing, SkillDescribe, SkillStatus}

// BuiltinSkillIDs returns the ids of the skills this bridge can serve.
func BuiltinSkillIDs() []string {
	out := make([]string, len(builtinSkillIDs))
	copy(out, builtinSkillIDs)
	return out
}

// registerBuiltinSkills exposes the read-only introspection surface.
//
// Every skill here is deliberately read-only and free of side effects. A mesh
// that can be asked to run a shell command or touch the filesystem is a
// remote-code hole, and the value of serving anything at all is that a peer can
// see what you are — not that it can drive you. Anything that mutates state
// belongs behind its own explicit, separately gated skill rather than being
// folded in here.
//
// Registration happens before the agent connects, so the skills are present in
// the manifest the first registration publishes.
func (m *Manager) registerBuiltinSkills(agent *Agent) error {
	config := m.Config()
	if !config.SkillsEnabled {
		return nil
	}

	handlers := map[string]Handler{
		SkillPing:     m.skillPing,
		SkillDescribe: m.skillDescribe,
		SkillStatus:   m.skillStatus,
	}

	for _, id := range builtinSkillIDs {
		if !config.servesSkill(id) {
			continue
		}
		handler, ok := handlers[id]
		if !ok {
			// A built-in id with no handler is a programming error, not a runtime
			// condition; surfacing it beats silently advertising a skill that
			// answers 3001.
			return &unknownBuiltinSkillError{id: id}
		}
		agent.RegisterSkill(id, handler)
	}
	return nil
}

type unknownBuiltinSkillError struct{ id string }

func (e *unknownBuiltinSkillError) Error() string {
	return "built-in mesh skill " + e.id + " has no handler"
}

// skillPing answers liveness and touches no state, so it stays cheap under load.
func (m *Manager) skillPing(_ context.Context, _ any, _ RequestMeta) (any, error) {
	return map[string]any{
		"pong": true,
		"ts":   timestamp(),
	}, nil
}

// skillDescribe returns this agent's manifest: what it is and what it serves.
func (m *Manager) skillDescribe(_ context.Context, _ any, _ RequestMeta) (any, error) {
	agent, err := m.requireAgent()
	if err != nil {
		return nil, err
	}
	return agent.Manifest(), nil
}

// skillStatus returns an operational snapshot for a peer or an operator.
//
// Deliberately narrow. It reports this agent's own identity, readiness and mesh
// traffic counters — never anything about the desktop agents connected to it,
// their tokens, or the local API surface. A peer has no need for those, and a
// skill that leaks the fleet is worse than no skill at all.
func (m *Manager) skillStatus(_ context.Context, _ any, _ RequestMeta) (any, error) {
	agent, err := m.requireAgent()
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"agent_id":       agent.AgentID(),
		"fingerprint":    agent.Fingerprint(),
		"connected":      agent.Connected(),
		"skills":         agent.Skills(),
		"uptime_seconds": int(m.uptime().Seconds()),
		"traffic":        meshCounters(),
	}, nil
}

// uptime reports how long the current connection has been up, or zero when the
// bridge is not started.
func (m *Manager) uptime() time.Duration {
	m.mu.RLock()
	startedAt := m.startedAt
	m.mu.RUnlock()
	if startedAt.IsZero() {
		return 0
	}
	return time.Since(startedAt)
}

// meshCounters returns the mesh-specific counters from the process-wide usage
// snapshot. Filtering by prefix keeps this in step with new counters
// automatically rather than needing a second list to maintain.
func meshCounters() map[string]int64 {
	out := map[string]int64{}
	for key, value := range observability.Usage.Snapshot() {
		if strings.HasPrefix(key, "mesh_") {
			out[key] = value
		}
	}
	return out
}
