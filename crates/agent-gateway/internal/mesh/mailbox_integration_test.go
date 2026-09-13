package mesh

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// matchesSubject reports whether a NATS subject pattern matches a subject, for
// the one assertion that the mailbox stream cannot capture protocol traffic.
func matchesSubject(pattern, subject string) bool {
	patternTokens := strings.Split(pattern, ".")
	subjectTokens := strings.Split(subject, ".")
	for i, token := range patternTokens {
		if token == ">" {
			return true
		}
		if i >= len(subjectTokens) {
			return false
		}
		if token != "*" && token != subjectTokens[i] {
			return false
		}
	}
	return len(patternTokens) == len(subjectTokens)
}

// The mailbox is exercised against a real nats-server with JetStream enabled:
// stream creation, durable consumer position, redelivery and ack are all server
// behaviour, and a stub would assert nothing about them.

// buildTestAgent constructs an agent without starting it, so a test can leave
// mail for an agent that is not there yet — the case the mailbox exists for.
func buildTestAgent(t *testing.T, url, agentID string, mutate func(*Config)) *Agent {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = url
	cfg.AgentID = agentID
	cfg.IdentityPath = t.TempDir() + "/identity.json"
	if mutate != nil {
		mutate(&cfg)
	}
	identity, _, err := LoadIdentity(cfg.IdentityPath, agentID)
	if err != nil {
		t.Fatalf("LoadIdentity: %v", err)
	}
	return NewAgent(cfg, identity, nil)
}

// --- the hazard this design exists to avoid ---------------------------------

// A JetStream stream over the request/reply inbox does not merely fail to add
// durability — it breaks the protocol. This test measures both mechanisms and
// pins them, because the obvious implementation ("just put a stream on the
// inbox subject") is the one a future change would reach for.
//
// Measured against nats-server 2.14.2 / nats.go v1.53.1:
//  1. JetStream answers the publish, so the caller receives the PubAck JSON on
//     its reply inbox instead of the skill's response.
//  2. The delivered message's Reply is the JetStream ack subject, so the
//     consumer cannot answer the caller even if it wanted to.
func TestStreamingTheInboxSubjectWouldBreakRequestReply(t *testing.T) {
	url := startTestNATSJetStream(t)
	agentID := uniqueID("probe")

	caller, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect caller: %v", err)
	}
	defer caller.Close()
	consumerConn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect consumer: %v", err)
	}
	defer consumerConn.Close()

	js, err := jetstream.New(consumerConn)
	if err != nil {
		t.Fatalf("jetstream: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// The naive design, reproduced exactly.
	if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     "INBOX_HAZARD_PROBE",
		Subjects: []string{SubjectAgentInboxPrefix + "*" + SubjectAgentInboxSuffix},
	}); err != nil {
		t.Fatalf("create stream: %v", err)
	}
	consumer, err := js.CreateOrUpdateConsumer(ctx, "INBOX_HAZARD_PROBE", jetstream.ConsumerConfig{
		Durable:       "probe-consumer",
		AckPolicy:     jetstream.AckExplicitPolicy,
		FilterSubject: AgentInboxSubject(agentID),
	})
	if err != nil {
		t.Fatalf("create consumer: %v", err)
	}

	type delivery struct {
		reply string
		data  string
	}
	deliveries := make(chan delivery, 4)
	consume, err := consumer.Consume(func(message jetstream.Msg) {
		deliveries <- delivery{reply: message.Reply(), data: string(message.Data())}
		_ = message.Ack()
	})
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	defer consume.Stop()

	response, requestErr := caller.Request(AgentInboxSubject(agentID), []byte(`{"jsonrpc":"2.0"}`), 2*time.Second)
	if requestErr != nil {
		t.Fatalf("the caller's request failed outright: %v", requestErr)
	}

	// 1. The caller is answered by JetStream, not by any agent. Nothing here
	//    served the request, yet a response arrived — that is the pub ack.
	var pubAck struct {
		Stream string `json:"stream"`
		Seq    uint64 `json:"seq"`
	}
	if err := json.Unmarshal(response.Data, &pubAck); err != nil || pubAck.Stream == "" {
		t.Fatalf("expected a JetStream pub ack on the caller's inbox, got %q (err=%v)", response.Data, err)
	}
	if pubAck.Stream != "INBOX_HAZARD_PROBE" {
		t.Fatalf("pub ack names stream %q, want the probe stream", pubAck.Stream)
	}

	select {
	case got := <-deliveries:
		// 2. The reply subject the consumer is handed is an ack subject, so a
		//    reply published there reaches nobody the caller is listening to.
		if len(got.reply) == 0 || got.reply[0] != '$' {
			t.Fatalf("consumer reply subject = %q, want a JetStream ack subject beginning with '$'", got.reply)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the stream did not capture a core request, so this test no longer proves the hazard")
	}
}

