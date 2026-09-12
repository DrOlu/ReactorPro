// Package observability gathers the gateway's observability infrastructure (slog initialization and v2 protocol instrumentation).
package observability

import (
	"log/slog"
	"os"
)

// SetupLogging installs the process-wide default slog logger: single-line key=value output to stderr,
// friendly to container/journald log collection, with structured fields that ease searching and alerting.
func SetupLogging() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
}
