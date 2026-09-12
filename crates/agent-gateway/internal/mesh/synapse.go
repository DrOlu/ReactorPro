package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// ErrNotConnected is returned when an operation needs a live mesh connection.
var ErrNotConnected = errors.New("mesh is not connected")

// RequestMeta carries per-call context into a skill handler.
type RequestMeta struct {
	TaskID string
	From   string
	Trace  *Trace
}

// Handler serves one skill. Returning an error produces a 5001 respond
// envelope; the mesh stays up.
type Handler func(ctx context.Context, input any, meta RequestMeta) (any, error)

// EventHandler receives mesh events.
type EventHandler func(ctx context.Context, subject string, event EventPayload)

// Agent is a full-duplex Synapse mesh participant backed by NATS.
type Agent struct {
	config   Config
	identity *Identity
	logger   *slog.Logger

	conn *nats.Conn

	mu       sync.RWMutex
	handlers map[string]Handler
	manifest Manifest
	started  bool
	agentID  string
	subs     []*nats.Subscription
}

// NewAgent builds an agent. It does not connect until Start is called.
func NewAgent(config Config, identity *Identity, logger *slog.Logger) *Agent {
	if logger == nil {
		logger = slog.Default()
	}
	agentID := config.AgentID
	if identity != nil {
		agentID = identity.AgentID
	}
	return &Agent{
		config:   config,
		identity: identity,
		logger:   logger,
		handlers: map[string]Handler{},
		agentID:  agentID,
	}
}

// AgentID returns the immutable id this agent speaks as.
func (a *Agent) AgentID() string { return a.agentID }

// Fingerprint returns the identity fingerprint, or an empty string when the
// agent runs without an identity.
func (a *Agent) Fingerprint() string {
	if a.identity == nil {
		return ""
	}
	return a.identity.Fingerprint
}

// RegisterSkill adds or replaces a skill handler.
func (a *Agent) RegisterSkill(skillID string, handler Handler) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.handlers[skillID] = handler
}

// Skills lists the registered skill ids.
func (a *Agent) Skills() []string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]string, 0, len(a.handlers))
	for id := range a.handlers {
		out = append(out, id)
	}
	return out
}

// buildManifest describes this agent to the mesh.
func (a *Agent) buildManifest() Manifest {
	skills := make([]Skill, 0)
	for _, id := range a.Skills() {
		skills = append(skills, Skill{ID: id, Name: id})
	}
	capabilities := a.config.Capabilities
	if capabilities == nil {
		capabilities = []string{"agent"}
	}
	return Manifest{
		ID:            a.agentID,
		Name:          a.config.Name,
		Description:   a.config.Description,
		Capabilities:  capabilities,
		Skills:        skills,
		Endpoint:      AgentInboxSubject(a.agentID),
		Availability:  AvailabilityOnline,
		LastHeartbeat: timestamp(),
	}
}

// Start connects to NATS, registers, begins serving and starts heartbeating.
func (a *Agent) Start(ctx context.Context) error {
	a.mu.Lock()
	if a.started {
		a.mu.Unlock()
		return nil
	}
	a.mu.Unlock()

	options, err := a.config.natsOptions()
	if err != nil {
		return err
	}
	conn, err := nats.Connect(a.config.URL, options...)
	if err != nil {
		return fmt.Errorf("connect to NATS at %s: %w", a.config.URL, err)
	}
	a.conn = conn

	// Serve inbound skill requests.
	inbox := AgentInboxSubject(a.agentID)
	sub, err := conn.Subscribe(inbox, a.handleInboundRequest)
	if err != nil {
		conn.Close()
		return fmt.Errorf("subscribe to %s: %w", inbox, err)
	}
	a.mu.Lock()
	a.subs = append(a.subs, sub)
	a.started = true
	a.mu.Unlock()

	a.setManifest(a.buildManifest())

	if err := a.Register(ctx); err != nil {
		// Registration failing is not fatal: the agent still serves requests
		// and can re-register on demand.
		a.logger.Warn("mesh registration failed", "error", err)
	}
	a.startHeartbeat(ctx)
	return nil
}

