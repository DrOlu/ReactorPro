# NATS Event Mesh and Synapse Mesh Bridge

ReactorPro can join the fleet's NATS event mesh and act as a full-duplex Synapse agent,
speaking the same protocol as [RTerm](https://github.com/DrOlu/RTerm)'s
`plugins/synapse-bridge/`.

**Status: wired, exposed, and enforcing inbound trust.** The bridge runs inside the
gateway (`cmd/gateway/main.go`), is configurable from flags and environment
(`internal/config/config.go`), is driven from the HTTP API (`internal/handler/mesh.go`,
`internal/server/http.go`), and is visible in Settings → Mesh. With the shipping default
the mesh is **disabled** and nothing connects anywhere.

## What is here

| File | Purpose |
|---|---|
| `envelope.go` | Envelope, manifest, message types, subjects, spec-aligned error codes |
| `identity.go` | Immutable Ed25519 identity, signing payload, signature verification |
| `trust.go` | Peer fingerprint pinning (trust-on-first-use and configured pins) |
| `verify.go` | The inbound guard: size, version, addressee, clock skew, replay, signature, trust |
| `ratelimit.go` | Per-sender token bucket with a bounded, fail-closed population |
| `synapse.go` | The agent: register, discover, dispatch, serve, emit, subscribe |
| `reputation.go` | EXT-REPUTATION scoring |
| `governance.go` | EXT-GOVERNANCE approvals |
| `manager.go` | Lifecycle, configuration, the tool surface, status snapshot |
| `mesh_test.go`, `verify_test.go` | Unit coverage of the protocol and the inbound policy |
| `integration_test.go` | End-to-end tests against a private `nats-server` process |

## Inbound trust

Every inbound message — requests *and* events *and* discovery replies — passes through one
`inboundGuard` (`verify.go`), so no call path can skip a check. In order:

1. **Size.** Envelopes over `MaxEnvelopeBytes` (default 1 MiB) are dropped without a reply:
   an unparsed message has no verified sender to answer.
2. **Rate limit.** Per-sender token bucket. The tracked population is capped and the
   limiter **fails closed** once the cap is reached, so a flood of distinct sender ids
   cannot both exhaust memory and keep being served.
3. **Protocol version — advisory, not enforced.** An unrecognised version is logged once
   per distinct value and accepted. Strict equality against `ProtocolVersion` is wrong for
   a live mesh: peers in the wild declare `1.0` while this agent declares `0.3.0`, and
   refusing them silently emptied discovery. The envelope is the contract, and it is
   validated field by field. Set `-mesh-accepted-versions` on a closed fleet to enforce a
   set, where an unexpected value really is a fault.
4. **Addressee.** `To` must be empty (broadcast — events carry none), `SubjectRegistry`
   (register/discover), or this agent. This check exists because register and discover
   envelopes are addressed to the registry rather than to a named agent.
5. **Clock skew.** The envelope timestamp must be within `ClockSkew` (default 5m) of local
   time. This is the backstop that bounds how long a captured message stays replayable.
6. **Replay.** Envelope ids are remembered for twice the skew window.
7. **Signature and identity.** See below.

### What a signature actually proves

A valid signature on its own proves only that the sender holds the private key for the
public key carried **in the same envelope**. Anyone can mint a keypair and sign an envelope
claiming to be a different agent — the signature is valid, and it is valid for the
attacker's key. Two things close that hole, and both are load-bearing:

- The envelope carries a **fingerprint** (`fp`) covering the agent id and the public key,
  and `VerifyEnvelope` rejects an envelope whose stated fingerprint is not the one its key
  proves. The fingerprint is covered by the signature, so it cannot be swapped in transit.
- The **trust store** remembers which fingerprint each agent id presented first and refuses
  a different one afterwards. That is what detects impersonation and key substitution.

Verification modes (`-mesh-verify-mode`):

| Mode | Signed | Unsigned | Use |
|---|---|---|---|
| `off` | accepted, signature not consulted | accepted | Only when another layer provides trust |
| `prefer` **(default)** | verified, must be valid | accepted | Transitional: closes tampering for peers that sign without locking out peers that cannot |
| `require` | verified, must be valid | refused `3004` | Closed fleets where every peer holds an identity |

`prefer` is the default because RTerm's bridge does not sign at all. Note the consequence
for `require`: an *unsigned registry* reply is refused, so discovery needs signed peers.

Trust is seeded from `-mesh-trusted-peers` (fingerprints) and, with
`-mesh-trust-on-first-use` (default on), learned on first verified contact.

### What the signature covers

`SigningPayload` field-joins `v, id, type, ts, from, to, task_id, in_reply_to, fingerprint`,
the trace and error fields, and a digest of the payload. Each part is length-prefixed so a
field containing a newline cannot be re-split to collide with a different layout. Leaving
the error object out would let an attacker turn a denial into an apparent success; leaving
the fingerprint out would make the identity binding forgeable.

## Agent identity

The identity is an Ed25519 keypair whose fingerprint covers **both the agent id and the
public key**:

- Editing the id in the identity file invalidates the fingerprint and the file refuses to
  load (`ErrIdentityTampered`).
- Pointing the config at a different id than the file contains fails with "cannot be
  reassigned".
- Every outbound envelope is signed (`sig` + `pub` + `fp`), and the manifest advertises the
  fingerprint so a peer can pin this agent before it ever hears from it.

The private key is written `0600`, minted once on first start, and never leaves the host.

## Error codes

Aligned with the Synapse protocol table, because a peer branches on these values:
`2001 INVALID_ENVELOPE`, `2002 INVALID_MANIFEST`, `3001 SKILL_NOT_FOUND`,
`3002 AGENT_UNAVAILABLE`, `3004 IDENTITY_MISMATCH`, `4001 OVERLOADED`, `4002 RATE_LIMITED`,
`4003 GOVERNANCE_DENIED`, `4004 APPROVAL_REQUIRED`, `5001 INTERNAL_ERROR`.
`retryableCode` is the single source of truth for the `retryable` flag, so a code can never
be emitted with an inconsistent value. `verify_test.go` pins each value to the spec.

## Interoperating with RTerm

Verified against RTerm 3.8.4 source (`~/.work/RTerm/plugins/synapse-bridge/`). What matches
today:

| | RTerm | ReactorPro |
|---|---|---|
| Protocol version | `0.3.0` | `0.3.0` |
| Subject prefix | `mesh` (default) | `mesh` (hardcoded — see below) |
| Subjects | `mesh.registry.*`, `mesh.agent.<id>.inbox`, `mesh.event.*` | same |
| Request payload | `{skill, input}` | same |
| Reply mechanism | `msg.respond()` | NATS request/reply |
| `SKILL_NOT_FOUND` | `3001` | `3001` |

ReactorPro → RTerm dispatch works: RTerm's responder subscribes to
`mesh.agent.<id>.inbox` and reads `payload.skill`, which is exactly what `Dispatch` sends.

Known divergences:

1. **Subject prefix is fixed at `mesh` here** but configurable in RTerm. Defaults align, so
   this only bites if someone changes RTerm's prefix. Making it configurable is outstanding.
2. **Reputation model.** RTerm keys on `agent_id::skill` with
   `(0.7*success + 0.2*speed + 0.1*freshness) * lying_penalty * confidence`; this is still a
   per-agent success/failure model with half-life decay. Scores are not comparable.
3. **Governance transport.** RTerm negotiates approvals over
   `${prefix}.approval.${taskId}.request|response` with `approval_request` /
   `approval_response` types. Approvals here are in-process plus the local HTTP API, so they
   cannot federate.
4. **Error code `5000`.** RTerm returns `5000` for a generic handler failure where the spec
   (and now this implementation) uses `5001`.
5. **Manifest field naming.** RTerm registers `agent_id`; the spec and this implementation
   use `id`. ReactorPro cannot see RTerm in discovery until that is fixed in RTerm.
6. **Heartbeat and deregistration** exist here and not in RTerm. Harmless extra surface.

## Served skills

The gateway answers a small, deliberately read-only surface, so a peer that discovers it
gets a real response instead of `3001`:

| Skill | Returns |
|---|---|
| `ping` | `{pong: true, ts}`. Touches no state, so it stays cheap under load. |
| `describe` | This agent's manifest — what it is and what it serves. |
| `status` | `agent_id`, `fingerprint`, `connected`, `skills`, `uptime_seconds`, and the mesh traffic counters. |

Two properties are intentional and should survive future changes:

- **Nothing here mutates state.** A mesh that can be asked to run a shell command or touch
  the filesystem is a remote-code hole; the value of serving anything is that a peer can
  see what you are, not that it can drive you. Anything stateful belongs behind its own
  explicit, separately gated skill.
- **`status` is narrow.** It reports this agent's own identity and counters — never the
  desktop agents connected to it, their tokens, or the local API surface. A test pins the
  payload to an exact key set so adding a field has to be a deliberate act.

Skills are registered before the agent connects, so they appear in the manifest the first
registration publishes. `-mesh-skills-enabled=false` serves none;
`-mesh-skills=ping,status` serves a subset. An unknown id in that list is rejected at
startup rather than silently unserved.

## Configuration

`DefaultConfig()` returns a disabled configuration. `Validate()` explains why an enabled
configuration cannot start, and it **rejects an unrecognised verify mode** rather than
silently downgrading the posture. NATS auth precedence is creds file → token → user/password;
`-mesh-creds-file` is the only way to use NKey/JWT, and it takes precedence over both.

## Known limits

Stated plainly so they are not mistaken for oversights:

- **Replay protection is bounded.** The id cache evicts in insertion order once full, so a
  determined flood within the remaining validity of a target envelope could evict it and
  replay. The timestamp window and the rate limiter are what make that expensive. Bounded
  memory that is occasionally imperfect beats unbounded memory that is not.
- **`require` breaks unsigned registries.** Discovery replies are verified like any other
  input, so a mode that refuses unsigned envelopes needs signed peers to discover.
- **State is in-memory.** Reputation, approvals and trust pins are lost on restart except
  the identity keypair. Persistence to SQLite is outstanding.
- **Trust pins do not survive a restart**, so after a restart the first verified message
  from a known peer is re-learned rather than checked against the previous fingerprint. In
  `prefer` mode that is benign; in `require` mode with first-use learning off it means
  configured pins are the only durable trust. Persisting the pins is outstanding.

## Remaining work

1. Persist reputation, approvals and trust pins to SQLite; bound approval history.
2. Optional JetStream: durable inboxes (stream `AGENT_INBOXES`, matching RTerm) and a
   KV-backed registry for deterministic discovery.
3. Configurable subject prefix, `trace` on every envelope type, `in_reply_to` on replies.
4. Per-(agent, skill) reputation implementing Formula 11.5, and wire-level governance
   subjects so approvals federate.
5. Surface trust pins and the approval audit trail in the Settings UI — both endpoints
   exist (`/api/mesh/trust`, `/api/mesh/history`).
