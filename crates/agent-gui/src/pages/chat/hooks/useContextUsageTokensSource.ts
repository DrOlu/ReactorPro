import {
  buildContextUsageScanItems,
  deriveContextUsageTokens,
  hasContextUsageUsageAnchor,
} from "@liveagent/ui/lib/chat/contextUsage";
import { useMemo } from "react";
import type { CompactionController } from "../../../lib/chat/compaction/controller";
import type { RenderTimelineItem } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";

export type ContextUsageTokensSourceParams = {
  isRunning: boolean;
  conversationId: string;
  transcriptItems: readonly RenderTimelineItem[];
  liveTranscriptStore: LiveTranscriptStore;
  getCompactionController: (conversationId: string) => CompactionController;
};

/**
 * Pure factory shared by the current conversation (memoized via the hook
 * below) and workbench background panes, which build one source per pane
 * from their runtime cache entry and per-conversation live store.
 */
export function createContextUsageTokensSource(params: ContextUsageTokensSourceParams) {
  const {
    isRunning,
    conversationId,
    transcriptItems,
    liveTranscriptStore,
    getCompactionController,
  } = params;

  let cache: {
    rounds: unknown;
    draft: string;
    runtimeValue: number | undefined;
    fixedTokens: number | undefined;
    value: number | undefined;
  } | null = null;
  return {
    subscribe: liveTranscriptStore.subscribe,
    getContextUsageTokens: () => {
      const live = liveTranscriptStore.getSnapshot();
      const includeLive = isRunning && !live.isSettled;
      const rounds = includeLive ? live.liveRounds : null;
      const draft = includeLive ? live.draftAssistantText : "";
      const controller = getCompactionController(conversationId);
      const runtimeValue = controller.contextUsageTokens;
      // When the provider does not return usage, the reverse scan has no anchor at all: not
      // adding fixed (the system+tools estimate) would make the idle reading and the running
      // ledger reading (which includes fixed) jump back and forth.
      const fixedTokens = controller.contextFixedTokens;
      if (
        cache &&
        cache.rounds === rounds &&
        cache.draft === draft &&
        cache.runtimeValue === runtimeValue &&
        cache.fixedTokens === fixedTokens
      ) {
        return cache.value;
      }
      // Priority (the original design from when #426 was introduced; the comment was lost during a
      // file split): while running (sending/compacting) the transcript tail lags the ledger, so the
      // ledger reading wins; when idle the transcript holds the authoritative anchor (after an
      // edit-resend truncates history, the ledger stays frozen at the pre-truncation reading), so
      // the transcript scan is accurate. Lazy evaluation: hitting the ledger-priority case skips
      // the full transcript scan (the per-frame cost of JSON.stringify-ing large tool results and
      // discarding them during streaming). Hence the GUI ring jumps as messages settle during
      // streaming rather than estimating per frame; the live tail combined reverse scan is only
      // reachable while running and when the ledger has no reading yet (e.g. relay compaction
      // landing on a controller newly created for this conversation).
      let value: number | undefined;
      if (isRunning && runtimeValue !== undefined) {
        value = runtimeValue;
      } else {
        const scanItems = buildContextUsageScanItems(transcriptItems, includeLive ? live : null);
        const deriveOptions = { unanchoredFixedTokens: fixedTokens };
        const transcriptValue = deriveContextUsageTokens(scanItems, deriveOptions);
        // When there is no trusted usage anchor (a cold-cache hosted search is skipped) the
        // transcript holds only chain-of-thought summaries, and the ledger estimates from full
        // messages (including Responses thinkingSignature). When idle, take the higher value, to
        // avoid a 19k estimate being bumped to 30k by real usage on the next short reply. On a warm
        // cache search turn with a cacheRead+output anchor, still trust the transcript, to avoid an
        // encrypted estimate raising the ring to 36k and then dropping back to 32k after a short
        // reply. With an ordinary anchor, also trust the transcript (after an edit-resend truncation
        // the ledger freezes at the pre-truncation value).
        value =
          !hasContextUsageUsageAnchor(scanItems, deriveOptions) &&
          runtimeValue !== undefined &&
          (transcriptValue === undefined || runtimeValue > transcriptValue)
            ? runtimeValue
            : (transcriptValue ?? runtimeValue);
      }
      cache = { rounds, draft, runtimeValue, fixedTokens, value };
      return value;
    },
  };
}

export function useContextUsageTokensSource(params: ContextUsageTokensSourceParams) {
  const {
    isRunning,
    conversationId,
    transcriptItems,
    liveTranscriptStore,
    getCompactionController,
  } = params;

  return useMemo(
    () =>
      createContextUsageTokensSource({
        isRunning,
        conversationId,
        transcriptItems,
        liveTranscriptStore,
        getCompactionController,
      }),
    [conversationId, getCompactionController, isRunning, liveTranscriptStore, transcriptItems],
  );
}
