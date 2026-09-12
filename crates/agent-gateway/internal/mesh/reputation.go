package mesh

import (
	"math"
	"sort"
	"sync"
	"time"
)

// ReputationConfig tunes EXT-REPUTATION scoring.
type ReputationConfig struct {
	Enabled bool `json:"enabled"`
	// InitialScore is the score a newly seen agent starts from.
	InitialScore float64 `json:"initialScore"`
	// SuccessReward and FailurePenalty are applied to the running score.
	SuccessReward  float64 `json:"successReward"`
	FailurePenalty float64 `json:"failurePenalty"`
	// DecayHalfLife pulls stale scores back toward the initial score. Zero
	// disables decay.
	DecayHalfLife time.Duration `json:"-"`
	// MinScore and MaxScore clamp the score.
	MinScore float64 `json:"minScore"`
	MaxScore float64 `json:"maxScore"`
}

// DefaultReputationConfig returns the shipping defaults.
func DefaultReputationConfig() ReputationConfig {
	return ReputationConfig{
		Enabled:        true,
		InitialScore:   0.5,
		SuccessReward:  0.05,
		FailurePenalty: 0.10,
		DecayHalfLife:  24 * time.Hour,
		MinScore:       0,
		MaxScore:       1,
	}
}

// Reputation is the score record for one agent.
type Reputation struct {
	AgentID   string    `json:"agentId"`
	Score     float64   `json:"score"`
	Successes int       `json:"successes"`
	Failures  int       `json:"failures"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ReputationStore tracks per-agent reliability.
//
// Scores are kept in memory: reputation is advisory and rebuilt from observed
// traffic, so it does not warrant durable storage.
type ReputationStore struct {
	config  ReputationConfig
	mu      sync.Mutex
	records map[string]*Reputation
}

// NewReputationStore builds a store.
func NewReputationStore(config ReputationConfig) *ReputationStore {
	if config.MaxScore == 0 && config.MinScore == 0 {
		config = DefaultReputationConfig()
	}
	return &ReputationStore{config: config, records: map[string]*Reputation{}}
}

// RecordSuccess rewards an agent for a completed task.
func (s *ReputationStore) RecordSuccess(agentID string) { s.record(agentID, true) }

// RecordFailure penalises an agent for a failed task.
func (s *ReputationStore) RecordFailure(agentID string) { s.record(agentID, false) }

func (s *ReputationStore) record(agentID string, success bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.ensure(agentID)
	s.decayLocked(record)
	if success {
		record.Successes++
		record.Score += s.config.SuccessReward
	} else {
		record.Failures++
		record.Score -= s.config.FailurePenalty
	}
	record.Score = s.clamp(record.Score)
	record.UpdatedAt = now()
}

// Score returns an agent's current score, applying decay for elapsed time.
func (s *ReputationStore) Score(agentID string) float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.records[agentID]
	if !ok {
		return s.config.InitialScore
	}
	s.decayLocked(record)
	return record.Score
}

// Snapshot lists every known score, best first.
func (s *ReputationStore) Snapshot() []Reputation {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Reputation, 0, len(s.records))
	for _, record := range s.records {
		s.decayLocked(record)
		out = append(out, *record)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score == out[j].Score {
			return out[i].AgentID < out[j].AgentID
		}
		return out[i].Score > out[j].Score
	})
	return out
}

// ensure returns the record for an agent, creating it with the initial score.
// Callers must hold the lock.
func (s *ReputationStore) ensure(agentID string) *Reputation {
	record, ok := s.records[agentID]
	if !ok {
		record = &Reputation{
			AgentID:   agentID,
			Score:     s.clamp(s.config.InitialScore),
			UpdatedAt: now(),
		}
		s.records[agentID] = record
	}
	return record
}

// decayLocked pulls a stale score back toward the initial score.
func (s *ReputationStore) decayLocked(record *Reputation) {
	halfLife := s.config.DecayHalfLife
	if halfLife <= 0 || record.UpdatedAt.IsZero() {
		return
	}
	elapsed := now().Sub(record.UpdatedAt)
	if elapsed <= 0 {
		return
	}
	// Exponential half-life decay toward the initial score.
	factor := math.Pow(0.5, float64(elapsed)/float64(halfLife))
	record.Score = s.config.InitialScore + (record.Score-s.config.InitialScore)*factor
	record.Score = s.clamp(record.Score)
	record.UpdatedAt = now()
}

func (s *ReputationStore) clamp(score float64) float64 {
	if score < s.config.MinScore {
		return s.config.MinScore
	}
	if score > s.config.MaxScore {
		return s.config.MaxScore
	}
	return score
}
