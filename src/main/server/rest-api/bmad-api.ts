import { Router } from 'express';
import { z } from 'zod';

import { BaseApi } from './base-api';

import { EventsHandler } from '@/events-handler';

// Request schemas
const GetStatusSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required').optional(),
});

const GetWorkflowsSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required').optional(),
});

const InstallSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required').optional(),
});

const ExecuteWorkflowSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
  workflowId: z.string().min(1, 'Workflow ID is required'),
  asSubtask: z.boolean().optional(),
  options: z
    .object({
      resumeFromStep: z.number().optional(),
    })
    .optional(),
});

export class BmadApi extends BaseApi {
  constructor(private readonly eventsHandler: EventsHandler) {
    super();
  }

  registerRoutes(router: Router): void {
    // Get BMAD status
    router.get(
      '/bmad/status',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(GetStatusSchema, req.query, res);
        if (!parsed) {
          return;
        }

        const status = await this.eventsHandler.getBmadStatus();
        res.status(200).json(status);
      }),
    );

    // Install BMAD library
    router.post(
      '/bmad/install',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(InstallSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const result = await this.eventsHandler.installBmad();
        res.status(200).json(result);
      }),
    );

    // Get BMAD workflows
    router.get(
      '/bmad/workflows',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(GetWorkflowsSchema, req.query, res);
        if (!parsed) {
          return;
        }

        const workflows = await this.eventsHandler.getBmadWorkflows();
        res.status(200).json(workflows);
      }),
    );

    // Execute BMAD workflow
    router.post(
      '/bmad/execute-workflow',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(ExecuteWorkflowSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId, workflowId, asSubtask } = parsed;
        const result = await this.eventsHandler.executeWorkflow(projectDir, taskId, workflowId, asSubtask);

        if (result.success) {
          res.status(200).json(result);
        } else {
          res.status(500).json(result);
        }
      }),
    );

    // Reset BMAD workflow (clear _bmad-output folder)
    router.post(
      '/bmad/reset-workflow',
      this.handleRequest(async (_, res) => {
        const result = await this.eventsHandler.resetBmadWorkflow();

        if (result.success) {
          res.status(200).json(result);
        } else {
          res.status(500).json(result);
        }
      }),
    );
  }
}
