package mesh

import (
	"testing"
	"time"
)

// TestIntegrationRegistryAutoUnionsWithBroadcast guards the regression that made
// an upgraded edge blind to its own fleet.
//
// The first cut of `auto` returned the registry results and never broadcast. That
// is wrong for a mixed fleet, and wrong in the worst possible way: a peer that has
// not been upgraded publishes nothing to the bucket, but the registry read still
// *succeeds* — it answers with whatever is in the bucket, often only this edge's
// own entry. So the "registry read failed, fall back to broadcast" path never
// runs, and discovery returns an empty peer list on a mesh that is busy. It looks
// exactly like a healthy mesh with nobody on it, which is the failure mode the
// local-agent directory work went out of its way to make visible.
func TestIntegrationRegistryAutoUnionsWithBroadcast(t *testing.T) {
	url := startTestNATSJetStream(t)

	// The un-upgraded peer: broadcast only, so it never writes to the bucket.
	legacyID := uniqueID("legacy/edge")
	testManager(t, url, legacyID, func(cfg *Config) {
		cfg.RegistryMode = RegistryBroadcast
	})

	// The upgraded edge, on the default mode.
	upgradedID := uniqueID("upgraded/edge")
	upgraded := testManager(t, url, upgradedID, nil)

	// Precondition, so a pass cannot come from the pure-broadcast fallback: the
	// registry is reachable and holds only this edge's own entry, meaning the
	// legacy peer is unreachable through it and broadcast is the only way it can
	// be found.
	//
	// Polled, because the registry client is installed after Start returns and the
	// manifest is published from that path — the bucket is legitimately empty for
	// a moment. The legacy peer never publishes, so exactly one entry is the
	// settled state, and a second entry would mean this test is not testing what
	// it claims.
	var keys []string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		keys = registryKeysDirect(t, url, DefaultRegistryBucket)
		if len(keys) == 1 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(keys) != 1 {
		t.Fatalf("registry holds %d entries (%v), want only the upgraded edge's own; "+
			"the test is not exercising the mixed-fleet case", len(keys), keys)
	}

	manifests, err := upgraded.Discover(t.Context(), DiscoverFilter{})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if _, ok := manifestByID(manifests, legacyID); !ok {
		t.Fatalf("a broadcast-only peer was not discovered in auto mode (%d peers found); "+
			"an upgraded edge would go blind to every peer that has not upgraded with it",
			len(manifests))
	}
}
