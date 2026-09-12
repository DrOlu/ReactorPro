import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// PR #521 review P2: "Send in a background Pane only focuses, never sends." After the fix, a
// background Pane's send is routed by that Pane's own conversationId (consistent with Stop):
// enqueue when running, send directly when idle. This file covers the Pane-side send handler's
// clear-on-send / restore-on-failure semantics, plus a source-level regression guard for ChatPage.

const loader = createTsModuleLoader();
const { createPaneComposerSendHandler } = loader.loadModule(
  "src/pages/chat/surfaces/paneComposerSend.ts",
);
const { beginPaneComposerDraftSession } = loader.loadModule(
  "src/pages/chat/surfaces/paneComposerDraftSession.ts",
);

function textDraft(text) {
  return { text, isEmpty: !text.trim(), segments: [], largePastes: [] };
}

function fakeComposer(initialDraft) {
  let draft = initialDraft;
  return {
    getDraft: () => draft,
    setDraft: (next) => {
      draft = next;
    },
    clear: () => {
      draft = textDraft("");
    },
    hasContent: () => Boolean(draft && !draft.isEmpty),
    current: () => draft,
  };
}

function mountHandler({
  sendDraft,
  draft = textDraft("hello from pane B"),
  hasPendingUploads = false,
}) {
  const composer = fakeComposer(draft);
  const clearedDrafts = [];
  const restoredDrafts = [];
  const handler = createPaneComposerSendHandler({
    composerRef: { current: composer },
    clearConversationDraft: () => clearedDrafts.push(true),
    restoreConversationDraft: (value) => restoredDrafts.push(value),
    hasPendingUploads: () => hasPendingUploads,
    sendDraft,
  });
  return { handler, composer, clearedDrafts, restoredDrafts };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an accepted send clears the pane composer and its cached draft", async () => {
  const sent = [];
  const { handler, composer, clearedDrafts, restoredDrafts } = mountHandler({
    sendDraft: async (draft) => {
      sent.push(draft);
      return true;
    },
  });

  handler();
  await tick();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "hello from pane B");
  assert.equal(composer.hasContent(), false);
  assert.equal(clearedDrafts.length, 1);
  assert.equal(restoredDrafts.length, 0);
});

test("a rejected send restores the draft so no text is lost", async () => {
  const { handler, composer, restoredDrafts } = mountHandler({
    sendDraft: async () => false,
  });

  handler();
  await tick();

  assert.equal(restoredDrafts.length, 1);
  assert.equal(restoredDrafts[0].text, "hello from pane B");
  assert.equal(composer.current().text, "hello from pane B");
});

test("a send that throws restores the draft instead of surfacing an unhandled rejection", async () => {
  const { handler, composer, restoredDrafts } = mountHandler({
    sendDraft: async () => {
      throw new Error("runtime unavailable");
    },
  });

  handler();
  await tick();

  assert.equal(restoredDrafts.length, 1);
  assert.equal(composer.current().text, "hello from pane B");
});

test("an empty composer sends nothing", async () => {
  const sent = [];
  const { handler } = mountHandler({
    draft: textDraft("   "),
    sendDraft: async (draft) => {
      sent.push(draft);
      return true;
    },
  });

  handler();
  await tick();

  assert.equal(sent.length, 0);
});

test("an empty composer still sends when the pane has staged uploads", async () => {
  const sent = [];
  const { handler, composer, clearedDrafts } = mountHandler({
    draft: textDraft(""),
    hasPendingUploads: true,
    sendDraft: async (draft) => {
      sent.push(draft);
      return true;
    },
  });

  handler();
  await tick();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].isEmpty, true);
  assert.equal(composer.hasContent(), false);
  assert.equal(clearedDrafts.length, 1);
});

test("a second click while the first send is in flight is ignored", async () => {
  let resolveSend;
  const sent = [];
  const { handler } = mountHandler({
    sendDraft: (draft) => {
      sent.push(draft);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    },
  });

  handler();
  handler();
  resolveSend(true);
  await tick();

  assert.equal(sent.length, 1);
});

