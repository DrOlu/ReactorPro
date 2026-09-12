import type { CatalogThinkingLevel } from "./catalog.generated";
import {
  type CatalogAppProviderId,
  findCatalogModel,
  findCatalogModelAcrossProviders,
} from "./modelCatalog";

// ---------------------------------------------------------------------------
// Model thinking capability (single source of truth for level availability)
// ---------------------------------------------------------------------------
// Data comes from the thinking field in catalog.generated.ts (for OpenAI models with duplicate
// names, Codex supported_reasoning_levels takes priority; the rest are supplemented by
// models.dev reasoning_options and normalized at generation time). This module only answers
// "which thinking levels does this model have, and can it be turned off" — the UI level list and
// request-time clamping both derive from here, ensuring they never drift apart. Which request
// parameters each level sends (adaptive/budget, effort field name, value rewriting) belongs to
// the streaming runtime and is not managed here. This file is the single source of truth for
// thinking-capability decisions on both ends.

export type ThinkingLevel = CatalogThinkingLevel;

/** The ascending standard ladder; catalog levels are always a subset of it (guaranteed by generation-time normalization). */
export const THINKING_LEVEL_LADDER: readonly ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ModelThinkingCapability = {
  /** false = non-thinking model (no levels, no toggle, the UI hides the whole control group). */
  reasoning: boolean;
  /** Selectable levels (excluding off); reasoning true with an empty list = thinking always on and not adjustable. */
  levels: ThinkingLevel[];
  /** true = thinking cannot be turned off. */
  alwaysOn: boolean;
  /** Catalog hit or fallback inference (for debugging/testing). */
  fromCatalog: boolean;
};

// ---------------------------------------------------------------------------
// Anthropic generation heuristics (fallback for third-party renamed ids not found in the catalog; the only implementation shared by both ends)
// ---------------------------------------------------------------------------

function isClaudeFamilyVersionAtLeast(
  normalizedModelId: string,
  family: "opus" | "sonnet",
  minimumMinor: number,
) {
  // minor is limited to 1-2 digits, avoiding misreading a date suffix (e.g.
  // claude-sonnet-4-20250514) as a minor version; it also accepts the reversed naming used by
  // third-party relays (claude-4.6-sonnet).
  const match = normalizedModelId.match(
    new RegExp(`(?:${family}[-.]4[-.](\\d{1,2})(?!\\d)|4[-.](\\d{1,2})(?!\\d)[-.]${family})`),
  );
  if (!match) return false;
  const minor = Number(match[1] ?? match[2]);
  return Number.isFinite(minor) && minor >= minimumMinor;
}

// From Claude 5 onward (sonnet-5 / fable-5 / mythos-5, etc.) the whole family uses adaptive
// thinking and supports xhigh. The reversed form (claude-5-sonnet) uses a negative lookbehind to
// exclude old-generation minor version numbers like 3-5-sonnet.
function isClaudeFamilyMajorVersionAtLeast(normalizedModelId: string, minimumMajor: number) {
  const match = normalizedModelId.match(
    /(?:(?:opus|sonnet|haiku|fable|mythos)[-.](\d{1,2})(?!\d)|(?<!\d[-.])(\d{1,2})[-.](?:opus|sonnet|haiku|fable|mythos))/,
  );
  if (!match) return false;
  const major = Number(match[1] ?? match[2]);
  return Number.isFinite(major) && major >= minimumMajor;
}

/** The adaptive generation (Opus/Sonnet 4.6+, Claude 5, Mythos Preview) is the 1M GA generation. */
export function isAnthropicAdaptiveModelId(modelId: string): boolean {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    normalizedModelId.includes("mythos-preview") ||
    isClaudeFamilyVersionAtLeast(normalizedModelId, "opus", 6) ||
    isClaudeFamilyVersionAtLeast(normalizedModelId, "sonnet", 6) ||
    isClaudeFamilyMajorVersionAtLeast(normalizedModelId, 5)
  );
}

/** xhigh: Opus 4.7+ and the Claude 5 family; Mythos Preview / Opus 4.6 / Sonnet 4.6 only go up to max. */
export function anthropicModelSupportsXHigh(modelId: string): boolean {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    isClaudeFamilyVersionAtLeast(normalizedModelId, "opus", 7) ||
    isClaudeFamilyMajorVersionAtLeast(normalizedModelId, 5)
  );
}

// ---------------------------------------------------------------------------
// Capability resolution
// ---------------------------------------------------------------------------

// A custom model not found in the catalog cannot have its reasoning capability reliably
// determined from its id, so it is treated as reasoning-capable: the standard four levels,
// switchable off (same shape as catalog budget-type models); xhigh/max require a catalog or
// Anthropic generation heuristic opt-in. Whether thinking is actually sent is decided by the
// user's toggle.
const FALLBACK_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high"];

