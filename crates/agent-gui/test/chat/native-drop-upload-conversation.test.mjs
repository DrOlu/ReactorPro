import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// PR #521 review P1: "Native file drag-and-drop under multiple Panes must belong to the conversation of the drop-target Pane".
// Beyond the geometric hit-test, this asserts the real upload ownership: at drop time the
// conversationId (data-file-upload-conversation-id) is read synchronously from the drop-target
// composer and passed explicitly along importUploadZonePaths -> importReadableFilePaths ->
// captureUploadTarget, rather than relying on asynchronous focus switching (currentConversationIdRef).

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// 1) drop point -> conversationId: read the ownership marker directly from the hit composer element.
// ---------------------------------------------------------------------------

const routingLoader = createTsModuleLoader();
const routing = routingLoader.loadModule("src/pages/chat/hooks/nativeFileDropRouting.ts");

function composerZone(conversationId, rect) {
  return {
    getAttribute: (name) =>
      name === routing.FILE_UPLOAD_CONVERSATION_ATTRIBUTE ? conversationId : null,
    getBoundingClientRect: () => rect,
  };
}

function twoPaneDocument() {
  // Two side-by-side Pane composers: A on the left half of the screen, B on the right half.
  return {
    querySelectorAll(selector) {
      if (selector !== routing.FILE_UPLOAD_DROP_ZONE_SELECTOR) return [];
      return [
        composerZone("conv-a", { left: 40, top: 600, right: 560, bottom: 700 }),
        composerZone("conv-b", { left: 640, top: 600, right: 1160, bottom: 700 }),
      ];
    },
  };
}

test("a drop inside pane B's composer resolves conversation B, never the focused one", () => {
  const doc = twoPaneDocument();
  assert.equal(
    routing.resolveNativeUploadConversationId(
      { x: 900, y: 650 },
      { scaleFactor: 1, document: doc },
    ),
    "conv-b",
  );
  assert.equal(
    routing.resolveNativeUploadConversationId(
      { x: 100, y: 650 },
      { scaleFactor: 1, document: doc },
    ),
    "conv-a",
  );
});

test("a drop outside every composer resolves no upload conversation", () => {
  const doc = twoPaneDocument();
  assert.equal(
    routing.resolveNativeUploadConversationId(
      { x: 600, y: 100 },
      { scaleFactor: 1, document: doc },
    ),
    null,
  );
});

test("physical drop coordinates are normalized before attribution (Windows DPI)", () => {
  const doc = twoPaneDocument();
  // Physical (1800, 1300) @2x -> logical (900, 650), hitting conv-b.
  assert.equal(
    routing.resolveNativeUploadConversationId(
      { x: 1800, y: 1300 },
      { scaleFactor: 2, document: doc },
    ),
    "conv-b",
  );
});

// ---------------------------------------------------------------------------
// 2) usePendingUploads: an explicit target overrides the focused conversation, so both files and workdir follow the drop point.
// ---------------------------------------------------------------------------

function createHookHarness() {
  const refs = [];
  const states = [];
  let refIndex = 0;
  let stateIndex = 0;

  const react = {
    useRef(initialValue) {
      const index = refIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
    },
    useState(initialValue) {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setState = (next) => {
        states[index] = typeof next === "function" ? next(states[index]) : next;
      };
      return [states[index], setState];
    },
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect: () => undefined,
  };

  return {
    react,
    render(run) {
      refIndex = 0;
      stateIndex = 0;
      return run();
    },
  };
}

function mountPendingUploads({ invokeImpl }) {
  const harness = createHookHarness();
  const invokeCalls = [];
  const loader = createTsModuleLoader({
    mocks: {
      react: harness.react,
      "@tauri-apps/api/core": {
        invoke: async (command, args) => {
          invokeCalls.push({ command, args });
          return invokeImpl(command, args);
        },
      },
    },
  });
  const { usePendingUploads } = loader.loadModule("src/pages/chat/hooks/usePendingUploads.ts");
  const { createConversationUploadStore } = loader.loadModule(
    "src/pages/chat/conversations/conversationUploadStore.ts",
  );

  const uploadStore = createConversationUploadStore();
  const currentConversationIdRef = { current: "conv-a" };
  const notifications = [];
  const errors = [];
  const params = {
    isAgentMode: true,
    workdir: "/ws/a",
    conversationId: "conv-a",
    uploadStore,
    currentConversationIdRef,
    composerRef: { current: null },
    setErrorMessage: (message) => errors.push(message),
    addNotify: (type, message) => notifications.push({ type, message }),
  };
  const hook = harness.render(() => usePendingUploads(params));
  return { hook, uploadStore, currentConversationIdRef, invokeCalls, notifications, errors };
}

function uploadedFile(relativePath) {
  return {
    relativePath,
    fileName: relativePath,
    kind: "text",
    sizeBytes: 1,
  };
}

