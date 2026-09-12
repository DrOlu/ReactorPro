/**
 * Unified entry point for prefix-attributed provider cache parameters. Dispatches per protocol
 * family: anthropic records a breakpoint strategy and TTL; codex caching is implicit prefix
 * matching, where the variable parts are the shard routing key (prompt_cache_key / x-session-id)
 * and retention. Both the dispatch and the modelApi type narrowing stay in the providers layer,
 * so the runner no longer inlines if/else or casts model.api.
 */
import type { CacheRetention } from "@earendil-works/pi-ai";
import type { PrefixShapeCacheControl } from "../../debug/prefixCacheShape";
import type { CodexRequestFormat, PromptCacheHintMode, ProviderId } from "../../settings";
import { describeAnthropicCacheShape } from "./anthropicCache";
import { describeCodexCacheShape } from "./codexPromptCache";
import type { StreamOptionsEx } from "./types";

const CODEX_REQUEST_FORMATS: readonly CodexRequestFormat[] = [
  "openai-completions",
  "openai-responses",
];

/**
 * model.api comes from pi-ai's full Api set (which also includes anthropic-messages etc.), and
 * the codex check only knows about the two openai formats. Narrow it here rather than casting at
 * the call site: non-codex formats become undefined, letting resolvePromptCacheHintMode use its
 * own domain fallback instead of entering a branch with a misrepresented type.
 */
function toCodexRequestFormat(modelApi: string | undefined): CodexRequestFormat | undefined {
  return CODEX_REQUEST_FORMATS.find((format) => format === modelApi);
}

export function describeProviderCacheShape(params: {
  providerId: ProviderId;
  baseUrl: string;
  promptCacheHintMode?: PromptCacheHintMode;
  modelApi?: string;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  headers?: StreamOptionsEx["headers"];
}): PrefixShapeCacheControl {
  if (params.providerId === "deepseek") {
    return {
      cacheRetention: "automatic",
      breakpointStrategy: "deepseek-prefix",
    };
  }
  if (params.providerId === "codex") {
    return describeCodexCacheShape(
      params.providerId,
      params.baseUrl,
      params.promptCacheHintMode,
      toCodexRequestFormat(params.modelApi),
      params.sessionId,
      params.cacheRetention,
      params.headers,
    );
  }
  return describeAnthropicCacheShape(params.providerId, params.baseUrl, params.cacheRetention);
}