// --- durability -------------------------------------------------------------

// The core promise: mail left for an agent that is not running is still there
// when it starts.
func TestMailboxDeliversMailLeftWhileTheAgentWasAway(t *testing.T) {
	url := startTestNATSJetStream(t)
	targetID := uniqueID("away")

	// The target does not exist yet — this is the point.
	mailboxCfg := func(c *Config) { c.MailboxEnabled = true }

	publisher := buildTestAgent(t, url, uniqueID("sender"), mailboxCfg)
	if err := publisher.Start(t.Context()); err != nil {
		t.Fatalf("start publisher: %v", err)
	}
	defer func() { _ = publisher.Stop(context.Background()) }()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sequence, err := publisher.SendMailboxMessage(ctx, targetID, "echo", map[string]any{"text": "hello"}, "task-1")
	if err != nil {
		t.Fatalf("SendMailboxMessage: %v", err)
	}
	if sequence == 0 {
		t.Fatal("the send returned no stream sequence, so it was not stored")
	}

	// Now the agent arrives.
	received := make(chan any, 4)
	target := buildTestAgent(t, url, targetID, mailboxCfg)
	target.RegisterSkill("echo", func(_ context.Context, input any, meta RequestMeta) (any, error) {
		if meta.TaskID != "task-1" {
			t.Errorf("meta.TaskID = %q, want the task id carried through the mailbox", meta.TaskID)
		}
		if meta.From == "" {
			t.Error("meta.From is empty; the caller identity did not survive")
		}
		received <- input
		return map[string]any{"ok": true}, nil
	})
	if err := target.Start(t.Context()); err != nil {
		t.Fatalf("start target: %v", err)
	}
	defer func() { _ = target.Stop(context.Background()) }()

	select {
	case input := <-received:
		asMap, ok := input.(map[string]any)
		if !ok || asMap["text"] != "hello" {
			t.Fatalf("delivered input = %#v, want the stored payload", input)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("mail left for an absent agent was never delivered")
	}
}

// A transient failure must be retried, and must survive the process restarting
// in between — the durable consumer has to resume its own position rather than
// start over or skip ahead.
func TestMailboxRedeliversAfterATransientFailureAndARestart(t *testing.T) {
	url := startTestNATSJetStream(t)
	targetID := uniqueID("restart")

	mailboxCfg := func(c *Config) { c.MailboxEnabled = true }
	publisher := buildTestAgent(t, url, uniqueID("sender"), mailboxCfg)
	if err := publisher.Start(t.Context()); err != nil {
		t.Fatalf("start publisher: %v", err)
	}
	defer func() { _ = publisher.Stop(context.Background()) }()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := publisher.SendMailboxMessage(ctx, targetID, "flaky", map[string]any{"n": 1}, "task-2"); err != nil {
		t.Fatalf("SendMailboxMessage: %v", err)
	}

	// First life: the skill fails transiently, so the delivery must not be acked.
	failed := make(chan struct{}, 4)
	first := buildTestAgent(t, url, targetID, mailboxCfg)
	first.RegisterSkill("flaky", func(context.Context, any, RequestMeta) (any, error) {
		failed <- struct{}{}
		return nil, &codedError{code: CodeOverloaded, reason: "dependency down"}
	})
	if err := first.Start(t.Context()); err != nil {
		t.Fatalf("start first agent: %v", err)
	}
	select {
	case <-failed:
	case <-time.After(10 * time.Second):
		t.Fatal("the failing skill was never invoked")
	}
	if err := first.Stop(context.Background()); err != nil {
		t.Fatalf("stop first agent: %v", err)
	}

	// Second life, same agent id, same durable consumer: the unacked message must
	// come back, even though this is a brand-new process and connection.
	succeeded := make(chan struct{}, 4)
	second := buildTestAgent(t, url, targetID, mailboxCfg)
	second.RegisterSkill("flaky", func(context.Context, any, RequestMeta) (any, error) {
		succeeded <- struct{}{}
		return map[string]any{"ok": true}, nil
	})
	if err := second.Start(t.Context()); err != nil {
		t.Fatalf("start second agent: %v", err)
	}
	defer func() { _ = second.Stop(context.Background()) }()

	select {
	case <-succeeded:
	case <-time.After(15 * time.Second):
		t.Fatal("an unacknowledged message was not redelivered to the restarted consumer")
	}
}

// A request on the mailbox cannot be answered, so it must not be run at all:
// running it would look like success to nobody while the sender waits for a
// reply that can never arrive.
func TestMailboxRefusesARequestRatherThanAnsweringIt(t *testing.T) {
	url := startTestNATSJetStream(t)
	agentID := uniqueID("refuse")

	agent := buildTestAgent(t, url, agentID, func(c *Config) { c.MailboxEnabled = true })
	invoked := make(chan struct{}, 1)
	agent.RegisterSkill("echo", func(context.Context, any, RequestMeta) (any, error) {
		invoked <- struct{}{}
		return nil, nil
	})
	if err := agent.Start(t.Context()); err != nil {
		t.Fatalf("start agent: %v", err)
	}
	defer func() { _ = agent.Stop(context.Background()) }()

	// Send a real request envelope to the mailbox subject, signed and addressed
	// correctly, so only the type distinguishes it.
	envelope := agent.newEnvelope(TypeRequest, agentID, "task-3")
	if err := agent.attachPayload(envelope, RequestPayload{Skill: "echo"}); err != nil {
		t.Fatalf("attachPayload: %v", err)
	}
	raw, err := agent.marshal(envelope)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	conn, err := agent.connection()
	if err != nil {
		t.Fatalf("connection: %v", err)
	}
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("jetstream: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := js.Publish(ctx, AgentMailboxSubject(agentID), raw); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case <-invoked:
		t.Fatal("a request published to the mailbox was executed; it can never be answered")
	case <-time.After(2 * time.Second):
		// Refused, as intended.
	}
}

// --- the replay exemption ---------------------------------------------------

// The exemption must be exactly one policy wide: a redelivery is accepted, but
// the live path still refuses the same envelope as a replay, and every other
// check still applies to the durable path.
func TestMailboxRedeliverySkipsOnlyTheReplayCheck(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true

	identity, err := GenerateIdentity("acme/lagos/edge-1")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	guard := newInboundGuard(cfg, identity.AgentID, quietLogger())

	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeEmit,
		TS:      timestamp(),
		From:    identity.AgentID,
		To:      identity.AgentID,
		Trace:   newTrace(),
	}
	if err := identity.Sign(envelope); err != nil {
		t.Fatalf("Sign: %v", err)
	}

	// First sighting is fine on both paths.
	if rejection := guard.check(envelope); rejection != nil {
		t.Fatalf("first live check rejected a valid envelope: %v", rejection.reason)
	}
	// The durable path accepts the repeat; that is redelivery.
	if rejection := guard.checkRedelivered(envelope); rejection != nil {
		t.Fatalf("the durable path rejected a redelivery: %v", rejection.reason)
	}
	// The live path still calls it what it is.
	if rejection := guard.check(envelope); rejection == nil {
		t.Fatal("the live path accepted a repeated envelope: the replay cache is not doing its job")
	}

	// Everything else still applies on the durable path: a tampered signature is
	// refused even though the id has already been seen.
	tampered := *envelope
	tampered.Payload = []byte(`{"skill":"echo"}`)
	if rejection := guard.checkRedelivered(&tampered); rejection == nil {
		t.Fatal("the durable path accepted a tampered envelope: the replay exemption must not disable the signature check")
	}
	// As is a message addressed to someone else.
	elsewhere := *envelope
	elsewhere.To = "globex/berlin/edge-1"
	if rejection := guard.checkRedelivered(&elsewhere); rejection == nil {
		t.Fatal("the durable path accepted an envelope addressed to another agent")
	}
	// And a stale one.
	stale := *envelope
	stale.TS = time.Now().UTC().Add(-2 * cfg.ClockSkew).Format(time.RFC3339Nano)
	if rejection := guard.checkRedelivered(&stale); rejection == nil {
		t.Fatal("the durable path accepted an envelope outside the freshness window")
	}
}

