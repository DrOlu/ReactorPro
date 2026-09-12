import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadModules() {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  return {
    shared: loader.loadModule("@liveagent/ui/lib/chat/askUserQuestion.ts"),
    tools: loader.loadModule("src/lib/tools/askUserQuestionTools.ts"),
  };
}

function buildQuestionsArgs() {
  return {
    questions: [
      {
        id: "storage",
        header: "Storage",
        prompt: "Where should the configuration be stored?",
        options: [
          { label: "App data directory", description: "Does not pollute the workspace", recommended: true },
          { label: "Workspace root directory" },
          { label: "Custom path" },
        ],
      },
      {
        prompt: "Should old data be migrated?",
        options: [{ label: "Migrate" }, { label: "Do not migrate", recommended: true }, { label: "Decide later" }],
      },
    ],
  };
}

function createToolCall(argumentsValue, id = "call-ask-1") {
  return { type: "toolCall", id, name: "AskUserQuestion", arguments: argumentsValue };
}

test("AskUserQuestion schema accepts well-formed questions", () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const tool = bundle.tools.find((candidate) => candidate.name === "AskUserQuestion");
  assert.ok(tool);

  const args = validateToolArguments(tool, createToolCall(buildQuestionsArgs()));
  assert.equal(args.questions.length, 2);
});

test("parseAskUserQuestionItems enforces limits, ids, and single recommendation", () => {
  const { shared } = loadModules();

  assert.throws(() => shared.parseAskUserQuestionItems([]), /non-empty/);
  assert.throws(
    () =>
      shared.parseAskUserQuestionItems(
        Array.from({ length: 5 }, (_, index) => ({
          prompt: `q${index}`,
          options: [{ label: "a" }, { label: "b" }],
        })),
      ),
    /at most 4 questions/,
  );
  assert.throws(() => shared.parseAskUserQuestionItems(undefined), /non-empty/);
  assert.throws(
    () => shared.parseAskUserQuestionItems([{ prompt: "Only one option?", options: [{ label: "a" }] }]),
    /needs 2-6 options/,
  );
  assert.throws(
    () =>
      shared.parseAskUserQuestionItems([
        {
          prompt: "Too many options?",
          options: Array.from({ length: 7 }, (_, index) => ({ label: `o${index}` })),
        },
      ]),
    /needs 2-6 options/,
  );
  assert.throws(
    () =>
      shared.parseAskUserQuestionItems([
        {
          prompt: "Duplicate recommendation",
          options: [
            { label: "a", recommended: true },
            { label: "b", recommended: true },
          ],
        },
      ]),
    /at most one option as recommended/,
  );
  assert.throws(
    () =>
      shared.parseAskUserQuestionItems([
        { prompt: "Duplicate label", options: [{ label: "same" }, { label: "same" }] },
      ]),
    /duplicate option label/,
  );
  assert.throws(
    () =>
      shared.parseAskUserQuestionItems([
        { id: "dup", prompt: "One", options: [{ label: "a" }, { label: "b" }] },
        { id: "dup", prompt: "Two", options: [{ label: "a" }, { label: "b" }] },
      ]),
    /duplicate question id/,
  );

  // The number of options per question may differ within a round: the card renders only one question at a time, and its height already varies with prompt and
  // description changes; forcing alignment buys no layout stability and only needlessly rejects valid questions.
  const mixed = shared.parseAskUserQuestionItems([
    { prompt: "Three options", options: [{ label: "a" }, { label: "b" }, { label: "c" }] },
    { prompt: "Two options", options: [{ label: "x" }, { label: "y" }] },
  ]);
  assert.deepEqual(
    mixed.map((question) => question.options.length),
    [3, 2],
  );

  const parsed = shared.parseAskUserQuestionItems(buildQuestionsArgs().questions);
  assert.deepEqual(
    parsed.map((question) => question.id),
    ["storage", "q2"],
  );
  assert.equal(parsed[0].options[0].recommended, true);
  // The recommended option is always placed first; the rest keep their original order.
  assert.deepEqual(
    parsed[1].options.map((option) => option.label),
    ["Do not migrate", "Migrate", "Decide later"],
  );
  assert.equal(parsed[1].options[0].recommended, true);
});

test("buildDefaultAskUserQuestionAnswers picks the recommended (or first) option", () => {
  const { shared } = loadModules();
  const questions = shared.parseAskUserQuestionItems([
    {
      prompt: "Has recommended option",
      options: [{ label: "a" }, { label: "b", recommended: true }],
    },
    {
      prompt: "No recommended option",
      options: [{ label: "x" }, { label: "y" }],
    },
  ]);
  const defaults = shared.buildDefaultAskUserQuestionAnswers(questions);
  assert.deepEqual(
    defaults.map((answer) => answer.selectedLabel),
    ["b", "x"],
  );
  assert.match(
    shared.buildAskUserQuestionResultText(defaults, { timedOut: true }),
    /did not answer within the time limit/,
  );
});

