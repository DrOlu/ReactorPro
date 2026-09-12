import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { mergeTransientSidebarRunningActivity } = loader.loadModule(
  "@liveagent/ui/lib/sidebar/transientActivity.ts",
);
const gatewayAppSource = [
  "../src/app/GatewayApp.tsx",
  "../src/app/hooks/useGatewayChatPresentation.tsx",
  "../src/app/hooks/useGatewayConversationRuntime.ts",
]
  .map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8"))
  .join("\n");

test("manual compaction keeps its conversation and workspace running until terminal cleanup", () => {
  const runningConversationIds = new Set(["other-conversation"]);
  const runningProjectPathKeys = new Set(["/other/workspace"]);
  // Backward compatible: a single-object argument is still accepted.
  const merged = mergeTransientSidebarRunningActivity(
    runningConversationIds,
    runningProjectPathKeys,
    {
      conversationId: "conversation-1",
      workdir: "/workspace/project/",
    },
  );

  assert.deepEqual([...merged.runningConversationIds], ["other-conversation", "conversation-1"]);
  assert.deepEqual([...merged.runningProjectPathKeys], ["/other/workspace", "/workspace/project"]);

  const cleared = mergeTransientSidebarRunningActivity(
    runningConversationIds,
    runningProjectPathKeys,
    null,
  );
  assert.equal(cleared.runningConversationIds, runningConversationIds);
  assert.equal(cleared.runningProjectPathKeys, runningProjectPathKeys);

  const clearedEmptyArray = mergeTransientSidebarRunningActivity(
    runningConversationIds,
    runningProjectPathKeys,
    [],
  );
  assert.equal(clearedEmptyArray.runningConversationIds, runningConversationIds);
  assert.equal(clearedEmptyArray.runningProjectPathKeys, runningProjectPathKeys);
});

test("multiple manual compactions keep every pending conversation and workspace running (defect #3)", () => {
  const runningConversationIds = new Set(["other-conversation"]);
  const runningProjectPathKeys = new Set(["/other/workspace"]);
  const merged = mergeTransientSidebarRunningActivity(
    runningConversationIds,
    runningProjectPathKeys,
    [
      { conversationId: "conversation-1", workdir: "/workspace/one/" },
      { conversationId: "conversation-2", workdir: "/workspace/two/" },
      // null/undefined entries are skipped.
      null,
      undefined,
      // Duplicate conversations/workspaces are not counted twice.
      { conversationId: "conversation-1", workdir: "/workspace/one/" },
    ],
  );

  assert.deepEqual(
    [...merged.runningConversationIds],
    ["other-conversation", "conversation-1", "conversation-2"],
  );
  assert.deepEqual(
    [...merged.runningProjectPathKeys],
    ["/other/workspace", "/workspace/one", "/workspace/two"],
  );
});

test("manual compaction pending is keyed per conversation, never a global singleton (defect #3)", () => {
  // pending is keyed by conversation id: state + ref are written together through a
  // single setter/clearer.
  assert.match(
    gatewayAppSource,
    /useState<\s*ReadonlyMap<string, ManualCompactPendingRequest>\s*>/,
  );
  assert.match(
    gatewayAppSource,
    /const clearManualCompactPendingRequest = useCallback\(\s*\(conversationId: string, operationId: string\) => \{[\s\S]*?next\.delete\(conversationId\);/,
  );
  // handleManualCompact only refuses when the "same conversation" already has a pending.
  assert.match(
    gatewayAppSource,
    /manualCompactPendingRef\.current\.has\(conversationId\)/,
  );
  // A rejected acceptance (!accepted) clears pending by (conversationId, operationId).
  assert.match(
    gatewayAppSource,
    /!response\.accepted &&\s*clearManualCompactPendingRequest\(conversationId, operationId\) &&\s*isDisplayedConversation\(conversationId\)/,
  );
});

test("manual compaction terminal settlement surfaces the result even for background conversations (defect #4)", () => {
  // settle calls setChatError unconditionally (no longer gated by
  // isDisplayedConversation), so a compaction failure/skip on a switched-away
  // conversation can still surface a notice.
  assert.match(
    gatewayAppSource,
    /if \(!clearManualCompactPendingRequest\(targetConversationId, result\.operationId\)\) return;[\s\S]*?setChatError\(result\.message \|\| translate\(fallbackKey, locale\)\);/,
  );
  assert.doesNotMatch(
    gatewayAppSource,
    /if \(isDisplayedConversation\(targetConversationId\)\) \{\s*setChatError\(result\.message/,
  );
});
