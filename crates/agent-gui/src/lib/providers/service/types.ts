import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import type { StreamRetryConfig } from "../runtime/streamRetry";
import type { StreamOptionsEx } from "../runtime/types";

/**
 * The complete envelope for a single LLM streaming request.
 *
 * `model.api` determines which adapter it routes to; `context` and `options` are not
 * interpreted at all and are passed to the adapter as-is - transport routing fields (the
 * x-liveagent-* entries in headers, useSystemProxy-derived headers) are passed through
 * opaquely to the seam, which does not read, judge, or cache them.
 */
export type LlmStreamRequest = {
  model: Model<Api>;
  context: Context;
  options: StreamOptionsEx;
};

/**
 * LLM adapter: wires a set of wire protocols into the unified dispatch entry point llm.stream().
 *
 * PR-1 only requires stream() (behavior line-for-line equivalent to the wrapped original
 * implementation); resolveModel / retryPolicy are optional capabilities reserved for PR-2
 * (inverting policy ownership), with no implementers currently, and the retry policy is still
 * carried by the caller via options.streamRetry.
 */
export type LlmAdapter = {
  /** The set of wire protocol ids this adapter handles (i.e. the values of model.api). */
  readonly apis: readonly string[];
  /** Issue a streaming request. It must preserve the semantics of the wrapped implementation, including the wrapping position of in-stream retries. */
  stream(
    model: Model<Api>,
    context: Context,
    options: StreamOptionsEx,
  ): AssistantMessageEventStream;
  /** Reserved for PR-2: model resolution at routing time. */
  resolveModel?(model: Model<Api>): Model<Api>;
  /** Reserved for PR-2: provider-level retry policy lookup. */
  retryPolicy?(model: Model<Api>): StreamRetryConfig | undefined;
};
