import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import type {
  CodexRequestFormat,
  CustomProvider,
  PromptCacheHintMode,
  ProviderId,
  ProviderModelConfig,
  ProviderRetryPolicy,
  ReasoningLevel,
} from "../../settings";
import type { StreamRetryConfig } from "./streamRetry";

export type ModelOption = SharedModelOption<ProviderId>;

declare const PROVIDER_RUNTIME_CONFIG_BRAND: unique symbol;

/**
 * Provider request runtime config -- the single definition in the repo; its only construction point is
 * createProviderRuntimeConfig() (see ./providerRuntimeConfig).
 *
 * The brand field makes hand-written object literals fail to compile: nearly all fields are optional, and when
 * copying field by field and dropping customHeaders / promptCacheRetention, TypeScript would not complain -- which
 * is exactly the root cause of custom request headers silently failing across the chat pipeline. To derive one,
 * use spread ({...runtime, reasoning}); the brand is preserved through the spread.
 */
export type ProviderRuntimeConfig = {
  readonly [PROVIDER_RUNTIME_CONFIG_BRAND]: true;
  baseUrl: string;
  isFullUrl: boolean;
  apiKey: string;
  customHeaders?: CustomProvider["customHeaders"];
  requestFormat?: CodexRequestFormat;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
  promptCacheHintMode?: PromptCacheHintMode;
  promptCacheRetention?: "short" | "long";
  nativeWebSearchEnabled?: boolean;
  useSystemProxy?: boolean;
  /** Provider-level in-stream retry policy; absent = global default. failover carries it per candidate. */
  retryPolicy?: ProviderRetryPolicy;
  modelConfig?: ProviderModelConfig;
};

export type ToolChoice =
  | "auto"
  | "any"
  | "none"
  | {
      type: "tool";
      name: string;
    };

export type StreamOptionsEx = SimpleStreamOptions & {
  /**
   * Note: pi-ai's streamSimpleAnthropic() internally drops toolChoice via buildBaseOptions(),
   * so here we call streamAnthropic() ourselves and pass toolChoice down explicitly.
   */
  toolChoice?: ToolChoice;
  /** DeepSeek-only wire override for callers that must explicitly disable thinking. */
  deepSeekThinking?: "disabled";
  /** Conversation workdir used to resolve provider-native local attachments. */
  workdir?: string;
  /** Escape hatch for the unified provider stream retry in streamByApi.ts. */
  streamRetry?: StreamRetryConfig;
};
