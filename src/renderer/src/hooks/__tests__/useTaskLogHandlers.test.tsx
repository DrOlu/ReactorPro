import { act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useTaskLogHandlers } from '../useTaskLogHandlers';

import type { LogData } from '@common/types';

import { render } from '@/__tests__/render';
import { createMockApi } from '@/__tests__/mocks/api';
import { useApi } from '@/contexts/ApiContext';
import { setMessages, useTaskStore } from '@/stores/taskStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/contexts/ApiContext', () => ({
  useApi: vi.fn(),
}));

const TestComponent = () => {
  useTaskLogHandlers('/project', 'task-123');
  return null;
};

describe('useTaskLogHandlers', () => {
  const mockApi = createMockApi();
  let logHandler: ((data: LogData) => void) | undefined;

  const createLogData = (overrides: Partial<LogData> = {}): LogData => ({
    baseDir: '/project',
    taskId: 'task-123',
    level: 'error',
    message: 'error',
    timestamp: 1,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    logHandler = undefined;
    vi.mocked(useApi).mockReturnValue(mockApi);
    vi.mocked(mockApi.addLogListener).mockImplementation((_baseDir: string, _taskId: string, handler: (data: LogData) => void) => {
      logHandler = handler;
      return () => {};
    });
    setMessages('task-123', () => []);
  });

  it('adds log messages to the store', async () => {
    render(<TestComponent />);

    act(() => {
      logHandler?.(createLogData({ message: 'first error', timestamp: 1 }));
    });

    await waitFor(() => {
      const messages = useTaskStore.getState().taskMessagesMap.get('task-123');
      expect(messages).toHaveLength(1);
      expect(messages?.[0]?.type).toBe('log');
      expect(messages?.[0]?.content).toBe('first error');
    });
  });

  it('strips resolve-git-error-with-agent action id from older messages when a new one arrives', async () => {
    render(<TestComponent />);

    act(() => {
      logHandler?.(createLogData({ message: 'first error', actionIds: ['resolve-git-error-with-agent'], timestamp: 1 }));
    });

    await waitFor(() => {
      const messages = useTaskStore.getState().taskMessagesMap.get('task-123');
      expect(messages).toHaveLength(1);
    });

    act(() => {
      logHandler?.(createLogData({ message: 'second error', actionIds: ['resolve-git-error-with-agent'], timestamp: 2 }));
    });

    await waitFor(() => {
      const messages = useTaskStore.getState().taskMessagesMap.get('task-123') as Array<{ content: string; actionIds?: string[] }>;
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('first error');
      expect(messages[0].actionIds ?? []).not.toContain('resolve-git-error-with-agent');
      expect(messages[1].content).toBe('second error');
      expect(messages[1].actionIds).toContain('resolve-git-error-with-agent');
    });
  });

  it('keeps other action ids on older messages', async () => {
    render(<TestComponent />);

    act(() => {
      logHandler?.(createLogData({ message: 'rebase failed', actionIds: ['continue-rebase', 'resolve-git-error-with-agent'], timestamp: 1 }));
    });

    act(() => {
      logHandler?.(createLogData({ message: 'merge failed', actionIds: ['resolve-git-error-with-agent'], timestamp: 2 }));
    });

    await waitFor(() => {
      const messages = useTaskStore.getState().taskMessagesMap.get('task-123') as Array<{ content: string; actionIds?: string[] }>;
      expect(messages[0].actionIds).toEqual(['continue-rebase']);
      expect(messages[1].actionIds).toEqual(['resolve-git-error-with-agent']);
    });
  });
});
