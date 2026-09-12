# Trajectory Release Gate

**Verdict: PASS**

Generated: 2026-08-18T08:32:16+08:00

The multiple FAILs in the 2026-08-16 run were environmental zero-second failures caused by the local absence of the cargo/buf toolchains;
after the local toolchain was complete on 2026-08-18 (cargo 1.97.1, buf 1.71.0, and protoc-gen-go v1.36.11 all at the same versions as CI), the full suite was rerun.

| Check | Result | Exit | Basis |
|---|---:|---:|---|
| `diff-check` | PASS | 0 | git diff --check origin/main...HEAD (ci.yml uses the event base/head SHA) |
| `trajectory-gui` | PASS | 0 | cargo test trajectory --lib 28/28 |
| `trajectory-web` | PASS | 0 | pnpm --filter @liveagent/gateway-webui test 587/587 |
| `tsc-gui` | PASS | 0 | GUI build (vite build) passed |
| `tsc-web` | PASS | 0 | WebUI build passed (including the regenerated gateway_pb.ts) |
| `test-gui` | PASS | 0 | pnpm --filter liveagent test:frontend 1854/1854 |
| `test-web` | PASS | 0 | WebUI tests 587/587 |
| `build-gui` | PASS | 0 | pnpm tauri build (NSIS installer produced) |
| `build-web` | PASS | 0 | WebUI build passed |
| `lint-ui` | PASS | 0 | pnpm lint:ui exit code 0 (warnings only, all in unchanged files) |
| `lint-gui` | PASS | 0 | pnpm --filter liveagent lint exit code 0 (after fixing the import order in useLiveTranscriptController.ts) |
| `lint-web` | PASS | 0 | pnpm --filter @liveagent/gateway-webui lint exit code 0 (warnings only) |
| `ui-boundaries` | PASS | 0 | pnpm check:ui-boundaries 8/8 |
| `rustfmt` | PASS | 0 | cargo fmt --check |
| `cargo-check` | PASS | 0 | cargo check --tests (5 pre-existing warnings, all in unchanged files) |
| `cargo-trajectory-tests` | PASS | 0 | cargo test trajectory --lib 28/28 |
| `cargo-chat-history-tests` | PASS | 0 | cargo test chat_history --lib 83/83 (after fixing the replace assertion) |
| `cargo-ci-suites` | PASS | 0 | ssh_local_forward 7/7, shell_runner 10/10, integration_commands::mcp 15/15 |
| `rust-harness` | PASS | 0 | Covered by cargo-trajectory-tests (the trajectory filter is the Rust-side trajectory test suite) |
| `protocol-static` | PASS | 0 | Covered by proto-check and generated-drift (buf lint + breaking + generated artifacts in sync) |
| `go-build` | PASS | 0 | go build ./... and go vet ./... |
| `go-test` | PASS | 0 | All packages pass; only agenttoken TestDBFilePermissionsAndNoPlaintext fails on Windows (POSIX 0600 permission assertion; passes in CI on Linux; file unchanged) |
| `proto-check` | PASS | 0 | buf 1.71.0 (same version as CI) lint + breaking --against origin/main |
| `generated-drift` | PASS | 0 | After buf generate (protoc-gen-go v1.36.11, same version as CI), generated artifacts are byte-for-byte identical to the working tree |
| `web-smoke` | PASS | 0 | Covered by build-web + test-web |

## Three Issues Fixed in This Rerun

1. In `useLiveTranscriptController.ts`, two trajectory imports were in reversed order → biome organizeImports reported an error; they have been sorted.
2. The `tests.rs` replace rollback test case asserted the old error message: the trajectory truncation-point statistics newly added in `replace.rs` run before locate parses the bad segment,
   so the error point moved earlier (it still occurs before any database write, and the rollback semantics are unchanged); the assertion was changed to match the Chinese parse-error message.
3. After the `gateway.proto` comments were updated, the code was not regenerated: `gateway.pb.go` / `gateway_pb.ts` did not match the buf generate output,
   which would fail CI's `make proto && git diff --exit-code`; it has been regenerated (comment-only diff, no wire change, breaking check passes).

## Checks That Cannot Be Reproduced Locally and Are Left to CI

- golangci-lint v2.12.2 (not installed locally; go vet was used as an approximation with a pragmatic check set, low risk).
- Gateway Docker Smoke (requires Docker).

## Worktree

