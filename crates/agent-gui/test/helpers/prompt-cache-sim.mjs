/**
 * Offline deterministic prompt cache simulator.
 *
 * Purpose: without network access or an API key, turn "how much of this round's
 * cache was hit" into an assertable number. It does not guess the provider's
 * internal implementation; it only replicates two public, verifiable rules:
 *
 *   1. The cache matches on a **byte-level prefix**. Outside the common prefix
 *      between the previous request and this one, everything misses.
 *   2. The hit amount is then **rounded down** on top of the prefix, with the
 *      rounding rule depending on the provider:
 *      - Anthropic: take the last cache_control breakpoint that still falls
 *        within the common prefix. If no breakpoint falls inside the prefix,
 *        the hit is 0 -- the so-called "all or nothing".
 *      - DeepSeek / OpenAI implicit cache: round down to a 128-token block
 *        boundary.
 *
 * What is deliberately **not** modeled (modeling it would distort the
 * conclusions):
 *   - A real tokenizer. This uses chars/4 to estimate tokens. Absolute values
 *     are therefore imprecise, but every conclusion in this module is a
 *     **ratio** (hit/total) or an A/B comparison under the same ruler, so the
 *     estimation error cancels out on both sides.
 *   - Cache expiry. TTL expiration is a time quantity and would make tests
 *     nondeterministic. To test TTL effects, explicitly construct two different
 *     cacheControl parameters rather than waiting for it to expire.
 *   - Cache node misses caused by server-side load balancing. That is luck, not
 *     a regressable behavior.
 */

/** Token estimation: a pure character-count conversion, deterministic and
 * dependency-free. Absolute values are imprecise; ratios are usable. */
export function estimateTokens(charCount) {
  return Math.floor(charCount / 4);
}

/** Length of the common prefix of two strings. This is the underlying rule
 * for cache matching. */
export function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

/**
 * Flatten the Anthropic request body into a single string in **wire byte
 * order**, recording at which offset each `cache_control` breakpoint falls.
 *
 * The order must be system -> tools -> messages -- this is the actual
 * serialization order of the Anthropic request body, and the cause of the
 * phenomenon that "changing one byte in system invalidates all the history
 * after it". If the flattening order is wrong, every attribution the simulator
 * gives is wrong.
 */
export function flattenAnthropicPayload(payload) {
  let text = "";
  /** @type {number[]} breakpoint offsets, ascending */
  const breakpoints = [];

  // A top-level cache_control means "automatically mark the last cacheable
  // block", equivalent to placing one breakpoint at the end of the entire
  // request body -- that is, only one level, with no ladder.
  const hasTopLevel = Boolean(payload.cache_control);

  const pushBlock = (serialized, hasBreakpoint) => {
    text += serialized;
    if (hasBreakpoint) breakpoints.push(text.length);
  };

  const systemBlocks = Array.isArray(payload.system)
    ? payload.system
    : typeof payload.system === "string"
      ? [{ type: "text", text: payload.system }]
      : [];
  for (const block of systemBlocks) {
    pushBlock(`system:${block.text ?? ""}\n`, Boolean(block.cache_control));
  }

  for (const tool of payload.tools ?? []) {
    const schema = JSON.stringify(tool.input_schema ?? tool.parameters ?? {});
    pushBlock(
      `tool:${tool.name}:${tool.description ?? ""}:${schema}\n`,
      Boolean(tool.cache_control),
    );
  }

  for (const message of payload.messages ?? []) {
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: message.content ?? "" }];
    for (const block of blocks) {
      const body =
        block.type === "text"
          ? block.text
          : block.type === "thinking"
            ? block.thinking
            : block.type === "redacted_thinking"
              ? block.data
              : JSON.stringify(block);
      pushBlock(`${message.role}:${block.type}:${body ?? ""}\n`, Boolean(block.cache_control));
    }
  }

  if (hasTopLevel) breakpoints.push(text.length);

  return { text, breakpoints };
}

