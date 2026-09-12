# CI/CD and Release

This document describes the current automated release pipeline: CI checks, the Gateway Docker image, user self-hosted Gateway, and desktop macOS/Windows Release.

## Automation Entry Points

| Entry point | Workflow | Action |
|---|---|---|
| PR / `main` push | `.github/workflows/ci.yml` | Runs Gateway, WebUI, GUI, and Tauri Rust tests plus the proto consistency check. |
| Daily schedule | `.github/workflows/update-model-catalog.yml` | Refreshes the model capability catalog; GitHub Actions creates or updates a pending-review PR only when the data changes. |
| `v*` tag / manually specified tag | `.github/workflows/gateway-docker.yml` | Builds and pushes the `vX.Y.Z` and `latest` Gateway images. |
| `v*` tag / manually specified tag | `.github/workflows/desktop-release.yml` | Builds macOS Intel, macOS Apple Silicon, Windows x64, and Linux x64 desktop packages in parallel and uploads them to the GitHub Release. |

## Model Catalog Sync

`update-model-catalog.yml` runs every day at 03:17 UTC (11:17 Beijing time). The job directly runs `node scripts/generate-model-catalog.mjs`, generating `crates/agent-ui/src/lib/models/catalog.generated.ts` from OpenAI Codex `models.json` and `models.dev/api.json`.

- When there is no actual upstream data change, the job ends immediately and does not create a PR; the snapshot date itself does not trigger an update.
- When there is a change, it always updates the `automation/model-catalog-refresh` branch and the same PR, avoiding duplicate PRs.
- The PR commits only the model catalog generated file via `add-paths`; the generation job fails when an upstream request fails, data is truncated, or a key model is missing.
- The PR is created with the default `GITHUB_TOKEN` and does not automatically trigger `pull_request` CI or PR governance workflows; maintainers review it and then trigger the required checks themselves and merge.
- The model catalog is a compile-time static snapshot; installed versions do not sync dynamically, and merged data only enters subsequent builds and Releases.

The workflow does not need extra Secrets, but the repository must allow GitHub Actions to create Pull Requests in the Actions settings. The `governance-exempt` label is used to prevent automatic PRs from being closed by the stale job.

`github-release-main` only creates and pushes Tags from the already-reviewed `main`; it no longer refreshes, commits, or directly pushes the model catalog online during release, avoiding external data changes and network failures affecting release reproducibility.

## Gateway Image

The `Dockerfile` at the repository root is the production image for the Gateway:

| Stage | Content |
|---|---|
| `webui` | Builds `crates/agent-gateway/web/dist` with Node 22 and pnpm. |
| `gateway-builder` | Compiles `cmd/gateway` with Go; the WebUI static assets are embedded into the binary via `go:embed`. |
| `runtime` | Debian slim + CA certificates + `liveagent-gateway`, running as a non-root user. |

Runtime variables:

| Variable | Required | Description |
|---|---|---|
| `LIVEAGENT_GATEWAY_TOKEN` | Yes | Shared access token for the WebUI, HTTP API, and desktop v2 WebSocket. |
| `PORT` | Provided automatically by Railway | Listening port for HTTP/WebUI/desktop WebSocket; when not provided, the Dockerfile defaults to `8080`. |
| `LIVEAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT` | No | Maximum wait for the associated native Ping/Pong before `chat.prepare` and command accepted, default `2s`. |
| `LIVEAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT` | No | Maximum wait to deliver the `ChatCommandRequest` to the current desktop Agent stream after accepted, default `5s`. |
| `LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT` | No | The first watchdog segment for a Chat command entering the desktop running state, default `5s`. |
| `LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT` | No | The additional window to keep waiting for the desktop run to settle after the first watchdog segment, default `10s`. |

Example local smoke run:

```bash
make gateway-docker-smoke
```

The `Gateway Docker Smoke` job in CI performs the equivalent check: build the image, start the container, and access `/healthz`.

## User Self-Hosted Gateway

ReactorPro does not provide a hosted Gateway service. Users who need a public Remote Gateway can deploy this repository with their own Railway account, or deploy the `ghcr.io/<owner>/liveagent-gateway:vX.Y.Z` / `latest` image on another Docker platform.

Railway self-hosting path:

1. Create a new project in Railway and choose GitHub Repository.
2. Choose `DrOlu/ReactorPro` or your own fork.
3. Choose a branch that contains the root `Dockerfile` and `railway.json`.
4. Set `LIVEAGENT_GATEWAY_TOKEN=<long-random-token>` in the service variables.
5. After a successful deployment, generate a Public Domain and access `/healthz` to verify the health check.

