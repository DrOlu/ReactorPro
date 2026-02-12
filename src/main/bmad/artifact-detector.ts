import * as path from 'path';
import * as fs from 'fs/promises';

import { glob } from 'glob';
import * as yaml from 'yaml';
import * as yamlFront from 'yaml-front-matter';
import { BMAD_WORKFLOWS } from '@common/bmad-workflows';
import { StoryStatus } from '@common/bmad-types';

import type { ArtifactDetectionResult, IncompleteWorkflowMetadata, SprintStatusData } from '@common/bmad-types';

import logger from '@/logger';

/**
 * Parses a step identifier to extract the step number.
 * Handles formats:
 * - Pure numbers: '1', '5', '12'
 * - Prefixed step IDs: 'step-01-document-discovery', 'step-5-analysis'
 * - Falls back to index + 1 for unrecognized formats
 *
 * @param stepId - The step identifier string
 * @param index - The index of the step in the array (used as fallback)
 * @returns The extracted step number
 */
const parseStepNumber = (stepId: string, index: number): number => {
  // Try pure number first
  const pureNumber = parseInt(stepId, 10);
  if (!isNaN(pureNumber)) {
    return pureNumber;
  }

  // Try to extract number from patterns like 'step-01-...' or 'step-1-...'
  const stepPattern = /^step-(\d+)/i;
  const match = stepId.match(stepPattern);
  if (match) {
    return parseInt(match[1], 10);
  }

  // Fallback to index + 1
  return index + 1;
};

const VALID_STORY_STATUSES: StoryStatus[] = [StoryStatus.Backlog, StoryStatus.ReadyForDev, StoryStatus.InProgress, StoryStatus.Review, StoryStatus.Done];

const isValidStoryStatus = (status: string): status is StoryStatus => {
  return VALID_STORY_STATUSES.includes(status as StoryStatus);
};

/**
 * ArtifactDetector scans the project directory for completed BMAD workflow artifacts
 * Uses a hybrid two-tier detection strategy:
 * - Tier 1: Fast file existence check using glob patterns
 * - Tier 2: Detailed state parsing via YAML frontmatter for resume capability
 */
export class ArtifactDetector {
  /**
   * Parses sprint-status.yaml and extracts story statuses (excluding epics and retrospectives)
   * Also determines which workflows are completed based on story statuses:
   * - 'dev-story' and 'code-review' are completed if all stories are 'done' (non-empty)
   * - 'create-story' is completed if there are no 'backlog' stories
   * @param projectRoot - Absolute path to the project root directory
   * @returns SprintStatusData with array of story statuses and completed workflows, or undefined if file doesn't exist
   */
  private async parseSprintStatus(projectRoot: string): Promise<SprintStatusData | undefined> {
    const sprintStatusPath = path.join(projectRoot, '_bmad-output/implementation-artifacts/sprint-status.yaml');

    try {
      const content = await fs.readFile(sprintStatusPath, 'utf-8');
      const parsed = yaml.parse(content) as { development_status?: Record<string, string> };

      if (!parsed?.development_status) {
        return undefined;
      }

      const storyStatuses: StoryStatus[] = [];

      for (const [key, status] of Object.entries(parsed.development_status)) {
        if (key.startsWith('epic') || key.endsWith('-retrospective')) {
          continue;
        }

        if (isValidStoryStatus(status)) {
          storyStatuses.push(status as StoryStatus);
        }
      }

      const completedWorkflows: string[] = [];

      if (storyStatuses.length > 0 && storyStatuses.every((status) => status === StoryStatus.Done)) {
        completedWorkflows.push('dev-story', 'code-review');
      }

      if (storyStatuses.length > 0 && !storyStatuses.includes(StoryStatus.Backlog)) {
        completedWorkflows.push('create-story');
      }

      return { storyStatuses, completedWorkflows };
    } catch {
      return undefined;
    }
  }

