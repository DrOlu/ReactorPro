# NATS Event Mesh and Synapse Mesh Bridge

ReactorPro can join the fleet's NATS event mesh and act as a full-duplex Synapse
agent, mirroring the bridge wired into [RTerm](https://github.com/DrOlu/RTerm)
(`plugins/synapse-bridge/` + `packages/backend/src/services/automation/`).

**Status: the protocol layer is implemented and tested; it is not yet wired into
the gateway or exposed in the UI.** Nothing connects until that wiring lands and
someone enables it — the shipping configuration is disabled and unconfigured.

## What is here

| File | Purpose |
|---|---|
| `envelope.go` | Envelope, manifest, message types, subjects, error codes |
| `identity.go` | Immutable Ed25519 agent identity (see below) |
| `synapse.go` | The agent: register, discover, dispatch, serve, emit, subscribe |
| `reputation.go` | EXT-REPUTATION scoring |
| `governance.go` | EXT-GOVERNANCE approvals |
| `manager.go` | Lifecycle, configuration, the tool surface, status snapshot |
| `mesh_test.go` | 28 tests covering the above |

## Agent identity — an intentional divergence

RTerm has **no agent identity beyond a mutable config string**: `settings.synapse.agentId`
defaults to `rterm-001`, is freely editable, and envelopes are never signed.

ReactorPro deliberately does better, because the requirement was an agent id
that cannot be changed by anyone. The identity is an Ed25519 keypair whose
fingerprint covers **both the id and the public key**:

- Editing the id in the identity file invalidates the fingerprint and the
  identity refuses to load (`ErrIdentityTampered`).
- Pointing the config at a different id than the file contains fails with
  "cannot be reassigned".
- Envelopes are signed (`sig` + `pub`) and verified against the embedded key.

The private key is written `0600`. The id is minted once on first start and
persists.

## Deltas from RTerm that still need a pass

These were found by reading RTerm's actual source; the first implementation was
built from the older `synapse-demo` SDK, which differs. Reconciling them is
required before the bridge can interoperate with a real mesh:

1. **Subject prefix is configurable in RTerm** (`settings.synapse.prefix`,
   default `mesh`; the event bus defaults to `rterm`). Subjects are hardcoded
   constants here and need to become prefix-aware.
2. **`in_reply_to`** — RTerm sets it on `respond` and `approval_response`; the
   envelope here has no such field.
3. **No heartbeat or deregistration exists in RTerm.** This implementation adds
   both (30 s heartbeat, explicit deregister). Harmless against a registry that
   ignores them, but it is extra surface that upstream does not have.
4. **Reputation formula.** RTerm scores
   `(0.7*success_rate + 0.2*speed_score + 0.1*freshness) * lying_penalty * confidence`,
   keyed by `agent_id::skill`, with `skill_not_found` counted separately and
   three consecutive misses flagging `misleading_capabilities`. The scoring here
   is a simpler per-agent success/failure model with half-life decay.
5. **Governance transport.** RTerm negotiates approvals over
   `${prefix}.approval.${taskId}.request|response` using `approval_request` /
   `approval_response` envelope types, and it does **not** enforce approvals in
   the dispatch path — the caller must ask. Here the governor gates dispatch
   internally. Enforcement is stronger, but it is not wire-compatible.
6. **Error codes.** RTerm defines only `3001 SKILL_NOT_FOUND` and
   `5000` generic failure. This implementation uses a wider set
   (`2002/3001/5001/4010/5003/4030`).
7. **Manifest field naming.** RTerm uses `agent_id`; this uses `id`. Discovery
   normalisation here tolerates both reply shapes, but registration emits `id`.
8. **Tool count is 12, not 13** — `plugin.json` lists 12.

## Configuration

`DefaultConfig()` returns a disabled configuration. `Validate()` explains why an
enabled configuration cannot start. Auth precedence is creds file → token →
user/password, matching the fleet convention.

## Remaining work to finish the feature

1. Reconcile the deltas above (subject prefix, `in_reply_to`, reputation and
   governance wire formats).
2. Wire `mesh.Manager` into `cmd/gateway` and the gateway's HTTP surface.
3. Add protobuf messages so the desktop app and WebUI can read status and drive
   the tools.
4. Build the Settings section and the mesh-agents panel.
5. Decide which skills ReactorPro itself serves over the mesh.
