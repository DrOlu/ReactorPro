// Single source of truth on both ends for context usage: the color-band thresholds, the manual
// compaction threshold, and the anchor semantics (assistantAnchorTokens - the single definition of
// "the context size the next request will send"), plus the approach for back-scanning the
// transcript to account for trailing messages. Anchors are always computed on read from the round's
// usage + stopReason + reasoning-chain body, never persisted and never carried on events (the only
// exception is the compaction checkpoint snapshot, which cannot be derived from usage). While the
// GUI is running it reads the TokenLedger (the same anchor function); idle and the WebUI use the
// back-scan here.
//
// The CJK-aware text token estimation is also defined here (originally
// agent-gui compaction/tokenLedger.ts, moved into the shared layer so compaction checkpoint
// estimation can reuse it; tokenLedger re-exports from here to keep old callers unchanged).

/** Yellow threshold, which is also where manual compaction becomes available (issue #359: compaction is allowed only at >=50% usage). */
export const CONTEXT_USAGE_WARN_RATIO = 0.5;
/** Red threshold. */
export const CONTEXT_USAGE_DANGER_RATIO = 0.8;

export type ContextUsageLevel = "ok" | "warn" | "danger";

export function contextUsageLevel(ratio: number): ContextUsageLevel {
  if (ratio >= CONTEXT_USAGE_DANGER_RATIO) return "danger";
  if (ratio >= CONTEXT_USAGE_WARN_RATIO) return "warn";
  return "ok";
}

export function canManualCompact(ratio: number): boolean {
  return ratio >= CONTEXT_USAGE_WARN_RATIO;
}

export function contextUsageRatio(
  totalTokens: number | undefined,
  contextWindow: number | undefined,
): number {
  if (
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens) ||
    totalTokens <= 0 ||
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return 0;
  }
  return totalTokens / contextWindow;
}

const CHARS_PER_TOKEN = 4;
// CJK text has a far higher token density than Western text: mainstream tokenizers
// (o200k/cl100k/Claude) produce roughly 1 token per 1.4~1.7 CJK characters. Estimating at chars/4
// underestimates by about 2.5~3x, causing compaction to trigger far too late or even hit the
// context ceiling. 0.7 token/char is used as a conservative (rather early than late) estimate.
const CJK_TOKENS_PER_CHAR = 0.7;
// JSON / tool schema: o200k splits quotes, brackets, and short keys into many 1-token fragments,
// roughly 2.5 chars/token. Estimating 50k of tool JSON at prose's chars/4 gives only 12.5k, whereas
// the real first-turn prompt in the same workspace is 21-26k (system ~4.6k + tools). The cacheRead
// of later search turns is also steady at ~29k (the same prefix), and the difference is almost
// entirely on the tool side.
const JSON_TOKENS_PER_CHAR = 0.4;

// CJK unified ideographs (including Extension A), kana, Hangul, compatibility ideographs/forms,
// and full-width punctuation. These ranges all fall in the BMP, so a UTF-16 code unit check
// suffices; supplementary-plane characters (emoji, etc.) are counted as two Western characters on
// the chars/4 path.
function isCjkCodeUnit(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * Fractional token estimate for text (no trim, no rounding). It accumulates by character class:
 * CJK characters use CJK_TOKENS_PER_CHAR and the rest use 1/CHARS_PER_TOKEN. Additivity holds:
 * for any split, the sum of the segment estimates always equals the whole estimate, so streaming
 * deltas can be accumulated as deltas.
 */
export function estimateTextTokenUnits(text: string): number {
  let cjkChars = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isCjkCodeUnit(text.charCodeAt(index))) cjkChars += 1;
  }
  return (text.length - cjkChars) / CHARS_PER_TOKEN + cjkChars * CJK_TOKENS_PER_CHAR;
}

export function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.ceil(estimateTextTokenUnits(normalized));
}

