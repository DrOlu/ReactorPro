package mesh

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrIdentityTampered is returned when an identity file no longer matches the
// fingerprint it was created with.
var ErrIdentityTampered = errors.New("mesh identity fingerprint does not match: the agent id or key was modified")

// Identity is an agent's immutable mesh identity: an Ed25519 keypair bound to
// an agent id.
//
// The id is part of the fingerprint, so editing the id (or the key) invalidates
// the fingerprint and the identity refuses to load. That is what makes the
// agent id unchangeable — possession of the matching private key is the only
// way to speak as this agent.
type Identity struct {
	AgentID       string `json:"identity"`
	PrivateKeyPEM string `json:"privateKeyPem"`
	PublicKeyPEM  string `json:"publicKeyPem"`
	Fingerprint   string `json:"fingerprint"`

	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
}

// FingerprintFor derives the identity fingerprint from the agent id and the
// raw public key. Including the id is deliberate: it binds id to key.
func FingerprintFor(agentID string, publicKey ed25519.PublicKey) string {
	sum := sha256.Sum256(append([]byte(agentID+"\n"), publicKey...))
	return "sha256:" + hex.EncodeToString(sum[:])[:16]
}

// GenerateIdentity mints a new identity for agentID.
func GenerateIdentity(agentID string) (*Identity, error) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return nil, errors.New("agent id is required")
	}
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, fmt.Errorf("generate ed25519 key: %w", err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("marshal private key: %w", err)
	}
	spki, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return nil, fmt.Errorf("marshal public key: %w", err)
	}
	return &Identity{
		AgentID:       agentID,
		PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})),
		PublicKeyPEM:  string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: spki})),
		Fingerprint:   FingerprintFor(agentID, publicKey),
		privateKey:    privateKey,
		publicKey:     publicKey,
	}, nil
}

// ParseIdentity loads and verifies an identity from its JSON representation.
func ParseIdentity(raw []byte) (*Identity, error) {
	var identity Identity
	if err := json.Unmarshal(raw, &identity); err != nil {
		return nil, fmt.Errorf("parse identity: %w", err)
	}
	if strings.TrimSpace(identity.AgentID) == "" {
		return nil, errors.New("identity is missing its agent id")
	}
	privateKey, err := parsePrivateKey(identity.PrivateKeyPEM)
	if err != nil {
		return nil, err
	}
	publicKey, err := parsePublicKey(identity.PublicKeyPEM)
	if err != nil {
		return nil, err
	}
	// The private key must match the advertised public key.
	derived, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok || !derived.Equal(publicKey) {
		return nil, errors.New("identity private key does not match its public key")
	}
	expected := FingerprintFor(identity.AgentID, publicKey)
	if identity.Fingerprint != expected {
		return nil, ErrIdentityTampered
	}
	identity.privateKey = privateKey
	identity.publicKey = publicKey
	return &identity, nil
}

// LoadIdentity reads an identity file, creating it on first use.
//
// Creation is deliberate rather than implicit: minting an identity changes the
// agent's permanent id, so it only happens when the file is absent.
func LoadIdentity(path, agentID string) (*Identity, bool, error) {
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		identity, parseErr := ParseIdentity(raw)
		if parseErr != nil {
			return nil, false, parseErr
		}
		if agentID != "" && identity.AgentID != agentID {
			return nil, false, fmt.Errorf(
				"identity at %s belongs to %q, not %q: the agent id is part of the fingerprint and cannot be reassigned",
				path, identity.AgentID, agentID,
			)
		}
		return identity, false, nil
	case !os.IsNotExist(err):
		return nil, false, fmt.Errorf("read identity: %w", err)
	}

	identity, err := GenerateIdentity(agentID)
	if err != nil {
		return nil, false, err
	}
	if err := saveIdentity(path, identity); err != nil {
		return nil, false, err
	}
	return identity, true, nil
}

func saveIdentity(path string, identity *Identity) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create identity directory: %w", err)
		}
	}
	raw, err := json.MarshalIndent(identity, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal identity: %w", err)
	}
	// Private key material: owner-only.
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		return fmt.Errorf("write identity: %w", err)
	}
	return nil
}

// PublicKey returns the agent's Ed25519 public key.
func (i *Identity) PublicKey() ed25519.PublicKey { return i.publicKey }

// SigningPayload is the deterministic byte string a signature covers. It is a
// field-joined digest rather than re-serialised JSON so any language can
// reproduce it.
func SigningPayload(env *Envelope) []byte {
	var builder strings.Builder
	for _, part := range []string{
		env.Version, env.ID, string(env.Type), env.TS, env.From, env.To, env.TaskID,
	} {
		builder.WriteString(part)
		builder.WriteByte('\n')
	}
	sum := sha256.Sum256(env.Payload)
	builder.Write(sum[:])
	return []byte(builder.String())
}

// Sign attaches the agent's signature and public key to an envelope.
func (i *Identity) Sign(env *Envelope) error {
	if i == nil || i.privateKey == nil {
		return errors.New("mesh identity is not loaded")
	}
	env.Signature = hex.EncodeToString(ed25519.Sign(i.privateKey, SigningPayload(env)))
	env.PublicKey = i.PublicKeyPEM
	return nil
}

// VerifyEnvelope checks an envelope's signature against the embedded public key
// and confirms the key hashes to the fingerprint the sender claims.
func VerifyEnvelope(env *Envelope) error {
	if env.Signature == "" || env.PublicKey == "" {
		return errors.New("envelope is not signed")
	}
	publicKey, err := parsePublicKey(env.PublicKey)
	if err != nil {
		return err
	}
	signature, err := hex.DecodeString(env.Signature)
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}
	// Verify against a copy without the signature fields so the payload digest
	// matches what the sender signed.
	unsigned := *env
	unsigned.Signature = ""
	unsigned.PublicKey = ""
	if !ed25519.Verify(publicKey, SigningPayload(&unsigned), signature) {
		return errors.New("envelope signature is invalid")
	}
	return nil
}

func parsePrivateKey(value string) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode([]byte(value))
	if block == nil {
		return nil, errors.New("identity private key is not valid PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("identity private key is not Ed25519")
	}
	return privateKey, nil
}

func parsePublicKey(value string) (ed25519.PublicKey, error) {
	block, _ := pem.Decode([]byte(value))
	if block == nil {
		return nil, errors.New("identity public key is not valid PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse public key: %w", err)
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("identity public key is not Ed25519")
	}
	return publicKey, nil
}
