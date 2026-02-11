import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

import { v4 as uuidv4 } from 'uuid';
import { BMAD_WORKFLOWS } from '@common/bmad-workflows';

import { ArtifactDetector } from './artifact-detector';
import { ContextPreparer } from './context-preparer';

import type { BmadError, BmadStatus, InstallResult, WorkflowExecutionResult } from '@common/bmad-types';
import type { Task } from '@/task';
import type { ContextFile } from '@common/types';

import logger from '@/logger';

export class BmadManager {
  private readonly artifactDetector: ArtifactDetector;

  constructor(private readonly projectDir: string) {
    this.artifactDetector = new ArtifactDetector();
  }

  checkInstallation(): boolean {
    try {
      const bmadPath = path.join(this.projectDir, '_bmad', 'bmm');
      return fs.existsSync(bmadPath);
    } catch (error) {
      logger.error('BMAD installation check failed', { error });
      return false;
    }
  }

  getVersion(): string | undefined {
    try {
      const configPath = path.join(this.projectDir, '_bmad', 'bmm', 'config.yaml');
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const lines = configContent.split('\n');

        for (const line of lines) {
          if (line.startsWith('# Version:')) {
            return line.split(':')[1].trim();
          }
        }
      }
      return undefined;
    } catch (error) {
      logger.error('BMAD version detection failed', { error });
      return undefined;
    }
  }

  async getBmadStatus(): Promise<BmadStatus> {
    const installed = this.checkInstallation();
    const version = installed ? this.getVersion() : undefined;

    // Detect completed workflow artifacts
    const detectionResult = await this.artifactDetector.detect(this.projectDir);

    return {
      projectDir: this.projectDir,
      installed,
      version,
      availableWorkflows: BMAD_WORKFLOWS,
      completedWorkflows: detectionResult.completedWorkflows,
      inProgressWorkflows: detectionResult.inProgressWorkflows,
      detectedArtifacts: detectionResult,
    };
  }

  async install(): Promise<InstallResult> {
    try {
      // Check for legacy BMAD v4 folder (.bmad-method)
      const legacyV4Path = path.join(this.projectDir, '.bmad-method');
      if (fs.existsSync(legacyV4Path)) {
        const bmadError: BmadError = {
          errorCode: 'BMAD_INSTALL_FAILED',
          message: 'Legacy BMAD v4 installation detected. Please remove the .bmad-method folder and try again.',
          recoveryAction: 'Remove the .bmad-method folder from your project directory, then retry installation.',
        };
        throw bmadError;
      }

      // Get safe username for config
      let safeUsername: string;
      try {
        const username = os.userInfo().username;
        safeUsername = username.charAt(0).toUpperCase() + username.slice(1);
      } catch {
        safeUsername = process.env.USER || process.env.USERNAME || 'User';
      }

      // Determine if this is a reinstall/update
      const isReinstall = this.checkInstallation();

      // Build npx command with non-interactive flags
      const commandParts = [
        'npx',
        '-y', // Auto-confirm npx
        'bmad-method@latest',
        'install',
        `--directory ${this.projectDir}`,
        '--modules bmm',
        '--tools none',
        `--user-name "${safeUsername}"`,
        '--communication-language English',
        '--document-output-language English',
        '--output-folder _bmad-output',
      ];

      // Add action flag if updating
      if (isReinstall) {
        commandParts.push('--action update');
      }

      commandParts.push('--yes'); // Accept all defaults and skip prompts

      const command = commandParts.join(' ');

      logger.info('Installing BMAD using npx', {
        command,
        isReinstall,
        directory: this.projectDir,
      });

      // Execute the npx command
      const execAsync = promisify(exec);
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.projectDir,
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      if (stderr) {
        logger.warn('BMAD installation stderr output', { stderr });
      }

      logger.debug('BMAD installation stdout', { stdout });

      // Verify installation
      const installed = this.checkInstallation();
      if (!installed) {
        throw new Error('Installation verification failed - BMAD directory not detected');
      }

      const version = this.getVersion();
      logger.info('BMAD installation completed', {
        version,
        actionType: isReinstall ? 'update' : 'install',
      });

      return {
        success: true,
        version,
        message: isReinstall ? 'BMAD updated successfully' : 'BMAD installed successfully',
      };
    } catch (error: unknown) {
      logger.error('BMAD installation failed', { error });

      const bmadError: BmadError = {
        errorCode: 'BMAD_INSTALL_FAILED',
        message: `Failed to install BMAD: ${error instanceof Error ? error.message : String(error)}`,
        recoveryAction: this.getRecoveryAction(error),
        details: error instanceof Error ? error.stack : String(error),
      };

      throw bmadError;
    }
  }

  private getRecoveryAction(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as { code: string }).code;

      switch (code) {
        case 'EACCES':
        case 'EPERM':
          return 'Check write permissions for project directory';
        case 'ENOSPC':
          return 'Free up disk space and retry installation';
        case 'ENOENT':
          return 'Ensure BMAD library is bundled with application';
        default:
          break;
      }
    }

    return 'Try restarting the application and retry installation';
  }

  /**
   * Execute a BMAD workflow via Agent Mode
   * @param workflowId - ID of the workflow to execute
   * @param task - Task instance for Agent Mode execution
   * @returns Workflow execution result with success status
   */
  /**
   * Reset BMAD workflow state by clearing the _bmad-output directory
   * @returns Promise resolving to success status
   */
  async resetWorkflow(): Promise<{ success: boolean; message?: string }> {
    try {
      const outputDir = path.join(this.projectDir, '_bmad-output');

      // Check if directory exists
      if (!fs.existsSync(outputDir)) {
        logger.info('BMAD output directory does not exist, nothing to reset');
        return {
          success: true,
          message: 'No workflow state to reset',
        };
      }

      // Remove the directory recursively
      await fsPromises.rm(outputDir, { recursive: true, force: true });

      logger.info('BMAD workflow state reset successfully', { outputDir });

      return {
        success: true,
        message: 'Workflow state reset successfully',
      };
    } catch (error) {
      logger.error('Failed to reset BMAD workflow state', { error });

      return {
        success: false,
        message: `Failed to reset workflow state: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async executeWorkflow(workflowId: string, task: Task): Promise<WorkflowExecutionResult> {
    try {
      const workflow = BMAD_WORKFLOWS.find((w) => w.id === workflowId);
      if (!workflow) {
        throw new Error(`Workflow '${workflowId}' not found in registry`);
      }

      // 1. Get current BMAD status
      const status = await this.getBmadStatus();

      // 2. Prepare context using ContextPreparer
      const preparer = new ContextPreparer(this.projectDir);
      const preparedContext = await preparer.prepare(workflowId, status);

      logger.info('Context prepared for workflow execution', {
        workflowId,
        contextFilesCount: preparedContext.contextFiles.length,
      });

      // 3. Execute workflow via Agent Mode
      const agentProfile = await task.getTaskAgentProfile();
      if (!agentProfile) {
        throw new Error('No agent profile configured for this task');
      }

      const promptContext = { id: uuidv4() };

      logger.info('Executing workflow via Agent Mode', {
        workflowId,
        agentProfile: agentProfile.name,
      });

      const contextFiles: ContextFile[] = preparedContext.contextFiles.map((filePath) => ({
        path: filePath,
        readOnly: true,
      }));

      // Store prepared context messages in task context and send to UI
      if (preparedContext.contextMessages.length > 0) {
        await task.loadContextMessages(preparedContext.contextMessages);
        logger.info('Prepared context messages loaded into task context', {
          workflowId,
          contextMessagesCount: preparedContext.contextMessages.length,
        });
      }

      if (!task.task.name) {
        await task.saveTask({ name: workflow.name });
      }

      if (preparedContext.execute) {
        task.addLogMessage('loading');
        await task.runPromptInAgent(
          agentProfile,
          null, // No user prompt - workflow is system-driven
          promptContext,
          preparedContext.contextMessages,
          contextFiles,
        );
      }

      logger.info('Workflow execution completed', { workflowId });

      // 4. Return success
      return {
        success: true,
      };
    } catch (error) {
      logger.error('Workflow execution failed:', { workflowId, error });

      // Determine error code based on error type
      let errorCode = 'WORKFLOW_EXECUTION_FAILED';
      let recoveryAction = 'Check workflow configuration and retry';

      if (error instanceof Error) {
        if (error.message.includes('agent profile')) {
          errorCode = 'AGENT_PROFILE_MISSING';
          recoveryAction = 'Configure an agent profile for this task';
        } else if (
          error.message.includes('Workflow definition') ||
          error.message.includes('Workflow not found') ||
          error.message.includes('WORKFLOW_NOT_FOUND')
        ) {
          errorCode = 'WORKFLOW_DEFINITION_MISSING';
          recoveryAction = 'Ensure BMAD library is installed and workflow exists';
        }
      }

      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          errorCode,
          recoveryAction,
        },
      };
    }
  }
}
