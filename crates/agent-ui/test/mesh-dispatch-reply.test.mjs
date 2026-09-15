// The dispatch-reply coercion for the mesh chat tools (issue #11).
//
// A peer's respond envelope is remote output: every field is defaulted rather
// than trusted, and a reply that carries no identity must not masquerade as one.
import assert from "node:assert/strict";
import { test } from "node:test";

// Direct source import: this is the only in-repo module needed, and the
// runner has no workspace loader (Node 22.18+ strips types by default).
import { normalizeMeshDispatchReply } from "../src/lib/mesh/types.ts";

test("a full respond envelope is coerced into a reply", () => {
  const reply = normalizeMeshDispatchReply({
    v: "1.0",
    type: "respond",
    from: "globex/berlin/edge-1",
    task_id: "task-9",
    payload: { text: "Q3 revenue was up 12%." },
  });
  assert.equal(reply.from, "globex/berlin/edge-1");
  assert.equal(reply.text, "Q3 revenue was up 12%.");
  assert.equal(reply.taskId, "task-9");
  assert.equal(reply.error, undefined);
});

test("a refusal keeps the peer's code and message", () => {
  const reply = normalizeMeshDispatchReply({
    from: "grip-001",
    payload: { text: "" },
    error: { code: 4001, message: "No text in request", retryable: false },
  });
  assert.deepEqual(reply.error, { code: 4001, message: "No text in request" });
  assert.equal(reply.text, "");
});

test("nothing is trusted: a null, a junk payload and wrong types all coerce", () => {
  assert.deepEqual(normalizeMeshDispatchReply(null), { from: "", text: "" });
  assert.deepEqual(normalizeMeshDispatchReply("string"), { from: "", text: "" });
  const numeric = normalizeMeshDispatchReply({
    from: 42,
    task_id: 7,
    payload: { text: { nested: true } },
  });
  assert.equal(numeric.from, "");
  assert.equal(numeric.text, "");
  assert.equal(numeric.taskId, undefined);
});

test("a reply with no sender cannot masquerade as coming from somewhere", () => {
  const reply = normalizeMeshDispatchReply({ payload: { text: "hello" } });
  assert.equal(reply.from, "");
  assert.equal(reply.text, "hello");
});
