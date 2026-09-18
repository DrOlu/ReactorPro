package mesh

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestRtermBridgeReverseDiscover proves the REVERSE direction of the
// federation contract: the gateway's own Discover must see RTerm
// (reactorpro/rterm-01) advertising on the shared NATS mesh, after RTerm's
// manifest shape fix (id instead of identity, skills as objects, bare
// manifest payloads).
//
// It is a no-op without the RTerm daemon running on the local mesh:
//
//	RTERM_BRIDGE_LIVE=1 go test ./internal/mesh -run TestRtermBridgeReverseDiscover -v
func TestRtermBridgeReverseDiscover(t *testing.T) {
	if os.Getenv("RTERM_BRIDGE_LIVE") == "" {
		t.Skip("RTERM_BRIDGE_LIVE not set; live reverse-discover is a no-op")
	}

	identity, err := GenerateIdentity("reactorpro/xcheck/gateway-side")
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	cfg := DefaultConfig()
	cfg.URL = "nats://localhost:4222"
	cfg.User = "admin"
	cfg.Password = "neural-admin-2026"
	agent := NewAgent(cfg, identity, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := agent.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = agent.Stop(ctx) }()

	dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dcancel()
	peers, err := agent.Discover(dctx, DiscoverFilter{})
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	found := false
	for _, p := range peers {
		t.Logf("peer: id=%s name=%s fp=%s", p.ID, p.Name, p.Fingerprint)
		if p.ID == "reactorpro/rterm-01" {
			found = true
		}
	}
	if !found {
		t.Fatalf("gateway discovery did NOT see reactorpro/rterm-01 (%d peers)", len(peers))
	}
}