// Stop deregisters and drains the connection. It is safe to call twice.
func (a *Agent) Stop(ctx context.Context) error {
	a.mu.Lock()
	conn := a.conn
	subs := a.subs
	started := a.started
	a.started = false
	a.conn = nil
	a.subs = nil
	agentID := a.agentID
	a.mu.Unlock()

	if !started || conn == nil {
		return nil
	}
	for _, sub := range subs {
		_ = sub.Unsubscribe()
	}
	a.deregisterWith(ctx, conn, agentID)
	a.stopHeartbeat()
	if err := conn.Drain(); err != nil {
		conn.Close()
	}
	return nil
}

// Connected reports whether the agent currently holds a NATS connection.
func (a *Agent) Connected() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.conn != nil && a.conn.IsConnected()
}

// Register publishes this agent's manifest to the registry.
func (a *Agent) Register(ctx context.Context) error {
	conn, err := a.connection()
	if err != nil {
		return err
	}
	envelope := a.newEnvelope(TypeRegister, SubjectRegistry, "")
	if err := a.attachPayload(envelope, a.Manifest()); err != nil {
		return err
	}
	raw, err := a.marshal(envelope)
	if err != nil {
		return err
	}
	// Registration is fire-and-forget in the SDK; a reply is optional.
	if err := conn.Publish(SubjectRegistryRegister, raw); err != nil {
		return fmt.Errorf("publish registration: %w", err)
	}
	return nil
}

func (a *Agent) deregisterWith(ctx context.Context, conn *nats.Conn, agentID string) {
	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeRegister,
		TS:      timestamp(),
		From:    agentID,
	}
	if a.identity != nil {
		_ = a.identity.Sign(envelope)
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return
	}
	_ = conn.Publish(SubjectRegistryDeregister, raw)
}

