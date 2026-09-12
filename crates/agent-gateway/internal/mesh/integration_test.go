package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nuid"
)

// These tests run against a real nats-server so the wire behaviour is exercised
// end to end: connect, register, discover, dispatch, and the inbound policy
// applied to traffic arriving over the network rather than handed to the guard
// directly.
//
// The server is started per test on a free port, with no authentication, and is
// torn down with the test. Nothing here touches a shared or production mesh.
// When the nats-server binary is absent the tests skip rather than fail, so a
// checkout without it still builds and tests cleanly.

// startTestNATS launches a private nats-server and returns its URL.
func startTestNATS(t *testing.T) string {
	t.Helper()

	binary, err := exec.LookPath("nats-server")
	if err != nil {
		t.Skip("nats-server is not on PATH; skipping mesh integration test")
	}

	port := freePort(t)
	cmd := exec.Command(binary, "-a", "127.0.0.1", "-p", strconv.Itoa(port))
	if err := cmd.Start(); err != nil {
		t.Fatalf("start nats-server: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	url := fmt.Sprintf("nats://127.0.0.1:%d", port)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return url
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("nats-server did not become ready at %s", url)
	return ""
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port
}

// testAgent builds and starts an agent on its own identity, with cleanup.
func testAgent(t *testing.T, url, agentID string, mutate func(*Config)) *Agent {
	t.Helper()

	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.URL = url
	cfg.AgentID = agentID
	cfg.IdentityPath = t.TempDir() + "/identity.json"
	if mutate != nil {
		mutate(&cfg)
	}

	identity, _, err := LoadIdentity(cfg.IdentityPath, agentID)
	if err != nil {
		t.Fatalf("LoadIdentity: %v", err)
	}
	agent := NewAgent(cfg, identity, nil)
	if err := agent.Start(t.Context()); err != nil {
		t.Fatalf("start agent %s: %v", agentID, err)
	}
	t.Cleanup(func() { _ = agent.Stop(context.Background()) })
	return agent
}

func uniqueID(prefix string) string { return prefix + "/" + nuid.Next()[:8] }

func TestIntegrationDispatchRoundTrip(t *testing.T) {
	url := startTestNATS(t)

	peerID := uniqueID("test/peer")
	peer := testAgent(t, url, peerID, nil)
	peer.RegisterSkill("ping", func(_ context.Context, input any, _ RequestMeta) (any, error) {
		return map[string]any{"pong": true, "echo": input}, nil
	})

	caller := testAgent(t, url, uniqueID("test/caller"), nil)

	response, err := caller.Dispatch(t.Context(), peerID, "ping", map[string]any{"n": 1}, 5*time.Second)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if response.Error != nil {
		t.Fatalf("peer returned an error: %+v", response.Error)
	}

	var payload RespondPayload
	if err := json.Unmarshal(response.Payload, &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	output, ok := payload.Output.(map[string]any)
	if !ok || output["pong"] != true {
		t.Fatalf("unexpected output: %#v", payload.Output)
	}

	// The reply must carry correlation and be signed by the peer.
	if response.TaskID == "" {
		t.Error("reply should carry the task id")
	}
	if err := VerifyEnvelope(response); err != nil {
		t.Errorf("reply should be signed and verifiable: %v", err)
	}
}

func TestIntegrationUnknownSkillReturns3001(t *testing.T) {
	url := startTestNATS(t)
	peerID := uniqueID("test/peer")
	testAgent(t, url, peerID, nil)
	caller := testAgent(t, url, uniqueID("test/caller"), nil)

	response, err := caller.Dispatch(t.Context(), peerID, "does-not-exist", nil, 5*time.Second)
	if err == nil {
		t.Fatal("expected a SKILL_NOT_FOUND error")
	}
	if response == nil || response.Error == nil || response.Error.Code != CodeSkillNotFound {
		t.Fatalf("response = %+v, want code %d", response, CodeSkillNotFound)
	}
	if response.Error.Retryable {
		t.Error("SKILL_NOT_FOUND must not be marked retryable")
	}
}

// A tampered envelope arriving over the wire must be refused, and the refusal
// must name the identity problem rather than silently dropping.
func TestIntegrationTamperedEnvelopeIsRefused(t *testing.T) {
	url := startTestNATS(t)
	peerID := uniqueID("test/peer")
	testAgent(t, url, peerID, nil)

	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close()

	attacker, err := GenerateIdentity(uniqueID("test/attacker"))
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeRequest,
		TS:      timestamp(),
		From:    attacker.AgentID,
		To:      peerID,
		Payload: json.RawMessage(`{"skill":"ping"}`),
	}
	if err := attacker.Sign(envelope); err != nil {
		t.Fatalf("sign: %v", err)
	}
	// Swap the payload after signing: the signature no longer covers it.
	envelope.Payload = json.RawMessage(`{"skill":"deploy"}`)

	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	message, err := conn.Request(AgentInboxSubject(peerID), raw, 5*time.Second)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	reply, err := decodeEnvelope(message.Data)
	if err != nil {
		t.Fatalf("decode reply: %v", err)
	}
	if reply.Error == nil || reply.Error.Code != CodeIdentityMismatch {
		t.Fatalf("reply = %+v, want code %d", reply.Error, CodeIdentityMismatch)
	}
}

// The same envelope delivered twice must be refused the second time.
func TestIntegrationReplayIsRefused(t *testing.T) {
	url := startTestNATS(t)
	peerID := uniqueID("test/peer")
	peer := testAgent(t, url, peerID, nil)
	peer.RegisterSkill("ping", func(_ context.Context, _ any, _ RequestMeta) (any, error) {
		return "pong", nil
	})

	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close()

	sender, err := GenerateIdentity(uniqueID("test/sender"))
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeRequest,
		TS:      timestamp(),
		From:    sender.AgentID,
		To:      peerID,
		Payload: json.RawMessage(`{"skill":"ping"}`),
	}
	if err := sender.Sign(envelope); err != nil {
		t.Fatalf("sign: %v", err)
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	first, err := conn.Request(AgentInboxSubject(peerID), raw, 5*time.Second)
	if err != nil {
		t.Fatalf("first request: %v", err)
	}
	firstReply, err := decodeEnvelope(first.Data)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if firstReply.Error != nil {
		t.Fatalf("the first delivery should have succeeded: %+v", firstReply.Error)
	}

	second, err := conn.Request(AgentInboxSubject(peerID), raw, 5*time.Second)
	if err != nil {
		t.Fatalf("second request: %v", err)
	}
	secondReply, err := decodeEnvelope(second.Data)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if secondReply.Error == nil || secondReply.Error.Code != CodeInvalidEnvelope {
		t.Fatalf("replay reply = %+v, want code %d", secondReply.Error, CodeInvalidEnvelope)
	}
}

// Two peers on the same mesh must find each other through discovery.
func TestIntegrationDiscoveryFindsPeers(t *testing.T) {
	url := startTestNATS(t)
	firstID := uniqueID("test/first")
	secondID := uniqueID("test/second")
	testAgent(t, url, firstID, nil)
	testAgent(t, url, secondID, nil)
	watcher := testAgent(t, url, uniqueID("test/watcher"), nil)

	// Discovery replies are collected for a fixed window on both sides, so allow
	// more than the window before giving up.
	deadline := time.Now().Add(15 * time.Second)
	var found []string
	for time.Now().Before(deadline) {
		manifests, err := watcher.Discover(t.Context(), DiscoverFilter{})
		if err != nil {
			t.Fatalf("Discover: %v", err)
		}
		found = found[:0]
		for _, manifest := range manifests {
			found = append(found, manifest.ID)
		}
		if containsString(found, firstID) && containsString(found, secondID) {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if !containsString(found, firstID) || !containsString(found, secondID) {
		t.Fatalf("discovery saw %v, want both %s and %s", found, firstID, secondID)
	}
}

// The manifest must let a peer pin our identity before it ever hears from us.
// Discovery deliberately filters out the caller's own manifest, so this needs a
// second agent to do the looking.
func TestIntegrationManifestCarriesFingerprint(t *testing.T) {
	url := startTestNATS(t)
	agentID := uniqueID("test/fingerprinted")
	target := testAgent(t, url, agentID, nil)
	watcher := testAgent(t, url, uniqueID("test/watcher"), nil)

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		manifests, err := watcher.Discover(t.Context(), DiscoverFilter{})
		if err != nil {
			t.Fatalf("Discover: %v", err)
		}
		for _, manifest := range manifests {
			if manifest.ID == agentID {
				if manifest.Fingerprint == "" {
					t.Fatal("manifest carries no fingerprint, so a peer cannot pin this identity")
				}
				if manifest.Fingerprint != target.Fingerprint() {
					t.Fatalf("manifest fingerprint = %q, want %q", manifest.Fingerprint, target.Fingerprint())
				}
				return
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatal("watcher never saw the target in discovery")
}

// Start and Stop must be safe to call concurrently against a real connection.
// The connection assignment and teardown are what raced before the lifecycle
// mutex existed, and this is the only test that exercises a successful connect.
// Run with -race for it to be meaningful.
func TestIntegrationConcurrentStartStop(t *testing.T) {
	url := startTestNATS(t)

	for i := 0; i < 4; i++ {
		cfg := DefaultConfig()
		cfg.Enabled = true
		cfg.URL = url
		cfg.AgentID = uniqueID("test/churn")
		cfg.IdentityPath = t.TempDir() + "/identity.json"

		identity, _, err := LoadIdentity(cfg.IdentityPath, cfg.AgentID)
		if err != nil {
			t.Fatalf("LoadIdentity: %v", err)
		}
		agent := NewAgent(cfg, identity, nil)

		var wg sync.WaitGroup
		for worker := 0; worker < 4; worker++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_ = agent.Start(context.Background())
				_ = agent.Connected()
				_ = agent.Stop(context.Background())
			}()
		}
		wg.Wait()
	}
}

// A terminated connection must not panic a reply in flight: publishReply used to
// dereference the connection field directly.
func TestIntegrationReplyAfterStopDoesNotPanic(t *testing.T) {
	url := startTestNATS(t)
	peerID := uniqueID("test/peer")
	peer := testAgent(t, url, peerID, nil)

	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close()

	if err := peer.Stop(t.Context()); err != nil {
		t.Fatalf("stop: %v", err)
	}

	sender, err := GenerateIdentity(uniqueID("test/sender"))
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	envelope := &Envelope{
		Version: ProtocolVersion,
		ID:      newID(),
		Type:    TypeRequest,
		TS:      timestamp(),
		From:    sender.AgentID,
		To:      peerID,
		Payload: json.RawMessage(`{"skill":"ping"}`),
	}
	if err := sender.Sign(envelope); err != nil {
		t.Fatalf("sign: %v", err)
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// Nobody is listening now; a timeout is the expected outcome, and the point
	// is that nothing panics.
	if _, err := conn.Request(AgentInboxSubject(peerID), raw, 500*time.Millisecond); err == nil {
		t.Log("unexpected reply from a stopped agent")
	} else if !errors.Is(err, nats.ErrTimeout) {
		t.Logf("request error (acceptable): %v", err)
	}
}
