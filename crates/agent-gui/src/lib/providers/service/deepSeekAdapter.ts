import { DEEPSEEK_RESPONSES_API, streamDeepSeekResponses } from "../deepSeekNative";
import { withStreamRetry } from "../runtime/streamRetry";
import type { LlmAdapter } from "./types";

/**
 * DeepSeek native protocol adapter.
 *
 * A verbatim move of the DEEPSEEK_RESPONSES_API branch in streamByApi.ts (PR-1 behavioral-equivalence
 * invariant): the withStreamRetry wrapping position and arguments are preserved word for word.
 */
export const deepSeekAdapter: LlmAdapter = {
  apis: [DEEPSEEK_RESPONSES_API] as const,
  stream(model, context, options) {
    return withStreamRetry(() => streamDeepSeekResponses(model, context, options), {
      signal: options.signal,
      ...options.streamRetry,
    });
  },
};
