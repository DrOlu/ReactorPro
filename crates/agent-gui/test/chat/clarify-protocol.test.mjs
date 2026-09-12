// crates/agent-gui/test/chat/clarify-protocol.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);
const loader = createTsModuleLoader({ mocks: {} });
const protocol = loader.loadModule(
  abs("../agent-ui/src/components/chat/clarify/clarifyProtocol.ts"),
);

const QUESTIONS_JSON = JSON.stringify({
  questions: [
    {
      id: "q1",
      header: "Scope",
      prompt: "What feature should it do?",
      options: [
        { label: "Batch rename", description: "Rename files by rule" },
        { label: "Format conversion", recommended: true },
      ],
    },
    {
      prompt: "Target platform?",
      options: [{ label: "Web" }, { label: "Mobile" }],
      allowMultiple: true,
    },
  ],
});

test("questions marker + JSON parses into normalized questions", () => {
  const r = protocol.parseClarifyTurn(`[CLARIFY_QUESTIONS]\n${QUESTIONS_JSON}`);
  assert.equal(r.kind, "questions");
  assert.equal(r.questions.length, 2);
  assert.equal(r.questions[0].id, "q1");
  assert.equal(r.questions[0].header, "Scope");
  assert.equal(r.questions[0].options.length, 2);
  assert.equal(r.questions[0].options[1].recommended, true);
  // Missing ids are filled in by sequence number; allowMultiple is passed through.
  assert.equal(r.questions[1].id, "q2");
  assert.equal(r.questions[1].allowMultiple, true);
});

test("final marker parses", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_FINAL]\nOptimized prompt body");
  assert.equal(r.kind, "final");
  assert.equal(r.text, "Optimized prompt body");
});

test("fenced JSON without marker still parses as questions", () => {
  const r = protocol.parseClarifyTurn("```json\n" + QUESTIONS_JSON + "\n```");
  assert.equal(r.kind, "questions");
  assert.equal(r.questions.length, 2);
});

test("invalid JSON falls back to a single open question", () => {
  const r = protocol.parseClarifyTurn("Just a plain sentence with no marker");
  assert.equal(r.kind, "questions");
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].prompt, "Just a plain sentence with no marker");
  assert.deepEqual(r.questions[0].options, []);
});

test("normalization drops blank prompts, dedupes ids/labels and enforces caps", () => {
  const payload = {
    questions: [
      { id: "a", prompt: "", options: [] }, // empty prompt dropped
      {
        id: "dup",
        prompt: "Q1",
        options: [
          { label: "x" },
          { label: "x" }, // duplicate label dropped
          { label: "  " }, // empty label dropped
          { label: "1" },
          { label: "2" },
          { label: "3" },
          { label: "4" },
          { label: "5" }, // truncated past the cap
          { label: "6" },
        ],
      },
      { id: "dup", prompt: "Q2", options: [] }, // duplicate id reassigned
      { id: "q3", prompt: "Q3", options: [] },
      { id: "q4", prompt: "Q4", options: [] },
      { id: "q5", prompt: "Q5", options: [] }, // truncated past the per-round cap
    ],
  };
  const questions = protocol.normalizeClarifyQuestions(payload);
  assert.equal(questions.length, protocol.CLARIFY_MAX_QUESTIONS_PER_ROUND);
  assert.equal(questions[0].id, "dup");
  assert.equal(questions[0].options.length, protocol.CLARIFY_MAX_OPTIONS_PER_QUESTION);
  assert.notEqual(questions[1].id, "dup");
});

test("clarifyStreamPreview hides markers and JSON, streams final text", () => {
  // Neither marker fragments nor JSON are shown on screen.
  assert.equal(protocol.clarifyStreamPreview("[CLARIFY_QUE"), "");
  assert.equal(protocol.clarifyStreamPreview("[CLARIFY_QUESTIONS]\n{\"questions\":["), "");
  assert.equal(protocol.clarifyStreamPreview('{"questions":[{"id"'), "");
  assert.equal(protocol.clarifyStreamPreview("```json"), "");
  // Text after the final marker is streamed verbatim.
  assert.equal(protocol.clarifyStreamPreview("[CLARIFY_FINAL]\nstart of final text"), "start of final text");
  // Ordinary text, once ruled out as a possible marker, is displayed as usual (a downgraded open question).
  assert.equal(protocol.clarifyStreamPreview("This is a sufficiently long ordinary question text"), "This is a sufficiently long ordinary question text");
});

test("buildClarifyAnswersMessage serializes picks, custom text and skips", () => {
  const round = {
    questions: [
      { id: "q1", prompt: "What do you want to build?", options: [{ label: "A" }], allowMultiple: true },
      { id: "q2", prompt: "Platform?", options: [{ label: "Web" }] },
      { id: "q3", prompt: "Skipped question", options: [] },
    ],
    answers: [
      { questionId: "q1", prompt: "What do you want to build?", selectedLabels: ["A"], customText: "Also needs undo support" },
      { questionId: "q2", prompt: "Platform?", selectedLabels: ["Web"] },
      { questionId: "q3", prompt: "Skipped question", selectedLabels: [] },
    ],
  };
  const message = protocol.buildClarifyAnswersMessage(round);
  assert.ok(message.startsWith("[CLARIFY_ANSWERS]"));
  assert.match(message, /Q1: What do you want to build\?/);
  assert.match(message, /A1: A; Also needs undo support/);
  assert.match(message, /A2: Web/);
  assert.match(message, /A3: \(not answered\)/);
});

test("system prompt contains protocol markers, caps and workspace context", () => {
  const p = protocol.buildClarifySystemPrompt({ workdir: "/repo/x", gitBranch: "main" });
  assert.match(p, /\[CLARIFY_QUESTIONS\]/);
  assert.match(p, /\[CLARIFY_FINAL\]/);
  assert.match(p, /\[CLARIFY_ANSWERS\]/);
  assert.match(p, /\/repo\/x/);
  assert.match(p, /main/);
  assert.ok(p.includes(`1-${protocol.CLARIFY_MAX_QUESTIONS_PER_ROUND} questions`));
  const bare = protocol.buildClarifySystemPrompt();
  assert.doesNotMatch(bare, /Workspace:/);
});

test("buildClarifyMessages prepends system", () => {
  const msgs = protocol.buildClarifyMessages(
    [{ role: "user", content: "hi" }],
    { workdir: "/w" },
  );
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs.length, 2);
});
