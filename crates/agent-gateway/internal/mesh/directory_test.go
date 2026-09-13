package mesh

import (
	"fmt"
	"strings"
	"testing"
)

func TestSanitizeSubjectToken(t *testing.T) {
	cases := map[string]string{
		"gateway-01":              "gateway-01",
		"Gateway-01":              "gateway-01",
		"build.01.eu":             "build-01-eu", // dots would split the subject token
		"host*":                   "host",        // a wildcard would change routing
		"host>":                   "host",        // ditto for the tail wildcard
		"host with spaces":        "host-with-spaces",
		"  padded  ":              "padded",
		"--leading-and-trailing-": "leading-and-trailing",
		"":                        "",
		"...":                     "",
		"café":                    "caf", // non-ASCII folded away, not passed through
	}
	for input, want := range cases {
		if got := sanitizeSubjectToken(input); got != want {
			t.Errorf("sanitizeSubjectToken(%q) = %q, want %q", input, got, want)
		}
	}
}

// Every derived id must be usable as a single NATS subject token: dots and
// wildcards in an agent id silently change which inbox a request reaches.
func TestSanitizedTokensAreSubjectSafe(t *testing.T) {
	for _, host := range []string{"build.01.eu", "host*", "a b c", "MY-HOST-01", "..", "x>y"} {
		got := sanitizeSubjectToken(host)
		if strings.ContainsAny(got, ".*> ") {
			t.Errorf("sanitizeSubjectToken(%q) = %q, which is not safe inside a subject", host, got)
		}
	}
}

func TestDefaultAgentIDIsUniquePerHostAndSubjectSafe(t *testing.T) {
	id := DefaultAgentID()
	if id == "" {
		t.Fatal("a default agent id must not be empty")
	}
	if !strings.HasPrefix(id, defaultAgentIDPrefix) {
		t.Errorf("default agent id %q should be namespaced with %q", id, defaultAgentIDPrefix)
	}
	if UsesLegacyAgentID(id) {
		t.Fatal("the derived default must never be the shared legacy id")
	}
	// Deterministic per host: the identity file binds the id on first start, so a
	// value that changed between runs would refuse to load.
	if again := DefaultAgentID(); again != id {
		t.Errorf("DefaultAgentID is not deterministic: %q then %q", id, again)
	}
	token := strings.TrimPrefix(id, defaultAgentIDPrefix)
	if token == "" {
		t.Fatal("the default id has no host-derived token")
	}
	if strings.ContainsAny(token, ".*>") {
		t.Fatalf("default id %q contains subject-structural characters", id)
	}
}

func TestUsesLegacyAgentID(t *testing.T) {
	if !UsesLegacyAgentID(LegacyDefaultAgentID) {
		t.Fatal("the legacy constant must be recognised")
	}
	if !UsesLegacyAgentID("  " + LegacyDefaultAgentID + "  ") {
		t.Fatal("surrounding whitespace must not defeat the check")
	}
	if UsesLegacyAgentID("acme/lagos/edge-1") {
		t.Fatal("a federated id must not be mistaken for the legacy default")
	}
	if UsesLegacyAgentID("") {
		t.Fatal("an empty id is not the legacy default")
	}
}

func TestDirectorySnapshotSortsOnlineFirstThenByID(t *testing.T) {
	provider := func() []LocalAgent {
		return []LocalAgent{
			{ID: "zeta", Online: true},
			{ID: "alpha", Online: false},
			{ID: "beta", Online: true},
		}
	}
	agents, total := directorySnapshot(provider)
	if total != 3 {
		t.Fatalf("total = %d, want 3", total)
	}
	want := []string{"beta", "zeta", "alpha"}
	for i, id := range want {
		if agents[i].ID != id {
			t.Fatalf("order = %v, want %v (online first, then by id)", idsOf(agents), want)
		}
	}
}

func idsOf(agents []LocalAgent) []string {
	out := make([]string, len(agents))
	for i, agent := range agents {
		out[i] = agent.ID
	}
	return out
}

func TestDirectorySnapshotIsStable(t *testing.T) {
	provider := func() []LocalAgent {
		return []LocalAgent{{ID: "b"}, {ID: "a"}, {ID: "c"}}
	}
	first, _ := directorySnapshot(provider)
	second, _ := directorySnapshot(provider)
	if strings.Join(idsOf(first), ",") != strings.Join(idsOf(second), ",") {
		t.Fatal("the directory must be stably ordered: a manifest that reshuffles churns peer caches")
	}
}

func TestDirectorySnapshotTruncatesButReportsTotal(t *testing.T) {
	provider := func() []LocalAgent {
		agents := make([]LocalAgent, 0, maxAdvertisedLocalAgents+50)
		for i := 0; i < maxAdvertisedLocalAgents+50; i++ {
			agents = append(agents, LocalAgent{ID: fmt.Sprintf("agent-%04d", i), Online: true})
		}
		return agents
	}
	agents, total := directorySnapshot(provider)
	if len(agents) != maxAdvertisedLocalAgents {
		t.Fatalf("advertised %d agents, want the cap of %d", len(agents), maxAdvertisedLocalAgents)
	}
	if total != maxAdvertisedLocalAgents+50 {
		t.Fatalf("total = %d, want %d so truncation is visible rather than mistaken for the whole directory",
			total, maxAdvertisedLocalAgents+50)
	}
}

func TestDirectorySnapshotHandlesEmptyAndNil(t *testing.T) {
	if agents, total := directorySnapshot(nil); agents != nil || total != 0 {
		t.Fatalf("a nil provider must yield nothing, got %v/%d", agents, total)
	}
	if agents, total := directorySnapshot(func() []LocalAgent { return nil }); agents != nil || total != 0 {
		t.Fatalf("an empty provider must yield nothing, got %v/%d", agents, total)
	}

	// Entries with no id cannot be addressed, so they must not be advertised.
	agents, total := directorySnapshot(func() []LocalAgent {
		return []LocalAgent{{ID: "ok"}, {ID: "   "}, {ID: ""}}
	})
	if len(agents) != 1 || agents[0].ID != "ok" {
		t.Fatalf("agents = %v, want only the addressable one", idsOf(agents))
	}
	if total != 1 {
		t.Fatalf("total = %d, want 1: an unaddressable entry is not part of the directory", total)
	}
}

func TestLocalAgentByIDMatchesIDThenName(t *testing.T) {
	agents := []LocalAgent{
		{ID: "agent-1111", Name: "Reception"},
		{ID: "agent-2222", Name: "Build Runner"},
	}

	if agent, ok := LocalAgentByID(agents, "agent-1111"); !ok || agent.Name != "Reception" {
		t.Fatal("an exact id must match")
	}
	// Operators addressing another organisation's edge use the name they were
	// given, not a generated id.
	if agent, ok := LocalAgentByID(agents, "reception"); !ok || agent.ID != "agent-1111" {
		t.Fatal("a name must match case-insensitively")
	}
	if agent, ok := LocalAgentByID(agents, "BUILD RUNNER"); !ok || agent.ID != "agent-2222" {
		t.Fatal("name matching must be case-insensitive")
	}
	if _, ok := LocalAgentByID(agents, "missing"); ok {
		t.Fatal("an unknown key must not match")
	}
	if _, ok := LocalAgentByID(agents, "   "); ok {
		t.Fatal("a blank key must not match")
	}
	if _, ok := LocalAgentByID(nil, "agent-1111"); ok {
		t.Fatal("an empty directory must not match")
	}
}
