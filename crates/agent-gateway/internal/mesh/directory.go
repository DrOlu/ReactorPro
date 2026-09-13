package mesh

import (
	"sort"
	"strings"
)

// maxAdvertisedLocalAgents bounds how many attached agents an edge publishes in
// its manifest.
//
// The manifest travels inside every discovery reply and registration, so an
// unbounded list would inflate traffic and could push an envelope past a peer's
// size limit — turning a busy edge into one that is silently unreachable. The
// true total is always reported separately so truncation is visible rather than
// mistaken for the whole directory.
const maxAdvertisedLocalAgents = 128

// LocalAgent is a desktop agent attached to this edge, as advertised to the mesh.
//
// The mesh routes to an *edge*, not to a desktop machine. A laptop that comes and
// goes should not own a mesh identity, and a peer in another organisation should
// not have to pin trust to one. Advertising the local directory instead lets a
// peer see what sits behind an edge and address it through that edge, which is
// what makes gateway-level addressing workable across organisations.
type LocalAgent struct {
	ID      string `json:"id"`
	Name    string `json:"name,omitempty"`
	Online  bool   `json:"online"`
	Version string `json:"version,omitempty"`
	// ConnectedSince is a Unix timestamp in seconds; zero when unknown.
	ConnectedSince int64 `json:"connected_since,omitempty"`
}

// LocalAgentProvider reports the desktop agents currently attached to this edge.
//
// Injected rather than imported so the mesh package stays independent of the
// session manager and the desktop protocol: the bridge needs a directory, not an
// opinion about how desktop agents connect.
type LocalAgentProvider func() []LocalAgent

// directorySnapshot returns the advertised directory and the true total.
//
// Sorted by id so the manifest is stable: a manifest that reshuffles on every
// build would churn through peer caches and make diffs useless. Online agents
// sort first, because a peer looking for capacity cares about those.
func directorySnapshot(provider LocalAgentProvider) ([]LocalAgent, int) {
	if provider == nil {
		return nil, 0
	}
	agents := provider()
	if len(agents) == 0 {
		return nil, 0
	}

	sorted := make([]LocalAgent, 0, len(agents))
	for _, agent := range agents {
		if strings.TrimSpace(agent.ID) == "" {
			continue
		}
		sorted = append(sorted, agent)
	}
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Online != sorted[j].Online {
			return sorted[i].Online
		}
		return sorted[i].ID < sorted[j].ID
	})

	total := len(sorted)
	if total > maxAdvertisedLocalAgents {
		return sorted[:maxAdvertisedLocalAgents], total
	}
	return sorted, total
}

// LocalAgentByID looks an attached agent up by id, falling back to its name.
//
// Name is accepted as a second key because an operator addressing an agent from
// another organisation will reach for the name they configured, not the
// generated id — and requiring the id would make the directory useless in
// practice.
func LocalAgentByID(agents []LocalAgent, key string) (LocalAgent, bool) {
	key = strings.TrimSpace(key)
	if key == "" {
		return LocalAgent{}, false
	}
	for _, agent := range agents {
		if agent.ID == key {
			return agent, true
		}
	}
	for _, agent := range agents {
		if agent.Name != "" && strings.EqualFold(agent.Name, key) {
			return agent, true
		}
	}
	return LocalAgent{}, false
}
