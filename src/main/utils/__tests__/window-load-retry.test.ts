import { beforeEach, describe, expect, it, vi } from 'vitest';
import { delay } from '@common/utils';

import logger from '@/logger';
import { createLoadRetryHandler } from '@/utils/window-load-retry';

vi.mock('@common/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@common/utils')>();
  return {
    ...actual,
    delay: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('@/logger', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const ERR_ABORTED = -3;
const ERR_NETWORK_CHANGED = -21;
const ERR_CONNECTION_REFUSED = -102;
const ERR_FAILED = -2;

type LoadFn = ReturnType<typeof vi.fn<() => Promise<void>>>;
type IsDestroyedFn = ReturnType<typeof vi.fn<() => boolean>>;

interface HandlerMocks {
  load: LoadFn;
  isDestroyed: IsDestroyedFn;
}

const createHandler = ({ load, isDestroyed, ...options }: { load?: LoadFn; isDestroyed?: IsDestroyedFn; maxRetries?: number; baseDelayMs?: number } = {}): {
  handler: ReturnType<typeof createLoadRetryHandler>;
  mocks: HandlerMocks;
} => {
  const loadMock = load ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const isDestroyedMock = isDestroyed ?? vi.fn<() => boolean>().mockReturnValue(false);
  const handler = createLoadRetryHandler({ load: loadMock, isDestroyed: isDestroyedMock, ...options });
  return { handler, mocks: { load: loadMock, isDestroyed: isDestroyedMock } };
};

describe('createLoadRetryHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores non-main-frame load failures', async () => {
    const { handler, mocks } = createHandler();

    await handler.onDidFailLoad(ERR_NETWORK_CHANGED, false);

    expect(mocks.load).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });

  it('ignores aborted loads', async () => {
    const { handler, mocks } = createHandler();

    await handler.onDidFailLoad(ERR_ABORTED, true);

    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('ignores non-transient error codes', async () => {
    const { handler, mocks } = createHandler();

    await handler.onDidFailLoad(ERR_FAILED, true);

    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('retries transient failures with exponential backoff until success', async () => {
    const load = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('load failed')).mockResolvedValueOnce(undefined);
    const { handler, mocks } = createHandler({ load });

    await handler.onDidFailLoad(ERR_NETWORK_CHANGED, true, 'http://localhost:5173');

    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 1000);
    expect(delay).toHaveBeenNthCalledWith(2, 2000);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('gives up after max retries and allows a fresh retry chain afterwards', async () => {
    const load = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('load failed'));
    const { handler, mocks } = createHandler({ load, maxRetries: 2, baseDelayMs: 1 });

    await handler.onDidFailLoad(ERR_CONNECTION_REFUSED, true);
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('giving up'));

    await handler.onDidFailLoad(ERR_CONNECTION_REFUSED, true);
    expect(mocks.load).toHaveBeenCalledTimes(4);
    expect(vi.mocked(logger.warn).mock.calls.filter((call) => String(call[0]).includes('attempt 1/2'))).toHaveLength(2);
  });

  it('stops retrying once the window is destroyed', async () => {
    const isDestroyed = vi.fn().mockReturnValue(true);
    const { handler, mocks } = createHandler({ isDestroyed });

    await handler.onDidFailLoad(ERR_NETWORK_CHANGED, true);

    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('reset restores the attempt counter after a successful load', async () => {
    const load = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('load failed')).mockResolvedValue(undefined);
    const { handler, mocks } = createHandler({ load, maxRetries: 2, baseDelayMs: 1 });

    await handler.onDidFailLoad(ERR_NETWORK_CHANGED, true);
    expect(mocks.load).toHaveBeenCalledTimes(2);

    handler.reset();

    await handler.onDidFailLoad(ERR_NETWORK_CHANGED, true);
    expect(mocks.load).toHaveBeenCalledTimes(3);
  });

  it('ignores a new failure while a retry chain is already in progress', async () => {
    let resolveLoad: (() => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const { handler, mocks } = createHandler({ load });

    const chain = handler.onDidFailLoad(ERR_NETWORK_CHANGED, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.load).toHaveBeenCalledTimes(1);

    await handler.onDidFailLoad(ERR_NETWORK_CHANGED, true);
    expect(mocks.load).toHaveBeenCalledTimes(1);

    resolveLoad?.();
    await chain;
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });
});