/**
 * Fractional token estimate for JSON / schema. Non-CJK uses JSON_TOKENS_PER_CHAR, and CJK still
 * uses CJK_TOKENS_PER_CHAR. It is only for structured payloads such as tool definitions; prose
 * continues through estimateTextTokenUnits (chars/4) to avoid inflating English body text.
 */
export function estimateJsonTokenUnits(text: string): number {
  let cjkChars = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isCjkCodeUnit(text.charCodeAt(index))) cjkChars += 1;
  }
  return (text.length - cjkChars) * JSON_TOKENS_PER_CHAR + cjkChars * CJK_TOKENS_PER_CHAR;
}

export function estimateJsonTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(estimateJsonTokenUnits(text));
}

// Minimal structural projection of transcript items on both ends: GUI RenderTimelineItem
// (checkpoint kind:"summary") and WebUI TranscriptRow (checkpoint kind:"checkpoint") are passed in
// directly via structural typing. attachments are the PendingUploadedFile projection on both ends
// (GUI timeline item / WebUI user row). Round meta only needs usage + stopReason: the anchor is
// computed during the back-scan, and meta carries no derived values.
export type ContextUsageScanItem = {
  kind: string;
  text?: string;
  attachments?: readonly unknown[];
  rounds?: readonly {
    meta?: {
      usage?: ContextUsageAnchorUsage;
      stopReason?: string;
      api?: string;
      contextRelevant?: boolean;
    };
    blocks?: readonly {
      kind?: string;
      text?: string;
      item?: unknown;
      /** Estimate for the OpenAI Responses replayed reasoning item (thinkingSignature), not the UI summary. */
      replayTokenUnits?: number;
    }[];
  }[];
  content?: string;
  contextUsageTokens?: number;
};

export type ContextUsageLiveTail = {
  liveRounds: NonNullable<ContextUsageScanItem["rounds"]>;
  draftAssistantText: string;
};

export function buildContextUsageScanItems(
  historyItems: readonly ContextUsageScanItem[],
  live: ContextUsageLiveTail | null,
): readonly ContextUsageScanItem[] {
  if (!live) return historyItems;
  if (live.liveRounds.length > 0) {
    return [...historyItems, { kind: "assistant", rounds: live.liveRounds }];
  }
  if (live.draftAssistantText) {
    return [
      ...historyItems,
      {
        kind: "assistant",
        rounds: [{ blocks: [{ kind: "text", text: live.draftAssistantText }] }],
      },
    ];
  }
  return historyItems;
}

// Per-message estimation counts only body characters and adds a small constant approximating the
// overhead of the JSON envelope (role/key names/quotes). Both ends (GUI TokenLedger and WebUI
// back-scan) share this approach; tuning happens only here.
export const MESSAGE_ENVELOPE_TOKENS = 8;

// Estimation approach for small structured payloads (strings estimated directly, everything else
// estimated after JSON serialization). Used only as the fallback leaf of
// estimateContentBlockTokenUnits; binary blocks carrying base64 must never reach here (see
// BINARY_BLOCK_TOKENS).
export function stringifiedTokenUnits(value: unknown): number {
  if (typeof value === "string") return estimateTextTokenUnits(value);
  if (value == null) return 0;
  try {
    const serialized = JSON.stringify(value);
    return serialized ? estimateTextTokenUnits(serialized) : 0;
  } catch {
    return estimateTextTokenUnits(String(value));
  }
}

// Models price binary attachments such as images by dimensions/file (Anthropic ~ width x height/750,
// OpenAI by tile), with a single block usually hundreds to ~2k tokens, independent of base64 length.
// The estimation side cannot get the decoded dimensions, so it uses a constant at the upper end of
// the pricing magnitude. Estimating by serialized character count would be off by two orders of
// magnitude - the base64 of a 400KB image would falsely report ~130k tokens, the usage ring would
// swing wildly as the anchor toggles between estimate and real usage, and auto-compaction would be
// triggered early by phantom readings.
export const BINARY_BLOCK_TOKENS = 1_600;

