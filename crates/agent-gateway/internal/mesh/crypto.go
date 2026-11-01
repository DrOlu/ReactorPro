package mesh

// Application-layer payload encryption between mesh edges.
//
// WHY: envelope signatures authenticate the sender but do not conceal the
// payload — the central broker (and anyone on the NATS server) can read every
// skill invocation. Sealed-box encryption seals the payload to the receiving
// edge's identity so only that edge can open it; the broker routes ciphertext.
//
// HOW (and why the signature contract survives untouched):
//
//   1. The sender builds and SIGNS the envelope exactly as before — the
//      signature covers the plaintext payload bytes.
//   2. SealPayloadFor then REPLACES env.Payload with an encrypted payload
//      object ({scheme, nonce, box}) — the signature now covers the
//      ciphertext, which cannot be stripped without breaking verification.
//   3. The receiver calls OpenPayload BEFORE the signature guard: the box is
//      opened with the edge's X25519 key (derived from its Ed25519 identity)
//      and the original plaintext payload is restored. The guard then
//      verifies the signature over the restored plaintext — exactly what the
//      sender signed. Zero changes to SigningPayload, VerifyEnvelope, or any
//      handler.
//
// Keys are derived from the identity the edges already hold and pin — the
// Ed25519 seed converts to an X25519 scalar by the standard SHA-512 +
// clamping transform (RFC-mandated Ed25519→X25519 conversion), so no new key
// ceremony is needed. The recipient's public key travels in the registry
// manifest (Manifest.PubKey), and its integrity is bound by the manifest's
// existing fingerprint.
//
// Scheme "x25519-sb-v1": NaCl sealed box (X25519 + XSalsa20-Poly1305) —
// anonymous, authenticated, with an ephemeral sender key per message.

import (
	cryptorand "crypto/rand"
	"crypto/ed25519"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/box"
)

// EncryptionSchemeSealedBox is the only payload encryption scheme this edge
// understands. Envelopes whose scheme differs are refused, never guessed at.
const EncryptionSchemeSealedBox = "x25519-sb-v1"

// ErrNotEncrypted is returned when a payload does not carry an encrypted
// payload object.
var ErrNotEncrypted = errors.New("mesh payload is not encrypted")

// ErrNotForThisEdge is returned when the sealed payload cannot be opened with
// this edge's key — it was sealed for a different recipient, or the edge
// identity changed after the payload was sealed (rotation requires re-sealing).
var ErrNotForThisEdge = errors.New("mesh payload was not sealed for this edge identity")

// SealPayloadFor replaces env.Payload with an encrypted payload object that
// only the holder of recipientPub can open. Call it AFTER Identity.Sign: the
// signature covers the ciphertext, binding the encrypted form to the sender.
func SealPayloadFor(env *Envelope, recipientX25519Pub [32]byte,
	sender ed25519.PrivateKey) error {
	if env == nil || len(env.Payload) == 0 {
		return errors.New("seal: envelope has no payload")
	}
	var recipientKey [32]byte
	copy(recipientKey[:], recipientX25519Pub[:])
	allZero := true
	for _, b := range recipientKey {
		if b != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		return errors.New("seal: recipient x25519 key is the all-zero point")
	}

	var nonce [24]byte
	if _, err := cryptorand.Read(nonce[:]); err != nil {
		return fmt.Errorf("seal: generate nonce: %w", err)
	}
	// IMPORTANT: golang.org/x/crypto/nacl/box has NO sealed-box helper —
	// box.Seal appends ONLY the ciphertext. The ephemeral sender key is
	// generated here and transmitted alongside (libsodium's crypto_box_seal
	// convention does NOT apply to this API).
	var ephemeralPriv [32]byte
	if _, err := cryptorand.Read(ephemeralPriv[:]); err != nil {
		return fmt.Errorf("seal: generate ephemeral key: %w", err)
	}
	var ephemeralScalar [32]byte
	copy(ephemeralScalar[:], ephemeralPriv[:])
	ephemeralScalar[0] &= 248
	ephemeralScalar[31] &= 127
	ephemeralScalar[31] |= 64
	var ephemeralPub [32]byte
	ephemeralPubSlice, err := curve25519.X25519(ephemeralScalar[:], curve25519.Basepoint)
	if err != nil {
		return fmt.Errorf("seal: derive ephemeral public key: %w", err)
	}
	copy(ephemeralPub[:], ephemeralPubSlice)
	sealed := box.Seal(nil, env.Payload, &nonce, &recipientKey, &ephemeralScalar)

	sealedObj, err := json.Marshal(map[string]string{
		"scheme": EncryptionSchemeSealedBox,
		"epk":    base64.StdEncoding.EncodeToString(ephemeralPub[:]),
		"nonce":  base64.StdEncoding.EncodeToString(nonce[:]),
		"box":    base64.StdEncoding.EncodeToString(sealed),
	})
	if err != nil {
		return err
	}
	env.Payload = sealedObj
	return nil
}

