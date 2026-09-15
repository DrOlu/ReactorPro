package meshstate

// Task storage for the mesh task lifecycle, on the gateway's shared SQLite
// database. The mesh package defines the contract (mesh.TaskStore); this file
// is one place to keep it. Unlike the StateStore methods, these are
// load-bearing: errors here surface to the caller instead of being logged and
// absorbed, because a task that "should" exist but cannot be read back is a
// broken promise, not a degraded cache.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/mesh"
)

// taskTimeLayout is a fixed-width UTC timestamp: nine digits of nanoseconds,
// always emitted, never truncated.
//
// RFC3339Nano is NOT lexicographically ordered across second boundaries: it
// drops trailing zeros, so `12:00:00` (no fraction) sorts AFTER
// `12:00:00.000000003` as text — '.' sorts before 'Z'. Pagination compares
// these strings directly, and a cursor at a whole second — exactly what a
// client sends when it round-trips a timestamp — would mis-order rows. The
// zero-padded layout makes text order and time order the same thing.
const taskTimeLayout = "2006-01-02T15:04:05.000000000Z"

// taskSchema is created alongside the other mesh tables. Composite primary
// key (caller_id, task_id): two tenants may use the same task id, and every
// read is scoped by caller, so the key and the access rule agree.
const taskSchema = `
CREATE TABLE IF NOT EXISTS mesh_tasks (
	caller_id          TEXT NOT NULL,
	task_id            TEXT NOT NULL,
	caller_fingerprint TEXT NOT NULL DEFAULT '',
	agent              TEXT NOT NULL DEFAULT '',
	operation          TEXT NOT NULL DEFAULT '',
	arguments_json     TEXT,
	state              TEXT NOT NULL,
	result_json        TEXT,
	error_code         TEXT NOT NULL DEFAULT '',
	error_message      TEXT NOT NULL DEFAULT '',
	trace_id           TEXT NOT NULL DEFAULT '',
	stream             INTEGER NOT NULL DEFAULT 0,
	created_at         TEXT NOT NULL,
	updated_at         TEXT NOT NULL,
	PRIMARY KEY (caller_id, task_id)
)`

const stubSchema = `
CREATE TABLE IF NOT EXISTS mesh_task_stubs (
	task_id        TEXT PRIMARY KEY,
	target         TEXT NOT NULL,
	skill          TEXT NOT NULL DEFAULT '',
	state          TEXT NOT NULL,
	result_json    TEXT,
	error_message  TEXT NOT NULL DEFAULT '',
	completed_sync INTEGER NOT NULL DEFAULT 0,
	created_at     TEXT NOT NULL,
	updated_at    TEXT NOT NULL
)`

// initTaskSchema creates the task tables and migrates them forward.
//
// v1.5.16 created mesh_tasks without the stream column: the Go struct carried
// the field and the SQL silently dropped it, so a streamed task's own record
// read stream:false — caught when a live streamed task was inspected on disk.
// CREATE IF NOT EXISTS cannot add a column to an existing table, and SQLite
// has no ADD COLUMN IF NOT EXISTS, so the migration checks first.
func (s *Store) initTaskSchema() error {
	for _, statement := range []string{taskSchema, stubSchema} {
		if _, err := s.pool.Exec(statement); err != nil {
			return fmt.Errorf("init mesh task schema: %w", err)
		}
	}
	if !taskColumnExists(s.pool, "mesh_tasks", "stream") {
		if _, err := s.pool.Exec(`ALTER TABLE mesh_tasks ADD COLUMN stream INTEGER NOT NULL DEFAULT 0`); err != nil {
			return fmt.Errorf("migrate mesh_tasks stream column: %w", err)
		}
	}
	return nil
}

// taskColumnExists reads PRAGMA table_info, the only way to ask SQLite whether
// a column is present. The table name is a call-site constant, never a value.
func taskColumnExists(pool *sql.DB, table, column string) bool {
	rows, err := pool.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var index int
		var name, columnType string
		var notNull int
		var defaultValue any
		var primaryKey int
		if err := rows.Scan(&index, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false
		}
		if name == column {
			return true
		}
	}
	return false
}

func formatTaskTime(t time.Time) string { return t.UTC().Format(taskTimeLayout) }

// SaveTask inserts or updates a task keyed by (caller, task id).
func (s *Store) SaveTask(task mesh.Task) error {
	if strings.TrimSpace(task.Caller) == "" || strings.TrimSpace(task.TaskID) == "" {
		return errors.New("mesh task requires a caller and a task id")
	}
	var arguments, result any
	if len(task.Arguments) > 0 {
		arguments = string(task.Arguments)
	}
	if len(task.Result) > 0 {
		result = string(task.Result)
	}
	_, err := s.pool.Exec(`
		INSERT INTO mesh_tasks
			(caller_id, task_id, caller_fingerprint, agent, operation, arguments_json,
			 state, result_json, error_code, error_message, trace_id, stream, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(caller_id, task_id) DO UPDATE SET
			caller_fingerprint = excluded.caller_fingerprint,
			agent             = excluded.agent,
			operation         = excluded.operation,
			arguments_json     = excluded.arguments_json,
			state             = excluded.state,
			result_json       = excluded.result_json,
			error_code        = excluded.error_code,
			error_message    = excluded.error_message,
			trace_id          = excluded.trace_id,
			stream            = excluded.stream,
			created_at        = excluded.created_at,
			updated_at       = excluded.updated_at`,
		task.Caller, task.TaskID, task.CallerFingerprint, task.Agent, task.Operation,
		arguments, string(task.State), result, task.ErrorCode, task.ErrorMessage,
		task.TraceID, taskBool(task.Stream), formatTaskTime(task.CreatedAt), formatTaskTime(task.UpdatedAt))
	if err != nil {
		return fmt.Errorf("save mesh task: %w", err)
	}
	return nil
}

