import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const approval = loader.loadModule("src/lib/tools/toolApproval.ts");

const {
  requestToolApproval,
  answerToolApproval,
  hasPendingToolApproval,
  getPendingToolApproval,
  getToolApprovalVersion,
  subscribeToolApprovals,
  isSessionApproved,
  cancelPendingToolApprovalsForConversation,
} = approval;

test("approve decision lets the gate through and removes it from the pending table", async () => {
  const promise = requestToolApproval({
    toolCallId: "c1",
    toolName: "Bash",
    conversationId: "conv",
  });
  assert.equal(hasPendingToolApproval("c1"), true);
  const outcome = answerToolApproval("c1", "approve");
  assert.equal(outcome.ok, true);
  const settlement = await promise;
  assert.deepEqual(settlement, { kind: "decided", decision: "approve" });
  assert.equal(hasPendingToolApproval("c1"), false);
});

test("approve_session remembers this tool for the conversation, so isSessionApproved is true afterwards", async () => {
  const promise = requestToolApproval({
    toolCallId: "c2",
    toolName: "Bash",
    conversationId: "conv2",
  });
  answerToolApproval("c2", "approve_session");
  await promise;
  assert.equal(isSessionApproved("conv2", "Bash"), true);
  assert.equal(isSessionApproved("conv2", "Write"), false);
  assert.equal(isSessionApproved("other", "Bash"), false);
});

test("deny decision returns decided/deny", async () => {
  const promise = requestToolApproval({
    toolCallId: "c3",
    toolName: "Delete",
    conversationId: "conv3",
  });
  answerToolApproval("c3", "deny");
  assert.deepEqual(await promise, { kind: "decided", decision: "deny" });
});

test("a timeout settles as timeout", async () => {
  const settlement = await requestToolApproval({
    toolCallId: "c4",
    toolName: "Bash",
    conversationId: "conv4",
    timeoutMs: 10,
  });
  assert.deepEqual(settlement, { kind: "timeout" });
  assert.equal(hasPendingToolApproval("c4"), false);
});

test("an AbortSignal trigger → cancelled; an already-aborted signal cancels immediately", async () => {
  const controller = new AbortController();
  const promise = requestToolApproval({
    toolCallId: "c5",
    toolName: "Bash",
    conversationId: "conv5",
    signal: controller.signal,
  });
  controller.abort();
  assert.deepEqual(await promise, { kind: "cancelled" });

  const pre = new AbortController();
  pre.abort();
  const immediate = await requestToolApproval({
    toolCallId: "c6",
    toolName: "Bash",
    conversationId: "conv6",
    signal: pre.signal,
  });
  assert.deepEqual(immediate, { kind: "cancelled" });
});

test("a cross-conversation answer is rejected; the correct conversation's answer passes", async () => {
  const promise = requestToolApproval({
    toolCallId: "c7",
    toolName: "Bash",
    conversationId: "convA",
  });
  const wrong = answerToolApproval("c7", "approve", { conversationId: "convB" });
  assert.equal(wrong.ok, false);
  assert.equal(hasPendingToolApproval("c7"), true);
  const right = answerToolApproval("c7", "approve", { conversationId: "convA" });
  assert.equal(right.ok, true);
  await promise;
});

test("conversation cancellation: pending approvals settle as cancelled and the session-approval set is cleared", async () => {
  const promise = requestToolApproval({
    toolCallId: "c8",
    toolName: "Bash",
    conversationId: "convX",
  });
  const pending = getPendingToolApproval("c8");
  assert.ok(pending && pending.deadlineAt > Date.now());
  cancelPendingToolApprovalsForConversation("convX");
  assert.deepEqual(await promise, { kind: "cancelled" });
  assert.equal(hasPendingToolApproval("c8"), false);
});

test("the subscription version changes when a pending entry appears/settles", async () => {
  let notified = 0;
  const unsubscribe = subscribeToolApprovals(() => {
    notified += 1;
  });
  const before = getToolApprovalVersion();
  const promise = requestToolApproval({
    toolCallId: "c9",
    toolName: "Bash",
    conversationId: "convV",
  });
  assert.ok(getToolApprovalVersion() > before);
  answerToolApproval("c9", "approve");
  await promise;
  assert.ok(notified >= 2);
  unsubscribe();
});
