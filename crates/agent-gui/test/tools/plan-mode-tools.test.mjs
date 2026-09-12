import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadModules() {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  return {
    shared: loader.loadModule("@liveagent/ui/lib/chat/planMode.ts"),
    tools: loader.loadModule("src/lib/tools/planModeTools.ts"),
  };
}

const PLAN = "## Goal\n\n1. Change A\n2. Verify B\n";

function createToolCall(argumentsValue, id = "call-plan-1") {
  return { type: "toolCall", id, name: "ExitPlanMode", arguments: argumentsValue };
}

test("ExitPlanMode schema accepts a markdown plan", () => {
  const { tools } = loadModules();
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-1" });
  const tool = bundle.tools.find((candidate) => candidate.name === "ExitPlanMode");
  assert.ok(tool);
  const args = validateToolArguments(tool, createToolCall({ plan: PLAN }));
  assert.equal(args.plan, PLAN);
});

test("shared helpers sanitize plans and resolve decisions", () => {
  const { shared } = loadModules();

  assert.equal(shared.sanitizePlanMarkdown("  x  "), "x");
  assert.equal(shared.sanitizePlanMarkdown(42), "");
  const oversized = "a".repeat(shared.EXIT_PLAN_MODE_PLAN_MAX_LENGTH + 10);
  assert.equal(
    shared.sanitizePlanMarkdown(oversized).length,
    shared.EXIT_PLAN_MODE_PLAN_MAX_LENGTH,
  );

  assert.equal(shared.resolvePlanDecisionAnswer(null), null);
  assert.equal(shared.resolvePlanDecisionAnswer({ decision: "maybe" }), null);
  assert.deepEqual(shared.resolvePlanDecisionAnswer({ decision: "approve" }), {
    decision: "approve",
  });
  assert.deepEqual(shared.resolvePlanDecisionAnswer({ decision: "reject", feedback: " revise it " }), {
    decision: "reject",
    feedback: "revise it",
  });

  // Reading the pending/approved synthetic markers (WebUI argument stamping).
  assert.equal(shared.readPlanPendingMarker({ __exitPlanModePending: true }), true);
  assert.equal(shared.readPlanPendingMarker({}), false);
  assert.equal(shared.readPlanApprovedMarker({ __exitPlanModeApproved: true }), true);

  // details parsing: null when kind/plan are missing.
  assert.equal(shared.parseExitPlanModeResultDetails({ kind: "other", plan: "p" }), null);
  assert.deepEqual(shared.parseExitPlanModeResultDetails({ kind: "exit_plan_mode", plan: "p" }), {
    kind: "exit_plan_mode",
    plan: "p",
  });
});

test("isPlanApprovalMessage accepts pure approval phrases only", () => {
  const { tools } = loadModules();
  for (const yes of ["approve", "  go ahead.", "OK", "ok!", "Go ahead", "lgtm", "do it"]) {
    assert.equal(tools.isPlanApprovalMessage(yes), true, yes);
  }
  for (const no of ["approve, but change step two", "wait a bit first", "save to plan.md then execute", "", "  "]) {
    assert.equal(tools.isPlanApprovalMessage(no), false, no);
  }
});

test("execute rejects an empty plan without registering", async () => {
  const { tools } = loadModules();
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-1" });
  const result = await bundle.executeToolCall(createToolCall({ plan: "   " }, "call-plan-empty"));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /plan is required/);
  assert.equal(tools.getPendingPlanForConversation("conv-1"), null);
});

test("submission returns immediately and registers the pending plan", async () => {
  const { tools } = loadModules();
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-submit" });
  // Conversational paradigm: execute does not suspend --- it resolves immediately with no reply required.
  const result = await bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-submit-1"));
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /this turn ends here/);
  assert.deepEqual(result.details, { kind: "exit_plan_mode", plan: PLAN.trim() });
  assert.deepEqual(tools.getPendingPlanForConversation("conv-submit"), {
    toolCallId: "call-submit-1",
    plan: PLAN.trim(),
  });
  assert.equal(tools.isPlanDecisionPending("call-submit-1"), true);

  // A new submission overrides the old registration: the old call is no longer pending.
  await bundle.executeToolCall(createToolCall({ plan: "# v2" }, "call-submit-2"));
  assert.equal(tools.isPlanDecisionPending("call-submit-1"), false);
  assert.equal(tools.getPendingPlanForConversation("conv-submit").toolCallId, "call-submit-2");
  tools.cancelPendingPlanDecisionsForConversation("conv-submit");
});

