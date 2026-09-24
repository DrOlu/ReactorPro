# reactorpro

Official npm CLI for [ReactorPro](https://reactorpro.ng) — installs the
**ReactorPro gateway** and the headless **reactorpro-agentd** worker binaries
from the official GitHub releases, for macOS (Intel/Apple Silicon), Linux
(x64/arm64) and Windows (x64).

## Install

```sh
npm install -g reactorpro
```

## Usage

```sh
# Install the gateway daemon (headless backend service)
reactorpro install gateway

# Install the headless concurrent agent worker
reactorpro install agentd

# Install both
reactorpro install all
```

Binaries land in `~/.reactorpro/bin` (a `.cmd` shim is created on Windows).
Add that directory to your `PATH` and follow the gateway setup guide in the
[repository](https://github.com/DrOlu/ReactorPro).

## Requirements

- Node.js ≥ 18
- A supported platform: `darwin-arm64`, `darwin-x64`, `linux-x64`,
  `linux-arm64`, or `win32-x64`

## License

MIT © Hyperspace Technologies