test("sanitizeAskUserQuestionItems tolerates streaming partial arguments", () => {
  const { shared } = loadModules();
  assert.deepEqual(shared.sanitizeAskUserQuestionItems(undefined), []);
  assert.deepEqual(shared.sanitizeAskUserQuestionItems([{ prompt: "Missing options" }]), []);

  const partial = shared.sanitizeAskUserQuestionItems([
    { prompt: "Well-formed question", options: [{ label: "Option A", recommended: true }, { label: "" }] },
    { prompt: "", options: [{ label: "x" }] },
  ]);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].id, "q1");
  assert.deepEqual(partial[0].options, [{ label: "Option A", recommended: true }]);
});

test("execute suspends until the user answers, then returns the selections", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const toolCall = createToolCall(buildQuestionsArgs(), "call-ask-answer");

  const resultPromise = bundle.executeToolCall(toolCall);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-answer"), true);

  // An invalid response (missing the second question) does not settle and does not clear the pending state.
  const invalid = tools.answerAskUserQuestion("call-ask-answer", [
    { questionId: "storage", selectedLabel: "App data directory" },
  ]);
  assert.equal(invalid.ok, false);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-answer"), true);

  // Options must come from the question definition.
  const wrongLabel = tools.answerAskUserQuestion("call-ask-answer", [
    { questionId: "storage", selectedLabel: "Nonexistent option" },
    { questionId: "q2", selectedLabel: "Migrate" },
  ]);
  assert.equal(wrongLabel.ok, false);

  // Submitting each question's non-recommended, non-first option out of order still aligns the result with the question definition; this also ensures the timeout
  // default answer cannot mask the user's real choice.
  const accepted = tools.answerAskUserQuestion("call-ask-answer", [
    { questionId: "q2", selectedLabel: "Decide later" },
    { questionId: "storage", selectedLabel: "Workspace root directory" },
  ]);
  assert.equal(accepted.ok, true);

  const result = await resultPromise;
  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "ask_user_question");
  assert.deepEqual(
    result.details.answers.map((answer) => answer.selectedLabel),
    ["Workspace root directory", "Decide later"],
  );
  assert.equal("timedOut" in result.details, false);
  assert.match(result.content[0].text, /proceed accordingly/);
  assert.match(result.content[0].text, /Workspace root directory/);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-answer"), false);

  // A settled question cannot be answered again.
  const late = tools.answerAskUserQuestion("call-ask-answer", []);
  assert.equal(late.ok, false);
});

test("timeout auto-selects the recommended options and continues", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1", timeoutMs: 50 });
  const toolCall = createToolCall(buildQuestionsArgs(), "call-ask-timeout");

  const result = await bundle.executeToolCall(toolCall);
  assert.equal(result.isError, false);
  assert.equal(result.details.timedOut, true);
  assert.deepEqual(
    result.details.answers.map((answer) => answer.selectedLabel),
    ["App data directory", "Do not migrate"],
  );
  assert.match(result.content[0].text, /did not answer within the time limit/);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-timeout"), false);

  // It cannot be answered again after a timeout settles it.
  const late = tools.answerAskUserQuestion("call-ask-timeout", [
    { questionId: "storage", selectedLabel: "Workspace root directory" },
    { questionId: "q2", selectedLabel: "Migrate" },
  ]);
  assert.equal(late.ok, false);
});

test("timeout falls back to the first option when no recommendation exists", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1", timeoutMs: 25 });
  const result = await bundle.executeToolCall(
    createToolCall(
      {
        questions: [
          {
            id: "plain",
            prompt: "No recommendation",
            options: [{ label: "First" }, { label: "Second" }],
          },
        ],
      },
      "call-ask-first-fallback",
    ),
  );

  assert.equal(result.details.timedOut, true);
  assert.deepEqual(
    result.details.answers.map((answer) => answer.selectedLabel),
    ["First"],
  );
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-first-fallback"), false);
});

