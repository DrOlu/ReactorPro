import { BmadStatus } from '@common/bmad-types';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useApi } from '@/contexts/ApiContext';
import { generateSuggestions } from '@/utils/bmad-suggestions';

type BmadStateType = {
  status: BmadStatus | null;
  suggestedWorkflows: string[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export const useBmadState = (): BmadStateType => {
  const [status, setStatus] = useState<BmadStatus | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const api = useApi();

  const suggestedWorkflows = useMemo(() => {
    if (!status) {
      return [];
    }
    return generateSuggestions(status.completedWorkflows, status.detectedArtifacts.detectedArtifacts, status.detectedArtifacts.sprintStatus);
  }, [status]);

  const loadBmadStatus = useCallback(async () => {
    setError(null);

    try {
      const bmadStatus = await api.getBmadStatus();
      setStatus(bmadStatus);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch BMAD status:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  const refresh = useCallback(async () => {
    await loadBmadStatus();
  }, [loadBmadStatus]);

  useEffect(() => {
    void loadBmadStatus();
  }, [loadBmadStatus]);

  // Otherwise, use standalone state (for components outside BmadWorkflowPage)
  return { status, suggestedWorkflows, isLoading, error, refresh };
};
