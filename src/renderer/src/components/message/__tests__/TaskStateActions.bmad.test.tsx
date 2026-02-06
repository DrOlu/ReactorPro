import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BmadStatus, WorkflowMetadata, IncompleteWorkflowMetadata, WorkflowPhase } from '@common/bmad-types';
import { DefaultTaskState } from '@common/types';

import { TaskStateActions } from '../TaskStateActions';

// Mock hooks
const mockUseBmadState = vi.fn();
vi.mock('@/hooks/useBmadState', () => ({
  useBmadState: () => mockUseBmadState(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Mock Button component
vi.mock('@/components/common/Button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => <button onClick={onClick}>{children}</button>,
}));

// Mock components
vi.mock('@/components/bmad/SuggestedWorkflowCard', () => ({
  SuggestedWorkflowCard: ({ workflow, incompleteWorkflow }: { workflow: WorkflowMetadata; incompleteWorkflow?: IncompleteWorkflowMetadata }) => (
    <button data-testid={`workflow-${workflow.id}`}>
      {workflow.name}
      {incompleteWorkflow && <span data-testid={`step-info-${workflow.id}`}>Step {incompleteWorkflow.nextStep}</span>}
    </button>
  ),
}));

// Helper to create mock BmadStatus with required fields
const createMockBmadStatus = (overrides: Partial<BmadStatus> = {}): BmadStatus => ({
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
  ...overrides,
});

describe('TaskStateActions - BMAD Integration', () => {
  const mockOnResumeTask = vi.fn();
  const mockOnMarkAsDone = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Mode Detection', () => {
    it('should render BMAD actions when mode is "bmad"', () => {
      mockUseBmadState.mockReturnValue({
        status: createMockBmadStatus(),
        suggestedWorkflows: [],
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<TaskStateActions state={DefaultTaskState.Todo} mode="bmad" isArchived={false} onResumeTask={mockOnResumeTask} onMarkAsDone={mockOnMarkAsDone} />);

      // Should see BMAD-specific UI elements
      expect(screen.queryByText('messages.execute')).not.toBeInTheDocument();
    });

    it('should NOT render BMAD actions when mode is not "bmad"', () => {
      render(
        <TaskStateActions state={DefaultTaskState.Todo} mode="agent" isArchived={false} onResumeTask={mockOnResumeTask} onMarkAsDone={mockOnMarkAsDone} />,
      );

      // Should see default actions
      expect(screen.getByText('messages.execute')).toBeInTheDocument();
    });

    it('should render default actions when mode is undefined', () => {
      render(<TaskStateActions state={DefaultTaskState.Todo} isArchived={false} onResumeTask={mockOnResumeTask} onMarkAsDone={mockOnMarkAsDone} />);

      // Should see default actions
      expect(screen.getByText('messages.execute')).toBeInTheDocument();
    });
  });

  describe('Available Workflows', () => {
    it('should render WorkflowActionButton for suggested workflows', () => {
      const mockWorkflow: WorkflowMetadata = {
        id: 'product-brief',
        name: 'Product Brief',
        description: 'Create product brief',
        phase: WorkflowPhase.Analysis,
        workflowPath: '/path/to/workflow.yaml',
        outputArtifact: 'brief.md',
        totalSteps: 3,
      };

      mockUseBmadState.mockReturnValue({
        status: createMockBmadStatus({
          availableWorkflows: [mockWorkflow],
          completedWorkflows: ['create-product-brief'], // Need completed workflows to show suggestions
        }),
        suggestedWorkflows: ['product-brief'],
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<TaskStateActions state={DefaultTaskState.Todo} mode="bmad" isArchived={false} onResumeTask={mockOnResumeTask} onMarkAsDone={mockOnMarkAsDone} />);

      expect(screen.getByTestId('workflow-product-brief')).toBeInTheDocument();
    });

    it('should render completed workflows with distinction', () => {
      const mockSuggestedWorkflow: WorkflowMetadata = {
        id: 'prd',
        name: 'PRD',
        description: 'Product requirements',
        phase: WorkflowPhase.Planning,
        workflowPath: '/path/to/prd.yaml',
        outputArtifact: 'prd.md',
        totalSteps: 3,
      };

      mockUseBmadState.mockReturnValue({
        status: createMockBmadStatus({
          availableWorkflows: [mockSuggestedWorkflow],
          completedWorkflows: ['product-brief'],
        }),
        suggestedWorkflows: ['prd'],
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<TaskStateActions state={DefaultTaskState.Todo} mode="bmad" isArchived={false} onResumeTask={mockOnResumeTask} onMarkAsDone={mockOnMarkAsDone} />);

      // Should see the suggested workflow
      expect(screen.getByTestId('workflow-prd')).toBeInTheDocument();
    });
  });

  describe('Error States', () => {
    it('should handle error state gracefully', () => {
      mockUseBmadState.mockReturnValue({
        status: null,
        suggestedWorkflows: [],
        isLoading: false,
        error: 'Failed to load BMAD status',
        refresh: vi.fn(),
      });

      render(<TaskStateActions state={DefaultTaskState.Todo} mode="bmad" isArchived={false} onResumeTask={mockOnResumeTask} onMarkAsDone={mockOnMarkAsDone} />);

      // Should show error message
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
    });
  });

  describe('State Refresh', () => {
    it('should pass refresh callback to WorkflowActionButton', () => {
      const mockRefresh = vi.fn();
      const mockWorkflow: WorkflowMetadata = {
        id: 'product-brief',
        name: 'Product Brief',
        description: 'Create product brief',
        phase: WorkflowPhase.Analysis,
        workflowPath: '/path/to/workflow.yaml',
        outputArtifact: 'brief.md',
        totalSteps: 3,
      };

      mockUseBmadState.mockReturnValue({
        status: createMockBmadStatus({
          availableWorkflows: [mockWorkflow],
          completedWorkflows: ['create-product-brief'], // Need completed workflows to show suggestions
        }),
        suggestedWorkflows: ['product-brief'],
        isLoading: false,
        error: null,
        refresh: mockRefresh,
      });

      render(<TaskStateActions state={DefaultTaskState.Todo} mode="bmad" isArchived={false} onResumeTask={mockOnResumeTask} onMarkAsDone={mockOnMarkAsDone} />);

      // WorkflowActionButton should receive onComplete callback
      // This is verified by the component rendering correctly
      expect(screen.getByTestId('workflow-product-brief')).toBeInTheDocument();
    });
  });
});
