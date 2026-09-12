import {
  type CatalogInputModality,
  type CatalogModelEntry,
  type CatalogProviderId,
  MODEL_CATALOG,
} from "./catalog.generated";

// ---------------------------------------------------------------------------
// Model metadata catalog (the single source of truth for limits)
// ---------------------------------------------------------------------------
// Data comes from catalog.generated.ts (at build time scripts/generate-model-catalog.mjs
// prefers Codex models.json for OpenAI with models.dev as a supplement, and takes other providers
// from models.dev; refreshed on a schedule by update-model-catalog.yml). This file and the
// generated file are both provided by the shared package.
// Request-path behavior such as thinking tiers/API selection/compat is not managed here -- that is
// the domain of the streaming runtime (pi-ai); this file only answers "what are this model's
// window/output limits and input modalities".

export { MODEL_CATALOG, MODEL_CATALOG_SNAPSHOT_DATE } from "./catalog.generated";
export type { CatalogInputModality, CatalogModelEntry, CatalogProviderId };

// Same shape as settings' ProviderId; this module does not import settings (to avoid a cycle).
export type CatalogAppProviderId = "claude_code" | "codex" | "gemini" | "xai" | "deepseek";

export type ModelLimits = { contextWindow: number; maxOutputToken: number };

/** The single mapping point from app provider type -> catalog provider. */
export const CATALOG_PROVIDER_BY_APP_PROVIDER: Record<CatalogAppProviderId, CatalogProviderId> = {
  claude_code: "anthropic",
  codex: "openai",
  gemini: "google",
  xai: "xai",
  deepseek: "deepseek",
};

/**
 * Provider fallback limits when the catalog misses (xai and codex are both OpenAI-compatible
 * ecosystems and share a fallback value). contextWindow always means the total window including
 * output (consistent with the catalog): codex/xai's 400K = a 258K input-side budget + 142K output,
 * from the same source as the build-time conversion of Codex context_window. An old value that
 * stored the 258K input budget directly would let a "window minus output reservation" compaction
 * threshold be squeezed down to 45K by the large 142K output, triggering compaction almost every
 * round.
 */
export const PROVIDER_FALLBACK_LIMITS: Record<CatalogAppProviderId, ModelLimits> = {
  claude_code: { contextWindow: 200_000, maxOutputToken: 32_000 },
  codex: { contextWindow: 400_000, maxOutputToken: 142_000 },
  gemini: { contextWindow: 1_048_576, maxOutputToken: 65_536 },
  xai: { contextWindow: 400_000, maxOutputToken: 142_000 },
  deepseek: { contextWindow: 128_000, maxOutputToken: 32_000 },
};

// The single catalog data semantics rule: community catalogs record "output == window" for every
// provider that does not publish a separate output limit (both models.dev and LiteLLM do this), and
// taking that at face value would squeeze a "window minus output reservation" input budget to zero.
// Any output that fills the whole window is treated as degraded data and clamped to the unified
// reservation cap (the same value as OpenCode's OUTPUT_TOKEN_MAX), guaranteeing the input at least
// 3/4 of the window. The generation script applies the same rule at build time, and a catalog
// invariant test locks the two places together.
export const MAX_OUTPUT_TOKEN_CAP = 32_000;

export function normalizeModelLimits(limits: ModelLimits): ModelLimits {
  if (limits.contextWindow <= 0 || limits.maxOutputToken < limits.contextWindow) return limits;
  return {
    contextWindow: limits.contextWindow,
    maxOutputToken: Math.min(
      MAX_OUTPUT_TOKEN_CAP,
      Math.max(1, Math.floor(limits.contextWindow / 4)),
    ),
  };
}

// Relays/gateways often decorate official model ids (date suffixes, @versions, case changes, and
// AnyRouter's [1m] long-context suffix), and literal matching would miss the catalog. Look up
// exactly first, then fall back through the candidate chain; the match keeps the user-configured
// original id (whether to strip [1m] is decided by request-side policy and is unrelated to the
// catalog).
export function normalizeModelIdCandidates(modelId: string): string[] {
  const candidates: string[] = [];
  const push = (value: string) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  push(modelId);
  const lower = modelId.toLowerCase();
  push(lower);
  const withoutAtVersion = lower.split("@")[0];
  push(withoutAtVersion);
  const withoutContextSuffix = withoutAtVersion.replace(/\[1m\]$/i, "");
  push(withoutContextSuffix);
  push(withoutContextSuffix.replace(/-20\d{6}$/, ""));
  // Relay aggregators often prepend their own path prefix to model ids (bailian/deepseek-v4-pro,
  // openrouter/xxx, etc.), while the catalog stores bare ids. Put this at the end of the chain --
  // only after all exact forms and partitions miss do we try stripping the prefix, avoiding a bare
  // segment accidentally hitting an unrelated same-named model in the catalog.
  const lastSegment = withoutContextSuffix.split("/").pop() ?? "";
  if (lastSegment !== withoutContextSuffix) {
    push(lastSegment);
    push(lastSegment.replace(/-20\d{6}$/, ""));
  }
  return candidates;
}

const catalogIndexByProvider = new Map<CatalogProviderId, Map<string, CatalogModelEntry>>();

