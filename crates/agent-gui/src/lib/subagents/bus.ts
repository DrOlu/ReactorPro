import {
  SUBAGENT_BROADCAST_RECIPIENT,
  SUBAGENT_PARENT_ID,
  type SubagentMessageRecord,
} from "./types";

const DEFAULT_MAX_MESSAGES = 24;
const DEFAULT_MAX_BODY_CHARS = 2_400;

function normalizeAgentId(value: string | undefined) {
  return (value ?? "").trim();
}

function escapeInlineCode(value: string) {
  return value.replace(/`/g, "\\`");
}

function escapeInlineMarkdown(value: string) {
  return value.replace(/[`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function displayAgentLabel(agentId: string | undefined, displayName?: string) {
  const id = normalizeAgentId(agentId) || "unknown";
  const name = displayName?.trim();
  if (!name || name === id) return `\`${escapeInlineCode(id)}\``;
  return `**${escapeInlineMarkdown(name)}** (\`${escapeInlineCode(id)}\`)`;
}

function truncateMarkdown(value: string, maxChars: number) {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 40)).trimEnd()}\n\n[message truncated; original chars=${text.length}]`;
}

function quoteMarkdown(value: string) {
  const text = value.trim();
  if (!text) return "> (empty)";
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function isSharedMessage(message: SubagentMessageRecord) {
  return message.recipientId === SUBAGENT_BROADCAST_RECIPIENT;
}

function isForAgent(message: SubagentMessageRecord, agentId: string) {
  return message.recipientId === agentId;
}

function sortBySeq(messages: SubagentMessageRecord[]) {
  return messages.slice().sort((a, b) => a.seq - b.seq);
}

function renderMessage(message: SubagentMessageRecord, maxBodyChars: number) {
  const from = displayAgentLabel(message.senderId, message.senderName);
  const to = displayAgentLabel(message.recipientId, message.recipientName);
  const subject = message.subject?.trim();
  return [
    `#### #${message.seq} ${from} -> ${to}`,
    `- Channel: ${message.channel}`,
    subject ? `- Subject: ${escapeInlineMarkdown(subject)}` : "",
    `- Created at: ${new Date(message.createdAt).toISOString()}`,
    "",
    quoteMarkdown(truncateMarkdown(message.bodyMarkdown, maxBodyChars)),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function takeLatest(messages: SubagentMessageRecord[], limit: number) {
  if (messages.length <= limit) return messages;
  return messages.slice(messages.length - limit);
}

/**
 * Visibility policy shared by snapshot and delta: ascending by seq, filtering out empty messages,
 * keeping only messages addressed to this agent, broadcast to all, or sent by this agent. Both
 * places must use the same policy, otherwise the delta would under-deliver or re-deliver.
 */
function visibleBusMessages(messages: SubagentMessageRecord[], currentAgentId: string) {
  return sortBySeq(messages).filter(
    (message) =>
      message.parentConversationId.trim() &&
      message.bodyMarkdown.trim() &&
      (isForAgent(message, currentAgentId) ||
        isSharedMessage(message) ||
        message.senderId === currentAgentId),
  );
}

export function displayRecipientLabel(recipientId: string) {
  if (recipientId === SUBAGENT_PARENT_ID) return "parent";
  if (recipientId === SUBAGENT_BROADCAST_RECIPIENT) return "all agents";
  return recipientId;
}

/**
 * Render a bounded Markdown snapshot of the conversation-level message bus
 * for one agent. Delivery is pull-based: this snapshot is injected into the
 * agent's context at turn boundaries.
 *
 * The snapshot renders at most maxMessages entries; when visible messages exceed the limit, some
 * are left unrendered. The returned `renderedSeq` is the max seq of the "contiguous rendered
 * prefix of visible messages in ascending seq order" -- the freeze cursor must use it rather than
 * the max seq of all visible messages, otherwise messages squeezed out by the quota would be
 * skipped by the cursor and silently lost. Unrendered messages are left for a later
 * `renderMessageBusDelta` incremental top-up.
 */
export function renderMessageBusSnapshot(params: {
  messages: SubagentMessageRecord[];
  currentAgentId: string;
  currentAgentName?: string;
  maxMessages?: number;
  maxBodyChars?: number;
}): { text: string; renderedSeq: number; omittedCount: number } {
  const currentAgentId = normalizeAgentId(params.currentAgentId);
  if (!currentAgentId) return { text: "", renderedSeq: 0, omittedCount: 0 };

  const maxMessages = params.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxBodyChars = params.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const messages = visibleBusMessages(params.messages, currentAgentId);
  if (messages.length === 0) return { text: "", renderedSeq: 0, omittedCount: 0 };

  const usedSeqs = new Set<number>();
  let remainingMessages = maxMessages;
  const consume = (items: SubagentMessageRecord[]) => {
    if (remainingMessages <= 0) return [];
    const fresh = items.filter((message) => !usedSeqs.has(message.seq));
    for (const message of fresh) usedSeqs.add(message.seq);
    const selected = takeLatest(fresh, remainingMessages);
    remainingMessages -= selected.length;
    return selected;
  };

  const directInbox = consume(messages.filter((message) => isForAgent(message, currentAgentId)));
  const sharedDecisions = consume(
    messages.filter((message) => message.channel === "decision" && isSharedMessage(message)),
  );
  const openQuestions = consume(
    messages.filter(
      (message) =>
        message.channel === "question" &&
        (isForAgent(message, currentAgentId) || isSharedMessage(message)),
    ),
  );
  const recentMessages = consume(takeLatest(messages, maxMessages));

  // The set actually rendered into the snapshot is the union of the four selected sets; usedSeqs
  // gets consume-marked onto fresh messages that were not selected, so it cannot be used as the
  // rendered set.
  const renderedSeqs = new Set<number>();
  for (const bucket of [directInbox, sharedDecisions, openQuestions, recentMessages]) {
    for (const message of bucket) renderedSeqs.add(message.seq);
  }
  // Contiguous rendered prefix: advance entry by entry from the smallest seq, stopping at the first unrendered visible message.
  let renderedSeq = 0;
  for (const message of messages) {
    if (!renderedSeqs.has(message.seq)) break;
    renderedSeq = message.seq;
  }
  const omittedCount = messages.length - renderedSeqs.size;

  const sections: string[] = [
    "## ReactorPro Message Bus",
    "",
    `Current agent: ${displayAgentLabel(currentAgentId, params.currentAgentName)}`,
    "Messages below are a Markdown snapshot of the conversation-level bus. Use the SendMessage tool for new cross-agent messages; do not write temporary files for communication.",
  ];

  const appendSection = (title: string, items: SubagentMessageRecord[]) => {
    if (items.length === 0) return;
    sections.push(
      "",
      `### ${title}`,
      "",
      ...items.map((message) => renderMessage(message, maxBodyChars)).flatMap((text) => [text, ""]),
    );
  };

  appendSection(
    `Direct Inbox for ${params.currentAgentName?.trim() || currentAgentId}`,
    directInbox,
  );
  appendSection("Shared Decisions", sharedDecisions);
  appendSection("Open Questions", openQuestions);
  appendSection("Recent Messages", recentMessages);

  if (omittedCount > 0) {
    // Honestly mark the omission so readers do not mistake the snapshot for the full set; unrendered messages are topped up by the delta according to renderedSeq.
    sections.push(
      "",
      `(${omittedCount} messages omitted; unrendered messages will be re-delivered via delta)`,
    );
  }

  return { text: sections.join("\n").trim(), renderedSeq, omittedCount };
}

/**
 * Render incremental messages with seq greater than sinceSeq.
 *
 * The snapshot in systemPrompt is frozen per compaction epoch; messages arriving during the run
 * do not retroactively rewrite systemPrompt. Instead this function renders them as an incremental
 * text segment appended to the tail of the messages -- the tail already sits after the cache
 * breakpoint and is re-read every turn, so appending does not lose additional cache hits.
 *
 * Pure function: no time-dependent or random quantities; identical input yields identical output.
 * When there is nothing new it returns `{ text: "", lastSeq: sinceSeq }`, and the caller produces
 * no additional content at all.
 */
export function renderMessageBusDelta(params: {
  messages: SubagentMessageRecord[];
  sinceSeq: number;
  currentAgentId: string;
  currentAgentName?: string;
  maxBodyChars?: number;
}): { text: string; lastSeq: number } {
  const sinceSeq = Number.isFinite(params.sinceSeq) ? params.sinceSeq : 0;
  const currentAgentId = normalizeAgentId(params.currentAgentId);
  if (!currentAgentId) return { text: "", lastSeq: sinceSeq };

  const maxBodyChars = params.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const fresh = visibleBusMessages(params.messages, currentAgentId).filter(
    (message) => message.seq > sinceSeq,
  );
  if (fresh.length === 0) return { text: "", lastSeq: sinceSeq };

  const text = [
    "## ReactorPro Message Bus (new messages)",
    "",
    `Current agent: ${displayAgentLabel(currentAgentId, params.currentAgentName)}`,
    "Messages below arrived after the snapshot in the system prompt. Use the SendMessage tool for new cross-agent messages; do not write temporary files for communication.",
    "",
    ...fresh.map((message) => renderMessage(message, maxBodyChars)).flatMap((body) => [body, ""]),
  ]
    .join("\n")
    .trim();

  return { text, lastSeq: fresh[fresh.length - 1].seq };
}