/**
 * Anthropic hit model: hit amount = the last breakpoint of the **previous
 * request** that still falls within the common prefix.
 *
 * The direction is easy to get backwards, so let us be explicit: the
 * `cache_control` in the request body marks content "up to here" as being
 * **written to** the cache. So how much this round can **read** depends on
 * where the previous round wrote, not on where this round intends to write.
 * Computing the hit from this round's breakpoints would yield the obviously
 * absurd conclusion that "a pure-append conversation has a 0% hit rate" --
 * because this round's trailing breakpoint is always outside the common prefix.
 *
 * This is also the core of the breakpoint-count debate: if the previous round
 * wrote only one breakpoint at the end, then as soon as this round's prefix
 * diverges before that position the hit drops straight to zero; if the previous
 * round wrote one each in system / tools / messages, the earlier ones are still
 * readable -- that is the "ladder".
 */
export function anthropicCacheHit(previous, current) {
  if (!previous) return { hitChars: 0, totalChars: current.text.length };
  const prefix = commonPrefixLength(previous.text, current.text);

  let hitChars = 0;
  for (const breakpoint of previous.breakpoints) {
    if (breakpoint <= prefix) hitChars = Math.max(hitChars, breakpoint);
  }

  return { hitChars, totalChars: current.text.length };
}

/** DeepSeek / OpenAI implicit cache: round the common prefix down to 128-token blocks. */
const IMPLICIT_CACHE_BLOCK_TOKENS = 128;

export function implicitCacheHit(previous, current) {
  if (!previous) return { hitTokens: 0, totalTokens: estimateTokens(current.text.length) };
  const prefixTokens = estimateTokens(commonPrefixLength(previous.text, current.text));
  const blocks = Math.floor(prefixTokens / IMPLICIT_CACHE_BLOCK_TOKENS);
  return {
    hitTokens: blocks * IMPLICIT_CACHE_BLOCK_TOKENS,
    totalTokens: estimateTokens(current.text.length),
  };
}

/**
 * Run a whole multi-round conversation, accounting round by round.
 *
 * The first round has no comparable counterpart and necessarily misses
 * entirely -- that is a physical fact, not a defect. The hit rate is therefore
 * reported on two bases: `overall` includes the first round (matching the real
 * bill), and `steadyState` excludes it (matching "how stable it is once the
 * conversation is running"). When reporting a number, you must say which one
 * you are using, otherwise you are cherry-picking.
 *
 * There is also a third basis, the only one independent of conversation shape:
 * `efficiency`, actual hit / theoretical ceiling. The theoretical ceiling is
 * "round n can at most hit the entirety of round n-1" -- content newly added in
 * this round did not exist in the previous round at all, so it cannot be hit.
 * The absolute hit rate is therefore determined by the base/delta ratio rather
 * than by the implementation: with the same implementation, enlarging the
 * system prompt makes the number look better. Asserting an absolute hit rate is
 * asserting the shape of the fixture; asserting efficiency is asserting that we
 * have not missed any byte that could have been hit.
 */
export function runCacheSimulation(payloads, { model = "anthropic" } = {}) {
  const flattened = payloads.map(flattenAnthropicPayload);
  const rounds = [];

  let hitUnits = 0;
  let totalUnits = 0;
  let steadyHitUnits = 0;
  let steadyTotalUnits = 0;
  let ceilingUnits = 0;

  for (let index = 0; index < flattened.length; index += 1) {
    const previous = index === 0 ? null : flattened[index - 1];
    const current = flattened[index];

    const result =
      model === "anthropic"
        ? anthropicCacheHit(previous, current)
        : implicitCacheHit(previous, current);
    const hit = result.hitChars ?? result.hitTokens;
    const total = result.totalChars ?? result.totalTokens;

    // This round's theoretical ceiling: the entirety of the previous round (the
    // common prefix for a pure append); not one more byte could possibly hit.
    const ceiling =
      previous === null
        ? 0
        : model === "anthropic"
          ? previous.text.length
          : estimateTokens(previous.text.length);

    hitUnits += hit;
    totalUnits += total;
    ceilingUnits += ceiling;
    if (index > 0) {
      steadyHitUnits += hit;
      steadyTotalUnits += total;
    }

    rounds.push({
      round: index + 1,
      hit,
      total,
      ceiling,
      hitRate: total === 0 ? 0 : hit / total,
      breakpointCount: current.breakpoints.length,
    });
  }

  return {
    rounds,
    overallHitRate: totalUnits === 0 ? 0 : hitUnits / totalUnits,
    steadyStateHitRate: steadyTotalUnits === 0 ? 0 : steadyHitUnits / steadyTotalUnits,
    efficiency: ceilingUnits === 0 ? 1 : hitUnits / ceilingUnits,
  };
}
