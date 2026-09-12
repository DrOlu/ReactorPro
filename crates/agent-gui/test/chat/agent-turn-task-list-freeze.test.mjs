import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The authoritative taskList JSON is concatenated into systemPrompt, and systemPrompt precedes all messages, while
// the cache prefix matches byte by byte -- re-reading meta.taskList every round within a run means a single
// TaskUpdate punches through the system block and all history after it. The snapshot is therefore frozen per
// "compaction epoch". These cases watch for:
//   1. task state progress within a run does not change systemPrompt bytes (and the snapshot is not silently dropped)
//   2. it is still not injected when runId does not match (following the tool layer's rule, semantics must not change)
//   3. after compaction the snapshot refreshes to the current state (the prefix is rebuilt at that moment anyway, so re-freezing is free)

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

// formatTaskListRuntimeContext stays as the real implementation: what is frozen is its output bytes, so mocking it would test nothing.
let runAssistantWithToolsScenario = async () => {
  throw new Error("scenario was not installed");
};
const registryBuildCalls = [];

const loader = createTsModuleLoader({
  mocks: {
    [agentRunnerPath]: {
      async runAssistantWithTools(params) {
        return runAssistantWithToolsScenario(params);
      },
    },
    [builtinRegistryPath]: {
      async buildBuiltinToolRegistry(params) {
        registryBuildCalls.push(params);
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
      // buildToolsSuffix (the usage-ring fixed calibration at turn runner start) reaches these three
      // pure functions; a whole-module replacement stub must fill them in, or the turn throws on entry.
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
const { formatTaskListRuntimeContext } = loader.loadModule("src/lib/tools/taskTools.ts");

const RUN_ID = "run-1";
const BASE_SYSTEM_PROMPT = "base system prompt";

function noOp() {}

function task(id, subject, status) {
  return {
    id,
    subject,
    description: `${subject} completion criteria`,
    activeForm: `${subject} in progress`,
    status,
  };
}

function taskListState(runId, tasks) {
  return { runId, revision: tasks.length, nextTaskId: tasks.length + 1, tasks };
}

const PENDING_TASKS = taskListState(RUN_ID, [task("1", "Wire the freeze", "pending")]);
const ADVANCED_TASKS = taskListState(RUN_ID, [
  task("1", "Wire the freeze", "completed"),
  task("2", "Cover it with tests", "in_progress"),
]);

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

const taskUpdateAssistant = assistantMessage(
  [{ type: "toolCall", id: "call-task-update", name: "TaskUpdate", arguments: { taskId: "1" } }],
  "toolUse",
);
const taskUpdateResult = {
  role: "toolResult",
  toolCallId: "call-task-update",
  toolName: "TaskUpdate",
  content: [{ type: "text", text: "task updated" }],
  details: {},
  isError: false,
  timestamp: 3,
};
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

/**
 * Capture every systemPrompt actually fed to the model / used for compaction decisions. The three capture points
 * cover all of withAgentRuntimeContext's outputs: pre-send budget, per-round request, and in-run compaction budget.
 */
function createHarness({ initialTaskList, compactDuringRun } = {}) {
  let current = conversationState.createConversationStateFromContext({
    systemPrompt: BASE_SYSTEM_PROMPT,
    messages: [],
  });
  if (initialTaskList) {
    current = conversationState.setTaskListState(current, initialTaskList);
  }

  const systemPrompts = [];
  const record = (label, context) => {
    if (context) systemPrompts.push({ label, systemPrompt: context.systemPrompt });
    return context;
  };

  return {
    systemPrompts,
    // The continuation context returned by onBeforeNextTurn; non-null only when compaction happens.
    overrides: [],
    // Simulates TaskUpdate being persisted: taskStateStore.commitState ultimately goes through applyConversationState.
    commitTaskList(taskList) {
      current = conversationState.setTaskListState(current, taskList);
    },
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
      getMcpSettings: () => ({ servers: [], selected: [] }),
      sessionId: "session-1",
      taskStateStore: {
        runId: RUN_ID,
        getState: () => current.meta.taskList,
        async commitState() {},
      },
      conversationId: "conversation-task-freeze",
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

/** Three tool rounds: advance the task state once before each round ends, simulating the model repeatedly calling TaskUpdate. */
function threeToolRounds(harness, nextTaskListByRound) {
  return async (params) => {
    for (const round of [1, 2]) {
      params.onTurnStart?.(round);
      params.onToolCall?.(taskUpdateAssistant.content[0], round);
      params.onToolResult?.(taskUpdateAssistant.content[0], taskUpdateResult, round);
      params.onAssistantMessage?.(taskUpdateAssistant, round);
      const nextTaskList = nextTaskListByRound[round];
      if (nextTaskList) harness.commitTaskList(nextTaskList);
      harness.overrides.push(
        await params.onBeforeNextTurn?.({
          round,
          assistant: taskUpdateAssistant,
          toolResults: [taskUpdateResult],
          emittedMessages: [taskUpdateAssistant, taskUpdateResult],
          runtimeContext: params.context,
          signal: params.signal,
        }),
      );
    }
    params.onTurnStart?.(3);
    params.onAssistantMessage?.(finalAssistant, 3);
    return {
      assistant: finalAssistant,
      messages: [finalAssistant],
      emittedMessages: [finalAssistant],
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

// ---------------------------------------------------------------------------
// 1. Task state progress within a run must not change systemPrompt bytes

test("consecutive TaskUpdate rounds within a run do not change systemPrompt bytes", async () => {
  const harness = createHarness({ initialTaskList: PENDING_TASKS });
  await runWithScenario(
    threeToolRounds(harness, { 1: ADVANCED_TASKS, 2: taskListState(RUN_ID, []) }),
    harness.params,
  );

  const captured = harness.systemPrompts;
  assert.ok(captured.length >= 3, `expected at least 3 captures, got ${captured.length}`);
  const unique = new Set(captured.map((entry) => entry.systemPrompt));
  assert.equal(
    unique.size,
    1,
    `systemPrompt drifted within the run: ${JSON.stringify(captured, null, 2)}`,
  );

  // What is frozen is the snapshot from the start of the run, and it must be preserved verbatim in the system section -- not silently dropped.
  const frozen = [...unique][0];
  assert.equal(
    frozen,
    `${BASE_SYSTEM_PROMPT}\n\n${formatTaskListRuntimeContext(PENDING_TASKS)}`,
  );
  assert.match(frozen, /<task_list>/);
  assert.ok(!frozen.includes("Cover it with tests"), "tasks created within the run must not squeeze into the system section");
});

// ---------------------------------------------------------------------------
// 2. The runId predicate must be preserved as-is: freezing only moves the predicate from "executed every round" to "executed at freeze time"

test("taskList belonging to a previous Run is not injected", async () => {
  const harness = createHarness({
    initialTaskList: taskListState("run-stale", [task("1", "Stale task", "pending")]),
  });
  await runWithScenario(threeToolRounds(harness, {}), harness.params);

  assert.ok(harness.systemPrompts.length >= 3);
  for (const entry of harness.systemPrompts) {
    assert.equal(entry.systemPrompt, BASE_SYSTEM_PROMPT, `${entry.label} injected task state from another Run`);
  }
});

test("systemPrompt carries no task section when there is no task state", async () => {
  const harness = createHarness();
  await runWithScenario(threeToolRounds(harness, {}), harness.params);

  assert.ok(harness.systemPrompts.length >= 3);
  for (const entry of harness.systemPrompts) {
    assert.equal(entry.systemPrompt, BASE_SYSTEM_PROMPT);
  }
});

// ---------------------------------------------------------------------------
// 3. Re-freeze at the compaction boundary: once history is truncated, this snapshot is the model's only authoritative source of task state

test("the snapshot refreshes to the current task state after in-run compaction", async () => {
  let compactionsLeft = 1;
  const harness = createHarness({
    initialTaskList: PENDING_TASKS,
    compactDuringRun: () =>
      compactionsLeft-- > 0
        ? {
            context: { systemPrompt: BASE_SYSTEM_PROMPT, messages: [] },
            shouldDisableProtection: false,
          }
        : { context: null, shouldDisableProtection: false },
  });

  await runWithScenario(threeToolRounds(harness, { 1: ADVANCED_TASKS }), harness.params);

  // Compaction is triggered on round 1; the continuation context must carry the refreshed snapshot.
  const continuation = harness.overrides[0];
  assert.ok(continuation?.context, "a continuation context must be returned when compaction returns a context");
  assert.equal(
    continuation.context.systemPrompt,
    `${BASE_SYSTEM_PROMPT}\n\n${formatTaskListRuntimeContext(ADVANCED_TASKS)}`,
  );
  assert.match(continuation.context.systemPrompt, /Cover it with tests/);

  // What was captured before compaction is still the old snapshot: re-freezing happens only at the compaction boundary, not every round.
  const beforeCompaction = harness.systemPrompts.filter((entry) => entry.label !== "during-run");
  assert.equal(
    beforeCompaction[0].systemPrompt,
    `${BASE_SYSTEM_PROMPT}\n\n${formatTaskListRuntimeContext(PENDING_TASKS)}`,
  );
});

test("the main Agent turn passes each command safety mode to the tool registry", async () => {
  const cases = [
    ["sandbox", { enabled: true, allowNetwork: true }],
    ["sandboxOffline", { enabled: true, allowNetwork: false }],
    ["ask", undefined],
    ["auto", undefined],
    [undefined, undefined],
  ];

  registryBuildCalls.length = 0;
  for (const [commandSafetyMode, expectedSandbox] of cases) {
    const harness = createHarness();
    harness.params.commandSafetyMode = commandSafetyMode;
    await runWithScenario(
      async (params) => {
        params.onTurnStart?.(1);
        params.onAssistantMessage?.(finalAssistant, 1);
        return {
          assistant: finalAssistant,
          messages: [finalAssistant],
          emittedMessages: [finalAssistant],
        };
      },
      harness.params,
    );
    const call = registryBuildCalls.at(-1);
    assert.ok(call, `registry was not built for mode ${commandSafetyMode ?? "undefined"}`);
    assert.deepEqual(call.sandbox, expectedSandbox, `sandbox mapping for ${commandSafetyMode}`);
  }
});
