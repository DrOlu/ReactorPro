// Package shared holds connection-level constructs shared by the v2 protocol
// layer that belong to neither session nor wscore.
package shared

import (
	"strings"
	"sync"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// TerminalInterestTracker records the terminal session/project interest set for
// a single connection and decides whether events are forwarded: metadata events
// are broadcast, while raw output is pushed only to explicitly attached
// connections. It follows the existing implementation with unchanged behavior;
// it is concurrency-safe.
type TerminalInterestTracker struct {
	mu       sync.RWMutex
	projects map[string]struct{}
	sessions map[string]struct{}
}

// NewTerminalInterestTracker constructs an empty interest set.
func NewTerminalInterestTracker() *TerminalInterestTracker {
	return &TerminalInterestTracker{
		projects: make(map[string]struct{}),
		sessions: make(map[string]struct{}),
	}
}

// RememberProject registers interest in a project's terminal list.
func (t *TerminalInterestTracker) RememberProject(projectPathKey string) {
	projectPathKey = strings.TrimSpace(projectPathKey)
	if projectPathKey == "" {
		return
	}
	t.mu.Lock()
	t.projects[projectPathKey] = struct{}{}
	t.mu.Unlock()
}

// RememberSession registers attachment to a terminal session (and its project).
func (t *TerminalInterestTracker) RememberSession(sessionID string, projectPathKey string) {
	sessionID = strings.TrimSpace(sessionID)
	projectPathKey = strings.TrimSpace(projectPathKey)
	if sessionID == "" && projectPathKey == "" {
		return
	}
	t.mu.Lock()
	if sessionID != "" {
		t.sessions[sessionID] = struct{}{}
	}
	if projectPathKey != "" {
		t.projects[projectPathKey] = struct{}{}
	}
	t.mu.Unlock()
}

// Forget detaches a session; when only a project key is given it removes
// interest in that project.
func (t *TerminalInterestTracker) Forget(sessionID string, projectPathKey string) {
	sessionID = strings.TrimSpace(sessionID)
	projectPathKey = strings.TrimSpace(projectPathKey)
	t.mu.Lock()
	if sessionID != "" {
		delete(t.sessions, sessionID)
	}
	if sessionID == "" && projectPathKey != "" {
		delete(t.projects, projectPathKey)
	}
	t.mu.Unlock()
}

// ShouldForward decides whether a terminal event should be pushed to this
// connection.
func (t *TerminalInterestTracker) ShouldForward(event *gatewayv2.TerminalEvent) bool {
	if event == nil {
		return false
	}
	sessionID := strings.TrimSpace(event.GetSessionId())
	projectPathKey := strings.TrimSpace(event.GetProjectPathKey())
	kind := strings.TrimSpace(event.GetKind())

	// Metadata changes are broadcast to all tabs to keep lists fresh; raw output
	// is pushed only to explicitly attached connections.
	if kind != "output" {
		return sessionID != "" || projectPathKey != ""
	}

	t.mu.RLock()
	_, sessionSubscribed := t.sessions[sessionID]
	t.mu.RUnlock()

	return sessionID != "" && sessionSubscribed
}
