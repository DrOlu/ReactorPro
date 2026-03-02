# Installation

Extensions can be installed at two levels: global (available to all projects) or project-specific (only for the current project). Both locations support hot reload, so changes take effect immediately without restarting ReactorPro.

## Installation Locations

### Global Extensions

Global extensions are available to all ReactorPro projects on your system.

```bash
# Create the directory if it doesn't exist
mkdir -p ~/.reactorpro/extensions

# Copy your extension
cp my-extension.ts ~/.reactorpro/extensions/

# For folder-based extensions
cp -r my-complex-extension ~/.reactorpro/extensions/
```

**Path:** `~/.reactorpro/extensions/`

### Project Extensions

Project extensions are only loaded when working with that specific project.

```bash
# Create the directory in your project
mkdir -p .reactorpro/extensions

# Copy your extension
cp my-extension.ts .reactorpro/extensions/

# For folder-based extensions
cp -r my-complex-extension .reactorpro/extensions/
```

**Path:** `./.reactorpro/extensions/`

## Extension Priority

When both global and project extensions exist with the same name:

1. **Project extensions override global extensions** - The project-level version takes precedence
2. **Both are loaded** - If names differ, both extensions run
3. **Execution order** - Global extensions execute first, then project extensions

## Hot Reload

Extensions are automatically reloaded when files change. There's no need to restart ReactorPro.

### How It Works

1. ReactorPro watches both extension directories for changes
2. When a file is added, modified, or deleted, a reload is triggered
3. Changes are debounced by 1 second to prevent rapid reloads
4. The extension is unloaded and reloaded with the new code

### What Triggers a Reload

- Creating a new extension file (`.ts` or `.js`)
- Modifying an existing extension file
- Deleting an extension file
- Adding/modifying/deleting files in a folder extension

### Development Workflow

```bash
# 1. Create or edit your extension
vim ~/.reactorpro/extensions/my-extension.ts

# 2. Save the file - extension reloads automatically

# 3. Check ReactorPro logs for any errors
# Logs appear in the ReactorPro console
```

## Installing from Examples

To install an example from the ReactorPro repository:

```bash
# Single file example
curl -o ~/.reactorpro/extensions/sound-notification.ts \
  https://raw.githubusercontent.com/hyperspace/reactorpro/main/docs-site/examples/extensions/sound-notification.ts

# Folder-based example
git clone --depth 1 https://github.com/hyperspace/reactorpro temp-aider
cp -r temp-aider/docs-site/examples/extensions/sandbox ~/.reactorpro/extensions/
rm -rf temp-aider

# Install dependencies for folder extensions
cd ~/.reactorpro/extensions/sandbox
npm install
```

## TypeScript Setup

For TypeScript support in your extensions:

```bash
# Download type definitions to your extensions directory
curl -o ~/.reactorpro/extensions/extension-types.d.ts \
  https://raw.githubusercontent.com/hyperspace/reactorpro/main/build/types/extension-types.d.ts

# For project extensions
curl -o .reactorpro/extensions/extension-types.d.ts \
  https://raw.githubusercontent.com/hyperspace/reactorpro/main/build/types/extension-types.d.ts
```

Then import in your extension:

```typescript
import type { Extension, ExtensionContext } from './extension-types';
```

## Verifying Installation

To verify your extension is loaded:

1. Open ReactorPro
2. Check the console/logs for extension load messages
3. Look for your extension's tools, commands, or agents in the UI

Extensions log messages using `context.log()` which appears in ReactorPro's log output.

## Uninstalling

Simply remove the extension file or folder:

```bash
# Remove a single-file extension
rm ~/.reactorpro/extensions/my-extension.ts

# Remove a folder extension
rm -rf ~/.reactorpro/extensions/my-complex-extension
```

The extension will be automatically unloaded.
