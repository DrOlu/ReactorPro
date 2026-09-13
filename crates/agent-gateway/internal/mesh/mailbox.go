package mesh

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// mailboxRetryDelay separates redelivery attempts for a transiently failing
// skill, so an outage in a dependency does not turn into a retry storm.
const mailboxRetryDelay = 5 * time.Second

// The durable agent mailbox.
//
// Core NATS is fire-and-forget: a skill request published to an agent that is
// momentarily away is simply gone, and the sender's only recourse is to try
// again. The mailbox gives an edge a place to leave work for an agent that is
// not there yet — a JetStream stream captures `mesh.agent.*.mailbox`, and each
// edge consumes its own messages from a durable consumer, so a message
// published while it was down is delivered when it comes back.
//
// What this is not, and deliberately so:
//
//   - It does not make request/reply durable. See AgentMailboxSubject: a stream
//     over the inbox breaks the protocol outright.
//   - It is not a queue for arbitrary traffic. Only mailbox messages are
//     captured, and only the mesh envelope types that expect no reply are
//     accepted; a request arriving on the mailbox is terminated rather than
//     answered, because there is nowhere to answer it.
//   - Delivery is at-least-once. A message is acked only after the skill handler
//     returns successfully, so an unacked delivery is retried; a skill reached
//     this way must therefore be idempotent.
type mailbox struct {
	consume jetstream.ConsumeContext
	stream  jetstream.Stream
	// name is the durable consumer name, kept for logging and tests.
	name string
}

// mailboxDurableName derives a NATS-legal durable name from an agent id.
//
// The id is not usable as a durable name directly: ids are free-form and
// routinely contain `/` (acme/lagos/edge-1), which NATS rejects in a name. A
// hash keeps the name valid, stable across restarts — so the consumer resumes
// its own position rather than starting a second one — and collision-resistant
// enough that two edges cannot adopt each other's mail.
func mailboxDurableName(agentID string) string {
	sum := sha256.Sum256([]byte(agentID))
	return "mailbox-" + hex.EncodeToString(sum[:8])
}

// startMailbox creates the stream and consumer and begins delivering to the
// agent's skill handlers. It is a no-op when the feature is off.
func (a *Agent) startMailbox(ctx context.Context) error {
	if !a.config.MailboxEnabled {
		return nil
	}
	conn, err := a.connection()
	if err != nil {
		return err
	}
	js, err := jetstream.New(conn)
	if err != nil {
		return fmt.Errorf("create JetStream context for mailbox: %w", err)
	}

	// Bounded on both axes: a mailbox is a handoff buffer, not an archive, so an
	// agent that never returns cannot grow the store without limit. DiscardOld
	// drops the oldest undelivered message under pressure, which is the right
	// loss for a mailbox — the newest instruction is the one that still matters.
	stream, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:        a.config.MailboxStream,
		Description: "durable mailbox for mesh agents (mesh.agent.*.mailbox)",
		Subjects:    []string{AgentMailboxSubjectPattern()},
		MaxAge:      a.config.MailboxMaxAge,
		MaxMsgs:     a.config.MailboxMaxMsgs,
		Storage:     jetstream.FileStorage,
		Discard:     jetstream.DiscardOld,
	})
	if err != nil {
		return fmt.Errorf("create mailbox stream %q: %w", a.config.MailboxStream, err)
	}

	name := mailboxDurableName(a.agentID)
	consumer, err := js.CreateOrUpdateConsumer(ctx, a.config.MailboxStream, jetstream.ConsumerConfig{
		Durable:       name,
		Description:   "mailbox for " + a.agentID,
		FilterSubject: AgentMailboxSubject(a.agentID),
		AckPolicy:     jetstream.AckExplicitPolicy,
		// No MaxDeliver: redelivery is the mechanism that makes the mailbox
		// useful, and capping it would silently discard work for an agent that
		// was away longer than the cap allowed.
		MaxAckPending: 256,
	})
	if err != nil {
		return fmt.Errorf("create mailbox consumer %q: %w", name, err)
	}

	consume, err := consumer.Consume(a.handleMailboxMessage)
	if err != nil {
		return fmt.Errorf("consume mailbox: %w", err)
	}

	a.mu.Lock()
	a.mailbox = &mailbox{consume: consume, stream: stream, name: name}
	a.mu.Unlock()

	a.logger.Info("mesh mailbox consuming",
		"stream", a.config.MailboxStream,
		"subject", AgentMailboxSubject(a.agentID),
		"consumer", name,
		"maxAge", a.config.MailboxMaxAge)
	return nil
}