// OpenAI Responses stores the previous turn's thinking as reasoning item JSON (containing
// encrypted_content), and the next request's convertResponsesMessages pushes it into input as-is.
// The UI only shows the short summary; estimating by the summary would compress the idle ring to
// six tenths of the real prompt (measured: ~19k after a search turn ends, while the next short
// reply's real usage is ~32k).
export function isResponsesReasoningSignature(signature: string): boolean {
  const trimmed = signature.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    return parsed?.type === "reasoning";
  } catch {
    return false;
  }
}

export type ThinkingReplayBlock = {
  type?: unknown;
  kind?: unknown;
  text?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
  replayTokenUnits?: unknown;
};

function thinkingBlockText(block: ThinkingReplayBlock): string {
  if (typeof block.thinking === "string") return block.thinking;
  if (typeof block.text === "string") return block.text;
  return "";
}

/**
 * The reasoning-chain size the next request will actually send: Responses replays the entire
 * thinkingSignature JSON; other providers replay the thinking body (Anthropic returns it with a
 * signature). An already-computed replayTokenUnits (on the transcript block) takes precedence, to
 * avoid pushing the encrypted blob back into the UI.
 *
 * encrypted_content is high-entropy base64, roughly 1 token / 2.5 chars for o200k, and chars/4
 * underestimates by about 40%, so the idle ring will still be raised a notch by real usage on the
 * next short reply.
 */
const RESPONSES_ENCRYPTED_TOKENS_PER_CHAR = 0.4;

function estimateResponsesReasoningSignatureUnits(signature: string): number {
  try {
    const parsed = JSON.parse(signature) as { encrypted_content?: unknown };
    const encrypted = typeof parsed.encrypted_content === "string" ? parsed.encrypted_content : "";
    if (!encrypted) return estimateTextTokenUnits(signature);
    const wrapperLength = Math.max(0, signature.length - encrypted.length);
    return wrapperLength / CHARS_PER_TOKEN + encrypted.length * RESPONSES_ENCRYPTED_TOKENS_PER_CHAR;
  } catch {
    return estimateTextTokenUnits(signature);
  }
}

export function estimateThinkingReplayTokenUnits(block: ThinkingReplayBlock): number {
  const replayed = positiveTokenCount(block.replayTokenUnits);
  if (replayed !== undefined) return replayed;
  const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : "";
  if (signature && isResponsesReasoningSignature(signature)) {
    return estimateResponsesReasoningSignatureUnits(signature);
  }
  const text = thinkingBlockText(block);
  return text ? estimateTextTokenUnits(text) : 0;
}

function isThinkingContentBlock(block: ThinkingReplayBlock): boolean {
  return (
    block.type === "thinking" ||
    block.kind === "thinking" ||
    typeof block.thinking === "string" ||
    typeof block.thinkingSignature === "string"
  );
}

/**
 * Whether this turn's reasoning chain enters the next request and is billed. Within a toolUse turn
 * every provider requires it to be returned; the OpenAI Responses reasoning item's signature and
 * Anthropic's long signature are likewise replayed. Short markers (such as "reasoning_content" on
 * the completions path) are not protocol state and do not count.
 */
export function contentReplaysReasoning(
  content: readonly unknown[] | undefined,
  options?: { api?: string; stopReason?: string; reasoningTokens?: number },
): boolean {
  if (options?.stopReason === "toolUse") return true;
  const api = typeof options?.api === "string" ? options.api : "";
  if (api.includes("responses") && flooredTokens(options?.reasoningTokens) > 0) {
    return true;
  }
  for (const block of content ?? []) {
    if (!block || typeof block !== "object") continue;
    const record = block as ThinkingReplayBlock;
    if (positiveTokenCount(record.replayTokenUnits) !== undefined) return true;
    const signature = typeof record.thinkingSignature === "string" ? record.thinkingSignature : "";
    if (signature && isResponsesReasoningSignature(signature)) return true;
    if (signature.trim().length >= 16) return true;
  }
  return false;
}