test("immediate answers are pending synchronously and never fall through to timeout defaults", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-fast", timeoutMs: 100 });

  for (let index = 0; index < 20; index += 1) {
    const toolCallId = `call-ask-fast-${index}`;
    const resultPromise = bundle.executeToolCall(createToolCall(buildQuestionsArgs(), toolCallId));
    assert.equal(tools.hasPendingAskUserQuestion(toolCallId), true);

    const accepted = tools.answerAskUserQuestion(toolCallId, [
      { questionId: "storage", selectedLabel: "Workspace root directory" },
      { questionId: "q2", selectedLabel: "Decide later" },
    ]);
    assert.deepEqual(accepted, { ok: true });

    const result = await resultPromise;
    assert.equal("timedOut" in result.details, false);
    assert.deepEqual(
      result.details.answers.map((answer) => answer.selectedLabel),
      ["Workspace root directory", "Decide later"],
    );
  }
});

test("an answer accepted before the deadline is not overwritten when the old timeout passes", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1", timeoutMs: 35 });
  const toolCallId = "call-ask-before-deadline";
  const resultPromise = bundle.executeToolCall(createToolCall(buildQuestionsArgs(), toolCallId));

  const accepted = tools.answerAskUserQuestion(toolCallId, [
    { questionId: "storage", selectedLabel: "Workspace root directory" },
    { questionId: "q2", selectedLabel: "Decide later" },
  ]);
  assert.equal(accepted.ok, true);
  const result = await resultPromise;

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal("timedOut" in result.details, false);
  assert.deepEqual(
    result.details.answers.map((answer) => answer.selectedLabel),
    ["Workspace root directory", "Decide later"],
  );
  assert.equal(tools.hasPendingAskUserQuestion(toolCallId), false);
  assert.equal(tools.answerAskUserQuestion(toolCallId, []).ok, false);
});

test("abort settles a pending question as cancelled", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const controller = new AbortController();
  const toolCall = createToolCall(buildQuestionsArgs(), "call-ask-abort");

  const resultPromise = bundle.executeToolCall(toolCall, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();

  const result = await resultPromise;
  assert.equal(result.isError, true);
  assert.equal(result.details.cancelled, true);
  assert.deepEqual(result.details.answers, []);
  assert.match(result.content[0].text, /stopped the turn/);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-abort"), false);
  assert.equal(tools.getAskUserQuestionDeadlineAt("call-ask-abort"), null);
  assert.equal(
    tools.answerAskUserQuestion("call-ask-abort", [
      { questionId: "storage", selectedLabel: "Workspace root directory" },
      { questionId: "q2", selectedLabel: "Migrate" },
    ]).ok,
    false,
  );
});