Recommended production deployment model:

| Traffic | Railway capability | Remote configuration |
|---|---|---|
| WebUI / HTTP / desktop WebSocket (`/ws/v2*`) | Public Networking HTTPS domain | On the desktop, set `Gateway URL=https://<service>.up.railway.app` and fill in `443` for the gateway port. |

All real-time links uniformly use the same HTTPS domain and port.

Gateway runtime variables are configured by the user on their own platform:

| Variable | Description |
|---|---|
| `LIVEAGENT_GATEWAY_TOKEN` | The gateway Token used by the WebUI, management API, and Agent links; Agents may also use separate credentials. |
| `LIVEAGENT_GATEWAY_AGENT_DB` | Path to the Agent credential SQLite database; created automatically by default, no manual setup required. |
| `LIVEAGENT_GATEWAY_DATA_DIR` | Parent directory of the automatic database; the official container defaults to `/var/lib/liveagent`, and running the binary directly defaults to the user configuration directory. |
| `LIVEAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT` | Default `2s`; usually no need to increase it. A timeout should expose a half-open connection and let the client recover quickly. |
| `LIVEAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT` | Default `5s`; controls the upper bound for delivering to the desktop stream after accepted. |
| `LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT` | Default `5s`; controls the first phase of the remote command startup watchdog. |
| `LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT` | Default `10s`; controls the additional phase of the startup watchdog. |

The Gateway's conversation stream replay and `client_request_id` deduplication are both currently bounded in-process state and do not themselves require a persistent volume. The event window retains the last 10 minutes, at most 4096 entries, or about 8 MiB by default; command deduplication records are kept for 24 hours but are not retained after a Gateway process restart. By default the Gateway automatically creates a per-Agent credential database (SQLite); you can specify the path with `-agent-db`. Production deployments need to mount the database directory onto a persistent volume; the official Docker command uses `-v liveagent-gateway-data:/var/lib/liveagent`, otherwise rebuilding the container loses issued credentials (see [multi-agent.md](multi-agent.md)).

During upgrades, `-grpc-addr` and `-command-queue-timeout` in old startup scripts are removed before the new argument parsing, do not appear in `--help`, and do not restore the deleted v1/gRPC or offline command queue. `-grpc-max-message-bytes` and `LIVEAGENT_GATEWAY_GRPC_MAX_MESSAGE_BYTES` map to the current WebSocket protobuf message limit; the new names `-max-message-bytes` and `LIVEAGENT_GATEWAY_MAX_MESSAGE_BYTES` take precedence. Other unknown arguments still raise errors, avoiding hidden configuration typos.

## GitHub Secrets

The macOS signed/notarized release needs these secrets:

| Secret | Description |
|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | Base64 of the Developer ID Application `.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | The password set when exporting the `.p12`. |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: wenlin fei (UU94JSVAA9)`. |
| `APPLE_ID` | Apple Developer account email. |
| `APPLE_TEAM_ID` | `UU94JSVAA9`. |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password. |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key, used to generate release update package signatures. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri updater private key password; may be empty when there is no password. |
| `TAURI_UPDATER_PUBLIC_KEY` | Tauri updater public key, compiled into the desktop app to verify update packages. |

Scripted write to GitHub configuration:

```bash
BOOTSTRAP_APPLE_SECRETS=1 \
APPLE_CERTIFICATE_PASSWORD=<p12-export-password> \
  scripts/release/bootstrap-github-secrets.sh
```

If `CERT_DIR/developer_id_application.p12` does not exist, the script automatically exports it from `Developer ID Application: wenlin fei (UU94JSVAA9)` in the local Keychain and generates a `.p12` password to write into the GitHub Secret. `CERT_DIR` defaults to `~/Personal/cert` first, and uses `~/Downloads/cert` when it does not exist. When a `.p12` already exists, you need to pass `APPLE_CERTIFICATE_PASSWORD=<p12-password>`.

If automatic export fails, first confirm that a signable identity is visible on the machine:

```bash
security find-identity -v -p codesigning "$HOME/Library/Keychains/login.keychain-db"
```

The Keychain must contain a `Developer ID Application` identity with a private key. If macOS refuses to export the private key, you can manually export the `.p12` to `P12_PATH` in Keychain Access, then re-run the script with the same `APPLE_CERTIFICATE_PASSWORD`.

