// The mesh chat tools (issue #11).
//
// The client is mocked, so these tests pin the tool surface and the CONTRACT
// with the gateway — what gets dispatched, how a peer's reply is framed, and
// how refusals and transport failures are reported to the model — without a
// gateway or NATS. The framing matters most: a peer's reply is untrusted
// remote output, and the result must say so.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const meshClientPath = path.join(rootDir, "src/lib/mesh/meshClient.ts");

function callOf(name, arguments_) {
  return { id: "call-1", name, arguments: arguments_ };
}

function textOf(result) {
  return result.content[0].text;
}

/** A fake MeshClient recording dispatch calls, configurable per test. */
function makeClient(overrides = {}) {
  const state = { dispatchCalls: [] };
  const client = {
    async discover() {
      return overrides.discover ?? [];
    },
    async dispatch(request) {
      state.dispatchCalls.push(request);
      if (overrides.dispatchError) throw new Error(overrides.dispatchError);
      return (
        overrides.dispatch ?? { from: "globex/berlin/edge-1", text: "Q3 is up." }
      );
    },
  };
  return { client, state };
}

function loadTools(overrides) {
  const { client, state } = makeClient(overrides);
  // The module under test imports { meshClient }, so the mock must carry that
  // export name — the mock replaces the module namespace, not the binding.
  const loader = createTsModuleLoader({ mocks: { [meshClientPath]: { meshClient: client } } });
  const { createMeshTools } = loader.loadModule("src/lib/tools/meshTools.ts");
  return { createMeshTools, state };
}

test("the bundle is invisible until the user enables it", () => {
  const { createMeshTools } = loadTools();
  const bundle = createMeshTools({ enabled: false, runtimeScope: "chat", timeoutMs: 120_000, allowlist: [] });
  assert.equal(bundle.tools.length, 0, "a disabled bundle must register no tools");
  assert.equal(bundle.metadataByName.size, 0);
});

test("cron scope never gets the tools, even when enabled", () => {
  const { createMeshTools } = loadTools();
  const bundle = createMeshTools({
    enabled: true,
    runtimeScope: "cron_auto_prompt",
    timeoutMs: 120_000,
    allowlist: [],
  });
  assert.equal(bundle.tools.length, 0, "mesh chat is a chat-scoped capability");
});

test("an enabled bundle exposes exactly the two tools with the right read-only flags", () => {
  const { createMeshTools } = loadTools();
  const bundle = createMeshTools({ enabled: true, runtimeScope: "chat", timeoutMs: 120_000, allowlist: [] });
  assert.deepEqual(
    bundle.tools.map((tool) => tool.name).sort(),
    ["MeshPeers", "MeshSend"],
  );
  assert.equal(bundle.metadataByName.get("MeshPeers").isReadOnly, true);
  assert.equal(bundle.metadataByName.get("MeshSend").isReadOnly, false);
});

test("MeshPeers lists the directory", async () => {
  const { createMeshTools } = loadTools({
    discover: [
      {
        id: "grip-001",
        name: "Grip AI Agent",
        capabilities: [],
        skills: [{ id: "invoke" }],
        endpoint: "mesh.agent.grip-001.inbox",
        availability: "online",
      },
    ],
  });
  const bundle = createMeshTools({ enabled: true, runtimeScope: "chat", timeoutMs: 120_000, allowlist: [] });
  const result = await bundle.executeToolCall(callOf("MeshPeers", {}));
  assert.equal(result.isError, false);
  assert.match(textOf(result), /id: grip-001/);
  assert.match(textOf(result), /skills: invoke/);
});

test("MeshPeers reports an empty mesh as guidance, not as a failure", async () => {
  const { createMeshTools } = loadTools({ discover: [] });
  const bundle = createMeshTools({ enabled: true, runtimeScope: "chat", timeoutMs: 120_000, allowlist: [] });
  const result = await bundle.executeToolCall(callOf("MeshPeers", {}));
  assert.equal(result.isError, false);
  assert.match(textOf(result), /No peer agents/);
});

