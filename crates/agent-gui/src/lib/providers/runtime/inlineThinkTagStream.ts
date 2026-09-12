import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
/** When the body starts exactly with `<`, we cannot wait forever — beyond this length it is judged not to be a think tag. */
const MAX_PROBE_CHARS = 64;

type Mode = "probing" | "thinking" | "answer" | "passthrough";

function splitInlineThinkText(text: string) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(OPEN_TAG)) {
    return { thinking: "", answer: text, matched: false };
  }
  const rest = trimmed.slice(OPEN_TAG.length);
  const closeAt = rest.indexOf(CLOSE_TAG);
  if (closeAt < 0) return { thinking: rest, answer: "", matched: true };
  return {
    thinking: rest.slice(0, closeAt),
    answer: rest.slice(closeAt + CLOSE_TAG.length).trimStart(),
    matched: true,
  };
}

function rewriteContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
  const head = content[0];
  if (head?.type !== "text") return content;
  const split = splitInlineThinkText(head.text);
  if (!split.matched) return content;
  // The thinking block is retained unconditionally (even if empty); otherwise the contentIndex shift in the event stream would not line up with the
  // final message's array indices, causing subsequent tool calls to be read at the wrong offset.
  const rewritten: AssistantMessage["content"] = [{ type: "thinking", thinking: split.thinking }];
  if (split.answer.length > 0) rewritten.push({ ...head, text: split.answer });
  return [...rewritten, ...content.slice(1)];
}

function rewriteMessage(message: AssistantMessage): AssistantMessage {
  const content = rewriteContent(message.content);
  return content === message.content ? message : { ...message, content };
}

