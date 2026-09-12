import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  hasAnthropicLongContextSuffix,
  shouldSendAnthropicLongContextHeader,
} from "@liveagent/ui/lib/models/anthropicContext";
import { normalizeModelIdCandidates } from "@liveagent/ui/lib/models/modelCatalog";
import { anthropicModelSupportsXHigh } from "@liveagent/ui/lib/models/modelThinking";

export {
  ANTHROPIC_LONG_CONTEXT_WINDOW,
  ANTHROPIC_STANDARD_CONTEXT_WINDOW,
  hasAnthropicLongContextSuffix,
  resolveAnthropicContextWindow,
  resolveAnthropicKnownModelLimits,
  shouldSendAnthropicLongContextHeader,
} from "@liveagent/ui/lib/models/anthropicContext";
// ---------------------------------------------------------------------------
// Anthropic 1M long-context window policy (request behavior, single source of truth)
// ---------------------------------------------------------------------------
// As of 2026-03-13, 1M context is GA for the adaptive generation
// (Opus/Sonnet 4.6+, Claude 5) and needs no beta header; as of 2026-04-30 the
// `context-1m-2025-08-07` beta for the older generation (Sonnet 4/4.5) is
// retired -- the header is still accepted but has no effect, and requests over
// 200K will always 400. The catalog (models.dev snapshot) still lists
// claude-sonnet-4-5 as 1M, so here we clamp to the real effective window online
// using "is it the adaptive generation" (an id heuristic equivalent to the
// catalog's generation set), shared by settings defaults and the request-side
// beta-header decision so budget and signal never drift. The limit/price data
// itself comes from lib/models/modelCatalog; this file's pi-ai catalog lookup
// (findBuiltinAnthropicModel) only serves request-path metadata such as
// compat.
export { normalizeModelIdCandidates as normalizeAnthropicModelIdCandidates } from "@liveagent/ui/lib/models/modelCatalog";
export { isAnthropicAdaptiveModelId } from "@liveagent/ui/lib/models/modelThinking";

// Relays/gateways often decorate official Anthropic model ids; a literal match
// would miss the pi-ai catalog, and a miss makes the model lose request-path
// metadata such as compat.forceAdaptiveThinking, breaking the thinking tier.
// The candidate chain shares the same implementation as the catalog lookup in
// lib/models/modelCatalog.
export function findBuiltinAnthropicModel(
  modelId: string,
): Model<"anthropic-messages"> | undefined {
  const models = getBuiltinModels("anthropic");
  for (const candidate of normalizeModelIdCandidates(modelId)) {
    const known = models.find((model) => model.id === candidate);
    if (known?.api) return known as Model<"anthropic-messages">;
  }
  return undefined;
}

export function getAnthropicCompat(
  model: Model<"anthropic-messages">,
): Model<"anthropic-messages">["compat"] | undefined {
  return model.compat;
}

// The single implementation of the generation heuristic lives in the mirror
// module lib/models/modelThinking (same source on the web side); it is
// re-exported here for existing consumers on the limits/1M path.
export { anthropicModelSupportsXHigh };

export function resolveAnthropicWireModelId(modelId: string, baseUrl: string | undefined): string {
  if (hasAnthropicLongContextSuffix(modelId) && !shouldSendAnthropicLongContextHeader(baseUrl)) {
    return modelId.replace(/\[1m\]$/i, "");
  }
  return modelId;
}

// The adaptive generation is the 1M GA generation; the 1M listed in the older
// generation's catalog is a historical value from before retirement, so report
// an effective window of 200K.
