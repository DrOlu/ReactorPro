import type { CacheRetention, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  ANTHROPIC_DEFAULT_REQUEST_HEADERS,
  CLAUDE_SESSION_ID_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  CODEX_CONVERSATION_ID_HEADER,
  CODEX_OFFICIAL_SESSION_ID_HEADER,
  CODEX_SESSION_ID_HEADER,
  CODEX_THREAD_ID_HEADER,
  isAnthropicOAuthApiKey,
  mergeCustomHeaders,
} from "@liveagent/ui/lib/providers/customHeaders";
import { type PreparedProxyRequest, prepareProxyRequest } from "@liveagent/ui/lib/providers/proxy";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { CodexRequestFormat, ProviderId, ReasoningLevel } from "../../settings";
import {
  normalizeDeepSeekResponsesBaseUrl,
  normalizeDeepSeekResponsesEndpoint,
} from "../deepSeekNative";
import { normalizeSessionId } from "./common";
import type { ProviderRuntimeConfig } from "./types";

export { isValidCustomHeaderKey } from "@liveagent/ui/lib/providers/customHeaders";

// Each provider carries only its own standard API key header, never sending both.
export function buildAnthropicAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
  };
}

export function buildOpenAIAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

export function buildGeminiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "x-goog-api-key": apiKey,
  };
}

function buildProviderAuthHeaders(providerId: ProviderId, apiKey: string): Record<string, string> {
  if (providerId === "gemini") return buildGeminiAuthHeaders(apiKey);
  if (providerId === "claude_code") return buildAnthropicAuthHeaders(apiKey);
  return buildOpenAIAuthHeaders(apiKey);
}

export function buildProviderRequestHeaders(
  providerId: ProviderId,
  apiKey: string,
  sessionId?: string,
  requestFormat?: CodexRequestFormat,
): Record<string, string> {
  const authHeaders = buildProviderAuthHeaders(providerId, apiKey);
  if (providerId === "claude_code") {
    if (isAnthropicOAuthApiKey(apiKey)) return {};
    const requestSessionId = normalizeSessionId(sessionId);
    return {
      ...authHeaders,
      ...ANTHROPIC_DEFAULT_REQUEST_HEADERS,
      // The official CLI sends X-Claude-Code-Session-Id on every request (client.ts:108).
      ...(requestSessionId ? { [CLAUDE_SESSION_ID_HEADER]: requestSessionId } : {}),
    };
  }
  if (providerId === "codex") {
    // Standard Chat Completions is a stateless protocol and needs only Authorization --
    // session identity headers belong exclusively to the Responses (Codex CLI) path
    // and must not leak into completions.
    if (requestFormat === "openai-completions") return authHeaders;
    const requestSessionId = normalizeSessionId(sessionId) ?? createUuid();
    return {
      ...authHeaders,
      // Current Codex CLI (codex-api responses.rs): session-id / thread-id /
      // x-client-request-id. The old underscore names are kept for existing relays and
      // ReactorPro legacy paths.
      [CODEX_OFFICIAL_SESSION_ID_HEADER]: requestSessionId,
      [CODEX_THREAD_ID_HEADER]: requestSessionId,
      [CLIENT_REQUEST_ID_HEADER]: requestSessionId,
      [CODEX_SESSION_ID_HEADER]: requestSessionId,
      [CODEX_CONVERSATION_ID_HEADER]: requestSessionId,
    };
  }
  // Other OpenAI-compatible endpoints: Bearer only.
  return authHeaders;
}

/**
 * The single assembly point for provider upstream requests: built-in headers -> merge
 * user custom headers -> go through the local reverse proxy. All three chains (chat /
 * text / summary) go through here, preventing any of them from omitting customHeaders
 * when assembling requests independently.
 */
export async function prepareProviderRequest(
  providerId: ProviderId,
  runtime: ProviderRuntimeConfig,
  options?: { sessionId?: string },
): Promise<PreparedProxyRequest> {
  const upstreamBaseUrl =
    providerId === "deepseek"
      ? runtime.isFullUrl
        ? normalizeDeepSeekResponsesEndpoint(runtime.baseUrl)
        : normalizeDeepSeekResponsesBaseUrl(runtime.baseUrl)
      : runtime.baseUrl;
  return prepareProxyRequest(
    providerId,
    upstreamBaseUrl.trim(),
    mergeCustomHeaders(
      buildProviderRequestHeaders(
        providerId,
        runtime.apiKey,
        options?.sessionId,
        runtime.requestFormat,
      ),
      runtime.customHeaders,
    ),
    {
      useSystemProxy: runtime.useSystemProxy === true,
      isFullUrl: runtime.isFullUrl === true,
    },
  );
}

export function toSimpleStreamReasoning(
  reasoning: ReasoningLevel | undefined,
): SimpleStreamOptions["reasoning"] | undefined {
  return reasoning && reasoning !== "off" ? reasoning : undefined;
}

export function resolveProviderCacheRetention(
  providerId: ProviderId,
  promptCachingEnabled?: boolean,
  requestOverride?: CacheRetention,
  providerPreference?: CacheRetention,
): CacheRetention | undefined {
  // Codex's wire policy is handled by promptCacheHintMode; short is kept here so a
  // provider-level none can still be overridden per model. A request-level none always
  // takes precedence, used to disable caching for auxiliary requests such as titles/compaction.
  if (providerId !== "claude_code" && providerId !== "codex") return undefined;
  if (providerId === "codex") return requestOverride ?? "short";
  if (promptCachingEnabled === false) return "none";
  // Request-level override takes precedence (auxiliary requests such as compaction/titles force none).
  if (requestOverride) return requestOverride;
  // User-selectable long: on the official Anthropic API it is mapped by the cache middleware to a 1h TTL breakpoint.
  if (providerId === "claude_code" && providerPreference === "long") return "long";
  return "short";
}

export function buildProviderRequestMetadata(
  providerId: ProviderId,
  sessionId?: string,
): Record<string, unknown> | undefined {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (providerId !== "claude_code" || !normalizedSessionId) return undefined;
  return {
    user_id: normalizedSessionId,
  };
}
