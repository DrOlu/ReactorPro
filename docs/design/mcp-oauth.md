# MCP OAuth Design and Implementation Baseline

| Metadata | Content |
|---|---|
| Status | In Progress / initial implementation baseline |
| Version | v0.1 |
| Date | 2026-08-24 |
| Owning plan | [2026 H2 Capability Roadmap](./2026h2-capability-roadmap.md) P1-③ |

## 1. Problem and Goals

remote MCP server (transport=http/sse) currently only supports static `headers` authentication, and cannot connect to hosted MCP servers that require OAuth 2.1 (Sentry, Linear, Notion, GitHub and other mainstream hosted connectors in 2026). Goal: implement the full authorization code flow — discovery, dynamic registration, PKCE, token refresh, keychain storage — per the MCP Authorization specification (2025-06-18 and subsequent revisions), so that a one-click Connect on the desktop is enough to connect.

## 2. Reality Corrections (deviations from roadmap assumptions, all verified against the code)

1. **No mcp.rs SDK**. The roadmap says "integrate `mcp.rs`'s HttpTransport/SseTransport"; the actual repository does not depend on an MCP SDK, and the transport is a blocking JSON-RPC custom-built inside `commands/integration/mcp.rs` (reqwest blocking + hand-written SSE parsing). The OAuth attachment point is that file's `HttpTransport`/`SseTransport`/`McpClient`.
2. **No oauth2 v5 crate**. The glue needed to adapt its pluggable HTTP trait to our reqwest 0.13 + `system_proxy` egress discipline exceeds the hand-written protocol itself (token exchange/refresh is just two form POSTs, PKCE is 40 lines); the repository already hand-writes the MCP/SSE protocol layers entirely. The only new dependency is `keyring` v3.
3. **The auth type does not introduce a `"headers"` enum value**. Static headers are already a separate `McpServerConfig.headers` field and continue to work; `auth` absent or `type:"none"` is the status quo, and only `type:"oauth"` enables this feature. This avoids a meaningless migration of existing data.
4. **Linux degrades to 0600 plaintext JSON rather than an "encrypted file"**. Without an OS keystore there is nowhere to put the encryption key (the key can only sit next to the token), so encryption is security theater; be honest about the degradation and state it clearly in docs/diagnostics.

## 3. Core Design

