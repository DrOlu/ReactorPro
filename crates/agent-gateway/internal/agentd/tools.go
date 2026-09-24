package agentd

// The curated tool set. The desktop's tool surface is large because a person
// sits in front of it; the agentd ships the opposite: a small, legible set an
// operator can reason about, each tool constrained to the configured workdir.
// The two tools with the widest reach (shell, network fetch) are flags, so a
// read-only worker is one flag away.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
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

// Toolset builds the enabled tools around a sandbox root, plus an optional
// read-only skills library.
type Toolset struct {
	root     string
	shell    bool
	fetch    bool
	skills   map[string]Skill
	neuralos *NeuralOSConfig
}

// NeuralOSConfig pins where the on-device needle engine, the needle3.cact
// weights, and the python interpreter that runs instance bridges live. A nil
// config (or an empty InstancesDir) disables the neuralOS tools.
type NeuralOSConfig struct {
	InstancesDir string
	Engine       string
	Cact         string
	Python       string
}

// EnableNeuralOS installs the neuralOS tool pair (instance list + query).
// Chained after NewToolset so the existing constructor call sites stay put.
func (t *Toolset) EnableNeuralOS(cfg *NeuralOSConfig) *Toolset {
	if cfg != nil && strings.TrimSpace(cfg.InstancesDir) != "" {
		t.neuralos = cfg
	}
	return t
}

// NewToolset binds the enabled tools to a workdir root and a scanned skills
// library (nil or empty disables the skill tools).
func NewToolset(root string, shell, fetch bool, skills []Skill) *Toolset {
	byName := map[string]Skill{}
	for _, skill := range skills {
		byName[skill.Name] = skill
	}
	return &Toolset{root: root, shell: shell, fetch: fetch, skills: byName}
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
	if t.neuralos != nil {
		tools = append(tools,
			Tool{
				Name:        "neuralos_instances",
				Description: "List the installed neuralOS data instances. Each exposes validated read probes over one live data source (MySQL, Cloudflare, AWS, ...).",
				Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
				Run:         t.runNeuralOSInstances,
			},
			Tool{
				Name:        "neuralos_query",
				Description: "Ask one neuralOS instance a question in plain language. The on-device needle model selects a read probe and the instance's own bridge executes it, returning a small validated JSON digest. Prefer this over raw shell commands when the question is about the instance's data.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"instance": map[string]any{"type": "string", "description": "The instance name exactly as listed by neuralos_instances."},
						"question": map[string]any{"type": "string", "description": "The question, phrased like the instance's canonical probe questions."},
					},
					"required": []string{"instance", "question"},
				},
				Run: t.runNeuralOSQuery,
			})
	}
	if len(t.skills) > 0 {
		tools = append(tools,
			Tool{
				Name:        "read_skill",
				Description: "Load a skill's SKILL.md instructions from the library by name. Do this before following a skill.",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"skill": map[string]any{"type": "string", "description": "The skill name exactly as listed in the system prompt."},
					},
					"required": []string{"skill"},
				},
				Run: t.runReadSkill,
			},
			Tool{
				Name:        "read_skill_file",
				Description: "Read a supporting file inside a skill's directory (references, scripts).",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"skill": map[string]any{"type": "string", "description": "The skill name exactly as listed in the system prompt."},
						"path":  map[string]any{"type": "string", "description": "Path relative to the skill's directory."},
					},
					"required": []string{"skill", "path"},
				},
				Run: t.runReadSkillFile,
			},
		)
	}
	return tools
}

