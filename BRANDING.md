# ReactorPro Branding

ReactorPro is a rebranded distribution of [Stack-Cairn/LiveAgent](https://github.com/Stack-Cairn/LiveAgent),
maintained by **Hyperspace Technologies** (<agent@reactorpro.ng>).

This document explains how the rebrand is applied and how it is kept in place.

## What changes

| Area | ReactorPro value |
|---|---|
| Product name (visible UI, window title, About) | `ReactorPro` |
| Tauri `productName` | `ReactorPro` |
| Bundle identifier | `ng.reactorpro.app` |
| Author metadata (`package.json`, `Cargo.toml`) | `Hyperspace Technologies <agent@reactorpro.ng>` |
| Homepage | <https://reactorpro.ng> |
| App icons, tray icon, favicons, README banner | `branding/` |
| Auto-update source | `DrOlu/ReactorPro` |
| Language | English only |

## What deliberately does **not** change

Internal identifiers are left alone so the build, the protocol, and existing user
data keep working:

- npm package scope `@liveagent/*` and workspace package names
- Rust crate name `liveagent` / `liveagent_lib`
- Data directory `~/.liveagent`
- Environment variables such as `LIVEAGENT_GATEWAY_TOKEN`
- Internal prompt tags such as `LiveAgentSkillFileRules`
- Upstream citations in docs that reference real upstream issues

## The single source of truth

`scripts/reactorpro-rebrand.mjs` applies and enforces the entire rebrand. It is
idempotent — running it repeatedly converges on the same state.

```bash
node scripts/reactorpro-rebrand.mjs           # apply branding
node scripts/reactorpro-rebrand.mjs --check   # verify only, no writes
```

It performs five jobs:

1. **Restores brand-owned files** from `branding/` (icons, favicons, README, banner).
2. **Rewrites product identity** in the Tauri configs, `Cargo.toml`, and `package.json` files.
3. **Rewrites the visible product name** (`LiveAgent` → `ReactorPro`) in source, skipping
   the internal identifiers listed above.
4. **Repoints repository references** that must belong to ReactorPro — most importantly the
   auto-update repository, so a ReactorPro build never downloads upstream LiveAgent releases.
5. **Enforces the language policy** — the default locale is `en-US`, document `lang`
   attributes are `en`, and the script **fails** if any Chinese text exists in the tree.

## No upstream sync

ReactorPro does **not** track `Stack-Cairn/LiveAgent`. The `sync-upstream.yml` workflow that merged
upstream every six hours was removed on purpose: ReactorPro is a standalone product, the two
codebases have diverged too far for a mechanical merge to be worth reconciling, and the merge kept
proposing changes that had to be undone again.

What this means:

- Nothing merges, prunes, or re-bases upstream into this repository.
- `scripts/reactorpro-rebrand.mjs` remains the source of truth for branding, but nothing re-applies
  it automatically any more. Run it after any change that touches visible names. The
  `gateway-release.yml` release gate runs `--check`, so drift cannot reach a published binary
  unnoticed.
- `branding/prune.txt` is no longer read by anything. It is kept as the record of what ReactorPro
  intentionally does not ship (the Chinese README, the removed speech-to-text feature) in case a
  file is ever pulled in from upstream by hand.
- Upstream is now only a reference. If a file is taken from it manually, translate it and run
  `node scripts/reactorpro-rebrand.mjs --check` until it passes.

### Adding a new brand-owned file

1. Put the file under `branding/`.
2. Add a `[source, destination]` entry to `BRAND_COPIES` in `scripts/reactorpro-rebrand.mjs`.

## Divergence from upstream

ReactorPro is a standalone fork, so these are permanent differences rather than something to
reconcile. They are recorded here because they are **not** branding changes, and the rebrand script
does not manage them:

- `crates/agent-ui/src/lib/chat/hostedSearch.ts` — text blocks are concatenated with no
  separator before sentence-boundary resolution. Chinese `。` ends a sentence regardless of
  what follows, but ASCII `.` only did so when followed by whitespace, so an English answer
  ending one block and starting the next (`"…complete." + "Task…"`) was not recognised as a
  boundary. Hosted-search cards were placed after the whole answer instead of in position.
  `isAsciiPeriodSentenceTerminator` now also treats a period followed by an uppercase letter
  as a sentence end.

The `chatUi-agent` tests cover this: they fail if the ASCII sentence-boundary handling regresses, so
the fix cannot be lost silently.

- `.github/workflows/desktop-release.yml` — signing is optional. When
  `APPLE_CERTIFICATE_P12_BASE64` or `TAURI_SIGNING_PRIVATE_KEY` is absent the workflow builds an
  **unsigned** release: installers for all three platforms are produced and published, but they
  are not code-signed/notarized and no updater manifest or `.sig` assets are emitted, so in-app
  auto-update stays off. `crates/agent-gui/src-tauri/tauri.unsigned.conf.json` disables
  `bundle.createUpdaterArtifacts` for that path. Add the signing secrets to switch to a fully
  signed release with no further changes.

  Unlike the sentence-boundary fix, no test catches a regression here: dropping the gate or the
  overlay silently produces a release that is neither signed nor updatable, so check both when
  editing `desktop-release.yml`.

## ReactorPro-only additions

These do not exist upstream. They are listed so that anyone importing a file from upstream by hand
notices the overlap.

- `.github/workflows/gateway-release.yml` — publishes standalone `reactorpro-gateway-<os>-<arch>`
  binaries (linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64) plus a
  `SHA256SUMS` file to the same GitHub release the desktop workflow publishes to, so a server can
  be set up by downloading one file. The Docker image from `gateway-docker.yml` still exists as
  the alternative path.

  The gateway Go binary embeds the Web UI (`//go:embed all:web/dist`, see
  `crates/agent-gateway/embed.go`), and `web/dist/` is **gitignored**. A stale bundle therefore
  ships stale branding with nothing to catch it — the served gateway UI read "Live Agent" for
  several releases after the rename. The `webui` job builds the bundle once, the `build` matrix
  reuses that single artifact, and a `Verify the bundle is branded` step fails the release if the
  bundle still contains the pre-rebrand name, contains Chinese text, or omits the product name.
  Keep that guard: it is the only thing that catches this class of regression.
