package mesh

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func keyPair(t *testing.T, id string) *Identity {
	t.Helper()
	identity, err := GenerateIdentity(id)
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}
	return identity
}

func TestSealOpenRoundTrip(t *testing.T) {
	sender := keyPair(t, "org-a-edge")
	receiver := keyPair(t, "org-b-edge")
	env := &Envelope{Version: ProtocolVersion, ID: newID(), Type: TypeRequest,
		TS: timestamp(), From: sender.AgentID, To: receiver.AgentID,
		Payload: json.RawMessage(`{"skill":"incidents.count","args":{"period":"7d"}}`)}
	if err := sender.Sign(env); err != nil {
		t.Fatalf("sign: %v", err)
	}
	if err := SealPayloadFor(env, receiver.X25519PublicKeyBytes(), sender.privateKey); err != nil {
		t.Fatalf("seal: %v", err)
	}
	if !EncryptedPayload(env) {
		t.Fatal("payload must report as encrypted")
	}
	// sign-then-encrypt: the signature verifies over the RESTORED plaintext
	if err := OpenPayload(env, receiver.privateKey); err != nil {
		t.Fatalf("open: %v", err)
	}
	if !strings.Contains(string(env.Payload), "incidents.count") {
		t.Fatalf("plaintext not restored: %s", env.Payload)
	}
	if err := VerifyEnvelope(env); err != nil {
		t.Fatalf("signature must also verify over the restored plaintext: %v", err)
	}
}

func TestSealedPayloadRefusesWrongKey(t *testing.T) {
	sender := keyPair(t, "org-a-edge")
	receiver := keyPair(t, "org-b-edge")
	impersonator := keyPair(t, "org-b-edge-imposter")
	env := &Envelope{Version: ProtocolVersion, ID: newID(), Type: TypeRequest,
		TS: timestamp(), From: sender.AgentID, To: receiver.AgentID,
		Payload: json.RawMessage(`{"secret":true}`)}
	if err := sender.Sign(env); err != nil {
		t.Fatalf("sign: %v", err)
	}
	if err := SealPayloadFor(env, receiver.X25519PublicKeyBytes(), sender.privateKey); err != nil {
		t.Fatalf("seal: %v", err)
	}
	if err := OpenPayload(env, impersonator.privateKey); !errors.Is(err, ErrNotForThisEdge) {
		t.Fatalf("wrong key: want ErrNotForThisEdge, got %v", err)
	}
}

func TestSealedPayloadTamperRefused(t *testing.T) {
	sender := keyPair(t, "org-a-edge")
	receiver := keyPair(t, "org-b-edge")
	env := &Envelope{Version: ProtocolVersion, ID: newID(), Type: TypeRequest,
		TS: timestamp(), From: sender.AgentID, To: receiver.AgentID,
		Payload: json.RawMessage(`{"amount":100}`)}
	if err := SealPayloadFor(env, receiver.X25519PublicKeyBytes(), sender.privateKey); err != nil {
		t.Fatalf("seal: %v", err)
	}
	var sealedObj map[string]any
	if err := json.Unmarshal(env.Payload, &sealedObj); err != nil {
		t.Fatal(err)
	}
	boxStr := sealedObj["box"].(string)
	boxBytes := []byte(boxStr)
	boxBytes[len(boxBytes)/2] ^= 0xff
	sealedObj["box"] = string(boxBytes)
	raw, _ := json.Marshal(sealedObj)
	env.Payload = raw
	if err := OpenPayload(env, receiver.privateKey); err == nil {
		t.Fatal("tampered box must fail to open")
	}
}

func TestPlaintextPayloadSkipsDecryption(t *testing.T) {
	receiver := keyPair(t, "org-b-edge")
	env := &Envelope{Payload: json.RawMessage(`{"plain":true}`)}
	if err := OpenPayload(env, receiver.privateKey); !errors.Is(err, ErrNotEncrypted) {
		t.Fatalf("plaintext must report ErrNotEncrypted, got %v", err)
	}
}

func TestCrossEdgeSealOpen(t *testing.T) {
	a, c, b := keyPair(t, "edge-a"), keyPair(t, "edge-c"), keyPair(t, "edge-b")
	env := &Envelope{Version: ProtocolVersion, ID: newID(), Type: TypeRespond,
		TS: timestamp(), From: c.AgentID, To: a.AgentID,
		Payload: json.RawMessage(`{"p1":7,"sla_breaches":2}`)}
	if err := c.Sign(env); err != nil {
		t.Fatal(err)
	}
	if err := SealPayloadFor(env, a.X25519PublicKeyBytes(), c.privateKey); err != nil {
		t.Fatal(err)
	}
	if err := OpenPayload(env, b.privateKey); !errors.Is(err, ErrNotForThisEdge) {
		t.Fatal("third edge must not read A-C traffic")
	}
	if err := OpenPayload(env, a.privateKey); err != nil {
		t.Fatalf("recipient edge failed: %v", err)
	}
}

func TestSealRejectsBadKeys(t *testing.T) {
	sender := keyPair(t, "org-a-edge")
	env := &Envelope{Version: ProtocolVersion, ID: newID(), Type: TypeRequest,
		TS: timestamp(), From: sender.AgentID, Payload: json.RawMessage(`{"x":1}`)}
	if err := SealPayloadFor(env, [32]byte{}, sender.privateKey); err == nil {
		t.Fatal("empty recipient key must be rejected")
	}
}
