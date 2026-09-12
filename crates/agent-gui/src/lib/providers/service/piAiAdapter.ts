import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  type GoogleOptions,
  stream as streamGoogle,
} from "@earendil-works/pi-ai/api/google-generative-ai";
import {
  type OpenAICompletionsOptions,
  stream as streamOpenAICompletions,
} from "@earendil-works/pi-ai/api/openai-completions";
import {
  type OpenAIResponsesOptions,
  stream as streamOpenAIResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import { resolveMaxTokens } from "../runtime/common";
import { wrapInlineThinkTagStream } from "../runtime/inlineThinkTagStream";
import { rejectEmptyOpenAICompletionsResponse } from "../runtime/openAICompletionsStream";
import { withStreamRetry } from "../runtime/streamRetry";
import {
  clampOpenAIReasoningEffort,
  resolveAnthropicThinkingRuntime,
  resolveGeminiThinkingRuntime,
} from "../runtime/thinkingLevels";
import { omitToolResultImagesForTextOnlyModel } from "../runtime/toolResultImageFallback";
import type { StreamOptionsEx, ToolChoice } from "../runtime/types";
import type { LlmAdapter } from "./types";

// ============================================================================
// pi-ai four-protocol adapter.
//
// Each branch is a faithful move of the original implementation in streamByApi.ts (the PR-1
// behavioural-equivalence invariant): the withStreamRetry wrapper position, toolChoice mapping,
// thinking-runtime resolution, and comments inside each branch are all preserved with no rewrite.
// The acceptance criterion is PR-0 golden snapshots passing with zero modifications.
//
// The only entry-side handling: for the openai-completions / openai-responses / google protocols,
// tool-result images for text-only models (model.input without "image") are replaced with
// explanatory text before entering pi-ai. For these three protocols pi-ai already silently drops
// such images based on model.input, so the model would only see "see image below" with no image;
// this makes the reason for the missing image and the alternative explicit to the model.
// ============================================================================

function mapToolChoiceToOpenAI(
  toolChoice: ToolChoice | undefined,
): OpenAICompletionsOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "any") return "required";
  if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
  return {
    type: "function",
    function: {
      name: toolChoice.name,
    },
  };
}

function mapToolChoiceToGoogle(
  toolChoice: ToolChoice | undefined,
): GoogleOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "any") {
    return toolChoice;
  }
  return "auto";
}

function buildOpenAIBaseOptions(model: Model<Api>, options: StreamOptionsEx) {
  return {
    temperature: options.temperature,
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    signal: options.signal,
    apiKey: options.apiKey,
    cacheRetention: options.cacheRetention,
    sessionId: options.sessionId,
    headers: options.headers,
    onPayload: options.onPayload,
    maxRetryDelayMs: options.maxRetryDelayMs,
    metadata: options.metadata,
  };
}

function streamAnthropicMessages(model: Model<Api>, context: Context, options: StreamOptionsEx) {
  // Anthropic: we need to call streamAnthropic() ourselves in order to pass toolChoice
  // explicitly (and to enable/disable thinking).
  const anthropicThinking = resolveAnthropicThinkingRuntime(model, options);
  // Anthropic rejects extended thinking together with a forced tool ("any"/{type:"tool"}) in the
  // same request (400). Downgrade to auto: callers that force within bounds (the plan mode
  // supplementary submit turn) also inject a message-level reminder, so the semantics still hold;
  // a direct 400 would instead enter the retry/failover loop.
  const requestedToolChoice = options.toolChoice ?? "none";
  const anthropicToolChoice =
    anthropicThinking.thinkingEnabled &&
    requestedToolChoice !== "none" &&
    requestedToolChoice !== "auto"
      ? "auto"
      : requestedToolChoice;
  return withStreamRetry(
    () => {
      return streamAnthropic(model as Model<"anthropic-messages">, context, {
        temperature: options.temperature,
        maxTokens: anthropicThinking.maxTokens,
        signal: options.signal,
        apiKey: options.apiKey,
        cacheRetention: options.cacheRetention,
        sessionId: options.sessionId,
        headers: options.headers,
        onPayload: options.onPayload,
        maxRetryDelayMs: options.maxRetryDelayMs,
        metadata: options.metadata,
        thinkingEnabled: anthropicThinking.thinkingEnabled,
        ...(anthropicThinking.effort ? { effort: anthropicThinking.effort } : {}),
        ...(anthropicThinking.thinkingBudgetTokens !== undefined
          ? { thinkingBudgetTokens: anthropicThinking.thinkingBudgetTokens }
          : {}),
        toolChoice: anthropicToolChoice,
      });
    },
    { signal: options.signal, ...options.streamRetry },
  );
}

