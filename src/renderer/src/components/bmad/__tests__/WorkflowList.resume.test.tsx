import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IncompleteWorkflowMetadata, WorkflowPhase } from '@common/bmad-types';

import { WorkflowList } from '../WorkflowList';

import { createMockApi } from '@/__tests__/mocks/api';
import * as ApiContext from '@/contexts/ApiContext';
import * as useBmadStateModule from '@/hooks/useBmadState';
import * as useIncompleteWorkflowsModule from '@/hooks/useIncompleteWorkflows';

vi.mock('@/contexts/ApiContext');
vi.mock('@/hooks/useBmadState');
vi.mock('@/hooks/useIncompleteWorkflows');

describe('WorkflowList - Resume Functionality', () => {
  const mockApi = createMockApi();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(ApiContext, 'useApi').mockReturnValue(mockApi);
  });

  it('shows workflows when incomplete workflows exist', () => {
    const mockIncompleteWorkflows: IncompleteWorkflowMetadata[] = [
      {
        workflowId: 'prd',
        artifactPath: '/path/to/prd.md',
        stepsCompleted: [1, 2],
        nextStep: 3,
        lastModified: new Date('2024-01-01'),
      },
    ];

    vi.spyOn(useIncompleteWorkflowsModule, 'useIncompleteWorkflows').mockReturnValue({
      incompleteWorkflows: mockIncompleteWorkflows,
    });

    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: {
        installed: true,
        version: '1.0.0',
        availableWorkflows: [
          {
            id: 'prd',
            name: 'PRD',
            phase: WorkflowPhase.Planning,
            description: 'Create comprehensive requirements document',
            workflowPath: '_bmad/bmm/workflows/2-plan-workflows/create-prd/workflow.md',
            outputArtifact: '_bmad-output/planning-artifacts/prd.md',
            totalSteps: 3,
          },
        ],
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

    render(<WorkflowList projectDir="/project" taskId="task-1" activeTab="full" />);

    // The workflow should be rendered within a phase section
    expect(screen.getByText('PRD')).toBeInTheDocument();
    expect(screen.getByText('Create comprehensive requirements document')).toBeInTheDocument();
  });

  it('hides resume section when no incomplete workflows', () => {
    vi.spyOn(useIncompleteWorkflowsModule, 'useIncompleteWorkflows').mockReturnValue({
      incompleteWorkflows: [],
    });

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
          incompleteWorkflows: [],
        },
      },
      suggestedWorkflows: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<WorkflowList projectDir="/project" taskId="task-1" activeTab="full" />);

    // Should show no workflows message
    expect(screen.getByText('bmad.workflows.noWorkflows')).toBeInTheDocument();
  });

  it('renders multiple workflows with incomplete status', () => {
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

    vi.spyOn(useIncompleteWorkflowsModule, 'useIncompleteWorkflows').mockReturnValue({
      incompleteWorkflows: mockIncompleteWorkflows,
    });

    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: {
        installed: true,
        version: '1.0.0',
        availableWorkflows: [
          {
            id: 'prd',
            name: 'PRD',
            phase: WorkflowPhase.Planning,
            description: 'Create comprehensive requirements document',
            workflowPath: '_bmad/bmm/workflows/2-plan-workflows/create-prd/workflow.md',
            outputArtifact: '_bmad-output/planning-artifacts/prd.md',
            totalSteps: 3,
          },
          {
            id: 'architecture',
            name: 'Architecture',
            phase: WorkflowPhase.Solutioning,
            description: 'Design technical architecture',
            workflowPath: '_bmad/bmm/workflows/3-solutioning/create-architecture/workflow.md',
            outputArtifact: '_bmad-output/planning-artifacts/architecture.md',
            totalSteps: 3,
          },
        ],
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

    render(<WorkflowList projectDir="/project" taskId="task-1" activeTab="full" />);

    // Both workflows should be visible
    expect(screen.getByText('PRD')).toBeInTheDocument();
    expect(screen.getByText('Architecture')).toBeInTheDocument();
  });

  it('displays step indicators for in-progress workflows', () => {
    const mockIncompleteWorkflows: IncompleteWorkflowMetadata[] = [
      {
        workflowId: 'prd',
        artifactPath: '/path/to/prd.md',
        stepsCompleted: [1, 2],
        nextStep: 3,
        lastModified: new Date('2024-01-01'),
      },
    ];

    vi.spyOn(useIncompleteWorkflowsModule, 'useIncompleteWorkflows').mockReturnValue({
      incompleteWorkflows: mockIncompleteWorkflows,
    });

    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: {
        installed: true,
        version: '1.0.0',
        availableWorkflows: [
          {
            id: 'prd',
            name: 'PRD',
            phase: WorkflowPhase.Planning,
            description: 'Create comprehensive requirements document',
            workflowPath: '_bmad/bmm/workflows/2-plan-workflows/create-prd/workflow.md',
            outputArtifact: '_bmad-output/planning-artifacts/prd.md',
            totalSteps: 4,
          },
        ],
        completedWorkflows: [],
        inProgressWorkflows: ['prd'],
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

    render(<WorkflowList projectDir="/project" taskId="task-1" activeTab="full" />);

    // Step indicator should be shown for in-progress workflows
    expect(screen.getByText('bmad.resume.stepIndicator')).toBeInTheDocument();
  });

  it('handles null status gracefully', () => {
    vi.spyOn(useIncompleteWorkflowsModule, 'useIncompleteWorkflows').mockReturnValue({
      incompleteWorkflows: [],
    });

    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: null,
      suggestedWorkflows: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<WorkflowList projectDir="/project" taskId="task-1" activeTab="full" />);

    // Should show no workflows message when status is null
    expect(screen.getByText('bmad.workflows.noWorkflows')).toBeInTheDocument();
  });

  it('filters workflows by active tab', () => {
    const mockIncompleteWorkflows: IncompleteWorkflowMetadata[] = [
      {
        workflowId: 'prd',
        artifactPath: '/path/to/prd.md',
        stepsCompleted: [1, 2],
        nextStep: 3,
        lastModified: new Date('2024-01-01'),
      },
      {
        workflowId: 'quick-spec',
        artifactPath: '/path/to/quick-spec.md',
        stepsCompleted: [1],
        nextStep: 2,
        lastModified: new Date('2024-01-02'),
      },
    ];

    vi.spyOn(useIncompleteWorkflowsModule, 'useIncompleteWorkflows').mockReturnValue({
      incompleteWorkflows: mockIncompleteWorkflows,
    });

    vi.spyOn(useBmadStateModule, 'useBmadState').mockReturnValue({
      status: {
        installed: true,
        version: '1.0.0',
        availableWorkflows: [
          {
            id: 'prd',
            name: 'PRD',
            phase: WorkflowPhase.Planning,
            description: 'Create comprehensive requirements document',
            workflowPath: '_bmad/bmm/workflows/2-plan-workflows/create-prd/workflow.md',
            outputArtifact: '_bmad-output/planning-artifacts/prd.md',
            totalSteps: 3,
          },
          {
            id: 'quick-spec',
            name: 'Quick Spec',
            phase: WorkflowPhase.QuickFlow,
            description: 'Create focused specifications',
            workflowPath: '_bmad/bmm/workflows/bmad-quick-flow/quick-spec/workflow.md',
            outputArtifact: '_bmad-output/planning-artifacts/quick-spec.md',
            totalSteps: 3,
          },
        ],
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

    // Render with quick tab - should only show quick-spec workflow
    const { rerender } = render(<WorkflowList projectDir="/project" taskId="task-1" activeTab="quick" />);

    // Quick-spec should be shown, PRD should not
    expect(screen.getByText('Quick Spec')).toBeInTheDocument();
    expect(screen.queryByText('PRD')).not.toBeInTheDocument();

    // Rerender with full tab - should only show PRD workflow (since it's in Planning phase)
    rerender(<WorkflowList projectDir="/project" taskId="task-1" activeTab="full" />);

    expect(screen.getByText('PRD')).toBeInTheDocument();
    // Quick Spec should not be shown in full tab (it's in QuickFlow phase)
    expect(screen.queryByText('Quick Spec')).not.toBeInTheDocument();
  });
});
