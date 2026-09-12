import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { AnthropicEffort } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { GoogleOptions } from "@earendil-works/pi-ai/api/google-generative-ai";
import { resolveMaxTokens } from "./common";
import type { StreamOptionsEx } from "./types";

type ReasoningInput = SimpleStreamOptions["reasoning"] | undefined;

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export type { AnthropicEffort };
export type AnthropicThinkingMode = "disabled" | "adaptive" | "budget";
export type AnthropicThinkingRuntime = {
  thinkingEnabled: boolean;
  mode: AnthropicThinkingMode;
  maxTokens: number;
  effort?: AnthropicEffort;
  thinkingBudgetTokens?: number;
  display?: "summarized";
};

function anthropicCompat(model: Model<Api>) {
  return (model as Model<"anthropic-messages">).compat;
}

// Same source as pi-ai streamAnthropic's internal decision: the catalog's
// compat.forceAdaptiveThinking decides adaptive vs. budget levels; custom models
// have no compat and are always handled as budget.
export function supportsAdaptiveAnthropicThinking(model: Model<Api>): boolean {
  return anthropicCompat(model)?.forceAdaptiveThinking ?? false;
}

const ANTHROPIC_THINKING_BUDGETS: Record<NonNullable<ReasoningInput>, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 16_384,
  max: 32_768,
};

export function mapReasoningToAnthropicEffort(
  reasoning: ReasoningInput,
  model: Model<Api>,
): AnthropicEffort {
  // Levels explicitly declared in the catalog's thinkingLevelMap take priority
  // (e.g. opus-4-6's xhigh→max), same semantics as pi-ai
  // mapThinkingLevelToEffort; when undeclared, the standard level passes
  // through unchanged.
  const mapped = reasoning ? model.thinkingLevelMap?.[reasoning] : undefined;
  if (typeof mapped === "string") return mapped as AnthropicEffort;

  switch (reasoning) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return "high";
  }
}

export function resolveAnthropicThinkingRuntime(
  model: Model<Api>,
  options: StreamOptionsEx,
): AnthropicThinkingRuntime {
  const maxTokens = resolveMaxTokens(options.maxTokens, model.maxTokens);
  if (!options.reasoning) {
    return { thinkingEnabled: false, mode: "disabled", maxTokens };
  }

  if (supportsAdaptiveAnthropicThinking(model)) {
    return {
      thinkingEnabled: true,
      mode: "adaptive",
      maxTokens,
      effort: mapReasoningToAnthropicEffort(options.reasoning, model),
      display: "summarized",
    };
  }

  let thinkingBudgetTokens = ANTHROPIC_THINKING_BUDGETS[options.reasoning];
  const adjustedMaxTokens = Math.min(maxTokens + thinkingBudgetTokens, model.maxTokens);
  if (adjustedMaxTokens <= thinkingBudgetTokens) {
    thinkingBudgetTokens = Math.max(0, adjustedMaxTokens - 1_024);
  }

  return {
    thinkingEnabled: true,
    mode: "budget",
    maxTokens: adjustedMaxTokens,
    thinkingBudgetTokens,
  };
}

// ---------------------------------------------------------------------------
// OpenAI (shared by the codex provider's two request formats)
// ---------------------------------------------------------------------------

// Same source as pi-ai streamSimple(OpenAI): clamp to the nearest level the
// model supports according to the catalog's thinkingLevelMap; when no override
// is declared, pi-ai's underlying stream() passes the clamped level string
// through to reasoning_effort verbatim, so no model-family id check is needed
// here.
export function clampOpenAIReasoningEffort(
  model: Model<Api>,
  reasoning: ReasoningInput,
): ReasoningInput {
  if (!reasoning) return undefined;
  const clamped = clampThinkingLevel(model, reasoning);
  return clamped === "off" ? undefined : clamped;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

export type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
type GeminiEffort = "minimal" | "low" | "medium" | "high";

// pi-ai does not put the "level field vs. budget field" dispatch into the
// catalog data, and its own streamSimple(Gemini) internally decides via these
// three id regexes too — mirrored verbatim here; it is a separate matter from
// level availability (which goes through the catalog thinkingLevelMap /
// clampThinkingLevel) and cannot be substituted for it.
function isGemini3ProModel(modelId: string) {
  return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string) {
  const id = modelId.toLowerCase();
  return (
    /gemini-3(?:\.\d+)?-flash/.test(id) ||
    id === "gemini-flash-latest" ||
    id === "gemini-flash-lite-latest"
  );
}

function isGemma4Model(modelId: string) {
  return /gemma-?4/.test(modelId.toLowerCase());
}

function usesGeminiThinkingLevelField(modelId: string) {
  return isGemini3ProModel(modelId) || isGemini3FlashModel(modelId) || isGemma4Model(modelId);
}

// Same source as pi-ai getThinkingLevel: Gemini 3 Pro has only two levels,
// LOW/HIGH; Gemma 4 has only two, MINIMAL/HIGH; everything else (including
// Gemini 3 Flash) has the full four.
function mapGeminiThinkingLevel(modelId: string, effort: GeminiEffort): GeminiThinkingLevel {
  if (isGemini3ProModel(modelId)) {
    return effort === "minimal" || effort === "low" ? "LOW" : "HIGH";
  }
  if (isGemma4Model(modelId)) {
    return effort === "minimal" || effort === "low" ? "MINIMAL" : "HIGH";
  }
  switch (effort) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    default:
      return "HIGH";
  }
}

// Same source as pi-ai getGoogleBudget; returns -1 when no known series
// matches, leaving the upstream API to use the model default.
function mapGeminiThinkingBudget(modelId: string, effort: GeminiEffort) {
  const id = modelId.toLowerCase();
  if (id.includes("2.5-pro")) {
    return { minimal: 128, low: 2_048, medium: 8_192, high: 32_768 }[effort];
  }
  if (id.includes("2.5-flash-lite")) {
    return { minimal: 512, low: 2_048, medium: 8_192, high: 24_576 }[effort];
  }
  if (id.includes("2.5-flash")) {
    return { minimal: 128, low: 2_048, medium: 8_192, high: 24_576 }[effort];
  }
  return -1;
}

export function resolveGeminiThinkingRuntime(
  model: Model<Api>,
  reasoning: ReasoningInput,
): GoogleOptions["thinking"] {
  if (!reasoning) return { enabled: false };

  // Level availability is decided by the catalog thinkingLevelMap
  // (clampThinkingLevel): gemini-3-pro-preview, for example, is clamped to only
  // low/high; no Gemini catalog entry currently declares support for xhigh/max,
  // so they are always lowered to high.
  const clamped = clampThinkingLevel(model, reasoning);
  const effort: GeminiEffort =
    clamped === "minimal" || clamped === "low" || clamped === "medium" ? clamped : "high";

  if (usesGeminiThinkingLevelField(model.id)) {
    return { enabled: true, level: mapGeminiThinkingLevel(model.id, effort) };
  }
  return { enabled: true, budgetTokens: mapGeminiThinkingBudget(model.id, effort) };
}
