import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The sub-agent message bus snapshot is assembled into systemPrompt, and systemPrompt sits before
// all messages. Refreshing the snapshot every round = every sub-agent delivery blows through the
// system block together with all the history after it. But the bus cannot be frozen wholesale the
// way taskList is -- delayed delivery is a functional regression. Therefore: the snapshot is frozen
// per "compaction epoch", and messages arriving during the run are rendered as delta blocks handed
// to the runner via override.wireTailText -- the runner accumulates them and attaches them only to
// each outbound request; the agent runtime state, emittedMessages, and persistence never contain
// them. This set of cases watches:
//   1. No new messages -> no extra content is produced (onBeforeNextTurn returns null)
//   2. With new messages -> systemPrompt bytes are unchanged, and the delta is delivered that round
//      via wireTailText without entering the message list
//   3. An already-delivered delta is replayed as-is in later rounds through the accumulator
//      (guarding against the "append once, then revert next round" regression)
//   4. With no safe anchor the cursor does not advance; it is delivered next round and no message
//      is lost
//   5. The compaction boundary re-freezes the snapshot and cursor
//   6. When the re-freeze read fails at the compaction boundary, the cursor rolls back and the
//      delta is delivered next round via wireTailText

const agentRunnerPath = fileURLToPath(
  new URL("../../src/lib/chat/runner/agentRunner.ts", import.meta.url),
);
const builtinRegistryPath = fileURLToPath(
  new URL("../../src/lib/tools/builtinRegistry.ts", import.meta.url),
);
const runtimePlatformPath = fileURLToPath(
  new URL("../../src/lib/runtimePlatform.ts", import.meta.url),
);
const memoryExtractionPath = fileURLToPath(
  new URL("../../src/lib/chat/memory/extractionController.ts", import.meta.url),
);
const fileToolStatePath = fileURLToPath(
  new URL("../../src/lib/tools/fileToolState.ts", import.meta.url),
);

// bus.ts stays a real implementation: both the frozen and delta content are its output bytes, so mocking it out would leave nothing to test.
let runAssistantWithToolsScenario = async () => {
  throw new Error("scenario was not installed");
};

const loader = createTsModuleLoader({
  mocks: {
    [agentRunnerPath]: {
      async runAssistantWithTools(params) {
        return runAssistantWithToolsScenario(params);
      },
    },
    [builtinRegistryPath]: {
      async buildBuiltinToolRegistry() {
        return {
          tools: [],
          async executeToolCall() {
            throw new Error("tool execution was not expected");
          },
        };
      },
    },
    [runtimePlatformPath]: {
      async resolveRuntimePlatform() {
        return "win32";
      },
      // buildToolsSuffix (the usage-ring fixed calibration at the start of the turn runner) reaches
      // these three pure functions; the whole-module replacement stub must fill them in, otherwise
      // the turn throws as soon as it starts.
      normalizeRuntimePlatform(value) {
        return value === "windows" || value === "macos" || value === "linux" ? value : undefined;
      },
      inferRuntimePlatform() {
        return "linux";
      },
      runtimePlatformLabel(platform) {
        if (platform === "windows") return "Windows";
        if (platform === "macos") return "macOS";
        return "Linux";
      },
    },
    [memoryExtractionPath]: {
      memoryExtraction: {
        noteTurnBoundary() {},
        async requestExtraction() {
          return {
            ok: true,
            acceptedCount: 0,
            rejectedCount: 0,
            writtenSlugs: [],
            emittedMessages: [],
          };
        },
      },
    },
    [fileToolStatePath]: {
      createFileToolState() {
        return {};
      },
    },
  },
});

const { runAgentConversationTurn } = loader.loadModule(
  "src/pages/chat/turns/runAgentConversationTurn.ts",
);
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
// The outbound attachment simulation needs exactly the same anchor resolution logic as the runner, so load the real implementation directly.
const { attachPinnedTailBlocks, resolveTailBlockAnchorId } = loader.loadModule(
  "src/lib/chat/context/contextTailBlock.ts",
);

const RUN_ID = "run-bus";
const BASE_SYSTEM_PROMPT = "base system prompt";

function noOp() {}

