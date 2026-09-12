import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const controllerModule = loader.loadModule("src/lib/chat/compaction/controller.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const cancellationModule = loader.loadModule("src/lib/chat/conversation/turnCancellation.ts");

const { CompactionController, createCompactionControllerRegistry } = controllerModule;

const VALID_SUMMARY_XML = `<summary>
<task>Fix src/app.ts</task>
<state>Work on src/app.ts continues ${"detail ".repeat(60)}</state>
<artifacts>
- [file] src/app.ts | modified
</artifacts>
<next_steps>
1. keep going
</next_steps>
</summary>`;

function usage(totalTokens) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function user(content, timestamp = 1) {
  return { role: "user", content, timestamp };
}

function assistantWithUsage(text, totalTokens, timestamp = 2) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-real",
    stopReason: "stop",
    usage: usage(totalTokens),
    timestamp,
  };
}

function toolResultBig(chars, timestamp = 3) {
  return {
    role: "toolResult",
    toolCallId: "tc-big",
    toolName: "Read",
    content: [{ type: "text", text: "x".repeat(chars) }],
    isError: false,
    timestamp,
  };
}

function summaryResponse() {
  return {
    role: "assistant",
    content: [{ type: "text", text: VALID_SUMMARY_XML }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-real",
    stopReason: "stop",
    usage: usage(5000),
    timestamp: 1234,
    responseId: "resp-1",
  };
}

// Three user messages bypass the MIN_COMPACTION_USER_MESSAGES cooldown window,
// easing consecutive-compaction scenarios.
function bigState(extraMessages = []) {
  return conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      user("continue with src/app.ts", 2),
      user("check src/app.ts again", 3),
      assistantWithUsage("working on src/app.ts", 190_000, 4),
      ...extraMessages,
    ],
  });
}

function createSinksRecorder() {
  const events = [];
  return {
    events,
    byKind(kind) {
      return events.filter((event) => event[0] === kind);
    },
    sinks: {
      applyState: (state) => events.push(["applyState", state]),
      applyStateMidRun: (state) => events.push(["applyStateMidRun", state]),
      publishStatus: (status) => events.push(["publishStatus", status]),
      setBridgeToolStatus: (text, isCompaction) => events.push(["bridge", text, isCompaction]),
      queueCheckpoint: (state, contextUsageTokens) =>
        events.push(["queueCheckpoint", state, contextUsageTokens]),
      persist: async (state) => {
        events.push(["persist", state]);
        return true;
      },
      restoreComposer: (text, uploads) => events.push(["restoreComposer", text, uploads]),
      persistRollback: async (state) => {
        events.push(["persistRollback", state]);
        return true;
      },
    },
  };
}

function bindController(controller, overrides = {}) {
  const cancellation = cancellationModule.createTurnCancellation();
  const recorder = createSinksRecorder();
  controller.bindTurn({
    providerId: "anthropic",
    model: "claude-x",
    runtime: {
      baseUrl: "https://example",
      apiKey: "k",
      modelConfig: { contextWindow: 200_000, maxOutputToken: 32_000 },
    },
    cancellation,
    sinks: recorder.sinks,
    buildPreparedContext: (state, _tools, options) =>
      conversationState.buildRequestContext(state, options),
    buildResumeContext: (state, resumeMessage, _tools, options) => {
      const context = conversationState.buildRequestContext(state, options);
      return resumeMessage
        ? { ...context, messages: [...context.messages, resumeMessage] }
        : context;
    },
    ...overrides,
  });
  return { cancellation, recorder };
}

test("pre-send compaction: checkpoint, persist, re-appended user message, paired status", async () => {
  const controller = new CompactionController();
  const baseState = bigState();
  const pendingUserMessage = user("next question", 9);
  let completeCalls = 0;
  const { recorder } = bindController(controller, {
    complete: async () => {
      completeCalls += 1;
      return summaryResponse();
    },
    presend: {
      baseState,
      pendingUserText: "next question",
      composerText: "next question",
      uploadedFiles: [],
      composeAppliedState: (state) =>
        conversationState.appendMessagesToConversation(state, [pendingUserMessage]),
    },
  });

  const applied = await controller.maybeCompactPreSend({
    budgetContext: conversationState.buildRequestContext(baseState),
  });

  assert.equal(applied, true);
  assert.equal(completeCalls, 1);

  const statuses = recorder.byKind("publishStatus").map(([, status]) => status.phase);
  assert.deepEqual(statuses, ["running", "completed"]);

  // What is persisted is the checkpoint state (new segment, no pending message);
  // what is applied is the state with the user message restored.
  const [, persistedState] = recorder.byKind("persist")[0];
  assert.equal(persistedState.segments.length, 2);
  assert.equal(persistedState.segments[1].messages.length, 0);
  const [, appliedState] = recorder.byKind("applyState")[0];
  assert.equal(appliedState.segments[1].messages.length, 1);
  assert.equal(appliedState.segments[1].messages[0].content, "next question");

  assert.equal(recorder.byKind("queueCheckpoint").length, 1);

  // Bridge states come in pairs: isCompaction=true while running, cleared to null
  // after it ends.
  const bridgeEvents = recorder.byKind("bridge");
  assert.match(bridgeEvents[0][1], /compacting history/);
  assert.equal(bridgeEvents[0][2], true);
  assert.equal(bridgeEvents.at(-1)[1], null);
});

