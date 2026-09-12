import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { StreamDebugLogger } from "../../debug/agentDebug";
import type { PromptCacheHintMode, ProviderId } from "../../settings";
import {
  attachAnthropicMessagesNativeAttachments,
  attachGeminiGenerativeAINativeAttachments,
  attachOpenAICompletionsNativeAttachments,
  attachOpenAIResponsesNativeAttachments,
} from "../nativeResponsesAttachments";
import {
  composePayloadInterceptorChain,
  installDefaultPayloadInterceptors,
  type PayloadInterceptor,
} from "../service/interceptors";
import { attachAnthropicAutomaticCaching } from "./anthropicCache";
import { attachAnthropicLongContextBeta } from "./anthropicLongContext";
import { attachCodexPromptCacheHint } from "./codexPromptCache";
import { attachCodexResponsesStorage } from "./codexStorage";
import { attachDeepSeekResponsesPayloadCompat } from "./deepSeekResponsesPayload";
import { attachGeminiThoughtSignatureGuard } from "./geminiToolPayload";
import { attachProviderNativeWebSearch } from "./nativeSearchPayload";
import type { StreamOptionsEx } from "./types";
import { attachXaiResponsesPayloadCompat } from "./xaiResponsesPayload";

export type ProviderPayloadMiddleware = (
  options: StreamOptionsEx,
  params: FinalizeProviderStreamOptionsParams,
) => StreamOptionsEx;

export type FinalizeProviderStreamOptionsParams = {
  providerId: ProviderId;
  baseUrl: string;
  options: StreamOptionsEx;
  context?: Context;
  model?: Model<Api>;
  workdir?: string;
  nativeWebSearch?: boolean;
  promptCacheHintMode?: PromptCacheHintMode;
  debugLogger?: StreamDebugLogger;
  extra?: {
    phase?: string;
    round?: number;
    sessionId?: string;
  };
};

export function composePayloadMiddlewares(
  middlewares: ProviderPayloadMiddleware[],
): ProviderPayloadMiddleware {
  return (options, params) =>
    middlewares.reduce((next, middleware) => middleware(next, params), options);
}

export function attachPayloadDebugLogging(
  options: StreamOptionsEx,
  debugLogger?: StreamDebugLogger,
  extra?: {
    phase?: string;
    round?: number;
    sessionId?: string;
  },
): StreamOptionsEx {
  const previousOnPayload = options.onPayload;
  if (!debugLogger && !previousOnPayload) return options;

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(payload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      debugLogger?.logRequest({
        phase: extra?.phase ?? "provider_payload",
        round: extra?.round,
        sessionId: extra?.sessionId,
        api: model.api,
        provider: model.provider,
        payload: nextPayload,
      });

      return nextPayload;
    },
  };
}

/**
 * Named default interceptors for the existing 10 middlewares (PR-3 registration). The order
 * matches the pre-registration finalizePayloadMiddlewares array item by item -- order is part of
 * protocol correctness (e.g. native attachments must precede the gemini thought guard), and is
 * locked down by an order snapshot test. payload-debug-logging is the pinned tail of the chain:
 * custom interceptors are inserted after the default interceptors and before it, ensuring custom
 * changes are still observed by the debug log.
 */
const DEFAULT_PAYLOAD_INTERCEPTORS: readonly PayloadInterceptor[] = [
  {
    name: "anthropic-automatic-caching",
    intercept: (options, params) =>
      attachAnthropicAutomaticCaching(params.providerId, params.baseUrl, options),
  },
  {
    name: "anthropic-long-context-beta",
    intercept: (options, params) =>
      attachAnthropicLongContextBeta(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
        model: params.model,
        context: params.context,
      }),
  },
  {
    name: "codex-responses-storage",
    intercept: (options, params) => attachCodexResponsesStorage(params.providerId, options),
  },
  {
    name: "codex-prompt-cache-hint",
    intercept: (options, params) =>
      attachCodexPromptCacheHint(
        params.providerId,
        params.baseUrl,
        params.promptCacheHintMode,
        params.model,
        options,
      ),
  },
  {
    name: "provider-native-web-search",
    intercept: (options, params) =>
      attachProviderNativeWebSearch(params.providerId, options, params.nativeWebSearch, {
        baseUrl: params.baseUrl,
      }),
  },
  {
    name: "xai-responses-payload-compat",
    intercept: (options, params) =>
      attachXaiResponsesPayloadCompat(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
      }),
  },
  {
    name: "deepseek-responses-payload-compat",
    intercept: (options, params) =>
      attachDeepSeekResponsesPayloadCompat(options, {
        providerId: params.providerId,
        model: params.model,
        context: params.context,
      }),
  },
  {
    name: "native-attachments",
    intercept: (options, params) => {
      if (!params.context || !params.model) return options;
      let nextOptions = attachOpenAIResponsesNativeAttachments(options, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
        baseUrl: params.baseUrl,
      });
      nextOptions = attachOpenAICompletionsNativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
        baseUrl: params.baseUrl,
      });
      nextOptions = attachAnthropicMessagesNativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
        baseUrl: params.baseUrl,
      });
      return attachGeminiGenerativeAINativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
        baseUrl: params.baseUrl,
      });
    },
  },
  {
    name: "gemini-thought-signature-guard",
    intercept: (options, params) =>
      attachGeminiThoughtSignatureGuard(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
      }),
  },
  {
    name: "payload-debug-logging",
    intercept: (options, params) =>
      attachPayloadDebugLogging(options, params.debugLogger, params.extra),
  },
];

installDefaultPayloadInterceptors(DEFAULT_PAYLOAD_INTERCEPTORS);

export function finalizeProviderStreamOptions(
  params: FinalizeProviderStreamOptionsParams,
): StreamOptionsEx {
  return composePayloadInterceptorChain()(params.options, params);
}