// --- plumbing ---------------------------------------------------------------

func TestMailboxDurableNameIsNATSlegalAndStable(t *testing.T) {
	// An agent id containing '/' is normal and cannot be a NATS name.
	first := mailboxDurableName("acme/lagos/edge-1")
	if first != mailboxDurableName("acme/lagos/edge-1") {
		t.Fatal("the durable name is not stable; a restart would create a second consumer and lose the position")
	}
	if first == mailboxDurableName("acme/lagos/edge-2") {
		t.Fatal("two agents share a durable name, so one would consume the other's mail")
	}
	for _, r := range first {
		valid := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-'
		if !valid {
			t.Fatalf("durable name %q contains %q, which NATS does not accept", first, r)
		}
	}
}

// Off by default, and off means off — no stream, no consumer, and a send that
// says so rather than silently publishing into a subject nobody reads.
func TestMailboxIsOffByDefault(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.MailboxEnabled {
		t.Fatal("the mailbox is on by default; it needs JetStream and should be an explicit choice")
	}
	agent := NewAgent(cfg, nil, quietLogger())
	if err := agent.startMailbox(t.Context()); err != nil {
		t.Fatalf("startMailbox with the feature off: %v", err)
	}
	if status := agent.MailboxStatus(); status["running"] != false {
		t.Fatalf("mailbox reports running while disabled: %v", status)
	}
	if _, err := agent.SendMailboxMessage(t.Context(), "acme/lagos/edge-1", "echo", nil, ""); err == nil {
		t.Fatal("a send on a disabled mailbox must fail loudly, not publish into the void")
	}
}

