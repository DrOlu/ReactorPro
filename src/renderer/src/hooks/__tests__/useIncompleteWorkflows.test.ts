import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { IncompleteWorkflowMetadata } from '@common/bmad-types';

import { useIncompleteWorkflows } from '../useIncompleteWorkflows';
import * as useBmadStateModule from '../useBmadState';

vi.mock('../useBmadState');

describe('useIncompleteWorkflows', () => {
  it('returns empty array when status is null', () => {
    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: null,
      suggestedWorkflows: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { result } = renderHook(() => useIncompleteWorkflows());

    expect(result.current.incompleteWorkflows).toEqual([]);
  });

  it('returns empty array when detectedArtifacts is undefined', () => {
    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: {
        installed: true,
        version: '1.0.0',
        availableWorkflows: [],
        completedWorkflows: [],
        inProgressWorkflows: [],
        detectedArtifacts: {
          completedWorkflows: [],
          inProgressWorkflows: [],
          detectedArtifacts: {},
        },
      },
      suggestedWorkflows: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { result } = renderHook(() => useIncompleteWorkflows());

    expect(result.current.incompleteWorkflows).toEqual([]);
  });

  it('returns incomplete workflows from status', () => {
    const mockIncompleteWorkflows: IncompleteWorkflowMetadata[] = [
      {
        workflowId: 'prd',
        artifactPath: '/path/to/prd.md',
        stepsCompleted: [1, 2],
        nextStep: 3,
        lastModified: new Date('2024-01-01'),
      },
      {
        workflowId: 'architecture',
        artifactPath: '/path/to/architecture.md',
        stepsCompleted: [1],
        nextStep: 2,
        lastModified: new Date('2024-01-02'),
      },
    ];

    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: {
        installed: true,
        version: '1.0.0',
        availableWorkflows: [],
        completedWorkflows: [],
        inProgressWorkflows: [],
        detectedArtifacts: {
          completedWorkflows: [],
          inProgressWorkflows: [],
          detectedArtifacts: {},
          incompleteWorkflows: mockIncompleteWorkflows,
        },
      },
      suggestedWorkflows: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { result } = renderHook(() => useIncompleteWorkflows());

    expect(result.current.incompleteWorkflows).toEqual(mockIncompleteWorkflows);
  });

  it('updates when status changes', () => {
    const mockIncompleteWorkflows1: IncompleteWorkflowMetadata[] = [
      {
        workflowId: 'prd',
        artifactPath: '/path/to/prd.md',
        stepsCompleted: [1],
        nextStep: 2,
        lastModified: new Date('2024-01-01'),
      },
    ];

    const mockIncompleteWorkflows2: IncompleteWorkflowMetadata[] = [
      {
        workflowId: 'architecture',
        artifactPath: '/path/to/architecture.md',
        stepsCompleted: [1, 2, 3],
        nextStep: 4,
        lastModified: new Date('2024-01-02'),
      },
    ];

    const useBmadStateSpy = vi.spyOn(useBmadStateModule, 'useBmadState');

    useBmadStateSpy.mockReturnValue({
      status: {
        installed: true,
        version: '1.0.0',
        availableWorkflows: [],
        completedWorkflows: [],
        inProgressWorkflows: [],
        detectedArtifacts: {
          completedWorkflows: [],
          inProgressWorkflows: [],
          detectedArtifacts: {},
          incompleteWorkflows: mockIncompleteWorkflows1,
        },
      },
      suggestedWorkflows: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { result, rerender } = renderHook(() => useIncompleteWorkflows());

    expect(result.current.incompleteWorkflows).toEqual(mockIncompleteWorkflows1);

    // Update mock to return different incomplete workflows
    useBmadStateSpy.mockReturnValue({
      status: {
        installed: true,
        version: '1.0.0',
        availableWorkflows: [],
        completedWorkflows: [],
        inProgressWorkflows: [],
        detectedArtifacts: {
          completedWorkflows: [],
          inProgressWorkflows: [],
          detectedArtifacts: {},
          incompleteWorkflows: mockIncompleteWorkflows2,
        },
      },
      suggestedWorkflows: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    rerender();

    expect(result.current.incompleteWorkflows).toEqual(mockIncompleteWorkflows2);
  });
});
