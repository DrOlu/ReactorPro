import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";

import {
  assistantAnchorTokens,
  contentReplaysReasoning,
  estimateContentBlockTokenUnits,
  estimateContentTokenUnits,
  estimateJsonTokens,
  estimateTextTokens,
  estimateTextTokenUnits,
  estimateThinkingReplayTokenUnits,
  hostedSearchFollowUpTokens,
  isStrippedHostedSearchUsage,
  MESSAGE_ENVELOPE_TOKENS,
  stringifiedTokenUnits,
} from "@liveagent/ui/lib/chat/contextUsage";
import { isCompactionAssistantMessage } from "../conversation/conversationState";

// CJK-aware text estimation, message-envelope constants, and non-text value
// serialization estimates all come from the shared layer (the usage ring's
// checkpoint estimates and the WebUI back-scan reuse the same convention, so
// tuning only touches the shared layer); text estimation is re-exported here to
// keep existing callers and tests unchanged.
export { estimateTextTokens, estimateTextTokenUnits };

// Messages are immutable value objects in this codebase (state changes only
// create new arrays), so estimates can be cached by object identity across
// state/segment/temporary state and the hot path avoids re-serializing.
const messageTokenCache = new WeakMap<object, number>();
const toolsTokenCache = new WeakMap<object, number>();

// Content blocks uniformly use the shared-layer convention (CJK-aware text,
// binary blocks by pricing constant, small structures via serialization
// fallback). A toolResult's details are a UI/accounting payload; the provider
// conversion sends only content, so details are never counted — full shell
// output and file-read metadata hang off details, and counting them would
// double-count.
function estimateMessageTokenUnits(message: Message): number {
  if (message.role === "assistant") {
    let units = 0;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "toolCall") {
        units += estimateTextTokenUnits(block.name) + stringifiedTokenUnits(block.arguments);
        continue;
      }
      // hostedSearch blocks (the UI payload for provider-hosted search) are
      // stripped by the sanitizer on the request side and never sent to the
      // model; estimating by serialization would falsely count the queries/
      // sources JSON as context.
      if ((block as { type?: string }).type === "hostedSearch") continue;
      units += estimateContentBlockTokenUnits(block);
    }
    return units;
  }

  if (message.role === "toolResult") {
    return estimateContentTokenUnits(message.content);
  }

  return estimateContentTokenUnits((message as { content?: unknown }).content);
}

export function estimateMessageTokens(message: Message): number {
  const cached = messageTokenCache.get(message);
  if (cached !== undefined) return cached;
  const tokens = Math.ceil(estimateMessageTokenUnits(message)) + MESSAGE_ENVELOPE_TOKENS;
  messageTokenCache.set(message, tokens);
  return tokens;
}

export function estimateToolsTokens(tools: Context["tools"]): number {
  if (!tools || tools.length === 0) return 0;
  const cached = toolsTokenCache.get(tools);
  if (cached !== undefined) return cached;
  // Tool definitions are JSON schema, not prose: use estimateJsonTokens
  // (~2.5 chars/token), not chars/4, or fixedTokens would be 4-8k short of the
  // real first-turn prompt.
  const tokens = estimateJsonTokens(JSON.stringify(tools));
  toolsTokenCache.set(tools, tokens);
  return tokens;
}

export type TokenLedgerRebaseOptions = {
  /**
   * Lower-bound calibration for fixed (not a replacement): a ledger snapshot
   * from the previous real-request convention that may contain segments the
   * current context lacks (background conversations do not receive the
   * skills/memory prompts). After compaction the systemPrompt already contains
   * the new summary, so replacing the whole segment would drop the summary from
   * the estimate — after the first compaction the checkpoint would be too low
   * and the next send ring would spike; when the old snapshot is too large the
   * checkpoint would be too high and move backward on send.
   */
  fixedTokens?: number;
  /**
   * Estimate of the appended segment that is only concatenated into the
   * systemPrompt at the provider boundary (the agent-mode tool-execution rules
   * in toolsSuffix measure ~4k tokens). The context passed to the ledger always
   * precedes that concatenation, so not accounting for it would systematically
   * undercount the anchor-less window after compaction (from the checkpoint
   * value until the first reply arrives), and the ring would jump as soon as the
   * first real usage lands.
   */
  fixedOverheadTokens?: number;
};