// stopMailbox halts delivery. Undelivered messages stay in the stream and are
// redelivered to the same durable consumer on the next start — that is the
// whole point, so this must not purge anything.
func (a *Agent) stopMailbox() {
	a.mu.Lock()
	box := a.mailbox
	a.mailbox = nil
	a.mu.Unlock()
	if box != nil && box.consume != nil {
		box.consume.Stop()
	}
}

// handleMailboxMessage delivers one mailbox envelope to a skill handler and
// settles the delivery according to the outcome.
//
// Nothing is ever published in response: a mailbox message has no reply path,
// so there is no caller to answer. The result is logged instead, and a sender
// that needs an answer should use the request/reply inbox or the remote-task
// path, both of which have one.
func (a *Agent) handleMailboxMessage(message jetstream.Msg) {
	// Deliberate ordering: nothing here may panic, because a panic in a Consume
	// callback takes the process down. Every path either settles the message or
	// leaves it unacked for redelivery.
	if rejection := a.guard.checkBytes(len(message.Data())); rejection != nil {
		// Too large to be a valid envelope; retrying cannot help.
		_ = message.Term()
		return
	}
	envelope, err := decodeEnvelope(message.Data())
	if err != nil {
		a.logger.Warn("discarding undecodable mailbox message", "error", err)
		_ = message.Term()
		return
	}
	if rejection := a.guard.checkRedelivered(envelope); rejection != nil {
		// Signature, trust, addressee and freshness all still apply. Terminate
		// rather than retry: a message that fails these will fail identically
		// every time, so redelivering it would only spin.
		a.logger.Warn("refusing mailbox message",
			"code", rejection.code, "reason", rejection.reason, "from", envelope.From)
		_ = message.Term()
		return
	}

	// A mailbox message is one-way by construction. Answering is impossible, so
	// accepting a request here would leave its sender waiting for a reply that
	// can never come; refuse it instead of appearing to succeed.
	if envelope.Type == TypeRequest {
		a.logger.Warn("refusing a request on the mailbox subject: it has no reply path",
			"from", envelope.From, "id", envelope.ID,
			"hint", "request/reply belongs on the agent inbox subject, which is not streamed")
		_ = message.Term()
		return
	}

	var payload RequestPayload
	if len(envelope.Payload) > 0 {
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			a.logger.Warn("discarding mailbox message with a malformed payload",
				"from", envelope.From, "error", err)
			_ = message.Term()
			return
		}
	}

	a.mu.RLock()
	handler := a.handlers[payload.Skill]
	a.mu.RUnlock()
	if handler == nil {
		// The skill set can differ between restarts — an edge may be upgraded
		// while mail is queued. Dropping is right: the skill will not appear by
		// waiting.
		a.logger.Warn("discarding mailbox message for an unknown skill",
			"from", envelope.From, "skill", payload.Skill, "id", envelope.ID)
		_ = message.Term()
		return
	}

	callerFingerprint, verified := a.guard.callerIdentity(envelope)
	output, handlerErr := handler(context.Background(), payload.Input, RequestMeta{
		TaskID:            envelope.TaskID,
		From:              envelope.From,
		Trace:             envelope.Trace,
		Verified:          verified,
		CallerFingerprint: callerFingerprint,
	})
	if handlerErr != nil {
		code, reason := CodeInternalError, handlerErr.Error()
		var refusal *codedError
		if errors.As(handlerErr, &refusal) {
			code, reason = refusal.code, refusal.reason
		}
		if retryableCode(code) {
			// A transient failure is exactly what redelivery is for — but on a
			// delay. A bare Nak redelivers immediately, so a skill that is failing
			// while its dependency is down would spin at full speed, logging and
			// burning CPU for as long as the outage lasted.
			a.logger.Warn("mailbox delivery will be retried",
				"from", envelope.From, "skill", payload.Skill, "code", code,
				"reason", reason, "retryIn", mailboxRetryDelay)
			_ = message.NakWithDelay(mailboxRetryDelay)
			return
		}
		a.logger.Warn("discarding mailbox message after a permanent failure",
			"from", envelope.From, "skill", payload.Skill, "code", code, "reason", reason)
		_ = message.Term()
		return
	}

	// Ack only now: the work is done, so the message will not come back.
	if err := message.Ack(); err != nil {
		a.logger.Warn("failed to ack a mailbox message; it will be redelivered",
			"from", envelope.From, "skill", payload.Skill, "error", err)
		return
	}
	a.logger.Info("mailbox message handled",
		"from", envelope.From, "skill", payload.Skill, "taskId", envelope.TaskID,
		"verified", verified, "output", truncateForLog(output))
}