function streamOpenAICompletionsApi(model: Model<Api>, context: Context, options: StreamOptionsEx) {
  // Strictly validating OpenAI-compatible endpoints (xAI/various relay gateways) return 400
  // directly for requests that carry tool_choice but no tools ("A tool_choice was set on the
  // request but no tools were specified") — text-only requests such as compaction summaries and
  // title generation have no tools and would trip this. tool_choice is meaningless without tools
  // anyway, so it is only sent when the request actually carries tools.
  const openAIOptions: OpenAICompletionsOptions = {
    ...buildOpenAIBaseOptions(model, options),
    reasoningEffort: clampOpenAIReasoningEffort(model, options.reasoning),
    toolChoice: context.tools?.length ? mapToolChoiceToOpenAI(options.toolChoice) : undefined,
  };
  return withStreamRetry(
    () => {
      return wrapInlineThinkTagStream(
        rejectEmptyOpenAICompletionsResponse(
          streamOpenAICompletions(model as Model<"openai-completions">, context, openAIOptions),
        ),
      );
    },
    { signal: options.signal, ...options.streamRetry },
  );
}

function streamOpenAIResponsesApi(model: Model<Api>, context: Context, options: StreamOptionsEx) {
  const openAIOptions: OpenAIResponsesOptions = {
    ...buildOpenAIBaseOptions(model, options),
    reasoningEffort: clampOpenAIReasoningEffort(model, options.reasoning),
  };
  return withStreamRetry(
    () =>
      wrapInlineThinkTagStream(
        streamOpenAIResponses(model as Model<"openai-responses">, context, openAIOptions),
      ),
    {
      signal: options.signal,
      ...options.streamRetry,
    },
  );
}

function streamGoogleGenerativeAi(model: Model<Api>, context: Context, options: StreamOptionsEx) {
  const googleOptions: GoogleOptions = {
    temperature: options.temperature,
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    signal: options.signal,
    apiKey: options.apiKey,
    headers: options.headers,
    onPayload: options.onPayload,
    maxRetryDelayMs: options.maxRetryDelayMs,
    metadata: options.metadata,
    thinking: resolveGeminiThinkingRuntime(model, options.reasoning),
    toolChoice: mapToolChoiceToGoogle(options.toolChoice) ?? "none",
  };
  return withStreamRetry(
    () => streamGoogle(model as Model<"google-generative-ai">, context, googleOptions),
    {
      signal: options.signal,
      ...options.streamRetry,
    },
  );
}

export const piAiAdapter: LlmAdapter = {
  apis: [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "google-generative-ai",
  ] as const,
  stream(model, context, options) {
    switch (model.api) {
      case "anthropic-messages":
        // Do not strip tool-result images based on model.input: a custom anthropic model's input
        // is a conservative default (["text"]), the model behind a relay may be vision-capable, and
        // pi-ai does not read model.input for this protocol either, consistent with the attachment
        // path (see the modelFactory comment).
        return streamAnthropicMessages(model, context, options);
      case "openai-completions":
        return streamOpenAICompletionsApi(
          model,
          omitToolResultImagesForTextOnlyModel(context, model),
          options,
        );
      case "openai-responses":
        return streamOpenAIResponsesApi(
          model,
          omitToolResultImagesForTextOnlyModel(context, model),
          options,
        );
      case "google-generative-ai":
        return streamGoogleGenerativeAi(
          model,
          omitToolResultImagesForTextOnlyModel(context, model),
          options,
        );
      default:
        // The registry routes by apis before reaching here, so this is normally unreachable; the
        // defensive branch keeps the same error text.
        throw new Error(`Unsupported model API: ${model.api}`);
    }
  },
};
