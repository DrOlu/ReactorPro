import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Merge semantics of applyTerminalEventToSessions. Core invariant: apart from created, no event
// may append an unknown sessionId to the list -- close() races the PTY reader thread, so a late
// exit can arrive after closed, and appending it blindly would resurrect the just-closed session
// as a ghost (a dock tab whose attach is guaranteed to fail, i.e. the "create -> close -> terminal
// session not found" scenario).

const loader = createTsModuleLoader();
const { applyTerminalEventToSessions } = loader.loadModule(
  "../agent-ui/src/lib/terminal/sessionStore.ts",
);

function session(id, overrides = {}) {
  return {
    id,
    projectPathKey: "/repo",
    cwd: "/repo",
    shell: "zsh",
    title: id,
    kind: "local",
    cols: 80,
    rows: 24,
    createdAt: 1,
    updatedAt: 1,
    running: true,
    ...overrides,
  };
}

test("closed removes the session; a late exit for the same id does not resurrect it", () => {
  const initial = [session("s-1"), session("s-2")];
  const afterClosed = applyTerminalEventToSessions(initial, {
    kind: "closed",
    sessionId: "s-1",
    projectPathKey: "/repo",
  });
  assert.deepEqual(
    afterClosed.map((entry) => entry.id),
    ["s-2"],
  );
  // A late exit re-sent after the reader thread loses the race: full session record, id no longer in the list.
  const afterLateExit = applyTerminalEventToSessions(afterClosed, {
    kind: "exit",
    sessionId: "s-1",
    projectPathKey: "/repo",
    session: session("s-1", { running: false, exitCode: 0 }),
  });
  assert.deepEqual(
    afterLateExit.map((entry) => entry.id),
    ["s-2"],
    "late exit resurrected the closed session",
  );
});

test("only created appends an unknown session", () => {
  const initial = [session("s-1")];
  for (const kind of ["exit", "resized", "renamed", "reconnecting", "reconnected"]) {
    const next = applyTerminalEventToSessions(initial, {
      kind,
      sessionId: "s-9",
      projectPathKey: "/repo",
      session: session("s-9"),
    });
    assert.deepEqual(
      next.map((entry) => entry.id),
      ["s-1"],
      `${kind} appended an unknown session`,
    );
  }
  const created = applyTerminalEventToSessions(initial, {
    kind: "created",
    sessionId: "s-2",
    projectPathKey: "/repo",
    session: session("s-2"),
  });
  assert.deepEqual(
    created.map((entry) => entry.id).sort(),
    ["s-1", "s-2"],
  );
});

test("known sessions still merge updates from any event kind", () => {
  const initial = [session("s-1")];
  const next = applyTerminalEventToSessions(initial, {
    kind: "exit",
    sessionId: "s-1",
    projectPathKey: "/repo",
    session: session("s-1", { running: false, exitCode: 1 }),
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].running, false);
  assert.equal(next[0].exitCode, 1);
});

test("output events never mutate membership", () => {
  const initial = [session("s-1")];
  const next = applyTerminalEventToSessions(initial, {
    kind: "output",
    sessionId: "s-9",
    projectPathKey: "/repo",
    session: session("s-9"),
  });
  assert.deepEqual(
    next.map((entry) => entry.id),
    ["s-1"],
  );
});
