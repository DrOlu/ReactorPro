import type { Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type ModelThinkingCapability,
  resolveModelThinking,
  type ThinkingLevelMap,
  toThinkingLevelMap,
} from "@liveagent/ui/lib/models/modelThinking";
import {
  type CodexRequestFormat,
  getProviderModelDefaults,
  normalizeInputModalities,
  type ProviderId,
  type ProviderModelConfig,
} from "../../settings";
import {
  findBuiltinAnthropicModel,
  isAnthropicAdaptiveModelId,
  resolveAnthropicContextWindow,
  resolveAnthropicWireModelId,
} from "../anthropicModels";
import {
  DEEPSEEK_RESPONSES_API,
  isOfficialDeepSeekBaseUrl,
  normalizeDeepSeekResponsesBaseUrl,
} from "../deepSeekNative";
import { isXaiProviderTarget } from "./xaiResponsesPayload";

// ---------------------------------------------------------------------------
// Thinking levels: availability always comes from lib/models/modelThinking (the
// generated catalog); only the per-vendor wire value rewrite table is kept here.
// toThinkingLevelMap ensures the wire table does not resurrect levels the catalog
// removed, so the UI list and request-time clamp (pi-ai getSupportedThinkingLevels)
// share the same source.
// ---------------------------------------------------------------------------

/** Grok / xAI wire values: the official effort has no minimal, so map it upward to low. */
const XAI_THINKING_WIRE_VALUES: ThinkingLevelMap = {
  minimal: "low",
};

/** DeepSeek Responses accepts none/low/high/max; medium/xhigh map to high. */
const DEEPSEEK_THINKING_WIRE_VALUES: ThinkingLevelMap = {
  off: "none",
  minimal: "low",
  medium: "high",
  xhigh: "high",
};