  /**
   * Detects completed workflow artifacts in the project
   * @param projectRoot - Absolute path to the project root directory
   * @returns Detection result with completed workflows and artifact details
   */
  async detect(projectRoot: string): Promise<ArtifactDetectionResult> {
    // Check if _bmad-output directory exists
    const outputDir = path.join(projectRoot, '_bmad-output');

    try {
      await fs.access(outputDir);
    } catch {
      // Directory doesn't exist or permission denied - return greenfield state
      return {
        completedWorkflows: [],
        inProgressWorkflows: [],
        detectedArtifacts: {},
      };
    }

    // Scan for artifacts using glob patterns from workflow registry
    const completedWorkflows: string[] = [];
    const inProgressWorkflows: string[] = [];
    const detectedArtifacts: ArtifactDetectionResult['detectedArtifacts'] = {};
    const incompleteWorkflows: IncompleteWorkflowMetadata[] = [];

    for (const workflow of BMAD_WORKFLOWS) {
      const { id, outputArtifact } = workflow;

      try {
        // Resolve glob pattern relative to project root
        const fullPattern = path.join(projectRoot, outputArtifact);

        // Use glob to find matching files
        const matches = await glob(fullPattern, {
          windowsPathsNoEscape: true,
        });

        if (matches.length > 0) {
          const artifactPath = matches[0];

          // Try to parse YAML frontmatter for stepsCompleted and status
          let stepsCompleted: string[] | undefined;
          let status: string | undefined;
          let frontmatterError: string | undefined;

          try {
            const content = await fs.readFile(artifactPath, 'utf-8');
            const { __content, ...properties } = yamlFront.loadFront(content);

            logger.debug('Parsed frontmatter', { parsed: properties });

            if (properties.stepsCompleted) {
              stepsCompleted = properties.stepsCompleted;
            }

            if (properties.status) {
              status = properties.status;
            }
          } catch (parseError) {
            // File read or YAML parse error - track corruption
            frontmatterError = parseError instanceof Error ? parseError.message : 'Unknown error parsing frontmatter';
            // Artifact is still detected (file existence), just no detailed state
          }

          // Store artifact details
          detectedArtifacts[id] = {
            path: artifactPath,
            ...(stepsCompleted && { stepsCompleted }),
            ...(status && { status }),
            ...(frontmatterError && { error: frontmatterError }),
          };

          // Determine completion status using workflow.totalSteps from registry
          const workflowTotalSteps = workflow.totalSteps;
          const stepsCompletedNumbers = stepsCompleted?.map((s, i) => parseStepNumber(s, i)) || [];
          const maxCompletedStep = stepsCompletedNumbers.length > 0 ? Math.max(...stepsCompletedNumbers) : 0;

          // Workflow is complete if:
          // 1. No stepsCompleted in frontmatter (legacy/simple artifact) - assume complete
          // 2. stepsCompleted exists and max step >= totalSteps from registry
          // 3. For quick-spec workflow: status is 'ready-for-dev'
          const isQuickSpecReadyForDevStatus = id === 'quick-spec' && status === 'ready-for-dev';
          const isQuickDevWithReadyStatus = id === 'quick-dev' && status === 'ready-for-dev';

          // quick-dev with ready-for-dev status is NOT complete (that status comes from quick-spec)
          const isLegacyComplete = !stepsCompleted && !isQuickDevWithReadyStatus;
          const isStepsComplete = maxCompletedStep >= workflowTotalSteps && !isQuickDevWithReadyStatus;
          const isFullyCompleted = isLegacyComplete || isStepsComplete || isQuickSpecReadyForDevStatus;

          logger.debug('Workflow completion status', {
            workflowId: id,
            stepsCompleted,
            maxCompletedStep,
            workflowTotalSteps,
            status,
            isLegacyComplete,
            isStepsComplete,
            isQuickSpecReadyForDevStatus,
            isQuickDevWithReadyStatus,
            isFullyCompleted,
          });

          if (isFullyCompleted) {
            completedWorkflows.push(id);
          } else {
            if (id === 'quick-dev' && detectedArtifacts['quick-spec']?.status === 'ready-for-dev') {
              // quick-dev is not in progress if quick-spec is ready-for-dev
              continue;
            }

            // Workflow is in progress
            inProgressWorkflows.push(id);

            // Also add to incompleteWorkflows for resume functionality
            try {
              const stats = await fs.stat(artifactPath);
              const nextStep = stepsCompletedNumbers.length === 0 ? 1 : maxCompletedStep + 1;

              incompleteWorkflows.push({
                workflowId: id,
                artifactPath,
                stepsCompleted: stepsCompletedNumbers,
                nextStep,
                lastModified: stats.mtime,
                ...(frontmatterError && { corrupted: true, corruptionError: frontmatterError }),
              });
            } catch {
              // Failed to get file stats - still mark as in progress but skip incompleteWorkflows entry
            }
          }
        }
      } catch {
        // Glob error - continue scanning other workflows
      }
    }

    const sprintStatus = await this.parseSprintStatus(projectRoot);

    if (sprintStatus) {
      for (const workflowId of sprintStatus.completedWorkflows) {
        if (!completedWorkflows.includes(workflowId)) {
          completedWorkflows.push(workflowId);
        }
      }
    }

    return {
      completedWorkflows,
      inProgressWorkflows,
      detectedArtifacts,
      incompleteWorkflows,
      sprintStatus,
    };
  }
}
