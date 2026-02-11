import Handlebars from 'handlebars';
import { ContextMessage } from '@common/types';

import type { BmadStatus } from '@common/bmad-types';

import logger from '@/logger';

export interface PreparedContext {
  contextMessages: ContextMessage[];
  contextFiles: string[];
  execute: boolean;
}

/**
 * ContextPreparer prepares context for workflow execution based on current BMAD status
 */
export class ContextPreparer {
  constructor(private readonly projectDir: string) {}

  /**
   * Prepare context for workflow execution
   * @param workflowId - ID of the workflow to prepare context for
   * @param status - Current BMAD status with workflow and artifact information
   * @returns Prepared context with messages and file paths
   */
  async prepare(workflowId: string, status: BmadStatus): Promise<PreparedContext> {
    // will be used in the future
    void status;

    const context: PreparedContext = {
      contextMessages: [],
      contextFiles: [],
      execute: true,
    };

    // Inject context messages based on workflow ID
    await this.injectContextMessages(workflowId, context);

    return context;
  }

  private async injectContextMessages(workflowId: string, context: PreparedContext) {
    // Try to load .json.hbs template first, fall back to .json
    const templateLoaded = await this.tryLoadTemplate(workflowId, context);
    if (templateLoaded) {
      logger.debug('Context template loaded.', { workflowId });
    } else {
      logger.warn('Context template not found.', { workflowId });
    }
  }

  private async tryLoadTemplate(workflowId: string, context: PreparedContext): Promise<boolean> {
    try {
      const module = await import(`./context/${workflowId}.json.hbs?raw`);
      const templateSource = module.default ?? module;

      logger.debug('Context template found', { workflowId });

      const template = Handlebars.compile(templateSource, {
        noEscape: true,
      });

      const rendered = template({ projectDir: this.projectDir });
      const messages = JSON.parse(rendered) as ContextMessage[];

      context.contextMessages = messages.map((msg) => ({ ...msg }));

      // Special case: research workflow doesn't auto-execute
      if (workflowId === 'research') {
        context.execute = false;
      }

      return true;
    } catch (error) {
      logger.error('Failed to load context template', { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
}
