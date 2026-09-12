import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.location = { origin: "http://127.0.0.1:9", href: "http://127.0.0.1:9/" };

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const { getGatewayWebSocketClient, onGatewayWebSocketClientReplaced, resetGatewayWebSocketClient } =
  loader.loadModule("src/lib/gatewaySocket.ts");

// Whenever a new instance displaces an existing instance -- including reset to empty then create
// (logout -> login) -- replaced must fire; otherwise the module-level store would stay attached to
// the disposed old instance forever and receive no events.
test("singleton reset->create also fires replaced", () => {
  let fired = 0;
  const detach = onGatewayWebSocketClientReplaced(() => {
    fired += 1;
  });
  const first = getGatewayWebSocketClient("token-a");
  assert.equal(fired, 0); // the first creation does not count as a replacement
  resetGatewayWebSocketClient();
  assert.equal(fired, 0); // reset itself does not notify (no new instance is available to attach at this moment)
  const second = getGatewayWebSocketClient("token-a");
  assert.notEqual(first, second);
  assert.equal(fired, 1);
  detach();
  resetGatewayWebSocketClient();
});