test("below-threshold decisions are side-effect free", async () => {
  const controller = new CompactionController();
  const smallState = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [user("hi"), assistantWithUsage("hello", 1000)],
  });
  let completeCalls = 0;
  const { recorder } = bindController(controller, {
    complete: async () => {
      completeCalls += 1;
      return summaryResponse();
    },
    presend: {
      baseState: smallState,
      pendingUserText: "next",
      composeAppliedState: (state) => state,
    },
  });

  const applied = await controller.maybeCompactPreSend({
    budgetContext: conversationState.buildRequestContext(smallState),
  });
  const midRun = await controller.compactDuringRun({
    trigger: "post-tool",
    state: smallState,
  });

  assert.equal(applied, false);
  assert.equal(midRun.context, null);
  assert.equal(completeCalls, 0);
  assert.equal(recorder.events.length, 0);
});

test("single-flight: a concurrent trigger is rejected while a compaction is in flight", async () => {
  const controller = new CompactionController();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let completeCalls = 0;
  bindController(controller, {
    complete: async () => {
      completeCalls += 1;
      await gate;
      return summaryResponse();
    },
  });

  const state = bigState();
  const first = controller.compactDuringRun({ trigger: "post-tool", state });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.shouldProtectMidStream(1_000_000), false);
  const second = await controller.compactDuringRun({ trigger: "post-tool", state });
  assert.equal(second.context, null);

  release();
  const firstContext = await first;
  assert.ok(firstContext.context);
  assert.equal(completeCalls, 1);
});

