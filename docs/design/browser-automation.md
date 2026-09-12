# Browser Automation: Native `Browser` Tool (Phase B)

| Metadata | Content |
|---|---|
| Status | In Progress |
| Version | v0.1 |
| Date | 2026-08-25 |
| Upstream | `docs/design/2026h2-capability-roadmap.md` section 4 |

> This document implements Phase B of point 4 in the roadmap: a native `Browser` tool that connects to CDP directly from Rust. Phase A (Playwright-MCP recommended-preset card) is submitted separately as an independent small change.

## 0. Dual Mode: Extension Bridge (Reusing the User's Browser) and Standalone Launch

Following the shape of Claude Code in Chrome, the Browser tool supports two access modes, controlled by the setting `settings.system.browserAutomationMode` (selected inline on the settings page under "System Tools → Browser Automation"):

| Setting value | Semantics |
|---|---|
| `auto` (default) | Extension connected → extension mode; otherwise fall back to launcher |
| `userProfile` | extension mode only; when the extension is not connected, **report an error along with installation guidance** and never silently downgrade (when the user explicitly wants a logged-in session, downgrading to a browser without login state would cause the misjudgment that "it looks like it's operating my account but actually isn't") |
| `isolated` | launcher mode only; never touch the user's browser even if the extension is online |

The mode value uses the persisted setting as the sole authority: the `browser_action` command layer performs a server-side lookup via `load_runtime_browser_automation_mode()` (same paradigm as `load_runtime_command_safety_mode`, not trusting the renderer process / gateway passthrough), and changing the setting takes effect on the next action; when an existing session conflicts with the new mode (e.g. an extension session still alive under isolated), it is automatically torn down and rebuilt. Normalization of unknown values on both the TS and Rust sides always falls back to `auto` (a behavioral choice rather than a security constraint, so fail-closed is unnecessary).

| Mode | Carrier | Login state | Process |
|---|---|---|---|
| **extension** | User's everyday browser + ReactorPro browser extension (`crates/agent-gui/browser-extension/`, MV3) | **Reuses the user's login state** | No new process; opens a new automation tab |
| **launcher** | `--remote-debugging-port` + a new browser instance launched with an isolated profile | Isolated, no login state | ReactorPro child process, reclaimed when the app exits |

How it works:

