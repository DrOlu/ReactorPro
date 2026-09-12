import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import { branchChatHistory } from "../../../lib/chat/history/chatHistory";
import { asErrorMessage } from "../chatPageUtils";

type UseBranchConversationParams = {
  currentConversationIdRef: MutableRefObject<string>;
  isSending: boolean;
  isConversationHydrating: boolean;
  isConversationHydrationFailed: boolean;
  sidebarStore: SidebarStore;
  handleSelectConversation: (id: string) => void;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  t: (key: string) => string;
};

/**
 * Copies the conversation prefix up to (and including) the picked assistant
 * reply into a fresh "New Branch" conversation, then switches to it.
 */
export function useBranchConversation(params: UseBranchConversationParams) {
  const {
    currentConversationIdRef,
    isSending,
    isConversationHydrating,
    isConversationHydrationFailed,
    sidebarStore,
    handleSelectConversation,
    setErrorMessage,
    t,
  } = params;

  const branchInFlightRef = useRef(false);
  // Drives the spinner on the clicked row and disables the whole row; the ref remains the synchronous source of truth for re-entry prevention.
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);
  const handleBranchConversation = useCallback(
    async (messageRef: HistoryMessageRef) => {
      const conversationId = currentConversationIdRef.current.trim();
      if (!conversationId) return;
      if (isSending || isConversationHydrating || isConversationHydrationFailed) return;
      // The branch invoke queues behind the same-session persist write lock, during which the button can still be clicked:
      // use the ref to block duplicate confirmations, preventing one click storm from creating multiple "New Branch" conversations.
      if (branchInFlightRef.current) return;
      branchInFlightRef.current = true;
      setBranchPendingMessageId(messageRef.messageId);
      try {
        const summary = await branchChatHistory(conversationId, messageRef);
        sidebarStore.upsertLocal({ ...summary, isPending: undefined });
        handleSelectConversation(summary.id);
      } catch (error) {
        setErrorMessage(asErrorMessage(error, t("chat.branchFailed")));
      } finally {
        branchInFlightRef.current = false;
        setBranchPendingMessageId(null);
      }
    },
    [
      currentConversationIdRef,
      handleSelectConversation,
      isConversationHydrating,
      isConversationHydrationFailed,
      isSending,
      setErrorMessage,
      sidebarStore,
      t,
    ],
  );

  return { branchPendingMessageId, handleBranchConversation };
}
