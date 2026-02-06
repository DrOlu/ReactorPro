import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BmadInstallPrompt } from '../BmadInstallPrompt';

import { useApi } from '@/contexts/ApiContext';
import * as notifications from '@/utils/notifications';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { returnObjects?: boolean }) => {
      if (key === 'bmad.install.benefits' && options?.returnObjects) {
        return [
          'Structured workflows from brainstorming to implementation',
          'Automatic context preparation (50-80% cost savings)',
          'No context-switching between tools',
          'Smart next-step recommendations',
        ];
      }
      return key;
    },
  }),
}));

// Mock contexts
vi.mock('@/contexts/ApiContext', () => ({
  useApi: vi.fn(),
}));

// Mock notifications
vi.mock('@/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

describe('BmadInstallPrompt', () => {
  const mockOnOpenTerminal = vi.fn();
  const mockCreateTerminal = vi.fn();
  const mockGetAllTerminalsForTask = vi.fn();
  const mockWriteToTerminal = vi.fn();

  const renderComponent = () => {
    return render(
      <TooltipProvider>
        <BmadInstallPrompt projectDir="/test/project" taskId="task-123" onOpenTerminal={mockOnOpenTerminal} />
      </TooltipProvider>,
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useApi).mockReturnValue({
      createTerminal: mockCreateTerminal,
      getAllTerminalsForTask: mockGetAllTerminalsForTask,
      writeToTerminal: mockWriteToTerminal,
    } as unknown as ReturnType<typeof useApi>);
  });

  it('renders install button and welcome content', () => {
    renderComponent();

    expect(screen.getByText('bmad.welcome.title')).toBeInTheDocument();
    expect(screen.getByText('bmad.welcome.subtitle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /bmad.install.openTerminal/ })).toBeInTheDocument();
  });

  it('renders benefits list', () => {
    renderComponent();

    expect(screen.getByText(/Structured workflows/)).toBeInTheDocument();
    expect(screen.getByText(/Automatic context preparation/)).toBeInTheDocument();
  });

  it('creates terminal and writes command on button click', async () => {
    mockCreateTerminal.mockResolvedValue('terminal-123');
    mockGetAllTerminalsForTask.mockResolvedValue([{ id: 'terminal-123', taskId: 'task-123', cols: 160, rows: 40 }]);
    mockWriteToTerminal.mockResolvedValue(true);

    renderComponent();

    const button = screen.getByRole('button', { name: /bmad.install.openTerminal/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockCreateTerminal).toHaveBeenCalledWith('/test/project', 'task-123', 160, 40);
      expect(mockOnOpenTerminal).toHaveBeenCalled();
    });

    // Wait for the setTimeout callback to execute
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(mockGetAllTerminalsForTask).toHaveBeenCalledWith('task-123');
    expect(mockWriteToTerminal).toHaveBeenCalledWith('terminal-123', 'npx -y bmad-method install\r');
  });

  it('shows loading state during terminal opening', async () => {
    mockCreateTerminal.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('terminal-123'), 100)));

    renderComponent();

    const button = screen.getByRole('button', { name: /bmad.install.openTerminal/ });
    fireEvent.click(button);

    expect(screen.getByText('bmad.install.opening')).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it('calls onOpenTerminal callback on successful terminal creation', async () => {
    mockCreateTerminal.mockResolvedValue('terminal-123');
    mockGetAllTerminalsForTask.mockResolvedValue([{ id: 'terminal-123', taskId: 'task-123', cols: 160, rows: 40 }]);
    mockWriteToTerminal.mockResolvedValue(true);

    renderComponent();

    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockOnOpenTerminal).toHaveBeenCalled();
    });
  });

  it('shows error toast on failed terminal creation', async () => {
    mockCreateTerminal.mockRejectedValue(new Error('Terminal creation failed'));

    renderComponent();

    const button = screen.getByRole('button');
    await fireEvent.click(button);

    await waitFor(
      () => {
        expect(notifications.showErrorNotification).toHaveBeenCalledWith(expect.stringContaining('Terminal creation failed'));
      },
      { timeout: 1000 },
    );
    expect(mockOnOpenTerminal).not.toHaveBeenCalled();
  });

  it('handles exception during terminal operations', async () => {
    mockCreateTerminal.mockRejectedValue(new Error('Network error'));

    renderComponent();

    const button = screen.getByRole('button');
    await fireEvent.click(button);

    await waitFor(
      () => {
        expect(notifications.showErrorNotification).toHaveBeenCalledWith(expect.stringContaining('Network error'));
      },
      { timeout: 1000 },
    );
    expect(mockOnOpenTerminal).not.toHaveBeenCalled();
  });

  it('renders command that will be executed', () => {
    renderComponent();

    expect(screen.getByText('npx -y bmad-method install')).toBeInTheDocument();
    expect(screen.getByText('bmad.install.commandLabel')).toBeInTheDocument();
  });

  it('renders auto-check note', () => {
    renderComponent();

    expect(screen.getByText('bmad.install.autoCheckNote')).toBeInTheDocument();
  });
});
