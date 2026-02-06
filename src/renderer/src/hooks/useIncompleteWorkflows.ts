import { IncompleteWorkflowMetadata } from '@common/bmad-types';
import { useMemo } from 'react';

import { useBmadState } from './useBmadState';

/**
 * Hook to access incomplete workflows from BMAD status
 * Returns array of incomplete workflows that can be resumed
 */
export const useIncompleteWorkflows = () => {
  const { status } = useBmadState();

  const incompleteWorkflows = useMemo<IncompleteWorkflowMetadata[]>(() => {
    return status?.detectedArtifacts?.incompleteWorkflows || [];
  }, [status]);

  return { incompleteWorkflows };
};
