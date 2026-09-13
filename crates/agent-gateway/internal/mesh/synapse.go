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

	// guard applies every inbound policy. It is built once and shared by the
	// request handler and the event subscriber so neither can skip a check.
	guard *inboundGuard

	// lifecycle serializes Start and Stop. mu protects fields; it is
	// deliberately not held across the network connect, so a slow or hanging
	// dial cannot block readers of Connected().
	lifecycle sync.Mutex

	// localAgents supplies the directory published in the manifest. Injected by
	// the manager so the bridge stays independent of the desktop layers.
	localAgents LocalAgentProvider

	mu       sync.RWMutex
	conn     *nats.Conn
	handlers map[string]Handler
	manifest Manifest
	started  bool
	agentID  string
	subs     []*nats.Subscription

	// collision records a peer seen using this edge's own id, which makes the
	// mesh ambiguous. Empty when none has been seen.
	collision string
}

// NewAgent builds an agent. It does not connect until Start is called.
func NewAgent(config Config, identity *Identity, logger *slog.Logger) *Agent {
	if logger == nil {
		logger = slog.Default()
	}
	config.normalize()
	agentID := config.AgentID
	if identity != nil {
		agentID = identity.AgentID
	}
	return &Agent{
		config:   config,
		identity: identity,
		logger:   logger,
		guard:    newInboundGuard(config, agentID, logger),
		handlers: map[string]Handler{},
		agentID:  agentID,
	}
}

// TrustPeers returns the identities this agent has accepted, ordered by agent id.
func (a *Agent) TrustPeers() []PeerPin { return a.guard.trust.peers() }

// SeedTrustedPeers installs previously persisted identity pins.
func (a *Agent) SeedTrustedPeers(pins []PeerPin) { a.guard.trust.seed(pins) }

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
	localAgents, localTotal := directorySnapshot(a.localAgents)

	return Manifest{
		ID:              a.agentID,
		Name:            a.config.Name,
		Description:     a.config.Description,
		Capabilities:    capabilities,
		Skills:          skills,
		Endpoint:        AgentInboxSubject(a.agentID),
		Availability:    AvailabilityOnline,
		LastHeartbeat:   timestamp(),
		Fingerprint:     a.Fingerprint(),
		LocalAgents:     localAgents,
		LocalAgentTotal: localTotal,
	}
}

// SetLocalAgentsProvider installs the directory supplier used when building the
// manifest. Safe to call before Start; the next manifest rebuild picks it up.
func (a *Agent) SetLocalAgentsProvider(provider LocalAgentProvider) {
	a.mu.Lock()
	a.localAgents = provider
	a.mu.Unlock()
	if a.Connected() {
		a.refreshManifest()
	}
}

// refreshManifest rebuilds and stores the manifest, then re-registers so peers
// see the change without waiting for a heartbeat window.
func (a *Agent) refreshManifest() {
	a.setManifest(a.buildManifest())
	if err := a.Register(context.Background()); err != nil {
		a.logger.Warn("mesh re-registration failed", "error", err)
	}
}

// Collision reports a peer that was seen using this edge's own agent id, which
// makes routing ambiguous. Empty when none has been observed.
//
// This is surfaced rather than merely logged because the failure it describes is
// otherwise invisible: the peer is dropped as "self", so the mesh simply looks
// empty while every service reports healthy.
func (a *Agent) Collision() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.collision
}

// noteCollision records an id clash once, and logs it loudly.
func (a *Agent) noteCollision(manifest Manifest) {
	a.mu.Lock()
	already := a.collision != ""
	if !already {
		a.collision = manifest.ID
	}
	a.mu.Unlock()
	if already {
		return
	}
	a.logger.Error("mesh agent id collision: another agent is using this edge's id",
		"agentId", manifest.ID,
		"theirEndpoint", manifest.Endpoint,
		"theirFingerprint", manifest.Fingerprint,
		"ourEndpoint", AgentInboxSubject(a.agentID),
		"ourFingerprint", a.Fingerprint(),
		"impact", "requests addressed to this id are ambiguous and discovery hides the peer",
		"fix", "give each edge a unique -mesh-agent-id such as <org>/<site>/<edge>")
}

