// Package meshstate persists the mesh bridge's long-lived state to the gateway's
// shared SQLite database.
//
// It lives outside the mesh package on purpose. The mesh decides *what* is worth
// remembering — trust pins, reputation, approval decisions — and this package is
// one possible place to keep it. Importing the database from the mesh package
// would invert that, and would make an in-memory-only mesh impossible to run.
package meshstate

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/db"
	"github.com/liveagent/agent-gateway/internal/mesh"
)

// Store implements mesh.StateStore over the gateway's shared connection pool.
type Store struct {
	pool *sql.DB
}

// Timestamps are stored as UTC RFC3339 with nanoseconds. That format is
// lexicographically ordered, so ordering by the text column is the same as
// ordering by time and the approval trim needs no separate index.
const timeLayout = time.RFC3339Nano

// NewStore creates the mesh tables on the gateway's database.
func NewStore(database *db.DB) (*Store, error) {
	if database == nil || !database.Enabled() {
		return nil, errors.New("mesh state store requires a database")
	}
	pool := database.Pool()
	if pool == nil {
		return nil, errors.New("mesh state store requires a database pool")
	}

	schema := []string{
		`CREATE TABLE IF NOT EXISTS mesh_trust_pins (
			agent_id    TEXT PRIMARY KEY,
			fingerprint TEXT NOT NULL,
			first_seen  TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mesh_reputation (
			agent_id  TEXT PRIMARY KEY,
			score     REAL    NOT NULL,
			successes INTEGER NOT NULL,
			failures  INTEGER NOT NULL,
			updated_at TEXT   NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS mesh_approvals (
			id           TEXT PRIMARY KEY,
			requester    TEXT NOT NULL,
			target       TEXT NOT NULL,
			skill        TEXT NOT NULL,
			status       TEXT NOT NULL,
			decided_by   TEXT NOT NULL DEFAULT '',
			reason       TEXT NOT NULL DEFAULT '',
			requested_at TEXT NOT NULL,
			decided_at   TEXT,
			input_json   TEXT
		)`,
	}
	for _, statement := range schema {
		if _, err := pool.Exec(statement); err != nil {
			return nil, fmt.Errorf("init mesh state schema: %w", err)
		}
	}
	store := &Store{pool: pool}
	// The task tables are created alongside the rest: one gateway, one schema.
	// An edge that never receives a task pays for two empty tables, and an
	// edge that does cannot run with a schema it silently lacks.
	if err := store.initTaskSchema(); err != nil {
		return nil, err
	}
	return store, nil
}