function fallbackCapability(providerId: CatalogAppProviderId, modelId: string) {
  if (providerId === "claude_code" && isAnthropicAdaptiveModelId(modelId)) {
    // Adaptive-generation catalog shape: no minimal level; xhigh determined by family.
    const levels: ThinkingLevel[] = anthropicModelSupportsXHigh(modelId)
      ? ["low", "medium", "high", "xhigh", "max"]
      : ["low", "medium", "high", "max"];
    return { reasoning: true, levels, alwaysOn: false, fromCatalog: false };
  }
  return { reasoning: true, levels: [...FALLBACK_LEVELS], alwaysOn: false, fromCatalog: false };
}

/**
 * Resolve a model's thinking capability. Catalog lookup follows the same path as quota: the
 * provider scope takes priority, and on a miss it re-queries across providers by id
 * (relay-mounted glm/kimi/deepseek etc. hit their real levels), only falling back at the end.
 *
 * xAI exception: thinking can never be turned off (omitting reasoning_effort ≠ off; the wire
 * cannot express off), so the catalog's off declaration does not take effect for the xai
 * provider — consistent with request-side behavior; do not enable it separately.
 */
export function resolveModelThinking(
  providerId: CatalogAppProviderId,
  modelId: string | undefined,
): ModelThinkingCapability {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return { reasoning: false, levels: [], alwaysOn: false, fromCatalog: false };

  const entry =
    findCatalogModel(providerId, trimmedId) ?? findCatalogModelAcrossProviders(trimmedId);
  const capability = entry
    ? entry.thinking
      ? {
          reasoning: true,
          levels: [...entry.thinking.levels],
          alwaysOn: !entry.thinking.off,
          fromCatalog: true,
        }
      : { reasoning: false, levels: [], alwaysOn: false, fromCatalog: true }
    : fallbackCapability(providerId, trimmedId);

  if (providerId === "xai" && capability.reasoning) {
    return { ...capability, alwaysOn: true };
  }
  return capability;
}

// ---------------------------------------------------------------------------
// pi-ai ThinkingLevelMap derivation (consumed by the GUI request path; compatible with pi-ai's type structure)
// ---------------------------------------------------------------------------
// pi-ai getSupportedThinkingLevels semantics: null = unsupported; xhigh/max exist only when
// explicitly declared; minimal..high are supported by default (values passed through). This
// function guarantees getSupportedThinkingLevels(model with this map) ≡ capability.levels (+off).

export type ThinkingLevelMap = Partial<Record<"off" | ThinkingLevel, string | null>>;

const BASE_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high"];
const OPT_IN_LEVELS: readonly ThinkingLevel[] = ["xhigh", "max"];

/**
 * @param wireValues level → request-value rewrite table (e.g. xai's minimal→low, the pi-ai
 * catalog's built-in off→"none", low→"LOW"); it applies only to levels present in capability —
 * the wire table must not revive levels trimmed by the catalog, null (pi-ai's "unsupported"
 * marker) is always ignored, and availability follows capability alone.
 */
export function toThinkingLevelMap(
  capability: ModelThinkingCapability,
  wireValues?: ThinkingLevelMap,
): ThinkingLevelMap | undefined {
  if (!capability.reasoning) return undefined;
  const wireOf = (level: "off" | ThinkingLevel) => {
    const wire = wireValues?.[level];
    return typeof wire === "string" ? wire : undefined;
  };
  const map: ThinkingLevelMap = {};
  if (capability.alwaysOn) {
    map.off = null;
  } else {
    const wire = wireOf("off");
    if (wire !== undefined) map.off = wire;
  }
  for (const level of BASE_LEVELS) {
    if (!capability.levels.includes(level)) {
      map[level] = null;
    } else {
      const wire = wireOf(level);
      if (wire !== undefined && wire !== level) map[level] = wire;
    }
  }
  for (const level of OPT_IN_LEVELS) {
    if (capability.levels.includes(level)) map[level] = wireOf(level) ?? level;
  }
  return map;
}

/**
 * Clamp a level (from historical settings) to the nearest one in the list: search upward first,
 * then downward — same algorithm as pi-ai clampThinkingLevel, used by the UI to normalize saved
 * levels.
 */
export function clampThinkingLevelToList(
  level: ThinkingLevel,
  levels: readonly ThinkingLevel[],
): ThinkingLevel | undefined {
  if (levels.length === 0) return undefined;
  if (levels.includes(level)) return level;
  const requestedIndex = THINKING_LEVEL_LADDER.indexOf(level);
  if (requestedIndex === -1) return levels[0];
  for (let i = requestedIndex + 1; i < THINKING_LEVEL_LADDER.length; i += 1) {
    const candidate = THINKING_LEVEL_LADDER[i];
    if (levels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    const candidate = THINKING_LEVEL_LADDER[i];
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0];
}
