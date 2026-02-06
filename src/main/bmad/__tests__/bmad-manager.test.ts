import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BMAD_WORKFLOWS } from '@common/bmad-workflows';

import { BmadManager } from '../bmad-manager';
import { ArtifactDetector } from '../artifact-detector';
import { ContextPreparer } from '../context-preparer';

import type { PreparedContext } from '../context-preparer';

vi.mock('fs');
vi.mock('fs/promises');
vi.mock('../artifact-detector');
vi.mock('../context-preparer');
vi.mock('@/paths', () => ({
  getResourceDir: vi.fn(() => '/fake/resources'),
  getDataDir: vi.fn(() => '/fake/data'),
}));
vi.mock('@/logger', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Setup default mock for ArtifactDetector
const mockDetect = vi.fn().mockResolvedValue({
  completedWorkflows: [],
  incompleteWorkflows: [],
  detectedArtifacts: {},
});

// Mock as a constructor
vi.mocked(ArtifactDetector).mockImplementation(function (this: ArtifactDetector) {
  (this as unknown as { detect: typeof mockDetect }).detect = mockDetect;
  return this as ArtifactDetector;
});

// Setup default mock for ContextPreparer
const mockPrepare = vi.fn().mockResolvedValue({
  contextMessages: [],
  contextFiles: [],
  execute: true,
} as PreparedContext);

vi.mocked(ContextPreparer).mockImplementation(function (this: unknown) {
  (this as { prepare: typeof mockPrepare }).prepare = mockPrepare;
  return this as ContextPreparer;
});

describe('BmadManager', () => {
  let bmadManager: BmadManager;
  const mockProjectPath = '/fake/project/path';

  beforeEach(() => {
    bmadManager = new BmadManager(mockProjectPath);
    vi.clearAllMocks();
    // Reset mock to default empty response
    mockDetect.mockResolvedValue({
      completedWorkflows: [],
      incompleteWorkflows: [],
      inProgressWorkflows: [],
      detectedArtifacts: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkInstallation', () => {
    it('returns true when BMAD library is installed', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const result = bmadManager.checkInstallation();

      expect(result).toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith(path.join(mockProjectPath, '_bmad', 'bmm'));
    });

    it('returns false when BMAD library is not installed', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const result = bmadManager.checkInstallation();

      expect(result).toBe(false);
    });

    it('returns false on file system error', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation(() => {
        throw new Error('File system error');
      });

      const result = bmadManager.checkInstallation();

      expect(result).toBe(false);
    });
  });

  describe('getVersion', () => {
    it('returns version string when config.yaml contains version comment', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('# Version: 6.0.0\nproject_name: test');

      const result = bmadManager.getVersion();

      expect(result).toBe('6.0.0');
    });

    it('returns undefined when config.yaml is missing', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const result = bmadManager.getVersion();

      expect(result).toBeUndefined();
    });

    it('returns undefined when config.yaml has no version comment', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('project_name: test\nuser_name: john');

      const result = bmadManager.getVersion();

      expect(result).toBeUndefined();
    });

    it('returns undefined on file read error', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('File read error');
      });

      const result = bmadManager.getVersion();

      expect(result).toBeUndefined();
    });
  });

  describe('getBmadStatus', () => {
    it('returns BmadStatus with installed=true and version when library present', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('# Version: 2.5.3\nproject_name: test');

      const result = await bmadManager.getBmadStatus();

      expect(result).toEqual({
        installed: true,
        version: '2.5.3',
        availableWorkflows: BMAD_WORKFLOWS,
        completedWorkflows: [],
        inProgressWorkflows: [],
        detectedArtifacts: {
          completedWorkflows: [],
          inProgressWorkflows: [],
          incompleteWorkflows: [],
          detectedArtifacts: {},
        },
      });
    });

    it('returns BmadStatus with installed=false and no version when library absent', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const result = await bmadManager.getBmadStatus();

      expect(result).toEqual({
        installed: false,
        version: undefined,
        availableWorkflows: BMAD_WORKFLOWS,
        completedWorkflows: [],
        inProgressWorkflows: [],
        detectedArtifacts: {
          completedWorkflows: [],
          inProgressWorkflows: [],
          incompleteWorkflows: [],
          detectedArtifacts: {},
        },
      });
    });

    it('returns completed workflows from artifact detection', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('# Version: 1.0.0\nproject_name: test');

      mockDetect.mockResolvedValue({
        completedWorkflows: ['create-prd', 'create-architecture'],
        incompleteWorkflows: [],
        detectedArtifacts: {
          'create-prd': { path: 'planning-artifacts/prd.md', stepsCompleted: ['1', '2'] },
          'create-architecture': { path: 'planning-artifacts/architecture.md' },
        },
      });

      const result = await bmadManager.getBmadStatus();

      expect(result.availableWorkflows).toEqual(BMAD_WORKFLOWS);
      expect(result.completedWorkflows).toEqual(['create-prd', 'create-architecture']);
      expect(result.detectedArtifacts.completedWorkflows).toEqual(['create-prd', 'create-architecture']);
      expect(result.detectedArtifacts.detectedArtifacts['create-prd']).toBeDefined();
    });

    it('handles version detection failure gracefully', async () => {
      vi.spyOn(fs, 'existsSync').mockImplementation((pathArg) => {
        if (pathArg.toString().includes('config.yaml')) {
          return false;
        }
        return true;
      });

      const result = await bmadManager.getBmadStatus();

      expect(result.installed).toBe(true);
      expect(result.version).toBeUndefined();
    });
  });

  describe('install', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns early if BMAD is already installed', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('# Version: 6.0.0\nproject_name: test');

      const result = await bmadManager.install();

      expect(result).toEqual({
        success: true,
        version: '6.0.0',
        message: 'BMAD already installed',
      });
      expect(fsPromises.cp).not.toHaveBeenCalled();
    });

    it('copies BMAD from resources to project directory', async () => {
      let existsSyncCallCount = 0;
      vi.spyOn(fs, 'existsSync').mockImplementation(() => {
        existsSyncCallCount++;
        return existsSyncCallCount > 1;
      });

      vi.spyOn(fs, 'readFileSync').mockReturnValue('# Version: 6.0.0\nproject_name: test');
      vi.mocked(fsPromises.cp).mockResolvedValue(undefined);

      const result = await bmadManager.install();

      expect(fsPromises.cp).toHaveBeenCalledWith('/fake/resources/_bmad', '/fake/project/path/_bmad', { recursive: true, force: false });
      expect(result).toEqual({
        success: true,
        version: '6.0.0',
        message: 'BMAD installed successfully',
      });
    });

    it('throws error when copy fails with EACCES', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const permissionError = Object.assign(new Error('Permission denied'), {
        code: 'EACCES',
      });
      vi.mocked(fsPromises.cp).mockRejectedValue(permissionError);

      await expect(bmadManager.install()).rejects.toMatchObject({
        errorCode: 'BMAD_INSTALL_FAILED',
        message: expect.stringContaining('Permission denied'),
        recoveryAction: 'Check write permissions for project directory',
      });
    });

    it('throws error when copy fails with ENOSPC', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const diskError = Object.assign(new Error('No space left on device'), {
        code: 'ENOSPC',
      });
      vi.mocked(fsPromises.cp).mockRejectedValue(diskError);

      await expect(bmadManager.install()).rejects.toMatchObject({
        errorCode: 'BMAD_INSTALL_FAILED',
        message: expect.stringContaining('No space'),
        recoveryAction: 'Free up disk space and retry installation',
      });
    });

    it('throws error when copy fails with ENOENT', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const notFoundError = Object.assign(new Error('Source not found'), {
        code: 'ENOENT',
      });
      vi.mocked(fsPromises.cp).mockRejectedValue(notFoundError);

      await expect(bmadManager.install()).rejects.toMatchObject({
        errorCode: 'BMAD_INSTALL_FAILED',
        message: expect.stringContaining('Source not found'),
        recoveryAction: 'Ensure BMAD library is bundled with application',
      });
    });

    it('throws error when verification fails after copy', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      vi.mocked(fsPromises.cp).mockResolvedValue(undefined);

      await expect(bmadManager.install()).rejects.toMatchObject({
        errorCode: 'BMAD_INSTALL_FAILED',
        message: expect.stringContaining('verification failed'),
      });
    });

    it('provides generic recovery action for unknown errors', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const unknownError = new Error('Unknown error');
      vi.mocked(fsPromises.cp).mockRejectedValue(unknownError);

      await expect(bmadManager.install()).rejects.toMatchObject({
        errorCode: 'BMAD_INSTALL_FAILED',
        recoveryAction: 'Try restarting the application and retry installation',
      });
    });

    it('handles cross-platform paths correctly', async () => {
      let existsSyncCallCount = 0;
      vi.spyOn(fs, 'existsSync').mockImplementation(() => {
        existsSyncCallCount++;
        return existsSyncCallCount > 1;
      });

      vi.spyOn(fs, 'readFileSync').mockReturnValue('# Version: 6.0.0\nproject_name: test');
      vi.mocked(fsPromises.cp).mockResolvedValue(undefined);

      await bmadManager.install();

      const cpCall = vi.mocked(fsPromises.cp).mock.calls[0];
      expect(cpCall[0]).toBe('/fake/resources/_bmad');
      expect(cpCall[1]).toBe('/fake/project/path/_bmad');
    });
  });

  describe('executeWorkflow', () => {
    const workflowId = 'create-prd';
    let mockTask: any;

    beforeEach(() => {
      vi.clearAllMocks();
      mockPrepare.mockResolvedValue({
        contextMessages: [],
        contextFiles: [],
        execute: true,
      } as PreparedContext);

      mockTask = {
        taskId: 'parent-task-123',
        task: {
          autoApprove: true,
          name: undefined,
        },
        getTaskAgentProfile: vi.fn().mockResolvedValue({
          name: 'Test Agent',
          provider: 'openai',
          model: 'gpt-4',
        }),
        runPromptInAgent: vi.fn().mockResolvedValue([{ content: 'Generated artifact content' }]),
        addLogMessage: vi.fn(),
        loadContextMessages: vi.fn().mockResolvedValue(undefined),
        saveTask: vi.fn().mockResolvedValue(undefined),
        getProject: vi.fn().mockReturnValue({
          createNewTask: vi.fn().mockResolvedValue({
            id: 'subtask-123',
            name: 'PRD - Step 2',
          }),
        }),
      };

      vi.mocked(fsPromises.readFile).mockResolvedValue('# Workflow Definition');
    });

    describe('executeWorkflow orchestration flow', () => {
      it('should define executeWorkflow method with correct signature', () => {
        expect(bmadManager.executeWorkflow).toBeDefined();
        expect(typeof bmadManager.executeWorkflow).toBe('function');
      });

      it('should accept workflowId and task parameters', async () => {
        await bmadManager.executeWorkflow(workflowId, mockTask);
        expect(mockPrepare).toHaveBeenCalledWith(workflowId, expect.any(Object));
      });

      it('should return WorkflowExecutionResult with correct structure', async () => {
        const result = await bmadManager.executeWorkflow(workflowId, mockTask);
        expect(result).toHaveProperty('success');
        expect(typeof result.success).toBe('boolean');
      });
    });

    describe('context preparation integration', () => {
      it('should instantiate ContextPreparer', async () => {
        await bmadManager.executeWorkflow(workflowId, mockTask);
        expect(ContextPreparer).toHaveBeenCalled();
      });

      it('should call ContextPreparer.prepare() with correct parameters', async () => {
        await bmadManager.executeWorkflow(workflowId, mockTask);
        expect(mockPrepare).toHaveBeenCalledWith(workflowId, expect.any(Object));
      });
    });

    describe('execute workflow via Agent Mode', () => {
      it('should get agent profile from task', async () => {
        await bmadManager.executeWorkflow(workflowId, mockTask);
        expect(mockTask.getTaskAgentProfile).toHaveBeenCalled();
      });

      it('should call runPromptInAgent with correct parameters', async () => {
        const agentProfile = { name: 'Test Agent', provider: 'openai', model: 'gpt-4' };
        mockTask.getTaskAgentProfile.mockResolvedValue(agentProfile);

        await bmadManager.executeWorkflow(workflowId, mockTask);

        expect(mockTask.runPromptInAgent).toHaveBeenCalledWith(
          agentProfile,
          null,
          expect.objectContaining({ id: expect.any(String) }),
          expect.any(Array),
          expect.any(Array),
        );
      });

      it('should return error if no agent profile configured', async () => {
        mockTask.getTaskAgentProfile.mockResolvedValue(undefined);

        const result = await bmadManager.executeWorkflow(workflowId, mockTask);

        expect(result.success).toBe(false);
        expect(result.error?.errorCode).toBe('AGENT_PROFILE_MISSING');
      });

      it('should convert context files to ContextFile array with readOnly flag', async () => {
        mockPrepare.mockResolvedValue({
          contextMessages: [],
          contextFiles: ['/project/prd.md', '/project/architecture.md'],
          execute: true,
        } as PreparedContext);

        await bmadManager.executeWorkflow(workflowId, mockTask);

        expect(mockTask.runPromptInAgent).toHaveBeenCalledWith(
          expect.anything(),
          null,
          expect.anything(),
          expect.any(Array),
          expect.arrayContaining([
            { path: '/project/prd.md', readOnly: true },
            { path: '/project/architecture.md', readOnly: true },
          ]),
        );
      });

      it('should return success response on successful execution', async () => {
        const result = await bmadManager.executeWorkflow(workflowId, mockTask);

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it('should return error response with errorCode on failure', async () => {
        mockTask.getTaskAgentProfile.mockResolvedValue(undefined);

        const result = await bmadManager.executeWorkflow(workflowId, mockTask);

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error?.errorCode).toBe('AGENT_PROFILE_MISSING');
        expect(result.error?.recoveryAction).toBeDefined();
      });

      it('should not crash application on execution failure', async () => {
        mockTask.runPromptInAgent.mockRejectedValue(new Error('LLM API timeout'));

        const result = await bmadManager.executeWorkflow(workflowId, mockTask);

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });
    });

    describe('Quick Workflows Execution', () => {
      it('should execute Quick Spec workflow with correct metadata', async () => {
        const quickSpecWorkflow = BMAD_WORKFLOWS.find((w) => w.id === 'quick-spec');
        expect(quickSpecWorkflow).toBeDefined();

        vi.mocked(fsPromises.readFile).mockResolvedValue('# Quick Spec Workflow');

        const result = await bmadManager.executeWorkflow('quick-spec', mockTask);
        expect(result.success).toBe(true);
      });

      it('should execute Quick Dev workflow with correct metadata', async () => {
        const quickDevWorkflow = BMAD_WORKFLOWS.find((w) => w.id === 'quick-dev');
        expect(quickDevWorkflow).toBeDefined();

        vi.mocked(fsPromises.readFile).mockResolvedValue('# Quick Dev Workflow');

        const result = await bmadManager.executeWorkflow('quick-dev', mockTask);
        expect(result.success).toBe(true);
      });

      it('should return error for non-existent workflow', async () => {
        const result = await bmadManager.executeWorkflow('non-existent-workflow', mockTask);
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('not found');
      });
    });

    describe('Error Handling', () => {
      it('should return WORKFLOW_DEFINITION_MISSING error for non-existent workflow', async () => {
        const result = await bmadManager.executeWorkflow('non-existent-workflow', mockTask);

        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('not found in registry');
      });

      it('should handle runPromptInAgent errors gracefully', async () => {
        mockTask.runPromptInAgent.mockRejectedValue(new Error('Network error'));

        const result = await bmadManager.executeWorkflow(workflowId, mockTask);

        expect(result.success).toBe(false);
        expect(result.error?.errorCode).toBe('WORKFLOW_EXECUTION_FAILED');
      });

      it('should handle context preparation errors gracefully', async () => {
        mockPrepare.mockRejectedValue(new Error('Context preparation failed'));

        const result = await bmadManager.executeWorkflow(workflowId, mockTask);

        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('Context preparation failed');
      });
    });
  });
});
