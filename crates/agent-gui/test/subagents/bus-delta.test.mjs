import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const bus = loader.loadModule("src/lib/subagents/bus.ts");
const tailBlock = loader.loadModule("src/lib/chat/context/contextTailBlock.ts");

let nextSeq = 0;
function makeMessage(overrides = {}) {
  nextSeq += 1;
  return {
    id: nextSeq,
    parentConversationId: "conversation-1",
    seq: overrides.seq ?? nextSeq,
    senderId: overrides.senderId ?? "agent-x",
    senderName: overrides.senderName,
    recipientId: overrides.recipientId ?? "parent",
    recipientName: overrides.recipientName,
    channel: overrides.channel ?? "direct",
    subject: overrides.subject,
    bodyMarkdown: overrides.bodyMarkdown ?? `message body ${nextSeq}`,
    createdAt: overrides.createdAt ?? 1_700_000_000_000 + nextSeq,
  };
}

function delta(messages, sinceSeq, overrides = {}) {
  return bus.renderMessageBusDelta({
    messages,
    sinceSeq,
    currentAgentId: overrides.currentAgentId ?? "parent",
    currentAgentName: overrides.currentAgentName,
    maxBodyChars: overrides.maxBodyChars,
  });
}

test("delta renders nothing and holds the cursor when no message is newer than sinceSeq", () => {
  const messages = [
    makeMessage({ seq: 11, bodyMarkdown: "already delivered" }),
    makeMessage({ seq: 12, bodyMarkdown: "also delivered" }),
  ];

  assert.deepEqual(delta(messages, 12), { text: "", lastSeq: 12 });
  assert.deepEqual(delta([], 7), { text: "", lastSeq: 7 });
  // A cursor ahead of every message (the extreme case of re-freezing after compaction) must not regress.
  assert.deepEqual(delta(messages, 99), { text: "", lastSeq: 99 });
});

test("delta carries only messages after the cursor and advances it to the newest seq", () => {
  const messages = [
    makeMessage({ seq: 1, bodyMarkdown: "old one" }),
    makeMessage({ seq: 2, bodyMarkdown: "old two" }),
    makeMessage({ seq: 3, bodyMarkdown: "fresh three" }),
    makeMessage({ seq: 4, recipientId: "*", channel: "decision", bodyMarkdown: "fresh four" }),
  ];

  const result = delta(messages, 2);
  assert.equal(result.lastSeq, 4);
  assert.doesNotMatch(result.text, /old one/);
  assert.doesNotMatch(result.text, /old two/);
  assert.match(result.text, /> fresh three/);
  assert.match(result.text, /> fresh four/);
  assert.match(result.text, /^## ReactorPro Message Bus \(new messages\)/);
  assert.match(result.text, /Current agent: `parent`/);
  // Ordered by ascending seq, on the same basis as the snapshot.
  assert.ok(result.text.indexOf("fresh three") < result.text.indexOf("fresh four"));
});

test("delta reuses the snapshot visibility filter", () => {
  const invisible = [
    // Directed at another agent
    makeMessage({ seq: 21, recipientId: "agent-b", bodyMarkdown: "secret for b" }),
    // Empty body
    makeMessage({ seq: 22, bodyMarkdown: "   " }),
    // Empty conversation ownership
    { ...makeMessage({ seq: 23, bodyMarkdown: "orphan" }), parentConversationId: "  " },
  ];
  assert.deepEqual(delta(invisible, 20), { text: "", lastSeq: 20 });
  assert.equal(bus.renderMessageBusSnapshot({ messages: invisible, currentAgentId: "parent" }).text, "");

  const visible = [
    makeMessage({ seq: 24, recipientId: "parent", bodyMarkdown: "direct to parent" }),
    makeMessage({ seq: 25, recipientId: "*", bodyMarkdown: "broadcast" }),
    makeMessage({ seq: 26, senderId: "parent", recipientId: "agent-b", bodyMarkdown: "sent by me" }),
  ];
  const result = delta([...invisible, ...visible], 20);
  assert.equal(result.lastSeq, 26);
  assert.doesNotMatch(result.text, /secret for b/);
  assert.doesNotMatch(result.text, /orphan/);
  assert.match(result.text, /> direct to parent/);
  assert.match(result.text, /> broadcast/);
  assert.match(result.text, /> sent by me/);
});

test("delta is pure: same input renders byte-identical output", () => {
  const first = makeMessage({ seq: 31, bodyMarkdown: "deterministic", createdAt: 1_700_000_000_001 });
  const second = makeMessage({ seq: 32, bodyMarkdown: "later", createdAt: 1_700_000_000_002 });
  assert.equal(delta([first], 30).text, delta([first], 30).text);
  // Out-of-order input does not affect output (sorted internally by seq).
  assert.equal(delta([first, second], 30).text, delta([second, first], 30).text);
});

test("overflow snapshot exposes renderedSeq so unrendered messages get re-delivered by delta", () => {
  // Visible messages beyond the snapshot render cap (recent bucket of 24): low-seq ones are squeezed out by the quota.
  const messages = [];
  for (let i = 1; i <= 30; i += 1) {
    messages.push(
      makeMessage({ seq: i, recipientId: "*", bodyMarkdown: `overflow message ${i}` }),
    );
  }

  const snapshot = bus.renderMessageBusSnapshot({ messages, currentAgentId: "parent" });
  assert.ok(snapshot.omittedCount > 0, "30 visible messages must exceed the snapshot capacity");
  // The cursor must not skip unrendered messages: the contiguous rendered prefix stops before
  // the first squeezed-out message.
  assert.ok(
    snapshot.renderedSeq < 30,
    `renderedSeq(${snapshot.renderedSeq}) must not be the max seq of all visible messages`,
  );
  assert.match(snapshot.text, new RegExp(`\\(${snapshot.omittedCount} messages omitted;`));

  // Messages not in the snapshot must still be re-delivered by the delta from renderedSeq and
  // must not be silently lost.
  const followUp = delta(messages, snapshot.renderedSeq);
  assert.equal(followUp.lastSeq, 30);
  for (const message of messages) {
    const inSnapshot = snapshot.text.includes(message.bodyMarkdown);
    const inDelta = followUp.text.includes(message.bodyMarkdown);
    assert.ok(inSnapshot || inDelta, `seq=${message.seq} is in neither the snapshot nor the delta`);
  }
});

function toolResult(toolCallId, text, overrides = {}) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: overrides.toolName ?? "Read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
    ...overrides,
  };
}

