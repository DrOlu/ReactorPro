package mesh

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// This file implements the JetStream KV discovery registry: an alternative to
// the broadcast discovery window that is deterministic and does not degrade as
// edges are added.
//
// Each edge writes its own manifest to one key in a shared bucket and refreshes
// it on every heartbeat. Discovery lists the bucket instead of waiting a fixed
// window for replies, so a peer is either present in the registry or it is not —
// there is no race in which a slow peer is silently missed.
//
// The registry degrades gracefully. Discovery uses it when JetStream is
// available and falls back to the broadcast window when it is not, so a plain
// nats-server (no -js) deployment keeps working unchanged.
//
// # Registry entries are data, not identity
//
// A manifest read from the bucket is untrusted input and is treated as such: it
// is never fed to the inbound guard's trust store, never seeds a peer pin, and
// never bypasses verification. It only tells discovery *where* a peer claims to
// be. The identity boundary is unchanged: a peer is trusted only when a signed
// envelope from it survives inboundGuard, exactly as before. A registry entry
// carries a Fingerprint field, but it is a claim like the rest of the manifest
// and confers nothing.

// registryBucketRe mirrors nats.go's bucket-name rule
// (`^[a-zA-Z0-9_-]+$`) so an invalid bucket is rejected at startup rather than
// when the first write is attempted.
var registryBucketRe = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func validRegistryBucket(bucket string) bool { return registryBucketRe.MatchString(bucket) }

// registryKeyPrefix marks a key as ours. It is a plain token, not a subject
// segment, so it cannot be confused with the agent id.
const registryKeyPrefix = "agent-"

// registryKey maps an agent id to a KV key.
//
// The id is encoded rather than embedded raw. nats.go accepts `.`, `/` and `_`
// in a key, but a `.` is structurally significant: it splits the key into extra
// subject tokens, so a key can be addressed by several subjects and a wildcard
// watch is no longer guaranteed to line up with the id it was written under.
// Agent ids in this fleet legitimately contain `.` (a hostname such as
// `build.01.eu`) and `/` (`acme/lagos/edge-1`), so the id is stored as unpadded
// base64url: deterministic, reversible, collision-free, and free of both dots and
// subject wildcards. The manifest in the value carries the id too, so a reader
// never has to decode the key to know whose entry it is.
func registryKey(agentID string) string {
	return registryKeyPrefix + base64.RawURLEncoding.EncodeToString([]byte(agentID))
}

// decodeRegistryKey reverses registryKey. It reports false for a key that was
// not produced by registryKey, which is how a foreign or hand-written key is
// kept out of discovery.
func decodeRegistryKey(key string) (string, bool) {
	if !strings.HasPrefix(key, registryKeyPrefix) {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(key, registryKeyPrefix))
	if err != nil {
		return "", false
	}
	return string(raw), true
}

// registryProbeTimeout bounds the JetStream availability check. In auto mode the
// probe runs off the connect path; in jetstream mode it bounds how long startup
// waits before reporting that JetStream is required and absent.
const registryProbeTimeout = 5 * time.Second

// registryClient is a live handle on the discovery bucket. A nil client means
// the registry is unavailable and discovery must broadcast instead.
type registryClient struct {
	kv     nats.KeyValue
	bucket string
	ttl    time.Duration
	logger *slog.Logger

	// mu serialises publish against remove. remove deletes this edge's entry
	// on a clean shutdown, but a heartbeat tick that entered publish just
	// before Stop latched would re-create the entry AFTER the delete —
	// resurrecting a stopped edge in discovery until its TTL expires. Holding
	// the lock across both operations makes the delete the last word: a
	// publish already in flight lands first and is deleted; one that follows
	// sees closed and refuses.
	mu     sync.Mutex
	closed bool
}

func newRegistryClient(kv nats.KeyValue, bucket string, ttl time.Duration, logger *slog.Logger) *registryClient {
	if logger == nil {
		logger = slog.Default()
	}
	return &registryClient{kv: kv, bucket: bucket, ttl: ttl, logger: logger}
}