// Unified estimation for content blocks: text/reasoning chains are estimated directly with CJK
// awareness, a replayed Responses thinkingSignature is estimated from the signature body, binary
// blocks carrying a base64 payload (pi-ai ImageContent and similar {type, data, mimeType} shapes)
// use a constant, and other small structural blocks are estimated by serialization. Shared by the
// GUI TokenLedger and the WebUI back-scan, keeping both ends consistent.
export function estimateContentBlockTokenUnits(block: unknown): number {
  if (typeof block === "string") return estimateTextTokenUnits(block);
  if (!block || typeof block !== "object") return 0;
  const record = block as ThinkingReplayBlock & { data?: unknown };
  if (isThinkingContentBlock(record)) return estimateThinkingReplayTokenUnits(record);
  if (typeof record.text === "string") return estimateTextTokenUnits(record.text);
  if (typeof record.data === "string") return BINARY_BLOCK_TOKENS;
  return stringifiedTokenUnits(block);
}

// Unified estimation for message content (string | block array | other structures).
export function estimateContentTokenUnits(content: unknown): number {
  if (typeof content === "string") return estimateTextTokenUnits(content);
  if (Array.isArray(content)) {
    let units = 0;
    for (const block of content) units += estimateContentBlockTokenUnits(block);
    return units;
  }
  return content == null ? 0 : stringifiedTokenUnits(content);
}

function messageTokensFromUnits(units: number): number {
  return Math.ceil(Math.max(0, units)) + MESSAGE_ENVELOPE_TOKENS;
}

// Both stores replace tool result objects via immutable updates, so estimates can be cached by
// object identity; the back-scan runs every frame during streaming, and without this cache large
// tool results would be re-estimated every frame.
const toolResultTokenCache = new WeakMap<object, number>();

function estimateToolResultTokens(result: { content?: unknown }): number {
  const cached = toolResultTokenCache.get(result);
  if (cached !== undefined) return cached;
  // Count only model-visible content: details is a UI/accounting payload that provider conversion
  // never sends (full shell stdout/stderr and file-read metadata hang off it), so counting it would
  // double-count shell output and treat pure metadata as context, systematically inflating the reading.
  const tokens = messageTokensFromUnits(estimateContentTokenUnits(result.content));
  toolResultTokenCache.set(result, tokens);
  return tokens;
}

// Shared kind on both ends for provider-hosted search blocks (both the GUI timeline and WebUI rows
// fold into this kind via the shared upsertHostedSearchToRound). For turns containing this block:
// 1) usage.input / totalTokens is the aggregate of the server's multiple internal calls (the full
//    search results are counted into input but do not enter later requests), so it cannot serve as
//    a whole-turn anchor - measured: a search turn reports 118k while the real persistent context
//    is 52k, and anchoring to it makes the next ordinary turn fall back without compaction (44%->16%);
// 2) under a warm cache, cacheRead+output is still trustworthy, see hostedSearchFollowUpTokens;
// 3) the block itself is stripped by the sanitizer on the request side, so estimation must skip it too.
export const HOSTED_SEARCH_BLOCK_KIND = "hostedSearch";

function roundHasHostedSearch(
  round: NonNullable<ContextUsageScanItem["rounds"]>[number] | undefined,
): boolean {
  if (!round?.blocks) return false;
  for (const block of round.blocks) {
    if (block.kind === HOSTED_SEARCH_BLOCK_KIND) return true;
  }
  return false;
}

// Reasoning-chain body estimate needed for anchor deduction (effective only when the turn's usage
// did not report reasoning and it is confirmed not to be replayed). Responses replay volume uses
// replayTokenUnits, not the summary body.
function roundThinkingTokenUnits(
  round: NonNullable<ContextUsageScanItem["rounds"]>[number],
): number {
  let units = 0;
  for (const block of round.blocks ?? []) {
    if (block.kind !== "thinking") continue;
    units += estimateThinkingReplayTokenUnits(block);
  }
  return units;
}

function roundReplaysReasoning(
  round: NonNullable<ContextUsageScanItem["rounds"]>[number],
): boolean {
  return contentReplaysReasoning(round.blocks, {
    api: round.meta?.api,
    stopReason: round.meta?.stopReason,
    reasoningTokens: round.meta?.usage?.reasoning,
  });
}

