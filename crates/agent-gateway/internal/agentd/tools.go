package agentd

// The curated tool set. The desktop's tool surface is large because a person
// sits in front of it; the agentd ships the opposite: a small, legible set an
// operator can reason about, each tool constrained to the configured workdir.
// The two tools with the widest reach (shell, network fetch) are flags, so a
// read-only worker is one flag away.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// toolOutputCap bounds one tool result as delivered into the conversation:
// a runaway command or a huge file must degrade the turn, not break it.
const toolOutputCap = 64 << 10

// fetchCap bounds one fetched body, for the same reason.
const fetchCap = 256 << 10

// Tool is one capability offered to the model inside a turn.
type Tool struct {
	Name        string
	Description string
	// Parameters is the JSON Schema object for the tool's arguments, in the
	// provider's function-calling format.
	Parameters map[string]any
	// Run executes the tool. The returned string is the tool result the model
	// reads; an error is reported to the model as a failed call, which it
	// may retry or route around — a failed tool is a turn event, not a
	// turn-ending failure.
	Run func(ctx context.Context, args map[string]any) (string, error)
}

// Toolset builds the enabled tools around a sandbox root.
type Toolset struct {
	root  string
	shell bool
	fetch bool
}

// NewToolset binds the enabled tools to a workdir root.
func NewToolset(root string, shell, fetch bool) *Toolset {
	return &Toolset{root: root, shell: shell, fetch: fetch}
}

// Tools returns the enabled tools in a stable order (order matters: it is the
// order the provider sees them in every request).
func (t *Toolset) Tools() []Tool {
	tools := []Tool{
		{
			Name:        "read_file",
			Description: "Read a text file inside the work directory. Returns the file content.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{"type": "string", "description": "Path relative to the work directory."},
				},
				"required": []string{"path"},
			},
			Run: t.runReadFile,
		},
		{
			Name:        "write_file",
			Description: "Write a text file inside the work directory, creating parent directories.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":    map[string]any{"type": "string", "description": "Path relative to the work directory."},
					"content": map[string]any{"type": "string", "description": "The full file content to write."},
				},
				"required": []string{"path", "content"},
			},
			Run: t.runWriteFile,
		},
		{
			Name:        "list_dir",
			Description: "List the entries of a directory inside the work directory.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{"type": "string", "description": "Directory path relative to the work directory; empty means the work directory itself."},
				},
			},
			Run: t.runListDir,
		},
	}
	if t.shell {
		tools = append(tools, Tool{
			Name:        "run_command",
			Description: "Run a shell command with the work directory as cwd. Returns stdout and stderr. Each command is bounded by the configured timeout.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command": map[string]any{"type": "string", "description": "The shell command line to run."},
				},
				"required": []string{"command"},
			},
			Run: t.runCommand,
		})
	}
	if t.fetch {
		tools = append(tools, Tool{
			Name:        "fetch_url",
			Description: "Fetch a URL over HTTPS and return the response body (text). GET only, size-capped.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"url": map[string]any{"type": "string", "description": "The http:// or https:// URL to fetch."},
				},
				"required": []string{"url"},
			},
			Run: t.runFetch,
		})
	}
	return tools
}

// resolvePath anchors a tool-supplied path inside the sandbox root and refuses
// anything that escapes it — including via .., absolute paths, or a symlink
// that points outside. Refusal is an error the model sees, not a panic the
// process pays for.
func (t *Toolset) resolvePath(relative string) (string, error) {
	clean := filepath.Clean(strings.TrimSpace(relative))
	if clean == "." || clean == "" {
		return t.root, nil
	}
	// Absolute paths are refused, not re-anchored: silently rewriting
	// /etc/passwd to <root>/etc/passwd would hand the model a file it never
	// asked for. The error tells it the rule, so it can retry correctly.
	if filepath.IsAbs(clean) {
		return "", fmt.Errorf("path %q must be relative to the work directory", relative)
	}
	joined := filepath.Join(t.root, clean)
	if !withinRoot(t.root, joined) {
		return "", fmt.Errorf("path %q escapes the work directory", relative)
	}
	return joined, nil
}

