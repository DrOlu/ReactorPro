package agentd

// Regression tests for the v1.6.9/v1.7.0 timeout fixes. The v1.6.9 bug class:
// Serve() overwrites toolsetCommandTimeout from cfg.CommandTimeout at startup,
// so a bound raised only in tools.go silently reverts to the config default
// and on-device engine selection gets SIGKILLed under load.

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDefaultCommandTimeoutMatchesToolsetBound(t *testing.T) {
	// Serve() installs cfg.CommandTimeout as the toolset command bound. If the
	// config default drifts below the toolset constant again, on-device engine
	// selection gets SIGKILLed under load (the v1.6.9 regression).
	cfg := DefaultConfig()
	if cfg.CommandTimeout < toolsetCommandTimeout {
		t.Fatalf("config default CommandTimeout (%v) must be >= toolsetCommandTimeout (%v); a smaller default reintroduces the engine SIGKILL bug", cfg.CommandTimeout, toolsetCommandTimeout)
	}
}

func TestSetCommandTimeoutIsHonouredByTheToolset(t *testing.T) {
	prev := toolsetCommandTimeout
	SetCommandTimeout(250 * time.Millisecond)
	t.Cleanup(func() { SetCommandTimeout(prev) })
	if toolsetCommandTimeout != 250*time.Millisecond {
		t.Fatalf("SetCommandTimeout did not take effect: %v", toolsetCommandTimeout)
	}
}

func TestNeuralOSQueryKillsAHangingEngine(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake engine helper is a POSIX shell script")
	}
	root := t.TempDir()
	instanceDir := filepath.Join(root, "toys")
	if err := os.MkdirAll(instanceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(instanceDir, "needle_menu.json"),
		[]byte(`[{"name":"echo"}]`), 0o644); err != nil {
		t.Fatal(err)
	}

	// An engine that never answers: selection must hit the toolset deadline
	// and surface a killed-process error instead of hanging the whole turn.
	// Written directly (not via fakeEngine, which printf-wraps its payload).
	hanging := filepath.Join(root, "hanging-needle")
	if err := os.WriteFile(hanging, []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	prev := toolsetCommandTimeout
	SetCommandTimeout(200 * time.Millisecond)
	t.Cleanup(func() { SetCommandTimeout(prev) })

	toolset := NewToolset(t.TempDir(), true, true, nil).
		EnableNeuralOS(&NeuralOSConfig{
			InstancesDir: root,
			Engine:       hanging,
			Python:       fakeBridgePython(t, root),
		})

	start := time.Now()
	_, err := toolset.runNeuralOSQuery(context.Background(), map[string]any{
		"instance": "toys",
		"question": "echo this",
	})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected an engine-selection error from the hanging engine")
	}
	if !strings.Contains(err.Error(), "engine selection failed") {
		t.Fatalf("expected engine-selection failure, got: %v", err)
	}
	if !strings.Contains(err.Error(), "killed") {
		t.Fatalf("expected the hanging engine to be killed, got: %v", err)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("engine kill took %v; the deadline is not being enforced", elapsed)
	}
}