function estimateRoundTokens(
  round: NonNullable<ContextUsageScanItem["rounds"]>[number],
  onlyToolResults: boolean,
): number {
  let assistantUnits = 0;
  let toolResultTokens = 0;
  for (const block of round.blocks ?? []) {
    if (block.kind === HOSTED_SEARCH_BLOCK_KIND) continue;
    if (block.kind === "tool") {
      const item =
        block.item && typeof block.item === "object"
          ? (block.item as {
              toolCall?: { name?: string; arguments?: unknown };
              toolResult?: { content?: unknown };
            })
          : undefined;
      const toolCall = item?.toolCall;
      if (!onlyToolResults && toolCall) {
        assistantUnits +=
          stringifiedTokenUnits(toolCall.name) + stringifiedTokenUnits(toolCall.arguments);
      }
      const toolResult = item?.toolResult;
      if (toolResult) toolResultTokens += estimateToolResultTokens(toolResult);
      continue;
    }
    if (!onlyToolResults) {
      assistantUnits += estimateContentBlockTokenUnits(block);
    }
  }
  if (onlyToolResults) return toolResultTokens;
  return (assistantUnits > 0 ? messageTokensFromUnits(assistantUnits) : 0) + toolResultTokens;
}

// The single validation approach on both ends for an "effective token count" (floored and must be a finite positive number).
export function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

// Structural projection of provider usage (compatible with the pi-ai Usage structure; relays may omit fields or report zero).
export type ContextUsageAnchorUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** A subset of output; set only for providers that report a reasoning breakdown (may be 0), left empty otherwise. */
  reasoning?: number;
  totalTokens?: number;
};

function flooredTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The hosted search turn's input / totalTokens includes the full server-side search text and must
 * never be used as a whole-turn anchor (it would pin the ring at 80k-120k, dropping back to ~32k on
 * the next ordinary turn).
 *
 * cacheRead and output are still trustworthy: under a warm cache, cacheRead is exactly the cached
 * system+tools+history prefix (measured steady at ~29k-30k), and output is the reasoning + body
 * actually generated this turn (which enters the next request as-is). Next request size ~
 * cacheRead + output, no longer estimating encrypted_content at 0.4/char - that would inflate by
 * 5-6k over the real output, showing 36k idle and dropping to 32k after a short reply.
 *
 * A cold-cache sliver (3k-5k) cannot be treated as the full prefix, so fall back to estimation.
 */
export const HOSTED_SEARCH_PREFIX_CACHE_MIN = 16_000;

export function hostedSearchFollowUpTokens(
  usage: ContextUsageAnchorUsage | undefined,
  minPrefixTokens = 0,
): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const output = flooredTokens(usage.output);
  const cacheRead = flooredTokens(usage.cacheRead);
  if (output <= 0 || cacheRead <= 0) return undefined;
  // When there is a trustworthy system+tools estimate, cacheRead must be close to that prefix;
  // otherwise a 16k partial cache would be treated as the whole, making the idle ring too low again
  // (19k->30k). Without an estimate, only cold-start slivers are rejected (measured 3k-5k). A small
  // minPrefix must not loosen the sliver check.
  if (minPrefixTokens >= HOSTED_SEARCH_PREFIX_CACHE_MIN) {
    if (cacheRead < Math.floor(minPrefixTokens * 0.6)) return undefined;
  } else if (cacheRead < HOSTED_SEARCH_PREFIX_CACHE_MIN) {
    return undefined;
  }
  return cacheRead + output;
}

/** After the sanitizer strips hostedSearch it zeroes input/totalTokens, leaving only cacheRead+output. */
export function isStrippedHostedSearchUsage(usage: ContextUsageAnchorUsage | undefined): boolean {
  if (!usage || typeof usage !== "object") return false;
  return (
    flooredTokens(usage.input) === 0 &&
    flooredTokens(usage.totalTokens) === 0 &&
    flooredTokens(usage.cacheRead) > 0
  );
}

