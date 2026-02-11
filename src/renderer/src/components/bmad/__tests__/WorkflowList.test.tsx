import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BmadStatus, WorkflowPhase } from '@common/bmad-types';
import { BMAD_WORKFLOWS } from '@common/bmad-workflows';

// Mock useBmadState hook
vi.mock('@/contexts/BmadStateContext');

// Mock useIncompleteWorkflows hook
vi.mock('@/hooks/useIncompleteWorkflows', () => ({
  useIncompleteWorkflows: vi.fn(() => ({
    incompleteWorkflows: [],
  })),
}));

// Mock useApi hook
vi.mock('@/contexts/ApiContext', () => ({
  useApi: vi.fn(() => ({
    executeWorkflow: vi.fn(),
    openPath: vi.fn(),
  })),
}));

import { WorkflowList } from '../WorkflowList';

import * as useBmadStateModule from '@/contexts/BmadStateContext';

describe('WorkflowList', () => {
  const mockBmadStatus: BmadStatus = {
    projectDir: '/test/project',
    installed: true,
    version: '6.0.0',
    availableWorkflows: BMAD_WORKFLOWS,
    completedWorkflows: ['product-brief'],
    inProgressWorkflows: [],
    detectedArtifacts: {
      completedWorkflows: ['product-brief'],
      inProgressWorkflows: [],
      detectedArtifacts: {},
    },
  };

  beforeEach(() => {
    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: mockBmadStatus,
      suggestedWorkflows: ['prd'],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it('should render phase sections for full workflow tab', () => {
    render(<WorkflowList projectDir="/test/project" taskId="task-123" activeTab="full" />);

    // Check phase section headers are rendered
    expect(screen.getByText('bmad.phase.analysis')).toBeInTheDocument();
    expect(screen.getByText('bmad.phase.planning')).toBeInTheDocument();
    expect(screen.getByText('bmad.phase.solutioning')).toBeInTheDocument();
    expect(screen.getByText('bmad.phase.implementation')).toBeInTheDocument();
  });

  it('should render workflows grouped by phase for full workflow tab', () => {
    render(<WorkflowList projectDir="/test/project" taskId="task-123" activeTab="full" />);

    // Check that workflows from different phases are rendered
    expect(screen.getByRole('button', { name: /research/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /product brief/i })).toBeInTheDocument();
  });

  it('should render quick flow workflows for quick tab', () => {
    render(<WorkflowList projectDir="/test/project" taskId="task-123" activeTab="quick" />);

    // Quick flow workflows should be visible
    expect(screen.getByRole('button', { name: /quick spec/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /quick dev/i })).toBeInTheDocument();

    // Full workflow phases should not be visible
    expect(screen.queryByText('bmad.phase.analysis')).not.toBeInTheDocument();
    expect(screen.queryByText('bmad.phase.planning')).not.toBeInTheDocument();
  });

  it('should render correct number of workflows for full tab', () => {
    render(<WorkflowList projectDir="/test/project" taskId="task-123" activeTab="full" />);

    // Count full workflow phases (Analysis, Planning, Solutioning, Implementation)
    const fullWorkflows = BMAD_WORKFLOWS.filter((w) => w.phase !== WorkflowPhase.QuickFlow);
    const buttons = screen.getAllByRole('button');
    // Workflow buttons + phase toggle buttons (4 phases)
    expect(buttons.length).toBeGreaterThanOrEqual(fullWorkflows.length);
  });

  it('should show loading state', () => {
    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: null,
      suggestedWorkflows: [],
      isLoading: true,
      error: null,
      refresh: vi.fn(),
    });

    render(<WorkflowList projectDir="/test/project" taskId="task-123" activeTab="full" />);

    expect(screen.getByText('bmad.workflows.loading')).toBeInTheDocument();
  });

  it('should show error state', () => {
    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: null,
      suggestedWorkflows: [],
      isLoading: false,
      error: 'Failed to load BMAD status',
      refresh: vi.fn(),
    });

    render(<WorkflowList projectDir="/test/project" taskId="task-123" activeTab="full" />);

    expect(screen.getByText(/bmad.workflows.errorLoading/i)).toBeInTheDocument();
  });

  it('should handle empty workflow list', () => {
    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: {
        ...mockBmadStatus,
        availableWorkflows: [],
      },
      suggestedWorkflows: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<WorkflowList projectDir="/test/project" taskId="task-123" activeTab="full" />);

    expect(screen.getByText('bmad.workflows.noWorkflows')).toBeInTheDocument();
  });

  it('should show no workflows message for quick tab when no quick workflows exist', () => {
    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: {
        ...mockBmadStatus,
        availableWorkflows: BMAD_WORKFLOWS.filter((w) => w.phase !== WorkflowPhase.QuickFlow),
      },
      suggestedWorkflows: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<WorkflowList projectDir="/test/project" taskId="task-123" activeTab="quick" />);

    expect(screen.getByText('bmad.workflows.noWorkflows')).toBeInTheDocument();
  });
});
