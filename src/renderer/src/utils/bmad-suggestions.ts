import { BMAD_WORKFLOWS } from '@common/bmad-workflows';
import { ArtifactDetectionResult, SprintStatusData, StoryStatus, WorkflowMetadata } from '@common/bmad-types';

/**
 * Simple glob pattern matching for artifact paths
 */
const matchesPattern = (pathToMatch: string, pattern: string): boolean => {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*/g, '.*'); // Replace * with .*

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(pathToMatch);
};

/**
 * Calculate prerequisite satisfaction score for a workflow
 * Higher score = more prerequisites satisfied
 */
const getPrerequisiteScore = (workflow: WorkflowMetadata | undefined, detectedArtifacts: ArtifactDetectionResult['detectedArtifacts']): number => {
  if (!workflow?.requiredArtifacts || workflow.requiredArtifacts.length === 0) {
    // No prerequisites = high priority
    return 100;
  }

  // Check how many prerequisites are satisfied
  let satisfiedCount = 0;
  const totalRequired = workflow.requiredArtifacts.length;

  workflow.requiredArtifacts.forEach((requiredPattern) => {
    // Check if any detected artifact matches the required pattern
    const hasMatch = Object.values(detectedArtifacts).some((artifact) => matchesPattern(artifact.path, requiredPattern));
    if (hasMatch) {
      satisfiedCount++;
    }
  });

  // Return percentage of satisfied prerequisites
  return (satisfiedCount / totalRequired) * 100;
};

const STORY_STATUS_TO_WORKFLOW: Record<StoryStatus, string | null> = {
  [StoryStatus.Backlog]: 'create-story',
  [StoryStatus.ReadyForDev]: 'dev-story',
  [StoryStatus.InProgress]: null,
  [StoryStatus.Review]: 'code-review',
  [StoryStatus.Done]: null,
};

/**
 * Get workflow suggestions based on story statuses in sprint-status.yaml
 */
const getSprintStatusSuggestions = (sprintStatus: SprintStatusData | undefined): string[] => {
  if (!sprintStatus?.storyStatuses.length) {
    return [];
  }

  const suggestions = new Set<string>();

  for (const status of sprintStatus.storyStatuses) {
    const workflow = STORY_STATUS_TO_WORKFLOW[status];
    if (workflow) {
      suggestions.add(workflow);
    }
  }

  return Array.from(suggestions);
};

/**
 * Generate smart workflow suggestions based on completed workflows and detected artifacts
 * Implements greenfield/brownfield detection and prerequisite checking
 */
export const generateSuggestions = (
  completedWorkflows: string[],
  detectedArtifacts: ArtifactDetectionResult['detectedArtifacts'],
  sprintStatus?: SprintStatusData,
): string[] => {
  // No workflows completed - suggest entry points
  if (completedWorkflows.length === 0) {
    return ['create-product-brief', 'quick-spec'];
  }

  // Collect followUps from completed workflows
  const followUpSet = new Set<string>();
  completedWorkflows.forEach((workflowId) => {
    const workflow = BMAD_WORKFLOWS.find((w) => w.id === workflowId);
    if (workflow?.followUps) {
      workflow.followUps.forEach((followUp) => followUpSet.add(followUp));
    }
  });

  // Add suggestions based on story statuses in sprint-status.yaml
  const sprintSuggestions = getSprintStatusSuggestions(sprintStatus);
  sprintSuggestions.forEach((suggestion) => followUpSet.add(suggestion));

  // Filter out already completed workflows
  const suggestions = Array.from(followUpSet).filter((workflowId) => !completedWorkflows.includes(workflowId));

  // Sort suggestions: workflows with satisfied prerequisites first
  return suggestions.sort((a, b) => {
    const workflowA = BMAD_WORKFLOWS.find((w) => w.id === a);
    const workflowB = BMAD_WORKFLOWS.find((w) => w.id === b);

    const scoreA = getPrerequisiteScore(workflowA, detectedArtifacts);
    const scoreB = getPrerequisiteScore(workflowB, detectedArtifacts);

    // Higher score first (more prerequisites satisfied)
    return scoreB - scoreA;
  });
};
