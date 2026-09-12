// crates/agent-gui/test/chat/clarify-session.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

// React mock: the hook only uses useRef/useCallback/useSyncExternalStore, all of which can be empty implementations
// (the tests directly test only createClarifySessionCore; the hook part is manually tested by the host).
const reactMock = {
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useEffect: (fn) => (fn(), () => {}),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};
const loader = createTsModuleLoader({ mocks: { react: reactMock } });
const mod = loader.loadModule(
  abs("../agent-ui/src/components/chat/clarify/useClarifySession.ts"),
);

const QUESTIONS =
  "[CLARIFY_QUESTIONS]\n" +
  JSON.stringify({
    questions: [
      { id: "q1", header: "Scope", prompt: "What feature are we building?", options: [{ label: "A" }, { label: "B" }] },
      { id: "q2", prompt: "Target platform?", options: [{ label: "Web" }], allowMultiple: true },
    ],
  });
const FINAL = "[CLARIFY_FINAL]\nOptimized prompt";

const answersFor = (round) =>
  round.questions.map((question, index) => ({
    questionId: question.id,
    prompt: question.prompt,
    selectedLabels: index === 0 ? ["A"] : [],
    ...(index === 0 ? {} : { customText: "free input" }),
  }));

test("happy path: structured questions round then final", async () => {
  const seenInputs = [];
  const runTurn = async (messages, _signal, onDelta) => {
    seenInputs.push(messages);
    if (onDelta) onDelta(QUESTIONS.slice(0, 10));
    return seenInputs.length === 1 ? QUESTIONS : FINAL;
  };
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("Help me write a script");
  const afterStart = session.getState();
  assert.equal(afterStart.status, "awaitingInput");
  assert.equal(afterStart.roundCount, 1);
  assert.equal(afterStart.draftText, "Help me write a script");
  assert.equal(afterStart.rounds.length, 1);
  assert.equal(afterStart.rounds[0].answers, null);
  assert.equal(afterStart.rounds[0].questions.length, 2);
  assert.equal(afterStart.rounds[0].questions[0].options.length, 2);

  await session.submitAnswers(answersFor(afterStart.rounds[0]));
  const done = session.getState();
  assert.equal(done.status, "done");
  assert.deepEqual(finals, ["Optimized prompt"]);
  // Committed rounds settle into read-only answers.
  assert.equal(done.rounds[0].answers.length, 2);
  assert.deepEqual(done.rounds[0].answers[0].selectedLabels, ["A"]);
  // The second-round input should contain system + the first round's original assistant text + the serialized answers message.
  const second = seenInputs[1];
  assert.equal(second[0].role, "system");
  assert.equal(second.filter((m) => m.role === "assistant").length, 1);
  const answersMessage = second.at(-1);
  assert.equal(answersMessage.role, "user");
  assert.ok(answersMessage.content.startsWith("[CLARIFY_ANSWERS]"));
  assert.match(answersMessage.content, /A1: A/);
  assert.match(answersMessage.content, /A2: free input/);
});

test("exceeding max rounds force-injects final instruction", async () => {
  let calls = 0;
  const runTurn = async (messages) => {
    calls += 1;
    if (messages.at(-1).content.includes("CLARIFY_FINAL")) {
      return FINAL; // already the forced-instruction round
    }
    return QUESTIONS;
  };
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("draft");
  for (let i = 0; i < mod.CLARIFY_MAX_ROUNDS; i++) {
    const pending = session.getState().rounds.at(-1);
    await session.submitAnswers(answersFor(pending));
  }
  // Final-round submit: no more questions are allowed through; the answers are sent together with the final-instruction prompt.
  assert.equal(session.getState().status, "done");
  assert.ok(calls <= mod.CLARIFY_MAX_ROUNDS + 1);
});

