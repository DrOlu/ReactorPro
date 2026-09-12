package shared

import (
	"strings"

	"google.golang.org/protobuf/proto"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Terminal relay domain logic (permission gating, list merging/filtering,
// interest registration): reuses the existing handler implementation with
// unchanged behavior, shared by v2 so each caller does not duplicate the gating
// rules.

// TerminalFeaturesEnabled reports whether any web terminal feature is enabled.
func TerminalFeaturesEnabled(sm session.AgentView) bool {
	return sm.WebTerminalEnabled() || sm.WebSshTerminalEnabled()
}

// TerminalSessionAllowed checks, by session kind (local/ssh), whether the session is visible to the web side.
func TerminalSessionAllowed(sm session.AgentView, ts *gatewayv2.TerminalSession) bool {
	if ts == nil {
		return false
	}
	if TerminalSessionKindOf(ts) == "ssh" {
		return sm.WebSshTerminalEnabled()
	}
	return sm.WebTerminalEnabled()
}

// TerminalSessionKindOf normalizes the session kind (empty is treated as local).
func TerminalSessionKindOf(ts *gatewayv2.TerminalSession) string {
	if strings.TrimSpace(ts.GetKind()) == "ssh" {
		return "ssh"
	}
	return "local"
}

// TerminalEventAllowed reports whether a terminal event may be pushed to the web side.
func TerminalEventAllowed(sm session.AgentView, event *gatewayv2.TerminalEvent) bool {
	if event == nil {
		return false
	}
	if strings.TrimSpace(event.GetKind()) == "ssh_tabs_updated" {
		return sm.WebSshTerminalEnabled()
	}
	// Port-forward events follow SSH permissions only: when the session cache is
	// missing, they must not fall back to the local-terminal gate.
	if strings.TrimSpace(event.GetKind()) == "ssh_local_forward" {
		return sm.WebSshTerminalEnabled()
	}
	if ts := event.GetSession(); ts != nil {
		return TerminalSessionAllowed(sm, ts)
	}
	sessionID := strings.TrimSpace(event.GetSessionId())
	if sessionID != "" && sm.TerminalSessionKind(sessionID) == "ssh" {
		return sm.WebSshTerminalEnabled()
	}
	return sm.WebTerminalEnabled()
}

// TerminalRequestAllowed gates permissions by action and target session kind.
func TerminalRequestAllowed(sm session.AgentView, action string, sessionID string) bool {
	switch action {
	case "create_ssh", "answer_ssh_prompt", "cancel_ssh_prompt", "ssh_latency",
		"ssh_reconnect", "ssh_tabs_list", "ssh_tab_open", "ssh_tab_close",
		"ssh_local_forward_start", "ssh_local_forward_list", "ssh_local_forward_stop",
		"ssh_local_forward_check_port":
		return sm.WebSshTerminalEnabled()
	case "list", "close_project":
		return sm.WebTerminalEnabled() || sm.WebSshTerminalEnabled()
	case "rename", "close":
		if sm.TerminalSessionKind(sessionID) == "ssh" {
			return sm.WebSshTerminalEnabled()
		}
		return sm.WebTerminalEnabled()
	default:
		return sm.WebTerminalEnabled()
	}
}

// TerminalPermissionError returns a user-readable error message for a denied action.
func TerminalPermissionError(action string) string {
	switch action {
	case "create_ssh", "answer_ssh_prompt", "cancel_ssh_prompt", "ssh_latency",
		"ssh_reconnect", "ssh_tabs_list", "ssh_tab_open", "ssh_tab_close",
		"ssh_local_forward_start", "ssh_local_forward_list", "ssh_local_forward_stop",
		"ssh_local_forward_check_port":
		return "web SSH terminal is disabled in desktop Remote settings"
	default:
		return "web terminal is disabled in desktop Remote settings"
	}
}

// FinalizeTerminalResponse performs unified post-processing: merge list results with the cached snapshot, write the snapshot back, filter by permissions, and register project interest.
func FinalizeTerminalResponse(
	sm session.AgentView,
	tracker *TerminalInterestTracker,
	action string,
	projectPathKey string,
	resp *gatewayv2.TerminalResponse,
) *gatewayv2.TerminalResponse {
	resp = MergeTerminalListWithCachedSnapshot(sm, action, projectPathKey, resp)
	sm.ApplyTerminalResponseSnapshot(action, projectPathKey, resp)
	resp = FilterTerminalResponseForPermissions(sm, action, resp)
	RememberTerminalInterest(tracker, action, projectPathKey, resp)
	return resp
}

// MergeTerminalListWithCachedSnapshot merges sessions that are missing from the
// desktop list response but still present in the gateway cache into the result
// (the list may be incomplete early after a desktop reconnect).
func MergeTerminalListWithCachedSnapshot(
	sm session.AgentView,
	action string,
	projectPathKey string,
	resp *gatewayv2.TerminalResponse,
) *gatewayv2.TerminalResponse {
	if resp == nil || strings.TrimSpace(action) != "list" {
		return resp
	}
	cachedSessions := sm.TerminalSessionSnapshot(projectPathKey)
	if len(cachedSessions) == 0 {
		return resp
	}
	seen := make(map[string]struct{}, len(resp.GetSessions()))
	for _, ts := range resp.GetSessions() {
		id := strings.TrimSpace(ts.GetId())
		if id != "" {
			seen[id] = struct{}{}
		}
	}
	merged := make([]*gatewayv2.TerminalSession, 0, len(resp.GetSessions())+len(cachedSessions))
	merged = append(merged, resp.GetSessions()...)
	changed := false
	for _, ts := range cachedSessions {
		id := strings.TrimSpace(ts.GetId())
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		merged = append(merged, ts)
		changed = true
	}
	if !changed {
		return resp
	}
	clone := proto.CloneOf(resp)
	clone.Sessions = merged
	return clone
}

// FilterTerminalResponseForPermissions filters out sessions the web side is not allowed to see.
func FilterTerminalResponseForPermissions(
	sm session.AgentView,
	action string,
	resp *gatewayv2.TerminalResponse,
) *gatewayv2.TerminalResponse {
	if resp == nil || action != "list" {
		return resp
	}
	filtered := make([]*gatewayv2.TerminalSession, 0, len(resp.GetSessions()))
	changed := false
	for _, ts := range resp.GetSessions() {
		if TerminalSessionAllowed(sm, ts) {
			filtered = append(filtered, ts)
		} else {
			changed = true
		}
	}
	if !changed {
		return resp
	}
	clone := proto.CloneOf(resp)
	clone.Sessions = filtered
	return clone
}

// RememberTerminalInterest registers project interest after list/create actions, for use in terminal event filtering.
func RememberTerminalInterest(
	tracker *TerminalInterestTracker,
	action string,
	projectPathKey string,
	resp *gatewayv2.TerminalResponse,
) {
	if tracker == nil {
		return
	}
	projectPathKey = strings.TrimSpace(projectPathKey)
	if respSession := resp.GetSession(); respSession != nil {
		if projectPathKey == "" {
			projectPathKey = strings.TrimSpace(respSession.GetProjectPathKey())
		}
	}

	switch action {
	case "list", "create", "create_ssh", "answer_ssh_prompt", "close_project":
		tracker.RememberProject(projectPathKey)
	}
}
