package agentd

// Unit coverage for the pieces the wire cannot be allowed to forgive: the
// sandbox, the ingress sequence discipline the gateway enforces, and the
// runner's every-path-ends-in-one-terminal contract. The end-to-end wire
// proof lives in e2e_test.go.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	cfg := DefaultConfig()
	cfg.AgentID = "agentd-test-1"
	cfg.Token = "test-token"
	cfg.ProviderURL = "http://provider.invalid/v1"
	cfg.ProviderModel = "test-model"
	cfg.Workdir = t.TempDir()
	cfg.Heartbeat = 10 * time.Millisecond
	return cfg
}

func TestToolsetSandboxRefusesEscapes(t *testing.T) {
	root := t.TempDir()
	tools := NewToolset(root, true, false)

	for _, escape := range []string{"../outside.txt", "/etc/passwd", "a/../../b", "../../etc/passwd"} {
		if _, err := tools.resolvePath(escape); err == nil {
			t.Fatalf("path %q escaped the sandbox", escape)
		}
	}
	// The legal shapes stay legal.
	legal := map[string]string{"notes.txt": filepath.Join(root, "notes.txt"), "sub/dir/file.txt": filepath.Join(root, "sub/dir/file.txt")}
	for relative, want := range legal {
		got, err := tools.resolvePath(relative)
		if err != nil || got != want {
			t.Fatalf("resolvePath(%q) = (%q, %v), want %q", relative, got, err, want)
		}
	}
	// A symlink pointing outside must not smuggle a path.
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink: %v", err)
	}
	if _, err := tools.resolvePath("link/secret.txt"); err == nil {
		t.Fatal("a symlink escaped the sandbox")
	}
}

func TestToolsetWriteReadListRoundTrip(t *testing.T) {
	tools := NewToolset(t.TempDir(), false, false)
	if _, err := tools.runWriteFile(context.Background(), map[string]any{
		"path": "reports/q3.txt", "content": "4.1M",
	}); err != nil {
		t.Fatalf("write: %v", err)
	}
	content, err := tools.runReadFile(context.Background(), map[string]any{"path": "reports/q3.txt"})
	if err != nil || content != "4.1M" {
		t.Fatalf("read: (%q, %v)", content, err)
	}
	listing, err := tools.runListDir(context.Background(), map[string]any{"path": ""})
	if err != nil || !strings.Contains(listing, "reports") {
		t.Fatalf("list: (%q, %v)", listing, err)
	}
	// Shell disabled means the tool is absent, not merely failing.
	for _, tool := range tools.Tools() {
		if tool.Name == "run_command" {
			t.Fatal("run_command must not exist when the shell flag is off")
		}
	}
}

func TestIngressSequenceDiscipline(t *testing.T) {
	var seqs []uint64
	ing := newIngress("run-1", "conv-1", func(seq uint64, record *gatewayv2.ChatIngressRecord) error {
		seqs = append(seqs, seq)
		return nil
	})
	if err := ing.checkpoint([]Entry{{ID: "u1", Kind: "user", Text: "hello"}}); err != nil {
		t.Fatal(err)
	}
	if err := ing.heartbeat(); err != nil {
		t.Fatal(err)
	}
	if err := ing.checkpoint([]Entry{{ID: "u1", Kind: "user", Text: "hello"}, {ID: "a1", Kind: "assistant", Text: "hi"}}); err != nil {
		t.Fatal(err)
	}
	if err := ing.terminal([]Entry{}, TerminalCompleted, "", ""); err != nil {
		t.Fatal(err)
	}
	want := []uint64{1, 2, 3, 4}
	if len(seqs) != len(want) {
		t.Fatalf("sequence numbers = %v, want %v (every record consumes one)", seqs, want)
	}
	for i, seq := range want {
		if seqs[i] != seq {
			t.Fatalf("sequence numbers = %v, want %v", seqs, want)
		}
	}
}

func TestProjectionRoundTripsThroughZstd(t *testing.T) {
	entries := []Entry{
		{ID: "u1", Kind: "user", Text: "report Q3"},
		{ID: "a1", Kind: "assistant", Text: "Q3 revenue was 4.1M."},
	}
	snap, err := newProjection(entries)
	if err != nil {
		t.Fatal(err)
	}
	decoder, err := zstd.NewReader(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer decoder.Close()
	raw, err := decoder.DecodeAll(snap.compressed, nil)
	if err != nil {
		t.Fatalf("the projection is not valid zstd: %v", err)
	}
	var readBack []Entry
	if err := json.Unmarshal(raw, &readBack); err != nil {
		t.Fatalf("the projection is not the entries JSON: %v", err)
	}
	if len(readBack) != 2 || readBack[1].Text != "Q3 revenue was 4.1M." {
		t.Fatalf("entries did not round trip: %+v", readBack)
	}
	if snap.sha256Hex == "" || uint64(len(snap.raw)) != uint64(len(raw)) {
		t.Fatalf("projection hash/size not recorded: sha=%q size=%d", snap.sha256Hex, len(snap.raw))
	}
}

func TestConfigValidateRefusesTheUnhonourable(t *testing.T) {
	cfg := testConfig(t)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("a complete config must validate: %v", err)
	}
	for _, mutation := range []func(*Config){
		func(c *Config) { c.AgentID = "" },
		func(c *Config) { c.Token = "" },
		func(c *Config) { c.ProviderURL = "" },
		func(c *Config) { c.Workdir = "" },
		func(c *Config) { c.Concurrency = 0 },
	} {
		broken := cfg
		mutation(&broken)
		if err := broken.Validate(); err == nil {
			t.Fatal("an unrunnable config must be refused at start-up")
		}
	}
}