// Skills returns the scanned library sorted by name, for the system prompt.
func (t *Toolset) Skills() []Skill {
	out := make([]Skill, 0, len(t.skills))
	for _, skill := range t.skills {
		out = append(out, skill)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// resolveSkill finds a scanned skill by name — only scanned names are
// servable, so a model cannot probe the filesystem with invented names.
func (t *Toolset) resolveSkill(name string) (Skill, error) {
	skill, ok := t.skills[strings.TrimSpace(name)]
	if !ok {
		return Skill{}, fmt.Errorf("no skill %q in the library (use a name from the system prompt)", name)
	}
	return skill, nil
}

func (t *Toolset) runReadSkill(_ context.Context, args map[string]any) (string, error) {
	skill, err := t.resolveSkill(argString(args, "skill"))
	if err != nil {
		return "", err
	}
	content, err := os.ReadFile(filepath.Join(skill.Dir, skillFile))
	if err != nil {
		return "", fmt.Errorf("read skill %q: %v", skill.Name, err)
	}
	return capString(string(content), skillOutputCap), nil
}

func (t *Toolset) runReadSkillFile(_ context.Context, args map[string]any) (string, error) {
	skill, err := t.resolveSkill(argString(args, "skill"))
	if err != nil {
		return "", err
	}
	// Same confinement rule as the workdir, applied to the skill's own
	// directory: the model may read inside the skill, nowhere else.
	target := filepath.Join(skill.Dir, filepath.Clean(strings.TrimSpace(argString(args, "path"))))
	if !withinRoot(skill.Dir, target) {
		return "", fmt.Errorf("path %q escapes the skill directory", argString(args, "path"))
	}
	content, err := os.ReadFile(target)
	if err != nil {
		return "", fmt.Errorf("read skill %q file %q: %v", skill.Name, argString(args, "path"), err)
	}
	return capString(string(content), skillOutputCap), nil
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
	// The windows-amd64 asset is published alongside the rest, and there is
	// no sh on Windows: cmd /c carries the same one-shot "run this line and
	// exit" semantics. Everywhere else the POSIX shell is the contract.
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(cmdCtx, "cmd", "/c", line)
	} else {
		cmd = exec.CommandContext(cmdCtx, "sh", "-c", line)
	}
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

// isNeuralOSProbeName mirrors the menu grammar: snake_case identifiers only,
// no dunders, no separators — the string reaches getattr in the bridge.
func isNeuralOSProbeName(name string) bool {
	if name == "" || len(name) > 64 || strings.HasPrefix(name, "__") {
		return false
	}
	for i, r := range name {
		ok := r == '_' || (r >= 'a' && r <= 'z') || (i > 0 && r >= '0' && r <= '9')
		if !ok {
			return false
		}
	}
	return true
}

func (t *Toolset) runNeuralOSInstances(_ context.Context, _ map[string]any) (string, error) {
	entries, err := os.ReadDir(t.neuralos.InstancesDir)
	if err != nil {
		return "", fmt.Errorf("neuralos_instances: %v", err)
	}
	var lines []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		menu, err := os.ReadFile(filepath.Join(t.neuralos.InstancesDir, entry.Name(), "needle_menu.json"))
		if err != nil {
			continue
		}
		var list []json.RawMessage
		_ = json.Unmarshal(menu, &list)
		lines = append(lines, fmt.Sprintf("%s\t%d probes", entry.Name(), len(list)))
	}
	if len(lines) == 0 {
		return "(no neuralOS instances installed)", nil
	}
	return strings.Join(lines, "\n"), nil
}

// needleSelection is the engine's call-selection output.
type needleSelection struct {
	FunctionCalls []struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function_calls"`
	Confidence float64 `json:"confidence"`
}

// neuralOSBridgeSnippet executes the selected probe through the instance's
// own bridge — the same contract the desktop integration uses: the needle
// engine only selects, the bridge executes and holds its credentials.
const neuralOSBridgeSnippet = `import json, sys
sys.path.insert(0, sys.argv[1])
import bridge
fn = getattr(bridge, sys.argv[2])
args = json.load(sys.stdin)
out = fn(**args)
print(json.dumps({"probe": sys.argv[2], "result": out}, ensure_ascii=False, default=str))
`

func (t *Toolset) runNeuralOSQuery(ctx context.Context, args map[string]any) (string, error) {
	instance := argString(args, "instance")
	question := argString(args, "question")
	if instance == "" || question == "" {
		return "", fmt.Errorf("neuralos_query: instance and question are required")
	}
	if strings.ContainsAny(instance, "/\\") || strings.Contains(instance, "..") {
		return "", fmt.Errorf("neuralos_query: invalid instance name %q", instance)
	}
	instanceDir := filepath.Join(t.neuralos.InstancesDir, instance)
	if _, err := os.Stat(filepath.Join(instanceDir, "needle_menu.json")); err != nil {
		return "", fmt.Errorf("neuralos_query: instance %q not found (run neuralos_instances first)", instance)
	}

	engine := t.neuralOS_Engine()
	cact := t.neuralOS_Cact(engine)
	python := t.neuralOS_Python()

	// Phase A — selection (on-device, deterministic).
	selCtx, selCancel := context.WithTimeout(ctx, toolsetCommandTimeout)
	defer selCancel()
	sel := exec.CommandContext(selCtx, engine,
		"--model", cact,
		"--tools", filepath.Join(instanceDir, "needle_menu.json"),
		"--prompt", question)
	// The deadline must bound the TOOL, not just the direct child: when the
	// ctx fires, WaitDelay closes the inherited pipes (and re-kills) so
	// grandchildren holding them cannot stall runNeuralOSQuery past its
	// deadline.
	sel.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	sel.Stderr = &stderr
	selOut, err := sel.Output()
	if err != nil {
		return "", fmt.Errorf("neuralos_query: engine selection failed: %v: %s", err, capString(stderr.String(), 400))
	}
	var selection needleSelection
	if err := json.Unmarshal(bytes.TrimSpace(selOut), &selection); err != nil {
		return "", fmt.Errorf("neuralos_query: engine output unparseable: %v", err)
	}
	if len(selection.FunctionCalls) == 0 {
		return fmt.Sprintf("no probe selected (confidence %.2f) — rephrase closer to the instance's canonical questions", selection.Confidence), nil
	}
	probe := selection.FunctionCalls[0].Name
	probeArgs := string(selection.FunctionCalls[0].Arguments)
	if !isNeuralOSProbeName(probe) {
		return "", fmt.Errorf("neuralos_query: engine selected invalid probe name %q", probe)
	}

	// Phase B — execution through the instance bridge.
	bridgeCtx, bridgeCancel := context.WithTimeout(ctx, toolsetCommandTimeout)
	defer bridgeCancel()
	bridge := exec.CommandContext(bridgeCtx, python, "-c", neuralOSBridgeSnippet, instanceDir, probe)
	bridge.Stdin = strings.NewReader(probeArgs)
	bridge.WaitDelay = 2 * time.Second
	bridge.Env = append(os.Environ(), "NEEDLE_TELEMETRY=0", "DO_NOT_TRACK=1", "PYTHONIOENCODING=utf-8")
	var berr bytes.Buffer
	bridge.Stderr = &berr
	bridgeOut, err := bridge.Output()
	if err != nil {
		return "", fmt.Errorf("neuralos_query: bridge execution failed for %s: %v: %s", probe, err, capString(berr.String(), 400))
	}
	return capString(string(bridgeOut), toolOutputCap), nil
}

func (t *Toolset) neuralOS_Engine() string {
	if t.neuralos.Engine != "" {
		return t.neuralos.Engine
	}
	// Windows binaries carry .exe; LookPath does not infer it for us.
	if runtime.GOOS == "windows" {
		if path, err := exec.LookPath("needle.exe"); err == nil {
			return path
		}
	}
	if path, err := exec.LookPath("needle"); err == nil {
		return path
	}
	return "needle"
}

func (t *Toolset) neuralOS_Cact(engine string) string {
	if t.neuralos.Cact != "" {
		return t.neuralos.Cact
	}
	if engine != "" {
		candidate := filepath.Join(filepath.Dir(engine), "needle3.cact")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "needle3.cact"
}

func (t *Toolset) neuralOS_Python() string {
	if t.neuralos.Python != "" {
		return t.neuralos.Python
	}
	return "python3"
}

// toolsetCommandTimeout bounds one shell command; Serve installs the
// configured value once at start-up, keeping the tool function signature free
// of configuration plumbing.
// toolsetCommandTimeout bounds one engine/bridge exec. On-device model
// inference (needle selection) needs ~20s of CPU and under load a child may
// only get half a core, so 60s produced spurious SIGKILLs ("signal: killed")
// exactly when the machine was busiest. 3 minutes keeps the bound honest.
var toolsetCommandTimeout = 3 * time.Minute

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
