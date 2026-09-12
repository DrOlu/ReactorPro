# ReactorPro Branding

ReactorPro is a rebranded distribution of [Stack-Cairn/LiveAgent](https://github.com/Stack-Cairn/LiveAgent),
maintained by **Hyperspace Technologies** (<agent@reactorpro.ng>).

This document explains how the rebrand is applied and how it survives upstream syncs.

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

## Upstream sync

`.github/workflows/sync-upstream.yml` runs every six hours (and on demand):

1. Merges `Stack-Cairn/LiveAgent@main` into a `sync/upstream` branch, preferring upstream on conflicts.
2. Prunes paths listed in `branding/prune.txt` — files ReactorPro intentionally does not ship
   (the Chinese README, the removed speech-to-text feature).
3. Runs `scripts/reactorpro-rebrand.mjs`, which restores every branding element and fails the
   build if Chinese text has reappeared.
4. Opens (or updates) a pull request against `main` and enables auto-merge.

Because the workflow only ever lands changes through a pull request, upstream changes still run
the full CI. If an upstream change reintroduces Chinese text, the rebrand step fails and the pull
request is left open with the offending files listed in the log.

### When upstream reintroduces Chinese

Translate the flagged files to English, run `node scripts/reactorpro-rebrand.mjs --check` until it
passes, and push to the sync branch. The pull request then completes normally.

### Adding a new brand-owned file

1. Put the file under `branding/`.
2. Add a `[source, destination]` entry to `BRAND_COPIES` in `scripts/reactorpro-rebrand.mjs`.

### Removing an upstream file permanently

Add its path to `branding/prune.txt`, one per line.

## Known divergence from upstream

Because ReactorPro is English-only, one behavioural fix was needed that is **not** a
branding change and is therefore not re-applied by the rebrand script:

- `crates/agent-ui/src/lib/chat/hostedSearch.ts` — text blocks are concatenated with no
  separator before sentence-boundary resolution. Chinese `。` ends a sentence regardless of
  what follows, but ASCII `.` only did so when followed by whitespace, so an English answer
  ending one block and starting the next (`"…complete." + "Task…"`) was not recognised as a
  boundary. Hosted-search cards were placed after the whole answer instead of in position.
  `isAsciiPeriodSentenceTerminator` now also treats a period followed by an uppercase letter
  as a sentence end.

If an upstream sync reverts this, the `chatUi-agent` tests fail — CI blocks the sync pull
request, so the fix cannot be lost silently. Re-apply it as part of resolving that sync.

- `.github/workflows/desktop-release.yml` — signing is optional. When
  `APPLE_CERTIFICATE_P12_BASE64` or `TAURI_SIGNING_PRIVATE_KEY` is absent the workflow builds an
  **unsigned** release: installers for all three platforms are produced and published, but they
  are not code-signed/notarized and no updater manifest or `.sig` assets are emitted, so in-app
  auto-update stays off. `crates/agent-gui/src-tauri/tauri.unsigned.conf.json` disables
  `bundle.createUpdaterArtifacts` for that path. Add the signing secrets to switch to a fully
  signed release with no further changes.

  A sync merge would revert this workflow file. Unlike the sentence-boundary fix there is no test
  that catches it — re-apply the `Detect signing configuration` gate and the
  `tauri.unsigned.conf.json` overlays when resolving a sync, or the next unsigned release fails.
