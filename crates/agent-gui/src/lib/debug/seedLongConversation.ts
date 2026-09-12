import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import {
  appendMessagesToConversation,
  normalizeConversationState,
} from "../chat/conversation/conversationState";
import { persistConversationRuntime } from "../chat/history/chatHistory";

// Dev-only transcript stress fixture: builds a large conversation with the
// content shapes that dominate real rendering cost (long prose, big code
// fences, thinking blocks, Bash output, Edit diffs, tool groups and one
// compaction checkpoint), then persists it through the normal history
// pipeline so it opens like any other conversation. Registered on `window`
// from main.tsx behind `import.meta.env.DEV`.

const CODE_SAMPLE = `export function createLedger(entries: LedgerEntry[]): Ledger {
  const byAccount = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const bucket = byAccount.get(entry.account) ?? [];
    bucket.push(entry);
    byAccount.set(entry.account, bucket);
  }
  return {
    balance(account: string): number {
      return (byAccount.get(account) ?? []).reduce((sum, e) => sum + e.amount, 0);
    },
    accounts(): string[] {
      return [...byAccount.keys()].sort();
    },
  };
}`;

const PROSE_SAMPLE = [
  "Here is a longer block of explanatory text, simulating multi-paragraph Markdown content in a real reply.",
  "It contains **bold**, `inline code`, and a list:",
  "",
  "- The first point, explaining the implementation approach and trade-offs",
  "- The second point, describing boundary conditions and failure modes",
  "- The third point, giving follow-up steps that can be verified",
  "",
  "A closing summary sentence to make the paragraph height closer to a real reply.",
].join("\n");

function repeatLines(line: string, count: number) {
  return Array.from({ length: count }, (_, i) => `${line} ${i + 1}`).join("\n");
}

function userMessage(turn: number, timestamp: number): Message {
  return {
    role: "user",
    id: `seed-user-${turn}`,
    content:
      turn % 7 === 0
        ? `This is a long question for turn ${turn}: ${PROSE_SAMPLE}`
        : `Question for turn ${turn}: please continue optimizing the previous implementation and explain the key changes.`,
    timestamp,
  } as Message;
}

function assistantMessage(
  turn: number,
  timestamp: number,
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    id: `seed-assistant-${turn}`,
    responseId: `seed-assistant-${turn}`,
    content,
    provider: "seed",
    model: "seed-model",
    api: "seed",
    stopReason: "stop",
    usage: {
      input: 1200 + turn,
      output: 300 + (turn % 90),
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1500 + turn,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp,
  } as AssistantMessage;
}

function toolResult(
  turn: number,
  callId: string,
  timestamp: number,
  body: string,
  details?: Record<string, unknown>,
): ToolResultMessage {
  return {
    role: "toolResult",
    id: `seed-result-${turn}-${callId}`,
    toolCallId: callId,
    toolName: callId.startsWith("edit") ? "Edit" : "Bash",
    content: [{ type: "text", text: body }],
    isError: false,
    details,
    timestamp,
  } as unknown as ToolResultMessage;
}

