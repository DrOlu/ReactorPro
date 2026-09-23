package agentd

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeEngine emits the needle engine's call-selection contract.
func fakeEngine(t *testing.T, dir, payload string) string {
	t.Helper()
	path := filepath.Join(dir, "fake-needle")
	if runtime.GOOS == "windows" {
		path += ".cmd"
	}
	script := "#!/bin/sh\nprintf '%s' '" + payload + "'\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// fakeBridgePython plays the python interpreter: it implements the bridge
// snippet's contract (argv: <dir> <probe>; arguments JSON on stdin; one JSON
// digest line on stdout) without needing a real instance fleet.
func fakeBridgePython(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "fake-python")
	body := `#!/bin/sh
# argv after -c: <dir> <probe>; stdin holds the arguments JSON
read -r ARGS
printf '{"probe":"%s","result":{"args":%s}}' "$4" "$ARGS"
`
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEnableNeuralOSDisabledWithoutDir(t *testing.T) {
	toolset := NewToolset(t.TempDir(), true, true, nil).EnableNeuralOS(&NeuralOSConfig{})
	for _, tool := range toolset.Tools() {
		if strings.HasPrefix(tool.Name, "neuralos_") {
			t.Fatalf("neuralOS tool %q registered with an empty instances dir", tool.Name)
		}
	}
}

func TestEnableNeuralOSNilConfigDisabled(t *testing.T) {
	toolset := NewToolset(t.TempDir(), true, true, nil).EnableNeuralOS(nil)
	for _, tool := range toolset.Tools() {
		if strings.HasPrefix(tool.Name, "neuralos_") {
			t.Fatalf("neuralOS tool %q registered with nil config", tool.Name)
		}
	}
}

func TestNeuralOSInstancesListsMenus(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"chinook", "cyberbank"} {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "needle_menu.json"),
			[]byte(`[{"name":"a"},{"name":"b"}]`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	toolset := NewToolset(t.TempDir(), true, true, nil).
		EnableNeuralOS(&NeuralOSConfig{InstancesDir: root})

	out, err := toolset.runNeuralOSInstances(context.Background(), map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "chinook\t2 probes") || !strings.Contains(out, "cyberbank\t2 probes") {
		t.Fatalf("unexpected listing: %q", out)
	}
}

func TestNeuralOSQueryRejectsBadInstance(t *testing.T) {
	root := t.TempDir()
	toolset := NewToolset(t.TempDir(), true, true, nil).
		EnableNeuralOS(&NeuralOSConfig{InstancesDir: root})
	if _, err := toolset.runNeuralOSQuery(context.Background(), map[string]any{
		"instance": "../escape", "question": "x",
	}); err == nil || !strings.Contains(err.Error(), "invalid instance") {
		t.Fatalf("expected invalid-instance error, got %v", err)
	}
}

func TestNeuralOSQueryEndToEndWithFakeEngine(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake engine/bridge helpers are POSIX shell scripts")
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
	engine := fakeEngine(t, root,
		`{"function_calls":[{"name":"echo","arguments":{"word":"ping"}}],"confidence":0.9}`)
	python := fakeBridgePython(t, root)

	toolset := NewToolset(t.TempDir(), true, true, nil).
		EnableNeuralOS(&NeuralOSConfig{
			InstancesDir: root,
			Engine:       engine,
			Cact:         filepath.Join(root, "needle3.cact"),
			Python:       python,
		})

	out, err := toolset.runNeuralOSQuery(context.Background(), map[string]any{
		"instance": "toys",
		"question": "echo this",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"probe":"echo"`) {
		t.Fatalf("digest missing probe name: %q", out)
	}
	if !strings.Contains(out, `"word":"ping"`) {
		t.Fatalf("digest missing bridged arguments: %q", out)
	}
}

func TestNeuralOSQueryEmptySelectionIsHonest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake engine helper is a POSIX shell script")
	}
	root := t.TempDir()
	instanceDir := filepath.Join(root, "toys")
	if err := os.MkdirAll(instanceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(instanceDir, "needle_menu.json"), []byte(`[]`), 0o644); err != nil {
		t.Fatal(err)
	}
	engine := fakeEngine(t, root, `{"function_calls":[],"confidence":0.4}`)
	toolset := NewToolset(t.TempDir(), true, true, nil).
		EnableNeuralOS(&NeuralOSConfig{
			InstancesDir: root,
			Engine:       engine,
			Cact:         filepath.Join(root, "needle3.cact"),
			Python:       "python3",
		})
	out, err := toolset.runNeuralOSQuery(context.Background(), map[string]any{
		"instance": "toys", "question": "anything",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "no probe selected") {
		t.Fatalf("expected honest refusal, got %q", out)
	}
}

func TestIsNeuralOSProbeName(t *testing.T) {
	if !isNeuralOSProbeName("multi_account_customers") {
		t.Fatal("valid probe rejected")
	}
	for _, bad := range []string{"", "Bridge", "os.system", "__import__", "a b", strings.Repeat("x", 65)} {
		if isNeuralOSProbeName(bad) {
			t.Fatalf("invalid probe %q accepted", bad)
		}
	}
}

func TestConfigNeuralOSDefaultsDisabled(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.NeuralOSInstancesDir != "" || cfg.NeuralOSEngine != "" ||
		cfg.NeuralOSCact != "" || cfg.NeuralOSPython != "" {
		t.Fatal("neuralOS config must default to disabled/empty")
	}
}
