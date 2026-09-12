/**
 * Desktop thin wrapper around the conversation stats status bar: wires the
 * shared-layer data hook to the local live event source and the Tauri
 * trajectory host (docs/design/composer-context-stats-bar.md §4.4).
 *
 * The data code is the same as ConversationTrajectorySurface; merging,
 * deduplication, and caching of live events with the persisted window all
 * happen in the shared layer, and this only handles injection.
 */

import { ConversationStatsBar } from "@liveagent/ui/components/chat/ConversationStatsBar";
import { useConversationStats } from "@liveagent/ui/lib/trajectory/useConversationStats";
import type { ContextUsageTokensSource } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { useSyncExternalStore } from "react";
import { createTauriTrajectoryHost } from "../../../agent-ui-adapters/trajectory";
import {
  desktopLiveTrajectoryEvents,
  desktopTrajectoryReloadVersion,
  subscribeDesktopLiveTrajectory,
} from "../../../lib/trajectory/liveTrajectory";

// The host is stateless (just a wrapper around invoke), so one module-level
// instance can be reused.
const trajectoryHost = createTauriTrajectoryHost();

const noopSubscribe = () => () => {};
const readNoTokens = () => undefined;

export function ConversationStatsBarHost(props: {
  conversationId: string;
  enabled?: boolean;
  /** When provided and usage meets the threshold, the whole bar is clickable and triggers manual compaction after a confirmation; defaults to display-only. */
  onManualCompactConfirm?: (() => void) | (() => Promise<unknown>);
  manualCompactBlocked?: boolean;
  /** The same subscription source as the composer usage ring, letting the always-visible status bar group read the current context usage. */
  contextUsageTokensSource?: ContextUsageTokensSource;
  contextWindow?: number;
}) {
  const {
    conversationId,
    enabled = true,
    onManualCompactConfirm,
    manualCompactBlocked,
    contextUsageTokensSource,
    contextWindow,
  } = props;
  const liveEvents = useSyncExternalStore(subscribeDesktopLiveTrajectory, () =>
    desktopLiveTrajectoryEvents(conversationId),
  );
  const authoritativeRevision = useSyncExternalStore(subscribeDesktopLiveTrajectory, () =>
    desktopTrajectoryReloadVersion(conversationId),
  );
  const { stats } = useConversationStats({
    conversationId,
    host: trajectoryHost,
    liveEvents,
    // The desktop holds the authoritative live tail: an empty set is also
    // evidence that "the process has restarted", so a leftover running state
    // converges to interrupted.
    liveOwnership: "authoritative",
    authoritativeRevision,
    enabled,
  });
  const contextUsageTokens = useSyncExternalStore(
    contextUsageTokensSource?.subscribe ?? noopSubscribe,
    contextUsageTokensSource?.getContextUsageTokens ?? readNoTokens,
    contextUsageTokensSource?.getContextUsageTokens ?? readNoTokens,
  );

  return (
    <ConversationStatsBar
      stats={stats}
      contextUsageTokens={contextUsageTokens}
      contextWindow={contextWindow}
      manualCompactBlocked={manualCompactBlocked}
      {...(onManualCompactConfirm === undefined ? {} : { onManualCompactConfirm })}
    />
  );
}
