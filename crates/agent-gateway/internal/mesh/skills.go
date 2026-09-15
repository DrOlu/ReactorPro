package mesh

import (
	"context"
	"slices"
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
	// SkillTaskGet returns the creating caller's task by id. Served only when
	// a task store is configured, and scoped to the caller: another caller
	// asking for the same id is told the task does not exist.
	SkillTaskGet = "task.get"
	// SkillTaskCancel stops the creating caller's task. Idempotent — a cancel
	// of a finished task reports the task's real state rather than failing.
	SkillTaskCancel = "task.cancel"
	// SkillTaskRetry re-runs the creating caller's failed or canceled task,
	// under the same id. The manual-resume primitive: a long task that
	// outlived a restart or a runtime budget is one call from running again.
	SkillTaskRetry = "task.retry"
)

// builtinSkillIDs is the served set, in a stable order for the UI and tests.
// The task skills are conditionally registered (they need durable storage to
// keep their promises), so the manifest reflects what this edge can really
// do — see registerBuiltinSkills.
var builtinSkillIDs = []string{SkillPing, SkillDescribe, SkillStatus}

// BuiltinSkillIDs returns the ids of the skills this bridge can serve.
func BuiltinSkillIDs() []string {
	out := make([]string, len(builtinSkillIDs))
	copy(out, builtinSkillIDs)
	return out
}

// servableSkillIDs lists every id that may be named in the skill allowlist: the
// read-only built-ins, the task skills, and the gated invoke skill.
//
// Kept separate from BuiltinSkillIDs so that adding `invoke` to what an operator
// may select does not also enrol it in the read-only registration path, which
// assumes every id has a side-effect-free handler. The task skills are always
// acceptable names even though they only register with a task store, so an
// operator's allowlist does not have to track this edge's storage.
func servableSkillIDs() []string {
	return append(append(BuiltinSkillIDs(), SkillTaskGet, SkillTaskCancel, SkillTaskRetry), SkillInvoke)
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
	// The task skills are registered only when a task store is installed: a
	// task handle from an edge that forgets tasks on restart would be a
	// promise nothing could keep, so the edge does not advertise what it
	// cannot honour. The allowlist still accepts the ids either way, so an
	// operator's config does not have to track this edge's storage.
	if m.taskStoreSnapshot() != nil {
		handlers[SkillTaskGet] = m.skillTaskGet
		handlers[SkillTaskCancel] = m.skillTaskCancel
		handlers[SkillTaskRetry] = m.skillTaskRetry
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
	for id, handler := range handlers {
		if slices.Contains(builtinSkillIDs, id) {
			continue
		}
		if !config.servesSkill(id) {
			continue
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