test("approve routes to the host handler and settles the pending plan", async () => {
  const { tools } = loadModules();
  const approvals = [];
  const rejections = [];
  tools.registerPlanDecisionHandlers({
    onApprove: (input) => approvals.push(input),
    onReject: (input) => rejections.push(input),
  });
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-approve" });
  await bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-approve-1"));

  // An invalid decision is rejected.
  assert.equal(tools.answerPlanDecision("call-approve-1", { decision: "maybe" }).ok, false);
  // A cross-conversation answer is rejected.
  assert.equal(
    tools.answerPlanDecision(
      "call-approve-1",
      { decision: "approve" },
      { conversationId: "conv-other" },
    ).ok,
    false,
  );

  const outcome = tools.answerPlanDecision(
    "call-approve-1",
    { decision: "approve" },
    { conversationId: "conv-approve" },
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(approvals, [{ conversationId: "conv-approve", plan: PLAN.trim() }]);
  assert.deepEqual(rejections, []);
  assert.equal(tools.isPlanApprovalToolCall("call-approve-1"), true);
  assert.equal(tools.getPendingPlanForConversation("conv-approve"), null);
  // Answering again after settlement is rejected (a structured code lets the remote card settle rather than error).
  const settled = tools.answerPlanDecision("call-approve-1", { decision: "approve" });
  assert.equal(settled.ok, false);
  assert.equal(settled.code, "not_pending");
  tools.registerPlanDecisionHandlers(null);
  // The approved state is also cleaned up with the conversation: pending is deleted on approval, so cleanup
  // must not rely on a reverse lookup through pending --- otherwise approvedToolCallIds would grow unbounded per process.
  tools.cancelPendingPlanDecisionsForConversation("conv-approve");
  assert.equal(tools.isPlanApprovalToolCall("call-approve-1"), false);
});

test("reject requires feedback and routes it to the host as a message", async () => {
  const { tools } = loadModules();
  const approvals = [];
  const rejections = [];
  tools.registerPlanDecisionHandlers({
    onApprove: (input) => approvals.push(input),
    onReject: (input) => rejections.push(input),
  });
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-reject" });
  await bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-reject-1"));

  // A reject without feedback is rejected (prompting the user to type directly).
  assert.equal(tools.answerPlanDecision("call-reject-1", { decision: "reject" }).ok, false);
  assert.equal(tools.isPlanDecisionPending("call-reject-1"), true);

  const outcome = tools.answerPlanDecision("call-reject-1", {
    decision: "reject",
    feedback: "split into two steps",
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(rejections, [{ conversationId: "conv-reject", feedback: "split into two steps" }]);
  assert.deepEqual(approvals, []);
  // The old plan is invalidated after feedback is sent (the model will revise and resubmit).
  assert.equal(tools.isPlanDecisionPending("call-reject-1"), false);
  assert.equal(tools.isPlanApprovalToolCall("call-reject-1"), false);
  tools.registerPlanDecisionHandlers(null);
});

test("cancel clears the conversation's pending plan and approval mark", async () => {
  const { tools } = loadModules();
  tools.registerPlanDecisionHandlers({ onApprove: () => {}, onReject: () => {} });
  const bundleA = tools.createExitPlanModeTools({ conversationId: "conv-a" });
  const bundleB = tools.createExitPlanModeTools({ conversationId: "conv-b" });
  await bundleA.executeToolCall(createToolCall({ plan: PLAN }, "call-plan-a"));
  await bundleB.executeToolCall(createToolCall({ plan: PLAN }, "call-plan-b"));

  tools.cancelPendingPlanDecisionsForConversation("conv-a");
  assert.equal(tools.getPendingPlanForConversation("conv-a"), null);
  // Other conversations are unaffected.
  assert.equal(tools.isPlanDecisionPending("call-plan-b"), true);
  tools.cancelPendingPlanDecisionsForConversation("conv-b");
  tools.registerPlanDecisionHandlers(null);
});

test("subscription notifies on register/approve/supersede", async () => {
  const { tools } = loadModules();
  tools.registerPlanDecisionHandlers({ onApprove: () => {}, onReject: () => {} });
  let notifications = 0;
  const unsubscribe = tools.subscribePlanDecisions(() => {
    notifications += 1;
  });
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-sub" });
  await bundle.executeToolCall(createToolCall({ plan: PLAN }, "call-sub-1"));
  const afterRegister = notifications;
  assert.ok(afterRegister >= 1);
  tools.answerPlanDecision("call-sub-1", { decision: "approve" });
  assert.ok(notifications > afterRegister);
  unsubscribe();
  tools.registerPlanDecisionHandlers(null);
  tools.cancelPendingPlanDecisionsForConversation("conv-sub");
});

test("phrase approval in ChatPage is gated on the live plan switch", () => {
  // A pending plan survives across runs (by design), but phrase approval must require the plan switch to
  // still be on: after the user turns off the pill and discards the plan, a casual "ok" afterwards must not
  // revive the stale plan into an execution continuation turn. Explicit approval still goes through the card
  // button and is not limited by the switch.
  const chatPageSource = readFileSync(
    new URL("../../src/pages/ChatPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    chatPageSource,
    /planModeEnabledRef\.current =\s*settings\.chatRuntimeControls\.planModeEnabled === true/,
  );
  assert.match(chatPageSource, /if \(conversationId && planModeEnabledRef\.current\) \{/);
  // The phrase-approval branch is entirely inside the switch precondition (the precondition appears before the pending query).
  assert.ok(
    chatPageSource.indexOf("conversationId && planModeEnabledRef.current") <
      chatPageSource.indexOf("getPendingPlanForConversation(conversationId)"),
  );
});

test("isPlanModeAllowedTool admits read-only, plan, and collaboration tools only", () => {
  const { tools } = loadModules();
  assert.equal(tools.isPlanModeAllowedTool("Read", { isReadOnly: true }), true);
  assert.equal(tools.isPlanModeAllowedTool("ExitPlanMode", { isReadOnly: true }), true);
  assert.equal(tools.isPlanModeAllowedTool("Agent", { isReadOnly: false }), true);
  assert.equal(tools.isPlanModeAllowedTool("SendMessage", { isReadOnly: false }), true);
  assert.equal(tools.isPlanModeAllowedTool("Bash", { isReadOnly: false }), false);
  assert.equal(tools.isPlanModeAllowedTool("Write", { isReadOnly: false }), false);
  assert.equal(tools.isPlanModeAllowedTool("mcp_srv_tool", undefined), false);
});

test("plan-mode prompt routes every complete answer through ExitPlanMode without unbounded pressure", () => {
  const { tools } = loadModules();
  const section = tools.buildPlanModeSystemPromptSection();
  // Coverage: every complete answer (not only implementation plans) is submitted through ExitPlanMode.
  assert.match(section, /Submit every complete answer through ExitPlanMode/);
  assert.match(section, /architecture summaries, research findings, Q&A/);
  assert.match(section, /instead of plain assistant text/);
  // Anti-spin: guide the model to "stop once it is enough" and point out that repeated reads only return an unchanged stub.
  assert.match(section, /Stop researching once you can produce the deliverable/);
  assert.match(section, /unchanged stub/);
  // Ask proactively about detailed decisions: decisions that belong to the user are clarified with
  // AskUserQuestion rather than guessed or left as open questions in the plan; after answering, the turn continues.
  assert.match(section, /proactively ask with AskUserQuestion during research/);
  assert.match(section, /instead of guessing or leaving open questions in the plan/);
  assert.match(section, /Execution pauses for the answers and continues this turn/);
  // High-pressure wording has been removed: it raises the submission bar and induces endless research.
  assert.doesNotMatch(section, /You MUST call/);
  const bundle = tools.createExitPlanModeTools({ conversationId: "conv-prompt" });
  const tool = bundle.tools.find((candidate) => candidate.name === "ExitPlanMode");
  assert.match(tool.description, /every finished answer, not only implementation plans/);
  assert.match(tool.description, /Submitting ends this turn immediately/);
});

// ---------------------------------------------------------------------------
// Run policy: bounded escalation state machine
// ---------------------------------------------------------------------------

function textAssistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 };
}

function planToolResultMessage(toolCallId, isError = false) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "ExitPlanMode",
    content: [{ type: "text", text: "ok" }],
    isError,
    timestamp: 1,
  };
}

test("run policy: auto during research, one forced nudge, then text fallback registers the plan", () => {
  const { tools } = loadModules();
  const policy = tools.createPlanModeRunPolicy({ conversationId: "conv-policy" });

  // Research phase: tool_choice is not forced, and the circuit-breaker line is the research limit.
  assert.equal(policy.resolveToolChoice(), undefined);
  assert.equal(policy.maxRounds(), tools.PLAN_MODE_MAX_RESEARCH_ROUNDS);
  assert.equal(
    policy.resolveToolTermination({ type: "toolCall", id: "c1", name: "ExitPlanMode" }),
    true,
  );
  assert.equal(policy.resolveToolTermination({ type: "toolCall", id: "c2", name: "Read" }), false);

  // The first run ends with text and no submission -> one supplementary submission round (targeted forcing + reminder text).
  const first = policy.decideAfterRun({ emittedMessages: [textAssistantMessage("plan text")] });
  assert.equal(first.kind, "nudge");
  assert.equal(first.reminderText, tools.PLAN_MODE_NUDGE_REMINDER);
  assert.deepEqual(policy.resolveToolChoice(), { type: "tool", name: "ExitPlanMode" });
  assert.equal(policy.maxRounds(), tools.PLAN_MODE_MAX_NUDGE_ROUNDS);

  // The supplementary submission still produces nothing -> text fallback.
  const second = policy.decideAfterRun({ emittedMessages: [textAssistantMessage("plan text")] });
  assert.equal(second.kind, "fallback");

  const fallback = policy.registerFallbackPlan({ planText: "## Fallback plan\n\n1. A\n" });
  assert.ok(fallback);
  assert.equal(fallback.toolCall.name, "ExitPlanMode");
  assert.equal(fallback.toolResult.toolCallId, fallback.toolCall.id);
  assert.equal(fallback.toolResult.isError, false);
  assert.deepEqual(fallback.toolResult.details, {
    kind: "exit_plan_mode",
    plan: "## Fallback plan\n\n1. A",
  });
  // Isomorphic to a real submission: register the pending plan and reuse the approval entry with zero changes.
  assert.deepEqual(tools.getPendingPlanForConversation("conv-policy"), {
    toolCallId: fallback.toolCall.id,
    plan: "## Fallback plan\n\n1. A",
  });
  assert.equal(tools.isPlanDecisionPending(fallback.toolCall.id), true);
  tools.cancelPendingPlanDecisionsForConversation("conv-policy");
});

test("run policy: a successful ExitPlanMode submission settles the run immediately", () => {
  const { tools } = loadModules();
  const policy = tools.createPlanModeRunPolicy({ conversationId: "conv-policy-ok" });
  const decision = policy.decideAfterRun({
    emittedMessages: [planToolResultMessage("call-ok-1")],
  });
  assert.equal(decision.kind, "submitted");
  // After a successful submission it does not enter the supplementary-submission state.
  assert.equal(policy.resolveToolChoice(), undefined);
});

test("run policy: an errored ExitPlanMode result does not count as submission", () => {
  const { tools } = loadModules();
  const policy = tools.createPlanModeRunPolicy({ conversationId: "conv-policy-err" });
  const decision = policy.decideAfterRun({
    emittedMessages: [planToolResultMessage("call-err-1", true)],
  });
  assert.equal(decision.kind, "nudge");
});

test("run policy: fallback with empty text registers nothing and the turn just ends", () => {
  const { tools } = loadModules();
  const policy = tools.createPlanModeRunPolicy({ conversationId: "conv-policy-empty" });
  policy.decideAfterRun({ emittedMessages: [] });
  policy.decideAfterRun({ emittedMessages: [] });
  assert.equal(policy.registerFallbackPlan({ planText: "   " }), null);
  assert.equal(tools.getPendingPlanForConversation("conv-policy-empty"), null);
});

test("run policy: repeated identical research calls are blocked past the limit", () => {
  const { tools } = loadModules();
  const policy = tools.createPlanModeRunPolicy({ conversationId: "conv-policy-repeat" });
  const read = (id) => ({
    type: "toolCall",
    id,
    name: "Read",
    // A different key order still counts as the same call (stable serialization).
    arguments: id === "r2" ? { limit: 5, path: "a.ts" } : { path: "a.ts", limit: 5 },
  });

  assert.equal(policy.guardRepeatedToolCall(read("r1")).allow, true);
  assert.equal(policy.guardRepeatedToolCall(read("r2")).allow, true);
  const blocked = policy.guardRepeatedToolCall(read("r3"));
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /already made this exact Read call/);
  assert.match(blocked.reason, /ExitPlanMode/);

  // Calls with different arguments are unaffected.
  assert.equal(
    policy.guardRepeatedToolCall({
      type: "toolCall",
      id: "r4",
      name: "Read",
      arguments: { path: "b.ts" },
    }).allow,
    true,
  );
  // ExitPlanMode is never blocked by the repeat guard (a revised resubmission must not be stuck).
  for (const id of ["p1", "p2", "p3", "p4"]) {
    assert.equal(
      policy.guardRepeatedToolCall({
        type: "toolCall",
        id,
        name: "ExitPlanMode",
        arguments: { plan: "same" },
      }).allow,
      true,
    );
  }
});