// OpenPayload detects an encrypted payload object on env and restores the
// original plaintext payload. Returns ErrNotEncrypted when the payload is
// plaintext (callers skip decryption and proceed normally), and
// ErrNotForThisEdge when the box cannot be opened with this edge's key.
func OpenPayload(env *Envelope, recipient ed25519.PrivateKey) error {
	if env == nil || len(env.Payload) == 0 {
		return ErrNotEncrypted
	}
	var probe struct {
		Scheme string `json:"scheme"`
	}
	if err := json.Unmarshal(env.Payload, &probe); err != nil {
		return ErrNotEncrypted            // ordinary JSON payload
	}
	if probe.Scheme != EncryptionSchemeSealedBox {
		return ErrNotEncrypted
	}
	var sealed struct {
		EphemeralPub string `json:"epk"`
		Nonce        string `json:"nonce"`
		Box          string `json:"box"`
	}
	if err := json.Unmarshal(env.Payload, &sealed); err != nil {
		return fmt.Errorf("open: malformed sealed payload: %w", err)
	}
	ephemeralPub, err := base64.StdEncoding.DecodeString(sealed.EphemeralPub)
	if err != nil || len(ephemeralPub) != 32 {
		return fmt.Errorf("open: bad ephemeral public key")
	}
	nonceBytes, err := base64.StdEncoding.DecodeString(sealed.Nonce)
	if err != nil || len(nonceBytes) != 24 {
		return fmt.Errorf("open: bad nonce")
	}
	boxBytes, err := base64.StdEncoding.DecodeString(sealed.Box)
	if err != nil || len(boxBytes) < box.Overhead {
		return fmt.Errorf("open: bad box")
	}
	var recipientKey [32]byte
	recipientSecret, err := x25519Secret(recipient)
	if err != nil {
		return err
	}
	copy(recipientKey[:], recipientSecret[:])
	var ephemeralPubArr [32]byte
	copy(ephemeralPubArr[:], ephemeralPub)
	var nonce [24]byte
	copy(nonce[:], nonceBytes)

	plaintext, ok := box.Open(nil, boxBytes, &nonce, &ephemeralPubArr, &recipientKey)
	if !ok {
		return ErrNotForThisEdge
	}
	env.Payload = json.RawMessage(plaintext)
	return nil
}

// EncryptedPayload reports whether env carries a sealed payload object.
func EncryptedPayload(env *Envelope) bool {
	if env == nil || len(env.Payload) == 0 {
		return false
	}
	var probe struct {
		Scheme string `json:"scheme"`
	}
	if err := json.Unmarshal(env.Payload, &probe); err != nil {
		return false
	}
	return probe.Scheme == EncryptionSchemeSealedBox
}

// x25519Secret converts an Ed25519 private key into an X25519 scalar by the
// standard transform: SHA-512 of the seed, first half, clamped.
func x25519Secret(private ed25519.PrivateKey) ([32]byte, error) {
	var out [32]byte
	if len(private) != ed25519.PrivateKeySize {
		return out, errors.New("x25519: private key has the wrong size")
	}
	digest := sha512.Sum512(private.Seed())
	copy(out[:], digest[:32])
	out[0] &= 248
	out[31] &= 127
	out[31] |= 64
	return out, nil
}

// X25519PublicKey derives the edge's X25519 public key (publish it in the
// mesh manifest so senders can seal payloads to this edge). It is NOT the
// Ed25519 public key: the Montgomery form comes from the clamped scalar.
func (i *Identity) X25519PublicKey() ([]byte, error) {
	scalar, err := x25519Secret(i.privateKey)
	if err != nil {
		return nil, err
	}
	return curve25519.X25519(scalar[:], curve25519.Basepoint)
}

// X25519PublicKeyBytes is the no-error variant used by callers that already
// validated the identity (tests, the manifest builder).
func (i *Identity) X25519PublicKeyBytes() [32]byte {
	var out [32]byte
	scalar, err := x25519Secret(i.privateKey)
	if err == nil {
		if pub, err := curve25519.X25519(scalar[:], curve25519.Basepoint); err == nil {
			copy(out[:], pub)
		}
	}
	return out
}
