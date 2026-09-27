package mesh

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestParseSkillProxyTargets(t *testing.T) {
	got := parseSkillProxyTargets([]string{
		"  reactorpro/coronation-ws2  ",
		"",
		"reactorpro/neuralos-mac-001",
		"reactorpro/coronation-ws2", // duplicate
	})
	if len(got) != 2 {
		t.Fatalf("expected 2 deduped targets, got %d: %v", len(got), got)
	}
	if got[0] != "reactorpro/coronation-ws2" || got[1] != "reactorpro/neuralos-mac-001" {
		t.Fatalf("targets not trimmed/order-preserving: %v", got)
	}
	if len(parseSkillProxyTargets(nil)) != 0 {
		t.Fatal("nil input must yield an empty list")
	}
}

func TestProxyTargetAllowed(t *testing.T) {
	targets := []string{"reactorpro/coronation-ws2", "reactorpro/neuralos-mac-001"}
	if !proxyTargetAllowed(targets, "reactorpro/coronation-ws2") {
		t.Error("an exact allowlisted target must be allowed")
	}
	if !proxyTargetAllowed(targets, "  reactorpro/coronation-ws2 ") {
		t.Error("surrounding whitespace on the caller side must be tolerated")
	}
	if proxyTargetAllowed(targets, "reactorpro/neuralos-mac-002") {
		t.Error("an unknown target must be refused")
	}
	// Substring matches are identities, not patterns: a suffix or prefix of an
	// allowlisted id must not sneak through.
	if proxyTargetAllowed(targets, "reactorpro/coronation-ws") {
		t.Error("a substring of an allowlisted target must be refused")
	}
	if proxyTargetAllowed(nil, "reactorpro/coronation-ws2") {
		t.Error("an empty allowlist must refuse everything")
	}
}

func TestParseSkillProxyInput(t *testing.T) {
	req, err := parseSkillProxyInput(map[string]any{
		"target": "  reactorpro/coronation-ws2 ",
		"skill":  " coronation.query ",
		"args":   map[string]any{"question": "balance"},
	})
	if err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
	if req.Target != "reactorpro/coronation-ws2" || req.Skill != "coronation.query" {
		t.Fatalf("trim not applied: %+v", req)
	}
	if req.TimeoutSeconds != 0 {
		t.Fatalf("unset timeout must stay zero (edge default applies), got %d", req.TimeoutSeconds)
	}

	if _, err := parseSkillProxyInput(map[string]any{"skill": "x"}); err == nil {
		t.Error("missing target must be refused")
	}
	if _, err := parseSkillProxyInput(map[string]any{"target": "x"}); err == nil {
		t.Error("missing skill must be refused")
	}
	if _, err := parseSkillProxyInput(nil); err == nil {
		t.Error("nil input must be refused")
	}
	if _, err := parseSkillProxyInput(map[string]any{"target": "x", "skill": "y", "timeoutSeconds": -5}); err == nil {
		t.Error("a negative timeout must be refused")
	}

	clamped, err := parseSkillProxyInput(map[string]any{"target": "x", "skill": "y", "timeoutSeconds": 9999})
	if err != nil {
		t.Fatalf("an over-large timeout should be clamped, not refused: %v", err)
	}
	if clamped.TimeoutSeconds != 300 {
		t.Fatalf("timeout clamp = %d, want 300", clamped.TimeoutSeconds)
	}
}

// Harnesses reply in the synapse shape. A successful reply carries the
// handler's return under payload.result.
func TestParseProxyReplySuccess(t *testing.T) {
	envelope := &Envelope{
		Version: "0.3.0",
		Type:    "respond",
		From:    "reactorpro/coronation-ws2",
		Payload: json.RawMessage(`{"result":{"ok":true,"result":"[{\"spend\":49.62}]"}}`),
	}
	result, err := parseProxyReply(envelope, "reactorpro/coronation-ws2", "coronation.query")
	if err != nil {
		t.Fatalf("successful reply must parse: %v", err)
	}
	if !result.OK {
		t.Error("result.OK must be true for a success reply")
	}
	if !strings.Contains(string(result.Reply), "49.62") {
		t.Errorf("inner result not extracted, got: %s", string(result.Reply))
	}
	if result.Target != "reactorpro/coronation-ws2" || result.Skill != "coronation.query" {
		t.Errorf("provenance not carried: %+v", result)
	}
}

// A harness-reported error is relayed as ok=false with the harness's own code
// and message — the transport worked, the data request did not.
func TestParseProxyReplyRelaysHarnessError(t *testing.T) {
	envelope := &Envelope{
		Version: "0.3.0",
		Type:    "respond",
		From:    "reactorpro/coronation-ws2",
		Error:   &Error{Code: 3002, Message: "harness is restarting", Retryable: true},
	}
	result, err := parseProxyReply(envelope, "reactorpro/coronation-ws2", "coronation.query")
	if err != nil {
		t.Fatalf("a harness error must be relayed, not raised: %v", err)
	}
	if result.OK {
		t.Error("result.OK must be false for an error reply")
	}
	if !strings.Contains(string(result.Reply), "3002") ||
		!strings.Contains(string(result.Reply), "harness is restarting") {
		t.Errorf("harness error details lost: %s", string(result.Reply))
	}
}