// Start connects to NATS, registers, begins serving and starts heartbeating.
func (a *Agent) Start(ctx context.Context) error {
	a.lifecycle.Lock()
	defer a.lifecycle.Unlock()

	a.mu.RLock()
	alreadyStarted := a.started
	a.mu.RUnlock()
	if alreadyStarted {
		return nil
	}

	options, err := a.config.natsOptions()
	if err != nil {
		return err
	}
	conn, err := nats.Connect(a.config.URL, options...)
	if err != nil {
		return fmt.Errorf("connect to NATS at %s: %w", a.config.URL, err)
	}
	// Publish the connection under the field lock. Assigning it unlocked raced
	// Stop and Connected, and let publishReply dereference a nil connection.
	a.mu.Lock()
	a.conn = conn
	a.mu.Unlock()

	// Serve inbound skill requests.
	inbox := AgentInboxSubject(a.agentID)
	sub, err := conn.Subscribe(inbox, a.handleInboundRequest)
	if err != nil {
		a.mu.Lock()
		a.conn = nil
		a.mu.Unlock()
		conn.Close()
		return fmt.Errorf("subscribe to %s: %w", inbox, err)
	}
	// Answer discovery queries directly. The Synapse SDK's agents do this, and
	// without it discovery only works when a separate registry service happens
	// to be running — a two-agent mesh would silently see nobody.
	discoverSub, err := conn.Subscribe(SubjectRegistryDiscover, a.handleDiscoverRequest)
	if err != nil {
		// Not fatal: an external registry may still serve discovery.
		a.logger.Warn("mesh discovery subscription failed", "error", err)
	}

	// Watch our own liveness subject. Only one agent should ever be speaking
	// there, so this is how an id collision becomes visible rather than silent.
	heartbeatSub, err := conn.Subscribe(HeartbeatSubject(a.agentID), a.handleHeartbeatPeers)
	if err != nil {
		a.logger.Warn("mesh heartbeat subscription failed", "error", err)
	}

	a.mu.Lock()
	a.subs = append(a.subs, sub)
	if discoverSub != nil {
		a.subs = append(a.subs, discoverSub)
	}
	if heartbeatSub != nil {
		a.subs = append(a.subs, heartbeatSub)
	}
	a.started = true
	a.mu.Unlock()

	a.setManifest(a.buildManifest())

	if err := a.Register(ctx); err != nil {
		// Registration failing is not fatal: the agent still serves requests
		// and can re-register on demand.
		a.logger.Warn("mesh registration failed", "error", err)
	}
	// Announce immediately so a colliding peer is noticed within seconds rather
	// than after a full heartbeat interval.
	a.publishHeartbeat(HeartbeatSubject(a.agentID))
	a.startHeartbeat(ctx)
	return nil
}