/** Length of the longest suffix that forms a prefix of `tag` — for closing tags split across chunks. */
function partialTagSuffixLength(buffer: string, tag: string) {
  const max = Math.min(buffer.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (buffer.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Ollama's OpenAI-compatible endpoint inlines the reasoning model's thinking process as literal `<think>...</think>`
 * inside `content` rather than via the `reasoning_content` field. Here, at the event-stream layer, it is split into
 * a separate thinking block so upper layers receive an event sequence consistent with native reasoning providers.
 *
 * Only the beginning of the text block with source contentIndex 0 (leading whitespace allowed) participates in recognition; native reasoning providers'
 * block 0 is thinking, so it naturally never matches.
 */
export function wrapInlineThinkTagStream(
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  let mode: Mode = "probing";
  let headBuffer = "";
  let carry = "";
  let thinkingText = "";
  let answerText = "";
  let answerBlockCreated = false;
  let thinkingEnded = false;
  let headSettled = false;
  let headTextStartSeen = false;

  const shiftIndex = (index: number) => (index >= 1 && answerBlockCreated ? index + 1 : index);

  const pushThinkingDelta = (delta: string, partial: AssistantMessage) => {
    if (!delta) return;
    thinkingText += delta;
    output.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta,
      partial: rewriteMessage(partial),
    });
  };

  const endThinking = (partial: AssistantMessage) => {
    if (thinkingEnded) return;
    thinkingEnded = true;
    output.push({
      type: "thinking_end",
      contentIndex: 0,
      content: thinkingText,
      partial: rewriteMessage(partial),
    });
  };

  const pushAnswer = (chunk: string, partial: AssistantMessage) => {
    let text = chunk;
    if (!answerBlockCreated) {
      // The newline between `</think>` and the body is not part of the answer content.
      text = text.replace(/^\s+/, "");
      if (!text) return;
      answerBlockCreated = true;
      output.push({ type: "text_start", contentIndex: 1, partial: rewriteMessage(partial) });
    }
    if (!text) return;
    answerText += text;
    output.push({
      type: "text_delta",
      contentIndex: 1,
      delta: text,
      partial: rewriteMessage(partial),
    });
  };

  const feedThinking = (chunk: string, partial: AssistantMessage) => {
    const buffer = carry + chunk;
    carry = "";
    const closeAt = buffer.indexOf(CLOSE_TAG);
    if (closeAt >= 0) {
      pushThinkingDelta(buffer.slice(0, closeAt), partial);
      endThinking(partial);
      mode = "answer";
      pushAnswer(buffer.slice(closeAt + CLOSE_TAG.length), partial);
      return;
    }
    const hold = partialTagSuffixLength(buffer, CLOSE_TAG);
    carry = hold > 0 ? buffer.slice(buffer.length - hold) : "";
    pushThinkingDelta(buffer.slice(0, buffer.length - hold), partial);
  };

  const rejectProbe = (partial: AssistantMessage) => {
    mode = "passthrough";
    // Only re-emit text_start if the source actually emitted one, otherwise pass-through would no longer be an identity.
    if (headTextStartSeen) {
      output.push({ type: "text_start", contentIndex: 0, partial: rewriteMessage(partial) });
    }
    if (headBuffer) {
      output.push({
        type: "text_delta",
        contentIndex: 0,
        delta: headBuffer,
        partial: rewriteMessage(partial),
      });
    }
    headBuffer = "";
  };

  const feedProbe = (chunk: string, partial: AssistantMessage) => {
    headBuffer += chunk;
    const trimmed = headBuffer.trimStart();
    if (trimmed.startsWith(OPEN_TAG)) {
      mode = "thinking";
      headBuffer = "";
      output.push({ type: "thinking_start", contentIndex: 0, partial: rewriteMessage(partial) });
      feedThinking(trimmed.slice(OPEN_TAG.length), partial);
      return;
    }
    if (OPEN_TAG.startsWith(trimmed) && headBuffer.length <= MAX_PROBE_CHARS) return;
    rejectProbe(partial);
  };

  /** Reconcile authoritatively using the full text, filling in tails buffered during streaming that were not yet emitted. */
  const settleHead = (content: string, partial: AssistantMessage) => {
    if (headSettled || mode === "passthrough") return;
    headSettled = true;
    const split = splitInlineThinkText(content);

    if (!split.matched) {
      headBuffer = content;
      rejectProbe(partial);
      output.push({
        type: "text_end",
        contentIndex: 0,
        content,
        partial: rewriteMessage(partial),
      });
      return;
    }

    if (mode === "probing") {
      mode = "thinking";
      headBuffer = "";
      output.push({ type: "thinking_start", contentIndex: 0, partial: rewriteMessage(partial) });
    }
    carry = "";
    if (split.thinking.length > thinkingText.length) {
      pushThinkingDelta(split.thinking.slice(thinkingText.length), partial);
    }
    endThinking(partial);
    mode = "answer";
    if (split.answer.length > answerText.length) {
      pushAnswer(split.answer.slice(answerText.length), partial);
    }
    if (answerBlockCreated) {
      output.push({
        type: "text_end",
        contentIndex: 1,
        content: answerText,
        partial: rewriteMessage(partial),
      });
    }
  };

  const flushResidue = (message: AssistantMessage) => {
    if (headSettled || mode === "passthrough") return;
    const head = message.content[0];
    if (head?.type === "text") {
      settleHead(head.text, message);
      return;
    }
    // Interrupted too early; the final message does not even have text block 0.
    headSettled = true;
    if (mode === "probing") {
      if (headBuffer) rejectProbe(message);
      return;
    }
    pushThinkingDelta(carry, message);
    carry = "";
    endThinking(message);
  };

  void (async () => {
    for await (const event of source) {
      if (mode === "passthrough") {
        output.push(event);
        if (event.type === "done" || event.type === "error") return;
        continue;
      }

      switch (event.type) {
        case "start":
          output.push(event);
          break;
        case "text_start":
          // Block 0 withheld: it is not yet known whether it will become thinking_start or ordinary body text.
          if (event.contentIndex === 0) {
            headTextStartSeen = true;
            break;
          }
          output.push({
            type: "text_start",
            contentIndex: shiftIndex(event.contentIndex),
            partial: rewriteMessage(event.partial),
          });
          break;
        case "text_delta":
          if (event.contentIndex === 0) {
            if (mode === "probing") feedProbe(event.delta, event.partial);
            else if (mode === "thinking") feedThinking(event.delta, event.partial);
            else pushAnswer(event.delta, event.partial);
            break;
          }
          output.push({
            type: "text_delta",
            contentIndex: shiftIndex(event.contentIndex),
            delta: event.delta,
            partial: rewriteMessage(event.partial),
          });
          break;
        case "text_end":
          if (event.contentIndex === 0) {
            settleHead(event.content, event.partial);
            break;
          }
          output.push({
            type: "text_end",
            contentIndex: shiftIndex(event.contentIndex),
            content: event.content,
            partial: rewriteMessage(event.partial),
          });
          break;
        // Block 0 is already a native thinking block, meaning the provider uses reasoning_content; let it through directly.
        case "thinking_start":
          if (mode === "probing" && event.contentIndex === 0) {
            mode = "passthrough";
            output.push(event);
            break;
          }
          output.push({
            type: "thinking_start",
            contentIndex: shiftIndex(event.contentIndex),
            partial: rewriteMessage(event.partial),
          });
          break;
        case "thinking_delta":
          if (mode === "probing" && event.contentIndex === 0) {
            mode = "passthrough";
            output.push(event);
            break;
          }
          output.push({
            type: "thinking_delta",
            contentIndex: shiftIndex(event.contentIndex),
            delta: event.delta,
            partial: rewriteMessage(event.partial),
          });
          break;
        case "thinking_end":
          if (mode === "probing" && event.contentIndex === 0) {
            mode = "passthrough";
            output.push(event);
            break;
          }
          output.push({
            type: "thinking_end",
            contentIndex: shiftIndex(event.contentIndex),
            content: event.content,
            partial: rewriteMessage(event.partial),
          });
          break;
        case "toolcall_start":
          output.push({
            type: "toolcall_start",
            contentIndex: shiftIndex(event.contentIndex),
            partial: rewriteMessage(event.partial),
          });
          break;
        case "toolcall_delta":
          output.push({
            type: "toolcall_delta",
            contentIndex: shiftIndex(event.contentIndex),
            delta: event.delta,
            partial: rewriteMessage(event.partial),
          });
          break;
        case "toolcall_end":
          output.push({
            type: "toolcall_end",
            contentIndex: shiftIndex(event.contentIndex),
            toolCall: event.toolCall,
            partial: rewriteMessage(event.partial),
          });
          break;
        case "done":
          flushResidue(event.message);
          output.push({
            type: "done",
            reason: event.reason,
            message: rewriteMessage(event.message),
          });
          return;
        case "error":
          flushResidue(event.error);
          output.push({ type: "error", reason: event.reason, error: rewriteMessage(event.error) });
          return;
      }
    }

    const settled = await source.result();
    flushResidue(settled);
    output.end(rewriteMessage(settled));
  })();

  return output;
}
