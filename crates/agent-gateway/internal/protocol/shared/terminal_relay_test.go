package shared

import (
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

// SSH local port forwarding actions must go through the SSH terminal gate: missing from the
// allowlist they fall into the default branch and are wrongly allowed/blocked by the local
// terminal toggle (enableWebTerminal).
func TestTerminalRequestAllowedGatesSshLocalForwardOnSshToggle(t *testing.T) {
	actions := []string{
		"ssh_local_forward_start",
		"ssh_local_forward_list",
		"ssh_local_forward_stop",
		"ssh_local_forward_check_port",
	}

	manager := session.NewManager()
	manager.ApplySettingsJSON("test-agent", `{"remote":{"enableWebTerminal":true,"enableWebSshTerminal":false}}`)
	view := manager.AgentView("test-agent")
	for _, action := range actions {
		if TerminalRequestAllowed(view, action, "") {
			t.Fatalf("action %q must not be allowed by the local terminal toggle", action)
		}
		if TerminalPermissionError(action) != "web SSH terminal is disabled in desktop Remote settings" {
			t.Fatalf("action %q must report the SSH permission error", action)
		}
	}

	manager.ApplySettingsJSON("test-agent", `{"remote":{"enableWebTerminal":false,"enableWebSshTerminal":true}}`)
	for _, action := range actions {
		if !TerminalRequestAllowed(view, action, "") {
			t.Fatalf("action %q must be allowed once web SSH terminal is enabled", action)
		}
	}
}

// Forwarding events carry no session payload, so gating must decide on the SSH toggle directly
// from the kind, and must not fall back to the local terminal gate inferred from the session cache.
func TestTerminalEventAllowedGatesSshLocalForwardKind(t *testing.T) {
	event := &gatewayv2.TerminalEvent{
		Kind:           "ssh_local_forward",
		SessionId:      "ssh-1",
		ProjectPathKey: "/project",
	}

	manager := session.NewManager()
	manager.ApplySettingsJSON("test-agent", `{"remote":{"enableWebTerminal":true,"enableWebSshTerminal":false}}`)
	view := manager.AgentView("test-agent")
	if TerminalEventAllowed(view, event) {
		t.Fatal("ssh_local_forward events must not pass with only the local terminal enabled")
	}

	manager.ApplySettingsJSON("test-agent", `{"remote":{"enableWebTerminal":false,"enableWebSshTerminal":true}}`)
	if !TerminalEventAllowed(view, event) {
		t.Fatal("ssh_local_forward events must pass once web SSH terminal is enabled")
	}
}
