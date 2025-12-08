# ReactorPro Server

**ReactorPro Server** is the high-performance engine behind the ReactorPro cockpit. It transforms your machine into a robust development host, managing the lifecycle of multiple OpenCode instances and providing the low-latency data streams that long-haul builders demand. It bridges your local filesystem with the UI, ensuring that whether you are on localhost or a remote tunnel, you have the speed, clarity, and control of a native workspace.

## Features & Capabilities

### 🌍 Deployment Freedom
- **Remote Access**: Host ReactorPro on a powerful workstation and access it from your lightweight laptop.
- **Code Anywhere**: Tunnel in via VPN or SSH to code securely from coffee shops or while traveling.
- **Multi-Device**: The responsive web client works on tablets and iPads, turning any screen into a dev terminal.
- **Always-On**: Run as a background service so your sessions are always ready when you connect.

### ⚡️ Workspace Power
- **Multi-Instance**: Juggle multiple OpenCode sessions side-by-side with per-instance tabs.
- **Long-Context Native**: Scroll through massive transcripts without hitches.
- **Deep Task Awareness**: Monitor background tasks and child sessions without losing your flow.
- **Command Palette**: A single, global palette to jump tabs, launch tools, and fire shortcuts.

## Prerequisites
- **OpenCode**: `opencode` must be installed and configured on your system.
- Node.js 18+ and npm (for running or building from source).
- A workspace folder on disk you want to serve.
- Optional: a Chromium-based browser if you want `--launch` to open the UI automatically.

## Usage

### Run via npx (Recommended)
You can run ReactorPro directly without installing it:

```sh
npx @hyperspace/reactorpro --launch
```

### Install Globally
Or install it globally to use the `reactorpro` command:

```sh
npm install -g @hyperspace/reactorpro
reactorpro --launch
```

### Common Flags
You can configure the server using flags or environment variables:

| Flag | Env Variable | Description |
|------|--------------|-------------|
| `--port <number>` | `CLI_PORT` | HTTP port (default 9898) |
| `--host <addr>` | `CLI_HOST` | Interface to bind (default 127.0.0.1) |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | Default root for new workspaces |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | Allow full-filesystem browsing |
| `--config <path>` | `CLI_CONFIG` | Config file location |
| `--launch` | `CLI_LAUNCH` | Open the UI in a Chromium-based browser |
| `--log-level <level>` | `CLI_LOG_LEVEL` | Logging level (trace, debug, info, warn, error) |

### Data Storage
- **Config**: `~/.config/reactorpro/config.json`
- **Instance Data**: `~/.config/reactorpro/instances` (chat history, etc.)