// A zero-valued config built from a struct literal must still produce a usable
// stream name and real bounds.
func TestMailboxDefaultsAreFilledIn(t *testing.T) {
	cfg := Config{MailboxEnabled: true}
	cfg.normalize()
	if cfg.MailboxStream != DefaultMailboxStream {
		t.Fatalf("stream = %q, want %q", cfg.MailboxStream, DefaultMailboxStream)
	}
	if cfg.MailboxMaxAge != DefaultMailboxMaxAge || cfg.MailboxMaxMsgs != DefaultMailboxMaxMsgs {
		t.Fatalf("bounds = %v/%v, want the defaults", cfg.MailboxMaxAge, cfg.MailboxMaxMsgs)
	}
	if got := AgentMailboxSubjectPattern(); got != "mesh.agent.*.mailbox" {
		t.Fatalf("stream subject pattern = %q", got)
	}
	if got := AgentMailboxSubject("acme/lagos/edge-1"); got != "mesh.agent.acme/lagos/edge-1.mailbox" {
		t.Fatalf("mailbox subject = %q", got)
	}
}

// The mailbox must not capture the subjects the protocol depends on.
func TestMailboxStreamDoesNotCaptureProtocolSubjects(t *testing.T) {
	pattern := AgentMailboxSubjectPattern()
	for _, subject := range []string{
		AgentInboxSubject("acme/lagos/edge-1"),
		HeartbeatSubject("acme/lagos/edge-1"),
		SubjectRegistryRegister,
		SubjectRegistryDiscover,
		"mesh.event.something",
	} {
		if matchesSubject(pattern, subject) {
			t.Fatalf("the mailbox stream pattern %q captures %q", pattern, subject)
		}
	}
	if !matchesSubject(pattern, AgentMailboxSubject("acme/lagos/edge-1")) {
		t.Fatal("the mailbox stream pattern does not match an agent mailbox subject")
	}
}
