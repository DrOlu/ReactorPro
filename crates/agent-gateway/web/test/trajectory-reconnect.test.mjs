import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// Use web's own module loader: the CI webui job installs only this package's dependencies,
// so borrowing agent-gui's helper would fail to find its node_modules on the runner.
const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const {
  absorbTrajectoryChatEvent,
  clearLiveTrajectory,
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
  resetLiveTrajectoryForRebase,
} = loader.loadModule("src/lib/trajectory/liveTrajectory.ts");

test("rebase clears live events and invalidates the authoritative window", () => {
  const conversationId = "trajectory-rebase-test";
  clearLiveTrajectory(conversationId);
  const before = liveTrajectoryAuthoritativeRevision(conversationId);

  assert.equal(
    absorbTrajectoryChatEvent({
      type: "trajectory",
      conversation_id: conversationId,
      event: { k: "user", t: 1, at: 100, mi: 0 },
    }),
    true,
  );
  assert.equal(liveTrajectoryEvents(conversationId).length, 1);

  assert.equal(
    absorbTrajectoryChatEvent({ type: "rebased", conversation_id: conversationId }),
    false,
  );
  resetLiveTrajectoryForRebase(conversationId);
  assert.deepEqual(liveTrajectoryEvents(conversationId), []);
  assert.equal(liveTrajectoryAuthoritativeRevision(conversationId), before + 1);
});
