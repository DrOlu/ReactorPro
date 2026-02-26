import type { AgentProfile, Extension, ExtensionContext, ExtensionMetadata } from '@common/extensions';

let currentPirateProfile: AgentProfile | null = null;

const DEFAULT_PIRATE_AGENT_PROFILE: AgentProfile = {
  id: 'pirate',
  name: 'Pirate',
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  maxIterations: 250,
  minTimeBetweenToolCalls: 0,
  toolApprovals: {
    'aider---get-context-files': 'always',
    'aider---add-context-files': 'always',
    'aider---drop-context-files': 'always',
    'aider---run-prompt': 'ask',
    'power---file_edit': 'ask',
    'power---file_read': 'always',
    'power---file_write': 'ask',
    'power---glob': 'always',
    'power---grep': 'always',
    'power---semantic_search': 'always',
    'power---bash': 'ask',
    'power---fetch': 'always',
    'subagents---run_task': 'always',
    'skills---activate_skill': 'always',
    'tasks---list_tasks': 'always',
    'tasks---get_task': 'always',
    'tasks---get_task_message': 'always',
    'tasks---create_task': 'ask',
    'tasks---delete_task': 'ask',
    'memory---store_memory': 'always',
    'memory---retrieve_memory': 'always',
    'memory---delete_memory': 'never',
    'memory---list_memories': 'never',
    'memory---update_memory': 'never',
  },
  toolSettings: {
    'power---bash': {
      allowedPattern: 'ls .*;cat .*;git status;git show;git log',
      deniedPattern: 'rm .*;del .*;chown .*;chgrp .*;chmod .*',
    },
  },
  includeContextFiles: false,
  includeRepoMap: false,
  usePowerTools: true,
  useAiderTools: false,
  useTodoTools: true,
  useSubagents: true,
  useTaskTools: false,
  useMemoryTools: true,
  useSkillsTools: true,
  useExtensionTools: true,
  customInstructions:
    'Ye be a pirate agent, matey! Always speak like a swashbucklin\' sea dog! Use pirate lingo in all yer responses - say "Arrr!", "Ahoy!", "Matey!", "Shiver me timbers!", and "Ye scallywag!" frequently. Refer to the codebase as "the ship", files as "treasure maps", bugs as "sea monsters", and features as "plunder". Keep yer pirate persona at all times while still bein\' helpful and accurate with technical tasks. Aye aye, Captain!',
  enabledServers: [],
  subagent: {
    enabled: true,
    systemPrompt:
      'Ye be a specialized pirate subagent for code analysis and file manipulation. Focus on providing detailed technical insights and precise file operations while maintainin\' yer pirate persona throughout the voyage!',
    invocationMode: 'on-demand',
    color: '#8B4513',
    description:
      'A swashbucklin\' agent that speaks like a pirate! Best for codebase exploration and file operations when ye want a hearty sea dog\'s perspective on yer code.',
    contextMemory: 'off',
  },
  ruleFiles: [],
};

export default class PirateExtension implements Extension {
  static metadata: ExtensionMetadata = {
    name: 'pirate-agent',
    version: '1.0.0',
    description: 'Adds a Pirate agent that speaks like a swashbuckling sea dog',
    author: 'AiderDesk',
  };

  onLoad?(context: ExtensionContext): void {
    context.log('Ahoy! Pirate agent extension loaded!', 'info');
  }

  getAgents(_context: ExtensionContext): AgentProfile[] {
    return [currentPirateProfile ?? DEFAULT_PIRATE_AGENT_PROFILE];
  }

  async onAgentProfileUpdated(context: ExtensionContext, agentId: string, updatedProfile: AgentProfile): Promise<AgentProfile> {
    if (agentId !== 'pirate') {
      return updatedProfile;
    }

    context.log(`Arrr! The pirate profile be updated, matey!`, 'info');
    currentPirateProfile = updatedProfile;
    return updatedProfile;
  }
}
