import {
  type ChatRuntimeControls,
  type CustomProvider,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  normalizeChatRuntimeControlsForProvider,
} from "../../settings";
import type { ProviderRuntimeConfig } from "./types";

/**
 * The sole construction point for ProviderRuntimeConfig — the only place in the repo where the
 * brand is injected. Every caller must take the complete object and pass it along whole (use a
 * spread-derived object if you need to change a level or similar); copying it field by field is
 * not allowed.
 */
export function createProviderRuntimeConfig(
  provider: CustomProvider,
  model: string,
  controlsInput: ChatRuntimeControls | undefined,
): ProviderRuntimeConfig {
  const reasoningParams = {
    providerId: provider.type,
    requestFormat: provider.requestFormat,
    modelId: model,
  };
  const controls = normalizeChatRuntimeControlsForProvider(controlsInput, reasoningParams);
  const reasoningSupported = getChatRuntimeReasoningLevelsForProvider(reasoningParams).length > 0;
  return {
    baseUrl: provider.baseUrl,
    isFullUrl: provider.isFullUrl,
    apiKey: provider.apiKey,
    customHeaders: provider.customHeaders,
    requestFormat: provider.requestFormat,
    reasoning: reasoningSupported
      ? controls.thinkingEnabled
        ? controls.reasoning
        : "off"
      : undefined,
    promptCachingEnabled: provider.promptCachingEnabled,
    promptCacheHintMode: provider.promptCacheHintMode,
    promptCacheRetention: provider.promptCacheRetention,
    nativeWebSearchEnabled: controls.nativeWebSearchEnabled,
    useSystemProxy: provider.useSystemProxy,
    ...(provider.retryPolicy ? { retryPolicy: provider.retryPolicy } : {}),
    modelConfig: findProviderModelConfig(provider, model),
  } as ProviderRuntimeConfig;
}