function assistant(overrides = {}) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "Read", arguments: {} }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {},
    stopReason: "toolUse",
    timestamp: 1,
    ...overrides,
  };
}

test("resolveTailBlockAnchorId picks the last safe tool result and attach pins to it", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(),
    toolResult("call-1", "first result"),
    assistant(),
    toolResult("call-2", "second result"),
  ];
  const snapshot = JSON.parse(JSON.stringify(messages));

  const anchorToolCallId = tailBlock.resolveTailBlockAnchorId(messages);
  assert.equal(anchorToolCallId, "call-2");

  const next = tailBlock.attachPinnedTailBlocks(messages, [
    { anchorToolCallId, text: "BUS DELTA" },
  ]);
  assert.notEqual(next, messages);
  assert.deepEqual(messages, snapshot, "input messages must not be mutated in place");
  assert.equal(next[2], messages[2], "unmatched messages keep the same reference");
  assert.deepEqual(next[4].content, [
    { type: "text", text: "second result" },
    { type: "text", text: "BUS DELTA" },
  ]);
  assert.equal(next[4].toolCallId, "call-2", "toolCallId is preserved as-is");
});

// Critical regression guard: once an anchor is pinned, later rounds advancing the tool loop must
// not let the block move — moving would revert the bytes of the message the block was attached to
// in the previous round, invalidating the whole prefix from that point on.
test("pinned tail block stays on its original anchor as the tool loop grows", () => {
  const roundTwo = [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(),
    toolResult("call-1", "first result"),
  ];
  const anchorToolCallId = tailBlock.resolveTailBlockAnchorId(roundTwo);
  assert.equal(anchorToolCallId, "call-1");
  const pinned = [{ anchorToolCallId, text: "BUS DELTA" }];

  const outboundTwo = tailBlock.attachPinnedTailBlocks(roundTwo, pinned);

  // Round 3: the tool loop advanced another step, and the "last tool result" is now call-2.
  const roundThree = [...roundTwo, assistant(), toolResult("call-2", "second result")];
  const outboundThree = tailBlock.attachPinnedTailBlocks(roundThree, pinned);

  assert.deepEqual(
    outboundThree[2],
    outboundTwo[2],
    "the pinned anchor message must stay byte-stable; the block must not move to a new message as the tool loop advances",
  );
  assert.deepEqual(
    outboundThree[4].content,
    [{ type: "text", text: "second result" }],
    "the new tool result must not be polluted by the moved block",
  );
});

