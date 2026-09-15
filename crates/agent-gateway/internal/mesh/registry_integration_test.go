package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nuid"
)

// These tests run against a real nats-server with JetStream enabled so the KV
// registry is exercised over the wire, not against a stub. The plain-server
// fallback tests use the helper in integration_test.go, which starts
// nats-server WITHOUT -js.

// startTestNATSJetStream launches a private nats-server with JetStream enabled
// and a store under the test's temp dir, returning its URL.
func startTestNATSJetStream(t *testing.T) string {
	t.Helper()

	binary, err := exec.LookPath("nats-server")
	if err != nil {
		t.Skip("nats-server is not on PATH; skipping mesh registry integration test")
	}

	port := freePort(t)
	cmd := exec.Command(binary, "-a", "127.0.0.1", "-p", strconv.Itoa(port), "-js", "-sd", t.TempDir())
	if err := cmd.Start(); err != nil {
		t.Fatalf("start nats-server with JetStream: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	url := fmt.Sprintf("nats://127.0.0.1:%d", port)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if jetStreamReady(url) {
			return url
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("nats-server JetStream did not become ready at %s", url)
	return ""
}

// jetStreamReady reports whether the server at url answers a JetStream
// account-info request, which is the same probe the bridge uses.
func jetStreamReady(url string) bool {
	conn, err := nats.Connect(url, nats.Timeout(300*time.Millisecond))
	if err != nil {
		return false
	}
	defer conn.Close()
	js, err := conn.JetStream()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, err = js.AccountInfo(nats.Context(ctx))
	return err == nil
}

// createRegistryBucketDirect pre-creates a bucket with a chosen TTL, so a test
// can make the bucket outlive the entries and exercise the bridge's own expiry
// filter rather than JetStream's stream TTL.
func createRegistryBucketDirect(t *testing.T, url, bucket string, ttl time.Duration) {
	t.Helper()
	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect to %s: %v", url, err)
	}
	defer conn.Close()
	js, err := conn.JetStream()
	if err != nil {
		t.Fatalf("create JetStream context: %v", err)
	}
	if _, err := js.CreateKeyValue(&nats.KeyValueConfig{
		Bucket:  bucket,
		TTL:     ttl,
		History: 1,
		Storage: nats.FileStorage,
	}); err != nil {
		t.Fatalf("create bucket %q: %v", bucket, err)
	}
}

func registryKeysDirect(t *testing.T, url, bucket string) []string {
	t.Helper()
	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect to %s: %v", url, err)
	}
	defer conn.Close()
	js, err := conn.JetStream()
	if err != nil {
		t.Fatalf("create JetStream context: %v", err)
	}
	kv, err := js.KeyValue(bucket)
	if errors.Is(err, nats.ErrBucketNotFound) {
		return nil
	}
	if err != nil {
		t.Fatalf("open bucket %q: %v", bucket, err)
	}
	keys, err := kv.Keys()
	if errors.Is(err, nats.ErrNoKeysFound) {
		return nil
	}
	if err != nil {
		t.Fatalf("list bucket %q: %v", bucket, err)
	}
	return keys
}

func manifestByID(manifests []Manifest, id string) (Manifest, bool) {
	for _, manifest := range manifests {
		if manifest.ID == id {
			return manifest, true
		}
	}
	return Manifest{}, false
}

func jetStreamMode(c *Config) { c.RegistryMode = RegistryJetStream }

// TestIntegrationRegistryPublishesAndDiscovers is the core case: one edge
// publishes its manifest into the bucket and another reads it back. The ids
// deliberately contain a dot and a slash, the two shapes that stress KV key
// handling.
func TestIntegrationRegistryPublishesAndDiscovers(t *testing.T) {
	url := startTestNATSJetStream(t)

	// A dot in the id would split an unencoded key into extra subject tokens.
	dottedID := "acme.lagos.edge-" + nuid.Next()
	// A slash is legal in a KV key but must still round-trip safely.
	slashedID := "acme/lagos/edge-" + nuid.Next()

	a := testAgent(t, url, dottedID, jetStreamMode)
	b := testAgent(t, url, slashedID, jetStreamMode)

	if b.registryClient() == nil {
		t.Fatal("jetstream mode must install a registry client")
	}

	peers, err := b.Discover(t.Context(), DiscoverFilter{})
	if err != nil {
		t.Fatalf("discover via registry: %v", err)
	}
	found, ok := manifestByID(peers, a.AgentID())
	if !ok {
		t.Fatalf("registry discovery did not find %q in %+v", a.AgentID(), peers)
	}
	if found.Endpoint != AgentInboxSubject(a.AgentID()) {
		t.Fatalf("discovered endpoint = %q, want %q", found.Endpoint, AgentInboxSubject(a.AgentID()))
	}
	if _, ok := manifestByID(peers, b.AgentID()); ok {
		t.Fatal("discovery must not report the caller itself")
	}
}

