import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { BmadStatus } from '@common/bmad-types';

import { useApi } from '@/contexts/ApiContext';
import { generateSuggestions } from '@/utils/bmad-suggestions';

type BmadStateContextType = {
  status: BmadStatus | null;
  suggestedWorkflows: string[];
  isLoading: boolean;
  error: string | null;
  refresh: (loading?: boolean) => Promise<void>;
};

const BmadStateContext = createContext<BmadStateContextType | null>(null);

type Props = {
  children: ReactNode;
  projectDir?: string;
};

export const BmadStateProvider = ({ children, projectDir }: Props) => {
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

  const loadBmadStatus = useCallback(
    async (loading = true) => {
      if (!projectDir) {
        setStatus(null);
        setIsLoading(false);
        return;
      }

      if (loading) {
        setStatus(null);
        setError(null);
        setIsLoading(true);
      }

      try {
        const bmadStatus = await api.getBmadStatus(projectDir);
        setStatus(bmadStatus);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to fetch BMAD status:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setIsLoading(false);
      }
    },
    [api, projectDir],
  );

  const refresh = useCallback(
    async (loading = true) => {
      await loadBmadStatus(loading);
    },
    [loadBmadStatus],
  );

  useEffect(() => {
    void loadBmadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir]);

  useEffect(() => {
    if (!projectDir) {
      return;
    }

    const unsubscribe = api.addBmadStatusChangedListener(projectDir, (newStatus) => {
      setStatus(newStatus);
      setError(null);
      setIsLoading(false);
    });

    return () => {
      unsubscribe();
    };
  }, [api, projectDir]);

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

  if (!context) {
    throw new Error('useBmadState must be used within a BmadStateProvider');
  }

  return context;
};
