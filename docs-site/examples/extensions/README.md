# ReactorPro Extension Examples

This directory contains example extensions demonstrating various capabilities of the ReactorPro extension system.

## Extension Overview

| Extension | Description | Extension Functions |
|-----------|-------------|---------------------|
| **[theme.ts](./theme.ts)** | Adds `/theme` command to switch ReactorPro themes | `onLoad`, `getCommands` |
| **[sound-notification.ts](./sound-notification.ts)** | Plays a "Jobs Done" sound when a prompt finishes | `onLoad`, `onPromptFinished` |
| **[protected-paths.ts](./protected-paths.ts)** | Blocks file operations on protected paths (`.env`, `.git/`, `node_modules/`) | `onLoad`, `onToolCalled` |
| **[plan-mode.ts](./plan-mode.ts)** | Adds a Plan mode that enforces planning before coding | `onLoad`, `getModes`, `onAgentStarted` |
| **[pirate.ts](./pirate.ts)** | Adds a Pirate agent that speaks like a swashbuckling sea dog | `onLoad`, `getAgents`, `onAgentProfileUpdated` |
| **[permission-gate.ts](./permission-gate.ts)** | Prompts for confirmation before running dangerous bash commands (`rm -rf`, `sudo`, `chmod/chown 777`) | `onLoad`, `onToolCalled` |
| **[generate-tests.ts](./generate-tests.ts)** | Adds `/generate-tests` command to generate unit tests for files | `onLoad`, `getCommands` |
| **[sandbox/](./sandbox/)** | OS-level sandboxing for bash commands using `@anthropic-ai/sandbox-runtime` | `onLoad`, `onUnload`, `onTaskInitialized`, `onTaskClosed`, `onToolCalled` |
| **[rtk/](./rtk/)** | Transparently rewrites shell commands to RTK equivalents, reducing LLM token consumption by 60-90% | `onLoad`, `getCommands`, `onToolCalled` |
| **[chunkhound-search/](./chunkhound-search/)** | Provides `chunkhound-search` tool using ChunkHound for semantic code search | `onLoad`, `onUnload`, `onProjectOpen`, `onToolFinished`, `getTools` |
| **[chunkhound-on-semantic-search-tool/](./chunkhound-on-semantic-search-tool/)** | Overrides `power---semantic_search` to use ChunkHound for better semantic understanding | `onLoad`, `onUnload`, `onProjectOpen`, `onToolCalled`, `onToolFinished` |
| **[wakatime.ts](./wakatime.ts)** | Tracks coding activity by sending heartbeats to WakaTime via wakatime-cli | `onLoad`, `onPromptStarted`, `onPromptFinished`, `onToolFinished`, `onFilesAdded` |
| **[redact-secrets/](./redact-secrets/)** | Redacts secret values from `.env*` files in file read results | `onLoad`, `onProjectOpen`, `onToolFinished` |
| **[external-rules.ts](./external-rules.ts)** | Includes rule files from Cursor, Claude Code, and Roo Code configurations | `onLoad`, `onRuleFilesRetrieved` |
| **[ultrathink.ts](./ultrathink.ts)** | Detects prompts like "ultrathink" / "think hard" and increases OpenAI/OpenAI-compatible reasoning effort (`xhigh` for `-max` models, otherwise `high`) | `onLoad`, `onAgentStarted` |

## Using Extensions in Your Project

### 1. Download Type Definitions

For TypeScript support and autocompletion, download the extension type definitions:

```bash
# Download to your project
curl -o extension-types.d.ts https://raw.githubusercontent.com/hyperspace/reactorpro/main/build/types/extension-types.d.ts
```

Or manually download from: [extension-types.d.ts](https://github.com/hyperspace/reactorpro/blob/main/build/types/extension-types.d.ts)

### 2. Install Extension

Copy the extension file(s) to your ReactorPro extensions directory:

```bash
# Global extensions (available to all projects)
cp my-extension.ts ~/.reactorpro/extensions/

# Project-specific extensions
cp my-extension.ts .reactorpro/extensions/
```

### 3. Import Types (Optional)

If you downloaded `extension-types.d.ts`, update the import path in your extension:

```typescript
// Original import from examples
import type { Extension, ExtensionContext } from '../../../build/types/extension-types';

// Update to your local path
import type { Extension, ExtensionContext } from './extension-types';
```