function getCatalogIndex(catalogProvider: CatalogProviderId): Map<string, CatalogModelEntry> {
  let index = catalogIndexByProvider.get(catalogProvider);
  if (!index) {
    index = new Map();
    for (const entry of MODEL_CATALOG[catalogProvider]) {
      index.set(entry.id, entry);
      // The catalog contains mixed-case ids (MiniMax-M2/LongCat-2.0, etc.): add a lowercase alias
      // so the chain's lower candidate can hit; build-time dedup by lowercase ensures aliases are
      // not ambiguous across entries.
      const lower = entry.id.toLowerCase();
      if (!index.has(lower)) index.set(lower, entry);
    }
    catalogIndexByProvider.set(catalogProvider, index);
  }
  return index;
}

export function findCatalogModel(
  providerId: CatalogAppProviderId,
  modelId: string | undefined,
): CatalogModelEntry | undefined {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return undefined;
  const index = getCatalogIndex(CATALOG_PROVIDER_BY_APP_PROVIDER[providerId]);
  for (const candidate of normalizeModelIdCandidates(trimmedId)) {
    const entry = index.get(candidate);
    if (entry) return entry;
  }
  return undefined;
}

// Relay aggregators often host provider A's models under provider type B (grok/deepseek/glm/qwen
// under Anthropic/OpenAI-compatible relays); when the provider scope misses, look up across
// providers by id so the real limits are not displaced by this provider's fallback value. Domestic
// vendor partitions (deepseek/zhipuai/alibaba, etc.) have no corresponding app provider type and are
// consumed only through here. Catalog ids are globally lowercase-unique (build-time cross-partition
// dedup plus a catalog invariant test lock this down); the candidate chain is the outer loop -- a
// more precise id form takes priority over provider declaration order. Models that already have a
// formal app provider are also allowed to appear in generic relay endpoints, so they can still be
// hit through this protocol-agnostic metadata lookup path.
const CATALOG_PROVIDER_IDS = Object.keys(MODEL_CATALOG) as CatalogProviderId[];

export function findCatalogModelAcrossProviders(
  modelId: string | undefined,
): CatalogModelEntry | undefined {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return undefined;
  for (const candidate of normalizeModelIdCandidates(trimmedId)) {
    for (const catalogProvider of CATALOG_PROVIDER_IDS) {
      const entry = getCatalogIndex(catalogProvider).get(candidate);
      if (entry) return entry;
    }
  }
  return undefined;
}

// Input modality lookup for display: look up by provider scope first, then across providers if it
// misses (the same fallback strategy as limit resolution -- relay aggregators often host other
// vendors' models under this provider type). Returns catalog snapshot data; whether the user's
// inputModalities override takes priority is up to the caller (the override only expresses
// text/image gating, which differs in meaning from the catalog's full modality set).
export function resolveModelInputModalities(
  providerId: CatalogAppProviderId,
  modelId: string | undefined,
): readonly CatalogInputModality[] | undefined {
  const entry = findCatalogModel(providerId, modelId) ?? findCatalogModelAcrossProviders(modelId);
  return entry?.inputModalities;
}

export function resolveModelLimitsAcrossProviders(
  modelId: string | undefined,
): ModelLimits | undefined {
  const entry = findCatalogModelAcrossProviders(modelId);
  if (!entry) return undefined;
  return { contextWindow: entry.contextWindow, maxOutputToken: entry.maxOutputToken };
}

export function resolveModelLimits(
  providerId: CatalogAppProviderId,
  modelId: string | undefined,
): ModelLimits | undefined {
  const entry = findCatalogModel(providerId, modelId);
  if (!entry) return undefined;
  // Catalog data already passed through normalizeModelLimits at build time, so pass it through directly.
  return { contextWindow: entry.contextWindow, maxOutputToken: entry.maxOutputToken };
}

export function getProviderFallbackLimits(providerId: CatalogAppProviderId): ModelLimits {
  const fallback = PROVIDER_FALLBACK_LIMITS[providerId];
  return { contextWindow: fallback.contextWindow, maxOutputToken: fallback.maxOutputToken };
}

// Real limit fields carried by a provider's /v1/models API -- newer and more accurate than the
// local static catalog (the catalog is a build-time snapshot, while the provider API is live data
// for that deployment). Recognizes several common real-world forms: the OpenRouter-style top-level
// context_length, and the same-named field nested under top_provider. Only trust these fields when
// they parse as positive integers; unrecognized field names fall back to the catalog/fallback flow,
// the same approach as normalizeGeminiFetchedModels reading inputTokenLimit/outputTokenLimit.
export function extractProviderDeclaredLimits(
  obj: Record<string, unknown>,
): ModelLimits | undefined {
  const asPositiveInt = (value: unknown): number | undefined => {
    const numeric =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
  };
  const topProvider =
    obj.top_provider && typeof obj.top_provider === "object"
      ? (obj.top_provider as Record<string, unknown>)
      : undefined;

  const contextWindow =
    asPositiveInt(obj.context_length) ?? asPositiveInt(topProvider?.context_length);
  if (!contextWindow) return undefined;

  const maxOutputToken =
    asPositiveInt(topProvider?.max_completion_tokens) ??
    asPositiveInt(obj.max_completion_tokens) ??
    // Some relay vendors do not publish a separate output limit and only give the window -- clamp to the conservative reservation value by the same catalog rule.
    normalizeModelLimits({ contextWindow, maxOutputToken: contextWindow }).maxOutputToken;

  return normalizeModelLimits({ contextWindow, maxOutputToken });
}
