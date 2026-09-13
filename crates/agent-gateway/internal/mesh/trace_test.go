package mesh

import (
	"testing"
)

// Every outbound envelope carries a trace, including the ones with no task id.
// A trace is what lets a peer follow one logical action across hops.
func TestOutboundEnvelopesCarryATrace(t *testing.T) {
	cfg := DefaultConfig()
	agent := NewAgent(cfg, nil, quietLogger())

	// A deregistration travels as TypeRegister on the deregister subject, so the
	// distinct types are these five.
	types := []MessageType{TypeRequest, TypeDiscover, TypeRegister, TypeEmit, TypeHeartbeat}
	for _, messageType := range types {
		envelope := agent.newEnvelope(messageType, "globex/berlin/edge-1", "")
		if envelope.Trace == nil {
			t.Fatalf("%s envelope carries no trace", messageType)
		}
		if envelope.Trace.TraceID == "" || envelope.Trace.SpanID == "" {
			t.Fatalf("%s envelope has an empty trace: %+v", messageType, envelope.Trace)
		}
	}

	// Distinct messages must not share a trace id, or correlation is meaningless.
	first := agent.newEnvelope(TypeEmit, "globex/berlin/edge-1", "")
	second := agent.newEnvelope(TypeEmit, "globex/berlin/edge-1", "")
	if first.Trace.TraceID == second.Trace.TraceID {
		t.Fatal("two envelopes share a trace id")
	}
}

// A reply names the message it answers, and continues the request's trace.
func TestReplyCarriesInReplyToAndInheritsTrace(t *testing.T) {
	cfg := DefaultConfig()
	agent := NewAgent(cfg, nil, quietLogger())

	request := agent.newEnvelope(TypeRequest, agent.AgentID(), newID())
	request.From = "globex/berlin/edge-1"

	reply := agent.replyEnvelope(request)

	if reply.InReplyTo != request.ID {
		t.Fatalf("InReplyTo = %q, want the request id %q", reply.InReplyTo, request.ID)
	}
	if reply.Trace == nil || reply.Trace.TraceID != request.Trace.TraceID {
		t.Fatalf("reply trace = %+v, want the request's trace %+v", reply.Trace, request.Trace)
	}
	if reply.To != request.From {
		t.Fatalf("reply To = %q, want the requester %q", reply.To, request.From)
	}
	if reply.Type != TypeRespond {
		t.Fatalf("reply type = %q, want %q", reply.Type, TypeRespond)
	}
}

// A request that arrived without a trace still gets a correlateable answer.
func TestReplyMintsATraceWhenTheRequestHasNone(t *testing.T) {
	cfg := DefaultConfig()
	agent := NewAgent(cfg, nil, quietLogger())

	request := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeRequest,
		TS:      timestamp(),
		From:    "globex/berlin/edge-1",
		To:      agent.AgentID(),
		// No trace, as a peer that does not populate one would send.
	}

	reply := agent.replyEnvelope(request)

	if reply.Trace == nil || reply.Trace.TraceID == "" {
		t.Fatal("a reply to a traceless request must still carry a trace")
	}
	if reply.InReplyTo != request.ID {
		t.Fatalf("InReplyTo = %q, want %q", reply.InReplyTo, request.ID)
	}
}

// A reply to nothing in particular must not panic — the error path calls this
// with a nil request.
func TestReplyEnvelopeToleratesANilRequest(t *testing.T) {
	cfg := DefaultConfig()
	agent := NewAgent(cfg, nil, quietLogger())

	reply := agent.replyEnvelope(nil)
	if reply.Type != TypeRespond {
		t.Fatalf("type = %q, want %q", reply.Type, TypeRespond)
	}
	if reply.InReplyTo != "" {
		t.Fatalf("InReplyTo = %q, want empty when there is no request", reply.InReplyTo)
	}
	if reply.Trace == nil {
		t.Fatal("even an uncorrelated reply should carry a trace")
	}
}

// The point of populating these fields is that they are *covered by the
// signature* (see SigningPayload). If they were not, they would be a forgeable
// correlation hint — worse than absent, because they would look trustworthy.
func TestCorrelationFieldsAreCoveredByTheSignature(t *testing.T) {
	identity, err := GenerateIdentity("acme/lagos/edge-1")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}

	newSignedReply := func(t *testing.T) *Envelope {
		t.Helper()
		reply := &Envelope{
			Version:   ProtocolVersion,
			ID:        newID(),
			Type:      TypeRespond,
			TS:        timestamp(),
			From:      identity.AgentID,
			To:        "globex/berlin/edge-1",
			TaskID:    newID(),
			InReplyTo: newID(),
			Trace:     newTrace(),
		}
		if err := identity.Sign(reply); err != nil {
			t.Fatalf("Sign: %v", err)
		}
		if err := VerifyEnvelope(reply); err != nil {
			t.Fatalf("a freshly signed reply failed verification: %v", err)
		}
		return reply
	}

	t.Run("in_reply_to", func(t *testing.T) {
		reply := newSignedReply(t)
		reply.InReplyTo = newID()
		if err := VerifyEnvelope(reply); err == nil {
			t.Fatal("rewriting in_reply_to left the signature valid — it is not covered by the signature")
		}
	})

	t.Run("trace id", func(t *testing.T) {
		reply := newSignedReply(t)
		reply.Trace.TraceID = newID()
		if err := VerifyEnvelope(reply); err == nil {
			t.Fatal("rewriting the trace id left the signature valid — it is not covered by the signature")
		}
	})

	t.Run("trace span", func(t *testing.T) {
		reply := newSignedReply(t)
		reply.Trace.SpanID = newID()
		if err := VerifyEnvelope(reply); err == nil {
			t.Fatal("rewriting the trace span left the signature valid")
		}
	})

	t.Run("trace removed", func(t *testing.T) {
		reply := newSignedReply(t)
		reply.Trace = nil
		if err := VerifyEnvelope(reply); err == nil {
			t.Fatal("stripping the trace left the signature valid")
		}
	})
}