// taskBool converts a bool to the SQLite INTEGER the schema stores.
func taskBool(value bool) int {
	if value {
		return 1
	}
	return 0
}

// GetTask returns one task, scoped by caller.
func (s *Store) GetTask(caller, taskID string) (mesh.Task, bool, error) {
	row := s.pool.QueryRow(`
		SELECT caller_id, task_id, caller_fingerprint, agent, operation, arguments_json,
		       state, result_json, error_code, error_message, trace_id, stream, created_at, updated_at
		FROM mesh_tasks WHERE caller_id = ? AND task_id = ?`, caller, taskID)
	task, err := scanTask(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return mesh.Task{}, false, nil
	}
	if err != nil {
		return mesh.Task{}, false, err
	}
	return task, true, nil
}

// scanTask is shared between the one-row and multi-row readers.
func scanTask(scan func(dest ...any) error) (mesh.Task, error) {
	var task mesh.Task
	var state, createdAt, updatedAt string
	var fingerprint, agent, operation, errorCode, errorMessage, traceID string
	var arguments, result sql.NullString
	var stream int
	if err := scan(&task.Caller, &task.TaskID, &fingerprint, &agent, &operation, &arguments,
		&state, &result, &errorCode, &errorMessage, &traceID, &stream, &createdAt, &updatedAt); err != nil {
		return mesh.Task{}, err
	}
	task.Stream = stream != 0
	task.CallerFingerprint, task.Agent = fingerprint, agent
	task.Operation, task.ErrorCode, task.ErrorMessage, task.TraceID = operation, errorCode, errorMessage, traceID
	task.State = mesh.TaskState(state)
	if arguments.Valid && arguments.String != "" {
		task.Arguments = json.RawMessage(arguments.String)
	}
	if result.Valid && result.String != "" {
		task.Result = json.RawMessage(result.String)
	}
	var err error
	if task.CreatedAt, err = time.Parse(taskTimeLayout, createdAt); err != nil {
		return mesh.Task{}, fmt.Errorf("parse mesh task created_at: %w", err)
	}
	if task.UpdatedAt, err = time.Parse(taskTimeLayout, updatedAt); err != nil {
		return mesh.Task{}, fmt.Errorf("parse mesh task updated_at: %w", err)
	}
	return task, nil
}

