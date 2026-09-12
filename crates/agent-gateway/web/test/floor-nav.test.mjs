import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const floorModel = loader.loadModule("@liveagent/ui/lib/chat-floor-nav/floorModel.ts");
const floorBookmarks = loader.loadModule("@liveagent/ui/lib/chat-floor-nav/floorBookmarks.ts");

// The WebUI's floor source is TranscriptRow (a structural subset of kind/key/text/messageRef that is
// compatible with the desktop's RenderTimelineItem, so floorModel can be a byte-for-byte mirror).
function userRow(key, text, messageId) {
  return {
    key,
    origin: "history",
    kind: "user",
    text,
    attachments: [],
    messageRef: messageId
      ? {
          segmentIndex: 0,
          messageIndex: 0,
          segmentId: "seg",
          messageId,
          role: "user",
          contentHash: "h",
        }
      : undefined,
    timestamp: 0,
  };
}

function assistantRow(key, text) {
  return {
    key,
    origin: "history",
    kind: "assistant",
    rounds: [
      {
        blocks: [
          { kind: "thinking", text: "does not enter the preview" },
          { kind: "text", text },
          { kind: "tool", item: {} },
        ],
      },
    ],
  };
}

test("buildFloorEntries keeps only user rows and builds previews", () => {
  const rows = [
    { key: "c1", origin: "history", kind: "checkpoint" },
    userRow("u1", "  Help me look\nwhere this bug   is ", "user-aaa"),
    assistantRow("a1", " First stage complete,\nverified. "),
    userRow("u2", "x".repeat(60), "user-bbb"),
    userRow("u3", "   ", undefined),
  ];
  const floors = floorModel.buildFloorEntries(rows);
  assert.equal(floors.length, 3);
  assert.deepEqual(
    floors.map((f) => f.rowKey),
    ["u1", "u2", "u3"],
  );
  assert.equal(floors[0].preview, "Help me look where this bug is");
  assert.equal(floors[0].responsePreview, "First stage complete, verified.");
  assert.equal(floors[0].messageId, "user-aaa");
  assert.ok(floors[1].preview.endsWith("…"));
  assert.equal(floors[1].preview.length, 49);
  assert.equal(floors[1].responsePreview, null);
  assert.equal(floors[2].preview, "…");
  // Falls back to the row key when there is no messageRef, so bookmarking still works
  assert.equal(floors[2].messageId, "u3");
});

test("sampleFloorEntries keeps bookmarked floors and stays continuous at the cap", () => {
  const floors = Array.from(
    { length: 100 },
    (_, i) => floorModel.buildFloorEntries([userRow(`u${i}`, `msg ${i}`, `user-${i}`)])[0],
  );
  const mustKeep = new Set(["u37", "u73"]);
  const sampled = floorModel.sampleFloorEntries(floors, 20, mustKeep);
  assert.ok(sampled.length <= 20 + mustKeep.size);
  assert.ok(sampled.some((f) => f.rowKey === "u37"));
  assert.ok(sampled.some((f) => f.rowKey === "u73"));
  assert.equal(sampled[0].rowKey, "u0");
  assert.equal(sampled[sampled.length - 1].rowKey, "u99");

  // The marker count transitions continuously when over the cap: 25 floors limited to 24 should not
  // suddenly drop to half
  const floors25 = floors.slice(0, 25);
  const sampled25 = floorModel.sampleFloorEntries(floors25, 24, new Set());
  assert.ok(sampled25.length >= 23, `expected >=23 markers, got ${sampled25.length}`);
});

test("resolveNearestSampledRowKey maps active floor to nearest marker", () => {
  const floors = Array.from(
    { length: 10 },
    (_, i) => floorModel.buildFloorEntries([userRow(`u${i}`, `msg ${i}`, `user-${i}`)])[0],
  );
  const sampled = [floors[0], floors[5], floors[9]];
  assert.equal(floorModel.resolveNearestSampledRowKey(floors, sampled, "u5"), "u5");
  assert.equal(floorModel.resolveNearestSampledRowKey(floors, sampled, "u6"), "u5");
  assert.equal(floorModel.resolveNearestSampledRowKey(floors, sampled, "u8"), "u9");
  assert.equal(floorModel.resolveNearestSampledRowKey(floors, sampled, null), null);
  assert.equal(floorModel.resolveNearestSampledRowKey(floors, sampled, "missing"), null);
});

test("buildFloorPreview truncates on code points without splitting surrogates", () => {
  const emoji = "😀".repeat(60);
  const preview = floorModel.buildFloorPreview(emoji);
  assert.ok(preview.endsWith("…"));
  const chars = Array.from(preview);
  assert.equal(chars.length, 49);
  for (const ch of chars.slice(0, -1)) {
    assert.equal(ch, "😀", `expected intact emoji, got ${JSON.stringify(ch)}`);
  }
});

test("floor bookmarks toggle and persist through localStorage", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  try {
    floorBookmarks.resetFloorBookmarksCacheForTest();
    assert.equal(floorBookmarks.getFloorBookmarks("conv-1").size, 0);

    let notified = 0;
    const unsubscribe = floorBookmarks.subscribeFloorBookmarks(() => {
      notified += 1;
    });

    floorBookmarks.toggleFloorBookmark("conv-1", "user-aaa");
    assert.ok(floorBookmarks.getFloorBookmarks("conv-1").has("user-aaa"));
    assert.equal(notified, 1);

    // Stable reference: the snapshot is unchanged when nothing is written
    const snapshot = floorBookmarks.getFloorBookmarks("conv-1");
    assert.equal(floorBookmarks.getFloorBookmarks("conv-1"), snapshot);

    // Bookmarks are still present after re-reading the disk (simulating a restart)
    floorBookmarks.resetFloorBookmarksCacheForTest();
    assert.ok(floorBookmarks.getFloorBookmarks("conv-1").has("user-aaa"));

    floorBookmarks.toggleFloorBookmark("conv-1", "user-aaa");
    assert.equal(floorBookmarks.getFloorBookmarks("conv-1").size, 0);
    unsubscribe();

    // Corrupt data does not throw
    store.set("liveagent.floor-bookmarks.v1", "{not json");
    floorBookmarks.resetFloorBookmarksCacheForTest();
    assert.equal(floorBookmarks.getFloorBookmarks("conv-1").size, 0);
  } finally {
    delete globalThis.localStorage;
  }
});

test("bookmark eviction trims memory and disk together", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  try {
    floorBookmarks.resetFloorBookmarksCacheForTest();
    for (let i = 0; i < 205; i++) {
      floorBookmarks.toggleFloorBookmark(`conv-${i}`, `user-${i}`);
    }
    // The oldest conversation is evicted from memory immediately (consistent with disk), and the
    // newest conversation is retained
    assert.equal(floorBookmarks.getFloorBookmarks("conv-0").size, 0);
    assert.equal(floorBookmarks.getFloorBookmarks("conv-204").size, 1);
    // State is consistent after re-reading the disk
    floorBookmarks.resetFloorBookmarksCacheForTest();
    assert.equal(floorBookmarks.getFloorBookmarks("conv-0").size, 0);
    assert.equal(floorBookmarks.getFloorBookmarks("conv-204").size, 1);
    const payload = JSON.parse(store.get("liveagent.floor-bookmarks.v1"));
    assert.ok(Object.keys(payload.conversations).length <= 200);
  } finally {
    delete globalThis.localStorage;
  }
});
