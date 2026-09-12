import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type {
  ClarifyMessage,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { assistantMessageToText, streamAssistantMessage } from "../../../lib/providers/llm";
import type { EffectiveChatModelSelection } from "./modelSelection";

type RuntimeLike = Parameters<typeof streamAssistantMessage>[0]["runtime"];

function createZeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Assistant messages from the clarification history → pi-ai AssistantMessage.
 * The protocol only cares about text; fields such as api/usage are placeholders
 * required by the type (assembled the same way as the compaction summarizer),
 * and provider payload assembly reads only the text blocks among them.
 */
function toAssistantContextMessage(
  message: ClarifyMessage,
  timestamp: number,
  selection: EffectiveChatModelSelection,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    timestamp,
    api: "liveagent-clarify",
    provider: selection.providerId,
    model: selection.model,
    stopReason: "stop",
    usage: createZeroUsage(),
  } as AssistantMessage;
}

/**
 * Clarification messages → pi-ai Context. pi-ai's Message union type
 * (user/assistant/toolResult) has no system role; stuffing one directly into
 * messages would both fail the type check and be dropped by each provider's
 * payload assembly. So system messages are merged into systemPrompt, and the
 * rest are mapped as-is (the text-only suffix is appended uniformly by
 * buildTextOnlyCallContext).
 */
export function buildClarifyCallContext(
  messages: ClarifyMessage[],
  selection: EffectiveChatModelSelection,
): Context {
  const systemPrompts: string[] = [];
  const contextMessages: Context["messages"] = [];
  const timestamp = Date.now();
  for (const message of messages) {
    if (message.role === "system") {
      systemPrompts.push(message.content);
      continue;
    }
    contextMessages.push(
      message.role === "user"
        ? { role: "user", content: message.content, timestamp }
        : toAssistantContextMessage(message, timestamp, selection),
    );
  }
  return {
    systemPrompt: systemPrompts.length > 0 ? systemPrompts.join("\n\n") : undefined,
    messages: contextMessages,
  };
}

/**
 * The desktop host's clarification executor: runs one plain-text completion
 * with the current conversation model. The model/runtime are resolved lazily
 * (via getters) on each call, ensuring clarification always uses the selection
 * as of when the panel was opened.
 */
export function createGuiClarifyRunner(
  getSelection: () => EffectiveChatModelSelection,
  getRuntime: () => RuntimeLike,
): RunClarifyTurn {
  return async (
    messages: ClarifyMessage[],
    signal: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ) => {
    const selection = getSelection();
    const assistant = await streamAssistantMessage({
      providerId: selection.providerId,
      model: selection.model,
      runtime: getRuntime(),
      signal,
      cacheRetention: "none",
      nativeWebSearch: false,
      context: buildClarifyCallContext(messages, selection),
      onTextDelta: (delta) => onTextDelta?.(delta),
    });
    return assistantMessageToText(assistant);
  };
}
