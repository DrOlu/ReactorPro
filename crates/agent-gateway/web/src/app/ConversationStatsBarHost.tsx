/**
 * Thin WebUI wrapper around the conversation stats status bar
 * (docs/design/composer-context-stats-bar.md §4.4).
 *
 * A separate component rather than writing directly into GatewayAppView: while
 * running, the status bar re-renders once per second, and isolating it here
 * redraws only this row instead of reflowing the whole view (the same
 * consideration as ComposerContextUsageRing).
 */

import { ConversationStatsBar } from "@liveagent/ui/components/chat/ConversationStatsBar";
import type { TrajectoryHost } from "@liveagent/ui/contracts/trajectory";
import { useConversationStats } from "@liveagent/ui/lib/trajectory/useConversationStats";
import type { ContextUsageTokensSource } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { useSyncExternalStore } from "react";
import {
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
  subscribeLiveTrajectory,
} from "@/lib/trajectory/liveTrajectory";

const noopSubscribe = () => () => {};
const readNoTokens = () => undefined;

export function ConversationStatsBarHost(props: {
  conversationId: string;
  host: TrajectoryHost;
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
    host,
    enabled = true,
    onManualCompactConfirm,
    manualCompactBlocked,
    contextUsageTokensSource,
    contextWindow,
  } = props;
  const liveEvents = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryEvents(conversationId),
  );
  const authoritativeRevision = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryAuthoritativeRevision(conversationId),
  );
  const { stats } = useConversationStats({
    conversationId,
    host,
    liveEvents,
    // Observer side: when the page was just reloaded and no live stream has
    // arrived yet, do not misjudge a still-running turn as interrupted.
    liveOwnership: "observed",
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