test("user stop chains into the summarizer; handleTurnAbort rolls back and persists", async () => {
  const controller = new CompactionController();
  const observed = [];
  controller.setObserver({
    onStart: (info) => observed.push(["start", info]),
    onEnd: (info) => observed.push(["end", info]),
  });
  const state = bigState();
  const { cancellation, recorder } = bindController(controller, {
    complete: (params) =>
      new Promise((_, reject) => {
        params.signal?.addEventListener("abort", () => {
          const error = new Error("aborted by user");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  const pending = controller.compactDuringRun({ trigger: "mid-stream", state });
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.userStop.abort();
  await assert.rejects(pending, /aborted/);

  const rolledBack = await controller.handleTurnAbort();
  assert.equal(rolledBack, true);

  const [, restoredState] = recorder.byKind("applyStateMidRun")[0];
  assert.equal(restoredState, state);
  // A mid-run rollback must re-persist (the old persistOnRollback semantics).
  assert.equal(recorder.byKind("persistRollback").length, 1);
  const statuses = recorder.byKind("publishStatus").map(([, status]) => status.phase);
  assert.deepEqual(statuses, ["running", "idle"]);
  // After rollback the bridge state is cleared and isCompaction is not left
  // dangling.
  assert.equal(recorder.byKind("bridge").at(-1)[1], null);
  assert.equal(observed.length, 2);
  assert.equal(observed[0][0], "start");
  assert.equal(observed[0][1].trigger, "mid-stream");
  assert.equal(observed[1][0], "end");
  assert.equal(observed[1][1].trigger, "mid-stream");
  assert.equal(observed[1][1].status, "aborted");
  assert.equal(observed[1][1].tokensBefore, observed[0][1].tokensBefore);
  assert.equal(observed[1][1].tokensAfter, undefined);

  // Both the snapshot and the observation range have been consumed; another call
  // will not re-emit a terminal state.
  assert.equal(await controller.handleTurnAbort(), false);
  assert.equal(observed.length, 2);
});

test("unbindTurn closes an active compaction observer exactly once", async () => {
  const controller = new CompactionController();
  const observed = [];
  controller.setObserver({
    onStart: (info) => observed.push(["start", info]),
    onEnd: (info) => observed.push(["end", info]),
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  bindController(controller, {
    complete: async () => {
      await gate;
      return summaryResponse();
    },
  });
  const pending = controller.compactDuringRun({ trigger: "post-tool", state: bigState() });
  await new Promise((resolve) => setImmediate(resolve));
  controller.unbindTurn();
  assert.equal(observed.at(-1)[1].status, "aborted");
  assert.equal(observed.filter(([kind]) => kind === "end").length, 1);
  release();
  await assert.rejects(pending, /abort/i);
  assert.equal(observed.filter(([kind]) => kind === "end").length, 1);
});

test("a late result cannot settle a newer compaction with the same trigger", async () => {
  const controller = new CompactionController();
  const observed = [];
  controller.setObserver({
    onStart: (info) => observed.push(["start", info]),
    onEnd: (info) => observed.push(["end", info]),
  });

  let releaseOld;
  const oldGate = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const oldBinding = bindController(controller, {
    complete: async () => {
      await oldGate;
      return summaryResponse();
    },
  });
  const oldPending = controller.compactDuringRun({ trigger: "post-tool", state: bigState() });
  await new Promise((resolve) => setImmediate(resolve));
  controller.unbindTurn();

  let releaseNew;
  const newGate = new Promise((resolve) => {
    releaseNew = resolve;
  });
  const newBinding = bindController(controller, {
    complete: async () => {
      await newGate;
      return summaryResponse("new summary");
    },
  });
  const newPending = controller.compactDuringRun({ trigger: "post-tool", state: bigState() });
  await new Promise((resolve) => setImmediate(resolve));

  releaseOld();
  await assert.rejects(oldPending, /abort/i);
  assert.equal(oldBinding.recorder.byKind("persist").length, 0);
  assert.equal(observed.at(-1)[0], "start");

  releaseNew();
  const result = await newPending;
  assert.equal(result.outcome, "compacted");
  assert.equal(newBinding.recorder.byKind("persist").length, 1);
  assert.deepEqual(
    observed.map(([kind, info]) => [kind, info.status ?? info.trigger]),
    [
      ["start", "post-tool"],
      ["end", "aborted"],
      ["start", "post-tool"],
      ["end", "complete"],
    ],
  );
});

test("summarizer failure degrades to prune and still returns a usable context", async () => {
  const controller = new CompactionController();
  // A large tool output (200k chars ~ 50k tokens > the 40k protection budget) can
  // only be pruned if it precedes the "last 2 user turns".
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      toolResultBig(200_000, 2),
      user("continue with src/app.ts", 3),
      user("check src/app.ts again", 4),
      assistantWithUsage("working on src/app.ts", 190_000, 5),
    ],
  });
  const { recorder } = bindController(controller, {
    complete: async () => {
      throw new Error("invalid api key");
    },
  });

  const context = await controller.compactDuringRun({ trigger: "post-tool", state });

  assert.ok(context.context);
  const [, prunedState] = recorder.byKind("applyStateMidRun")[0];
  const prunedMessages = prunedState.segments[0].messages.filter(
    (message) =>
      message.role === "toolResult" &&
      message.content?.[0]?.text === "[output pruned to preserve context budget]",
  );
  assert.equal(prunedMessages.length, 1);

  const failedStatus = recorder
    .byKind("publishStatus")
    .map(([, status]) => status)
    .find((status) => status.phase === "failed");
  assert.match(failedStatus.message, /prune degradation/);
  assert.equal(recorder.byKind("bridge").at(-1)[1], null);
});

test("mid-stream compaction failure returns a safe continuation and disables protection", async () => {
  const controller = new CompactionController();
  const abortedAssistant = {
    ...assistantWithUsage("working on src/app.ts", 190_000, 4),
    stopReason: "aborted",
  };
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      user("continue with src/app.ts", 2),
      user("check src/app.ts again", 3),
      abortedAssistant,
    ],
  });
  bindController(controller, {
    complete: async () => {
      throw new Error("invalid api key");
    },
  });

  const result = await controller.compactDuringRun({
    trigger: "mid-stream",
    state,
    includeAbortedMessages: true,
  });

  assert.ok(result.context);
  assert.equal(result.shouldDisableProtection, true);
  assert.equal(
    result.context.messages.some(
      (message) => message.role === "assistant" && message.stopReason === "aborted",
    ),
    false,
  );
  assert.equal(result.context.messages.at(-1)?.role, "user");
  assert.equal(
    result.context.messages.at(-1)?.content,
    conversationState.INTERNAL_RESUME_MESSAGE_TEXT,
  );
});

test("mid-stream prune fallback also returns a safe continuation", async () => {
  const controller = new CompactionController();
  const abortedAssistant = {
    ...assistantWithUsage("working on src/app.ts", 190_000, 5),
    stopReason: "aborted",
  };
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      toolResultBig(200_000, 2),
      user("continue with src/app.ts", 3),
      user("check src/app.ts again", 4),
      abortedAssistant,
    ],
  });
  const { recorder } = bindController(controller, {
    complete: async () => {
      throw new Error("invalid api key");
    },
  });

  const result = await controller.compactDuringRun({
    trigger: "mid-stream",
    state,
    includeAbortedMessages: true,
  });

  assert.ok(result.context);
  assert.equal(result.shouldDisableProtection, false);
  assert.equal(
    result.context.messages.some(
      (message) => message.role === "assistant" && message.stopReason === "aborted",
    ),
    false,
  );
  assert.equal(result.context.messages.at(-1)?.role, "user");
  assert.equal(
    result.context.messages.at(-1)?.content,
    conversationState.INTERNAL_RESUME_MESSAGE_TEXT,
  );
  assert.equal(recorder.byKind("applyStateMidRun").length, 1);
});