// withinRoot reports whether target sits under root, following symlinks so a
// link cannot smuggle a path outside. A target whose parent directories do not
// exist yet (first write into a new subdirectory) is resolved as far as it
// exists: the not-yet-created tail is already ..-free because filepath.Join
// cleaned it, so it cannot walk out on its own.
func withinRoot(root, target string) bool {
	rootAbs, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	dir, tail := filepath.Dir(target), filepath.Base(target)
	for {
		resolved, err := filepath.EvalSymlinks(dir)
		if err == nil {
			dir = resolved
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		tail = filepath.Join(filepath.Base(dir), tail)
		dir = parent
	}
	resolved := filepath.Join(dir, tail)
	return resolved == rootAbs || strings.HasPrefix(resolved, rootAbs+string(filepath.Separator))
}

func argString(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return strings.TrimSpace(value)
}

func (t *Toolset) runReadFile(_ context.Context, args map[string]any) (string, error) {
	path, err := t.resolvePath(argString(args, "path"))
	if err != nil {
		return "", err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %q: %v", argString(args, "path"), err)
	}
	return capString(string(content), toolOutputCap), nil
}

func (t *Toolset) runWriteFile(_ context.Context, args map[string]any) (string, error) {
	path, err := t.resolvePath(argString(args, "path"))
	if err != nil {
		return "", err
	}
	content := args["content"]
	text, ok := content.(string)
	if !ok {
		return "", fmt.Errorf("write %q: content must be a string", argString(args, "path"))
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("write %q: %v", argString(args, "path"), err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		return "", fmt.Errorf("write %q: %v", argString(args, "path"), err)
	}
	return fmt.Sprintf("wrote %d bytes to %s", len(text), argString(args, "path")), nil
}

func (t *Toolset) runListDir(_ context.Context, args map[string]any) (string, error) {
	path, err := t.resolvePath(argString(args, "path"))
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return "", fmt.Errorf("list %q: %v", argString(args, "path"), err)
	}
	if len(entries) == 0 {
		return "(empty directory)", nil
	}
	var lines []string
	for _, entry := range entries {
		kind := "file"
		if entry.IsDir() {
			kind = "dir"
		}
		lines = append(lines, kind+"\t"+entry.Name())
	}
	return capString(strings.Join(lines, "\n"), toolOutputCap), nil
}

func (t *Toolset) runCommand(ctx context.Context, args map[string]any) (string, error) {
	command := args["command"]
	line, ok := command.(string)
	if !ok || strings.TrimSpace(line) == "" {
		return "", fmt.Errorf("run_command: command must be a non-empty string")
	}
	cmdCtx, cancel := context.WithTimeout(ctx, toolsetCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "sh", "-c", line)
	cmd.Dir = t.root
	output, err := cmd.CombinedOutput()
	if err != nil {
		// The command failed — that is a result the model must see, with the
		// exit reason and whatever output it produced.
		return fmt.Sprintf("command failed: %v\n%s", err, capString(string(output), toolOutputCap)), nil
	}
	return capString(string(output), toolOutputCap), nil
}

func (t *Toolset) runFetch(ctx context.Context, args map[string]any) (string, error) {
	raw := argString(args, "url")
	if raw == "" {
		return "", fmt.Errorf("fetch_url: url is required")
	}
	if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		return "", fmt.Errorf("fetch_url: only http and https URLs are supported")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "reactorpro-agentd/"+Version)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch %q: %v", raw, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode >= 400 {
		return "", fmt.Errorf("fetch %q: status %s", raw, response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, fetchCap))
	if err != nil {
		return "", fmt.Errorf("fetch %q: %v", raw, err)
	}
	return capString(string(body), fetchCap), nil
}

// toolsetCommandTimeout bounds one shell command; Serve installs the
// configured value once at start-up, keeping the tool function signature free
// of configuration plumbing.
var toolsetCommandTimeout = 60 * time.Second

// SetCommandTimeout installs the shell command budget.
func SetCommandTimeout(timeout time.Duration) {
	if timeout > 0 {
		toolsetCommandTimeout = timeout
	}
}

// capString truncates on a rune boundary and says so — the model must never
// be handed a silent cut.
func capString(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !isRuneStartByte(text[cut]) {
		cut--
	}
	return text[:cut] + "\n…[truncated: output exceeded the tool output limit]"
}
