import { delay } from '@common/utils';

import logger from '@/logger';

// Chromium network error codes that indicate transient failures where a retry can succeed
enum TransientLoadErrorCode {
  NetworkChanged = -21,
  ConnectionReset = -101,
  ConnectionRefused = -102,
  NameNotResolved = -105,
  InternetDisconnected = -106,
  TimedOut = -118,
}

const ERR_ABORTED = -3;

interface LoadRetryOptions {
  load: () => void | Promise<void>;
  isDestroyed: () => boolean;
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface LoadRetryHandler {
  onDidFailLoad: (errorCode: number, isMainFrame: boolean, validatedURL?: string) => Promise<void>;
  reset: () => void;
}

export const createLoadRetryHandler = ({ load, isDestroyed, maxRetries = 5, baseDelayMs = 1000 }: LoadRetryOptions): LoadRetryHandler => {
  let attempts = 0;
  let retrying = false;

  const onDidFailLoad = async (errorCode: number, isMainFrame: boolean, validatedURL?: string): Promise<void> => {
    if (!isMainFrame || errorCode === ERR_ABORTED || retrying || isDestroyed()) {
      return;
    }
    if (!(Object.values(TransientLoadErrorCode) as number[]).includes(errorCode)) {
      return;
    }

    retrying = true;
    const urlSuffix = validatedURL ? ` for ${validatedURL}` : '';
    try {
      while (attempts < maxRetries && !isDestroyed()) {
        attempts += 1;
        const delayMs = baseDelayMs * 2 ** (attempts - 1);
        logger.warn(
          `Window load failed with transient network error (code ${errorCode})${urlSuffix}; retrying in ${delayMs}ms (attempt ${attempts}/${maxRetries})`,
        );
        await delay(delayMs);
        if (isDestroyed()) {
          return;
        }
        try {
          await load();
          return;
        } catch (error) {
          logger.debug(`Window load retry ${attempts}/${maxRetries} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!isDestroyed()) {
        logger.error(`Window load kept failing after ${maxRetries} retries${urlSuffix}; giving up`);
        attempts = 0;
      }
    } finally {
      retrying = false;
    }
  };

  return {
    onDidFailLoad,
    reset: () => {
      attempts = 0;
    },
  };
};