// ListTasks returns tasks newest-first with cursor pagination.
//
// The cursor is the last row's (created_at, task_id): the next page is
// strictly older than that pair — a row-value comparison, exact even when two
// rows share a timestamp, and stable under concurrent inserts, unlike OFFSET
// where a new task shifting the window can skip or repeat a row.
func (s *Store) ListTasks(filter mesh.TaskFilter) ([]mesh.Task, error) {
	query := `
		SELECT caller_id, task_id, caller_fingerprint, agent, operation, arguments_json,
		       state, result_json, error_code, error_message, trace_id, stream, created_at, updated_at
		FROM mesh_tasks`
	conditions := []string{}
	args := []any{}
	if strings.TrimSpace(filter.Caller) != "" {
		conditions = append(conditions, "caller_id = ?")
		args = append(args, strings.TrimSpace(filter.Caller))
	}
	if len(filter.States) > 0 {
		placeholders := make([]string, len(filter.States))
		for i, state := range filter.States {
			placeholders[i] = "?"
			args = append(args, string(state))
		}
		conditions = append(conditions, "state IN ("+strings.Join(placeholders, ",")+")")
	}
	if !filter.Before.IsZero() {
		conditions = append(conditions, "(created_at, task_id) < (?, ?)")
		args = append(args, formatTaskTime(filter.Before), filter.BeforeTaskID)
	}
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	query += " ORDER BY created_at DESC, task_id DESC LIMIT ?"
	args = append(args, filter.Limit)
	if filter.Limit <= 0 {
		args[len(args)-1] = 50
	}

	rows, err := s.pool.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list mesh tasks: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var tasks []mesh.Task
	for rows.Next() {
		task, err := scanTask(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("scan mesh task: %w", err)
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

// PruneTasks deletes terminal tasks last updated before the cutoff.
func (s *Store) PruneTasks(cutoff time.Time) (int64, error) {
	result, err := s.pool.Exec(`
		DELETE FROM mesh_tasks
		WHERE updated_at < ?
		  AND state IN (?, ?, ?, ?)`,
		formatTaskTime(cutoff),
		string(mesh.TaskCompleted), string(mesh.TaskFailed),
		string(mesh.TaskCanceled), string(mesh.TaskRejected))
	if err != nil {
		return 0, fmt.Errorf("prune mesh tasks: %w", err)
	}
	return result.RowsAffected()
}

// SaveTaskStub inserts or updates a caller-side stub.
func (s *Store) SaveTaskStub(stub mesh.TaskStub) error {
	if strings.TrimSpace(stub.TaskID) == "" {
		return errors.New("mesh task stub requires a task id")
	}
	var result any
	if len(stub.Result) > 0 {
		result = string(stub.Result)
	}
	syncFlag := 0
	if stub.CompletedSync {
		syncFlag = 1
	}
	_, err := s.pool.Exec(`
		INSERT INTO mesh_task_stubs
			(task_id, target, skill, state, result_json, error_message, completed_sync, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(task_id) DO UPDATE SET
			target         = excluded.target,
			skill          = excluded.skill,
			state          = excluded.state,
			result_json    = excluded.result_json,
			error_message  = excluded.error_message,
			completed_sync = excluded.completed_sync,
			created_at     = excluded.created_at,
			updated_at    = excluded.updated_at`,
		stub.TaskID, stub.Target, stub.Skill, string(stub.State), result,
		stub.ErrorMessage, syncFlag,
		formatTaskTime(stub.CreatedAt), formatTaskTime(stub.UpdatedAt))
	if err != nil {
		return fmt.Errorf("save mesh task stub: %w", err)
	}
	return nil
}

// GetTaskStub returns one stub by task id.
func (s *Store) GetTaskStub(taskID string) (mesh.TaskStub, bool, error) {
	var stub mesh.TaskStub
	var state, createdAt, updatedAt string
	var result sql.NullString
	var syncFlag int
	err := s.pool.QueryRow(`
		SELECT task_id, target, skill, state, result_json, error_message, completed_sync, created_at, updated_at
		FROM mesh_task_stubs WHERE task_id = ?`, taskID).
		Scan(&stub.TaskID, &stub.Target, &stub.Skill, &state, &result,
			&stub.ErrorMessage, &syncFlag, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return mesh.TaskStub{}, false, nil
	}
	if err != nil {
		return mesh.TaskStub{}, false, fmt.Errorf("get mesh task stub: %w", err)
	}
	stub.State = mesh.TaskState(state)
	if result.Valid && result.String != "" {
		stub.Result = json.RawMessage(result.String)
	}
	stub.CompletedSync = syncFlag != 0
	if stub.CreatedAt, err = time.Parse(taskTimeLayout, createdAt); err != nil {
		return mesh.TaskStub{}, false, fmt.Errorf("parse stub created_at: %w", err)
	}
	if stub.UpdatedAt, err = time.Parse(taskTimeLayout, updatedAt); err != nil {
		return mesh.TaskStub{}, false, fmt.Errorf("parse stub updated_at: %w", err)
	}
	return stub, true, nil
}

// ListTaskStubs returns stubs newest-first with the same cursor rule as tasks.
func (s *Store) ListTaskStubs(before time.Time, limit int) ([]mesh.TaskStub, error) {
	query := `
		SELECT task_id, target, skill, state, result_json, error_message, completed_sync, created_at, updated_at
		FROM mesh_task_stubs`
	args := []any{}
	if !before.IsZero() {
		query += " WHERE created_at < ?"
		args = append(args, formatTaskTime(before))
	}
	query += " ORDER BY created_at DESC LIMIT ?"
	args = append(args, limit)
	if limit <= 0 {
		args[len(args)-1] = 50
	}
	rows, err := s.pool.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list mesh task stubs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var stubs []mesh.TaskStub
	for rows.Next() {
		var stub mesh.TaskStub
		var state, createdAt, updatedAt string
		var result sql.NullString
		var syncFlag int
		if err := rows.Scan(&stub.TaskID, &stub.Target, &stub.Skill, &state, &result,
			&stub.ErrorMessage, &syncFlag, &createdAt, &updatedAt); err != nil {
			return nil, fmt.Errorf("scan mesh task stub: %w", err)
		}
		stub.State = mesh.TaskState(state)
		if result.Valid && result.String != "" {
			stub.Result = json.RawMessage(result.String)
		}
		stub.CompletedSync = syncFlag != 0
		if stub.CreatedAt, err = time.Parse(taskTimeLayout, createdAt); err != nil {
			return nil, fmt.Errorf("parse stub created_at: %w", err)
		}
		if stub.UpdatedAt, err = time.Parse(taskTimeLayout, updatedAt); err != nil {
			return nil, fmt.Errorf("parse stub updated_at: %w", err)
		}
		stubs = append(stubs, stub)
	}
	return stubs, rows.Err()
}

// CountTaskStubs reports the stub count for the status snapshot.
func (s *Store) CountTaskStubs() (int64, error) {
	var count int64
	if err := s.pool.QueryRow(`SELECT COUNT(*) FROM mesh_task_stubs`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count mesh task stubs: %w", err)
	}
	return count, nil
}
