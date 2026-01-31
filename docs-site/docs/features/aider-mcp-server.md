---
title: ReactorPro as MCP Server
description: Learn how to use ReactorPro as a Model Context Protocol (MCP) server to integrate with other MCP-compatible clients.
---

ReactorPro includes a built-in MCP server, allowing other MCP-compatible clients (like Claude Desktop, Cursor, etc.) to interact with ReactorPro's core functionalities.

## Configuration

Add the following configuration to your MCP client settings, adjusting paths as needed.

### Windows

```json
{
  "mcpServers": {
    "reactorpro": {
      "command": "node",
      "args": ["path-to-appdata/reactorpro/mcp-server/reactorpro-mcp-server.js", "/path/to/project"],
      "env": {
        "AIDER_DESK_API_BASE_URL": "http://localhost:24337/api"
      }
    }
  }
}
```

**Note:** Replace `path-to-appdata` with the absolute path to your AppData directory. You can find this value by running `echo %APPDATA%` in your command prompt.

### macOS

```json
{
  "mcpServers": {
    "reactorpro": {
      "command": "node",
      "args": ["/path/to/home/Library/Application Support/reactorpro/mcp-server/reactorpro-mcp-server.js", "/path/to/project"],
      "env": {
        "AIDER_DESK_API_BASE_URL": "http://localhost:24337/api"
      }
    }
  }
}
```

**Note:** Replace `/path/to/home` with the absolute path to your home directory. You can find this value by running `echo $HOME` in your terminal.

### Linux

```json
{
  "mcpServers": {
    "reactorpro": {
      "command": "node",
      "args": ["/path/to/home/.config/reactorpro/mcp-server/reactorpro-mcp-server.js", "/path/to/project"],
      "env": {
        "AIDER_DESK_API_BASE_URL": "http://localhost:24337/api"
      }
    }
  }
}
```

**Note:** Replace `/path/to/home` with the absolute path to your home directory. You can find this value by running `echo $HOME` in your terminal.

## Arguments & Environment

- **Command Argument 1:** Project directory path (required).
- **`AIDER_DESK_API_BASE_URL`:** Base URL of the running ReactorPro API (default: `http://localhost:24337/api`).

## Available Tools via MCP

The built-in server exposes these tools to MCP clients:

- `add_context_file`: Add a file to ReactorPro's context.
- `drop_context_file`: Remove a file from ReactorPro's context.
- `get_context_files`: List files currently in ReactorPro's context.
- `get_addable_files`: List project files available to be added to the context.
- `run_prompt`: Execute a prompt within ReactorPro.
- `clear_context`: Clear the context of ReactorPro.

## Requirements

**Note:** ReactorPro must be running for its MCP server to be accessible.