// Stop deregisters and drains the connection. It is safe to call twice.
func (a *Agent) Stop(ctx context.Context) error {
	a.lifecycle.Lock()
	defer a.lifecycle.Unlock()

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

	// Discovery is a fixed collection window, not a per-reply timeout: peers
	// answer individually as well as the registry, so the caller must wait the
	// window out to be sure it saw everyone. Using the dispatch timeout here
	// would stall the caller for minutes.
	window := a.config.DiscoveryWindow
	if window <= 0 {
		window = 2 * time.Second
	}
	if err := conn.PublishRequest(SubjectRegistryDiscover, inbox, raw); err != nil {
		return nil, fmt.Errorf("publish discovery: %w", err)
	}

	deadline := time.Now().Add(window)
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
		// Discovery replies are unauthenticated input like any other: a forged
		// reply could otherwise inject a peer that does not exist.
		if rejection := a.guard.checkBytes(len(message.Data)); rejection != nil {
			continue
		}
		envelope, err := decodeEnvelope(message.Data)
		if err != nil {
			continue
		}
		if rejection := a.guard.check(envelope); rejection != nil {
			continue
		}
		for _, manifest := range manifestsFrom(envelope) {
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
			// A manifest carrying our own id is normally us, echoed back — but it
			// may be a different edge that took the same id, which makes routing to
			// that id ambiguous. Dropping it silently would leave the operator with
			// an inexplicably empty peer list.
			//
			// The fingerprint is the decisive signal, not the endpoint: the inbox
			// subject is *derived from* the agent id, so a colliding peer's
			// endpoint is identical to ours by construction. Only the key differs.
			ours := a.Fingerprint()
			switch {
			case manifest.Fingerprint != "" && ours != "" && manifest.Fingerprint != ours:
				a.noteCollision(manifest)
			case manifest.Endpoint != "" && manifest.Endpoint != AgentInboxSubject(a.agentID):
				// A peer using a different endpoint convention for the same id.
				a.noteCollision(manifest)
			}
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
		// Events carry the same trust requirements as requests: an unsigned or
		// replayed event is as dangerous as an unsigned request, and the
		// subscriber used to accept either.
		if rejection := a.guard.checkBytes(len(message.Data)); rejection != nil {
			return
		}
		envelope, decodeErr := decodeEnvelope(message.Data)
		if decodeErr != nil {
			a.logger.Warn("discarding malformed mesh event", "subject", message.Subject, "error", decodeErr)
			return
		}
		if rejection := a.guard.check(envelope); rejection != nil {
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

// handleDiscoverRequest answers a discovery query with this agent's manifest
// when it matches the filter. Replying is what makes discovery work between two
// agents with no registry in the middle.
func (a *Agent) handleDiscoverRequest(message *nats.Msg) {
	if message.Reply == "" {
		// A discovery query with no reply subject cannot be answered.
		return
	}
	if rejection := a.guard.checkBytes(len(message.Data)); rejection != nil {
		return
	}
	envelope, err := decodeEnvelope(message.Data)
	if err != nil {
		return
	}
	if rejection := a.guard.check(envelope); rejection != nil {
		return
	}

	var filter DiscoverFilter
	if len(envelope.Payload) > 0 {
		if err := json.Unmarshal(envelope.Payload, &filter); err != nil {
			return
		}
	}
	manifest := a.Manifest()
	if manifest.ID == envelope.From || !manifestMatches(manifest, filter) {
		// Do not answer our own query, and do not answer a filter we do not meet.
		return
	}

	reply := a.replyEnvelope(envelope)
	if err := a.attachPayload(reply, manifest); err != nil {
		return
	}
	conn, err := a.connection()
	if err != nil {
		return
	}
	raw, err := a.marshal(reply)
	if err != nil {
		return
	}
	if err := conn.Publish(message.Reply, raw); err != nil {
		a.logger.Warn("failed to publish discovery reply", "error", err)
	}
}

// handleInboundRequest serves a request envelope arriving on the agent inbox.
//
// Every inbound policy is applied by the guard before anything is dispatched, so
// an unauthenticated or replayed message never reaches a skill handler.
func (a *Agent) handleInboundRequest(message *nats.Msg) {
	if rejection := a.guard.checkBytes(len(message.Data)); rejection != nil {
		// Undecodable by policy: there is no verified sender to answer.
		return
	}
	envelope, err := decodeEnvelope(message.Data)
	if err != nil {
		a.respondError(message, nil, CodeInvalidEnvelope, "malformed envelope")
		return
	}
	if rejection := a.guard.check(envelope); rejection != nil {
		a.respondError(message, envelope, rejection.code, rejection.reason)
		return
	}
	if envelope.Type != TypeRequest {
		// The SDK ignores anything that is not a request.
		return
	}
	var payload RequestPayload
	if len(envelope.Payload) > 0 {
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			a.respondError(message, envelope, CodeInvalidEnvelope, "malformed request payload")
			return
		}
	}
	a.mu.RLock()
	handler := a.handlers[payload.Skill]
	a.mu.RUnlock()
	if handler == nil {
		a.respondError(message, envelope, CodeSkillNotFound, fmt.Sprintf("Skill %q not found", payload.Skill))
		return
	}
	meta := RequestMeta{TaskID: envelope.TaskID, From: envelope.From, Trace: envelope.Trace}
	output, handlerErr := handler(context.Background(), payload.Input, meta)
	if handlerErr != nil {
		a.respondError(message, envelope, CodeInternalError, handlerErr.Error())
		return
	}
	reply := a.replyEnvelope(envelope)
	if err := a.attachPayload(reply, RespondPayload{Output: output}); err != nil {
		a.respondError(message, envelope, CodeInternalError, err.Error())
		return
	}
	a.publishReply(message, reply)
}

// respondError replies with a failure envelope. Whether the code is retryable is
// derived from the code itself so the two can never disagree.
func (a *Agent) respondError(message *nats.Msg, request *Envelope, code int, reason string) {
	reply := a.replyEnvelope(request)
	reply.Error = &Error{Code: code, Message: reason, Retryable: retryableCode(code)}
	a.publishReply(message, reply)
}

func (a *Agent) publishReply(message *nats.Msg, reply *Envelope) {
	if message.Reply == "" {
		return
	}
	// Read the connection under the lock: Stop clears it concurrently, and
	// dereferencing the field directly could panic on a reply during shutdown.
	conn, err := a.connection()
	if err != nil {
		return
	}
	raw, err := a.marshal(reply)
	if err != nil {
		a.logger.Warn("failed to marshal mesh reply", "error", err)
		return
	}
	if err := conn.Publish(message.Reply, raw); err != nil {
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
				a.publishHeartbeat(subject)
			}
		}
	}()
}