// TestIntegrationRegistryEntryDoesNotSeedTrust pins the trust boundary: a
// manifest read from the bucket tells discovery where a peer claims to be, never
// that it is who it claims to be. Reading one must not install a peer pin.
func TestIntegrationRegistryEntryDoesNotSeedTrust(t *testing.T) {
	url := startTestNATSJetStream(t)

	a := testAgent(t, url, "acme/lagos/peer-"+nuid.Next(), jetStreamMode)
	b := testAgent(t, url, "acme/lagos/observer-"+nuid.Next(), jetStreamMode)

	peers, err := b.Discover(t.Context(), DiscoverFilter{})
	if err != nil {
		t.Fatalf("discover via registry: %v", err)
	}
	found, ok := manifestByID(peers, a.AgentID())
	if !ok {
		t.Fatalf("registry discovery did not find %q", a.AgentID())
	}
	// The manifest does carry a fingerprint (the peer has an identity), which is
	// exactly the data that must remain a claim rather than a trust decision.
	if found.Fingerprint == "" {
		t.Fatal("test peer should advertise a fingerprint for this boundary to be meaningful")
	}
	for _, pin := range b.TrustPeers() {
		if pin.AgentID == a.AgentID() {
			t.Fatalf("a registry entry seeded the trust store for %q; registry data is not identity", a.AgentID())
		}
	}
}

// TestIntegrationRegistryFilterMatching proves the registry path reuses the
// broadcast filter semantics: capability subset and skill-id matching.
func TestIntegrationRegistryFilterMatching(t *testing.T) {
	url := startTestNATSJetStream(t)

	// Manager registers the built-in skills, so the skill filter has something
	// real to match against.
	aID := "acme/lagos/gpu-" + nuid.Next()
	bID := "acme/lagos/observer-" + nuid.Next()
	_ = testManager(t, url, aID, func(c *Config) {
		c.RegistryMode = RegistryJetStream
		c.Capabilities = []string{"agent", "gpu"}
	})
	b := testManager(t, url, bID, jetStreamMode)

	match, err := b.Discover(t.Context(), DiscoverFilter{Capabilities: []string{"gpu"}})
	if err != nil {
		t.Fatalf("discover matching: %v", err)
	}
	if _, ok := manifestByID(match, aID); !ok {
		t.Fatalf("capability filter should match %q: %+v", aID, match)
	}

	// Skill filter: the manager serves built-in skills.
	bySkill, err := b.Discover(t.Context(), DiscoverFilter{SkillIDs: []string{"ping"}})
	if err != nil {
		t.Fatalf("discover by skill: %v", err)
	}
	if _, ok := manifestByID(bySkill, aID); !ok {
		t.Fatalf("skill filter should match %q: %+v", aID, bySkill)
	}

	// Capability subset: an absent capability must exclude the peer entirely.
	none, err := b.Discover(t.Context(), DiscoverFilter{Capabilities: []string{"quantum"}})
	if err != nil {
		t.Fatalf("discover non-matching: %v", err)
	}
	if _, ok := manifestByID(none, aID); ok {
		t.Fatalf("capability filter should not match %q: %+v", aID, none)
	}
	if len(none) != 0 {
		t.Fatalf("expected no peers for an unsatisfied filter, got %+v", none)
	}

	// Availability mismatch excludes too.
	offline, err := b.Discover(t.Context(), DiscoverFilter{Availability: "offline"})
	if err != nil {
		t.Fatalf("discover by availability: %v", err)
	}
	if _, ok := manifestByID(offline, aID); ok {
		t.Fatal("availability filter should not match an online peer")
	}
}

