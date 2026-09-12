// Web-side Session Workbench contract tests:
// 1) Conversation isolation through the gateway relay -- ConversationStreamClient
//    routes by conversation_id, and events never cross streams when multiple Panes
//    coexist; at the moment focus switches, the same conversation's "later
//    subscription replaces the earlier one", and cleanup of the replaced side does
//    not mistakenly delete the new subscription (GatewayConversationPaneHost relies
//    on this semantics).
// 2) In-place rebinding of a Pane when a draft is promoted -- renameWorkbenchConversation
//    keeps the topology/focus/paneId unchanged and only swaps the conversation id;
//    it refuses when "at most one Pane per conversation" would be violated.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { ConversationStreamClient } = loader.loadModule(
  "src/lib/chat/stream/conversationStreamClient.ts",
);
const { renameWorkbenchConversation } = loader.loadModule(
  "@liveagent/ui/lib/workbench/useWindowWorkbench.ts",
);
const { findPaneIdByConversationId, isWorkbenchLayoutValid } = loader.loadModule(
  "@liveagent/ui/lib/workbench/index.ts",
);
const { WORKBENCH_LAYOUT_SCHEMA_VERSION } = loader.loadModule(
  "@liveagent/ui/lib/workbench/types.ts",
);
const { resolveConversationRuntimeControls } = loader.loadModule(
  "src/app/gatewayChatCommandActions.ts",
);

// --- Stream client test harness (isomorphic with conversation-stream-client.test.mjs) ---

function createTransport() {
  const calls = [];
  let responder = () => ({});
  return {
    calls,
    setResponder(fn) {
      responder = fn;
    },
    request(type, payload, options) {
      calls.push({ type, payload, options });
      return Promise.resolve(responder(type, payload));
    },
  };
}

function subscribeResponse(conversationId, overrides = {}) {
  return {
    conversation_id: conversationId,
    stream_epoch: `epoch-${conversationId}`,
    latest_seq: 0,
    reset: false,
    activity: null,
    snapshot: null,
    events: [],
    ...overrides,
  };
}

