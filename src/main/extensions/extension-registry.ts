import { Extension, ExtensionMetadata, ToolDefinition, CommandDefinition, ModeDefinition } from '@common/extensions';

import type { AgentProfile } from '@common/types';

import logger from '@/logger';

export interface LoadedExtension {
  instance: Extension;
  metadata: ExtensionMetadata;
  filePath: string;
  initialized: boolean;
  projectDir?: string;
}

export interface RegisteredTool {
  extensionName: string;
  tool: ToolDefinition;
}

export interface RegisteredCommand {
  extensionName: string;
  command: CommandDefinition;
}

export interface RegisteredAgent {
  extensionName: string;
  agent: AgentProfile;
}

export interface RegisteredMode {
  extensionName: string;
  mode: ModeDefinition;
}

export class ExtensionRegistry {
  private extensions = new Map<string, LoadedExtension>();
  private tools = new Map<string, RegisteredTool>();
  private commands = new Map<string, RegisteredCommand>();
  private agents = new Map<string, RegisteredAgent>();
  private modes = new Map<string, RegisteredMode>();

  register(extension: Extension, metadata: ExtensionMetadata, filePath: string, projectDir?: string) {
    logger.info(`[Extensions] Registering extension: ${metadata.name}`);
    this.extensions.set(metadata.name, { instance: extension, metadata, filePath, initialized: false, projectDir });
  }

  setInitialized(name: string, initialized: boolean): void {
    const extension = this.extensions.get(name);
    if (extension) {
      logger.info(`[Extensions] Set initialized: ${name} to ${initialized}`);
      extension.initialized = initialized;
    } else {
      logger.warn(`[Extensions] Failed to set initialized: ${name} to ${initialized}, extension not found`);
    }
  }

  getExtensions(projectDir?: string): LoadedExtension[] {
    if (projectDir) {
      return Array.from(this.extensions.values()).filter((ext) => ext.projectDir === projectDir || !ext.projectDir);
    }
    return Array.from(this.extensions.values());
  }

  getExtension(name: string): LoadedExtension | undefined {
    return this.extensions.get(name);
  }

  unregister(name: string): boolean {
    logger.info(`[Extensions] Unregistering extension: ${name}`);
    for (const [toolKey, registered] of this.tools) {
      if (registered.extensionName === name) {
        this.tools.delete(toolKey);
      }
    }
    for (const [commandKey, registered] of this.commands) {
      if (registered.extensionName === name) {
        this.commands.delete(commandKey);
      }
    }
    for (const [agentKey, registered] of this.agents) {
      if (registered.extensionName === name) {
        this.agents.delete(agentKey);
      }
    }
    for (const [modeKey, registered] of this.modes) {
      if (registered.extensionName === name) {
        this.modes.delete(modeKey);
      }
    }
    return this.extensions.delete(name);
  }

  clear() {
    this.extensions.clear();
    this.tools.clear();
    this.commands.clear();
    this.agents.clear();
    this.modes.clear();
  }

  registerTool(extensionName: string, tool: ToolDefinition): void {
    logger.info(`[Extensions] Registered tool '${tool.name}' from extension '${extensionName}'`);
    const toolKey = `${extensionName}:${tool.name}`;
    this.tools.set(toolKey, { extensionName, tool });
  }

  getTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  getToolsByExtension(extensionName: string): RegisteredTool[] {
    return Array.from(this.tools.values()).filter((registered) => registered.extensionName === extensionName);
  }

  clearTools(): void {
    logger.info('[Extensions] Cleared all tools');
    this.tools.clear();
  }

  registerCommand(extensionName: string, command: CommandDefinition): void {
    logger.info(`[Extensions] Registered command '${command.name}' from extension '${extensionName}'`);
    const commandKey = `${extensionName}:${command.name}`;
    this.commands.set(commandKey, { extensionName, command });
  }

  getCommands(): RegisteredCommand[] {
    return Array.from(this.commands.values());
  }

  getCommandsByExtension(extensionName: string): RegisteredCommand[] {
    return Array.from(this.commands.values()).filter((registered) => registered.extensionName === extensionName);
  }

  getCommandByName(name: string): RegisteredCommand | undefined {
    for (const registered of this.commands.values()) {
      if (registered.command.name === name) {
        return registered;
      }
    }
    return undefined;
  }

  clearCommands(): void {
    logger.info('[Extensions] Cleared all commands');
    this.commands.clear();
  }

  registerAgent(extensionName: string, agent: AgentProfile): void {
    logger.info(`[Extensions] Registered agent '${agent.name}' from extension '${extensionName}'`);
    const agentKey = `${extensionName}:${agent.id}`;
    this.agents.set(agentKey, { extensionName, agent });
  }

  getAgents(): RegisteredAgent[] {
    return Array.from(this.agents.values());
  }

  getAgentsByExtension(extensionName: string): RegisteredAgent[] {
    return Array.from(this.agents.values()).filter((registered) => registered.extensionName === extensionName);
  }

  getAgentById(agentId: string): RegisteredAgent | undefined {
    for (const registered of this.agents.values()) {
      if (registered.agent.id === agentId) {
        return registered;
      }
    }
    return undefined;
  }

  clearAgents(): void {
    logger.info('[Extensions] Cleared all agents');
    this.agents.clear();
  }

  registerMode(extensionName: string, mode: ModeDefinition): void {
    logger.info(`[Extensions] Registered mode '${mode.name}' from extension '${extensionName}'`);
    const modeKey = `${extensionName}:${mode.name}`;
    this.modes.set(modeKey, { extensionName, mode });
  }

  getModes(): RegisteredMode[] {
    return Array.from(this.modes.values());
  }

  getModesByExtension(extensionName: string): RegisteredMode[] {
    return Array.from(this.modes.values()).filter((registered) => registered.extensionName === extensionName);
  }

  getModeByName(name: string): RegisteredMode | undefined {
    for (const registered of this.modes.values()) {
      if (registered.mode.name === name) {
        return registered;
      }
    }
    return undefined;
  }

  clearModes(): void {
    logger.info('[Extensions] Cleared all modes');
    this.modes.clear();
  }
}