// Discover asks the registry for matching agents and also honours direct
// replies from agents that answer discovery themselves (the SDK's behaviour).
func (a *Agent) Discover(ctx context.Context, filter DiscoverFilter) ([]Manifest, error) {
	conn, err := a.connection()
	if err != nil {
		return nil, err
	}
	envelope := a.newEnvelope(TypeDiscover, SubjectRegistry, "")
	if err := a.attachPayload(envelope, filter); err != nil {
		return nil, err
	}
	raw, err := a.marshal(envelope)
	if err != nil {
		return nil, err
	}

	// Collect every manifest seen within the collection window: the registry
	// answers once, and agents may answer individually too.
	inbox := nats.NewInbox()
	// A synchronous subscription is required: discovery drains replies with
	// NextMsg, which an async callback subscription would consume instead.
	sub, err := conn.SubscribeSync(inbox)
	if err != nil {
		return nil, fmt.Errorf("subscribe for discovery replies: %w", err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	timeout := a.config.RequestTimeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	if err := conn.PublishRequest(SubjectRegistryDiscover, inbox, raw); err != nil {
		return nil, fmt.Errorf("publish discovery: %w", err)
	}

	deadline := time.Now().Add(timeout)
	seen := map[string]Manifest{}
	var drainErr error
	for {
		wait := remaining(deadline)
		if wait <= 0 {
			break
		}
		// NextMsg treats a zero timeout as "wait forever", so the remaining time
		// is always checked to be positive before waiting.
		message, err := sub.NextMsg(wait)
		if err != nil {
			drainErr = err
			break
		}
		for _, manifest := range manifestsFrom(message.Data) {
			if !manifestMatches(manifest, filter) {
				continue
			}
			seen[manifest.ID] = manifest
		}
	}
	if len(seen) == 0 && drainErr != nil && !errors.Is(drainErr, nats.ErrTimeout) {
		return nil, fmt.Errorf("collect discovery replies: %w", drainErr)
	}
	out := make([]Manifest, 0, len(seen))
	for _, manifest := range seen {
		if manifest.ID == a.agentID {
			continue
		}
		out = append(out, manifest)
	}
	return out, nil
}

// Dispatch sends a skill request to another agent and waits for its reply.
func (a *Agent) Dispatch(ctx context.Context, targetAgent, skill string, input any, timeout time.Duration) (*Envelope, error) {
	conn, err := a.connection()
	if err != nil {
		return nil, err
	}
	if timeout <= 0 {
		timeout = a.config.RequestTimeout
	}
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	envelope := a.newEnvelope(TypeRequest, targetAgent, newID())
	envelope.Trace = &Trace{TraceID: newID(), SpanID: newID()}
	if err := a.attachPayload(envelope, RequestPayload{Skill: skill, Input: input}); err != nil {
		return nil, err
	}
	raw, err := a.marshal(envelope)
	if err != nil {
		return nil, err
	}
	message, err := conn.Request(AgentInboxSubject(targetAgent), raw, timeout)
	if err != nil {
		return nil, fmt.Errorf("dispatch %q to %s: %w", skill, targetAgent, err)
	}
	response, err := decodeEnvelope(message.Data)
	if err != nil {
		return nil, err
	}
	if response.Error != nil {
		return response, response.Error
	}
	return response, nil
}

// Emit publishes an event to the mesh.
func (a *Agent) Emit(ctx context.Context, eventType string, data any) error {
	conn, err := a.connection()
	if err != nil {
		return err
	}
	envelope := a.newEnvelope(TypeEmit, "", "")
	if err := a.attachPayload(envelope, EventPayload{EventType: eventType, Data: data}); err != nil {
		return err
	}
	raw, err := a.marshal(envelope)
	if err != nil {
		return err
	}
	if err := conn.Publish(SubjectEventPrefix+eventType, raw); err != nil {
		return fmt.Errorf("emit %q: %w", eventType, err)
	}
	return nil
}

// Subscribe attaches an event handler. A subject of "" subscribes to the whole
// mesh event wildcard; a plain name is prefixed with `mesh.event.`.
func (a *Agent) Subscribe(ctx context.Context, subject string, handler EventHandler) (*nats.Subscription, error) {
	conn, err := a.connection()
	if err != nil {
		return nil, err
	}
	full := subject
	switch {
	case full == "":
		full = SubjectEventWildcard
	case len(full) >= len(SubjectEventPrefix) && full[:len(SubjectEventPrefix)] == SubjectEventPrefix:
		// already a full subject
	case len(subject) > 0 && subject[len(subject)-1] == '>':
		full = SubjectEventPrefix + subject
	default:
		full = SubjectEventPrefix + subject
	}
	sub, err := conn.Subscribe(full, func(message *nats.Msg) {
		envelope, decodeErr := decodeEnvelope(message.Data)
		if decodeErr != nil {
			a.logger.Warn("discarding malformed mesh event", "subject", message.Subject, "error", decodeErr)
			return
		}
		var event EventPayload
		if len(envelope.Payload) > 0 {
			if err := json.Unmarshal(envelope.Payload, &event); err != nil {
				a.logger.Warn("discarding mesh event with bad payload", "subject", message.Subject, "error", err)
				return
			}
		}
		handler(ctx, message.Subject, event)
	})
	if err != nil {
		return nil, fmt.Errorf("subscribe to %s: %w", full, err)
	}
	a.mu.Lock()
	a.subs = append(a.subs, sub)
	a.mu.Unlock()
	return sub, nil
}

// Manifest returns the agent's current manifest.
func (a *Agent) Manifest() Manifest {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.manifest
}

func (a *Agent) setManifest(manifest Manifest) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.manifest = manifest
}

// handleInboundRequest serves a request envelope arriving on the agent inbox.
func (a *Agent) handleInboundRequest(message *nats.Msg) {
	envelope, err := decodeEnvelope(message.Data)
	if err != nil {
		a.respondError(message, nil, CodeInvalidRequest, "malformed envelope", false)
		return
	}
	if envelope.Type != TypeRequest {
		// The SDK ignores anything that is not a request.
		return
	}
	var payload RequestPayload
	if len(envelope.Payload) > 0 {
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			a.respondError(message, envelope, CodeInvalidRequest, "malformed request payload", false)
			return
		}
	}
	a.mu.RLock()
	handler := a.handlers[payload.Skill]
	a.mu.RUnlock()
	if handler == nil {
		a.respondError(message, envelope, CodeSkillNotFound, fmt.Sprintf("Skill %q not found", payload.Skill), false)
		return
	}
	meta := RequestMeta{TaskID: envelope.TaskID, From: envelope.From, Trace: envelope.Trace}
	output, handlerErr := handler(context.Background(), payload.Input, meta)
	if handlerErr != nil {
		a.respondError(message, envelope, CodeHandlerFailed, handlerErr.Error(), true)
		return
	}
	reply := a.replyEnvelope(envelope)
	if err := a.attachPayload(reply, RespondPayload{Output: output}); err != nil {
		a.respondError(message, envelope, CodeHandlerFailed, err.Error(), true)
		return
	}
	a.publishReply(message, reply)
}

