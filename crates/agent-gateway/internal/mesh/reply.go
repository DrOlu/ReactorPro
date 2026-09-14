package mesh

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
)

// Waiting for a reply that is actually a reply.
//
// `mesh.agent.<id>.inbox` is a request/reply subject, but nothing stops a
// JetStream stream from capturing it — and in this fleet one already does. When
// that happens the server answers the publish itself, delivering a PubAck
// (`{"stream":"…","seq":…}`) to the caller's reply inbox. `conn.Request` takes
// the first message it receives, so it returns the PubAck.
//
// The failure mode is nasty because it is silent: a PubAck decoded into an
// Envelope yields the zero value, so Dispatch reported success and an empty
// response — `{"v":"","id":"","type":"","ts":"","from":""}` — which is
// indistinguishable from a peer that answered with nothing. Callers were told
// the remote invocation worked.
//
// So this does two things conn.Request cannot: it ignores ack-shaped messages
// while it waits, and it refuses to treat anything that is not a mesh envelope
// as a reply.

// isJetStreamPublishAck reports whether a message is a JetStream publish
// acknowledgement rather than a mesh envelope.
//
// The discriminator is the shape, not the exact wording: a PubAck carries
// `stream` and `seq` and none of the envelope's identity fields. Requiring the
// envelope fields to be absent means a genuine envelope can never be mistaken
// for an ack, however a future server phrases its acknowledgement.
func isJetStreamPublishAck(data []byte) bool {
	var probe struct {
		Stream string          `json:"stream"`
		Seq    json.RawMessage `json:"seq"`
		Type   string          `json:"type"`
		ID     string          `json:"id"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return false
	}
	return probe.Stream != "" && len(probe.Seq) > 0 && probe.Type == "" && probe.ID == ""
}

// requestReply publishes a request and waits for a reply, discarding JetStream
// publish acknowledgements that a stream capturing the subject may inject.
//
// Unlike conn.Request this uses its own subscription, because it needs to look
// at more than one message. It builds the envelope itself so that the reply
// inbox can be carried inside the payload — see RequestPayload.ReplyTo — and
// still sets it as the NATS reply subject for peers that use msg.reply on a core
// delivery. It returns the raw reply bytes; interpreting them is the caller's
// job, because only the caller knows what shape it expects.
func (a *Agent) requestReply(conn *nats.Conn, subject string, envelope *Envelope, payload RequestPayload, timeout time.Duration) ([]byte, error) {
	// The fleet's bridges only honour a reply subject with this prefix.
	inbox := strings.Replace(conn.NewRespInbox(), "_INBOX.", "_REPLY.", 1)
	sub, err := conn.SubscribeSync(inbox)
	if err != nil {
		return nil, fmt.Errorf("subscribe to reply inbox: %w", err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	payload.ReplyTo = inbox
	if err := a.attachPayload(envelope, payload); err != nil {
		return nil, err
	}
	raw, err := a.marshal(envelope)
	if err != nil {
		return nil, err
	}

	// Publish after subscribing, and flush so the subscription is registered on
	// the server before the request can be answered. A reply that arrives first
	// would otherwise be lost and read as a timeout.
	if err := conn.PublishRequest(subject, inbox, raw); err != nil {
		return nil, fmt.Errorf("publish request: %w", err)
	}
	if err := conn.Flush(); err != nil {
		return nil, fmt.Errorf("flush request: %w", err)
	}

	deadline := time.Now().Add(timeout)
	acks := 0
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, a.noReplyError(subject, acks, timeout)
		}
		message, err := sub.NextMsg(remaining)
		if err != nil {
			return nil, a.noReplyError(subject, acks, timeout)
		}
		if isJetStreamPublishAck(message.Data) {
			// Not a reply. Keep waiting for one.
			acks++
			continue
		}
		return message.Data, nil
	}
}

// noReplyError explains a timeout in terms the operator can act on. "Timeout"
// alone sends people looking at the peer; the interesting case is a peer that
// never had a chance to answer because the server acked the publish instead.
func (a *Agent) noReplyError(subject string, acks int, timeout time.Duration) error {
	if acks > 0 {
		return fmt.Errorf("no reply on %s within %s (%d JetStream publish ack(s) received instead; a stream capturing this subject prevents the peer from answering — see the mailbox design note on AgentMailboxSubject)",
			subject, timeout, acks)
	}
	return fmt.Errorf("no reply on %s within %s", subject, timeout)
}
