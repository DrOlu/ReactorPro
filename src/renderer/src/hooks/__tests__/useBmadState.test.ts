import { renderHook, waitFor } from '@testing-library/react';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import { BmadStatus } from '@common/bmad-types';

import { useBmadState } from '../useBmadState';

import * as ApiContext from '@/contexts/ApiContext';

describe('useBmadState', () => {
  let mockGetBmadStatus: Mock;

  const mockBmadStatus: BmadStatus = {
    installed: true,
    version: '6.0.0',
    availableWorkflows: [],
    completedWorkflows: ['product-brief'],
    inProgressWorkflows: [],
    detectedArtifacts: {
      completedWorkflows: [],
      inProgressWorkflows: [],
      detectedArtifacts: {},
    },
  };

  beforeEach(() => {
    mockGetBmadStatus = vi.fn().mockResolvedValue(mockBmadStatus);

    vi.spyOn(ApiContext, 'useApi').mockReturnValue({
      getBmadStatus: mockGetBmadStatus,
    } as unknown as ReturnType<typeof ApiContext.useApi>);
  });

  it('should call getBmadStatus on mount', async () => {
    renderHook(() => useBmadState());

    await waitFor(() => {
      expect(mockGetBmadStatus).toHaveBeenCalledTimes(1);
    });
  });

  it('should return loading state initially', () => {
    const { result } = renderHook(() => useBmadState());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.status).toBeNull();
  });

  it('should return BmadStatus after successful load', async () => {
    const { result } = renderHook(() => useBmadState());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status).toEqual(mockBmadStatus);
    expect(result.current.error).toBeNull();
  });

  it('should handle errors from getBmadStatus gracefully', async () => {
    const errorMessage = 'Failed to fetch BMAD status';
    mockGetBmadStatus.mockRejectedValueOnce(new Error(errorMessage));

    const { result } = renderHook(() => useBmadState());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.status).toBeNull();
    expect(result.current.error).toBe(errorMessage);
  });

  it('should provide refresh function to reload status', async () => {
    const { result } = renderHook(() => useBmadState());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockGetBmadStatus).toHaveBeenCalledTimes(1);

    // Call refresh
    result.current.refresh();

    await waitFor(() => {
      expect(mockGetBmadStatus).toHaveBeenCalledTimes(2);
    });
  });

  it('should reset status to null when refresh starts', async () => {
    const { result } = renderHook(() => useBmadState());

    await waitFor(() => {
      expect(result.current.status).toEqual(mockBmadStatus);
    });

    // Delay the next response
    mockGetBmadStatus.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(mockBmadStatus), 100)));

    result.current.refresh();

    // Status should be null immediately after calling refresh
    await waitFor(() => {
      expect(result.current.status).toBeNull();
      expect(result.current.isLoading).toBe(true);
    });
  });
});