The script reads by default:

| File | Purpose |
|---|---|
| `CERT_DIR/developer_id_application.p12` | The signing identity imported by CI. |
| `CERT_DIR/app key.md` | Apple app-specific password. |

## Desktop Artifacts

`desktop-release.yml` artifacts:

| Platform | Runner | Artifacts |
|---|---|---|
| macOS Intel | `macos-15-intel` | `ReactorPro-vX.Y.Z-macOS-x64.dmg`, plus the `.app.tar.gz` / `.sig` used by the updater. |
| macOS Apple Silicon | `macos-14` | `ReactorPro-vX.Y.Z-macOS-aarch64.dmg`, plus the `.app.tar.gz` / `.sig` used by the updater. |
| Windows x64 | `windows-latest` | `ReactorPro-vX.Y.Z-Windows-x64.msi`, `ReactorPro-vX.Y.Z-Windows-x64-Setup.exe`, plus the `.zip` / `.sig` used by the updater. |
| Linux x64 | `ubuntu-latest` | `ReactorPro-vX.Y.Z-Linux-x86_64.AppImage`, `.deb`, `.rpm`, plus the `.tar.gz` / `.sig` used by the updater. |

The macOS DMG install window layout (background image, window size, icon positions) is written to `.DS_Store` at the DMG root. tauri-bundler drives Finder via AppleScript to write this file, but it skips this step whenever `CI=true` is detected, producing a plain white DMG with no layout. Therefore `make desktop-build-macos-release` does not directly publish the DMG generated by tauri-bundler; instead, after the `.app` signature verification passes, it regenerates the DMG with [dmgbuild](https://github.com/dmgbuild/dmgbuild) (`dmgbuild==1.6.5`, installed in CI by the `Install deterministic DMG builder` step of `desktop-release.yml`) according to `scripts/release/macos-dmg-settings.py`: dmgbuild writes Finder metadata directly without relying on a GUI session, so the layout is deterministic on any runner. The DMG is then signed, notarized, and stapler-verified, and `scripts/release/verify-macos-dmg.sh` is used to mount and verify that `.DS_Store`, `.background.png`, `ReactorPro.app`, and the `Applications` link are all present, aborting the release if anything is missing. For local troubleshooting you can run that script directly against any DMG (`make desktop-verify-macos` also runs it).

After uploading the platform artifacts, the release job generates and uploads `latest.json`. The desktop "Settings -> About" filters official / prerelease versions with `latest.json` from GitHub Releases based on whether the user allows prereleases; when prereleases are not allowed, only official Releases are checked.

## Desktop Version Number Source

Local development and ordinary local builds maintain only one default version source: `crates/agent-gui/package.json`. The Tauri default configuration, the frontend About page, and the Rust runtime code all read the version from here, so daily development does not require syncing the version number across multiple files.

Official releases do not rely on manually editing `package.json`. `desktop-release.yml` first parses the release tag in the `Release Metadata` job:

```bash
node scripts/release/prepare-app-version-from-tag.mjs vX.Y.Z
```

This script validates that the tag must be a semver starting with `v`, and outputs:

| Output | Example | Purpose |
|---|---|---|
| `LIVEAGENT_RELEASE_TAG` | `v0.1.3` | GitHub Release, artifact naming, and download URLs. |
| `LIVEAGENT_APP_VERSION` | `0.1.3` | The frontend About page and Rust runtime code. |
| `LIVEAGENT_IS_PRERELEASE` | `false` | Determines whether the GitHub Release is marked as prerelease. |
| `LIVEAGENT_TAURI_VERSION_CONFIG` | `src-tauri/tauri.version.generated.conf.json` | Temporary config overlay appended during the Tauri build. |

Each platform's build job reuses the same metadata and generates a Tauri overlay that is not committed to the repository:

```json
{
  "version": "0.1.3"
}
```

The Tauri build command injects this version via the extra `--config "$LIVEAGENT_TAURI_VERSION_CONFIG"`; Vite and the Rust build script inject the same version via `LIVEAGENT_APP_VERSION`. This way the release version takes the tag as its source of truth, and the updater manifest, the in-app displayed version, and the installer version stay consistent; forgetting to change `package.json` will not cause a release package to still show an old version.

Windows currently has no code signing secret, so the release workflow first automatically publishes an unsigned package. Add the signing step later after integrating Windows `.p12/.pfx` or Trusted Signing.