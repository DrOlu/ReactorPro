import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Acceptance for useConversationStats loading/caching/throttling
// (docs/design/composer-context-stats-bar.md §4.1 behaviors 1-5, §9 hook layer).
// Renders with real react-dom, with the loadWindow host driven by a fake: first window
// + background pagination stitching, live and persisted overlap dedupe,
// authoritativeRevision invalidating and reloading, and 1s throttling.

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const doc = env.dom.window.document;

const { useConversationStats, clearConversationStatsCache, STATS_REBUILD_THROTTLE_MS } =
  env.loadModule("@liveagent/ui/lib/trajectory/useConversationStats.ts");

let clock = 1_000;
function at() {
  clock += 10;
  return clock;
}

/** One complete turn: user -> step_start -> first_token -> step_end -> turn_end. */
function turnEvents(turn, { outputTokens = 100 } = {}) {
  const start = at();
  return [
    { k: "user", t: turn, at: start, mi: turn },
    { k: "step_start", t: turn, s: 1, at: start + 10 },
    { k: "first_token", t: turn, s: 1, at: start + 60 },
    {
      k: "step_end",
      t: turn,
      s: 1,
      at: start + 260,
      st: "complete",
      u: { input: 500, output: outputTokens, cacheRead: 1_500, cacheWrite: 0 },
    },
    { k: "turn_end", t: turn, at: start + 270, st: "complete" },
  ];
}

/** A fake host that paginates events by segment; pages are given from the tail backward, matching the backend loadWindow semantics. */
function createFakeHost(pages, { truncated = false } = {}) {
  const calls = [];
  return {
    calls,
    host: {
      loadWindow: async (conversationId, beforeSegmentIndex) => {
        calls.push({ conversationId, beforeSegmentIndex });
        const index = beforeSegmentIndex === undefined ? pages.length - 1 : beforeSegmentIndex - 1;
        const page = pages[index] ?? [];
        return {
          eventsJson: JSON.stringify(page),
          truncated,
          oldestSegmentIndex: index,
          returnedSegmentCount: 1,
          totalSegmentCount: pages.length,
          hasMoreBefore: index > 0,
        };
      },
    },
  };
}

