package mesh

import (
	"regexp"
	"strings"
	"testing"
	"time"
)

// natsKVKeyRe is the character class nats.go accepts for a KV key, copied from
// the vendored source so the test fails if this code ever produces something the
// client library would reject.
var natsKVKeyRe = regexp.MustCompile(`^[-/_=.a-zA-Z0-9]+$`)

func assertUsableKVKey(t *testing.T, key string) {
	t.Helper()
	if key == "" {
		t.Fatal("registry key must not be empty")
	}
	if key[0] == '.' || key[len(key)-1] == '.' || strings.Contains(key, "..") {
		t.Fatalf("registry key %q has a forbidden leading, trailing, or doubled dot", key)
	}
	if !natsKVKeyRe.MatchString(key) {
		t.Fatalf("registry key %q contains characters nats.go rejects", key)
	}
	// The stricter property this implementation deliberately guarantees: no dot
	// at all, so the key is a single subject token and cannot be split.
	if strings.Contains(key, ".") {
		t.Fatalf("registry key %q contains a dot, which splits it across subject tokens", key)
	}
	for _, wildcard := range []string{"*", ">"} {
		if strings.Contains(key, wildcard) {
			t.Fatalf("registry key %q contains the subject wildcard %q", key, wildcard)
		}
	}
}

// TestRegistryKeyEncoding pins the chosen behaviour for the two id shapes that
// motivate the encoding: a slash (valid in a KV key but not a token separator)
// and a dot (valid in a KV key but a subject-token separator).
func TestRegistryKeyEncoding(t *testing.T) {
	ids := []string{
		"acme/lagos/edge-1",
		"acme.lagos.edge-1",
		"reactorpro/build.01.eu",
		"drolu/reactorpro",
	}
	seen := map[string]string{}
	for _, id := range ids {
		key := registryKey(id)
		assertUsableKVKey(t, key)

		// Deterministic.
		if again := registryKey(id); again != key {
			t.Fatalf("registryKey(%q) is not deterministic: %q vs %q", id, key, again)
		}
		// Reversible.
		decoded, ok := decodeRegistryKey(key)
		if !ok || decoded != id {
			t.Fatalf("decodeRegistryKey(%q) = %q, %v; want %q, true", key, decoded, ok, id)
		}
		// Collision-free across these ids.
		if other, dup := seen[key]; dup {
			t.Fatalf("ids %q and %q map to the same key %q", id, other, key)
		}
		seen[key] = id
	}

	// The two shapes the requirement calls out must not collide with each other.
	if registryKey("acme/lagos/edge-1") == registryKey("acme.lagos.edge-1") {
		t.Fatal("slash and dot ids must not share a key")
	}
}

func TestDecodeRegistryKeyRejectsForeignKeys(t *testing.T) {
	for _, key := range []string{
		"",
		"acme/lagos/edge-1", // raw id, not a registry key
		"other-prefix-YWNtZQ",
		registryKeyPrefix + "not!base64url!",
	} {
		if decoded, ok := decodeRegistryKey(key); ok {
			t.Fatalf("decodeRegistryKey(%q) = %q, true; want false", key, decoded)
		}
	}
}

func TestRegistryModeValidation(t *testing.T) {
	base := func(mode string) Config {
		cfg := DefaultConfig()
		cfg.Enabled = true
		cfg.URL = "nats://localhost:4222"
		cfg.RegistryMode = mode
		return cfg
	}

	for _, mode := range []string{"", RegistryAuto, RegistryJetStream, RegistryBroadcast, "JetStream", " AUTO "} {
		if err := base(mode).Validate(); err != nil {
			t.Fatalf("mode %q must validate: %v", mode, err)
		}
	}
	for _, mode := range []string{"javascript", "nats", "off", "broadcastt"} {
		if err := base(mode).Validate(); err == nil {
			t.Fatalf("unknown registry mode %q must be rejected rather than silently degraded", mode)
		}
	}

	// A disabled bridge validates regardless: nothing is going to connect.
	disabled := DefaultConfig()
	disabled.RegistryMode = "javascript"
	if err := disabled.Validate(); err != nil {
		t.Fatalf("a disabled bridge must remain valid: %v", err)
	}
}

func TestRegistryBucketValidation(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = "nats://localhost:4222"

	for _, bucket := range []string{"", DefaultRegistryBucket, "acme_registry", "registry-1"} {
		cfg.RegistryBucket = bucket
		if err := cfg.Validate(); err != nil {
			t.Fatalf("bucket %q must validate: %v", bucket, err)
		}
	}
	for _, bucket := range []string{"has space", "has.dot", "has/slash", "has*star"} {
		cfg.RegistryBucket = bucket
		if err := cfg.Validate(); err == nil {
			t.Fatalf("invalid bucket %q must be rejected", bucket)
		}
	}
}

func TestNormalizeRegistryDefaults(t *testing.T) {
	// A literal-built config gets the documented defaults.
	literal := Config{HeartbeatInterval: 10 * time.Second}
	literal.normalize()
	if literal.RegistryMode != RegistryAuto {
		t.Fatalf("registry mode = %q, want %q", literal.RegistryMode, RegistryAuto)
	}
	if literal.RegistryBucket != DefaultRegistryBucket {
		t.Fatalf("registry bucket = %q, want %q", literal.RegistryBucket, DefaultRegistryBucket)
	}
	if want := 30 * time.Second; literal.RegistryTTL != want {
		t.Fatalf("registry ttl = %s, want 3x heartbeat = %s", literal.RegistryTTL, want)
	}

	// An explicit TTL is preserved.
	explicit := Config{RegistryTTL: 5 * time.Minute}
	explicit.normalize()
	if explicit.RegistryTTL != 5*time.Minute {
		t.Fatalf("explicit registry ttl = %s, want 5m", explicit.RegistryTTL)
	}

	// The shipping default is three default heartbeats.
	if DefaultConfig().RegistryTTL != DefaultRegistryTTL {
		t.Fatalf("DefaultConfig registry ttl = %s, want %s", DefaultConfig().RegistryTTL, DefaultRegistryTTL)
	}
}

// TestRegistryManifestExpiry pins the TTL rule directly, including the fallback
// to the bucket write time when a manifest carries no parsable heartbeat.
func TestRegistryManifestExpiry(t *testing.T) {
	client := &registryClient{ttl: time.Minute}
	now := time.Now().UTC()

	fresh := Manifest{LastHeartbeat: now.Add(-10 * time.Second).Format(time.RFC3339Nano)}
	if client.expired(fresh, now, now) {
		t.Fatal("a fresh heartbeat must not be expired")
	}
	stale := Manifest{LastHeartbeat: now.Add(-2 * time.Minute).Format(time.RFC3339Nano)}
	if !client.expired(stale, now, now) {
		t.Fatal("a stale heartbeat must be expired")
	}
	// No parsable heartbeat: fall back to the entry's creation time.
	unparseable := Manifest{LastHeartbeat: "not-a-time"}
	if client.expired(unparseable, now, now) {
		t.Fatal("an unparseable heartbeat with a fresh write time must not be expired")
	}
	if !client.expired(unparseable, now.Add(-2*time.Minute), now) {
		t.Fatal("an unparseable heartbeat with an old write time must be expired")
	}
	// A zero TTL disables expiry.
	noTTL := &registryClient{ttl: 0}
	if noTTL.expired(stale, now, now) {
		t.Fatal("a zero TTL must not expire entries")
	}
}