export function deriveContextTokens(context: Context, options?: TokenLedgerRebaseOptions): number {
  const ledger = new TokenLedger();
  ledger.rebase(context, options);
  return ledger.total();
}

// For provider-hosted search (hostedSearch) turns, usage.input / totalTokens is
// an aggregate of several server-side internal calls: the full search result
// text is billed as input but does not enter subsequent requests. In practice a
// search turn reports input 110k while the next turn's persistent context is
// only 52k — these two figures must never be treated as a whole-segment anchor.
// On a hot cache, cacheRead+output still tracks the next request size
// (hostedSearchFollowUpTokens).
export function messageHasHostedSearchBlocks(message: AssistantMessage): boolean {
  for (const block of message.content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "hostedSearch"
    ) {
      return true;
    }
  }
  return false;
}

// Chain-of-thought estimate needed for anchor deduction (only applies when
// replay is confirmed absent and usage did not report reasoning).
function messageThinkingTokenUnits(message: AssistantMessage): number {
  let units = 0;
  for (const block of message.content) {
    if (!block || typeof block !== "object" || block.type !== "thinking") continue;
    units += estimateThinkingReplayTokenUnits(block);
  }
  return units;
}

// Anchor semantics are defined only in the shared layer: a normal turn uses
// assistantAnchorTokens (pure usage arithmetic, never mixed with body-text
// estimates); hosted-search / sanitizer-stripped copies use only
// hostedSearchFollowUpTokens (cacheRead+output). A compaction checkpoint
// carries the summarizer request size and is always excluded.
export function getMessageObservedTokens(
  message: Message,
  options?: { minPrefixTokens?: number },
): number | undefined {
  if (message.role !== "assistant") return undefined;
  // (Booleanized to keep the type predicate from narrowing AssistantMessage to never in the else branch.)
  const isCheckpoint: boolean = isCompactionAssistantMessage(message);
  if (isCheckpoint) return undefined;
  const minPrefixTokens =
    typeof options?.minPrefixTokens === "number" &&
    Number.isFinite(options.minPrefixTokens) &&
    options.minPrefixTokens > 0
      ? Math.floor(options.minPrefixTokens)
      : 0;
  if (messageHasHostedSearchBlocks(message) || isStrippedHostedSearchUsage(message.usage)) {
    return hostedSearchFollowUpTokens(message.usage, minPrefixTokens);
  }
  return assistantAnchorTokens({
    usage: message.usage,
    stopReason: message.stopReason,
    thinkingTokenUnits: messageThinkingTokenUnits(message),
    replayReasoning: contentReplaysReasoning(message.content, {
      api: message.api,
      stopReason: message.stopReason,
      reasoningTokens: message.usage?.reasoning,
    }),
  });
}

export type TokenLedgerSnapshot = {
  fixedTokens: number;
  observedTokens: number;
  trailingTokens: number;
  // Maintained only when there is no usage anchor (total() reads it only in that
  // case too); with an anchor it is always fixedTokens.
  estimatedTotalTokens: number;
  hasObservedUsage: boolean;
  totalTokens: number;
};

/**
 * Per-conversation context-size ledger: observed (the most recent real usage
 * anchor, which already includes system/tools/all history) + trailing (the
 * estimated increment of the messages after it). With a usage anchor the reading
 * is always observed + trailing — the estimation convention is intentionally
 * conservative (overestimates) and must never override the real reading; only
 * when there is no usage anchor at all does it fall back to fixed (system+tools
 * estimate) + per-message estimates. All readings are O(1); a rebuild runs only
 * once at the start of each request.
 */
export class TokenLedger {
  private fixedTokens = 0;
  private observedTokens = 0;
  private trailingTokens = 0;
  private estimatedTotalTokens = 0;
  private hasObservedUsage = false;

