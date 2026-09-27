package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/observability"
)

// SkillProxy is the reserved skill a verified peer calls to reach a *local
// skill server* behind this edge — a raw-synapse harness (for example a
// neuralOS instance bridge) that serves fixed skills on this edge's own NATS
// connection but has no mesh identity of its own.
//
// It exists because the invoke skill routes only to desktop agents, and a
// harness is not one: it cannot attach to the gateway's agent WebSocket, so
// without this skill its data is unreachable from the mesh. The proxy keeps the
// harness out of the identity business: the caller presents a verified identity
// to *this edge*, and this edge makes the local request over its own
// connection, exactly as the invoke skill does for desktop agents.
//
// The exposure is deliberate and narrow: the target allowlist
// (Config.SkillProxyTargets) names the harnesses that may be reached, and an
// empty list disables the skill entirely. Harnesses served this way are
// expected to be read-only data probes; anything with side effects should not
// be listed.
// DefaultSkillProxyTimeout bounds one proxied request when the caller does not
// name a timeout.
const DefaultSkillProxyTimeout = 90 * time.Second

// SkillProxyRequest is the invoke input shape for the proxy skill.
type SkillProxyRequest struct {
	// Target is the local harness's mesh agent id, e.g.
	// "reactorpro/coronation-ws2". It must appear verbatim in the
	// SkillProxyTargets allowlist.
	Target string `json:"target"`
	// Skill is the skill name to invoke on the harness, e.g.
	// "coronation.query". The name is forwarded as-is; this edge treats it as
	// opaque.
	Skill string `json:"skill"`
	// Args is the skill's argument object, forwarded untouched.
	Args any `json:"args,omitempty"`
	// TimeoutSeconds bounds the proxied request. Zero uses the edge's
	// configured default. Clamped to [1s, 5m].
	TimeoutSeconds int `json:"timeoutSeconds,omitempty"`
}

// SkillProxyResult is the proxy's answer: the harness's own reply, wrapped so
// a caller can tell transport provenance from data.
type SkillProxyResult struct {
	Target string          `json:"target"`
	Skill  string          `json:"skill"`
	OK     bool            `json:"ok"`
	Reply  json.RawMessage `json:"reply,omitempty"`
}

// parseSkillProxyTargets normalises an operator-supplied target list: trimmed,
// de-duplicated, empty entries dropped. Order is preserved (it is allowlist
// data, not a set).
func parseSkillProxyTargets(raw []string) []string {
	out := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, entry := range raw {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if _, dup := seen[entry]; dup {
			continue
		}
		seen[entry] = struct{}{}
		out = append(out, entry)
	}
	return out
}

// proxyTargetAllowed reports whether the requested target appears verbatim in
// the allowlist. Substring and wildcard matches are deliberately refused: an
// allowlist entry is an identity, not a pattern.
func proxyTargetAllowed(targets []string, target string) bool {
	target = strings.TrimSpace(target)
	for _, allowed := range targets {
		if strings.TrimSpace(allowed) == target {
			return true
		}
	}
	return false
}

// parseSkillProxyInput decodes and validates the invoke input.
func parseSkillProxyInput(input any) (SkillProxyRequest, error) {
	var request SkillProxyRequest
	if input == nil {
		return request, coded(CodeInvalidEnvelope, "skillproxy requires an input object with target and skill")
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return request, coded(CodeInvalidEnvelope, "skillproxy input is not encodable: %v", err)
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return request, coded(CodeInvalidEnvelope, "skillproxy input is malformed: %v", err)
	}
	request.Target = strings.TrimSpace(request.Target)
	request.Skill = strings.TrimSpace(request.Skill)
	if request.Target == "" {
		return request, coded(CodeInvalidEnvelope, "skillproxy requires a target")
	}
	if request.Skill == "" {
		return request, coded(CodeInvalidEnvelope, "skillproxy requires a skill")
	}
	switch {
	case request.TimeoutSeconds < 0:
		return request, coded(CodeInvalidEnvelope, "timeoutSeconds must not be negative")
	case request.TimeoutSeconds == 0:
		// Zero means "use the edge default"; the handler applies it.
	case request.TimeoutSeconds > 300:
		request.TimeoutSeconds = 300
	}
	return request, nil
}