/**
 * The single semantic definition of a round anchor: "the context size the next request will send",
 * doing only usage arithmetic and never mixing in body estimates:
 *
 *   promptSide = input + cacheRead + cacheWrite   -- the amount actually sent by this request (authoritative)
 *   visibleOut = replayReasoning || stopReason === "toolUse"
 *                ? output      -- the reasoning chain is replayed and billed with the next request
 *                                (tool turns, OpenAI Responses encrypted reasoning, Anthropic
 *                                signed thinking)
 *                : output - (reasoning ?? ceil(thinkingTokenUnits))
 *                              -- deducted only when it is confirmed to be stripped (Chat Completions etc.)
 *   anchor     = promptSide + visibleOut
 *
 * The old approach assumed "after stop every provider strips reasoning". That is wrong for OpenAI
 * Responses: convertResponsesMessages pushes the entire thinkingSignature into the next turn's
 * input, so deducting it makes the idle ring too low and the next short reply's real usage raises
 * it back (19k->30k).
 *
 * When reasoning is missing (providers that do not report a reasoning breakdown) and it is
 * confirmed not to be replayed, deduct by the reasoning-body estimated units. When the entire
 * prompt side is missing (some relays only report totalTokens), fall back to totalTokens for the
 * same deduction. Body estimates must never be mixed into the anchor.
 */
export function assistantAnchorTokens(params: {
  usage: ContextUsageAnchorUsage | undefined;
  stopReason?: string;
  /** Fractional token estimate of this turn's reasoning-chain body (estimateTextTokenUnits approach). */
  thinkingTokenUnits?: number;
  /** The next request will replay this turn's reasoning / thinking. */
  replayReasoning?: boolean;
}): number | undefined {
  const usage = params.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const reasoning = usage.reasoning;
  const replayReasoning = params.replayReasoning === true || params.stopReason === "toolUse";
  const droppedReasoningTokens = replayReasoning
    ? 0
    : typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0
      ? Math.floor(reasoning)
      : Math.ceil(Math.max(0, params.thinkingTokenUnits ?? 0));
  const promptSideTokens =
    flooredTokens(usage.input) + flooredTokens(usage.cacheRead) + flooredTokens(usage.cacheWrite);
  if (promptSideTokens > 0) {
    return promptSideTokens + Math.max(0, flooredTokens(usage.output) - droppedReasoningTokens);
  }
  const totalTokens = flooredTokens(usage.totalTokens);
  if (totalTokens > 0) return Math.max(1, totalTokens - droppedReasoningTokens);
  return undefined;
}

export type DeriveContextUsageOptions = {
  // A fixed overhead added to the reading when the back-scan finds no authoritative anchor
  // (usage/checkpoint snapshot) - the estimate of system + tools, provided by the GUI's
  // TokenLedger. The running ledger's anchorless approach includes fixed, while the back-scan has
  // historically only accumulated visible message bodies - on conversations where "the provider
  // does not return usage" the two approaches make the idle reading systematically low and cause it
  // to jump back and forth against the running reading. When there is an anchor, usage/snapshot
  // already includes fixed, so it is never added on top.
  unanchoredFixedTokens?: number;
};

/**
 * Back-scan the transcript to derive current context usage: the most recent assistant round's real
 * API usage is computed on the fly by assistantAnchorTokens as the anchor (already including the
 * system/tools/history before that round and this round's visible output), then user messages after
 * the anchor (body + attachment metadata), later assistant content, and tool results are
 * accumulated. Compaction checkpoints prefer the authoritative contextUsageTokens synced by the
 * desktop; only when old history lacks that field does it fall back to summary-body estimation (in
 * which case unanchoredFixedTokens is likewise added to align the approaches).
 */