  rebase(context: Context, options?: TokenLedgerRebaseOptions): void {
    const fixedOverheadTokens =
      typeof options?.fixedOverheadTokens === "number" &&
      Number.isFinite(options.fixedOverheadTokens) &&
      options.fixedOverheadTokens > 0
        ? Math.floor(options.fixedOverheadTokens)
        : 0;
    const estimatedFixedTokens =
      estimateTextTokens(context.systemPrompt ?? "") +
      estimateToolsTokens(context.tools) +
      fixedOverheadTokens;
    const calibrationFixedTokens =
      typeof options?.fixedTokens === "number" &&
      Number.isFinite(options.fixedTokens) &&
      options.fixedTokens >= 0
        ? Math.floor(options.fixedTokens)
        : undefined;
    // The calibration value is only a lower bound (see
    // TokenLedgerRebaseOptions.fixedTokens): taking max guarantees that segments
    // genuinely present in this context (the new summary) are never replaced by
    // the old snapshot.
    this.fixedTokens =
      calibrationFixedTokens === undefined
        ? estimatedFixedTokens
        : Math.max(estimatedFixedTokens, calibrationFixedTokens);
    this.observedTokens = 0;
    this.trailingTokens = 0;
    this.estimatedTotalTokens = this.fixedTokens;
    this.hasObservedUsage = false;

    const messages = context.messages;
    let anchorIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const observed = getMessageObservedTokens(messages[index], {
        minPrefixTokens: this.fixedTokens,
      });
      if (typeof observed === "number") {
        this.observedTokens = observed;
        this.hasObservedUsage = true;
        anchorIndex = index;
        break;
      }
    }
    // estimatedTotalTokens is maintained only when there is no anchor: with an
    // anchor total() does not read it, and skipping the full estimation loop
    // makes rebuild cost grow with the number of messages after the anchor
    // rather than the whole history.
    if (anchorIndex < 0) {
      for (const message of messages) {
        this.estimatedTotalTokens += estimateMessageTokens(message);
      }
    }
    for (let index = anchorIndex + 1; index < messages.length; index += 1) {
      this.trailingTokens += estimateMessageTokens(messages[index]);
    }
  }

  /**
   * suppressUsageAnchors: the caller knows for certain that these messages'
   * input/totalTokens is untrustworthy (hosted-search aggregate values, and the
   * message object may not yet carry hostedSearch blocks — search finalization
   * is an asynchronous replacement, so content detection at commit time is
   * unreliable). Whole-segment anchors are still forbidden; on a hot cache
   * cacheRead+output can still be used as the next request size.
   */
  addMessages(messages: readonly Message[], options?: { suppressUsageAnchors?: boolean }): void {
    for (const message of messages) {
      if (!this.hasObservedUsage) {
        this.estimatedTotalTokens += estimateMessageTokens(message);
      }
      const observed = options?.suppressUsageAnchors
        ? hostedSearchFollowUpTokens(
            message.role === "assistant" ? message.usage : undefined,
            this.fixedTokens,
          )
        : getMessageObservedTokens(message, { minPrefixTokens: this.fixedTokens });
      if (typeof observed === "number") {
        // The new usage already covers all context before it; reset trailing and accumulate again.
        this.observedTokens = observed;
        this.hasObservedUsage = true;
        this.trailingTokens = 0;
        continue;
      }
      this.trailingTokens += estimateMessageTokens(message);
    }
  }

  total(): number {
    // With a usage anchor, always trust observed + trailing: the estimation
    // convention is conservative (CJK 0.7 tok/char, binary blocks by pricing
    // constants), and taking max with the real reading would let estimates
    // hijack the ring reading and auto-compaction. Estimates are only a fallback
    // when there is no usage anchor at all.
    if (!this.hasObservedUsage) return this.estimatedTotalTokens;
    return this.observedTokens + this.trailingTokens;
  }

  /**
   * pendingTokenUnits is the fractional-token estimate of the streaming
   * increment (the caller accumulates deltas with estimateTextTokenUnits), so
   * each decision does not rescan the full text.
   */
  totalWithPendingTokens(pendingTokenUnits: number): number {
    if (!Number.isFinite(pendingTokenUnits) || pendingTokenUnits <= 0) return this.total();
    return this.total() + Math.ceil(pendingTokenUnits);
  }

  snapshot(): TokenLedgerSnapshot {
    return {
      fixedTokens: this.fixedTokens,
      observedTokens: this.observedTokens,
      trailingTokens: this.trailingTokens,
      estimatedTotalTokens: this.estimatedTotalTokens,
      hasObservedUsage: this.hasObservedUsage,
      totalTokens: this.total(),
    };
  }
}
