# Development and Running

## Root Directory Commands

| Command | Purpose |
|---|---|
| `make dev` | Start desktop GUI development mode. |
| `make build` | Build the desktop GUI. |
| `make desktop-build-macos` | Ordinary macOS desktop packaging. |
| `make desktop-build-macos-release` | macOS Developer ID signing and notarization-related release packaging. |
| `make desktop-build-macos-intel` | Build for the Intel macOS target. |
| `make desktop-build-macos-m` | Build for the Apple Silicon macOS target. |
| `make desktop-build-windows` | Build for the Windows desktop target. |
| `make desktop-build-linux` | Build for the Linux desktop target. |
| `make dev-gateway` | Start the Go Gateway development service locally. |
| `make dev-webui` | Start the Gateway WebUI Vite development service locally. |
| `make dev-stack` | Start all three — Gateway, WebUI, and desktop ReactorPro — in the background with one command. |
| `make dev-stack-status` | Check the status of all three and MCP Bridge. |
| `make dev-stack-logs` | View recent logs from all three. |
| `make dev-stack-stop` | Stop processes managed by the three-end script. |
| `make check-fast` | Compile, lint, run basic tests, and check errors. |
| `make check-all` | Run fast, full tests, and Proto contract checks. |
| `make check-strict` | Run all, and treat Biome/Rust warnings as errors. |
| `make proto` | Generate Gateway proto. |
| `make webui` | Build Gateway WebUI static assets. |
| `make gateway-build` | proto + webui + Gateway build. |

## Package Management and Subprojects

| Subproject | Manifest | Description |
|---|---|---|
| Rust workspace | `Cargo.toml` | Root workspace containing Tauri/Rust crates. |
| Shared UI | `crates/agent-ui/package.json` | React application UI and domain logic shared by GUI/WebUI. |
| GUI frontend | `crates/agent-gui/package.json` | Desktop React/Tauri frontend dependencies and scripts. |
| Gateway | `crates/agent-gateway/go.mod` | Go Gateway dependencies. |
| Gateway WebUI | `crates/agent-gateway/web/package.json` | Browser WebUI dependencies and build scripts. |

## Common Check Commands

| Scenario | Command |
|---|---|
| GUI build | `pnpm -C crates/agent-gui build` |
| WebUI build | `pnpm -C crates/agent-gateway/web build` |
| Gateway tests | `cd crates/agent-gateway && go test ./...` |
| Gateway lint | `cd crates/agent-gateway && golangci-lint run ./...` |
| Proto check | `make proto-check` (buf lint + breaking check against origin/main) |
| Tauri/Rust tests | `cargo test --manifest-path crates/agent-gui/src-tauri/Cargo.toml` |
| Frontend targeted tests | `pnpm -C crates/agent-gui test:frontend` |
| diff whitespace check | `git diff --check` |
| Current changes | `git status --short` |

Toolchain versions are pinned by the root `mise.toml` (git-tracked), aligned with one command via `mise install`, and CI uses the same versions.

Actual script names may change with package.json; consult the current manifest before running.

## One-Command Three-End Startup

The cross-platform script `scripts/dev-stack.mjs` uniformly manages Gateway, Gateway WebUI, and desktop ReactorPro:

```bash
make dev-stack
make dev-stack-status
make dev-stack-logs
make dev-stack-stop
```

On macOS, Linux, and Windows you can also invoke it directly via pnpm:

```bash
pnpm dev:stack
pnpm dev:stack:status
pnpm dev:stack:logs
pnpm dev:stack:stop
```

The default ports are Gateway `50052`, WebUI `5173`, desktop frontend `1420`, and MCP Bridge `9223`; the default local Gateway token is `dev-token`. When the script encounters a port already occupied by an external process and healthy, it only reuses it and will not terminate that external process on stop. Process detection, HTTP health checks, logs, and state files are all implemented in Node; stopping managed processes on Windows invokes the system-provided `taskkill`, while macOS/Linux use process-group signals.

## Unified Compilation and Checks

The cross-platform main entry point is `scripts/check.mjs`; macOS, Linux, and Windows are recommended to invoke it via pnpm:

```bash
pnpm check:fast
pnpm check:all
pnpm check:strict
```

You can also run `make check-fast`, `make check-all`, and `make check-strict` in environments that provide Make.

| Level | Check Scope |
|---|---|
| `fast` | diff, script tests, Shared UI boundaries/typecheck, GUI/WebUI build, full lint diagnostics for all three, Rust check, golangci-lint, Go tests. |
| `all` | `fast` + auto-discovered GUI/WebUI/release tests, Rust all-target/doc tests, Proto lint/breaking. |
| `strict` | `all` + rustfmt, Clippy, full Biome diagnostics for all three, and Biome warnings in files changed relative to the baseline are treated as errors. |