// publish writes a manifest under its agent id. The manifest is self-describing,
// so the only requirement is a non-empty id to key on.
func (r *registryClient) publish(manifest Manifest) error {
	if r == nil {
		return nil
	}
	if strings.TrimSpace(manifest.ID) == "" {
		return errors.New("manifest has no agent id to key on")
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return fmt.Errorf("marshal manifest: %w", err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		// A publish racing shutdown: the entry was already removed (or is
		// being removed under this lock). Skipping is the correct outcome,
		// not an error to log.
		return nil
	}
	if _, err := r.kv.Put(registryKey(manifest.ID), raw); err != nil {
		return fmt.Errorf("write registry entry for %q: %w", manifest.ID, err)
	}
	return nil
}

// remove deletes this edge's entry, used on a clean shutdown so a stopped edge
// disappears immediately rather than lingering until its TTL expires. It also
// closes the client: no later publish may re-create the entry (see the struct
// comment for the race this closes).
func (r *registryClient) remove(agentID string) error {
	if r == nil || strings.TrimSpace(agentID) == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	if err := r.kv.Delete(registryKey(agentID)); err != nil && !errors.Is(err, nats.ErrKeyNotFound) {
		return fmt.Errorf("delete registry entry for %q: %w", agentID, err)
	}
	return nil
}

// manifests lists live registry entries that match the filter.
//
// Every entry is validated the same way: it must carry an id, its key must decode
// to that same id, and it must not be older than the TTL. Expired entries are
// deleted as they are encountered, so a crashed edge's manifest does not outlive
// its usefulness. Entries that fail validation are skipped, not trusted.
func (r *registryClient) manifests(ctx context.Context, filter DiscoverFilter) ([]Manifest, error) {
	if r == nil {
		return nil, nil
	}
	keys, err := r.kv.Keys()
	if err != nil {
		if errors.Is(err, nats.ErrNoKeysFound) {
			// An empty bucket is a valid, deterministic answer: no peers.
			return nil, nil
		}
		return nil, fmt.Errorf("list registry keys: %w", err)
	}

	now := time.Now().UTC()
	out := make([]Manifest, 0, len(keys))
	for _, key := range keys {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		entry, err := r.kv.Get(key)
		if err != nil {
			if errors.Is(err, nats.ErrKeyNotFound) {
				// Deleted between Keys and Get; not an error.
				continue
			}
			r.logger.Warn("mesh registry read failed", "key", key, "error", err)
			continue
		}
		var manifest Manifest
		if err := json.Unmarshal(entry.Value(), &manifest); err != nil {
			r.logger.Warn("mesh registry entry is not a manifest", "key", key, "error", err)
			continue
		}
		if manifest.ID == "" {
			r.discard(key)
			continue
		}
		// The key must decode to the id the manifest claims. A mismatch means the
		// entry was not written by the publish path and is not a peer directory
		// record; ignore it rather than reporting a peer under a wrong key.
		if decoded, ok := decodeRegistryKey(key); !ok || decoded != manifest.ID {
			r.logger.Warn("mesh registry key does not match its manifest; ignoring",
				"key", key, "manifestId", manifest.ID)
			continue
		}
		if r.expired(manifest, entry.Created(), now) {
			r.discard(key)
			continue
		}
		// Reuse the broadcast path's filter so capability and skill subset
		// semantics cannot drift between the two discovery mechanisms.
		if !manifestMatches(manifest, filter) {
			continue
		}
		out = append(out, manifest)
	}
	return out, nil
}

// expired reports whether an entry is older than the TTL.
//
// The manifest's own LastHeartbeat is authoritative when it parses because it
// reflects the peer's liveness, not the bucket's write time; a foreign writer
// could refresh the KV revision of a stale manifest, and using Created() alone
// would then keep a dead peer visible. Created() is the fallback for a manifest
// that never carried a parsable heartbeat.
func (r *registryClient) expired(manifest Manifest, created, now time.Time) bool {
	if r == nil || r.ttl <= 0 {
		return false
	}
	reference := created
	if heartbeat, err := time.Parse(time.RFC3339Nano, manifest.LastHeartbeat); err == nil {
		reference = heartbeat
	}
	if reference.IsZero() {
		return false
	}
	return now.Sub(reference) > r.ttl
}

// discard removes an unusable entry, best-effort. The bucket TTL is the backstop
// if the delete fails.
func (r *registryClient) discard(key string) {
	if err := r.kv.Delete(key); err != nil && !errors.Is(err, nats.ErrKeyNotFound) {
		r.logger.Debug("mesh registry cleanup failed", "key", key, "error", err)
	}
}

// connectRegistry probes for JetStream and binds to (or creates) the bucket.
//
// The probe is a bounded account-info request. It is deliberately a separate
// step from the connection: a server without JetStream answers no-responders
// immediately, and a server that is merely slow cannot hold startup open beyond
// the probe timeout.
func (a *Agent) connectRegistry(ctx context.Context, timeout time.Duration) (*registryClient, error) {
	conn, err := a.connection()
	if err != nil {
		return nil, err
	}
	js, err := conn.JetStream()
	if err != nil {
		return nil, fmt.Errorf("create JetStream context: %w", err)
	}

	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// The probe context is scoped to this single request; the JetStream context
	// itself stays usable afterwards with the connection's default deadline.
	if _, err := js.AccountInfo(nats.Context(probeCtx)); err != nil {
		return nil, fmt.Errorf("JetStream is not available: %w", err)
	}

	kv, err := js.KeyValue(a.config.RegistryBucket)
	if errors.Is(err, nats.ErrBucketNotFound) {
		kv, err = js.CreateKeyValue(&nats.KeyValueConfig{
			Bucket:  a.config.RegistryBucket,
			TTL:     a.config.RegistryTTL,
			History: 1,
			Storage: nats.FileStorage,
		})
	}
	if err != nil {
		return nil, fmt.Errorf("open registry bucket %q: %w", a.config.RegistryBucket, err)
	}
	return newRegistryClient(kv, a.config.RegistryBucket, a.config.RegistryTTL, a.logger), nil
}
