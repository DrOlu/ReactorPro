package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// openSQLite opens the embedded SQLite connection pool. WAL keeps reads and writes
// from excluding each other, busy_timeout makes occasional write conflicts wait and
// retry, and the file is tightened to 0600 (default 0644; the database contains
// sensitive data such as credential hashes).
func openSQLite(path string) (*sql.DB, error) {
	if dir := filepath.Dir(path); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("create sqlite directory: %w", err)
		}
	}
	pool, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite writes are naturally serialized to a single writer while reads run in
	// parallel via WAL; 4 is enough to cover the concurrency of handshake validation
	// plus the admin API.
	pool.SetMaxOpenConns(4)
	pool.SetMaxIdleConns(4)
	// sql.Open connects lazily; Ping forces creation of the database file so that
	// chmod has a target.
	if err := pool.Ping(); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("chmod sqlite file: %w", err)
	}
	return pool, nil
}
