// Package db manages the gateway's shared database connection pool: each persistence
// subsystem creates its own tables on the same pool, avoiding multiple pools on one
// database amplifying lock contention. The current backend is embedded SQLite; backend
// switching is dispatched in Open.
package db

import (
	"database/sql"
	"errors"
	"strings"
)

// DB is the handle to the Gateway's shared connection pool.
type DB struct {
	pool *sql.DB
}

// Open opens the connection pool; an empty DSN is an immediate error, and the Gateway
// offers no mode that disables persistence. Currently only SQLite is supported (the DSN
// is the file path); backend extensions (e.g. PostgreSQL) are dispatched here by DSN.
func Open(dsn string) (*DB, error) {
	dsn = strings.TrimSpace(dsn)
	if dsn == "" {
		return nil, errors.New("gateway database path is required")
	}
	pool, err := openSQLite(dsn)
	if err != nil {
		return nil, err
	}
	return &DB{pool: pool}, nil
}

func (d *DB) Enabled() bool {
	return d != nil
}

// Pool returns the underlying connection pool for subsystems to create tables and query;
// its lifetime belongs to this package, and callers must not Close it.
func (d *DB) Pool() *sql.DB {
	if d == nil {
		return nil
	}
	return d.pool
}

func (d *DB) Close() error {
	if d == nil {
		return nil
	}
	return d.pool.Close()
}
