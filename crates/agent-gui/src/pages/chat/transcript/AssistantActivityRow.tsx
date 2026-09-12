import { isPendingUserInteractionBlock } from "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils";
import { LiveSparkle } from "@liveagent/ui/components/chat/LiveSparkle";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { memo, useMemo } from "react";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
import { AssistantRenderUnit } from "./AssistantRenderUnit";
import type {
  AssistantActivityRow as AssistantActivityRowModel,
  AssistantUnitRow,
} from "./rowModel";

function hasPendingInteractionCard(units: AssistantUnitRow[]) {
  return units.some(
    (unit) => unit.unit.kind === "block" && isPendingUserInteractionBlock(unit.unit.block),
  );
}

export const AssistantActivityRow = memo(function AssistantActivityRow(props: {
  row: AssistantActivityRowModel;
  showUsage?: boolean;
  usageContextWindow?: number;
  isCompactionRunning: boolean;
  /** This conversation has a tool stuck at the approval gate (approval happens before execution and does not show up as a running tool). */
  hasPendingToolApproval?: boolean;
  toolStatus: string | null;
  actionsVisible?: boolean;
  retryAttempts?: RetryAttemptRecord[];
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
}) {
  const {
    row,
    showUsage,
    usageContextWindow,
    isCompactionRunning,
    hasPendingToolApproval = false,
    toolStatus,
    actionsVisible,
    retryAttempts,
    workdir,
    onOpenFileLink,
    onResendFromEdit,
    onBranchConversation,
  } = props;

  // When the turn stops on the user (an unanswered question / plan card, or a tool stuck at the
  // approval gate) nothing is actually running: the progress indicator becomes static, since
  // blinking would misreport "waiting for your decision" as "processing".
  const awaitingDecision = useMemo(
    () => row.live && (hasPendingToolApproval || hasPendingInteractionCard(row.units)),
    [hasPendingToolApproval, row.live, row.units],
  );

  return (
    <div data-live-activity={row.live ? "true" : undefined} className="min-w-0 w-full max-w-full">
      {row.units.map((unit, index) => (
        <div key={unit.key} data-activity-key={unit.key} className="min-w-0 max-w-full">
          <AssistantRenderUnit
            row={unit}
            showUsage={showUsage}
            usageContextWindow={usageContextWindow}
            isCompactionRunning={unit.mutable ? isCompactionRunning : false}
            awaitingDecision={awaitingDecision}
            toolStatus={unit.mutable ? toolStatus : null}
            actionsVisible={actionsVisible}
            retryAttempts={unit.mutable ? retryAttempts : undefined}
            workdir={workdir}
            onOpenFileLink={onOpenFileLink}
            onResendFromEdit={onResendFromEdit}
            onBranchConversation={onBranchConversation}
          />
          {unit.gapAfter > 0 && index < row.units.length - 1 ? (
            <div aria-hidden="true" style={{ height: unit.gapAfter }} />
          ) : null}
        </div>
      ))}
      {/* The pulsing star that persists for the whole life of the turn: it stays visible
          through gaps between tools/thinking and the compaction summary stage, telling the user
          the conversation is still in progress; it disappears once the turn settles (live=false). */}
      {row.live ? <LiveSparkle className="pt-1" paused={awaitingDecision} /> : null}
    </div>
  );
});