test("escalation ladder: consecutive ineffective compactions advise but never hard-refuse", async () => {
  const controller = new CompactionController();
  let completeCalls = 0;
  const { recorder } = bindController(controller, {
    complete: async () => {
      completeCalls += 1;
      return summaryResponse();
    },
    // The post-compaction recovery context is still huge -> judged inefficient
    // compaction, pushing the pressure escalation.
    buildResumeContext: () => ({
      systemPrompt: "sys",
      messages: [assistantWithUsage("still huge", 190_000, 99)],
    }),
  });

  for (let round = 1; round <= 3; round += 1) {
    const context = await controller.compactDuringRun({
      trigger: "post-tool",
      state: bigState(),
    });
    assert.ok(context.context, `compaction round ${round} must not be refused`);
  }

  assert.equal(completeCalls, 3);
  assert.equal(controller.stats.compactionsApplied, 3);

  const runningTexts = recorder
    .byKind("bridge")
    .filter(([, , isCompaction]) => isCompaction === true)
    .map(([, text]) => text);
  assert.equal(runningTexts.length, 3);
  assert.doesNotMatch(runningTexts[0], /starting a new conversation soon/);
  // After two consecutive inefficient compactions the ladder tops out; the third
  // gives an advisory notice but still performs compaction.
  assert.match(runningTexts[2], /starting a new conversation soon/);
});

test("two consecutive compaction checkpoints preserve the exact authoritative task state", async () => {
  const controller = new CompactionController();
  const { recorder } = bindController(controller, {
    complete: async () => summaryResponse(),
  });
  const taskList = {
    runId: "run-through-two-compactions",
    revision: 5,
    nextTaskId: 3,
    tasks: [
      {
        id: "1",
        subject: "Inspect compaction",
        description: "Verify task state survives every checkpoint",
        activeForm: "Inspecting compaction",
        status: "completed",
      },
      {
        id: "2",
        subject: "Finish implementation",
        description: "Keep working on the same stable task",
        activeForm: "Finishing implementation",
        status: "in_progress",
      },
    ],
  };
  const initialState = conversationState.setTaskListState(bigState(), taskList);

  const first = await controller.compactDuringRun({
    trigger: "post-tool",
    state: initialState,
  });
  assert.ok(first.context);
  const firstCheckpointState = recorder.byKind("applyStateMidRun").at(-1)[1];
  assert.deepEqual(firstCheckpointState.meta.taskList, taskList);

  const secondInput = conversationState.appendMessagesToConversation(firstCheckpointState, [
    user("continue task 2", 20),
    user("keep the same task ids", 21),
    user("verify state again", 22),
    assistantWithUsage("continuing the same task", 190_000, 23),
  ]);
  const second = await controller.compactDuringRun({
    trigger: "post-tool",
    state: secondInput,
  });
  assert.ok(second.context);
  const secondCheckpointState = recorder.byKind("applyStateMidRun").at(-1)[1];

  assert.deepEqual(secondCheckpointState.meta.taskList, taskList);
  assert.deepEqual(secondCheckpointState.meta.taskList, firstCheckpointState.meta.taskList);
});