test("attachPinnedTailBlocks returns the same reference when there is nothing to attach", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(),
    toolResult("call-1", "result"),
  ];
  assert.equal(tailBlock.attachPinnedTailBlocks(messages, []), messages);
  assert.equal(
    tailBlock.attachPinnedTailBlocks(messages, [{ anchorToolCallId: "call-1", text: "" }]),
    messages,
    "empty text produces no content at all",
  );
  assert.equal(
    tailBlock.attachPinnedTailBlocks(messages, [{ anchorToolCallId: "gone", text: "BUS DELTA" }]),
    messages,
    "when the anchor is no longer in the message list nothing is attached this round, and nothing moves",
  );
});

test("multiple blocks on one anchor replay in delivery order", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(),
    toolResult("call-1", "result"),
  ];
  const next = tailBlock.attachPinnedTailBlocks(messages, [
    { anchorToolCallId: "call-1", text: "FIRST" },
    { anchorToolCallId: "call-1", text: "SECOND" },
  ]);
  assert.deepEqual(next[2].content, [
    { type: "text", text: "result" },
    { type: "text", text: "FIRST" },
    { type: "text", text: "SECOND" },
  ]);
});

test("anchor resolution refuses unsafe anchors and never crosses the last user message", () => {
  const displayImage = [
    assistant(),
    toolResult("call-1", "image", { toolName: "Image", details: { kind: "display_image" } }),
  ];
  assert.equal(
    tailBlock.resolveTailBlockAnchorId(displayImage),
    null,
    "a display-image tool result's content is sanitized by whole replacement, so it cannot be an anchor",
  );

  const subagentCard = [
    assistant(),
    toolResult("call-1", "card", { toolName: "Agent", details: { kind: "subagent_card" } }),
  ];
  assert.equal(
    tailBlock.resolveTailBlockAnchorId(subagentCard),
    null,
    "a subagent card tool result is filtered out entirely, so it cannot be an anchor",
  );

  const aborted = [
    assistant({ stopReason: "aborted" }),
    toolResult("call-1", "orphan"),
    toolResult("call-2", "orphan too"),
  ];
  assert.equal(
    tailBlock.resolveTailBlockAnchorId(aborted),
    null,
    "tool results after an aborted assistant are discarded, so they cannot be an anchor",
  );

  const onlyUser = [
    { role: "user", content: "earlier", timestamp: 1 },
    assistant(),
    toolResult("call-1", "safe"),
    { role: "user", content: "latest", timestamp: 2 },
  ];
  assert.equal(
    tailBlock.resolveTailBlockAnchorId(onlyUser),
    null,
    "must not cross the last user message to rewrite an already-cached prefix",
  );

  const noToolCallId = [assistant(), toolResult("", "anonymous")];
  assert.equal(
    tailBlock.resolveTailBlockAnchorId(noToolCallId),
    null,
    "an unpinnable anchor is as good as no anchor, otherwise later rounds degrade into searching again",
  );
});

test("anchor resolution skips unsafe tail anchors and falls back to an earlier safe tool result", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(),
    toolResult("call-1", "safe result"),
    toolResult("call-2", "image", { toolName: "Image", details: { kind: "display_image" } }),
  ];
  const anchorToolCallId = tailBlock.resolveTailBlockAnchorId(messages);
  assert.equal(anchorToolCallId, "call-1");

  const next = tailBlock.attachPinnedTailBlocks(messages, [
    { anchorToolCallId, text: "BUS DELTA" },
  ]);
  assert.notEqual(next, messages);
  assert.equal(next[3], messages[3], "an unsafe tail anchor is left as-is");
  assert.deepEqual(next[2].content, [
    { type: "text", text: "safe result" },
    { type: "text", text: "BUS DELTA" },
  ]);
});