// TestIntegrationRegistrySkipsExpiredEntries covers the TTL rule end to end.
// The bucket is pre-created with a long TTL so JetStream does not delete the
// entry for us: the entry must disappear because the bridge treats it as
// absent and cleans it up, which is what a crashed edge relies on.
func TestIntegrationRegistrySkipsExpiredEntries(t *testing.T) {
	url := startTestNATSJetStream(t)
	bucket := "expiry_registry_" + nuid.Next()
	createRegistryBucketDirect(t, url, bucket, time.Hour)

	const entryTTL = 300 * time.Millisecond
	config := func(c *Config) {
		c.RegistryMode = RegistryJetStream
		c.RegistryBucket = bucket
		c.RegistryTTL = entryTTL
		// Long heartbeat so the entry is not refreshed during the test.
		c.HeartbeatInterval = time.Hour
	}
	a := testAgent(t, url, "acme/lagos/stale-"+nuid.Next(), config)
	b := testAgent(t, url, "acme/lagos/observer-"+nuid.Next(), config)

	// While fresh, the edge is visible through the registry.
	fresh, err := b.Discover(t.Context(), DiscoverFilter{})
	if err != nil {
		t.Fatalf("discover while fresh: %v", err)
	}
	if _, ok := manifestByID(fresh, a.AgentID()); !ok {
		t.Fatalf("a fresh entry must be discoverable: %+v", fresh)
	}

	time.Sleep(3 * entryTTL)

	stale, err := b.Discover(t.Context(), DiscoverFilter{})
	if err != nil {
		t.Fatalf("discover after expiry: %v", err)
	}
	if _, ok := manifestByID(stale, a.AgentID()); ok {
		t.Fatalf("an expired entry must be skipped: %+v", stale)
	}
	// And it must have been cleaned up, not merely hidden from this call.
	for _, key := range registryKeysDirect(t, url, bucket) {
		if key == registryKey(a.AgentID()) {
			t.Fatal("expired entry should have been deleted from the bucket")
		}
	}
}

// TestIntegrationRegistryAutoFallsBackToBroadcast is the critical constraint:
// a plain nats-server without JetStream must keep working via broadcast.
func TestIntegrationRegistryAutoFallsBackToBroadcast(t *testing.T) {
	url := startTestNATS(t) // no -js

	a := testAgent(t, url, "acme/lagos/edge-"+nuid.Next(), nil)
	b := testAgent(t, url, "acme/lagos/edge-"+nuid.Next(), nil)

	// The auto probe must fail and stay failed; wait for it to settle so this
	// asserts the steady state rather than racing the goroutine.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && b.registryClient() != nil {
		time.Sleep(20 * time.Millisecond)
	}
	if b.registryClient() != nil {
		t.Fatal("a plain nats-server must not yield a registry client")
	}

	peers, err := b.Discover(t.Context(), DiscoverFilter{})
	if err != nil {
		t.Fatalf("broadcast fallback discover: %v", err)
	}
	if _, ok := manifestByID(peers, a.AgentID()); !ok {
		t.Fatalf("broadcast fallback must still find %q: %+v", a.AgentID(), peers)
	}
}

// TestIntegrationRegistryJetStreamModeFailsWithoutJetStream proves the strict
// mode refuses to start rather than silently degrading.
func TestIntegrationRegistryJetStreamModeFailsWithoutJetStream(t *testing.T) {
	url := startTestNATS(t) // no -js

	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = url
	cfg.AgentID = "acme/lagos/edge-" + nuid.Next()
	cfg.IdentityPath = t.TempDir() + "/identity.json"
	cfg.RegistryMode = RegistryJetStream

	identity, _, err := LoadIdentity(cfg.IdentityPath, cfg.AgentID)
	if err != nil {
		t.Fatalf("LoadIdentity: %v", err)
	}
	agent := NewAgent(cfg, identity, nil)
	err = agent.Start(t.Context())
	if err == nil {
		_ = agent.Stop(context.Background())
		t.Fatal("jetstream mode must fail to start when JetStream is absent")
	}
	if !strings.Contains(err.Error(), "JetStream") {
		t.Fatalf("startup error should name JetStream, got: %v", err)
	}
}