function buildTurnMessages(turn: number, baseTimestamp: number): Message[] {
  const at = (offset: number) => baseTimestamp + offset;
  const messages: Message[] = [userMessage(turn, at(0))];

  const blocks: AssistantMessage["content"] = [];
  if (turn % 6 === 0) {
    blocks.push({
      type: "thinking",
      thinking: `Thinking for turn ${turn}:\n\n${PROSE_SAMPLE}`,
    } as AssistantMessage["content"][number]);
  }
  blocks.push({ type: "text", text: `Reply for turn ${turn}. ${PROSE_SAMPLE}` });
  if (turn % 4 === 0) {
    blocks.push({
      type: "text",
      text: `Here is the core code for this turn:\n\n\`\`\`ts\n${CODE_SAMPLE}\n\n${repeatLines("// padding line", 24)}\n\`\`\`\n\nClosing notes after the code.`,
    });
  }

  if (turn % 10 === 0) {
    const callId = `edit-${turn}`;
    blocks.push({
      type: "toolCall",
      id: callId,
      name: "Edit",
      arguments: { file_path: `src/generated/module${turn}.ts`, old_string: "a", new_string: "b" },
    } as AssistantMessage["content"][number]);
    messages.push(assistantMessage(turn, at(1), blocks));
    messages.push(
      toolResult(turn, callId, at(2), `Edited src/generated/module${turn}.ts`, {
        kind: "edit",
        path: `src/generated/module${turn}.ts`,
        displayPath: `src/generated/module${turn}.ts`,
        oldPreview: repeatLines(`const before${turn} = compute(`, 40),
        newPreview: repeatLines(`const after${turn} = computeFaster(`, 44),
      }),
    );
    return messages;
  }

  if (turn % 12 === 1) {
    // A burst of Bash calls in one round → renders as a ToolTraceGroup.
    const callIds = Array.from({ length: 8 }, (_, i) => `bash-${turn}-${i}`);
    for (const callId of callIds) {
      blocks.push({
        type: "toolCall",
        id: callId,
        name: "Bash",
        arguments: { command: `rg --stats "pattern-${callId}" src/` },
      } as AssistantMessage["content"][number]);
    }
    messages.push(assistantMessage(turn, at(1), blocks));
    callIds.forEach((callId, i) => {
      messages.push(toolResult(turn, callId, at(2 + i), repeatLines(`match ${callId}`, 60)));
    });
    return messages;
  }

  if (turn % 5 === 0) {
    const callId = `bash-${turn}`;
    blocks.push({
      type: "toolCall",
      id: callId,
      name: "Bash",
      arguments: { command: `pnpm test --filter step-${turn}` },
    } as AssistantMessage["content"][number]);
    messages.push(assistantMessage(turn, at(1), blocks));
    messages.push(
      toolResult(turn, callId, at(2), repeatLines(`test output line for ${turn}`, 120)),
    );
    return messages;
  }

  messages.push(assistantMessage(turn, at(1), blocks));
  return messages;
}

function compactionCheckpoint(turn: number, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    id: `seed-checkpoint-${turn}`,
    responseId: `seed-checkpoint-${turn}`,
    api: "liveagent-compaction",
    provider: "liveagent",
    model: "summary",
    stopReason: "stop",
    content: [{ type: "text", text: `Compaction checkpoint: covering the first ${turn} turns.\n\n${PROSE_SAMPLE}` }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp,
  } as AssistantMessage;
}

export type SeedLongConversationOptions = {
  turns?: number;
  cwd?: string;
  title?: string;
};

export async function seedLongConversation(options: SeedLongConversationOptions = {}) {
  const turns = Math.max(1, options.turns ?? 240);
  const conversationId = createUuid();
  const startedAt = Date.now() - turns * 60_000;

  let state = normalizeConversationState({ meta: {}, segments: [] });
  const checkpointTurn = Math.max(2, Math.floor(turns * 0.3));
  for (let turn = 1; turn <= turns; turn += 1) {
    const baseTimestamp = startedAt + turn * 60_000;
    state = appendMessagesToConversation(state, buildTurnMessages(turn, baseTimestamp));
    if (turn === checkpointTurn) {
      state = appendMessagesToConversation(state, [
        compactionCheckpoint(turn, baseTimestamp + 30_000),
      ]);
    }
  }

  await persistConversationRuntime({
    conversationId,
    providerId: "seed",
    model: "seed-model",
    cwd: options.cwd,
    title: options.title ?? `Seed conversation ${turns} turns (${state.meta.totalMessageCount} messages)`,
    createdAt: startedAt,
    updatedAt: Date.now(),
    state,
    getPersistenceCursor: () => null,
    commitPersistenceCursor: () => {},
  });

  console.info(
    `[seedLongConversation] Wrote conversation ${conversationId}: ${state.meta.totalMessageCount} messages, ${state.segments.length} segments. Refresh the sidebar and open it.`,
  );
  return conversationId;
}
