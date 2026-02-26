import { describe, it, expect, beforeEach } from 'vitest';
import { Extension, ExtensionMetadata } from '@common/extensions';
import { ContextMemoryMode, InvocationMode } from '@common/types';

import { ExtensionRegistry } from '../extension-registry';

import type { AgentProfile } from '@common/types';

describe('ExtensionRegistry', () => {
  let registry: ExtensionRegistry;
  let mockExtension: Extension;
  let mockMetadata: ExtensionMetadata;

  beforeEach(() => {
    registry = new ExtensionRegistry();
    mockExtension = {} as Extension;
    mockMetadata = {
      name: 'test-ext',
      version: '1.0.0',
      description: 'Test extension',
      author: 'Tester',
    };
  });

  it('should register and retrieve an extension', () => {
    registry.register(mockExtension, mockMetadata, '/path/to/ext.ts');

    const extension = registry.getExtension('test-ext');
    expect(extension).toBeDefined();
    expect(extension?.instance).toBe(mockExtension);
    expect(extension?.metadata).toEqual(mockMetadata);
    expect(extension?.filePath).toBe('/path/to/ext.ts');
    expect(extension?.initialized).toBe(false);
  });

  it('should set initialized status for an extension', () => {
    registry.register(mockExtension, mockMetadata, '/path/to/ext.ts');

    registry.setInitialized('test-ext', true);
    expect(registry.getExtension('test-ext')?.initialized).toBe(true);

    registry.setInitialized('test-ext', false);
    expect(registry.getExtension('test-ext')?.initialized).toBe(false);
  });

  it('should not throw when setting initialized for unknown extension', () => {
    expect(() => registry.setInitialized('unknown-ext', true)).not.toThrow();
  });

  it('should return undefined for unknown extension', () => {
    const extension = registry.getExtension('unknown-ext');
    expect(extension).toBeUndefined();
  });

  it('should return all registered extensions', () => {
    registry.register(mockExtension, mockMetadata, '/path/1');
    const meta2 = { ...mockMetadata, name: 'other-ext' };
    registry.register(mockExtension, meta2, '/path/2');

    const extensions = registry.getExtensions();
    expect(extensions).toHaveLength(2);
    expect(extensions.some((e) => e.metadata.name === 'test-ext')).toBe(true);
    expect(extensions.some((e) => e.metadata.name === 'other-ext')).toBe(true);
  });

  it('should clear all extensions', () => {
    registry.register(mockExtension, mockMetadata, '/path/1');
    registry.clear();
    expect(registry.getExtensions()).toHaveLength(0);
  });

  describe('Agent Registration', () => {
    let mockAgent: AgentProfile;

    beforeEach(() => {
      mockAgent = {
        id: 'test-agent-id',
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        maxIterations: 10,
        minTimeBetweenToolCalls: 0,
        enabledServers: [],
        toolApprovals: {},
        toolSettings: {},
        includeContextFiles: true,
        includeRepoMap: true,
        usePowerTools: false,
        useAiderTools: false,
        useTodoTools: false,
        useSubagents: false,
        useTaskTools: false,
        useMemoryTools: false,
        useSkillsTools: false,
        useExtensionTools: false,
        customInstructions: '',
        subagent: {
          enabled: false,
          contextMemory: ContextMemoryMode.Off,
          systemPrompt: '',
          invocationMode: InvocationMode.OnDemand,
          color: '#000000',
          description: '',
        },
      };
    });

    it('should register and retrieve an agent', () => {
      registry.registerAgent('test-ext', mockAgent);

      const agents = registry.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].extensionName).toBe('test-ext');
      expect(agents[0].agent).toEqual(mockAgent);
    });

    it('should get agents by extension name', () => {
      const mockAgent2 = { ...mockAgent, id: 'test-agent-2', name: 'Test Agent 2' };
      registry.registerAgent('test-ext', mockAgent);
      registry.registerAgent('test-ext', mockAgent2);
      registry.registerAgent('other-ext', { ...mockAgent, id: 'other-agent' });

      const agents = registry.getAgentsByExtension('test-ext');
      expect(agents).toHaveLength(2);
      expect(agents.every((a) => a.extensionName === 'test-ext')).toBe(true);
    });

    it('should clear all agents', () => {
      registry.registerAgent('test-ext', mockAgent);
      registry.clearAgents();
      expect(registry.getAgents()).toHaveLength(0);
    });

    it('should clear agents when unregistering extension', () => {
      registry.register(mockExtension, mockMetadata, '/path/to/ext.ts');
      registry.registerAgent('test-ext', mockAgent);

      registry.unregister('test-ext');

      expect(registry.getAgents()).toHaveLength(0);
    });

    it('should clear agents when clearing registry', () => {
      registry.register(mockExtension, mockMetadata, '/path/to/ext.ts');
      registry.registerAgent('test-ext', mockAgent);

      registry.clear();

      expect(registry.getAgents()).toHaveLength(0);
    });
  });
});