function resolveModelThinkingFields(
  capability: ModelThinkingCapability,
  wireValues?: ThinkingLevelMap,
): Pick<Model<Api>, "reasoning"> & { thinkingLevelMap?: ThinkingLevelMap } {
  const thinkingLevelMap = toThinkingLevelMap(capability, wireValues);
  return {
    reasoning: capability.reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

const CODEX_RESPONSES_SUFFIX = "/responses";
const CODEX_RESPONSE_SUFFIX = "/response";
const CODEX_CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

type CodexApi = "openai-responses" | "openai-completions";

function resolveKnownModel(
  provider: "openai" | "anthropic" | "google",
  modelId: string,
  baseUrl: string,
): Model<Api> | undefined {
  const known = getBuiltinModels(provider).find((model) => model.id === modelId);
  return known?.api ? { ...known, baseUrl } : undefined;
}

// ---------------------------------------------------------------------------
// Anthropic catalog lookup and custom-model thinking-capability inference
// ---------------------------------------------------------------------------

// Normalized candidates are looked up in the catalog (see anthropicModels.ts); after a
// missed lookup the model loses compat.forceAdaptiveThinking and the thinking config
// degrades to budget_tokens, which was removed in the 4.7+/Fable generation (official
// endpoints return 400, and after a relay strips the field the level becomes entirely
// ineffective). On a hit it inherits the full catalog metadata; by default the user's
// configured original id is kept, while the [1m] suffix for official/Vertex endpoints
// is stripped at the wire layer, avoiding sending catalog decoration to services that
// only accept canonical ids.
function resolveKnownAnthropicModel(
  modelId: string,
  baseUrl: string,
  upstreamBaseUrl?: string,
): Model<Api> | undefined {
  const known = findBuiltinAnthropicModel(modelId);
  if (!known?.api) return undefined;
  const endpointBaseUrl = upstreamBaseUrl?.trim() || baseUrl;
  return {
    ...known,
    baseUrl,
    id: resolveAnthropicWireModelId(modelId, endpointBaseUrl),
    name: modelId,
  } as Model<Api>;
}

// For third-party renamed ids that miss the catalog entirely (e.g. claude-4.6-sonnet),
// fall back to id heuristics: ids recognized as belonging to the adaptive family get
// compat.forceAdaptiveThinking (wire semantics — thinking.type adaptive +
// output_config.effort); both pi-ai stream() and the local thinkingLevels.ts treat this
// field as authoritative. Level declarations are not here — resolveModelThinking's same
// heuristic covers that.
function deriveAnthropicCompatForCustomModel(
  modelId: string,
): Model<"anthropic-messages">["compat"] | undefined {
  return isAnthropicAdaptiveModelId(modelId) ? { forceAdaptiveThinking: true } : undefined;
}

function maybeAppendGeminiApiVersion(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    let pathname = url.pathname.replace(/\/+$/, "");
    const lowerPathname = pathname.toLowerCase();
    for (const suffix of [":streamgeneratecontent", ":generatecontent"]) {
      if (lowerPathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length);
        break;
      }
    }
    const modelsIndex = pathname.toLowerCase().lastIndexOf("/models");
    if (
      modelsIndex >= 0 &&
      (pathname.length === modelsIndex + "/models".length ||
        pathname.charAt(modelsIndex + "/models".length) === "/")
    ) {
      pathname = pathname.slice(0, modelsIndex);
    }
    if (!pathname || pathname === "/") {
      url.pathname = "/v1beta";
      return url.toString().replace(/\/+$/, "");
    }
    if (/\/v\d+(?:beta)?$/i.test(pathname)) {
      url.pathname = pathname;
      return url.toString().replace(/\/+$/, "");
    }
    url.pathname = `${pathname}/v1beta`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

function maybeAppendCodexApiVersion(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!/\/v1$/i.test(pathname)) {
      url.pathname = `${pathname}/v1`;
    } else {
      url.pathname = pathname;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

function supportsOpenAICompletionsImageInputModel(modelId: string) {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (normalizedModelId.includes("search-preview")) return false;
  return (
    normalizedModelId.startsWith("gpt-5") ||
    normalizedModelId.startsWith("chat-latest") ||
    normalizedModelId.startsWith("gpt-4o") ||
    normalizedModelId.startsWith("chatgpt-4o") ||
    normalizedModelId.startsWith("gpt-4.1") ||
    normalizedModelId.startsWith("gpt-4.5") ||
    normalizedModelId.startsWith("gpt-4-turbo") ||
    normalizedModelId.startsWith("o3") ||
    normalizedModelId.startsWith("o4") ||
    normalizedModelId.includes("vision") ||
    normalizedModelId.includes("qwen-vl") ||
    normalizedModelId.includes("qwen2-vl") ||
    normalizedModelId.includes("qwen2.5-vl") ||
    normalizedModelId.includes("qwen3-vl") ||
    normalizedModelId.includes("llava") ||
    normalizedModelId.includes("pixtral")
  );
}

function resolveCodexModelInput(api: CodexApi, modelId: string): Model<Api>["input"] {
  if (api === "openai-responses" || supportsOpenAICompletionsImageInputModel(modelId)) {
    return ["text", "image"];
  }
  return ["text"];
}

/**
 * Only the DeepSeek Flash family accepts images: the official "Image Understanding"
 * guide states that deepseek-flash supports the three forms image_url / input_image /
 * Files API file_id, and notes that the old model name deepseek-v4-flash-vision-exp
 * has been retired, with its requests likewise handled by the latest Flash. Pro and
 * earlier models are not opened up along with it, to avoid false capability claims.
 *
 * If a relay endpoint does not actually accept images, override inputModalities to
 * ["text"] in settings: the user override takes precedence over this inference (see
 * inputOverride in createModelFromConfig).
 */
function resolveDeepSeekModelInput(modelId: string): Model<Api>["input"] {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedModelId) return ["text"];
  return normalizedModelId.includes("flash") ? ["text", "image"] : ["text"];
}

function isOfficialOpenAIBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl?.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function normalizeCompatBaseUrl(baseUrl: string | undefined) {
  return baseUrl?.trim().replace(/\/+$/, "").toLowerCase() ?? "";
}

function resolveCodexOpenAIResponsesCompat(params: {
  baseUrl: string;
  upstreamBaseUrl?: string;
}): Model<"openai-responses">["compat"] | undefined {
  const compatBaseUrl = normalizeCompatBaseUrl(params.upstreamBaseUrl ?? params.baseUrl);
  if (isOfficialOpenAIBaseUrl(compatBaseUrl)) return undefined;

  return {
    supportsDeveloperRole: false,
  };
}

function resolveCodexOpenAICompletionsOverrides(params: {
  baseUrl: string;
  upstreamBaseUrl?: string;
  modelId: string;
}):
  | {
      compat: OpenAICompletionsCompat;
      thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
    }
  | undefined {
  const compatBaseUrl = normalizeCompatBaseUrl(params.upstreamBaseUrl ?? params.baseUrl);
  if (isOfficialOpenAIBaseUrl(compatBaseUrl)) return undefined;

  const normalizedModelId = params.modelId.trim().toLowerCase();
  const isZai = compatBaseUrl.includes("api.z.ai");
  const isXai = compatBaseUrl.includes("api.x.ai");
  const isOpenRouter = compatBaseUrl.includes("openrouter.ai");
  const isGroq = compatBaseUrl.includes("groq.com");
  const isChutes = compatBaseUrl.includes("chutes.ai");
  const isKnownNonOpenAIModel =
    normalizedModelId.includes("qwen") ||
    normalizedModelId.includes("gpt-oss") ||
    normalizedModelId.includes("glm") ||
    normalizedModelId.includes("kimi") ||
    normalizedModelId.includes("minimax");
  const shouldUseCompatibleDefaults =
    isKnownNonOpenAIModel ||
    isZai ||
    isXai ||
    isOpenRouter ||
    isGroq ||
    isChutes ||
    compatBaseUrl.includes("cerebras.ai") ||
    compatBaseUrl.includes("opencode.ai") ||
    !isOfficialOpenAIBaseUrl(compatBaseUrl);

  if (!shouldUseCompatibleDefaults) return undefined;

  const compat: OpenAICompletionsCompat = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsFinishReason: false,
  };

  if (isXai || isZai) {
    compat.supportsReasoningEffort = false;
  }
  if (isChutes) {
    compat.maxTokensField = "max_tokens";
  }
  if (isZai) {
    compat.thinkingFormat = "zai";
  } else if (isOpenRouter) {
    compat.thinkingFormat = "openrouter";
  }
  return {
    compat,
    ...(isGroq && normalizedModelId === "qwen/qwen3-32b"
      ? {
          thinkingLevelMap: {
            minimal: "default",
            low: "default",
            medium: "default",
            high: "default",
            xhigh: "default",
          },
        }
      : {}),
  };
}

function normalizeCodexBaseUrl(baseUrl: string): {
  baseUrl: string;
  preferredApi?: CodexApi;
} {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  const lower = normalized.toLowerCase();
  let preferredApi: CodexApi | undefined;

  if (lower.endsWith(CODEX_CHAT_COMPLETIONS_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_CHAT_COMPLETIONS_SUFFIX.length);
    preferredApi = "openai-completions";
  } else if (lower.endsWith(CODEX_RESPONSES_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_RESPONSES_SUFFIX.length);
    preferredApi = "openai-responses";
  } else if (lower.endsWith(CODEX_RESPONSE_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_RESPONSE_SUFFIX.length);
    preferredApi = "openai-responses";
  }

  return {
    baseUrl: maybeAppendCodexApiVersion(normalized),
    preferredApi,
  };
}

function inferCodexApi(requestFormat?: CodexRequestFormat, preferredApi?: CodexApi): CodexApi {
  return requestFormat ?? preferredApi ?? "openai-responses";
}

export function createModelFromConfig(
  providerId: ProviderId,
  modelId: string,
  baseUrl: string,
  requestFormat?: CodexRequestFormat,
  modelConfig?: ProviderModelConfig,
  upstreamBaseUrl?: string,
): Model<Api> {
  const defaults = getProviderModelDefaults(providerId, modelId);
  const configuredContextWindow = modelConfig?.contextWindow ?? defaults.contextWindow;
  const contextWindow =
    providerId === "claude_code"
      ? resolveAnthropicContextWindow(
          modelId,
          configuredContextWindow,
          upstreamBaseUrl?.trim() || baseUrl,
        )
      : configuredContextWindow;
  const maxTokens = modelConfig?.maxOutputToken ?? defaults.maxOutputToken;
  // Billing has been removed entirely: pi-ai's Model.cost is a structurally required
  // field, so feed zero cost uniformly; the usage.cost computed on the streaming side
  // is always 0 (the known branch is likewise overridden, preventing catalog unit
  // prices from resurrecting billing).
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Sole source of thinking capability (reasoning + levels): the generated catalog
  // (with its fallback inference on a miss). On a pi-ai catalog hit only its
  // thinkingLevelMap wire rewrite values are used; availability is not taken from it.
  const thinking = resolveModelThinking(providerId, modelId);
  // Explicit user override of input modalities (e.g. enabling image input for a
  // multimodal model not recognized by the built-in allowlist); by default it goes
  // through each provider's built-in inference/known model catalog. The validation
  // logic shares the same normalizer as settings loading and does not trust the
  // caller's static types. It only takes effect in provider branches where attachment
  // sending is actually gated by model.input (codex/gemini/deepseek); the anthropic
  // attachment path does not read model.input yet, where the user override does not
  // apply, avoiding false capability claims.
  const inputOverride = normalizeInputModalities(modelConfig?.inputModalities);

  if (providerId === "deepseek") {
    return {
      id: modelId,
      name: modelId,
      api: DEEPSEEK_RESPONSES_API,
      provider: "deepseek",
      baseUrl: normalizeDeepSeekResponsesBaseUrl(baseUrl, {
        officialHost: isOfficialDeepSeekBaseUrl(upstreamBaseUrl?.trim() || baseUrl),
      }),
      ...resolveModelThinkingFields(thinking, DEEPSEEK_THINKING_WIRE_VALUES),
      input: inputOverride ?? resolveDeepSeekModelInput(modelId),
      cost: zeroCost,
      contextWindow,
      maxTokens,
      compat: {
        supportsDeveloperRole: true,
        supportsLongCacheRetention: false,
        supportsStrictMode: false,
      },
    } as Model<Api>;
  }

  if (providerId === "codex" || providerId === "xai") {
    const { baseUrl: normalizedBaseUrl, preferredApi } = normalizeCodexBaseUrl(baseUrl);
    // A real xai provider, or Codex directly connected to api.x.ai: fixed to Responses (agentic search, etc.).
    const isXaiTarget = isXaiProviderTarget({
      providerId,
      baseUrl: upstreamBaseUrl?.trim() || baseUrl,
    });
    const api = isXaiTarget ? "openai-responses" : inferCodexApi(requestFormat, preferredApi);
    const responsesCompat =
      api === "openai-responses"
        ? resolveCodexOpenAIResponsesCompat({
            baseUrl: normalizedBaseUrl,
            upstreamBaseUrl,
          })
        : undefined;
    const known = resolveKnownModel("openai", modelId, normalizedBaseUrl);
    if (known && known.api === api) {
      return {
        ...known,
        contextWindow,
        maxTokens,
        cost: zeroCost,
        ...(inputOverride ? { input: inputOverride } : {}),
        ...resolveModelThinkingFields(
          thinking,
          isXaiTarget ? XAI_THINKING_WIRE_VALUES : known.thinkingLevelMap,
        ),
        ...(responsesCompat
          ? {
              compat: {
                ...(known.compat ?? {}),
                ...responsesCompat,
              },
            }
          : {}),
      };
    }

    const completionsOverrides =
      api === "openai-completions"
        ? resolveCodexOpenAICompletionsOverrides({
            baseUrl: normalizedBaseUrl,
            upstreamBaseUrl,
            modelId,
          })
        : undefined;
    const custom: Model<Api> = {
      id: modelId,
      name: modelId,
      api,
      provider: "openai",
      baseUrl: normalizedBaseUrl,
      ...resolveModelThinkingFields(
        thinking,
        isXaiTarget ? XAI_THINKING_WIRE_VALUES : completionsOverrides?.thinkingLevelMap,
      ),
      input: inputOverride ?? resolveCodexModelInput(api, modelId),
      cost: zeroCost,
      contextWindow,
      maxTokens,
    };
    if (api === "openai-responses" && responsesCompat) {
      custom.compat = responsesCompat;
    } else if (completionsOverrides) {
      custom.compat = completionsOverrides.compat;
    }
    return custom;
  }

  if (providerId === "gemini") {
    const normalizedBaseUrl = maybeAppendGeminiApiVersion(baseUrl);
    const known = resolveKnownModel("google", modelId, normalizedBaseUrl);
    if (known && known.api === "google-generative-ai") {
      return {
        ...known,
        contextWindow,
        maxTokens,
        cost: zeroCost,
        ...(inputOverride ? { input: inputOverride } : {}),
        ...resolveModelThinkingFields(thinking, known.thinkingLevelMap),
      };
    }

    const custom: Model<"google-generative-ai"> = {
      id: modelId,
      name: modelId,
      api: "google-generative-ai",
      provider: "google",
      baseUrl: normalizedBaseUrl,
      ...resolveModelThinkingFields(thinking),
      input: inputOverride ?? ["text", "image"],
      cost: zeroCost,
      contextWindow,
      maxTokens,
    };
    return custom;
  }

  const known = resolveKnownAnthropicModel(modelId, baseUrl, upstreamBaseUrl);
  if (known) {
    return {
      ...known,
      contextWindow,
      maxTokens,
      cost: zeroCost,
      ...resolveModelThinkingFields(thinking, known.thinkingLevelMap),
    };
  }

  const customCompat = deriveAnthropicCompatForCustomModel(modelId);
  const custom: Model<"anthropic-messages"> = {
    id: resolveAnthropicWireModelId(modelId, upstreamBaseUrl?.trim() || baseUrl),
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    ...resolveModelThinkingFields(thinking),
    input: ["text"],
    cost: zeroCost,
    contextWindow,
    maxTokens,
    ...(customCompat ? { compat: customCompat } : {}),
  };
  return custom;
}