test("a rejected checkpoint persist never switches runtime state to the unpersisted segment", async () => {
  const controller = new CompactionController();
  const { recorder } = bindController(controller, {
    complete: async () => summaryResponse(),
  });
  recorder.sinks.persist = async (state) => {
    recorder.events.push(["persist", state]);
    return false;
  };

  const result = await controller.compactDuringRun({
    trigger: "post-tool",
    state: bigState(),
  });

  assert.equal(result.context, null);
  assert.equal(result.shouldDisableProtection, false);
  assert.equal(recorder.byKind("persist").length, 1);
  assert.equal(recorder.byKind("queueCheckpoint").length, 0);
  assert.ok(
    recorder
      .byKind("applyStateMidRun")
      .every(([, state]) => state.meta.activeSegmentIndex === 0),
  );
});

test("registry hands out one controller per conversation and disposes cleanly", () => {
  const registry = createCompactionControllerRegistry();
  const a = registry.get("conv-a");
  assert.equal(registry.get("conv-a"), a);
  assert.notEqual(registry.get("conv-b"), a);
  registry.dispose("conv-a");
  assert.notEqual(registry.get("conv-a"), a);
});

test("beginRequest exposes the current total and dynamic fixed-token snapshot", () => {
  const controller = new CompactionController();
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "x".repeat(400),
    messages: [],
  });

  controller.beginRequest(conversationState.buildRequestContext(state), state);

  assert.deepEqual(controller.contextUsageSnapshot, {
    totalTokens: 100,
    fixedTokens: 100,
  });
});

// -- Manual compaction (usage ring entry point) --

function manualBinding(overrides = {}) {
  const cancellation = cancellationModule.createTurnCancellation();
  const recorder = createSinksRecorder();
  return {
    recorder,
    binding: {
      providerId: "anthropic",
      model: "claude-x",
      runtime: {
        baseUrl: "https://example",
        apiKey: "k",
        modelConfig: { contextWindow: 200_000, maxOutputToken: 32_000 },
      },
      cancellation,
      sinks: recorder.sinks,
      complete: async () => summaryResponse(),
      buildPreparedContext: (state, _tools, options) =>
        conversationState.buildRequestContext(state, options),
      buildResumeContext: (state, resumeMessage, _tools, options) => {
        const context = conversationState.buildRequestContext(state, options);
        return resumeMessage
          ? { ...context, messages: [...context.messages, resumeMessage] }
          : context;
      },
      ...overrides,
    },
  };
}

test("compactManually skips below the 50% manual threshold", async () => {
  const controller = new CompactionController();
  // The anchor = pure arithmetic on usage (prompt side + visible output; output
  // is 0 in this case); 99_000 keeps the reading below the 100_000 (50%)
  // threshold.
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      assistantWithUsage("working on src/app.ts", 99_000, 2),
    ],
  });
  const { binding, recorder } = manualBinding();

  const result = await controller.compactManually(binding, state);

  assert.deepEqual(result, { status: "skipped", reason: "below-manual-threshold" });
  assert.equal(recorder.byKind("publishStatus").length, 0);
  assert.equal(recorder.byKind("persist").length, 0);
});

test("compactManually compacts at 50%, bypasses the automatic threshold, and unbinds", async () => {
  const controller = new CompactionController();
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      assistantWithUsage("working on src/app.ts", 100_000, 2),
    ],
  });
  const { binding, recorder } = manualBinding();

  const result = await controller.compactManually(binding, state);

  assert.deepEqual(result, { status: "compacted" });
  const statuses = recorder.byKind("publishStatus").map(([, status]) => status.phase);
  assert.deepEqual(statuses, ["running", "completed"]);
  assert.equal(recorder.byKind("persist").length, 1);
  assert.equal(recorder.byKind("queueCheckpoint").length, 1);
  const [, checkpointState, checkpointTokens] = recorder.byKind("queueCheckpoint")[0];
  assert.equal(
    checkpointState.segments[checkpointState.activeSegmentIndex].summary.summaryMeta.stats
      .contextTokensAfter,
    checkpointTokens,
  );
  assert.ok(checkpointTokens > 0);
  const [, appliedState] = recorder.byKind("applyStateMidRun")[0];
  assert.equal(appliedState.segments.length, 2);
  // Bridge isCompaction=true while running, cleared to null after it ends.
  const bridgeEvents = recorder.byKind("bridge");
  assert.equal(bridgeEvents[0][2], true);
  assert.equal(bridgeEvents.at(-1)[1], null);
  // After unbinding, manual compaction can run again (not stuck as busy by a
  // leftover binding).
  assert.notEqual(
    (await controller.compactManually(manualBinding().binding, bigState())).status,
    "busy",
  );
});