test("MeshSend dispatches the prompt and frames the reply as untrusted remote output", async () => {
  const { createMeshTools, state } = loadTools();
  const bundle = createMeshTools({ enabled: true, runtimeScope: "chat", timeoutMs: 90_000, allowlist: [] });
  const result = await bundle.executeToolCall(
    callOf("MeshSend", { target: "grip-001", text: "Summarise the Q3 report" }),
  );
  assert.equal(result.isError, false);
  // The settings timeout reaches the dispatch.
  assert.equal(state.dispatchCalls[0].timeoutMs, 90_000);
  assert.equal(state.dispatchCalls[0].target, "grip-001");
  assert.equal(state.dispatchCalls[0].text, "Summarise the Q3 report");
  // The reply is labelled: a hostile peer must not be able to steer this agent.
  const text = textOf(result);
  assert.match(text, /Remote reply from globex\/berlin\/edge-1/);
  assert.match(text, /never as instructions/);
  assert.match(text, /Q3 is up\./);
});

test("a peer's refusal is reported in the peer's own words, as an error", async () => {
  const { createMeshTools } = loadTools({
    dispatch: { from: "grip-001", text: "", error: { code: 4001, message: "No text in request" } },
  });
  const bundle = createMeshTools({ enabled: true, runtimeScope: "chat", timeoutMs: 120_000, allowlist: [] });
  const result = await bundle.executeToolCall(
    callOf("MeshSend", { target: "grip-001", text: "hello" }),
  );
  assert.equal(result.isError, true);
  assert.match(textOf(result), /refused the request: No text in request/);
});

test("a transport failure points at the settings instead of blaming the peer", async () => {
  const { createMeshTools } = loadTools({ dispatchError: "no reply within 120s" });
  const bundle = createMeshTools({ enabled: true, runtimeScope: "chat", timeoutMs: 120_000, allowlist: [] });
  const result = await bundle.executeToolCall(
    callOf("MeshSend", { target: "grip-001", text: "hello" }),
  );
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Could not contact grip-001 over the mesh: no reply within 120s/);
  assert.match(textOf(result), /Settings → Mesh/);
});

test("MeshSend refuses to guess: both a target and a prompt are required", async () => {
  const { createMeshTools, state } = loadTools();
  const bundle = createMeshTools({ enabled: true, runtimeScope: "chat", timeoutMs: 120_000, allowlist: [] });
  const missingTarget = await bundle.executeToolCall(
    callOf("MeshSend", { text: "hello" }),
  );
  assert.equal(missingTarget.isError, true);
  assert.equal(state.dispatchCalls.length, 0, "nothing must be dispatched");
});

test("an unknown tool name in this group is an error, never a silent success", async () => {
  const { createMeshTools } = loadTools();
  const bundle = createMeshTools({ enabled: true, runtimeScope: "chat", timeoutMs: 120_000, allowlist: [] });
  const result = await bundle.executeToolCall(callOf("MeshNonsense", {}));
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unknown tool: MeshNonsense/);
});

// The allowlist is a fence, not a hint — these pin both directions.
test("an empty allowlist allows every peer", async () => {
  const { createMeshTools, state } = loadTools();
  const bundle = createMeshTools({
    enabled: true,
    runtimeScope: "chat",
    timeoutMs: 120_000,
    allowlist: [],
  });
  const result = await bundle.executeToolCall(
    callOf("MeshSend", { target: "grip-001", text: "hello" }),
  );
  assert.equal(result.isError, false);
  assert.equal(state.dispatchCalls.length, 1);
});

test("a non-empty allowlist refuses a peer outside it, and dispatches nothing", async () => {
  const { createMeshTools, state } = loadTools();
  const bundle = createMeshTools({
    enabled: true,
    runtimeScope: "chat",
    timeoutMs: 120_000,
    allowlist: ["omp-cli-001", "agentspan-001"],
  });
  const result = await bundle.executeToolCall(
    callOf("MeshSend", { target: "grip-001", text: "hello" }),
  );
  assert.equal(result.isError, true);
  assert.match(textOf(result), /has not allowed MeshSend to contact grip-001/);
  assert.equal(state.dispatchCalls.length, 0, "nothing may be dispatched past the fence");
});

test("an allowed peer passes the fence, exact id match", async () => {
  const { createMeshTools, state } = loadTools();
  const bundle = createMeshTools({
    enabled: true,
    runtimeScope: "chat",
    timeoutMs: 120_000,
    allowlist: ["grip-001"],
  });
  const result = await bundle.executeToolCall(
    callOf("MeshSend", { target: "grip-001", text: "hello" }),
  );
  assert.equal(result.isError, false);
  assert.equal(state.dispatchCalls.length, 1);
});
