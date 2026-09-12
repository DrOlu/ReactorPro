import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

// The wording must match pi-ai `isRetryableAssistantError`'s `provider.?returned.?error`
// pattern: an empty response is a typical transient upstream hiccup and should be retried by
// withStreamRetry rather than killing a whole turn. Before changing this wording, run the pattern
// table in utils/retry.ts.
const EMPTY_RESPONSE_ERROR =
  "Provider returned error: the response contained no content (empty response)";

function hasUsableAssistantContent(message: AssistantMessage): boolean {
  const hasToolCall = message.content.some(
    (block) => block.type === "toolCall" && Boolean(block.id && block.name),
  );
  const hasText = message.content.some(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
  // A thinking block also counts as "the upstream actually produced content". A reasoning model
  // may burn all of max_tokens on reasoning and leave only thinking with no body (this is exactly
  // what pi-ai's supportsThinkingTokenBudget exists for) — that is a budget problem, not an empty
  // response, and retrying would only burn the reasoning budget again.
  const hasThinking = message.content.some(
    (block) => block.type === "thinking" && block.thinking.trim().length > 0,
  );
  return hasToolCall || hasText || hasThinking;
}

/**
 * Only "terminated normally but emitted not a single character" counts as an empty response.
 *
 * - `length`: truncation is a real termination semantic that the downstream truncated-tool-call
 *   chain needs to read, so it must not be rewritten.
 * - `aborted`: the user actively stopped; rewriting it would disguise a cancellation as an
 *   upstream failure (the semantic streamRetry specifically preserves).
 * - `error`: the upstream already gave a real error; keeping the original text is more
 *   informative than replacing it with "empty response".
 */
function shouldRejectAsEmptyResponse(message: AssistantMessage): boolean {
  if (message.stopReason === "length" || message.stopReason === "aborted") return false;
  if (message.stopReason === "error") return false;
  return !hasUsableAssistantContent(message);
}

function buildEmptyResponseError(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    stopReason: "error",
    errorMessage: EMPTY_RESPONSE_ERROR,
  };
}

export function rejectEmptyOpenAICompletionsResponse(
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  void (async () => {
    for await (const event of source) {
      if (event.type === "done" && shouldRejectAsEmptyResponse(event.message)) {
        const error = buildEmptyResponseError(event.message);
        output.push({ type: "error", reason: "error", error });
        return;
      }

      output.push(event);
      if (event.type === "done" || event.type === "error") return;
    }

    const result = await source.result();
    if (shouldRejectAsEmptyResponse(result)) {
      const error = buildEmptyResponseError(result);
      output.push({ type: "error", reason: "error", error });
      return;
    }
    output.end(result);
  })();

  return output;
}