function busMessage(seq, bodyMarkdown, overrides = {}) {
  return {
    id: seq,
    parentConversationId: "conversation-bus",
    seq,
    senderId: overrides.senderId ?? "agent-x",
    recipientId: overrides.recipientId ?? "parent",
    channel: overrides.channel ?? "direct",
    subject: overrides.subject,
    bodyMarkdown,
    createdAt: 1_700_000_000_000 + seq,
  };
}

function assistantMessage(content, stopReason) {
  return {
    role: "assistant",
    provider: "codex",
    api: "openai-responses",
    model: "gpt-5",
    content,
    stopReason,
    timestamp: 2,
  };
}

function toolCallAssistant(round) {
  return assistantMessage(
    [{ type: "toolCall", id: `call-${round}`, name: "Read", arguments: {} }],
    "toolUse",
  );
}

function toolResult(round, overrides = {}) {
  return {
    role: "toolResult",
    toolCallId: `call-${round}`,
    toolName: overrides.toolName ?? "Read",
    content: [{ type: "text", text: `result ${round}` }],
    details: overrides.details ?? {},
    isError: false,
    timestamp: 3,
  };
}

const finalAssistant = assistantMessage([{ type: "text", text: "done" }], "stop");

function createHookLifecycle() {
  return {
    startAgent: noOp,
    endAgent: noOp,
    startTurn: noOp,
    endTurn: noOp,
    ensureMessageEnded: noOp,
    assistantMessageCompleted: noOp,
    toolExecutionStarted: noOp,
    toolResultReceived: noOp,
  };
}

/** Mutable bus store: test cases deliver messages into it between rounds, simulating sub-agent sends. */
function createBusStore(initialMessages = []) {
  let messages = [...initialMessages];
  // -1 means no injected failure; otherwise let N reads pass, then throw on the N+1th.
  let readsBeforeFailure = -1;
  const calls = [];
  return {
    deliver(...next) {
      messages = [...messages, ...next];
    },
    /** Let skip reads pass, then make the next read throw, to precisely hit the re-freeze at the compaction boundary. */
    failReadAfter(skip) {
      readsBeforeFailure = skip;
    },
    calls,
    store: {
      async ready() {},
      listIdentities: () => [],
      latestRunsByAgent: () => new Map(),
      async listBusMessages(parentId) {
        calls.push(parentId);
        if (readsBeforeFailure === 0) {
          readsBeforeFailure = -1;
          throw new Error("bus store read failed");
        }
        if (readsBeforeFailure > 0) readsBeforeFailure -= 1;
        return messages.map((message) => ({ ...message }));
      },
    },
  };
}

function createHarness({ busMessages, compactDuringRun } = {}) {
  let current = conversationState.createConversationStateFromContext({
    systemPrompt: BASE_SYSTEM_PROMPT,
    messages: [],
  });
  const bus = createBusStore(busMessages);

  const systemPrompts = [];
  const requestMessages = [];
  const record = (label, context) => {
    if (context) {
      systemPrompts.push({ label, systemPrompt: context.systemPrompt });
      requestMessages.push({ label, messages: context.messages });
    }
    return context;
  };

  return {
    bus,
    systemPrompts,
    requestMessages,
    overrides: [],
    /** Message list actually sent in each round's outbound request (including the accumulated tail blocks attached by the runner). */
    outboundRequests: [],
    params: {
      providerId: "codex",
      model: "gpt-5",
      runtime: {},
      runtimeModel: { provider: "codex", api: "openai-responses", id: "gpt-5" },
      selectedModel: { customProviderId: "codex", model: "gpt-5" },
      effectiveWorkdir: "C:/workspace",
      effectiveSkillsEnabled: false,
      showSilentMemoryExtraction: false,
      agentTemplates: [],
      subagentStore: bus.store,
      getMcpSettings: () => ({ servers: [], selected: [] }),
      sessionId: "session-1",
      taskStateStore: {
        runId: RUN_ID,
        getState: () => current.meta.taskList,
        async commitState() {},
      },
      conversationId: "conversation-bus",
      fallbackTitle: "title",
      createdAt: 1,
      titlePromise: null,
      transcriptStore: {},
      gatewayBridgeEvents: {
        hasForwardedText: () => false,
        queueToken: noOp,
        queueEvent: noOp,
        queueToolStatus: noOp,
      },
      hookLifecycle: createHookLifecycle(),
      conversationDebugLogger: { enabled: false, logResult: noOp },
      getNextConversationState: () => current,
      applyConversationState(nextState) {
        current = nextState;
      },
      buildPreparedContext: (state) => ({
        systemPrompt: BASE_SYSTEM_PROMPT,
        messages: state.segments.flatMap((segment) => segment.messages),
      }),
      compaction: {
        noteFixedOverheadTokens() {},
        async maybeCompactPreSend({ budgetContext }) {
          record("pre-send", budgetContext);
        },
        beginRequest(context) {
          record("request", context);
        },
        observeContextMessages: () => 0,
        shouldProtectMidStream: () => false,
        async compactDuringRun({ budgetContext }) {
          record("during-run", budgetContext);
          return compactDuringRun
            ? compactDuringRun()
            : { context: null, shouldDisableProtection: false };
        },
      },
      cancellation: {
        userStop: new AbortController(),
        deriveScope() {
          return { controller: new AbortController(), release: noOp };
        },
      },
      resetLiveTranscript: noOp,
      settleLiveTranscript: noOp,
      batchLiveRoundsUpdate: noOp,
      updateToolStatus: noOp,
      updateRetryAttempts: noOp,
      updatePersistableAgentProgress: noOp,
      commitVisibleAbortedConversation: () => false,
      freezeGatewayFinalProjection: noOp,
      async persistConversationWithHistorySync() {
        return true;
      },
    },
  };
}