func TestParseProxyReplyMalformed(t *testing.T) {
	if _, err := parseProxyReply(nil, "t", "s"); err == nil {
		t.Error("a nil envelope must be refused")
	}
	bad := &Envelope{Version: "0.3.0", Type: "respond", From: "t", Payload: json.RawMessage("not json")}
	if _, err := parseProxyReply(bad, "t", "s"); err == nil {
		t.Error("a malformed payload must be refused")
	}
}

// The skill proxy is OFF unless an operator configures targets. An
// unconfigured edge must not even advertise it.
func TestSkillProxyRegistrationIsConfigGated(t *testing.T) {
	identity, err := GenerateIdentity("drolu/reactorpro")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	// An unconfigured edge: the skill must not be registered at all.
	unconfigured := DefaultConfig()
	agent := NewAgent(unconfigured, identity, nil)
	unconfiguredManager := NewManager(unconfigured, nil)
	if err := unconfiguredManager.registerSkillProxySkill(agent); err != nil {
		t.Fatalf("registration on an unconfigured edge must be a no-op, not an error: %v", err)
	}
	for _, id := range agent.Skills() {
		if id == SkillProxy {
			t.Fatal("skillproxy must not be registered without configured targets")
		}
	}

	// A configured edge: a fresh agent and manager (a Manager snapshots its
	// config at construction) register the skill.
	cfg := DefaultConfig()
	cfg.SkillProxyTargets = []string{"reactorpro/coronation-ws2"}
	configuredAgent := NewAgent(cfg, identity, nil)
	configuredManager := NewManager(cfg, nil)
	if err := configuredManager.registerSkillProxySkill(configuredAgent); err != nil {
		t.Fatalf("registration with targets failed: %v", err)
	}
	found := false
	for _, id := range configuredAgent.Skills() {
		if id == SkillProxy {
			found = true
		}
	}
	if !found {
		t.Fatal("skillproxy must be registered once targets are configured")
	}
}

// The handler's gates fail closed, in order, before any dispatch is attempted.
// No NATS connection exists in this test — reaching the dispatch gate would
// only be possible if the earlier gates leaked.
func TestSkillProxyHandlerGates(t *testing.T) {
	identity, err := GenerateIdentity("drolu/reactorpro")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	cfg := DefaultConfig()
	cfg.SkillProxyTargets = []string{"reactorpro/coronation-ws2"}
	manager := NewManager(cfg, nil)
	meta := RequestMeta{From: "peer/x/y", Verified: true}
	_ = identity

	// Gate 2 — an unverified caller is refused even with a valid input.
	unverified := meta
	unverified.Verified = false
	_, err = manager.skillProxy(context.Background(),
		map[string]any{"target": "reactorpro/coronation-ws2", "skill": "coronation.query",
			"args": map[string]any{"question": "balance"}},
		unverified)
	if err == nil || !strings.Contains(err.Error(), "verified identity") {
		t.Fatalf("unverified caller must hit the identity gate, got: %v", err)
	}

	// Gate 3 — a verified caller naming an off-allowlist target is refused.
	_, err = manager.skillProxy(context.Background(),
		map[string]any{"target": "reactorpro/unknown-harness", "skill": "coronation.query"}, meta)
	if err == nil || !strings.Contains(err.Error(), "allowlist") {
		t.Fatalf("off-allowlist target must hit the allowlist gate, got: %v", err)
	}

	// Gate 4 — with no live mesh connection, the proxy reports unavailability
	// rather than attempting a dispatch it cannot make.
	_, err = manager.skillProxy(context.Background(),
		map[string]any{"target": "reactorpro/coronation-ws2", "skill": "coronation.query",
			"args": map[string]any{"question": "balance"}},
		meta)
	if err == nil || !strings.Contains(err.Error(), "no live mesh connection") {
		t.Fatalf("a missing connection must hit the transport gate, got: %v", err)
	}
}

// With no configured targets at all, gate 1 refuses everything — even a
// verified caller with an allowlisted-looking target.
func TestSkillProxyHandlerUnconfigured(t *testing.T) {
	manager := NewManager(DefaultConfig(), nil)
	meta := RequestMeta{From: "peer/x/y", Verified: true}
	_, err := manager.skillProxy(context.Background(),
		map[string]any{"target": "reactorpro/coronation-ws2", "skill": "coronation.query"}, meta)
	if err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("an unconfigured edge must refuse at gate 1, got: %v", err)
	}
}

// A harness error relay keeps the error envelope's code visible in the reply —
// exercised through parseProxyReply's error path plus the relay formatting that
// the handler uses for Dispatch-returned harness errors.
func TestSkillProxyHarnessErrorRelayShape(t *testing.T) {
	envelope := &Envelope{Version: "0.3.0", Type: "respond", From: "harness",
		Error: &Error{Code: 3002, Message: "restarting", Retryable: true}}
	result, err := parseProxyReply(envelope, "reactorpro/coronation-ws2", "coronation.query")
	if err != nil {
		t.Fatalf("relay must not error: %v", err)
	}
	var decoded struct {
		Code      int    `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	}
	if jsonErr := json.Unmarshal(result.Reply, &decoded); jsonErr != nil {
		t.Fatalf("relay reply must be valid JSON: %v", jsonErr)
	}
	if decoded.Code != 3002 || decoded.Message != "restarting" || !decoded.Retryable {
		t.Fatalf("relay lost harness error detail: %+v", decoded)
	}
}