test("conversation disposal cancels its pending questions only", async () => {
  const { tools } = loadModules();
  const bundleA = tools.createAskUserQuestionTools({ conversationId: "conv-a" });
  const bundleB = tools.createAskUserQuestionTools({ conversationId: "conv-b" });

  const promiseA = bundleA.executeToolCall(createToolCall(buildQuestionsArgs(), "call-ask-a"));
  const promiseB = bundleB.executeToolCall(createToolCall(buildQuestionsArgs(), "call-ask-b"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  tools.cancelPendingAskUserQuestionsForConversation("conv-a");
  const resultA = await promiseA;
  assert.equal(resultA.details.cancelled, true);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-b"), true);

  const accepted = tools.answerAskUserQuestion("call-ask-b", [
    { questionId: "storage", selectedLabel: "Workspace root directory" },
    { questionId: "q2", selectedLabel: "Migrate" },
  ]);
  assert.equal(accepted.ok, true);
  const resultB = await promiseB;
  assert.equal(resultB.isError, false);
});

test("pending questions are observable per conversation for the sidebar badge", async () => {
  const { tools } = loadModules();
  const bundleA = tools.createAskUserQuestionTools({ conversationId: "conv-a" });
  const bundleB = tools.createAskUserQuestionTools({ conversationId: "conv-b" });

  let notifiedA = 0;
  let notifiedB = 0;
  const unsubscribeA = tools.subscribeAskUserQuestionsForConversation("conv-a", () => {
    notifiedA += 1;
  });
  const unsubscribeB = tools.subscribeAskUserQuestionsForConversation("conv-b", () => {
    notifiedB += 1;
  });

  assert.deepEqual(tools.getPendingAskUserQuestionsSnapshot("conv-a"), []);
  // The empty snapshot must be a stable reference: useSyncExternalStore tears
  // if the same state yields a fresh array each read.
  assert.equal(
    tools.getPendingAskUserQuestionsSnapshot("conv-a"),
    tools.getPendingAskUserQuestionsSnapshot("conv-b"),
  );

  const promiseA = bundleA.executeToolCall(createToolCall(buildQuestionsArgs(), "call-obs-a"));
  const promiseB = bundleB.executeToolCall(createToolCall(buildQuestionsArgs(), "call-obs-b"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Registering emits, and each conversation only sees its own question.
  assert.equal(notifiedA, 1);
  assert.equal(notifiedB, 1);
  const snapshotA = tools.getPendingAskUserQuestionsSnapshot("conv-a");
  assert.equal(snapshotA.length, 1);
  assert.equal(snapshotA[0].toolCallId, "call-obs-a");
  assert.equal(typeof snapshotA[0].deadlineAt, "number");
  // Cached until the next change, so a re-render reads the same array.
  assert.equal(tools.getPendingAskUserQuestionsSnapshot("conv-a"), snapshotA);

  // Answering emits and clears — this is what drops the badge.
  tools.answerAskUserQuestion("call-obs-a", [
    { questionId: "storage", selectedLabel: "Workspace root directory" },
    { questionId: "q2", selectedLabel: "Migrate" },
  ]);
  await promiseA;
  assert.equal(notifiedA, 2);
  assert.deepEqual(tools.getPendingAskUserQuestionsSnapshot("conv-a"), []);
  assert.equal(notifiedB, 1, "settling one conversation must not notify another");

  // Conversation teardown emits too.
  tools.cancelPendingAskUserQuestionsForConversation("conv-b");
  await promiseB;
  assert.equal(notifiedB > 1, true);
  assert.deepEqual(tools.getPendingAskUserQuestionsSnapshot("conv-b"), []);

  unsubscribeA();
  unsubscribeB();
});

test("invalid arguments fail fast with a validation error result", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const missing = await bundle.executeToolCall(createToolCall({}, "call-ask-missing"));
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /non-empty `questions` array/);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-missing"), false);

  const result = await bundle.executeToolCall(
    createToolCall({ questions: [{ prompt: "Insufficient options", options: [{ label: "Only" }] }] }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /needs 2-6 options/);
  assert.deepEqual(result.details, {});
});

test("result details round-trip through the transcript parser", () => {
  const { shared } = loadModules();
  const questions = shared.parseAskUserQuestionItems(buildQuestionsArgs().questions);
  const answers = shared.resolveAskUserQuestionAnswers(questions, [
    { questionId: "storage", selectedLabel: "App data directory" },
    { questionId: "q2", selectedLabel: "Do not migrate" },
  ]);
  assert.ok(answers);

  const parsed = shared.parseAskUserQuestionResultDetails({
    kind: "ask_user_question",
    questions,
    answers,
  });
  assert.ok(parsed);
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.answers.length, 2);
  assert.equal(parsed.cancelled, false);

  assert.equal(shared.parseAskUserQuestionResultDetails({ kind: "task_list" }), null);
  assert.equal(shared.parseAskUserQuestionResultDetails(null), null);
});

test("remote answers are rejected when the conversation does not match", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-owner" });
  const resultPromise = bundle.executeToolCall(createToolCall(buildQuestionsArgs(), "call-ask-conv"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const answers = [
    { questionId: "storage", selectedLabel: "App data directory" },
    { questionId: "q2", selectedLabel: "Do not migrate" },
  ];
  // A response carrying session context (the WebUI tool_answer channel) must hit the session that owns the pending question.
  const mismatch = tools.answerAskUserQuestion("call-ask-conv", answers, {
    conversationId: "conv-other",
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.message, /different conversation/);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-conv"), true);

  const accepted = tools.answerAskUserQuestion("call-ask-conv", answers, {
    conversationId: "conv-owner",
  });
  assert.equal(accepted.ok, true);
  const result = await resultPromise;
  assert.equal(result.isError, false);
});

test("gateway deadline stamp is preset once and adopted by execute", async () => {
  const { shared, tools } = loadModules();

  // Gateway parameter reporting precedes execute: the first ensure presets it, after which it idempotently returns the same value.
  const preset = tools.ensureAskUserQuestionDeadlineAt("call-ask-deadline");
  assert.ok(preset > Date.now());
  assert.equal(tools.ensureAskUserQuestionDeadlineAt("call-ask-deadline"), preset);
  assert.equal(tools.getAskUserQuestionDeadlineAt("call-ask-deadline"), preset);

  // After execute suspends, the same preset value is reused as the authoritative deadline (it does not restart the clock).
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const resultPromise = bundle.executeToolCall(
    createToolCall(buildQuestionsArgs(), "call-ask-deadline"),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tools.getAskUserQuestionDeadlineAt("call-ask-deadline"), preset);
  assert.equal(tools.ensureAskUserQuestionDeadlineAt("call-ask-deadline"), preset);

  tools.answerAskUserQuestion("call-ask-deadline", [
    { questionId: "storage", selectedLabel: "App data directory" },
    { questionId: "q2", selectedLabel: "Do not migrate" },
  ]);
  await resultPromise;
  // Cleanup after settling; reads fall back to null (the card is read-only by then and needs no countdown).
  assert.equal(tools.getAskUserQuestionDeadlineAt("call-ask-deadline"), null);

  // The reader stamped on the parameter: valid numbers pass through; missing/invalid returns null.
  const stamped = { questions: [], [shared.ASK_USER_QUESTION_DEADLINE_ARG]: preset };
  assert.equal(shared.readAskUserQuestionDeadlineAt(stamped), preset);
  assert.equal(shared.readAskUserQuestionDeadlineAt({ questions: [] }), null);
  assert.equal(
    shared.readAskUserQuestionDeadlineAt({ [shared.ASK_USER_QUESTION_DEADLINE_ARG]: "soon" }),
    null,
  );
  assert.equal(shared.readAskUserQuestionDeadlineAt(null), null);
});

test("injected test timeout overrides a preset deadline", async () => {
  const { tools } = loadModules();
  // Preset a deadline 3 minutes out; an injected timeoutMs must ignore it, avoiding a hung test.
  tools.ensureAskUserQuestionDeadlineAt("call-ask-timeout-preset");
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1", timeoutMs: 50 });
  const result = await bundle.executeToolCall(
    createToolCall(buildQuestionsArgs(), "call-ask-timeout-preset"),
  );
  assert.equal(result.details.timedOut, true);
});

test("custom answers bypass option membership and are marked in the result", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const resultPromise = bundle.executeToolCall(createToolCall(buildQuestionsArgs(), "call-ask-custom"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Empty custom text counts as unanswered and does not settle.
  const emptyCustom = tools.answerAskUserQuestion("call-ask-custom", [
    { questionId: "storage", selectedLabel: "   ", custom: true },
    { questionId: "q2", selectedLabel: "Do not migrate" },
  ]);
  assert.equal(emptyCustom.ok, false);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-custom"), true);

  // An out-of-scope label without custom is still rejected (the custom channel does not loosen this).
  const wrongLabel = tools.answerAskUserQuestion("call-ask-custom", [
    { questionId: "storage", selectedLabel: "Freestyle" },
    { questionId: "q2", selectedLabel: "Do not migrate" },
  ]);
  assert.equal(wrongLabel.ok, false);

  // Mixed response: one question picks a list item, another uses free input.
  const accepted = tools.answerAskUserQuestion("call-ask-custom", [
    { questionId: "storage", selectedLabel: "App data directory" },
    { questionId: "q2", selectedLabel: "Try migrating the last 30 days of data first", custom: true },
  ]);
  assert.equal(accepted.ok, true);

  const result = await resultPromise;
  assert.equal(result.isError, false);
  assert.deepEqual(
    result.details.answers.map((answer) => answer.custom === true),
    [false, true],
  );
  assert.equal(result.details.answers[1].selectedLabel, "Try migrating the last 30 days of data first");
  // A list-item response does not write the custom key (the serialized shape matches the old version).
  assert.equal("custom" in result.details.answers[0], false);
  assert.match(result.content[0].text, /Try migrating the last 30 days of data first/);
  assert.match(result.content[0].text, /user-typed answer via "Other"/);
});

test("resolveAskUserQuestionAnswers truncates over-length custom text", () => {
  const { shared } = loadModules();
  const questions = shared.parseAskUserQuestionItems(buildQuestionsArgs().questions);
  const longText = "x".repeat(shared.ASK_USER_QUESTION_CUSTOM_MAX_LENGTH + 100);
  const answers = shared.resolveAskUserQuestionAnswers(questions, [
    { questionId: "storage", selectedLabel: longText, custom: true },
    { questionId: "q2", selectedLabel: "Do not migrate" },
  ]);
  assert.ok(answers);
  assert.equal(answers[0].selectedLabel.length, shared.ASK_USER_QUESTION_CUSTOM_MAX_LENGTH);
  assert.equal(answers[0].custom, true);
});

test("custom flag round-trips through the transcript parser", () => {
  const { shared } = loadModules();
  const questions = shared.parseAskUserQuestionItems(buildQuestionsArgs().questions);
  const parsed = shared.parseAskUserQuestionResultDetails({
    kind: "ask_user_question",
    questions,
    answers: [
      { questionId: "storage", prompt: "Where should the configuration be stored?", selectedLabel: "App data directory" },
      { questionId: "q2", prompt: "Should old data be migrated?", selectedLabel: "I'll write my own", custom: true },
    ],
  });
  assert.ok(parsed);
  assert.equal("custom" in parsed.answers[0], false);
  assert.equal(parsed.answers[1].custom, true);
});