test("generateNow carries partial answers of the pending round", async () => {
  const seenInputs = [];
  const runTurn = async (messages) => {
    seenInputs.push(messages);
    return messages.at(-1).content.includes("CLARIFY_FINAL") ? FINAL : QUESTIONS;
  };
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("d");
  const pending = session.getState().rounds.at(-1);
  // Only the first question was answered before clicking "Generate directly".
  await session.generateNow([
    { questionId: "q1", prompt: pending.questions[0].prompt, selectedLabels: ["B"] },
    { questionId: "q2", prompt: pending.questions[1].prompt, selectedLabels: [] },
  ]);
  assert.deepEqual(finals, ["Optimized prompt"]);
  const finalTurnInput = seenInputs[1];
  const contents = finalTurnInput.map((m) => m.content);
  // Partial answers are filed first, then the forced final-instruction follows.
  const answersIndex = contents.findIndex((c) => c.startsWith("[CLARIFY_ANSWERS]"));
  assert.ok(answersIndex >= 0);
  assert.match(contents[answersIndex], /A1: B/);
  assert.match(contents[answersIndex], /A2: \(not answered\)/);
  assert.ok(contents.at(-1).includes("CLARIFY_FINAL"));
  // The awaiting-answer round has been settled.
  assert.notEqual(session.getState().rounds.at(-1).answers, null);
});

test("generateNow with no picks skips the noise answers message", async () => {
  const seenInputs = [];
  const runTurn = async (messages) => {
    seenInputs.push(messages);
    return messages.at(-1).content.includes("CLARIFY_FINAL") ? FINAL : QUESTIONS;
  };
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("d");
  await session.generateNow([]);
  assert.equal(session.getState().status, "done");
  const finalTurnInput = seenInputs[1];
  assert.ok(!finalTurnInput.some((m) => m.content.startsWith("[CLARIFY_ANSWERS]")));
});

test("error state keeps messages; retry resends", async () => {
  let fail = true;
  const runTurn = async () => {
    if (fail) throw new Error("boom");
    return FINAL;
  };
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("d");
  assert.equal(session.getState().status, "error");
  assert.match(session.getState().error, /boom/);
  fail = false;
  await session.retry();
  assert.equal(session.getState().status, "done");
  assert.deepEqual(finals, ["Optimized prompt"]);
});

test("unparseable reply degrades to a single open question", async () => {
  const runTurn = async () => "A sentence with no marker";
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("d");
  const state = session.getState();
  assert.equal(state.status, "awaitingInput");
  const round = state.rounds.at(-1);
  assert.equal(round.questions.length, 1);
  assert.equal(round.questions[0].prompt, "A sentence with no marker");
  assert.deepEqual(round.questions[0].options, []);
});

test("close() during in-flight ask leaves state idle and produces no error afterwards", async () => {
  let rejectTurn;
  const runTurn = () =>
    new Promise((_resolve, reject) => {
      rejectTurn = reject;
    });
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  const pending = session.start("d");
  session.close();
  // runTurn rejects with an abort-like error only after close: it must not pollute the already-reset idle state.
  const abortLike = new Error("The operation was aborted");
  abortLike.name = "AbortError";
  rejectTurn(abortLike);
  await pending;
  const s = session.getState();
  assert.equal(s.status, "idle");
  assert.equal(s.error, null);
  assert.deepEqual(s.rounds, []);
  assert.equal(s.roundCount, 0);
  assert.equal(s.draftText, "");
});

test("close() then start() while old ask in flight: stale completion must not corrupt the new session", async () => {
  const pending = [];
  const runTurn = () =>
    new Promise((resolve) => {
      pending.push(resolve);
    });
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  const first = session.start("old");
  session.close();
  const second = session.start("new");
  // An old request returns a round of "questions" late: it must not write into the new session's rounds or change state.
  pending[0](QUESTIONS);
  await first;
  assert.equal(session.getState().status, "asking");
  assert.deepEqual(session.getState().rounds, []);
  assert.equal(session.getState().draftText, "new");
  pending[1](FINAL);
  await second;
  assert.equal(session.getState().status, "done");
  assert.equal(session.getState().finalText, "Optimized prompt");
  assert.deepEqual(finals, ["Optimized prompt"]);
});

test("second start() without close() aborts the first request and discards its stale completion", async () => {
  const pending = [];
  const signals = [];
  const runTurn = (_messages, signal) =>
    new Promise((resolve) => {
      signals.push(signal);
      pending.push(resolve);
    });
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  const first = session.start("old");
  const second = session.start("new");
  // start() must abort the old request's signal rather than letting it run free.
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  pending[0](QUESTIONS); // old request returns late
  await first;
  assert.equal(session.getState().status, "asking");
  assert.deepEqual(session.getState().rounds, []);
  pending[1](FINAL);
  await second;
  assert.equal(session.getState().status, "done");
});