test("restore does not clobber text typed after a failed send", async () => {
  let rejectSend;
  const { handler, composer, restoredDrafts } = mountHandler({
    sendDraft: () =>
      new Promise((_resolve, reject) => {
        rejectSend = reject;
      }),
  });

  handler();
  composer.setDraft(textDraft("newer text"));
  rejectSend(new Error("late failure"));
  await tick();

  // The cached draft is still restored (the conversation side loses nothing), but newer input
  // in the composer is not overwritten.
  assert.equal(restoredDrafts.length, 1);
  assert.equal(composer.current().text, "newer text");
});

// ---------------------------------------------------------------------------
// Source-level regression guard: a background Pane's send must no longer be swallowed by focusGuard.
// ---------------------------------------------------------------------------

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("background pane bindings route Send by conversationId, not through focusGuard", () => {
  const chatPage = readSource("../../src/pages/ChatPage.tsx");
  const buildStart = chatPage.indexOf("const buildBackgroundPaneBinding");
  assert.notEqual(buildStart, -1, "buildBackgroundPaneBinding must exist in ChatPage");
  const buildEnd = chatPage.indexOf("const workbenchRegistrations", buildStart);
  const builder = chatPage.slice(buildStart, buildEnd);

  // Send has the same semantics as Stop: explicitly routed by conversationId.
  assert.doesNotMatch(builder, /onSend:\s*focusGuard/);
  assert.match(builder, /sendDraft: paneSendDraft/);
  assert.match(builder, /conversationIdOverride: conversationId/);
  assert.match(builder, /uploadedFilesOverride: uploads/);
  // A running conversation is enqueued, rather than dropped or crossed into the focused conversation.
  assert.match(builder, /enqueueComposerTurnForConversation\(\{/);

  const paneHost = readSource("../../src/pages/chat/surfaces/ConversationPaneHost.tsx");
  assert.match(paneHost, /createPaneComposerSendHandler/);
  assert.match(paneHost, /hasPendingUploads:\s*\(\)\s*=>\s*controller\.getSnapshot\(\)\.uploads\.length\s*>\s*0/);
  // Chip removal must name this pane's conversation, not the focused one.
  assert.match(builder, /removePendingUpload\(relativePath,\s*conversationId\)/);
  // Paste must pass an explicit conversation + workdir, not the focused ref.
  assert.doesNotMatch(builder, /onPasteFiles:\s*importReadableFiles\s*,/);
  assert.match(builder, /importReadableFiles\(files,\s*\{/);
  assert.match(builder, /workdir:\s*workspaceRoot/);
});

test("focusing another pane does not swap an object composer ref across hosts", () => {
  // Object refs swapped with `ref={isCurrent ? hostRef : undefined}` detach
  // in tree order: the outgoing host can null hostRef after the incoming
  // host attached, so Enter reads a null composer and sends nothing.
  const chatPage = readSource("../../src/pages/ChatPage.tsx");
  assert.doesNotMatch(chatPage, /ref=\{isCurrent \? conversationPaneHostRef : undefined\}/);
  assert.match(chatPage, /if \(handle\) conversationPaneHostRef\.current = handle;/);
});

test("the primary pane stays disabled during hydration in multi-pane layouts", () => {
  const chatPage = readSource("../../src/pages/ChatPage.tsx");
  const registrations = chatPage.slice(chatPage.indexOf("const workbenchRegistrations"));
  assert.match(registrations, /isUploadingFiles \|\|\s*isConversationHydrating/);
  assert.doesNotMatch(registrations, /isConversationHydrating &&\s*Object\.keys\(workbench\.layout\.panes\)/);
});

test("switch cleanup saves the outgoing pane draft to its original conversation", () => {
  const composer = fakeComposer(textDraft("draft from conversation A"));
  const drafts = new Map();
  const controllerA = {
    getDraft: () => null,
    setDraft: (draft) => drafts.set("conversation-a", draft),
  };
  const controllerB = {
    getDraft: () => textDraft("cached B"),
    setDraft: (draft) => drafts.set("conversation-b", draft),
  };

  let currentController = controllerA;
  const cleanupA = beginPaneComposerDraftSession(composer, currentController);
  composer.setDraft(textDraft("unsent A"));
  // React renders the next identity before it invokes the previous layout
  // effect cleanup. The cleanup must remain bound to controller A.
  currentController = controllerB;
  assert.equal(currentController.getDraft().text, "cached B");
  cleanupA();

  assert.equal(drafts.get("conversation-a").text, "unsent A");
  assert.equal(drafts.has("conversation-b"), false);
});