// TestIntegrationRegistryBroadcastModeNeverUsesJetStream pins that the explicit
// broadcast mode ignores an available JetStream server.
func TestIntegrationRegistryBroadcastModeNeverUsesJetStream(t *testing.T) {
	url := startTestNATSJetStream(t)

	broadcast := func(c *Config) { c.RegistryMode = RegistryBroadcast }
	a := testAgent(t, url, "acme/lagos/edge-"+nuid.Next(), broadcast)
	b := testAgent(t, url, "acme/lagos/edge-"+nuid.Next(), broadcast)

	if b.registryClient() != nil {
		t.Fatal("broadcast mode must not install a registry client")
	}
	peers, err := b.Discover(t.Context(), DiscoverFilter{})
	if err != nil {
		t.Fatalf("broadcast discover: %v", err)
	}
	if _, ok := manifestByID(peers, a.AgentID()); !ok {
		t.Fatalf("broadcast discovery must find %q: %+v", a.AgentID(), peers)
	}
}

// TestIntegrationHeartbeatRefreshesRegistrationWithTheLiveDirectory pins the
// bug found live on a production edge: registration ran once at Start with an
// empty agent directory (agents connect after Start), the KV entry expired
// with its TTL, and peers never saw the edge's agents. The heartbeat must now
// re-put a manifest built from the directory as it stands.
func TestIntegrationHeartbeatRefreshesRegistrationWithTheLiveDirectory(t *testing.T) {
	url := startTestNATSJetStream(t)

	// A directory that starts empty and gains an agent after Start — the
	// shape every real gateway boots in. The provider runs on the heartbeat
	// goroutine, so it must be safe to call concurrently — the real
	// gateway's provider reads the session registry under its own mutex,
	// and the test models that contract.
	var dirMu sync.Mutex
	directory := []LocalAgent{}
	jetStreamAndFastHeartbeat := func(c *Config) {
		c.RegistryMode = RegistryJetStream
		c.HeartbeatInterval = 40 * time.Millisecond
		c.RegistryTTL = 800 * time.Millisecond
	}
	agent := testAgent(t, url, uniqueID("acme/lagos/edge"), jetStreamAndFastHeartbeat)
	agent.SetLocalAgentsProvider(func() []LocalAgent {
		dirMu.Lock()
		defer dirMu.Unlock()
		return directory
	})

	// The entry must exist in the bucket at all — before the fix it expired
	// after the TTL and was never re-put.
	kv := registryBucketFor(t, url, agent)
	key := registryKey(agent.AgentID())
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if entry, err := kv.Get(key); err == nil && len(entry.Value()) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	entry, err := kv.Get(key)
	if err != nil || len(entry.Value()) == 0 {
		t.Fatalf("the heartbeat never re-put the registry entry: %v", err)
	}

	// The directory gains an agent; within a heartbeat the published manifest
	// must carry it, both in the stored snapshot and in the bucket.
	dirMu.Lock()
	directory = []LocalAgent{{ID: "agent-7", Name: "Warehouse", Online: true, Capabilities: []string{"task"}}}
	dirMu.Unlock()
	found := false
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if agent.Manifest().LocalAgentTotal > 0 {
			found = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !found {
		t.Fatalf("the stored manifest never picked up the attached agent: %+v", agent.Manifest().LocalAgents)
	}

	entry, err = kv.Get(key)
	if err != nil {
		t.Fatalf("read the refreshed registry entry: %v", err)
	}
	var published Manifest
	if err := json.Unmarshal(entry.Value(), &published); err != nil {
		t.Fatalf("the registry entry is not a manifest: %v", err)
	}
	if published.LocalAgentTotal != 1 || len(published.LocalAgents) != 1 ||
		published.LocalAgents[0].ID != "agent-7" {
		t.Fatalf("the bucket's manifest does not carry the live directory: %+v", published.LocalAgents)
	}

	// The describe skill serves the stored snapshot, so it must carry the
	// directory too — this is what peers actually ask.
	if agent.Manifest().LocalAgents[0].Name != "Warehouse" {
		t.Fatalf("describe would not show the agent's friendly name: %+v", agent.Manifest().LocalAgents)
	}
}

// registryBucketFor opens the KV bucket the agent publishes into.
func registryBucketFor(t *testing.T, url string, agent *Agent) nats.KeyValue {
	t.Helper()
	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	js, err := conn.JetStream()
	if err != nil {
		t.Fatalf("jetstream: %v", err)
	}
	kv, err := js.KeyValue(DefaultConfig().RegistryBucket)
	if err != nil {
		t.Fatalf("registry bucket %q: %v", DefaultConfig().RegistryBucket, err)
	}
	return kv
}
