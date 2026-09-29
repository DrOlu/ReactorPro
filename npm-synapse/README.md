# @hyperspaceng/synapse-gateway

The **ReactorPro Gateway** (Synapse agent mesh) as native binaries — headless
gateway + agentd worker, bundled per platform, offline after install.

```bash
npm i -g @hyperspaceng/synapse-gateway
synapse-gateway --help
synapse-agentd --help
```

Both commands exec the bundled native binary with all arguments passed
through. Each platform package (`@hyperspaceng/synapse-gateway-darwin-arm64`,
`-darwin-x64`, `-linux-x64-gnu`, `-linux-arm64-gnu`, `-win32-x64`) carries the
matching `reactorpro-gateway` + `reactorpro-agentd` binaries.

Docs: https://github.com/DrOlu/ReactorPro
