package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/db"
	"github.com/liveagent/agent-gateway/internal/observability"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

// fatal logs the error and exits with a non-zero code (slog has no Fatal level, so it is handled centrally here).
func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
}

func main() {
	observability.SetupLogging()
	cfg := config.Load()
	sm := session.NewManager()

	// Shared connection pool: the database is opened and centrally managed by internal/db,
	// and each persistence subsystem initializes its own tables on the shared pool; main
	// owns the lifecycle (closing it once on exit).
	database, err := db.Open(cfg.AgentDB)
	if err != nil {
		fatal("open gateway db failed", "path", cfg.AgentDB, "err", err)
	}
	defer func() { _ = database.Close() }()

	tokens, err := agenttoken.NewStore(database)
	if err != nil {
		fatal("init agent token store failed", "err", err)
	}
	slog.Info("agent registry db ready", "path", cfg.AgentDB)
	slog.Info("agent authentication accepts gateway token or per-agent token")

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.NewHTTPServer(cfg, sm, tokens),
		ReadHeaderTimeout: 10 * time.Second,
		// Idle keep-alive connections must be reclaimed, otherwise REST/static-asset
		// clients that hold connections open will slowly exhaust fds up to ulimit.
		// Deliberately no global Read/WriteTimeout: streaming uploads and long tunnel
		// responses need it; WS connections are hijacked and manage their own timeouts,
		// so they are unaffected.
		IdleTimeout: 120 * time.Second,
	}

	errCh := make(chan error, 1)

	go func() {
		slog.Info("HTTP listening", "addr", cfg.HTTPAddr)
		var serveErr error
		if cfg.TLSCert != "" || cfg.TLSKey != "" {
			serveErr = httpServer.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			serveErr = httpServer.ListenAndServe()
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
	}()

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-signalCh:
		slog.Info("received signal, shutting down", "signal", sig.String())
	case err := <-errCh:
		fatal("server error", "err", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		slog.Warn("http shutdown error", "err", err)
	}
}