func (a *Agent) respondError(message *nats.Msg, request *Envelope, code int, reason string, retryable bool) {
	reply := a.replyEnvelope(request)
	reply.Error = &Error{Code: code, Message: reason, Retryable: retryable}
	a.publishReply(message, reply)
}

func (a *Agent) publishReply(message *nats.Msg, reply *Envelope) {
	if message.Reply == "" {
		return
	}
	raw, err := a.marshal(reply)
	if err != nil {
		a.logger.Warn("failed to marshal mesh reply", "error", err)
		return
	}
	if err := a.conn.Publish(message.Reply, raw); err != nil {
		a.logger.Warn("failed to publish mesh reply", "error", err)
	}
}

// replyEnvelope seeds a respond envelope from the request it answers.
func (a *Agent) replyEnvelope(request *Envelope) *Envelope {
	reply := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeRespond,
		TS:      timestamp(),
		From:    a.agentID,
	}
	if request != nil {
		reply.To = request.From
		reply.TaskID = request.TaskID
		reply.Trace = request.Trace
	}
	if a.identity != nil {
		_ = a.identity.Sign(reply)
	}
	return reply
}

func (a *Agent) newEnvelope(messageType MessageType, to, taskID string) *Envelope {
	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    messageType,
		TS:      timestamp(),
		From:    a.agentID,
		To:      to,
		TaskID:  taskID,
	}
	if a.identity != nil {
		_ = a.identity.Sign(envelope)
	}
	return envelope
}

// attachPayload marshals a payload and re-signs, since the signature covers it.
func (a *Agent) attachPayload(envelope *Envelope, payload any) error {
	raw, err := encodePayload(payload)
	if err != nil {
		return fmt.Errorf("encode payload: %w", err)
	}
	envelope.Payload = raw
	if a.identity != nil {
		return a.identity.Sign(envelope)
	}
	return nil
}

func (a *Agent) marshal(envelope *Envelope) ([]byte, error) {
	raw, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("marshal envelope: %w", err)
	}
	return raw, nil
}

func (a *Agent) connection() (*nats.Conn, error) {
	a.mu.RLock()
	conn := a.conn
	a.mu.RUnlock()
	if conn == nil {
		return nil, ErrNotConnected
	}
	return conn, nil
}

func (a *Agent) startHeartbeat(ctx context.Context) {
	interval := a.config.HeartbeatInterval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	subject := HeartbeatSubject(a.agentID)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				conn, err := a.connection()
				if err != nil {
					return
				}
				payload, err := json.Marshal(HeartbeatPayload{TS: timestamp()})
				if err != nil {
					continue
				}
				if err := conn.Publish(subject, payload); err != nil {
					a.logger.Warn("mesh heartbeat failed", "error", err)
				}
			}
		}
	}()
}

func (a *Agent) stopHeartbeat() {
	// The heartbeat goroutine exits with the caller's context; nothing to do
	// here beyond letting the connection drain.
}

// manifestsFrom accepts both response shapes seen in the fleet: a registry
// `{agents:[...]}` payload, and a single-agent manifest reply.
func manifestsFrom(raw []byte) []Manifest {
	envelope, err := decodeEnvelope(raw)
	if err != nil || len(envelope.Payload) == 0 {
		return nil
	}
	var response DiscoverResponse
	if err := json.Unmarshal(envelope.Payload, &response); err == nil && len(response.Agents) > 0 {
		return response.Agents
	}
	var manifest Manifest
	if err := json.Unmarshal(envelope.Payload, &manifest); err == nil && manifest.ID != "" {
		return []Manifest{manifest}
	}
	return nil
}

func manifestMatches(manifest Manifest, filter DiscoverFilter) bool {
	if manifest.ID == "" || manifest.Name == "" {
		return false
	}
	if filter.Availability != "" && manifest.Availability != filter.Availability {
		return false
	}
	for _, capability := range filter.Capabilities {
		if !containsString(manifest.Capabilities, capability) {
			return false
		}
	}
	for _, skillID := range filter.SkillIDs {
		found := false
		for _, skill := range manifest.Skills {
			if skill.ID == skillID {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func decodeEnvelope(raw []byte) (*Envelope, error) {
	var envelope Envelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("decode envelope: %w", err)
	}
	return &envelope, nil
}

func remaining(deadline time.Time) time.Duration {
	left := time.Until(deadline)
	if left < 0 {
		return 0
	}
	return left
}
