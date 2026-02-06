import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { BmadStatus } from '@common/bmad-types';

import { useBmadState } from '../useBmadState';

import * as ApiContext from '@/contexts/ApiContext';

/**
 * Integration tests for useBmadState hook - State Refresh
 * These tests validate cross-session state refresh behavior:
 * - Hook refreshes state on mount (simulating app restart)
 * - Refresh function triggers state update after workflow execution
 * - Error handling during state refresh
 */
describe('useBmadState - State Refresh Integration', () => {
  let mockGetBmadStatus: Mock;

  const mockBmadStatusEmpty: BmadStatus = {
    installed: true,
    version: '6.0.0',
    availableWorkflows: [],
    completedWorkflows: [],
    inProgressWorkflows: [],
    detectedArtifacts: {
      completedWorkflows: [],
      inProgressWorkflows: [],
      detectedArtifacts: {},
    },
  };

  const mockBmadStatusWithWorkflows: BmadStatus = {
    installed: true,
    version: '6.0.0',
    availableWorkflows: [],
    completedWorkflows: ['create-product-brief', 'create-prd'],
    inProgressWorkflows: [],
    detectedArtifacts: {
      completedWorkflows: ['create-product-brief', 'create-prd'],
      inProgressWorkflows: [],
      detectedArtifacts: {
        'create-product-brief': {
          path: '/project/_bmad-output/planning-artifacts/product-brief.md',
          stepsCompleted: ['1', '2', '3'],
        },
        'create-prd': {
          path: '/project/_bmad-output/planning-artifacts/prd.md',
          stepsCompleted: ['1', '2'],
        },
      },
    },
  };

  beforeEach(() => {
    mockGetBmadStatus = vi.fn().mockResolvedValue(mockBmadStatusEmpty);

    vi.spyOn(ApiContext, 'useApi').mockReturnValue({
      getBmadStatus: mockGetBmadStatus,
    } as unknown as ReturnType<typeof ApiContext.useApi>);
  });

  describe('refreshes state on mount (app restart simulation)', () => {
    it('should call getBmadStatus immediately on hook mount', async () => {
      renderHook(() => useBmadState());

      await waitFor(() => {
        expect(mockGetBmadStatus).toHaveBeenCalledTimes(1);
      });
    });

    it('should load persisted state after app restart (empty state)', async () => {
      // Simulate greenfield project (no artifacts)
      mockGetBmadStatus.mockResolvedValueOnce(mockBmadStatusEmpty);

      const { result } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status).toEqual(mockBmadStatusEmpty);
      expect(result.current.status?.completedWorkflows).toEqual([]);
      // suggestedWorkflows is now computed in the hook based on completedWorkflows
      expect(result.current.suggestedWorkflows).toContain('create-product-brief');
    });

    it('should load persisted state after app restart (with workflows)', async () => {
      // Simulate brownfield project (existing artifacts)
      mockGetBmadStatus.mockResolvedValueOnce(mockBmadStatusWithWorkflows);

      const { result } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status).toEqual(mockBmadStatusWithWorkflows);
      expect(result.current.status?.completedWorkflows).toEqual(['create-product-brief', 'create-prd']);
      expect(result.current.status?.detectedArtifacts.completedWorkflows).toEqual(['create-product-brief', 'create-prd']);
    });

    it('should re-mount and refresh state (simulating app close/reopen)', async () => {
      // First mount - empty state
      mockGetBmadStatus.mockResolvedValueOnce(mockBmadStatusEmpty);
      const { result, unmount } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status?.completedWorkflows).toEqual([]);

      // Unmount (simulate app close)
      unmount();

      // Second mount - with completed workflows (simulating app reopen after workflow execution)
      mockGetBmadStatus.mockResolvedValueOnce(mockBmadStatusWithWorkflows);
      const { result: resultAfterReopen } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(resultAfterReopen.current.isLoading).toBe(false);
      });

      // State should reflect persisted artifacts
      expect(resultAfterReopen.current.status?.completedWorkflows).toEqual(['create-product-brief', 'create-prd']);
      expect(mockGetBmadStatus).toHaveBeenCalledTimes(2);
    });
  });

  describe('updates state after workflow execution', () => {
    it('should refresh state when refresh() is called', async () => {
      mockGetBmadStatus
        .mockResolvedValueOnce(mockBmadStatusEmpty) // Initial load
        .mockResolvedValueOnce(mockBmadStatusWithWorkflows); // After refresh

      const { result } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
        expect(result.current.status?.completedWorkflows).toEqual([]);
      });

      // Simulate workflow completion - call refresh
      result.current.refresh();

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
        expect(result.current.status?.completedWorkflows).toEqual(['create-product-brief', 'create-prd']);
      });

      // State should now include completed workflow
      expect(mockGetBmadStatus).toHaveBeenCalledTimes(2);
    });

    it('should update detected artifacts after refresh', async () => {
      mockGetBmadStatus.mockResolvedValueOnce(mockBmadStatusEmpty).mockResolvedValueOnce(mockBmadStatusWithWorkflows);

      const { result } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(result.current.status?.detectedArtifacts.detectedArtifacts).toEqual({});
      });

      result.current.refresh();

      await waitFor(() => {
        expect(result.current.status?.detectedArtifacts.detectedArtifacts).toHaveProperty('create-product-brief');
        expect(result.current.status?.detectedArtifacts.detectedArtifacts).toHaveProperty('create-prd');
      });
    });

    it('should update suggested workflows after refresh', async () => {
      mockGetBmadStatus.mockResolvedValueOnce(mockBmadStatusEmpty).mockResolvedValueOnce(mockBmadStatusWithWorkflows);

      const { result } = renderHook(() => useBmadState());

      await waitFor(() => {
        // suggestedWorkflows is now computed in the hook
        expect(result.current.suggestedWorkflows).toContain('create-product-brief');
      });

      result.current.refresh();

      await waitFor(() => {
        // After completing create-product-brief and create-prd, suggestions should include followUps
        expect(result.current.suggestedWorkflows).toContain('create-architecture');
      });
    });
  });

  describe('handles refresh errors gracefully', () => {
    it('should set error state when refresh fails', async () => {
      mockGetBmadStatus
        .mockResolvedValueOnce(mockBmadStatusWithWorkflows) // Initial successful load
        .mockRejectedValueOnce(new Error('Network error')); // Refresh fails

      const { result } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(result.current.status).toEqual(mockBmadStatusWithWorkflows);
        expect(result.current.isLoading).toBe(false);
      });

      // Call refresh - should fail
      result.current.refresh();

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status).toBeNull(); // Status cleared on refresh error
    });

    it('should clear previous error on successful refresh', async () => {
      mockGetBmadStatus
        .mockRejectedValueOnce(new Error('Initial error')) // Initial load fails
        .mockResolvedValueOnce(mockBmadStatusWithWorkflows); // Refresh succeeds

      const { result } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
        expect(result.current.error).toBe('Initial error');
      });

      // Call refresh - should succeed
      result.current.refresh();

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
        expect(result.current.error).toBeNull();
      });

      expect(result.current.status).toEqual(mockBmadStatusWithWorkflows);
    });

    it('should remain functional after refresh error', async () => {
      mockGetBmadStatus
        .mockResolvedValueOnce(mockBmadStatusEmpty) // Initial load
        .mockRejectedValueOnce(new Error('Temporary error')) // First refresh fails
        .mockResolvedValueOnce(mockBmadStatusWithWorkflows); // Second refresh succeeds

      const { result } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(result.current.status).toEqual(mockBmadStatusEmpty);
      });

      // First refresh - fails
      result.current.refresh();

      await waitFor(() => {
        expect(result.current.error).toBe('Temporary error');
      });

      // Second refresh - succeeds
      result.current.refresh();

      await waitFor(() => {
        expect(result.current.error).toBeNull();
        expect(result.current.status).toEqual(mockBmadStatusWithWorkflows);
      });
    });
  });

  describe('loading states during refresh', () => {
    it('should set loading=true when refresh starts', async () => {
      const { result } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Mock delayed response
      mockGetBmadStatus.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(mockBmadStatusWithWorkflows), 100)));

      result.current.refresh();

      // Should immediately go into loading state
      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      // Then finish loading
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should clear status when refresh starts (loading state)', async () => {
      const { result } = renderHook(() => useBmadState());

      await waitFor(() => {
        expect(result.current.status).toEqual(mockBmadStatusEmpty);
      });

      mockGetBmadStatus.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(mockBmadStatusWithWorkflows), 100)));

      result.current.refresh();

      // Status should be cleared during loading
      await waitFor(() => {
        expect(result.current.status).toBeNull();
        expect(result.current.isLoading).toBe(true);
      });
    });
  });
});
