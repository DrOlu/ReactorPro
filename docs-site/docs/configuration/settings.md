---
title: "Settings Overview"
sidebar_label: "Settings"
---

# Settings Overview

ReactorPro provides a centralized location to manage all your configurations. You can access it by clicking the gear icon in the top-right corner of the application.

The settings are organized into the following tabs:

### General

This tab contains settings related to the user interface and general application behavior.
- **Appearance**: Configure the application's language, zoom level, and theme (Dark/Light).
- **Start Up**: Choose what ReactorPro should do on launch: start with an empty task or load the last used task.
- **Notifications**: Enable or disable system notifications.
- **Prompt Behavior**: Customize autocompletion, command confirmation, and key bindings for the prompt field. See [Prompt Behavior](./prompt-behavior.md) for more details.

### Providers

Manage the API keys and connection settings for all supported Large Language Model (LLM) providers, such as OpenAI, Anthropic, Gemini, and more. This is where you connect ReactorPro to your AI models.

### Aider

Configure the underlying `aider-chat` engine.
- **Options**: Pass command-line arguments directly to Aider.
- **Environment Variables**: Set environment variables for the Aider process.
- **Context**: Control automatic inclusion of rule files.
For more details, see [Aider Configuration](./aider-configuration.md).

### Agent

Configure the powerful Agent Mode.
- **Agent Profiles**: Create and manage different profiles for the agent, each with its own model, tools, and behaviors.
- **MCP Servers**: Add and manage external tools via MCP servers.
- **Tool Approvals**: Set permissions for each tool on a per-profile basis.
See [Agent Mode](../agent-mode/agent-mode.md) and [MCP Servers](../agent-mode/mcp-servers.md) for more information.

### Memory

Configure the built-in long-term Memory system.
- **Enable/disable Memory**
- **Embedding model selection** and similarity tuning
- **View and delete stored memories**
See [Memory](../features/memory.md) for details.

### About

View version information for ReactorPro and the integrated Aider library.
- **Check for Updates**: Manually trigger an update check.
- **Automatic Updates**: Enable or disable automatic downloading of ReactorPro updates.
- **Logs**: Open the directory containing application logs for troubleshooting.
See [Automatic Updates](./automatic-updates.md) for more details.