// SendMailboxMessage leaves a skill invocation in a peer's durable mailbox.
//
// It publishes through JetStream rather than core NATS so the send is
// acknowledged: a caller that gets an error here knows the message was not
// stored, which is the guarantee core NATS cannot give. It does not wait for
// the work to be done — the mailbox is one-way, and the peer may not even be
// running yet.
//
// Returns the stream sequence the message was stored at, which is a receipt
// the caller can log.
func (a *Agent) SendMailboxMessage(ctx context.Context, targetAgent, skill string, input map[string]any, taskID string) (uint64, error) {
	if !a.config.MailboxEnabled {
		return 0, fmt.Errorf("the mailbox is not enabled on this edge; start it with -mesh-mailbox")
	}
	if targetAgent == "" {
		return 0, fmt.Errorf("a mailbox message needs a target agent")
	}
	conn, err := a.connection()
	if err != nil {
		return 0, err
	}
	js, err := jetstream.New(conn)
	if err != nil {
		return 0, fmt.Errorf("create JetStream context: %w", err)
	}

	envelope := a.newEnvelope(TypeEmit, targetAgent, taskID)
	if err := a.attachPayload(envelope, RequestPayload{Skill: skill, Input: input}); err != nil {
		return 0, err
	}
	raw, err := a.marshal(envelope)
	if err != nil {
		return 0, err
	}

	ack, err := js.Publish(ctx, AgentMailboxSubject(targetAgent), raw)
	if err != nil {
		return 0, fmt.Errorf("publish to %s: %w", AgentMailboxSubject(targetAgent), err)
	}
	return ack.Sequence, nil
}

// MailboxStatus reports whether the mailbox is running, for the status API.
func (a *Agent) MailboxStatus() map[string]any {
	a.mu.RLock()
	box := a.mailbox
	a.mu.RUnlock()

	status := map[string]any{
		"enabled": a.config.MailboxEnabled,
		"subject": AgentMailboxSubject(a.agentID),
		"stream":  a.config.MailboxStream,
	}
	status["running"] = box != nil
	if box != nil {
		status["consumer"] = box.name
	}
	return status
}

// truncateForLog keeps a handler's output out of the log's exponential path:
// output is arbitrary and unbounded, and a log line is not a result channel.
func truncateForLog(output any) string {
	if output == nil {
		return ""
	}
	raw, err := json.Marshal(output)
	if err != nil {
		return "<unencodable>"
	}
	const limit = 256
	if len(raw) > limit {
		return string(raw[:limit]) + "…"
	}
	return string(raw)
}