test("compactManually honors the persisted usage snapshot and fixed-token anchor", async () => {
  const controller = new CompactionController();
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      assistantWithUsage("working on src/app.ts", 1_000, 2),
    ],
  });
  const { binding, recorder } = manualBinding();

  const result = await controller.compactManually(binding, state, {
    totalTokens: 100_000,
    fixedTokens: 40_000,
  });

  assert.deepEqual(result, { status: "compacted" });
  const [, checkpointState, checkpointTokens] = recorder.byKind("queueCheckpoint")[0];
  assert.ok(checkpointTokens >= 40_000, "checkpoint keeps the persisted dynamic fixed overhead");
  assert.equal(
    checkpointState.segments[checkpointState.activeSegmentIndex].summary.summaryMeta.stats
      .contextTokensAfter,
    checkpointTokens,
  );
});

// The post-compaction anchorless window (the new segment has no real usage yet):
// the idle ring shows the checkpoint authoritative value, and after sending the
// running ring switches to reading the ledger. Any input drift in the live
// estimate (narrowed active-tool subset, re-frozen memory segment, overhead lost
// on restart) may fall below the checkpoint value -- the ledger must use the
// checkpoint as a fixed lower bound, otherwise the ring first regresses and then
// jumps up when the first real usage arrives.
test("post-compaction beginRequest never dips below the checkpoint anchor", async () => {
  const controller = new CompactionController();
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      assistantWithUsage("working on src/app.ts", 100_000, 2),
    ],
  });
  const { binding, recorder } = manualBinding();
  // A large fixedTokens snapshot raises the checkpoint authoritative value,
  // simulating "checkpoint value > the live estimate of the next send".
  const result = await controller.compactManually(binding, state, {
    totalTokens: 100_000,
    fixedTokens: 40_000,
  });
  assert.deepEqual(result, { status: "compacted" });
  const [, checkpointState, checkpointTokens] = recorder.byKind("queueCheckpoint")[0];
  assert.ok(checkpointTokens >= 40_000);

  // The next send after compaction: the live fixed (sys + summary) is far below
  // the checkpoint value.
  const nextState = conversationState.appendMessagesToConversation(checkpointState, [
    user("do the next thing", 30),
  ]);
  const nextContext = conversationState.buildRequestContext(nextState);
  const total = controller.beginRequest(nextContext, nextState);
  assert.ok(
    total >= checkpointTokens,
    `post-compaction beginRequest total ${total} must not dip below checkpoint ${checkpointTokens}`,
  );

  // Across restart: a brand-new controller (no overhead, no ledger snapshot)
  // recovers the same lower bound from persisted state.
  const freshController = new CompactionController();
  const freshTotal = freshController.beginRequest(nextContext, nextState);
  assert.ok(
    freshTotal >= checkpointTokens,
    `fresh-controller beginRequest total ${freshTotal} must not dip below checkpoint ${checkpointTokens}`,
  );

  // Once a real usage anchor appears, the lower bound retires and the reading
  // returns to anchor arithmetic.
  controller.observeContextMessages([assistantWithUsage("done", 41_000, 31)]);
  assert.equal(controller.contextUsageTokens, 41_000);
});

test("compactManually refuses while a turn is bound or a compaction is in flight", async () => {
  const controller = new CompactionController();
  bindController(controller);
  const { binding } = manualBinding();
  assert.deepEqual(await controller.compactManually(binding, bigState()), { status: "busy" });
});

test("compactManually keeps the disabled hard guard (zero context window)", async () => {
  const controller = new CompactionController();
  let completeCalls = 0;
  const { binding, recorder } = manualBinding({
    runtime: { baseUrl: "https://example", apiKey: "k", modelConfig: undefined },
    complete: async () => {
      completeCalls += 1;
      return summaryResponse();
    },
  });

  const result = await controller.compactManually(binding, bigState());

  assert.deepEqual(result, { status: "skipped", reason: "disabled" });
  assert.equal(completeCalls, 0);
  assert.equal(recorder.byKind("publishStatus").length, 0);
});

test("manual compaction failure never prunes or applies state to an idle conversation", async () => {
  const controller = new CompactionController();
  // A state containing a prunable large tool output: triggering while running
  // follows prune degradation, but manual (idle conversation) must never allow
  // it -- prune results are not persisted, so applying one forks memory from
  // disk.
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      toolResultBig(200_000, 2),
      user("continue with src/app.ts", 3),
      user("check src/app.ts again", 4),
      assistantWithUsage("working on src/app.ts", 190_000, 5),
    ],
  });
  const { binding, recorder } = manualBinding({
    complete: async () => {
      throw new Error("invalid api key");
    },
  });

  const result = await controller.compactManually(binding, state);

  assert.deepEqual(result, { status: "failed" });
  assert.equal(recorder.byKind("applyStateMidRun").length, 0);
  assert.equal(recorder.byKind("applyState").length, 0);
  assert.equal(recorder.byKind("persist").length, 0);
  const statuses = recorder.byKind("publishStatus").map(([, status]) => status.phase);
  assert.deepEqual(statuses, ["running", "failed"]);
  const failedStatus = recorder
    .byKind("publishStatus")
    .map(([, status]) => status)
    .find((status) => status.phase === "failed");
  assert.match(failedStatus.message, /invalid api key/);
  assert.equal(recorder.byKind("bridge").at(-1)[1], null);
});