/**
 * Tool loop. `beforeRound[n]` runs before the nth round's onBeforeNextTurn and is used to simulate
 * "a sub-agent delivered a message in this round".
 *
 * Faithfully simulates agentRunner's runtime state and tail-delivery accumulator; this is the key
 * fidelity point of this test set:
 * - stateMessages corresponds to agent.state.messages and never contains tail blocks;
 * - accumulated corresponds to accumulatedWireTailBlocks: overrides with wireTailText append
 *   (pinned down together with the anchor toolCallId resolved the first time); those without it
 *   (the compaction/re-freeze branch) clear it;
 * - each round's outbound request = stateMessages plus (if anything accumulated) the tail blocks
 *   re-attached to their pinned anchors via attachPinnedTailBlocks, recorded into
 *   harness.outboundRequests for assertions.
 */
function toolRounds(harness, { rounds = 2, beforeRound = {}, anchorOverrides = {} } = {}) {
  return async (params) => {
    let stateMessages = [];
    let emitted = [];
    let accumulated = [];
    const recordOutbound = (round) => {
      const outbound =
        accumulated.length > 0
          ? attachPinnedTailBlocks(stateMessages.slice(), accumulated)
          : stateMessages;
      harness.outboundRequests.push({ round, messages: outbound });
    };
    for (let round = 1; round <= rounds; round += 1) {
      recordOutbound(round);
      const assistant = toolCallAssistant(round);
      const result = toolResult(round, anchorOverrides[round] ?? {});
      params.onTurnStart?.(round);
      params.onToolCall?.(assistant.content[0], round);
      params.onToolResult?.(assistant.content[0], result, round);
      params.onAssistantMessage?.(assistant, round);
      emitted = [...emitted, assistant, result];
      stateMessages = [...stateMessages, assistant, result];

      beforeRound[round]?.();

      const override = await params.onBeforeNextTurn?.({
        round,
        assistant,
        toolResults: [result],
        emittedMessages: emitted,
        runtimeContext: params.context,
        signal: params.signal,
      });
      harness.overrides.push(override ?? null);
      if (override) {
        // applyTurnContextOverride: wireTailText goes only into the accumulator and pins the anchor
        // at this moment; the runtime message list is swapped for the override's message list
        // (without tail blocks).
        if (override.wireTailText) {
          const anchorToolCallId = resolveTailBlockAnchorId(override.context.messages);
          if (anchorToolCallId) {
            accumulated = [...accumulated, { anchorToolCallId, text: override.wireTailText }];
          }
        } else {
          accumulated = [];
        }
        stateMessages = override.context.messages.slice();
        emitted = override.emittedMessages.slice();
      }
    }
    recordOutbound(rounds + 1);
    params.onTurnStart?.(rounds + 1);
    params.onAssistantMessage?.(finalAssistant, rounds + 1);
    return {
      assistant: finalAssistant,
      messages: [...stateMessages, finalAssistant],
      emittedMessages: [...emitted, finalAssistant],
    };
  };
}

