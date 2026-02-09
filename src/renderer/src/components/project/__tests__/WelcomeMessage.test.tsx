import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { WelcomeMessage } from '../WelcomeMessage';

import type { BmadStatus } from '@common/bmad-types';

import { useApi } from '@/contexts/ApiContext';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Mock contexts
vi.mock('@/contexts/ApiContext', () => ({
  useApi: vi.fn(),
}));

// Mock child components
vi.mock('@/components/bmad/BmadInstallPrompt', () => ({
  BmadInstallPrompt: () => <div data-testid="bmad-install-prompt">BmadInstallPrompt</div>,
}));

vi.mock('@/components/bmad/WorkflowList', () => ({
  WorkflowList: () => <div data-testid="workflow-list">Workflows v6.0.0</div>,
}));

describe('WelcomeMessage', () => {
  const mockOnModeChange = vi.fn();
  const mockGetBmadStatus = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useApi).mockReturnValue({
      getBmadStatus: mockGetBmadStatus,
    } as unknown as ReturnType<typeof useApi>);
  });

  it('renders default welcome screen when mode is not bmad', () => {
    render(<WelcomeMessage onModeChange={mockOnModeChange} mode="agent" />);

    expect(screen.getByText('welcomeMessage.title')).toBeInTheDocument();
    expect(screen.queryByTestId('bmad-install-prompt')).not.toBeInTheDocument();
  });

  it('calls getBmadStatus when mode is bmad', async () => {
    const mockStatus: BmadStatus = {
      installed: false,
      availableWorkflows: [],
      completedWorkflows: [],
      inProgressWorkflows: [],
      detectedArtifacts: {
        completedWorkflows: [],
        inProgressWorkflows: [],
        detectedArtifacts: {},
      },
    };
    mockGetBmadStatus.mockResolvedValue(mockStatus);

    render(<WelcomeMessage onModeChange={mockOnModeChange} mode="bmad" />);

    await waitFor(() => {
      expect(mockGetBmadStatus).toHaveBeenCalled();
    });
  });

  it('shows BmadInstallPrompt when BMAD is not installed', async () => {
    const mockStatus: BmadStatus = {
      installed: false,
      availableWorkflows: [],
      completedWorkflows: [],
      inProgressWorkflows: [],
      detectedArtifacts: {
        completedWorkflows: [],
        inProgressWorkflows: [],
        detectedArtifacts: {},
      },
    };
    mockGetBmadStatus.mockResolvedValue(mockStatus);

    render(<WelcomeMessage onModeChange={mockOnModeChange} mode="bmad" projectDir="/test/project" taskId="test-task-id" />);

    await waitFor(() => {
      expect(screen.getByTestId('bmad-install-prompt')).toBeInTheDocument();
    });
  });

  it('shows WorkflowList when BMAD is installed', async () => {
    const mockStatus: BmadStatus = {
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
    mockGetBmadStatus.mockResolvedValue(mockStatus);

    render(<WelcomeMessage onModeChange={mockOnModeChange} mode="bmad" projectDir="/test/project" taskId="task-123" />);

    await waitFor(() => {
      expect(screen.getByTestId('workflow-list')).toBeInTheDocument();
      expect(screen.getByText(/v6.0.0/)).toBeInTheDocument();
    });
  });

  it('shows loading state while fetching status', async () => {
    mockGetBmadStatus.mockImplementation(() => new Promise(() => {})); // Never resolves

    render(<WelcomeMessage onModeChange={mockOnModeChange} mode="bmad" />);

    await waitFor(() => {
      expect(screen.getByText('common.loading')).toBeInTheDocument();
    });
  });

  it('shows error message and retry button on failure', async () => {
    mockGetBmadStatus.mockRejectedValue(new Error('Network error'));

    render(<WelcomeMessage onModeChange={mockOnModeChange} mode="bmad" />);

    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeInTheDocument();
      expect(screen.getByText('common.retry')).toBeInTheDocument();
    });
  });

  it('allows retry after error', async () => {
    mockGetBmadStatus.mockRejectedValueOnce(new Error('Network error'));
    mockGetBmadStatus.mockResolvedValueOnce({
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
    });

    render(<WelcomeMessage onModeChange={mockOnModeChange} mode="bmad" />);

    await waitFor(() => {
      expect(screen.getByText('common.retry')).toBeInTheDocument();
    });

    const retryButton = screen.getByText('common.retry');
    retryButton.click();

    await waitFor(() => {
      expect(mockGetBmadStatus).toHaveBeenCalledTimes(2);
    });
  });
});
