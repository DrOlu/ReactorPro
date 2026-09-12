import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The subagent roster used to pack identity fields (id/name/role) and run state
// (status/mode/last_task/last_summary) into the same line stuffed into
// systemPrompt. As soon as a subagent run's status advanced, the whole reminder
// changed, systemPrompt became unstable, and the system block was invalidated
// along with all the history after it.
// After the split: the stable section stays in systemPrompt; the volatile section
// is merged with bus increments into a single wireTailText segment, delivered only
// with the outbound request and never written into agent state messages
// (otherwise it would leak through emittedMessages into persistence / UI / memory
// extraction).
// This group of cases focuses on the wiring layer:
//   1. The volatile section (including mode) must not appear in systemPrompt, and
//      systemPrompt bytes stay constant within a run.
//   2. Rounds whose state is unchanged produce no additional content
//      (onBeforeNextTurn returns null).
//   3. When state advances, it is delivered that round as wireTailText, and
//      override.context.messages contains no tail text.
//   4. It merges with bus increments into one wireTailText segment, not separate
//      deliveries.

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

// roster.ts keeps its real implementation: what gets frozen/delivered is exactly its output bytes.
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
      // buildToolsSuffix (the usage-ring fixed calibration at the start of the
      // turn runner) reaches these three pure functions, so the whole-module
      // replacement stub must supply them or the turn throws the moment it enters.
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

const RUN_ID = "run-roster";
const BASE_SYSTEM_PROMPT = "base system prompt";

function noOp() {}

function identity(agentId, overrides = {}) {
  return {
    parentConversationId: "conversation-roster",
    agentId,
    name: overrides.name ?? `Agent ${agentId}`,
    role: overrides.role ?? "R",
    identityPrompt: "",
    lastMode: overrides.lastMode ?? "readonly",
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 2,
  };
}

function run(agentId, overrides = {}) {
  return {
    id: `run-${agentId}`,
    agentId,
    status: overrides.status ?? "running",
    prompt: overrides.prompt ?? `task for ${agentId}`,
    summary: overrides.summary,
  };
}