| Decision | Approach | Rationale |
|---|---|---|
| Authorization trigger | **Only triggered by an explicit user gesture** (MCP Hub card Connect / McpManager test guidance); a 401 inside the transport only does silent refresh + a marker error, and never pops up a browser | Concurrent tool calls mid-conversation would pop up N browser windows; authorization is a configuration-time action, not a runtime action |
| Discovery chain | 401 `WWW-Authenticate`'s `resource_metadata` (RFC 9728) → PRM `authorization_servers[0]` → RFC 8414 AS metadata (path-aware probing + OIDC fallback); when there is no `WWW-Authenticate`, derive the PRM well-known from the server URL, then fall back to the 2025-03-26 old spec (AS=server origin, defaulting to `/authorize` `/token` `/register` endpoints when metadata is missing) | Compatible with both old and new generations of hosted servers; old Cloudflare workers-type servers only have the default endpoints |
| Client | Configuration may carry a static `auth.clientId`; otherwise RFC 7591 dynamic registration (`token_endpoint_auth_method:"none"` public client), and the registration result is stored in the keychain alongside the token; after reuse, an authorization failure (invalid_client, timeout, etc.) only marks that client as suspicious (in-process), and the next authorization skips reuse and re-registers directly — existing tokens are retained, preventing one incomplete Reauthorize from destroying still-valid credentials | Hosted servers generally enable DCR; static client is for enterprise AS |
| Authorization flow | Authorization Code + **PKCE(S256) + state validation**; system browser (`tauri-plugin-opener`) + `127.0.0.1:random port` loopback callback (RFC 8252); both authorize/token requests carry the RFC 8707 `resource` parameter (normalized server URL) | The MCP spec mandates PKCE and resource binding; a random loopback port avoids conflicts |
| scope | `auth.scope` override > full PRM `scopes_supported` > omitted | Aligns with the MCP spec recommendation |
| Storage | `keyring` v3 (macOS Keychain / Windows Credential Manager / Linux secret-service); when keyring is unavailable (no secret-service, headless) degrade to `~/.liveagent/mcp-oauth-tokens.json` (plaintext; 0600 on Unix, Windows relies on the user directory's default ACL) | roadmap credential discipline; the degradation guarantees Linux usability |
| Storage key | service=`ReactorPro MCP OAuth`, account=server id; the blob contains `server_url`, and a mismatch with the current configured URL is treated as no token | Prevents a token from being cross-used on another server after the URL is redirected (audience confusion) |
| In-process cache | `mcp_oauth::store` holds a global `Mutex<HashMap<server_id, TokenRecord>>`, and keyring is read/written only on miss/authorization/refresh/clear | Keychain IPC has millisecond-level overhead and cannot be done once per request |
| Refresh | Proactive refresh in the `expires_at - 60s` window before a request; on 401 passively refresh once and retry (following the existing `SessionExpired404` single-retry skeleton); persist immediately when the refresh token is rotated | Seamless renewal; the retry skeleton has already been validated |
| Sync discipline | token/client_secret **never enter settings/SQLite** → Gateway settings sync and WebDAV backups naturally contain no credentials; config only adds `auth: { type, scope?, clientId? }` | roadmap's established tradeoff, zero redaction work |
| Remote limitation | The authorization flow can only be initiated on the desktop (the system browser opens on the desktop); the WebUI side only displays status (follow-up, see §8) | Explicit in the roadmap; the device-code flow is left for later |
| Egress discipline | All OAuth HTTP (probing/metadata/registration/token) goes through `system_proxy::blocking_client_builder()`, and proxy anomalies fail fast | Existing repository discipline: no silent direct connections |

## 4. Flow

### 4.1 Interactive Authorization (`mcp_oauth_authorize` command, executed serially within spawn_blocking)

```
Probe server URL (POST initialize, expect 401)
 ├─ WWW-Authenticate: Bearer resource_metadata="…"   → GET PRM (RFC 9728)
 ├─ no header → derive /.well-known/oauth-protected-resource{path} from the URL and probe
 └─ PRM unavailable → old spec fallback: issuer = server origin
GET AS metadata (RFC 8414 candidate sequence, see §4.3) → validate code_challenge_methods_supported ∋ S256
Decide client: auth.clientId > keychain existing registration > RFC 7591 dynamic registration
Bind 127.0.0.1:0 loopback listener (bind port first, then register/build redirect_uri)
Build authorization URL (code + PKCE S256 + state + resource + scope) → open system browser
Wait for callback (5-minute timeout, reject on state mismatch, one-shot) → authorization code
POST token_endpoint (code + code_verifier + redirect_uri + resource) → TokenRecord into keychain + cache
```

### 4.2 Runtime (inside transport, per request)

```
oauth enabled → store::ensure_bearer(id, url): cache/keyring read TokenRecord
 ├─ URL mismatch or no record → no Bearer (request sent bare; after 401 report the "authorization required" marker error)
 ├─ about to expire and has refresh_token → proactive refresh (on failure continue trying with the old token)
 └─ inject Authorization: Bearer
Response 401 (when oauth enabled) → McpTransportError::Unauthorized
 → McpClient passively refreshes once successfully → retry the original request
 → refresh infeasible/still 401 → error message carries a stable marker (frontend shows Connect guidance based on it)
```

SSE transport: the long-lived GET stream takes the current Bearer from the store on each reconnect (not frozen into the HeaderMap at spawn time); POST has the same semantics as the http transport.

### 4.3 AS Metadata Candidate Sequence (example with path-bearing issuer `https://as.example.com/tenant`)

1. `https://as.example.com/.well-known/oauth-authorization-server/tenant` (RFC 8414 path insertion)
2. `https://as.example.com/.well-known/openid-configuration/tenant` (OIDC path insertion)
3. `https://as.example.com/tenant/.well-known/openid-configuration` (OIDC path append)

When there is no path, try `/.well-known/oauth-authorization-server`, then `/.well-known/openid-configuration` in order. If all fail and we are on the old-spec fallback branch, use the default endpoints `{issuer}/authorize` `{issuer}/token` `{issuer}/register`.

## 5. Components and Files

**Rust (`crates/agent-gui/src-tauri`)**

- `src/services/mcp_oauth/mod.rs` (new) — public API: `authorize` / `status` / `clear` / `ensure_bearer` / `refresh_after_unauthorized`; authorization for the same server is mutually exclusive
- `src/services/mcp_oauth/discovery.rs` (new) — 401 probing, `WWW-Authenticate` parsing, PRM/AS metadata fetching and candidate sequence
- `src/services/mcp_oauth/register.rs` (new) — RFC 7591 dynamic registration
- `src/services/mcp_oauth/flow.rs` (new) — PKCE/state generation, loopback callback listener, authorize URL, code exchange, refresh
- `src/services/mcp_oauth/store.rs` (new) — TokenRecord, keyring read/write + file fallback + in-process cache
- `src/commands/integration/mcp.rs` — `McpServerConfig.auth` field; transport Bearer injection; `Unauthorized` error variant and refresh retry; `McpRuntimeTestResponse.auth_status` diagnostics
- `src/commands/integration/mcp_oauth.rs` (new) — `mcp_oauth_authorize` / `mcp_oauth_status` / `mcp_oauth_clear` commands
- `src/lib.rs` / `src/services/mod.rs` / `src/commands/integration/mod.rs` — registration
- `Cargo.toml` — `keyring = { version = "3", features = ["apple-native", "windows-native", "sync-secret-service"] }`, `getrandom`

**TS**

- `crates/agent-ui/src/lib/settings/types.ts` + `index.ts` — `McpAuthConfig` (`type/scope/clientId`), normalize
- `crates/agent-gui/src/shims/` or the existing invoke channel — bridging the three commands
- `crates/agent-ui/src/pages/mcp-hub/McpServerCard.tsx` / `McpServerEditModal.tsx` — authorization status badge for http/sse servers + Connect/Reauthorize/Disconnect; edit modal auth options
- The server deletion path calls `mcp_oauth_clear`; add i18n keys on both ends

## 6. Security Points

- loopback binds only `127.0.0.1`, one-shot, 5-minute timeout; `state` constant-time comparison validation; the callback page is pure static success/failure HTML
- The browser only opens authorization URLs with `https:` or loopback `http` (`127.0.0.1`/`localhost`, RFC 8252 §7.3) (blocking injection surfaces such as `javascript:`)
- token/client_secret are never logged, never enter settings/DB/sync/backup; diagnostic output is only status and expiry time
- Bearer is only sent to the server URL in the config (TokenRecord.server_url consistency check, preventing audience confusion)
- The `resource` parameter (RFC 8707) binds the token audience

## 7. Acceptance (roadmap P1-③ excerpt → landing points)

- [ ] Connect at least 2 real hosted MCP servers → manual acceptance script (candidates: Cloudflare demo, Linear, Notion MCP)
- [ ] Token expiry auto-refresh is seamless → active + passive refresh path unit tests & long-session manual test
- [ ] Uninstalling a server cleans up the keychain entry → deletion path hooks `mcp_oauth_clear`
- [ ] No re-authorization needed after restart → keychain persistence + ensure_bearer on first request after startup manual test

## 8. Known Boundaries (initial version)

1. **WebUI parity to be added later**: authorization can only be completed on the desktop anyway; the WebUI-side "authorization required" status display + guidance (gateway event/proto fields) is a separate change immediately following, with `check-ui-boundaries.mjs` as a gate.
2. **device-code flow not done** (per the roadmap).
3. **SSE GET stream does not proactively re-authorize on 401**: the GET stream takes the latest token on reconnect; invalidation mid-stream relies on the next POST's 401 to trigger a refresh.
4. **On Linux without secret-service it is a 0600 plaintext file** (the honest degradation in §2-4); diagnostic output will mark `storage: file`.
5. **Multiple desktop instances for the same server**: keyring is machine-level shared, and mutually overwriting tokens is harmless (all valid); authorization mutual exclusion is only in-process.

## 9. Testing

- `WWW-Authenticate` parsing, PRM/AS metadata candidate sequence derivation, resource normalization — pure function unit tests
- TokenRecord file fallback roundtrip, URL-mismatch invalidation, expiry window determination — store unit tests
- PKCE verifier/challenge, state, authorize URL assembly — flow unit tests
- 401 → refresh → retry / refresh infeasible → marker error — McpClient-layer unit tests (mock transport)
- Integration: local mock AS + mock MCP server runs the full flow (authorization code flow + refresh + revocation), in CI; real hosted servers are manual acceptance