function runWithScenario(scenario, params) {
  runAssistantWithToolsScenario = scenario;
  return runAgentConversationTurn(params).finally(() => {
    runAssistantWithToolsScenario = async () => {
      throw new Error("scenario was not installed");
    };
  });
}

function tailTexts(messages) {
  return messages.flatMap((message) =>
    message.role === "toolResult" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "text").map((block) => block.text)
      : [],
  );
}

// ---------------------------------------------------------------------------
// 1. No new messages: no extra content is produced

test("no extra content is produced when no new bus messages arrive during the run", async () => {
  const harness = createHarness({ busMessages: [busMessage(1, "delivered before the run")] });
  await runWithScenario(toolRounds(harness), harness.params);

  assert.deepEqual(
    harness.overrides,
    [null, null],
    "When there are no new messages, onBeforeNextTurn must return null and must not return a continuation context",
  );

  // The snapshot from the start of the run is still in the system section and unchanged throughout.
  const unique = new Set(harness.systemPrompts.map((entry) => entry.systemPrompt));
  assert.equal(unique.size, 1, `systemPrompt drifted during the run: ${[...unique].join("\n---\n")}`);
  assert.match([...unique][0], /## ReactorPro Message Bus/);
  assert.match([...unique][0], /delivered before the run/);

  // The message tail contains no delta blocks.
  for (const entry of harness.requestMessages) {
    assert.ok(
      !tailTexts(entry.messages).some((text) => text.includes("new messages")),
      `${entry.label} contained an unexpected delta block`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. New messages: systemPrompt bytes unchanged, delta delivered that round via wireTailText

test("after a sub-agent delivery systemPrompt bytes are unchanged and the delta is delivered that round via wireTailText", async () => {
  const harness = createHarness({ busMessages: [busMessage(1, "delivered before the run")] });
  await runWithScenario(
    toolRounds(harness, {
      beforeRound: { 1: () => harness.bus.deliver(busMessage(2, "arrived mid run")) },
    }),
    harness.params,
  );

  const unique = new Set(harness.systemPrompts.map((entry) => entry.systemPrompt));
  assert.equal(
    unique.size,
    1,
    `Delta delivery must not rewrite systemPrompt: ${JSON.stringify(harness.systemPrompts, null, 2)}`,
  );
  assert.ok(
    ![...unique][0].includes("arrived mid run"),
    "Messages arriving during the run must not be pushed back into systemPrompt",
  );

  const continuation = harness.overrides[0];
  assert.ok(continuation?.context, "A continuation context must be returned when there are new messages");
  assert.ok(continuation.wireTailText, "The delta must be handed to the runner via wireTailText");
  assert.match(continuation.wireTailText, /^## ReactorPro Message Bus \(new messages\)/);
  assert.match(continuation.wireTailText, /arrived mid run/);
  // The delta goes online only: the override's message list must not contain it, preventing leakage into persistence and memory extraction.
  assert.ok(
    !tailTexts(continuation.context.messages).some((text) => text.includes("arrived mid run")),
    "Delta blocks must not be written into the override's message list",
  );
  assert.equal(
    continuation.context.systemPrompt,
    [...unique][0],
    "The continuation context's systemPrompt must match the frozen value byte for byte",
  );

  // The next round's outbound request must attach this delta, and only once.
  const nextOutbound = harness.outboundRequests.find((entry) => entry.round === 2);
  assert.ok(nextOutbound, "Round 2 must issue an outbound request");
  const attached = tailTexts(nextOutbound.messages).filter((text) =>
    text.includes("arrived mid run"),
  );
  assert.equal(attached.length, 1, "The delta block must be attached to the next round's outbound request, and only once");
});

// ---------------------------------------------------------------------------
// 3. An attached delta is replayed as-is in later rounds (key regression guard)

test("a delivered delta block is replayed as-is in later rounds and not delivered twice", async () => {
  const harness = createHarness({ busMessages: [busMessage(1, "before the run")] });
  await runWithScenario(
    toolRounds(harness, {
      rounds: 3,
      beforeRound: { 1: () => harness.bus.deliver(busMessage(2, "arrived mid run")) },
    }),
    harness.params,
  );

  const roundOne = harness.overrides[0];
  assert.ok(roundOne?.wireTailText, "Round 1 must return the delta via wireTailText");
  const block = roundOne.wireTailText;
  assert.match(block, /arrived mid run/);

  // Rounds 2 and 3 have no new messages -> no override is returned, and the cursor does not re-deliver.
  assert.deepEqual(harness.overrides.slice(1), [null, null]);

  // But the accumulator keeps the delta block on each later round's outbound request, byte-identical and present only once.
  const laterOutbound = harness.outboundRequests.filter((entry) => entry.round >= 2);
  assert.ok(laterOutbound.length >= 3, `expected at least 3 subsequent outbound requests, got ${laterOutbound.length}`);
  for (const entry of laterOutbound) {
    const replayed = tailTexts(entry.messages).filter((text) => text.includes("arrived mid run"));
    assert.equal(replayed.length, 1, `Round ${entry.round}'s delta block must be replayed as-is and must not be attached more than once`);
    assert.equal(replayed[0], block, "The replayed bytes must be exactly identical to the first delivery");
  }

  // Asserting "same content" is not enough: the content stays the same when a block moves to
  // another message, but the message it was attached to in the previous round reverts its bytes,
  // invalidating the whole prefix from that point on. The anchor must be pinned to the same message.
  const anchorOf = (entry) =>
    entry.messages.find(
      (message) =>
        message.role === "toolResult" &&
        Array.isArray(message.content) &&
        message.content.some((item) => item.type === "text" && item.text === block),
    )?.toolCallId;
  const anchors = laterOutbound.map(anchorOf);
  assert.ok(anchors[0], "Round 2 must be able to locate the message carrying the delta block");
  for (const [index, anchor] of anchors.entries()) {
    assert.equal(
      anchor,
      anchors[0],
      `Round ${laterOutbound[index].round}'s delta block moved: the anchor changed from ${anchors[0]} to ${anchor}, ` +
        "so the message it was attached to last round reverts its bytes and the whole prefix from it is invalidated",
    );
  }

  // The same anchor message must be byte-stable across rounds.
  const anchorMessage = (entry) =>
    entry.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === anchors[0],
    );
  const baseline = JSON.stringify(anchorMessage(laterOutbound[0]));
  for (const entry of laterOutbound.slice(1)) {
    assert.equal(
      JSON.stringify(anchorMessage(entry)),
      baseline,
      `Round ${entry.round}'s anchor message bytes differ from the first delivery`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. With no safe anchor the cursor does not advance; retry next round

test("with only a display-image tool result at the tail nothing is delivered; it is topped up next round without losing the message", async () => {
  const harness = createHarness();
  await runWithScenario(
    toolRounds(harness, {
      rounds: 2,
      // Round 1's tool result is display-image: sanitization replaces the content wholesale, so it cannot serve as an anchor.
      anchorOverrides: { 1: { toolName: "Image", details: { kind: "display_image" } } },
      beforeRound: { 1: () => harness.bus.deliver(busMessage(1, "must not be lost")) },
    }),
    harness.params,
  );

  assert.equal(harness.overrides[0], null, "With no safe anchor, no continuation context may be returned");

  const secondRound = harness.overrides[1];
  assert.ok(secondRound?.wireTailText, "Once a safe anchor appears in the next round, it must be topped up via wireTailText");
  assert.match(secondRound.wireTailText, /must not be lost/);
  assert.ok(
    !tailTexts(secondRound.context.messages).some((text) => text.includes("must not be lost")),
    "The topped-up delta likewise goes online only and must not be written into the override's message list",
  );

  // The outbound request after the top-up must attach this message, and only once.
  const finalOutbound = harness.outboundRequests.find((entry) => entry.round === 3);
  assert.ok(finalOutbound, "The round after the top-up must issue an outbound request");
  const attached = tailTexts(finalOutbound.messages).filter((text) =>
    text.includes("must not be lost"),
  );
  assert.equal(attached.length, 1, "The cursor did not advance, so the message is topped up as-is next round");
});

// ---------------------------------------------------------------------------
// 5. Compaction boundary re-freezes the snapshot and cursor

test("after in-run compaction the bus snapshot is re-frozen and the delta is not delivered twice", async () => {
  let compactionsLeft = 1;
  const harness = createHarness({
    compactDuringRun: () =>
      compactionsLeft-- > 0
        ? {
            context: { systemPrompt: BASE_SYSTEM_PROMPT, messages: [] },
            shouldDisableProtection: false,
          }
        : { context: null, shouldDisableProtection: false },
  });

  await runWithScenario(
    toolRounds(harness, {
      rounds: 2,
      beforeRound: { 1: () => harness.bus.deliver(busMessage(1, "arrived before compaction")) },
    }),
    harness.params,
  );

  // Round 1 compaction: the continuation context's systemPrompt must carry the re-frozen snapshot.
  const continuation = harness.overrides[0];
  assert.ok(continuation?.context);
  assert.match(continuation.context.systemPrompt, /## ReactorPro Message Bus/);
  assert.match(continuation.context.systemPrompt, /arrived before compaction/);
  assert.deepEqual(continuation.emittedMessages, [], "The emittedMessages returned by the compaction branch must be emptied");

  // At the start of the run the bus was empty, so the snapshot section did not exist then -- proving the snapshot really was recomputed at the compaction boundary.
  const preSend = harness.systemPrompts.find((entry) => entry.label === "pre-send");
  assert.equal(preSend.systemPrompt, BASE_SYSTEM_PROMPT);

  // The cursor is reset as well: round 2 must not deliver the same message again.
  assert.equal(harness.overrides[1], null, "A message already in the snapshot must not be re-delivered as a delta");
});

// ---------------------------------------------------------------------------
// 6. Read failure during the compaction-boundary re-freeze: the cursor rolls back to the position covered by the snapshot, no message lost

test("when the re-freeze read fails at the compaction boundary the cursor rolls back and the delta is topped up next round", async () => {
  let compactionsLeft = 1;
  const harness = createHarness({
    compactDuringRun: () =>
      compactionsLeft-- > 0
        ? {
            context: { systemPrompt: BASE_SYSTEM_PROMPT, messages: [] },
            shouldDisableProtection: false,
          }
        : { context: null, shouldDisableProtection: false },
  });

  await runWithScenario(
    toolRounds(harness, {
      rounds: 2,
      beforeRound: {
        1: () => {
          harness.bus.deliver(busMessage(1, "must survive the failed refreeze"));
          // Let this round's read that renders the delta pass, so the re-freeze after compaction fails to read.
          harness.bus.failReadAfter(1);
        },
      },
    }),
    harness.params,
  );

  // Precondition: the re-freeze fails -> the snapshot did not pick up this message, and the
  // compaction branch carries no wireTailText, so the runner accumulator is cleared -- the tail
  // delivery holding it disappears.
  const roundOne = harness.overrides[0];
  assert.ok(roundOne?.context, "After round 1's compaction a continuation context must be returned");
  assert.ok(
    !roundOne.context.systemPrompt.includes("must survive the failed refreeze"),
    "On a read failure the snapshot should not pick up this message out of nowhere",
  );
  assert.equal(roundOne.wireTailText, undefined, "The compaction branch must not carry wireTailText");
  assert.deepEqual(roundOne.context.messages, [], "Compaction already truncated the history");

  const roundTwo = harness.overrides[1];
  assert.ok(roundTwo?.wireTailText, "The cursor must roll back to the position covered by the snapshot, and the delta must be topped up next round via wireTailText");
  const occurrences =
    roundTwo.wireTailText.split("must survive the failed refreeze").length - 1;
  assert.equal(occurrences, 1, "The message must be topped up as-is, exactly once");

  // The outbound request after the top-up must attach this message, and only once.
  const finalOutbound = harness.outboundRequests.find((entry) => entry.round === 3);
  assert.ok(finalOutbound, "The round after the top-up must issue an outbound request");
  const attached = tailTexts(finalOutbound.messages).filter((text) =>
    text.includes("must survive the failed refreeze"),
  );
  assert.equal(attached.length, 1, "The topped-up message must be attached to the outbound request, and only once");
});