All levels run the check-script unit tests, Shared UI boundaries, and standalone TypeScript typecheck; Biome uses `--max-diagnostics=none` and does not hide diagnostics beyond the default cap. `strict` still outputs full diagnostics for all three, but only upgrades to failure warnings newly added or modified relative to `LIVEAGENT_CHECK_BASE_REF` (which defaults to selecting `origin/main`, then `main`) in source code, avoiding masking historical diagnostics by turning rules off. GUI and WebUI test files are discovered recursively by `scripts/run-node-tests.mjs`, avoiding hand-written directory lists or reliance on shell globs.

Full text logs and structured JSON reports are written by default to `liveagent-check-<user>/<timestamp>-<profile>-<pid>/check.log` and `report.json` under the operating system temp directory. The JSON contains run metadata, summary counts, and each step's command, working directory, status, exit code, and elapsed time. Set `LIVEAGENT_CHECK_KEEP_GOING=1` to continue running other checks after a failure; set `LIVEAGENT_CHECK_REPORT_PATH` to pin the report location. It has currently been verified in a real run on macOS ARM64; Windows/Linux should still complete platform verification on the corresponding machine or CI.

## Runtime Paths

| Path | Description |
|---|---|
| `~/.liveagent/config.sqlite` | Desktop settings database. |
| `~/.liveagent/chat-history.sqlite3` | Chat history database. |
| `~/.liveagent/memory/` | Memory Markdown root directory and `memory-index.sqlite3`. |
| `~/.liveagent/skills` | Skills runtime root. |
| `~/.liveagent/default-project` | Default project directory on first install / when workdir is empty. |
| `~/.liveagent/debug/*.jsonl` | debug JSONL logs. |

## Gateway Development Concerns

| Item | Description |
|---|---|
| HTTP | `internal/server/http.go` registers the three `/ws/v2*` links, `/api/status`, `/api/files/import`, public share, and static assets. |
| Proto | After changing `proto/v2/*.proto`, run `make proto` (buf generates Go+TS), and commit generated artifacts in the same PR as the source; `make proto-check` guards against breaking changes. |
| Shutdown | `make dev-gateway` should support clean HTTP exit after Ctrl+C. |
| WebUI embed | Gateway build usually depends on `make webui` producing static assets first. |
| Adding desktop capabilities | Add an envelope arm in `proto/v2/gateway.proto` (numbers only increase, never change) → `make proto` → allowlist the v2 pass-through (`internal/protocol/pbws/guard.go`) → commit each side's generated artifacts in the same PR as the source; to add a gateway-local operation, add an arm in the v2 frame (`proto/v2/gateway_ws.proto`). |
| Deprecation conventions | Go `// Deprecated: <reason; replacement; removal condition>`, Rust `#[deprecated]`, TS `@deprecated`, proto `option deprecated`; deprecated code is kept in place and only bug-fixed, observed via usage instrumentation before removal. |

## Gateway Layering (Where New Code Goes)

| Code type | Location |
|---|---|
| Transport mechanism (write pump/backpressure/heartbeat, frame-format agnostic) | `internal/transport/wscore` |
| v2 protocol codec/handshake/pass-through/fan-out | `internal/protocol/pbws` |
| Cross-protocol domain logic (terminal gating, Origin validation, etc.) | `internal/protocol/shared` |
| chat command orchestration | `internal/chatcmd` |
| Session state and correlated routing (transport-agnostic) | `internal/session` |
| Logging facilities and protocol usage instrumentation | `internal/observability` |
| HTTP entry points and public share | `internal/server` |

## GUI/WebUI Shared UI Change Checklist

| Change type | Code location and check scope |
|---|---|
| Settings, Skills Hub, MCP Hub | Shared pages modify only `crates/agent-ui`; platform differences go in each host's `src/agent-ui-adapters/*` or the page extension registry, and must be verified on both ends. |
| Chat sidebar, composer, shared message visuals | Shared JSX/CSS modifies only `crates/agent-ui`; GUI/WebUI data controllers, streaming state, and virtual lists are still checked separately. |
| Upload, clipboard, directory selection | Shared interaction contracts live in `agent-ui`; Tauri/Gateway/browser implementations live in each host's adapters. |
| Provider settings | Shared Settings UI, both ends' provider adapters, Rust settings, Gateway redaction, and the model request layer. |
| Memory | Rust MemoryStore, shared Memory pages, both ends' `agent-ui-adapters/memoryOrganizer.ts`, Gateway memory.manage, and the MemoryManager tool. |
| Boundary checks | Run `pnpm check:ui-boundaries` to prevent public page duplicates from reappearing in app directories or the shared layer from directly depending on a specific host. |

## Documentation Task Boundaries

This documentation tree describes only the current architecture and does not require starting a dev server or running a build. If future documentation changes accompany code changes, the corresponding build/test should be added for the touched modules.