// publishHeartbeat announces liveness as a signed envelope.
func (a *Agent) publishHeartbeat(subject string) {
	conn, err := a.connection()
	if err != nil {
		return
	}
	envelope := a.newEnvelope(TypeHeartbeat, "", "")
	if err := a.attachPayload(envelope, HeartbeatPayload{TS: timestamp()}); err != nil {
		return
	}
	raw, err := a.marshal(envelope)
	if err != nil {
		return
	}
	if err := conn.Publish(subject, raw); err != nil {
		a.logger.Warn("mesh heartbeat failed", "error", err)
	}
}

// handleHeartbeatPeers watches this agent's own liveness subject.
//
// Exactly one agent should ever speak on a given heartbeat subject, so a signed
// heartbeat arriving from a different key means another edge has taken this id.
// This is the only reliable collision signal: discovery cannot see it, because
// two edges sharing an id each treat the other's query as their own and reply to
// nobody — the collision presents as mutual silence, indistinguishable from an
// empty mesh.
//
// This deliberately does not run the full inbound guard. The guard's trust store
// exists to decide whether a peer may be *served*, and it answers a second
// fingerprint under a known id with ErrIdentityMismatch — which is exactly the
// condition being watched for. Letting it reject here would classify a collision
// as an ordinary authentication failure and swallow the signal. What matters on
// this channel is narrower: is this a genuine, signed announcement from a
// different key claiming our id?
func (a *Agent) handleHeartbeatPeers(message *nats.Msg) {
	if rejection := a.guard.checkBytes(len(message.Data)); rejection != nil {
		return
	}
	envelope, err := decodeEnvelope(message.Data)
	if err != nil {
		return
	}
	if envelope.From != a.agentID {
		return
	}
	ours := a.Fingerprint()
	if ours == "" {
		return
	}
	// Our own announcement, echoed back by our own subscription.
	if envelope.Fingerprint == "" || envelope.Fingerprint == ours {
		return
	}
	// Require a valid signature before raising the alarm, so an unauthenticated
	// forgery cannot make an operator chase a collision that is not happening.
	if envelope.Signature != "" && envelope.PublicKey != "" {
		if err := VerifyEnvelope(envelope); err != nil {
			a.logger.Warn("ignoring unsigned claim on this agent's heartbeat subject",
				"from", envelope.From, "error", err)
			return
		}
	} else {
		a.logger.Warn("ignoring unsigned traffic on this agent's heartbeat subject", "from", envelope.From)
		return
	}
	a.noteCollision(Manifest{
		ID:          envelope.From,
		Endpoint:    AgentInboxSubject(envelope.From),
		Fingerprint: envelope.Fingerprint,
	})
}

func (a *Agent) stopHeartbeat() {
	// The heartbeat goroutine exits with the caller's context; nothing to do
	// here beyond letting the connection drain.
}

// manifestsFrom accepts both response shapes seen in the fleet: a registry
// `{agents:[...]}` payload, and a single-agent manifest reply.
func manifestsFrom(envelope *Envelope) []Manifest {
	if envelope == nil || len(envelope.Payload) == 0 {
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
