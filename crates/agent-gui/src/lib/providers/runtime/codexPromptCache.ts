import type { Api, Model, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import type { CodexRequestFormat, PromptCacheHintMode, ProviderId } from "../../settings";
import { isRecord, normalizeSessionId } from "./common";
import type { StreamOptionsEx } from "./types";

// OpenAI's length limit for prompt_cache_key (consistent with pi-ai's clamp rule).
const OPENAI_PROMPT_CACHE_KEY_MAX_CHARS = 64;
const OPENROUTER_SESSION_ID_MAX_CHARS = 256;

function clampPromptCacheKey(value: string): string {
  return value.length > OPENAI_PROMPT_CACHE_KEY_MAX_CHARS
    ? value.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_CHARS)
    : value;
}

function clampOpenRouterSessionId(value: string): string {
  return value.length > OPENROUTER_SESSION_ID_MAX_CHARS
    ? value.slice(0, OPENROUTER_SESSION_ID_MAX_CHARS)
    : value;
}

const OPENAI_PROMPT_CACHE_PAYLOAD_KEYS = [
  "prompt_cache_key",
  "prompt_cache_retention",
  "prompt_cache_options",
] as const;

function parseHostname(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isOfficialOpenAIHostname(hostname: string | undefined): boolean {
  return hostname === "api.openai.com" || Boolean(hostname?.endsWith(".api.openai.com"));
}

export function resolvePromptCacheHintMode(
  configuredMode: PromptCacheHintMode | undefined,
  baseUrl: string,
  modelApi?: CodexRequestFormat,
): Exclude<PromptCacheHintMode, "auto"> {
  if (configuredMode && configuredMode !== "auto") return configuredMode;
  // The Responses pipeline aligns with Codex CLI: the CLI sends a session-level prompt_cache_key to all
  // endpoints, so relays serving Codex traffic are necessarily compatible. If a strictly validating third-party
  // Responses endpoint returns 400, the escape hatch is to set none at the provider/model level, not to revert
  // this to a conservative value (PR#436).
  if (modelApi === "openai-responses") return "openai-key";
  const hostname = parseHostname(baseUrl);
  if (isOfficialOpenAIHostname(hostname)) {
    return "openai-key";
  }
  if (hostname === "openrouter.ai" || hostname?.endsWith(".openrouter.ai")) {
    return "openrouter-session";
  }
  return "none";
}

function isExplicitNoCacheOptions(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).mode === "explicit"
  );
}

/**
 * `prompt_cache_options: { mode: "explicit" }` is the **only** way for GPT-5.6+ to explicitly disable
 * implicit prefix caching (pi-ai generates it only when cacheRetention=none and the model declares that
 * capability). Stripping it amounts to "the user asked for no caching, yet the wire still implicitly caches",
 * so it must be let through in none mode.
 *
 * Official hosts only: like prompt_cache_key, this field is an OpenAI private extension, and strictly
 * validating relay endpoints return 400 outright (#307 and the like). On a relay it is better to fall back to
 * implicit caching than to kill the whole request just to disable caching -- that is the reason this file exists.
 */
function supportsExplicitNoCache(baseUrl: string, model: Model<Api> | undefined): boolean {
  if (!model || model.api !== "openai-responses") return false;
  if (!isOfficialOpenAIHostname(parseHostname(baseUrl))) return false;
  const compat = model.compat as OpenAIResponsesCompat | undefined;
  return compat?.supportsExplicitPromptCacheMode === true;
}

function stripOpenAIPromptCacheFields(
  payload: Record<string, unknown>,
  preserveExplicitNoCache: boolean,
) {
  // pi-ai's completions buildParams always explicitly writes prompt_cache_key: undefined;
  // judging by value, undefined is dropped during serialization anyway, so it is not worth copying the payload per request for it.
  const keysToStrip = OPENAI_PROMPT_CACHE_PAYLOAD_KEYS.filter((key) => {
    if (payload[key] === undefined) return false;
    return !(
      key === "prompt_cache_options" &&
      preserveExplicitNoCache &&
      isExplicitNoCacheOptions(payload[key])
    );
  });
  if (keysToStrip.length === 0) return payload;
  const nextPayload = { ...payload };
  for (const key of keysToStrip) delete nextPayload[key];
  return nextPayload;
}

/**
 * Looks up an existing x-session-id in the request headers (case-insensitive). attach and describe share
 * this one check: when the header exists, attach skips injection -- the effective routing key is the existing
 * header's value, not the clamped sessionId. If describe did not use the same check, it would describe a
 * request that does not exist in that scenario.
 * Returning undefined means the header is absent; when it exists but its value is not a string (e.g. a null
 * placeholder) an empty string is returned, consistent with the empty-string semantics of "a key that should
 * exist but has no value".
 */
