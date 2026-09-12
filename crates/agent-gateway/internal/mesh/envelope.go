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

// Error codes. Codes are grouped by cause: 2xxx request/validation, 3xxx
// capability, 5xxx handler execution.
const (
	CodeInvalidRequest   = 2002
	CodeSkillNotFound    = 3001
	CodeHandlerFailed    = 5001
	CodeUnauthorized     = 4010
	CodeNotConfigured    = 5003
	CodeGovernanceDenied = 4030
)

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

	// Signature authenticates the envelope when the sender has an identity.
	Signature string `json:"sig,omitempty"`
	// PublicKey is the sender's Ed25519 public key (PEM), letting a receiver
	// verify the signature without a separate trust lookup.
	PublicKey string `json:"pub,omitempty"`
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