test("manual compaction skip after a prior completed compaction is not misreported", async () => {
  const controller = new CompactionController();
  // The first successful compaction leaves the controller's statusPhase at
  // completed (a lifecycle field that persists across operations).
  const firstState = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      assistantWithUsage("working on src/app.ts", 150_000, 2),
    ],
  });
  assert.deepEqual(await controller.compactManually(manualBinding().binding, firstState), {
    status: "compacted",
  });

  // The second is below the 50% threshold: the probe refuses. The result must be
  // reported by this call's explicit outcome and must not be misreported as
  // compacted by the leftover completed.
  const secondState = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [user("hi", 1), assistantWithUsage("hello", 42_000, 2)],
  });
  const { binding, recorder } = manualBinding();
  const second = await controller.compactManually(binding, secondState);

  assert.deepEqual(second, { status: "skipped", reason: "below-manual-threshold" });
  assert.equal(recorder.byKind("publishStatus").length, 0);
  assert.equal(recorder.byKind("persist").length, 0);

  // One level deeper: the execution path's own secondary skip decision must also
  // go through the explicit outcome channel -- a decision refusal publishes no
  // state, and the leftover completed must not participate in the result
  // decision.
  const { binding: directBinding } = manualBinding();
  controller.bindTurn(directBinding);
  const direct = await controller.compactDuringRun({
    trigger: "manual",
    state: secondState,
    manualContextUsage: { totalTokens: 1_000 },
  });
  controller.unbindTurn();
  assert.equal(direct.outcome, "skipped");
  assert.equal(direct.reason, "below-manual-threshold");
  assert.equal(direct.context, null);
});

test("a rejected manual probe leaves the shared usage ledger untouched", async () => {
  const controller = new CompactionController();
  const activeState = bigState();
  controller.beginRequest(conversationState.buildRequestContext(activeState), activeState);
  const before = controller.contextUsageTokens;
  assert.ok(before > 0);

  const probeState = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [user("hi", 1), assistantWithUsage("hello", 42_000, 2)],
  });
  const result = await controller.compactManually(manualBinding().binding, probeState);

  assert.equal(result.status, "skipped");
  // The shared ledger is the usage ring's source of truth for readings: a refused
  // probe must leave no residue on it.
  assert.equal(controller.contextUsageTokens, before);
});

test("compactManually threads tools into probe and checkpoint builds and fires onProceed once", async () => {
  const controller = new CompactionController();
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      assistantWithUsage("working on src/app.ts", 150_000, 2),
    ],
  });
  const tools = [{ name: "Read", description: "read files", parameters: {} }];
  const seenTools = [];
  const { binding, recorder } = manualBinding({
    buildPreparedContext: (viewState, builtTools, options) => {
      seenTools.push(builtTools);
      return conversationState.buildRequestContext(viewState, options);
    },
  });
  let proceedCalls = 0;

  const result = await controller.compactManually(binding, state, undefined, {
    tools,
    onProceed: () => {
      proceedCalls += 1;
      // onProceed fires synchronously after the probe passes and before the running
      // status is published.
      assert.equal(recorder.byKind("publishStatus").length, 0);
    },
  });

  assert.deepEqual(result, { status: "compacted" });
  assert.equal(proceedCalls, 1);
  // The probe, budget, and checkpoint builds all receive the same tool set (a
  // checkpoint estimate missing tool weight would be systematically low).
  assert.ok(seenTools.length >= 3);
  assert.ok(seenTools.every((entry) => entry === tools));
});