function busMessage(seq, bodyMarkdown) {
  return {
    id: seq,
    parentConversationId: "conversation-roster",
    seq,
    senderId: "agent-a",
    recipientId: "parent",
    channel: "direct",
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

function toolResult(round) {
  return {
    role: "toolResult",
    toolCallId: `call-${round}`,
    toolName: "Read",
    content: [{ type: "text", text: `result ${round}` }],
    details: {},
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

/** Mutable roster + bus storage: cases advance run state between rounds to simulate subagent activity. */
function createSubagentStore({ identities = [], runs = [], busMessages = [] } = {}) {
  let identityList = [...identities];
  let runList = [...runs];
  let messages = [...busMessages];
  return {
    advanceRun(summary) {
      runList = runList.map((entry) =>
        entry.agentId === summary.agentId ? summary : entry,
      );
      if (!runList.some((entry) => entry.agentId === summary.agentId)) {
        runList = [...runList, summary];
      }
      // Advancing a run bumps the identity's updatedAt, changing listIdentities()' order.
      identityList = [...identityList]
        .map((entry) =>
          entry.agentId === summary.agentId ? { ...entry, updatedAt: entry.updatedAt + 100 } : entry,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    deliverBus(...next) {
      messages = [...messages, ...next];
    },
    store: {
      async ready() {},
      // The real implementation returns in reverse updatedAt order.
      listIdentities: () => [...identityList].sort((a, b) => b.updatedAt - a.updatedAt),
      latestRunsByAgent: () => new Map(runList.map((entry) => [entry.agentId, entry])),
      async listBusMessages() {
        return messages.map((message) => ({ ...message }));
      },
    },
  };
}

function createHarness(subagents) {
  let current = conversationState.createConversationStateFromContext({
    systemPrompt: BASE_SYSTEM_PROMPT,
    messages: [],
  });

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
    subagents,
    systemPrompts,
    requestMessages,
    overrides: [],
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
      subagentStore: subagents.store,
      getMcpSettings: () => ({ servers: [], selected: [] }),
      sessionId: "session-1",
      taskStateStore: {
        runId: RUN_ID,
        getState: () => current.meta.taskList,
        async commitState() {},
      },
      conversationId: "conversation-roster",
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
          return { context: null, shouldDisableProtection: false };
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

/** Tool loop. `beforeRound[n]` runs before onBeforeNextTurn of round n. */
function toolRounds(harness, { rounds = 2, beforeRound = {} } = {}) {
  return async (params) => {
    let emitted = [];
    for (let round = 1; round <= rounds; round += 1) {
      const assistant = toolCallAssistant(round);
      const result = toolResult(round);
      params.onTurnStart?.(round);
      params.onToolCall?.(assistant.content[0], round);
      params.onToolResult?.(assistant.content[0], result, round);
      params.onAssistantMessage?.(assistant, round);
      emitted = [...emitted, assistant, result];

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
        emitted = override.emittedMessages.length === 0 ? [] : override.context.messages.slice();
      }
    }
    params.onTurnStart?.(rounds + 1);
    params.onAssistantMessage?.(finalAssistant, rounds + 1);
    return {
      assistant: finalAssistant,
      messages: [finalAssistant],
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

/** Returns the text blocks appended to the anchor tool results (the original `result N` blocks do not count). */
function appendedBlocks(messages) {
  return messages.flatMap((message) =>
    message.role === "toolResult" && Array.isArray(message.content)
      ? message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .filter((text) => !/^result \d+$/.test(text))
      : [],
  );
}

function uniqueSystemPrompt(harness) {
  const unique = new Set(harness.systemPrompts.map((entry) => entry.systemPrompt));
  assert.equal(
    unique.size,
    1,
    `systemPrompt drifted within the run: ${[...unique].join("\n---\n")}`,
  );
  return [...unique][0];
}

// ---------------------------------------------------------------------------
// 1 + 2: the stable section goes into systemPrompt; rounds with unchanged state produce no extra content

test("identity section goes into systemPrompt while run state does not; unchanged rounds produce no extra content", async () => {
  const subagents = createSubagentStore({
    identities: [identity("agent-b", { updatedAt: 20 }), identity("agent-a", { updatedAt: 10 })],
    runs: [run("agent-a", { status: "running", prompt: "audit the parser" })],
  });
  const harness = createHarness(subagents);
  await runWithScenario(toolRounds(harness, { rounds: 3 }), harness.params);

  const systemPrompt = uniqueSystemPrompt(harness);
  assert.match(systemPrompt, /Existing delegated agents in this parent conversation:/);
  // listIdentities() returns reverse updatedAt order (agent-b first), but systemPrompt must be in id order.
  assert.ok(systemPrompt.indexOf("id=agent-a") < systemPrompt.indexOf("id=agent-b"));
  assert.doesNotMatch(systemPrompt, /status=/);
  assert.doesNotMatch(systemPrompt, /last_task=/);
  assert.doesNotMatch(systemPrompt, /audit the parser/);
  // mode changes with every Agent call and is a volatile field, so it must not enter the stable section.
  assert.doesNotMatch(systemPrompt, /mode=/);

  // Round 1 delivers the run state first (at run start the tail has no anchor yet, so there was nowhere to attach it before).
  const first = harness.overrides[0];
  assert.ok(first?.wireTailText, "round 1 must hand the run state to the runner as wireTailText");
  assert.match(first.wireTailText, /^Latest run state of the delegated agents/);
  assert.match(
    first.wireTailText,
    /- id=agent-a status=running mode=readonly last_task=audit the parser/,
  );
  // Tail text is delivered only with the outbound request: it must not be written
  // into override.context.messages, or it would leak through emittedMessages into
  // persistence / UI / memory extraction.
  assert.deepEqual(appendedBlocks(first.context.messages), []);

  // Rounds 2 and 3 have unchanged state → not a single byte may be added.
  assert.deepEqual(
    harness.overrides.slice(1),
    [null, null],
    "rounds with unchanged content must return null and produce no extra content",
  );
});

// ---------------------------------------------------------------------------
// 3: state advancement is delivered that round, and systemPrompt bytes are unchanged

test("run-state advancement is delivered that round while systemPrompt bytes stay unchanged", async () => {
  const subagents = createSubagentStore({
    identities: [identity("agent-a", { updatedAt: 10 })],
    runs: [run("agent-a", { status: "running" })],
  });
  const harness = createHarness(subagents);
  await runWithScenario(
    toolRounds(harness, {
      rounds: 3,
      beforeRound: {
        2: () =>
          subagents.advanceRun(
            run("agent-a", { status: "completed", summary: "found three issues" }),
          ),
      },
    }),
    harness.params,
  );

  const systemPrompt = uniqueSystemPrompt(harness);
  assert.ok(
    !systemPrompt.includes("found three issues"),
    "state advanced within the run must not be stuffed back into systemPrompt",
  );

  assert.match(harness.overrides[0].wireTailText, /status=running/);

  const second = harness.overrides[1];
  assert.ok(second?.wireTailText, "the round where state advances must deliver it that round");
  assert.match(second.wireTailText, /status=completed .*last_summary=found three issues/);
  // Each override carries only this round's increment; the runner handles
  // cumulative re-attachment across requests, and agent state messages never
  // contain the tail text.
  assert.deepEqual(appendedBlocks(second.context.messages), []);

  assert.equal(harness.overrides[2], null, "rounds unchanged after an advance must not be delivered again");
});

// ---------------------------------------------------------------------------
// 4: merges with bus increments into the same block

test("within one round the bus increment and run state merge into a single tail block", async () => {
  const subagents = createSubagentStore({
    identities: [identity("agent-a")],
    runs: [run("agent-a", { status: "running" })],
  });
  const harness = createHarness(subagents);
  await runWithScenario(
    toolRounds(harness, {
      rounds: 1,
      beforeRound: { 1: () => subagents.deliverBus(busMessage(1, "report is ready")) },
    }),
    harness.params,
  );

  const first = harness.overrides[0];
  assert.ok(first?.wireTailText);
  assert.match(first.wireTailText, /^## ReactorPro Message Bus \(new messages\)/);
  assert.match(first.wireTailText, /report is ready/);
  assert.match(first.wireTailText, /Latest run state of the delegated agents/);
  assert.match(first.wireTailText, /- id=agent-a status=running/);
  // The two merge into the same wireTailText segment (one tail block per
  // segment) and do not fall into agent state messages.
  assert.deepEqual(appendedBlocks(first.context.messages), []);
});