// parseProxyReply interprets a harness's reply envelope. Harnesses answer in
// the synapse shape: an Envelope whose payload carries the handler's return
// under "result", or a top-level error object. A harness-side error is relayed
// as a result with ok=false — the transport worked; the data request did not —
// so a caller can tell the two apart without parsing this layer's errors.
func parseProxyReply(envelope *Envelope, target, skill string) (SkillProxyResult, error) {
	result := SkillProxyResult{Target: target, Skill: skill}
	if envelope == nil {
		return result, coded(CodeInvalidEnvelope, "proxy target %q returned no reply envelope", target)
	}
	if envelope.Error != nil {
		result.OK = false
		result.Reply = json.RawMessage(fmt.Sprintf(
			`{"code":%d,"message":%q,"retryable":%t}`,
			envelope.Error.Code, envelope.Error.Message, envelope.Error.Retryable))
		return result, nil
	}
	var payload struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return result, coded(CodeInvalidEnvelope, "proxy target %q reply payload is malformed: %v", target, err)
	}
	result.OK = true
	result.Reply = payload.Result
	return result, nil
}

// registerSkillProxySkill exposes the proxy when — and only when — an operator
// has configured targets. Mirrors registerInvokeSkill: the gates live here so
// they can be read in one place, and an unconfigured edge never advertises a
// skill it would only refuse.
func (m *Manager) registerSkillProxySkill(agent *Agent) error {
	config := m.Config()
	if !config.SkillsEnabled {
		return nil
	}
	if len(parseSkillProxyTargets(config.SkillProxyTargets)) == 0 {
		return nil
	}
	if !config.servesSkill(SkillProxy) {
		return nil
	}
	agent.RegisterSkill(SkillProxy, m.skillProxy)
	return nil
}

// skillProxy forwards a verified remote request to a local skill server.
//
// The gates mirror skillInvoke and fail closed: configured targets, a verified
// caller (when the edge requires it), an allowlisted target, and a live mesh
// connection to proxy through. As with invoke, meta.From and
// meta.CallerFingerprint come from the guard's verification — the payload
// cannot forge them — so the harness-side audit trail names the real caller.
func (m *Manager) skillProxy(ctx context.Context, input any, meta RequestMeta) (any, error) {
	config := m.Config()

	// Gate 1 — is the capability configured at all? An edge with no targets
	// has nothing to proxy to, and saying so is clearer than a routing error.
	targets := parseSkillProxyTargets(config.SkillProxyTargets)
	if len(targets) == 0 {
		return nil, coded(CodeGovernanceDenied, "the skill proxy is not configured on this edge")
	}

	// Gate 2 — verified caller, under the same floor as invoke. A harness may
	// be read-only, but this edge cannot know that generically, so the
	// identity requirement matches the strongest served skill.
	if config.RequireVerifiedInvoke && !meta.Verified {
		observability.Usage.MeshInvokeDeniedTotal.Add(1)
		m.logger.Warn("refused skill-proxy request from an unverified caller",
			"caller", meta.From, "task", meta.TaskID)
		return nil, coded(CodeGovernanceDenied,
			"caller %q did not present a verified identity, and this edge requires a signed, trusted caller to reach local skill servers",
			meta.From)
	}

	request, err := parseSkillProxyInput(input)
	if err != nil {
		return nil, err
	}

	// Gate 3 — is this target on the allowlist?
	if !proxyTargetAllowed(targets, request.Target) {
		observability.Usage.MeshInvokeDeniedTotal.Add(1)
		m.logger.Warn("refused skill-proxy request to a non-allowlisted target",
			"caller", meta.From, "target", request.Target, "task", meta.TaskID)
		return nil, coded(CodeGovernanceDenied,
			"target %q is not in this edge's skill-proxy allowlist", request.Target)
	}

	// Gate 4 — a live mesh connection to proxy through.
	agent := m.agentSnapshot()
	if agent == nil {
		return nil, coded(CodeAgentUnavailable, "this edge has no live mesh connection to proxy through")
	}

	timeout := config.SkillProxyTimeout
	if timeout <= 0 {
		timeout = DefaultSkillProxyTimeout
	}
	if request.TimeoutSeconds > 0 {
		timeout = time.Duration(request.TimeoutSeconds) * time.Second
	}

	envelope, err := agent.Dispatch(ctx, request.Target, request.Skill, request.Args, timeout)

	// A harness-reported error rides back inside a valid envelope: the proxy
	// did its job, the data request failed. Relay it as ok=false so the caller
	// sees the harness's own code and message rather than a transport wrapper.
	var harnessErr *Error
	if errors.As(err, &harnessErr) && envelope != nil {
		result := SkillProxyResult{Target: request.Target, Skill: request.Skill, OK: false}
		result.Reply = json.RawMessage(fmt.Sprintf(
			`{"code":%d,"message":%q,"retryable":%t}`,
			harnessErr.Code, harnessErr.Message, harnessErr.Retryable))
		return result, nil
	}
	if err != nil {
		return nil, coded(CodeAgentUnavailable, "dispatch %q to %s failed: %v", request.Skill, request.Target, err)
	}
	return parseProxyReply(envelope, request.Target, request.Skill)
}
