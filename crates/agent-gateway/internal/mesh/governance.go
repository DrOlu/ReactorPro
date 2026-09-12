package mesh

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// GovernanceConfig tunes EXT-GOVERNANCE approvals.
type GovernanceConfig struct {
	Enabled bool `json:"enabled"`
	// RequireApprovalFor lists skill ids that must be approved before dispatch.
	RequireApprovalFor []string `json:"requireApprovalFor"`
	// ApprovalTimeout bounds how long a dispatch waits for a decision.
	ApprovalTimeout time.Duration `json:"-"`
}

// DefaultGovernanceConfig returns the shipping defaults: enabled, but with no
// skill gated, so dispatch is unaffected until an operator names one.
func DefaultGovernanceConfig() GovernanceConfig {
	return GovernanceConfig{
		Enabled:            true,
		RequireApprovalFor: nil,
		ApprovalTimeout:    5 * time.Minute,
	}
}

// ApprovalStatus is the state of an approval request.
type ApprovalStatus string

const (
	StatusPending  ApprovalStatus = "pending"
	StatusApproved ApprovalStatus = "approved"
	StatusDenied   ApprovalStatus = "denied"
	StatusExpired  ApprovalStatus = "expired"
)

// ErrApprovalDenied is returned when a gated dispatch is refused.
var ErrApprovalDenied = errors.New("mesh governance denied the request")

// ErrApprovalExpired is returned when no decision arrived in time.
var ErrApprovalExpired = errors.New("mesh governance approval timed out")

// Approval is one governance request.
type Approval struct {
	ID          string         `json:"id"`
	Requester   string         `json:"requester"`
	Target      string         `json:"target"`
	Skill       string         `json:"skill"`
	Input       any            `json:"input,omitempty"`
	Status      ApprovalStatus `json:"status"`
	DecidedBy   string         `json:"decidedBy,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	RequestedAt time.Time      `json:"requestedAt"`
	DecidedAt   *time.Time     `json:"decidedAt,omitempty"`
}

type pendingApproval struct {
	approval Approval
	done     chan struct{}
}

// Governor tracks approval requests and their decisions.
type Governor struct {
	config GovernanceConfig

	mu      sync.Mutex
	pending map[string]*pendingApproval
	history []Approval
}

// NewGovernor builds a governor.
func NewGovernor(config GovernanceConfig) *Governor {
	return &Governor{config: config, pending: map[string]*pendingApproval{}}
}

// RequiresApproval reports whether a skill is gated.
func (g *Governor) RequiresApproval(skill string) bool {
	if !g.config.Enabled {
		return false
	}
	for _, gated := range g.config.RequireApprovalFor {
		if gated == skill {
			return true
		}
	}
	return false
}

// Request opens an approval and returns its id.
func (g *Governor) Request(requester, target, skill string, input any) string {
	id := newID()
	entry := &pendingApproval{
		approval: Approval{
			ID:          id,
			Requester:   requester,
			Target:      target,
			Skill:       skill,
			Input:       input,
			Status:      StatusPending,
			RequestedAt: now(),
		},
		done: make(chan struct{}),
	}
	g.mu.Lock()
	g.pending[id] = entry
	g.mu.Unlock()
	return id
}

// Wait blocks until the approval is decided or the timeout elapses.
func (g *Governor) Wait(id string) (Approval, error) {
	g.mu.Lock()
	entry, ok := g.pending[id]
	g.mu.Unlock()
	if !ok {
		return Approval{}, fmt.Errorf("unknown approval %q", id)
	}
	timeout := g.config.ApprovalTimeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-entry.done:
		g.mu.Lock()
		approval := entry.approval
		g.mu.Unlock()
		if approval.Status == StatusApproved {
			return approval, nil
		}
		return approval, ErrApprovalDenied
	case <-timer.C:
		g.resolve(id, StatusExpired, "", "no decision before the timeout")
		return Approval{ID: id, Status: StatusExpired}, ErrApprovalExpired
	}
}

// Approve records an approval decision. Only a pending request can be decided.
func (g *Governor) Approve(id, approver, reason string) error {
	return g.resolve(id, StatusApproved, approver, reason)
}

// Deny records a rejection.
func (g *Governor) Deny(id, approver, reason string) error {
	return g.resolve(id, StatusDenied, approver, reason)
}

// Pending lists undecided approvals, oldest first.
func (g *Governor) Pending() []Approval {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]Approval, 0, len(g.pending))
	for _, entry := range g.pending {
		out = append(out, entry.approval)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RequestedAt.Before(out[j].RequestedAt) })
	return out
}

// History returns decided approvals, most recent first.
func (g *Governor) History() []Approval {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]Approval, len(g.history))
	copy(out, g.history)
	sort.Slice(out, func(i, j int) bool {
		if out[i].DecidedAt == nil || out[j].DecidedAt == nil {
			return out[i].RequestedAt.After(out[j].RequestedAt)
		}
		return out[i].DecidedAt.After(*out[j].DecidedAt)
	})
	return out
}

func (g *Governor) resolve(id string, status ApprovalStatus, decidedBy, reason string) error {
	g.mu.Lock()
	entry, ok := g.pending[id]
	if !ok {
		g.mu.Unlock()
		return fmt.Errorf("unknown approval %q", id)
	}
	if entry.approval.Status != StatusPending {
		g.mu.Unlock()
		return fmt.Errorf("approval %q was already %s", id, entry.approval.Status)
	}
	decidedAt := now()
	entry.approval.Status = status
	entry.approval.DecidedBy = decidedBy
	entry.approval.Reason = reason
	entry.approval.DecidedAt = &decidedAt
	decided := entry.approval
	close(entry.done)
	delete(g.pending, id)
	g.history = append(g.history, decided)
	g.mu.Unlock()
	return nil
}