function findExistingSessionHeader(headers: StreamOptionsEx["headers"]): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "x-session-id") {
      return typeof value === "string" ? value : "";
    }
  }
  return undefined;
}

/**
 * Describes "the cache parameters actually applied this round" for prefix attribution accounting. Same
 * contract as anthropicCache's describeAnthropicCacheShape: deliberately reuse this module's own decision
 * functions (resolvePromptCacheHintMode / normalizeSessionId / clamp) rather than duplicating the conditions on
 * the diagnostic side.
 *
 * codex's cache is implicit prefix matching with no breakpoints, and there are only two variable knobs:
 *   - prompt_cache_key (cache shard routing): sessionId changes -> shard changes -> full miss.
 *     When sessionId is missing, attachCodexPromptCacheHint **silently** skips injection -- the server falls
 *     back to machine/organization routing, and the hit rate merely looks worse without reporting any error.
 *     Recording cacheKey in attribution makes this silent degradation visible for the first time (cacheKey
 *     goes from a value to an empty string).
 *   - cacheRetention:long is mapped by pi-ai to prompt_cache_retention: "24h".
 *
 * headers is optional: if a request on the openrouter path already carries a custom x-session-id,
 * attachCodexPromptCacheHint skips injection -- the effective routing key is the existing header's value.
 * describe must then report the existing header's value rather than clamp(sessionId), otherwise it describes a
 * request that does not exist.
 */
export function describeCodexCacheShape(
  providerId: ProviderId,
  baseUrl: string,
  configuredMode: PromptCacheHintMode | undefined,
  modelApi: CodexRequestFormat | undefined,
  sessionId: string | undefined,
  cacheRetention?: string,
  headers?: StreamOptionsEx["headers"],
): { cacheRetention?: string; ttl?: string; breakpointStrategy?: string; cacheKey?: string } {
  if (providerId !== "codex") {
    return { cacheRetention: cacheRetention ?? "", breakpointStrategy: "none" };
  }
  const mode =
    cacheRetention === "none"
      ? "none"
      : resolvePromptCacheHintMode(configuredMode, baseUrl, modelApi);
  const normalizedSessionId = normalizeSessionId(sessionId);
  // Same source as attach: when the header exists (even with an empty value) injection is skipped, and the header value wins.
  const existingSessionHeader =
    mode === "openrouter-session" ? findExistingSessionHeader(headers) : undefined;

  return {
    cacheRetention: cacheRetention ?? "",
    breakpointStrategy: mode === "none" ? "none" : `codex-${mode}`,
    cacheKey:
      mode === "openai-key" && normalizedSessionId
        ? clampPromptCacheKey(normalizedSessionId)
        : mode === "openrouter-session"
          ? (existingSessionHeader ??
            (normalizedSessionId ? clampOpenRouterSessionId(normalizedSessionId) : ""))
          : "",
  };
}

export function attachCodexPromptCacheHint(
  providerId: ProviderId,
  baseUrl: string,
  configuredMode: PromptCacheHintMode | undefined,
  model: Model<Api> | undefined,
  options: StreamOptionsEx,
): StreamOptionsEx {
  if (providerId !== "codex") return options;
  const mode =
    options.cacheRetention === "none"
      ? "none"
      : resolvePromptCacheHintMode(configuredMode, baseUrl, model?.api as CodexRequestFormat);
  const sessionId = normalizeSessionId(options.sessionId);
  const effectiveCacheRetention = mode === "none" ? "none" : options.cacheRetention;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    // In mode=none, force retention to none as well: make pi-ai generate no cache hint at the source
    // (the responses pipeline injects prompt_cache_key based on retention), rather than relying on
    // stripping known fields afterward as a fallback.
    cacheRetention: effectiveCacheRetention,
    headers:
      mode === "openrouter-session" &&
      sessionId &&
      findExistingSessionHeader(options.headers) === undefined
        ? { ...options.headers, "x-session-id": clampOpenRouterSessionId(sessionId) }
        : options.headers,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (!isRecord(nextPayload)) return nextPayload;

      if (
        mode === "openai-key" &&
        sessionId &&
        (model.api === "openai-responses" || model.api === "openai-completions") &&
        typeof nextPayload.prompt_cache_key !== "string"
      ) {
        return {
          ...nextPayload,
          prompt_cache_key: clampPromptCacheKey(sessionId),
        };
      }

      return mode === "openai-key"
        ? nextPayload
        : stripOpenAIPromptCacheFields(
            nextPayload,
            effectiveCacheRetention === "none" && supportsExplicitNoCache(baseUrl, model),
          );
    },
  };
}
