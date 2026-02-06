import { createContext, useContext, useCallback, useEffect, useMemo, useState, ReactNode } from 'react';
import { BmadStatus } from '@common/bmad-types';

import { useApi } from '@/contexts/ApiContext';
import { generateSuggestions } from '@/utils/bmad-suggestions';

type BmadStateContextType = {
  status: BmadStatus | null;
  suggestedWorkflows: string[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const BmadStateContext = createContext<BmadStateContextType | null>(null);

type Props = {
  children: ReactNode;
};

export const BmadStateProvider = ({ children }: Props) => {
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
    setIsLoading(true);
    setStatus(null);
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

  const value = useMemo(
    () => ({
      status,
      suggestedWorkflows,
      isLoading,
      error,
      refresh,
    }),
    [status, suggestedWorkflows, isLoading, error, refresh],
  );

  return <BmadStateContext.Provider value={value}>{children}</BmadStateContext.Provider>;
};

export const useBmadState = (): BmadStateContextType => {
  const context = useContext(BmadStateContext);

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
    setIsLoading(true);
    setStatus(null);
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
    // Only load if not using context
    if (!context) {
      void loadBmadStatus();
    }
  }, [context, loadBmadStatus]);

  // If we have a context provider, use the shared state
  if (context) {
    return context;
  }

  // Otherwise, use standalone state (for components outside BmadWorkflowPage)
  return { status, suggestedWorkflows, isLoading, error, refresh };
};
