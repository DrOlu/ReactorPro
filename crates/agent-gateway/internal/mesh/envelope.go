// Package mesh implements the Synapse agent protocol and the NATS event mesh.
//
// The wire contract follows the Synapse SDK used by the rest of the fleet:
// a JSON envelope published on NATS subjects under `mesh.`.
package mesh

import (
	"encoding/json"
	"time"
)

// ProtocolVersion is the envelope version carried in every message. It matches
// the Synapse protocol version spoken by the rest of the fleet (RTerm's
// synapse-bridge emits the same literal).
const ProtocolVersion = "0.3.0"

// Subjects used by the mesh. Kept as constants so every call site agrees.
const (
	SubjectRegistryRegister   = "mesh.registry.register"
	SubjectRegistryDiscover   = "mesh.registry.discover"
	SubjectRegistryDeregister = "mesh.registry.deregister"
	SubjectHeartbeatPrefix    = "mesh.heartbeat."
	SubjectAgentInboxPrefix   = "mesh.agent."
	SubjectAgentInboxSuffix   = ".inbox"
	SubjectEventPrefix        = "mesh.event."
	SubjectEventWildcard      = "mesh.event.>"
	SubjectRegistry           = "REGISTRY"
)

// AgentInboxSubject returns the request/reply subject for an agent.
func AgentInboxSubject(agentID string) string {
	return SubjectAgentInboxPrefix + agentID + SubjectAgentInboxSuffix
}

// HeartbeatSubject returns the liveness subject for an agent.
func HeartbeatSubject(agentID string) string {
	return SubjectHeartbeatPrefix + agentID
}

// MessageType enumerates the envelope kinds exchanged on the mesh.
type MessageType string

const (
	TypeRegister MessageType = "register"
	TypeDiscover MessageType = "discover"
	TypeRequest  MessageType = "request"
	TypeRespond  MessageType = "respond"
	TypeEmit     MessageType = "emit"
)

// Error codes, aligned with the Synapse protocol's documented table so a
// spec-conformant peer interprets them correctly. Grouped by cause: 1xxx
// transport, 2xxx envelope validation, 3xxx capability and identity, 4xxx
// policy and load, 5xxx handler execution.
//
// These values are wire contract: a peer branches on them, so they must not be
// reused for a different meaning.
const (
	CodeInvalidEnvelope  = 2001 // INVALID_ENVELOPE — could not be decoded or validated
	CodeInvalidManifest  = 2002 // INVALID_MANIFEST — manifest missing required fields
	CodeSkillNotFound    = 3001 // SKILL_NOT_FOUND
	CodeAgentUnavailable = 3002 // AGENT_UNAVAILABLE — retryable
	CodeIdentityMismatch = 3004 // IDENTITY_MISMATCH — signature or pinned key does not match
	CodeOverloaded       = 4001 // OVERLOADED — retryable
	CodeRateLimited      = 4002 // RATE_LIMITED — retryable
	CodeGovernanceDenied = 4003 // GOVERNANCE_DENIED — blocked by policy
	CodeApprovalRequired = 4004 // APPROVAL_REQUIRED — retryable, awaiting sign-off
	CodeInternalError    = 5001 // INTERNAL_ERROR — retryable
)

// retryableCode reports whether a peer should consider retrying an error code.
// It is the single source of truth for the retryable flag so a code can never
// be emitted with an inconsistent value.
func retryableCode(code int) bool {
	switch code {
	case CodeAgentUnavailable, CodeOverloaded, CodeRateLimited, CodeApprovalRequired, CodeInternalError:
		return true
	default:
		return false
	}
}

// Trace carries correlation identifiers across hops.
type Trace struct {
	TraceID string `json:"trace_id"`
	SpanID  string `json:"span_id"`
}

// Error is the failure object carried by a respond envelope.
type Error struct {
	Code      int    `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (e *Error) Error() string { return e.Message }

// Skill is a capability an agent advertises.
type Skill struct {
	ID          string `json:"id"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
}

// Manifest is what an agent publishes to the registry.
type Manifest struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Description   string   `json:"description,omitempty"`
	Capabilities  []string `json:"capabilities"`
	Skills        []Skill  `json:"skills"`
	Endpoint      string   `json:"endpoint"`
	Availability  string   `json:"availability"`
	LastHeartbeat string   `json:"last_heartbeat"`
	// Fingerprint lets a discovering agent pin this peer's identity before it
	// ever receives a message from it, so trust-on-first-use has something to
	// compare against on the second contact.
	Fingerprint string `json:"fingerprint,omitempty"`
}

// AvailabilityOnline is the only availability value an active agent reports.
const AvailabilityOnline = "online"

// Envelope is the message framing for every mesh exchange.
type Envelope struct {
	Version string          `json:"v"`
	ID      string          `json:"id"`
	Type    MessageType     `json:"type"`
	TS      string          `json:"ts"`
	From    string          `json:"from"`
	To      string          `json:"to,omitempty"`
	TaskID  string          `json:"task_id,omitempty"`
	Trace   *Trace          `json:"trace,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Error   *Error          `json:"error,omitempty"`
	// InReplyTo is the id of the message this one answers, letting a peer
	// correlate a response without relying on the NATS reply subject.
	InReplyTo string `json:"in_reply_to,omitempty"`

	// Signature authenticates the envelope when the sender has an identity.
	Signature string `json:"sig,omitempty"`
	// PublicKey is the sender's Ed25519 public key (PEM), letting a receiver
	// verify the signature without a separate trust lookup.
	PublicKey string `json:"pub,omitempty"`
	// Fingerprint binds the public key to the claimed agent id. Without it a
	// signature only proves the sender holds *some* key — a receiver cannot tell
	// whether that key belongs to the agent named in From. It is covered by the
	// signature, so it cannot be swapped in transit.
	Fingerprint string `json:"fp,omitempty"`
}

// now is indirected so tests can pin timestamps.
var now = func() time.Time { return time.Now().UTC() }

func timestamp() string { return now().Format(time.RFC3339Nano) }

// RequestPayload and RespondPayload are the two payload shapes that carry
// skill calls.
type RequestPayload struct {
	Skill string `json:"skill"`
	Input any    `json:"input"`
}

type RespondPayload struct {
	Output any `json:"output"`
}

// DiscoverFilter narrows a discovery query.
type DiscoverFilter struct {
	Capabilities []string `json:"capabilities,omitempty"`
	SkillIDs     []string `json:"skill_ids,omitempty"`
	Availability string   `json:"availability,omitempty"`
}

// DiscoverResponse is the registry's reply payload.
type DiscoverResponse struct {
	Agents []Manifest `json:"agents"`
}

// RegisterResponse is the registry's acknowledgement payload.
type RegisterResponse struct {
	AgentID      string `json:"agent_id"`
	RegisteredAt string `json:"registered_at"`
	Status       string `json:"status"`
}

// EventPayload is the body of a `mesh.event.<type>` message.
type EventPayload struct {
	EventType string `json:"event_type"`
	Data      any    `json:"data"`
}

// HeartbeatPayload is published on mesh.heartbeat.<agent>.
type HeartbeatPayload struct {
	TS string `json:"ts"`
}

// encode marshals a payload, tolerating nil.
func encodePayload(value any) (json.RawMessage, error) {
	if value == nil {
		return nil, nil
	}
	return json.Marshal(value)
}