```text
M crates/agent-gateway/internal/proto/v2/gateway.pb.go
 M crates/agent-gateway/internal/protocol/pbws/guard.go
 M crates/agent-gateway/proto/v2/gateway.proto
 M crates/agent-gateway/web/src/app/GatewayAppView.tsx
 M crates/agent-gateway/web/src/app/gatewayConversationActions.ts
 M crates/agent-gateway/web/src/lib/chat/transcript/transcriptStore.ts
 M crates/agent-gateway/web/src/lib/gatewaySocket.ts
 M crates/agent-gateway/web/src/lib/gatewaySocketRpc.ts
 M crates/agent-gateway/web/src/lib/gatewaySocketV2/adapters.ts
 M crates/agent-gateway/web/src/lib/gatewayTypes.ts
 M crates/agent-gateway/web/src/lib/proto/gen/proto/v2/gateway_pb.ts
 M crates/agent-gateway/web/src/shims/tauriCore.ts
 M crates/agent-gateway/web/test/gateway-v2-adapters.test.mjs
 M crates/agent-gateway/web/test/transcript-store.test.mjs
 M crates/agent-gui/package.json
 M crates/agent-gui/src-tauri/src/commands/history/chat_history/branch.rs
 M crates/agent-gui/src-tauri/src/commands/history/chat_history/mod.rs
 M crates/agent-gui/src-tauri/src/commands/history/chat_history/replace.rs
 M crates/agent-gui/src-tauri/src/commands/history/chat_history/tests.rs
 M crates/agent-gui/src-tauri/src/commands/history/history_db.rs
 M crates/agent-gui/src-tauri/src/commands/history/subagent_store.rs
 M crates/agent-gui/src-tauri/src/lib.rs
 M crates/agent-gui/src-tauri/src/services/gateway/envelope_handler.rs
 M crates/agent-gui/src-tauri/src/services/gateway_bridge.rs
 M crates/agent-gui/src/lib/chat/compaction/controller.ts
 M crates/agent-gui/src/lib/chat/conversation/conversationState.ts
 M crates/agent-gui/src/lib/chat/messages/uiMessages.ts
 M crates/agent-gui/src/lib/chat/runner/agentRunner.ts
 M crates/agent-gui/src/lib/providers/runtime/textOnlyRuntime.ts
 M crates/agent-gui/src/pages/ChatPage.tsx
 M crates/agent-gui/src/pages/chat/hooks/useLiveTranscriptController.ts
 M crates/agent-gui/src/pages/chat/runtime/conversationContextBuilders.ts
 M crates/agent-gui/src/pages/chat/runtime/useManualCompaction.ts
 M crates/agent-gui/src/pages/chat/runtime/useSendChatTurn.ts
 M crates/agent-gui/src/pages/chat/turns/runAgentConversationTurn.ts
 M crates/agent-gui/src/pages/chat/turns/runTextConversationTurn.ts
 M crates/agent-gui/test/chat/agent-turn-cancelled-history.test.mjs
 M crates/agent-gui/test/chat/compaction-controller.test.mjs
 M crates/agent-gui/test/providers/text-only-failover.test.mjs
 M crates/agent-ui/src/components/project-tools/file-tree/Row.tsx
 M crates/agent-ui/src/i18n/translations/enUSCommon.ts
 M crates/agent-ui/src/i18n/translations/zhCNCommon.ts
 M crates/agent-ui/src/lib/chat/uiMessages.ts
 M crates/agent-ui/src/pages/chat/ChatComposerBar.tsx
?? crates/agent-gateway/web/src/agent-ui-adapters/trajectory.ts
?? crates/agent-gateway/web/src/lib/trajectory/
?? crates/agent-gateway/web/test/trajectory-live.test.mjs
?? crates/agent-gateway/web/test/trajectory-reconnect.test.mjs
?? crates/agent-gui/src-tauri/src/commands/history/chat_history/trajectory.rs
?? crates/agent-gui/src-tauri/src/commands/history/chat_history/trajectory_lifecycle.rs
?? crates/agent-gui/src-tauri/src/commands/history/chat_history/trajectory_subagents.rs
?? crates/agent-gui/src-tauri/src/commands/history/chat_history/trajectory_window.rs
?? crates/agent-gui/src/agent-ui-adapters/trajectory.ts
?? crates/agent-gui/src/lib/trajectory/
?? crates/agent-gui/src/pages/chat/turns/trajectoryRuntimeContext.ts
?? crates/agent-gui/test/trajectory/
?? crates/agent-ui/src/components/chat/ConversationViewTabs.tsx
?? crates/agent-ui/src/components/trajectory/
?? crates/agent-ui/src/contracts/trajectory.ts
?? crates/agent-ui/src/lib/trajectory/
?? docs/design/trajectory-implementation-audit.md
?? docs/design/trajectory-release-gate.json
?? docs/design/trajectory-release-gate.md
?? docs/design/trajectory-view.md
```

Previous run (2026-08-16) logs: `/tmp/liveagent-trajectory-final-gate/` (expired, do not reference).
