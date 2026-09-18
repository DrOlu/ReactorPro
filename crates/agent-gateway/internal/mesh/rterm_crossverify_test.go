package mesh

import (
	"encoding/json"
	"os"
	"testing"
)

// TestRtermBridgeCrossVerify is the RTerm reactorpro-bridge compatibility
// contract. It consumes fixtures produced by the plugin
// (plugins/reactorpro-bridge) and verifies them with the gateway's own
// VerifyEnvelope, then signs an envelope the plugin must accept.
//
// The fixture path is passed via env so the test is a no-op when run
// without the RTerm repo present:
//
//	RTERM_BRIDGE_FIXTURES=/path/to/fixtures go test ./internal/mesh -run CrossVerify
func TestRtermBridgeCrossVerify(t *testing.T) {
	dir := os.Getenv("RTERM_BRIDGE_FIXTURES")
	if dir == "" {
		t.Skip("RTERM_BRIDGE_FIXTURES not set; cross-verify is a no-op")
	}

	// 1. The plugin's signed envelope must verify with the gateway's rules.
	raw, err := os.ReadFile(dir + "/plugin_signed_envelope.json")
	if err != nil {
		t.Fatalf("read plugin envelope: %v", err)
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("decode plugin envelope: %v", err)
	}
	if err := VerifyEnvelope(&env); err != nil {
		t.Fatalf("plugin envelope FAILED gateway verification: %v", err)
	}
	// The fingerprint must bind to the claimed sender.
	claimed := env.Fingerprint
	proved, err := EnvelopeFingerprint(&env)
	if err != nil {
		t.Fatalf("derive fingerprint: %v", err)
	}
	if claimed != proved {
		t.Fatalf("fingerprint mismatch: envelope claims %s but key proves %s", claimed, proved)
	}

	// 2. The gateway's signing payload must match the plugin's byte-for-byte.
	// The fixture records the plugin's signing payload for the same envelope
	// fields; recompute it here and compare hex.
	spRaw, err := os.ReadFile(dir + "/plugin_signing_payload.hex")
	if err != nil {
		t.Fatalf("read signing payload fixture: %v", err)
	}
	spHex := string(spRaw)
	for i := 0; i < len(spHex); i++ {
		if spHex[i] == '\n' || spHex[i] == ' ' {
			spHex = spHex[:i]
			break
		}
	}
	got := SigningPayload(&env)
	gotHex := hexEncode(got)
	if gotHex != spHex {
		t.Fatalf("signing payload mismatch:\n gateway: %s\n plugin:  %s", gotHex, spHex)
	}

	// 3. A gateway-signed envelope (from a gateway identity) must verify under
	// the plugin's rules — the plugin fixture records its verdict.
	idRaw, err := os.ReadFile(dir + "/gateway_identity.json")
	if err != nil {
		t.Fatalf("read gateway identity: %v", err)
	}
	id, err := ParseIdentity(idRaw)
	if err != nil {
		t.Fatalf("parse gateway identity: %v", err)
	}
	env2 := Envelope{
		Version: ProtocolVersion,
		ID:      "cross-verify-2",
		Type:    TypeRespond,
		TS:      "2026-09-17T00:00:00Z",
		From:    id.AgentID,
		To:      "rterm-001",
		Payload: json.RawMessage(`{"output":{"cross":true}}`),
	}
	if err := id.Sign(&env2); err != nil {
		t.Fatalf("sign: %v", err)
	}
	// Write it for the plugin side to verify.
	out, _ := json.MarshalIndent(env2, "", "  ")
	if err := os.WriteFile(dir+"/gateway_signed_envelope.json", out, 0o644); err != nil {
		t.Fatalf("write gateway envelope: %v", err)
	}
}

func hexEncode(b []byte) string {
	const hexDigits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, hexDigits[c>>4], hexDigits[c&0x0f])
	}
	return string(out)
}