export function deriveContextUsageTokens(
  items: readonly ContextUsageScanItem[],
  options?: DeriveContextUsageOptions,
): number | undefined {
  const unanchoredFixedTokens = positiveTokenCount(options?.unanchoredFixedTokens) ?? 0;
  let trailingTokens = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "summary" || item.kind === "checkpoint") {
      const authoritativeTokens = positiveTokenCount(item.contextUsageTokens);
      if (authoritativeTokens !== undefined) return authoritativeTokens + trailingTokens;
      const estimatedTokens =
        typeof item.content === "string" ? estimateTextTokens(item.content) : undefined;
      return estimatedTokens === undefined
        ? undefined
        : estimatedTokens + trailingTokens + unanchoredFixedTokens;
    }
    if (item.kind === "user") {
      let units = typeof item.text === "string" ? estimateTextTokenUnits(item.text.trim()) : 0;
      // Attachments are estimated by serialized metadata (path/file name/size etc., i.e. the
      // magnitude of the instruction lines injected at runtime; under the native base64 attachment
      // path this is a lower bound). Excluding them would make the idle reading consistently low on
      // both ends for "a large batch of attachments sent after the checkpoint", and attachment-only
      // messages were previously counted as entirely zero.
      for (const attachment of item.attachments ?? []) {
        units += stringifiedTokenUnits(attachment);
      }
      if (units > 0) {
        trailingTokens += messageTokensFromUnits(units);
      }
      continue;
    }
    if (item.kind !== "assistant" || !item.rounds) continue;
    for (let roundIndex = item.rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
      const round = item.rounds[roundIndex];
      if (!round) continue;
      if (round.meta?.contextRelevant === false) continue;
      const usage = round.meta?.usage;
      if (roundHasHostedSearch(round)) {
        // input/totalTokens is the aggregate of the full search text, so skip it; under a warm cache
        // cacheRead+output is already the next request size and is used as the anchor, avoiding the
        // encrypted estimate raising the idle ring and then dropping back.
        const followUpTokens = hostedSearchFollowUpTokens(usage, unanchoredFixedTokens);
        if (followUpTokens !== undefined) {
          return followUpTokens + trailingTokens;
        }
        trailingTokens += estimateRoundTokens(round, false);
        continue;
      }
      if (usage) {
        const anchorTokens = assistantAnchorTokens({
          usage,
          stopReason: round.meta?.stopReason,
          thinkingTokenUnits: roundThinkingTokenUnits(round),
          replayReasoning: roundReplaysReasoning(round),
        });
        if (anchorTokens !== undefined) {
          return anchorTokens + trailingTokens + estimateRoundTokens(round, true);
        }
      }
      trailingTokens += estimateRoundTokens(round, false);
    }
  }
  const unanchoredTotal = trailingTokens + unanchoredFixedTokens;
  return unanchoredTotal > 0 ? unanchoredTotal : undefined;
}

/** Whether the back-scan can land on usage / an authoritative checkpoint. Without an anchor, the idle GUI should trust the ledger instead (full messages include thinkingSignature). */
export function hasContextUsageUsageAnchor(
  items: readonly ContextUsageScanItem[],
  options?: DeriveContextUsageOptions,
): boolean {
  const minPrefixTokens = positiveTokenCount(options?.unanchoredFixedTokens) ?? 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "summary" || item.kind === "checkpoint") {
      return positiveTokenCount(item.contextUsageTokens) !== undefined;
    }
    if (item.kind !== "assistant" || !item.rounds) continue;
    for (let roundIndex = item.rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
      const round = item.rounds[roundIndex];
      if (!round || round.meta?.contextRelevant === false) continue;
      if (roundHasHostedSearch(round)) {
        if (hostedSearchFollowUpTokens(round.meta?.usage, minPrefixTokens) !== undefined) {
          return true;
        }
        continue;
      }
      const anchorTokens = assistantAnchorTokens({
        usage: round.meta?.usage,
        stopReason: round.meta?.stopReason,
        thinkingTokenUnits: roundThinkingTokenUnits(round),
        replayReasoning: roundReplaysReasoning(round),
      });
      if (anchorTokens !== undefined) return true;
    }
  }
  return false;
}
