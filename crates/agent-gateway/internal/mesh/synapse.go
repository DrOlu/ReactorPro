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
	// Verified reports that the inbound guard established the sender's identity:
	// a signature that verified against a fingerprint the trust store pinned.
	//
	// False for an unsigned envelope that the prefer mode accepted, and always
	// false under verify-off. "It passed the guard" therefore does not mean "we
	// know who sent it", and a skill with a side effect must check this rather
	// than assume the stronger reading.
	Verified bool
	// CallerFingerprint is the verified fingerprint, empty when Verified is false.
	CallerFingerprint string
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
	// registry is the JetStream KV discovery registry, or nil when it is
	// unavailable or the mode is broadcast. Guarded by mu because auto mode
	// installs it from a detection goroutine after Start returns.
	registry *registryClient
	// mailbox is the durable inbox consumer, or nil when the feature is off or
	// has not started. Guarded by mu because Stop clears it concurrently.
	mailbox *mailbox
	// mailboxErr records why the mailbox is not running, so a failure is
	// reported rather than only logged. Empty when it started or is off.
	mailboxErr string

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

// SetTrustPinRecorder installs a callback invoked when a new peer identity pin
// is learned, so it can be written to durable storage. Without it, pins live
// only as long as the process — which resets the impersonation detection this
// store exists to provide.
func (a *Agent) SetTrustPinRecorder(record func(PeerPin)) {
	if a.guard == nil {
		return
	}
	a.guard.trust.setPinRecorder(record)
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

	a.setManifest(a.buildManifest())

	// Probe and bind the discovery registry before going live. In jetstream mode
	// a failure is fatal, so tear down what this Start created rather than leave a
	// half-started agent behind. In auto mode this only starts a background probe
	// and returns immediately, so a server without JetStream never delays startup.
	if err := a.setupRegistry(ctx); err != nil {
		_ = sub.Unsubscribe()
		if discoverSub != nil {
			_ = discoverSub.Unsubscribe()
		}
		if heartbeatSub != nil {
			_ = heartbeatSub.Unsubscribe()
		}
		a.mu.Lock()
		a.conn = nil
		a.mu.Unlock()
		conn.Close()
		return err
	}

	// The durable mailbox.
	//
	// A failure here is logged loudly and recorded, but it does NOT fail the
	// bridge. The mailbox is an added capability; taking the whole thing down
	// over it would cost discovery, invocation and serving as well, which is a
	// far worse outcome than running without an inbox. This mirrors how the mesh
	// itself is treated by the gateway, and how the discovery and heartbeat
	// subscriptions above are treated here. The reason is reported on
	// /api/mesh/status so it is visible rather than merely logged.
	a.mu.Lock()
	a.mailboxErr = ""
	a.mu.Unlock()
	if err := a.startMailbox(ctx); err != nil {
		a.logger.Error("mesh mailbox failed to start; the mesh continues without it",
			"err", err, "stream", a.config.MailboxStream,
			"hint", "pick a free stream name with -mesh-mailbox-stream, or drop -mesh-mailbox")
		a.mu.Lock()
		a.mailboxErr = err.Error()
		a.mu.Unlock()
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
	agentID := a.agentID
	registry := a.registry
	a.started = false
	a.conn = nil
	a.subs = nil
	a.registry = nil
	a.mu.Unlock()

	if !started || conn == nil {
		return nil
	}
	for _, sub := range subs {
		_ = sub.Unsubscribe()
	}
	// Stop consuming before the connection drains. Anything unacked stays in the
	// stream and comes back to this same durable consumer on the next start,
	// which is the guarantee the mailbox exists to provide.
	a.stopMailbox()
	// Remove the registry entry before draining the connection so a stopped edge
	// disappears from discovery at once; the TTL is only the crash fallback.
	if err := registry.remove(agentID); err != nil {
		a.logger.Debug("mesh registry deregister failed", "error", err)
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
	// Mirror the manifest into the KV registry. This is best-effort: a registry
	// write failure is logged, not returned, because registration and the mesh
	// connection are what keep this edge reachable and neither may depend on it.
	a.publishToRegistry()
	return nil
}

// registryClient returns the live registry client, or nil when discovery must
// broadcast.
func (a *Agent) registryClient() *registryClient {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.registry
}

func (a *Agent) setRegistryClient(client *registryClient) {
	a.mu.Lock()
	a.registry = client
	a.mu.Unlock()
}

// installRegistryIfStarted installs a client only while the agent is running.
// The auto-mode probe runs concurrently with Stop, so this closes the window in
// which a probe completing during shutdown could resurrect a client on an agent
// whose entry was just removed.
func (a *Agent) installRegistryIfStarted(client *registryClient) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.started {
		return false
	}
	a.registry = client
	return true
}

// setupRegistry installs the discovery registry according to the configured
// mode. Auto mode never blocks the connect path: the JetStream probe runs in the
// background and discovery broadcasts until (and unless) it succeeds.
func (a *Agent) setupRegistry(ctx context.Context) error {
	switch a.config.registryMode() {
	case RegistryBroadcast:
		a.logger.Info("mesh discovery registry disabled; using broadcast discovery")
		return nil
	case RegistryJetStream:
		client, err := a.connectRegistry(ctx, registryProbeTimeout)
		if err != nil {
			return fmt.Errorf("mesh registry mode %q requires JetStream: %w", RegistryJetStream, err)
		}
		a.setRegistryClient(client)
		a.logger.Info("mesh discovery registry ready",
			"mode", RegistryJetStream, "bucket", client.bucket, "ttl", client.ttl)
		return nil
	default: // RegistryAuto
		// Detection is asynchronous on purpose: a plain nats-server must not make
		// Start wait out a probe that can only fail.
		go a.detectRegistry(ctx)
		return nil
	}
}

// detectRegistry probes for JetStream off the connect path and, on success,
// installs the client and publishes the current manifest immediately so peers
// find this edge before the first heartbeat.
func (a *Agent) detectRegistry(ctx context.Context) {
	client, err := a.connectRegistry(ctx, registryProbeTimeout)
	if err != nil {
		// Info, not Warn: a plain nats-server is a legitimate deployment and this
		// is the expected path there, not a fault.
		a.logger.Info("mesh discovery registry unavailable; using broadcast discovery", "error", err)
		return
	}
	// Stop may have run while the probe was in flight; do not resurrect a client
	// on a stopped agent.
	if !a.installRegistryIfStarted(client) {
		return
	}
	a.logger.Info("mesh discovery registry ready",
		"mode", RegistryAuto, "bucket", client.bucket, "ttl", client.ttl)
	a.publishToRegistry()
}

// publishToRegistry refreshes this edge's entry in the KV registry with a
// current heartbeat timestamp.
//
// Failures are deliberately swallowed to a log line: the registry is an
// accelerator for discovery, and neither registration nor the heartbeat that
// keeps the edge visible may fail because the bucket is briefly unavailable.
func (a *Agent) publishToRegistry() {
	client := a.registryClient()
	if client == nil {
		return
	}
	manifest := a.Manifest()
	// Refresh the timestamp on the registry copy: the stored manifest's
	// LastHeartbeat is what TTL expiry is measured against, so a heartbeat that
	// republished a stale value would age out even while the edge is alive.
	manifest.LastHeartbeat = timestamp()
	if err := client.publish(manifest); err != nil {
		a.logger.Warn("mesh registry publish failed", "error", err)
	}
}

func (a *Agent) deregisterWith(ctx context.Context, conn *nats.Conn, agentID string) {
	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeRegister,
		TS:      timestamp(),
		From:    agentID,
		Trace:   newTrace(),
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

// Discover lists agents matching a filter.
//
// Discovery uses the JetStream KV registry when it is available, which is
// deterministic: every edge publishes its manifest on register and heartbeat, so
// a peer is either present or it is not and there is no window to fall out of.
// When the registry is not available it falls back to the original broadcast,
// which asks every agent to reply and waits a fixed window.
//
// The two are not merged in the common case: with the registry live, auto mode
// reads it and returns, because broadcasting as well would reintroduce the very
// window the registry exists to remove. Auto mode does broadcast whenever the
// registry is not ready or a read fails, so a mixed fleet — some edges with
// JetStream, some without — still discovers every peer through whichever
// mechanism each edge supports.
func (a *Agent) Discover(ctx context.Context, filter DiscoverFilter) ([]Manifest, error) {
	conn, err := a.connection()
	if err != nil {
		return nil, err
	}

	mode := a.config.registryMode()
	if client := a.registryClient(); mode != RegistryBroadcast && client != nil {
		manifests, registryErr := client.manifests(ctx, filter)
		if registryErr == nil {
			seen := make(map[string]Manifest, len(manifests))
			for _, manifest := range manifests {
				seen[manifest.ID] = manifest
			}
			// `jetstream` means the registry is the only source: the operator has
			// declared that the whole fleet publishes to it, and paying the
			// broadcast window as well would defeat the point of asking for it.
			if mode == RegistryJetStream {
				return a.collectPeers(seen), nil
			}
			// `auto` unions the registry with broadcast, and that is not a
			// nicety — returning the registry alone made an upgraded edge blind
			// to its own fleet. A peer that has not been upgraded, or that runs a
			// different implementation, publishes nothing to the bucket and only
			// answers a broadcast; the registry read still *succeeds*, so the
			// fallback below never triggers and discovery quietly returns almost
			// nothing. That is a worse failure than the lossy window it replaced,
			// because it looks like a healthy mesh with nobody on it.
			broadcast, broadcastErr := a.broadcastDiscover(conn, filter)
			if broadcastErr != nil {
				// The registry answered, so a broadcast problem must not lose what
				// we already have.
				a.logger.Warn("mesh broadcast discovery failed; using the registry alone",
					"error", broadcastErr)
				return a.collectPeers(seen), nil
			}
			for _, manifest := range broadcast {
				if _, ok := seen[manifest.ID]; !ok {
					seen[manifest.ID] = manifest
				}
			}
			return a.collectPeers(seen), nil
		}
		// jetstream mode is a hard requirement: surface the failure rather than
		// silently downgrading to a mechanism the operator turned off.
		if mode == RegistryJetStream {
			return nil, fmt.Errorf("read mesh registry: %w", registryErr)
		}
		a.logger.Warn("mesh registry read failed; falling back to broadcast discovery", "error", registryErr)
	}
	return a.broadcastDiscover(conn, filter)
}

// broadcastDiscover is the original discovery mechanism: ask the registry and
// every agent to answer, and collect replies for the discovery window.
func (a *Agent) broadcastDiscover(conn *nats.Conn, filter DiscoverFilter) ([]Manifest, error) {
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
	return a.collectPeers(seen), nil
}

// collectPeers drops this edge's own manifest and flags a peer using our id.
// Both discovery mechanisms share it so collision handling cannot diverge.
func (a *Agent) collectPeers(seen map[string]Manifest) []Manifest {
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
	return out
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
	// newEnvelope already attaches a fresh trace; no need to mint a second one.
	payload := RequestPayload{Skill: skill, Input: input}
	// Surface a text prompt at the payload's top level as well, so text-based
	// peers can act on it. See RequestPayload.Text.
	if asMap, ok := input.(map[string]any); ok {
		for _, key := range []string{"text", "message", "prompt"} {
			if value, present := asMap[key]; present {
				if text, isString := value.(string); isString && text != "" {
					payload.Text = text
					break
				}
			}
		}
	}
	envelope := a.newEnvelope(TypeRequest, targetAgent, newID())
	// Not conn.Request: a stream capturing the subject makes the server answer
	// the publish, and conn.Request would return that ack as the reply.
	data, err := a.requestReply(conn, AgentInboxSubject(targetAgent), envelope, payload, timeout)
	if err != nil {
		return nil, fmt.Errorf("dispatch %q to %s: %w", skill, targetAgent, err)
	}
	response, err := decodeEnvelope(data)
	if err != nil {
		return nil, err
	}
	// A decoded message that carries no identity is not a mesh envelope, and must
	// not be reported as a successful empty reply. This is the check that turns a
	// silent wrong answer into a loud failure.
	if response.ID == "" || response.Type == "" || response.From == "" {
		return nil, fmt.Errorf("dispatch %q to %s: reply is not a mesh envelope (no id, type or sender)", skill, targetAgent)
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
	callerFingerprint, verified := a.guard.callerIdentity(envelope)
	meta := RequestMeta{
		TaskID:            envelope.TaskID,
		From:              envelope.From,
		Trace:             envelope.Trace,
		Verified:          verified,
		CallerFingerprint: callerFingerprint,
	}
	output, handlerErr := handler(context.Background(), payload.Input, meta)
	if handlerErr != nil {
		// A skill may name the code a peer sees; anything else is internal. Without
		// this every refusal would arrive as 5001, and a caller could not tell "no
		// such operation" from "this edge is broken".
		code, reason := CodeInternalError, handlerErr.Error()
		var refusal *codedError
		if errors.As(handlerErr, &refusal) {
			code, reason = refusal.code, refusal.reason
		}
		a.respondError(message, envelope, code, reason)
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
		// Correlate the answer to the question it answers, rather than relying on
		// the NATS reply subject — that subject is transport, not part of the
		// signed envelope, so it does not survive a store-and-forward path and
		// cannot be verified. InReplyTo is covered by the signature.
		reply.InReplyTo = request.ID
	}
	if reply.Trace == nil {
		// A request that carried no trace still gets a correlateable answer.
		reply.Trace = newTrace()
	}
	if a.identity != nil {
		_ = a.identity.Sign(reply)
	}
	return reply
}

// newTrace mints a trace for an outbound envelope.
//
// Every envelope carries one, including the ones with no task id — registration,
// heartbeats and events. A trace is what lets a peer follow one logical action
// across hops, and it costs two short ids. Both fields are covered by the
// signature (see SigningPayload), so a trace cannot be rewritten in transit.
func newTrace() *Trace { return &Trace{TraceID: newID(), SpanID: newID()} }

func (a *Agent) newEnvelope(messageType MessageType, to, taskID string) *Envelope {
	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    messageType,
		TS:      timestamp(),
		From:    a.agentID,
		To:      to,
		TaskID:  taskID,
		Trace:   newTrace(),
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
	// Refresh the registry entry on the same cadence, so a live edge's manifest
	// never ages out and a crashed edge's does.
	a.publishToRegistry()
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