- On the Rust side, `bridge.rs` starts a WebSocket service on `127.0.0.1:19222` (overridable via `LIVEAGENT_BROWSER_BRIDGE_PORT`), and the extension service worker connects back (handshake validates `Origin: chrome-extension://`); after a disconnect, the extension's alarm periodically reconnects.
- The extension relays CDP using `chrome.debugger`: browser-level `Target.getTargets / createTarget / attachToTarget / closeTarget` are emulated by the extension (**registering and exposing only the tabs it created itself**; the user's other tabs are invisible to the desktop side); session-level commands are forwarded to `chrome.debugger.sendCommand` according to a sessionId→tabId mapping, and `chrome.debugger.onEvent` is forwarded back as event frames. The wire format is identical to native CDP, so `CdpConnection`/`PageSession` are reused with zero changes.
- When `BrowserManager` starts a session, it first checks whether the bridge has a live extension connection: if so, it opens a new tab via `Target.createTarget` and attaches (extension mode); otherwise it falls back to launcher. In extension mode, `browser_close` closes the automation tab (`Target.closeTarget`); in launcher mode it kills the process tree.
- Boundaries of extension mode: Chrome displays a "being debugged" banner at the top of the debugged tab; if the user clicks "Cancel" the debugger detaches (`onDetach`), and the desktop side detects this via target liveness probing and rebuilds on demand; a malicious local process can forge the Origin header to connect to the bridge, but the capabilities it can obtain are limited to "opening a new tab in the user's browser and driving it", which beyond the attack surface equivalent to the user manually opening a tab mainly adds reading that tab's content—a token handshake can be added later to tighten this.
- Extension installation guidance: browsers do not allow external programs to silently install extensions (except under enterprise policy), so the most that can be automated is providing the directory + steps. The extension's installation directory is fixed at `~/.liveagent/extension`—Chrome records an absolute path when loading an unpacked extension, and pointing at bundle resources would become invalid as the app updates (the installation directory is wholly replaced); on every startup the app syncs the built-in extension resources (packaged artifacts brought out via tauri.conf.json `bundle.resources`; in dev, a copy of the resources under target, with the repository source directory as fallback) as a whole directory to that stable path. `browser_extension_install_info` returns the extension connection state and that directory (re-syncing on demand to self-heal when the directory is missing); `browser_extension_reveal_dir` opens that directory in the file manager. The settings page shows an inline mode selector under the browser row + a connection status badge (5s polling); when not connected and the mode requires the extension, it expands a guidance card (chrome://extensions → Developer mode → Load unpacked). When the command is unavailable on the WebUI side (the shim throws), the guidance area is hidden and only the mode selector remains (synced to the desktop side via settings sync and taking effect there).

## 1. Goals

- A single `Browser` tool + `action` parameter (navigate / snapshot / click / type / screenshot / eval / wait / back), following the repository's manager style (cf. `McpManager`), to reduce the number of schemas.
- Launch the user's already-installed Chrome/Edge with `--remote-debugging-port` + an isolated profile (`~/.liveagent/browser-profile`), isolated from the everyday profile to prevent credential exposure.
- `snapshot` outputs the a11y tree + ref ids (aria-snapshot style), prioritizing token efficiency; `screenshot` goes through the existing image content block rendering pipeline.
- Security: the new `group:browser` defaults to `ask`; under `sandboxOffline` the tool is not injected and the executor fails closed.

## 2. Rust Side: `services/browser/`

Module structure (modeled on the multi-file service of `services/code_index/` + the WS session pattern of `services/stt/`):

```
services/browser/
  mod.rs        # BrowserManager: singleton browser session (extension/launcher dual mode), Arc-managed, registered in lib.rs run()
  bridge.rs     # Extension bridge WS service: accepts extension connections back, validates Origin, holds the latest connection
  launcher.rs   # Chrome/Edge executable discovery + isolated profile launch + DevTools port resolution (fallback mode)
  cdp.rs        # CDP WebSocket client (tokio-tungstenite), request/response id pairing + event dispatch; two entry points: connect dialing and from_stream wrapping an accepted connection
  page.rs       # High-level operations: navigate/click/type/screenshot/eval/wait/back; attach (first existing target) and attach_new_tab (open a new tab in extension mode)
  snapshot.rs   # Accessibility.getFullAXTree → condensed aria tree text + ref id mapping
  types.rs      # serde parameter/response types
```

### 2.1 Browser Discovery and Launch (launcher.rs)

- Probe for Chrome → Edge → Chromium via fixed candidate paths per platform (macOS `/Applications/...`, Windows `Program Files`, Linux `which`); Firefox is not supported (a roadmap item pending decision; Chromium-based browsers are bound first).
- Launch arguments: `--remote-debugging-port=0` (random port to avoid conflicts), `--user-data-dir=~/.liveagent/browser-profile`, `--no-first-run`, `--no-default-browser-check`, `--disable-sync`, `--new-window about:blank`.
- Port acquisition: prefer reading the `DevToolsActivePort` file written by Chrome under the profile (polling ≤10s); on success, `GET http://127.0.0.1:<port>/json/version` to obtain `webSocketDebuggerUrl`.
- Process lifecycle: `std::process::Command` + `configure_child_process_group` (same as MCP stdio); `BrowserManager::shutdown` and the app `ExitRequested` cleanup block call kill-tree (the existing helper in `runtime/process.rs`).

### 2.2 CDP Client (cdp.rs)

- `tokio-tungstenite` connects to the browser-level WS; `Target.getTargets`/`Target.attachToTarget` (flatten mode) obtains a page session.
- A command = JSON with a self-incrementing id, with responses paired via a `oneshot` channel; events (e.g. `Page.loadEventFired`) are broadcast to waiters.
- Everything runs on `tauri::async_runtime::spawn`, exposing async methods externally; errors uniformly use `Result<T, String>` (repository convention; no anyhow/tracing introduced).

### 2.3 Action Mapping

| action | CDP |
|---|---|
| navigate | scheme validation (http/https only) → `Page.navigate`, poll `Page.getFrameTree` by the `loaderId` in the response until that loader commits and readyState is ready (same-document navigation has no loaderId, so it completes immediately), returning the landed URL + title + condensed snapshot |
| snapshot | `Accessibility.getFullAXTree` → filter out ignored/generic empty nodes → indented text `- role "name" [ref=eN]`; ref→backendDOMNodeId stored in a session mapping; name has newlines flattened and quotes escaped (untrusted page text must not be able to forge snapshot line structure) |
| click | ref → `DOM.scrollIntoViewIfNeeded`/`DOM.getBoxModel` to get the center coordinates → `Input.dispatchMouseEvent` press+release |
| type | click to focus, then select all, `Input.insertText` (empty text = clear the field); when `submit: true`, add Enter (keyDown with `text:"\r"` to produce keypress semantics, otherwise the form will not implicitly submit) |
| screenshot | `Page.captureScreenshot`(jpeg q80) → base64 image content block |
| eval | `Runtime.evaluate` (returnByValue + awaitPromise); any `exceptionDetails` is an error (including thrown primitive values); result JSON truncated to ≤8k characters |
| wait | wait for a selector to appear (`Runtime.evaluate` polling `document.querySelector`) or a plain delay |
| back | `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`; the load event serves only as a ≤3s fast-path signal, with readyState polling as the fallback |

After a successful navigate/click/type/back/wait, a new snapshot is automatically attached (can be disabled with `includeSnapshot: false`) so the model has page state at every step; failure of the attached snapshot does not implicate the successfully executed action (the error is downgraded to a result note, preventing the model from misjudging failure and repeating side effects). The snapshot budget is measured in UTF-8 bytes (28k bytes ≈ 7k tokens; bytes/token is approximately constant across writing systems, so CJK pages do not exceed the acceptance line).

### 2.4 Command Layer

`commands/integration/browser.rs`: `browser_action(args) -> Result<BrowserActionResponse, String>` is a single command carrying all actions (dispatched on the Rust side), plus `browser_status` / `browser_close`. Registered into `app_invoke_handler!`.

**Current limitations (follow-up iterations)**: actions cannot be cancelled during execution (the TS side only checks AbortSignal before initiating, and does not hook into the `runtime_cancel` run-id chain), and `BrowserManager` holds a single lock across an entire action—an action in progress makes `browser_status`/`browser_close` queue up and wait (up to one action timeout of 120s). When hooking into the cancellation chain, lifecycle management and action execution should be split onto separate locks at the same time.

### 2.5 Session Lifecycle and Failure Recovery

- The browser process is reclaimed by the app `ExitRequested` cleanup block; `shutdown_cleanup` first `try_lock`s to take out the session and trigger kill-tree, and when the lock cannot be acquired (an action is running at the moment of exit) it falls back to `signal_process_tree_by_pid` directly using the pid recorded on the side path, avoiding a leftover instance locking up the profile.
- An invalid session is automatically rebuilt, covering both failure types: WS disconnect (the user quit the browser entirely); WS not disconnected but the page target disappears (the user closed only the automation window/tab, or the tab crashed)—target liveness is probed before every action via the browser-level `Target.getTargets`.

## 3. TS Side

- `agent-ui/src/contracts/builtinTools.ts`: add `"browser"` to `BuiltinToolGroupId`; add `BrowserResultDetails` to the details union.
- `agent-gui/src/lib/tools/browserTools.ts`: the `createBrowserTools({ sandbox })` bundle, a typebox schema (action union + optional parameters url/ref/text/selector/timeoutMs/snapshot, etc.), with the executor calling `invoke("browser_action")`; when `sandbox.enabled && !allowNetwork` (i.e. sandboxOffline), the executor rejects outright (belt and suspenders).
- `builtinRegistry.ts`: conditional registration—under sandboxOffline the whole bundle is not injected (invisible to the model).
- `toolPolicy.ts`: in the resolver, `group:browser` defaults to `ask` when not explicitly configured (the existing fall-through is allow, so a dedicated branch is needed); the default is also declared in the `defaultPolicy` field of `builtinToolCatalog`—the settings page uses this to display the real default, and when the user explicitly selects `allow` an explicit key is written (rather than deleting the key to fall back to ask), keeping the two in sync.
- `toolExecutionPrompt.ts`: a `has("Browser")` usage-guidance section + Available Tools entry.
- `builtinToolCatalog.ts` + i18n (en/zh): policy configurable on the settings page.
- Screenshot rendering: a `{type:"image", data, mimeType}` content block, with the existing desktop/WebUI pipeline unchanged; proto needs no changes (tool event JSON passes through directly). Non-screenshot results are rendered by the `kind === "browser"` branch of `ToolResultDisplay` (MetaTags overview + body/snapshot), and errors and status-line summaries go through the Browser branch of the shared `summarizeToolCall`.

## 4. Security Model

1. `group:browser` defaults to `ask`—every Browser call produces an approval card (the user can approve_session).
2. `sandboxOffline`: skipped at registration time + executor fails closed and rejects; the offline semantics cover browser network access.
3. The login-state boundary is layered by mode: launcher mode uses an isolated profile and does not read the user's everyday browser login state/Cookies; extension mode deliberately reuses login state (that is precisely the value of this mode), but the visible/controllable scope is strictly limited to the tabs the automation created itself, and the system prompt requires the model to treat operations on logged-in pages as "acting on the user's behalf" and to be conservative about submit/publish/purchase/delete-type actions.
4. navigate only allows http/https: `file://` would bypass the app's file permission model to read arbitrary local files, and privileged pages such as `chrome://` are the same; the Rust side rejects them uniformly (a URL allowlist remains a reserved item for later).
5. The approval summary precisely displays the corresponding parameters per action (`summarizeToolCallForApproval` special-case): navigate shows the URL, click shows the ref, type fully displays the input text (including +Enter), eval fully displays the expression—one must not take "the first non-empty field", otherwise the model could use an irrelevant field (e.g. a url attached to eval) to overshadow the actual content being executed.
6. Page text in the a11y snapshot (name/valuetext) has newlines flattened and quotes escaped, preventing an untrusted page from forging snapshot tree lines (e.g. injecting a fake `[ref=..]` line).

## 5. Acceptance (Aligned with the Roadmap)

- [x] The "open the docs site → search → extract content → screenshot as evidence" loop (manual e2e: `cargo test -p liveagent browser_e2e -- --ignored --nocapture`, actually tested on the tauri.app homepage; screenshot at `docs/images/browser-automation-e2e-tauri-app.jpg`)
- [x] a11y snapshot under 8k tokens for a single page (measured 13194 characters ≈ 3.3k tokens on the tauri.app homepage)
- [x] Isolated profile cannot read the user's everyday browser login state (`~/.liveagent/browser-profile` isolated user-data-dir)
- [x] Approval/sandbox policy takes effect (`group:browser` defaults to ask; under sandboxOffline the bundle is not registered + the executor fails closed)

## 6. Non-Goals (Not Done This Time)

- Phase A preset card (separate submission); Right Dock Browser panel (a later UI iteration); URL allowlist (a reserved policy slot; the scheme-level http/https restriction is already built in); Firefox support; multi-tab management (single-page session; navigate reuses the same target); mid-action cancellation and splitting the lifecycle/execution locks (see the current limitations in 2.4); cross-snapshot ref generation validation (refs are renumbered on every snapshot, and the model side is constrained by the hint "after the page changes you must use a new snapshot").