// LoadTrustPins returns every recorded identity pin.
func (s *Store) LoadTrustPins() ([]mesh.PeerPin, error) {
	rows, err := s.pool.Query(`SELECT agent_id, fingerprint FROM mesh_trust_pins ORDER BY agent_id`)
	if err != nil {
		return nil, fmt.Errorf("load mesh trust pins: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var pins []mesh.PeerPin
	for rows.Next() {
		var pin mesh.PeerPin
		if err := rows.Scan(&pin.AgentID, &pin.Fingerprint); err != nil {
			return nil, fmt.Errorf("scan mesh trust pin: %w", err)
		}
		pins = append(pins, pin)
	}
	return pins, rows.Err()
}

// SaveTrustPin records an id-to-fingerprint binding.
//
// The fingerprint is only updated when it changes, and the original first-seen
// time is preserved: the binding's age is evidence, and rewriting it on every
// re-observation would destroy that.
func (s *Store) SaveTrustPin(pin mesh.PeerPin) error {
	agentID := strings.TrimSpace(pin.AgentID)
	fingerprint := strings.TrimSpace(pin.Fingerprint)
	if agentID == "" || fingerprint == "" {
		return errors.New("mesh trust pin requires an agent id and a fingerprint")
	}
	_, err := s.pool.Exec(`
		INSERT INTO mesh_trust_pins (agent_id, fingerprint, first_seen)
		VALUES (?, ?, ?)
		ON CONFLICT(agent_id) DO UPDATE SET
			fingerprint = excluded.fingerprint
		WHERE mesh_trust_pins.fingerprint <> excluded.fingerprint`,
		agentID, fingerprint, time.Now().UTC().Format(timeLayout))
	if err != nil {
		return fmt.Errorf("save mesh trust pin: %w", err)
	}
	return nil
}

// LoadReputation returns every recorded score.
func (s *Store) LoadReputation() ([]mesh.Reputation, error) {
	rows, err := s.pool.Query(`
		SELECT agent_id, score, successes, failures, updated_at FROM mesh_reputation`)
	if err != nil {
		return nil, fmt.Errorf("load mesh reputation: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var records []mesh.Reputation
	for rows.Next() {
		var record mesh.Reputation
		var updatedAt string
		if err := rows.Scan(&record.AgentID, &record.Score, &record.Successes,
			&record.Failures, &updatedAt); err != nil {
			return nil, fmt.Errorf("scan mesh reputation: %w", err)
		}
		if parsed, err := time.Parse(timeLayout, updatedAt); err == nil {
			record.UpdatedAt = parsed
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

// SaveReputation records an agent's current score.
func (s *Store) SaveReputation(record mesh.Reputation) error {
	if strings.TrimSpace(record.AgentID) == "" {
		return errors.New("mesh reputation requires an agent id")
	}
	updatedAt := record.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = time.Now()
	}
	_, err := s.pool.Exec(`
		INSERT INTO mesh_reputation (agent_id, score, successes, failures, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(agent_id) DO UPDATE SET
			score      = excluded.score,
			successes  = excluded.successes,
			failures   = excluded.failures,
			updated_at = excluded.updated_at`,
		record.AgentID, record.Score, record.Successes, record.Failures,
		updatedAt.UTC().Format(timeLayout))
	if err != nil {
		return fmt.Errorf("save mesh reputation: %w", err)
	}
	return nil
}

// LoadApprovals returns at most limit decided approvals, newest first.
func (s *Store) LoadApprovals(limit int) ([]mesh.Approval, error) {
	query := `SELECT id, requester, target, skill, status, decided_by, reason,
	                 requested_at, decided_at, input_json
	          FROM mesh_approvals ORDER BY requested_at DESC`
	args := []any{}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}

	rows, err := s.pool.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("load mesh approvals: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var approvals []mesh.Approval
	for rows.Next() {
		var approval mesh.Approval
		var status, requestedAt string
		var decidedAt, inputJSON sql.NullString
		if err := rows.Scan(&approval.ID, &approval.Requester, &approval.Target,
			&approval.Skill, &status, &approval.DecidedBy, &approval.Reason,
			&requestedAt, &decidedAt, &inputJSON); err != nil {
			return nil, fmt.Errorf("scan mesh approval: %w", err)
		}
		approval.Status = mesh.ApprovalStatus(status)
		if parsed, err := time.Parse(timeLayout, requestedAt); err == nil {
			approval.RequestedAt = parsed
		}
		if decidedAt.Valid {
			if parsed, err := time.Parse(timeLayout, decidedAt.String); err == nil {
				approval.DecidedAt = &parsed
			}
		}
		if inputJSON.Valid && inputJSON.String != "" {
			// Best-effort: an argument we cannot decode is not a reason to lose
			// the approval record itself.
			var decoded any
			if err := json.Unmarshal([]byte(inputJSON.String), &decoded); err == nil {
				approval.Input = decoded
			}
		}
		approvals = append(approvals, approval)
	}
	return approvals, rows.Err()
}

// SaveApproval records a decided approval and enforces the history bound.
//
// The trim runs in the same transaction as the insert so the table cannot be
// left over-long by a crash between the two.
func (s *Store) SaveApproval(approval mesh.Approval, keep int) error {
	if strings.TrimSpace(approval.ID) == "" {
		return errors.New("mesh approval requires an id")
	}
	var decidedAt any
	if approval.DecidedAt != nil {
		decidedAt = approval.DecidedAt.UTC().Format(timeLayout)
	}
	var inputJSON any
	if approval.Input != nil {
		if encoded, err := json.Marshal(approval.Input); err == nil {
			inputJSON = string(encoded)
		}
	}

	tx, err := s.pool.Begin()
	if err != nil {
		return fmt.Errorf("save mesh approval: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`
		INSERT INTO mesh_approvals
			(id, requester, target, skill, status, decided_by, reason,
			 requested_at, decided_at, input_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			status     = excluded.status,
			decided_by = excluded.decided_by,
			reason     = excluded.reason,
			decided_at = excluded.decided_at`,
		approval.ID, approval.Requester, approval.Target, approval.Skill,
		string(approval.Status), approval.DecidedBy, approval.Reason,
		approval.RequestedAt.UTC().Format(timeLayout), decidedAt, inputJSON); err != nil {
		return fmt.Errorf("save mesh approval: %w", err)
	}

	if keep > 0 {
		if _, err := tx.Exec(`
			DELETE FROM mesh_approvals WHERE id NOT IN (
				SELECT id FROM mesh_approvals ORDER BY requested_at DESC LIMIT ?
			)`, keep); err != nil {
			return fmt.Errorf("trim mesh approvals: %w", err)
		}
	}
	return tx.Commit()
}