function mountHook(options) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  const seen = { current: null, renders: 0 };
  let setProps;

  function Probe(initial) {
    const [props, update] = React.useState(initial.value);
    setProps = update;
    const result = useConversationStats(props);
    seen.current = result;
    seen.renders += 1;
    return null;
  }

  return {
    seen,
    mount: async () => {
      await act(async () => {
        root.render(React.createElement(Probe, { value: options }));
      });
    },
    update: async (next) => {
      await act(async () => {
        setProps((current) => ({ ...current, ...next }));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Runs the scheduled idle/timer callbacks to completion; pagination is chain-scheduled and needs multiple rounds. */
async function drain(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

test("the first-window reading is available immediately and background pagination fills in earlier segments", async () => {
  clearConversationStatsCache();
  const pages = [turnEvents(1), turnEvents(2), turnEvents(3)];
  const { host, calls } = createFakeHost(pages);
  const probe = mountHook({
    conversationId: "c-paging",
    host,
    liveEvents: [],
    enabled: true,
  });

  await probe.mount();
  await drain();

  assert.equal(calls.length, 3, "all three segments should each be fetched once");
  assert.equal(calls[0].beforeSegmentIndex, undefined, "the first window carries no cursor");
  assert.deepEqual(
    calls.slice(1).map((call) => call.beforeSegmentIndex),
    [2, 1],
    "subsequent pagination moves forward along oldestSegmentIndex",
  );
  assert.equal(probe.seen.current.stats.turns, 3);
  assert.equal(probe.seen.current.stats.steps, 3);
  assert.equal(probe.seen.current.stats.approximate, false, "no longer approximate after reading all segments");
  assert.equal(probe.seen.current.loading, false);

  await probe.unmount();
});

test("live events overlapping with persisted ones are deduped by identity, not double-counted", async () => {
  clearConversationStatsCache();
  const shared = turnEvents(1);
  const { host } = createFakeHost([shared]);
  const probe = mountHook({
    conversationId: "c-overlap",
    host,
    // The whole turn's events also appear on the live channel, simulating a reconnect replay.
    liveEvents: shared,
    enabled: true,
  });

  await probe.mount();
  await drain();

  const stats = probe.seen.current.stats;
  assert.equal(stats.turns, 1, "a replay should not count the same turn twice");
  assert.equal(stats.steps, 1);
  assert.equal(stats.outputTokens, 100, "tokens must not be double-counted either");

  await probe.unmount();
});

test("an authoritativeRevision change discards the cache and fully reloads", async () => {
  clearConversationStatsCache();
  const first = createFakeHost([turnEvents(1), turnEvents(2)]);
  const probe = mountHook({
    conversationId: "c-revision",
    host: first.host,
    liveEvents: [],
    enabled: true,
    authoritativeRevision: 0,
  });

  await probe.mount();
  await drain();
  assert.equal(probe.seen.current.stats.turns, 2);
  const callsBefore = first.calls.length;

  // edit-resend removes the second turn: the same host now has only one segment left.
  await probe.update({ authoritativeRevision: 1 });
  await drain();

  assert.ok(first.calls.length > callsBefore, "an authoritative revision change must refetch");
  assert.equal(probe.seen.current.stats.turns, 2, "the reading converges to the history after reload");

  await probe.unmount();
});

test("switching back to the same conversation on a cache hit does not hit the backend again", async () => {
  clearConversationStatsCache();
  const { host, calls } = createFakeHost([turnEvents(1)]);
  const first = mountHook({
    conversationId: "c-cache",
    host,
    liveEvents: [],
    enabled: true,
  });
  await first.mount();
  await drain();
  const callsAfterFirst = calls.length;
  await first.unmount();

  const second = mountHook({
    conversationId: "c-cache",
    host,
    liveEvents: [],
    enabled: true,
  });
  await second.mount();
  await drain();

  assert.equal(calls.length, callsAfterFirst, "no further pagination when the cache is complete");
  assert.equal(second.seen.current.stats.turns, 1, "the reading comes directly from the cache");

  await second.unmount();
});

test("consecutive live notifications merge into a single rebuild within the 1s window", async () => {
  clearConversationStatsCache();
  const { host } = createFakeHost([turnEvents(1)]);
  const probe = mountHook({
    conversationId: "c-throttle",
    host,
    liveEvents: [],
    enabled: true,
  });
  await probe.mount();
  await drain();

  const rendersBefore = probe.seen.renders;
  // Three different live snapshots arrive in succession: only the first takes effect immediately; the rest merge into the throttle window.
  await probe.update({ liveEvents: [{ k: "user", t: 9, at: 9_000, mi: 9 }] });
  await probe.update({ liveEvents: [{ k: "user", t: 9, at: 9_000, mi: 9 }, { k: "step_start", t: 9, s: 1, at: 9_010 }] });
  await probe.update({
    liveEvents: [
      { k: "user", t: 9, at: 9_000, mi: 9 },
      { k: "step_start", t: 9, s: 1, at: 9_010 },
      { k: "first_token", t: 9, s: 1, at: 9_060 },
    ],
  });

  const rendersAfterBurst = probe.seen.renders;
  assert.ok(
    rendersAfterBurst - rendersBefore <= 4,
    `throttling should suppress rebuilds; actual increase ${rendersAfterBurst - rendersBefore}`,
  );

  // Wait past the throttle window; the last pending snapshot must be applied.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, STATS_REBUILD_THROTTLE_MS + 50));
  });
  assert.equal(probe.seen.current.stats.turns, 2, "after the window ends the reading converges to the latest live snapshot");

  await probe.unmount();
});

test("when enabled is false nothing loads and the reading is null", async () => {
  clearConversationStatsCache();
  const { host, calls } = createFakeHost([turnEvents(1)]);
  const probe = mountHook({
    conversationId: "c-disabled",
    host,
    liveEvents: [],
    enabled: false,
  });

  await probe.mount();
  await drain();

  assert.equal(calls.length, 0, "the backend should not be hit when disabled");
  assert.equal(probe.seen.current.stats, null);
  assert.equal(probe.seen.current.loading, false);

  await probe.unmount();
});

test("a truncated segment keeps the reading approximate", async () => {
  clearConversationStatsCache();
  const { host } = createFakeHost([turnEvents(1)], { truncated: true });
  const probe = mountHook({
    conversationId: "c-truncated",
    host,
    liveEvents: [],
    enabled: true,
  });

  await probe.mount();
  await drain();

  assert.equal(probe.seen.current.stats.approximate, true);

  await probe.unmount();
});

test("a conversation with no events has a null reading", async () => {
  clearConversationStatsCache();
  const { host } = createFakeHost([[]]);
  const probe = mountHook({
    conversationId: "c-empty",
    host,
    liveEvents: [],
    enabled: true,
  });

  await probe.mount();
  await drain();

  assert.equal(probe.seen.current.stats, null, "legacy conversations/text mode are hidden entirely");

  await probe.unmount();
});

test("liveOwnership semantics follow the trajectory view: an authoritative empty set converges zombies, observed keeps them running", async () => {
  // Persisted history has an unfinished step (left over from a process crash).
  const orphan = [
    { k: "user", t: 1, at: 5_000, mi: 1 },
    { k: "step_start", t: 1, s: 1, at: 5_010 },
  ];

  clearConversationStatsCache();
  const desktop = mountHook({
    conversationId: "c-ownership-desktop",
    host: createFakeHost([orphan]).host,
    liveEvents: [],
    liveOwnership: "authoritative",
    enabled: true,
  });
  await desktop.mount();
  await drain();
  assert.equal(
    desktop.seen.current.stats.llmRunningSinceAt,
    null,
    "an empty live set on the desktop is authoritative evidence, so the leftover running converges to aborted",
  );
  await desktop.unmount();

  clearConversationStatsCache();
  const web = mountHook({
    conversationId: "c-ownership-web",
    host: createFakeHost([orphan]).host,
    liveEvents: [],
    liveOwnership: "observed",
    enabled: true,
  });
  await web.mount();
  await drain();
  assert.equal(
    web.seen.current.stats.llmRunningSinceAt,
    5_010,
    "the observer side does not judge an interruption before receiving the live stream, so the running segment is kept",
  );
  await web.unmount();
});
