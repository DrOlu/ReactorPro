// crates/agent-gui/test/chat/clarify-delta-forwarder.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const loader = createTsModuleLoader({ mocks: {} });
const { createClarifyDeltaForwarder } = loader.loadModule(
  path.join(rootDir, "src/pages/chat/gateway/clarifyDeltaForwarder.ts"),
);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("forwarder serializes sends and coalesces deltas arriving in flight", async () => {
  const sent = [];
  const gates = [];
  const forward = createClarifyDeltaForwarder((text) => {
    const gate = deferred();
    gates.push(gate);
    sent.push(text);
    return gate.promise;
  });

  forward("[CLARIFY");
  forward("_QUESTION]");
  forward("\nLet's do");
  await settle();
  // The first frame is in flight; the next two deltas are merged and wait for the next flush.
  assert.deepEqual(sent, ["[CLARIFY"]);

  gates[0].resolve();
  await settle();
  assert.deepEqual(sent, ["[CLARIFY", "_QUESTION]\nLet's do"]);

  gates[1].resolve();
  await settle();
  forward("What?");
  await settle();
  assert.deepEqual(sent, ["[CLARIFY", "_QUESTION]\nLet's do", "What?"]);
  gates[2].resolve();
});

test("forwarder keeps forwarding after a send failure", async () => {
  const sent = [];
  const errors = [];
  let failFirst = true;
  const forward = createClarifyDeltaForwarder(
    (text) => {
      sent.push(text);
      if (failFirst) {
        failFirst = false;
        return Promise.reject(new Error("gateway offline"));
      }
      return Promise.resolve();
    },
    (error) => errors.push(error),
  );

  forward("a");
  await settle();
  forward("b");
  await settle();
  assert.deepEqual(sent, ["a", "b"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /gateway offline/);
});

test("forwarder ignores empty deltas", async () => {
  const sent = [];
  const forward = createClarifyDeltaForwarder((text) => {
    sent.push(text);
    return Promise.resolve();
  });
  forward("");
  await settle();
  assert.deepEqual(sent, []);
});