test("subscribe fires on state changes and unsubscribe stops notifications", async () => {
  const runTurn = async () => FINAL;
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  let calls = 0;
  const unsubscribe = session.subscribe(() => {
    calls += 1;
  });
  await session.start("d");
  assert.ok(calls > 0, "subscribe listener should have fired on state changes");
  const afterStart = calls;
  unsubscribe();
  session.close();
  assert.equal(calls, afterStart);
});

test("final turn streams preview text; question turn JSON stays hidden", async () => {
  const snapshots = [];
  let call = 0;
  const runTurn = async (messages, _signal, onDelta) => {
    call += 1;
    if (call === 1) {
      // Question round: JSON fragments must not appear on screen.
      onDelta?.("[CLARIFY_QUESTIONS]");
      onDelta?.('\n{"questions":[');
      return QUESTIONS;
    }
    // Final round: text after the marker streams to screen character by character.
    onDelta?.("[CLARIFY_FIN");
    onDelta?.("AL]\nFinal");
    onDelta?.("Start");
    return FINAL;
  };
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  session.subscribe(() => snapshots.push(session.getState().streamingText));
  await session.start("d");
  assert.ok(
    snapshots.every((text) => !text.includes("{")),
    "question-round JSON must never reach streamingText",
  );
  await session.generateNow([]);
  assert.ok(snapshots.includes("Final"), "final preview should stream after the marker");
  assert.ok(snapshots.includes("FinalStart"), "final preview should accumulate");
  assert.equal(session.getState().streamingText, "", "streamingText cleared after turn end");
});

test("generateNow while a question turn is in flight supersedes the stale turn", async () => {
  const pending = [];
  const deltaCbs = [];
  const runTurn = (_messages, _signal, onDelta) =>
    new Promise((resolve) => {
      deltaCbs.push(onDelta);
      pending.push(resolve);
    });
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  const first = session.start("d");
  const forced = session.generateNow();
  // A late delta and completion result from an old round: neither may pollute the forced final round.
  deltaCbs[0]("[CLARIFY_FINAL]\nold stream");
  deltaCbs[1]("[CLARIFY_FINAL]\nnew stream");
  assert.equal(session.getState().streamingText, "new stream");
  pending[0](QUESTIONS);
  await first;
  assert.equal(session.getState().status, "asking", "stale completion must not flip status");
  assert.equal(session.getState().streamingText, "new stream");
  assert.equal(session.getState().roundCount, 0, "stale question round must not count");
  pending[1](FINAL);
  await forced;
  const s = session.getState();
  assert.equal(s.status, "done");
  assert.deepEqual(s.rounds, [], "stale question round must not be recorded");
  assert.equal(s.streamingText, "");
  assert.deepEqual(finals, ["Optimized prompt"]);
});

test("generateNow and submitAnswers after done are no-ops: no new turn, no second onFinal", async () => {
  let calls = 0;
  const runTurn = async () => {
    calls += 1;
    return FINAL;
  };
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("d");
  assert.equal(session.getState().status, "done");
  await session.generateNow();
  await session.submitAnswers([]);
  assert.equal(calls, 1, "no second runTurn after done");
  assert.deepEqual(finals, ["Optimized prompt"]);
  assert.equal(session.getState().status, "done");
});

test("error turn clears streamingText", async () => {
  const runTurn = async (_messages, _signal, onDelta) => {
    if (onDelta) onDelta("[CLARIFY_FINAL]\npartial output");
    throw new Error("boom");
  };
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("d");
  assert.equal(session.getState().status, "error");
  assert.equal(session.getState().streamingText, "");
});

test("retry() is a no-op when status is not error", async () => {
  let calls = 0;
  const runTurn = async () => {
    calls += 1;
    return QUESTIONS;
  };
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("d");
  assert.equal(session.getState().status, "awaitingInput");
  await session.retry();
  assert.equal(calls, 1, "retry must not resend when not in error state");
  assert.equal(session.getState().status, "awaitingInput");
});

test("throwing onFinal does not clobber the committed done state", async () => {
  const runTurn = async () => FINAL;
  const session = mod.createClarifySessionCore(runTurn, {
    onFinal: () => {
      throw new Error("host callback boom");
    },
  });
  await session.start("d");
  const s = session.getState();
  assert.equal(s.status, "done");
  assert.equal(s.error, null);
});