test("an explicit drop target routes the import to that conversation and workdir", async () => {
  const { hook, uploadStore, invokeCalls } = mountPendingUploads({
    invokeImpl: () => ({ files: [uploadedFile("dropped.txt")], skipped: [] }),
  });

  // The focused conversation is conv-a and the drop point is conv-b: the file must appear only in conv-b.
  await hook.importReadableFilePaths(["/tmp/dropped.txt"], {
    conversationId: "conv-b",
    workdir: "/ws/b",
  });

  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].command, "system_import_readable_file_paths");
  assert.equal(invokeCalls[0].args.workdir, "/ws/b");
  assert.deepEqual(
    uploadStore.getSnapshot("conv-b").map((file) => file.relativePath),
    ["dropped.txt"],
  );
  assert.deepEqual(uploadStore.getSnapshot("conv-a"), []);
});

test("without an explicit target the import still lands in the focused conversation", async () => {
  const { hook, uploadStore, invokeCalls } = mountPendingUploads({
    invokeImpl: () => ({ files: [uploadedFile("plain.txt")], skipped: [] }),
  });

  await hook.importReadableFilePaths(["/tmp/plain.txt"]);

  assert.equal(invokeCalls[0].args.workdir, "/ws/a");
  assert.deepEqual(
    uploadStore.getSnapshot("conv-a").map((file) => file.relativePath),
    ["plain.txt"],
  );
});

test("removing a chip targets the owning conversation, not the focused pane", async () => {
  const { hook, uploadStore, currentConversationIdRef } = mountPendingUploads({
    invokeImpl: () => ({ files: [], skipped: [] }),
  });
  uploadStore.set("conv-a", [uploadedFile("a.txt")]);
  uploadStore.set("conv-b", [uploadedFile("b.txt"), uploadedFile("shared.txt")]);
  currentConversationIdRef.current = "conv-a";

  hook.removePendingUpload("shared.txt", "conv-b");

  assert.deepEqual(
    uploadStore.getSnapshot("conv-b").map((file) => file.relativePath),
    ["b.txt"],
  );
  assert.deepEqual(
    uploadStore.getSnapshot("conv-a").map((file) => file.relativePath),
    ["a.txt"],
  );

  hook.removePendingUpload("a.txt");
  assert.deepEqual(uploadStore.getSnapshot("conv-a"), []);
});

test("an explicit paste target routes clipboard files to that conversation and workdir", async () => {
  const { hook, uploadStore, invokeCalls } = mountPendingUploads({
    invokeImpl: () => ({ files: [uploadedFile("clip.png")], skipped: [] }),
  });

  await hook.importReadableFiles([new File(["png"], "clip.png", { type: "image/png" })], {
    conversationId: "conv-b",
    workdir: "/ws/b",
  });

  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].command, "system_import_uploaded_readable_files");
  assert.equal(invokeCalls[0].args.workdir, "/ws/b");
  assert.deepEqual(
    uploadStore.getSnapshot("conv-b").map((file) => file.relativePath),
    ["clip.png"],
  );
  assert.deepEqual(uploadStore.getSnapshot("conv-a"), []);
});

test("without an explicit paste target clipboard files still land in the focused conversation", async () => {
  const { hook, uploadStore, invokeCalls } = mountPendingUploads({
    invokeImpl: () => ({ files: [uploadedFile("plain.png")], skipped: [] }),
  });

  await hook.importReadableFiles([new File(["png"], "plain.png", { type: "image/png" })]);

  assert.equal(invokeCalls[0].args.workdir, "/ws/a");
  assert.deepEqual(
    uploadStore.getSnapshot("conv-a").map((file) => file.relativePath),
    ["plain.png"],
  );
});

test("a full target conversation still imports so duplicates can be merged", async () => {
  const { hook, uploadStore, notifications, invokeCalls } = mountPendingUploads({
    invokeImpl: () => ({ files: [], skipped: [] }),
  });
  // Even when the drop-point conversation already has 9 items, it must still be handed to the import
  // layer to identify duplicates; after merging it stays at 9, rather than rejecting early before a
  // stable dedupeKey is obtained.
  uploadStore.set(
    "conv-b",
    Array.from({ length: 9 }, (_, index) => uploadedFile(`existing-${index}.txt`)),
  );

  await hook.importReadableFilePaths(["/tmp/one-more.txt"], {
    conversationId: "conv-b",
    workdir: "/ws/b",
  });

  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].args.maxFiles, 9);
  assert.equal(notifications.some((item) => item.type === "warning"), false);
});

// ---------------------------------------------------------------------------
// 3) Source-level regression guard: the drop pipeline must not fall back to "focused conversation" routing.
// ---------------------------------------------------------------------------

test("the native drop pipeline resolves its conversation at drop time", () => {
  const tauriFileDrop = readSource("../../src/pages/chat/hooks/useTauriFileDrop.ts");
  // The drop branch must resolve the owning conversation from the final drop coordinates and pass it to the upload pipeline.
  assert.match(tauriFileDrop, /resolveNativeUploadConversationId\(event\.payload\.position/);
  assert.match(tauriFileDrop, /importUploadZonePaths\(event\.payload\.paths,\s*targetConversationId\)/);

  const composerBar = readSource("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx");
  // Each composer drop zone carries its own conversation ownership marker.
  assert.match(composerBar, /data-file-upload-conversation-id=\{conversationId\}/);
});