function collectHandlers() {
  const seen = { syncs: [], events: [] };
  return {
    seen,
    handlers: {
      onSync(result) {
        seen.syncs.push(result);
      },
      onEvent(event) {
        seen.events.push(event);
      },
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

// --- Layout test harness ----------------------------------------------------

function conversationPane(paneId, conversationId) {
  return {
    paneId,
    surface: {
      kind: "conversation",
      conversationId,
      project: {
        projectId: `project-${paneId}`,
        projectPathKey: `/workspace/${paneId}`,
      },
    },
    view: {},
  };
}

function twoPaneLayout(firstConversationId, secondConversationId) {
  const first = conversationPane("pane-a", firstConversationId);
  const second = conversationPane("pane-b", secondConversationId);
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 7,
    root: {
      type: "split",
      splitId: "split-root",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: first.paneId },
      second: { type: "leaf", paneId: second.paneId },
    },
    panes: {
      [first.paneId]: first,
      [second.paneId]: second,
    },
    focusedPaneId: first.paneId,
  };
}

// --- Conversation isolation -------------------------------------------------

test("multi-pane gateway streams stay isolated per conversation", async () => {
  const transport = createTransport();
  const client = new ConversationStreamClient(transport);
  const paneA = collectHandlers();
  const paneB = collectHandlers();

  transport.setResponder((_type, payload) => subscribeResponse(payload.conversation_id));
  client.subscribe("conv-a", paneA.handlers);
  client.subscribe("conv-b", paneB.handlers);
  client.handleConnected();
  await flushMicrotasks();
  assert.equal(paneA.seen.syncs.length, 1);
  assert.equal(paneB.seen.syncs.length, 1);

  client.handleChatEvent({ type: "token", conversation_id: "conv-a", seq: 1, text: "a1" });
  client.handleChatEvent({ type: "token", conversation_id: "conv-b", seq: 1, text: "b1" });
  client.handleChatEvent({ type: "token", conversation_id: "conv-a", seq: 2, text: "a2" });
  // Events for unsubscribed conversations are dropped and do not reach any handler.
  client.handleChatEvent({ type: "token", conversation_id: "conv-c", seq: 1, text: "c1" });

  assert.deepEqual(
    paneA.seen.events.map((event) => event.text),
    ["a1", "a2"],
  );
  assert.deepEqual(
    paneB.seen.events.map((event) => event.text),
    ["b1"],
  );
});

test("focus handoff: re-subscribing replaces the old registration; stale cleanup is inert", async () => {
  const transport = createTransport();
  const client = new ConversationStreamClient(transport);
  const preview = collectHandlers();
  const mainView = collectHandlers();

  transport.setResponder((_type, payload) => subscribeResponse(payload.conversation_id));
  const unsubscribePreview = client.subscribe("conv-a", preview.handlers);
  client.handleConnected();
  await flushMicrotasks();

  // Focus switch: the main view subscribes to the same conversation again, replacing
  // the preview's registration.
  client.subscribe("conv-a", mainView.handlers);
  await flushMicrotasks();

  client.handleChatEvent({ type: "token", conversation_id: "conv-a", seq: 1, text: "x" });
  assert.equal(preview.seen.events.length, 0);
  assert.deepEqual(
    mainView.seen.events.map((event) => event.text),
    ["x"],
  );

  // The preview component then unmounts: the replaced cleanup must not delete the
  // new registration nor send unsubscribe to the gateway.
  const callsBefore = transport.calls.length;
  unsubscribePreview();
  await flushMicrotasks();
  assert.equal(transport.calls.length, callsBefore);
  client.handleChatEvent({ type: "token", conversation_id: "conv-a", seq: 2, text: "y" });
  assert.deepEqual(
    mainView.seen.events.map((event) => event.text),
    ["x", "y"],
  );
});

// --- In-place rebinding when a draft is promoted -----------------------------

test("draft promotion rebinds the hosting pane in place", () => {
  const layout = twoPaneLayout("draft-local-1", "conversation-b");
  const next = renameWorkbenchConversation(layout, "draft-local-1", "conversation-real");

  assert.ok(next);
  assert.ok(isWorkbenchLayoutValid(next));
  assert.equal(next.revision, layout.revision + 1);
  // Topology and focus keep their references: the Pane is not remounted and the
  // split ratio does not change.
  assert.equal(next.root, layout.root);
  assert.equal(next.focusedPaneId, layout.focusedPaneId);
  assert.equal(next.panes["pane-b"], layout.panes["pane-b"]);
  // The same Pane is rebound in place to the real conversation id; the draft id is
  // no longer hosted by any Pane.
  assert.equal(findPaneIdByConversationId(next, "conversation-real"), "pane-a");
  assert.equal(findPaneIdByConversationId(next, "draft-local-1"), null);
  assert.equal(next.panes["pane-a"].surface.project, layout.panes["pane-a"].surface.project);
});

test("rename refuses no-op and invariant-breaking inputs", () => {
  const layout = twoPaneLayout("conversation-a", "conversation-b");

  // Source conversation has no Pane / empty id / same id: nothing happens.
  assert.equal(renameWorkbenchConversation(layout, "conversation-x", "conversation-y"), null);
  assert.equal(renameWorkbenchConversation(layout, "", "conversation-y"), null);
  assert.equal(
    renameWorkbenchConversation(layout, "conversation-a", "conversation-a"),
    null,
  );
  // Target conversation already has a Pane: refuse, preserving "at most one Pane
  // per conversation".
  assert.equal(
    renameWorkbenchConversation(layout, "conversation-a", "conversation-b"),
    null,
  );
});

test("background pane runtime controls resolve from that conversation's provider", () => {
  const runtimeControls = {
    reasoning: "medium",
    reasoningByProvider: {
      claude_code: "high",
      codex_openai_responses: "low",
      codex_openai_completions: "medium",
      gemini: "medium",
      xai: "medium",
      deepseek: "medium",
    },
    thinkingEnabled: true,
    nativeWebSearchEnabled: true,
    planModeEnabled: false,
  };
  const activeProviders = [
    {
      id: "provider-claude",
      type: "claude_code",
    },
    {
      id: "provider-codex",
      type: "codex",
      requestFormat: "openai-responses",
    },
  ];
  const resolved = resolveConversationRuntimeControls({
    activeProviders,
    selectedModel: { customProviderId: "provider-codex", model: "gpt-5.6" },
    runtimeControls,
  });
  assert.equal(resolved.reasoning, "low");
});

test("workbench pane composer wires the clarify runner (web default path)", () => {
  // sessionWorkbench is enabled by default: Web chat is always rendered through
  // GatewayConversationPaneHost, and the clarify button must be wired on this path
  // (GatewayAppView's inline composer is only the VITE_LIVEAGENT_SESSION_WORKBENCH=0
  // escape hatch). The runner resolves the provider/model from this Pane's
  // conversation (the desktop background Pane convention).
  const webRoot = fileURLToPath(new URL("../../web", import.meta.url));
  const paneHostSource = readFileSync(
    path.join(webRoot, "src/app/workbench/GatewayConversationPaneHost.tsx"),
    "utf8",
  );
  assert.match(paneHostSource, /executeClarifyPromptTurn\(\s*context\.api,\s*context\.settings,/);
  assert.match(paneHostSource, /\(messages, _signal, onTextDelta\) =>/);
  assert.match(paneHostSource, /onTextDelta,/);
  // When the master switch (settings.customSettings.promptClarifyEnabled) is off,
  // no executor is passed and ChatComposerBar hides the clarify button accordingly;
  // model override/fallback converges in executeClarifyPromptTurn (which internally
  // goes through resolvePromptClarifyModel), shared by both hosts.
  assert.match(
    paneHostSource,
    /context\.settings\.customSettings\.promptClarifyEnabled \? runClarifyTurn : undefined/,
  );
  assert.match(paneHostSource, /clarifyContext=\{clarifyContext\}/);
});