test("compactManually does not fire onProceed when the probe rejects", async () => {
  const controller = new CompactionController();
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [user("hi", 1), assistantWithUsage("hello", 42_000, 2)],
  });
  let proceedCalls = 0;

  const result = await controller.compactManually(manualBinding().binding, state, undefined, {
    onProceed: () => {
      proceedCalls += 1;
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(proceedCalls, 0);
});

test("compactManually reports aborted=true when the user stops mid-compaction", async () => {
  const controller = new CompactionController();
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "sys",
    messages: [
      user("please fix src/app.ts", 1),
      assistantWithUsage("working on src/app.ts", 150_000, 2),
    ],
  });
  const { binding, recorder } = manualBinding({
    complete: (params) =>
      new Promise((_, reject) => {
        params.signal?.addEventListener("abort", () => {
          const error = new Error("aborted by user");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  const pending = controller.compactManually(binding, state);
  await new Promise((resolve) => setImmediate(resolve));
  binding.cancellation.userStop.abort();
  const result = await pending;

  assert.deepEqual(result, { status: "failed", aborted: true });
  // Unified cleanup: rollback snapshot consumption (re-persist), running reset to
  // idle, bridge cleared.
  const statuses = recorder.byKind("publishStatus").map(([, status]) => status.phase);
  assert.deepEqual(statuses, ["running", "idle"]);
  assert.equal(recorder.byKind("persistRollback").length, 1);
  assert.equal(recorder.byKind("bridge").at(-1)[1], null);
});

// -- revision stamping: when the persist sink returns a persisted state with a
// revision, what lands (apply / queueCheckpoint) must be that stamped state.
// The compaction checkpoint state comes from appendMessagesToConversation
// (revision always null); applying it as-is would make the runtime cache lose
// its CAS token for replace/pagination, and after compaction edit-resend
// reports "history conversation is missing revision".

function stampingPersist(recorder, revision) {
  recorder.sinks.persist = async (state) => {
    recorder.events.push(["persist", state]);
    return {
      ...state,
      transcript: { ...state.transcript, revision },
    };
  };
}

test("during-run compaction applies the revision-stamped state returned by persist", async () => {
  const controller = new CompactionController();
  const { recorder } = bindController(controller, {
    complete: async () => summaryResponse(),
  });
  stampingPersist(recorder, "conv:100:1:2:4");

  const result = await controller.compactDuringRun({
    trigger: "post-tool",
    state: bigState(),
  });

  assert.ok(result.context);
  const [, persistedState] = recorder.byKind("persist")[0];
  assert.equal(persistedState.transcript.revision, null);
  const [, appliedState] = recorder.byKind("applyStateMidRun").at(-1);
  assert.equal(appliedState.transcript.revision, "conv:100:1:2:4");
  const [, checkpointState] = recorder.byKind("queueCheckpoint")[0];
  assert.equal(checkpointState.transcript.revision, "conv:100:1:2:4");
});

test("pre-send compaction re-stamps the revision after composeAppliedState clears it", async () => {
  const controller = new CompactionController();
  const pendingUserMessage = user("next question", 9);
  const baseState = bigState();
  const { recorder } = bindController(controller, {
    complete: async () => summaryResponse(),
    presend: {
      baseState,
      pendingUserText: "next question",
      composeAppliedState: (state) =>
        conversationState.appendMessagesToConversation(state, [pendingUserMessage]),
    },
  });
  stampingPersist(recorder, "conv:200:1:2:4");

  const applied = await controller.maybeCompactPreSend({
    budgetContext: conversationState.buildRequestContext(baseState),
  });

  assert.equal(applied, true);
  const [, appliedState] = recorder.byKind("applyState")[0];
  // compose restored the user message (in-memory append; the DB is still the
  // checkpoint version), and the revision is kept.
  assert.equal(appliedState.segments.at(-1).messages.at(-1).content, "next question");
  assert.equal(appliedState.transcript.revision, "conv:200:1:2:4");
});

test("boolean persist keeps the legacy pass-through contract", async () => {
  const controller = new CompactionController();
  const { recorder } = bindController(controller, {
    complete: async () => summaryResponse(),
  });

  const result = await controller.compactDuringRun({
    trigger: "post-tool",
    state: bigState(),
  });

  assert.ok(result.context);
  const [, persistedState] = recorder.byKind("persist")[0];
  const [, appliedState] = recorder.byKind("applyStateMidRun").at(-1);
  assert.equal(appliedState, persistedState);
});

test("a null persist result aborts the checkpoint like false", async () => {
  const controller = new CompactionController();
  const { recorder } = bindController(controller, {
    complete: async () => summaryResponse(),
  });
  recorder.sinks.persist = async (state) => {
    recorder.events.push(["persist", state]);
    return null;
  };

  const result = await controller.compactDuringRun({
    trigger: "post-tool",
    state: bigState(),
  });

  assert.equal(result.context, null);
  assert.equal(recorder.byKind("queueCheckpoint").length, 0);
  assert.ok(
    recorder
      .byKind("applyStateMidRun")
      .every(([, state]) => state.meta.activeSegmentIndex === 0),
  );
});
