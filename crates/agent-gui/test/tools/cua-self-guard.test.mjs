import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const guard = loader.loadModule("src/lib/tools/cuaSelfGuard.ts");

const {
  refuseSelfTargetedCall,
  refuseSelfRegionCall,
  usesDesktopScreenCoordinates,
  stripSelfFromJsonText,
  resetCuaSelfGuardCaches,
  isDesktopKeyboardCall,
  refuseDesktopKeyboardCall,
} = guard;

const SELF_PID = 4242;
const OTHER_PID = 99;

test.beforeEach(() => resetCuaSelfGuardCaches());

test("calls targeting the host pid are rejected, other pids pass", () => {
  assert.ok(refuseSelfTargetedCall({ pid: SELF_PID }, SELF_PID));
  assert.equal(refuseSelfTargetedCall({ pid: OTHER_PID }, SELF_PID), null);
  assert.equal(refuseSelfTargetedCall({}, SELF_PID), null);
  assert.equal(refuseSelfTargetedCall(undefined, SELF_PID), null);
});

test("when the host pid is unavailable, do not intercept — better not to intercept than to hit a legitimate target", () => {
  assert.equal(refuseSelfTargetedCall({ pid: SELF_PID }, null), null);
});

test("window enumeration results have host records removed", () => {
  const payload = JSON.stringify({
    windows: [
      { window_id: 1, pid: SELF_PID, app_name: "ReactorPro" },
      { window_id: 2, pid: OTHER_PID, app_name: "Safari" },
    ],
  });
  const stripped = JSON.parse(stripSelfFromJsonText(payload, SELF_PID));
  assert.deepEqual(
    stripped.windows.map((w) => w.pid),
    [OTHER_PID],
  );
});

test("the window_id learned during filtering makes later window_id-based calls intercepted too", () => {
  // Before filtering it cannot be intercepted: only cua-driver knows the mapping between
  // window_id and pid.
  assert.equal(refuseSelfTargetedCall({ window_id: 1 }, SELF_PID), null);

  stripSelfFromJsonText(
    JSON.stringify([{ window_id: 1, pid: SELF_PID }, { window_id: 2, pid: OTHER_PID }]),
    SELF_PID,
  );

  assert.ok(refuseSelfTargetedCall({ window_id: 1 }, SELF_PID));
  assert.equal(refuseSelfTargetedCall({ window_id: 2 }, SELF_PID), null);
});

test("host records nested in structures are removed as well", () => {
  const payload = JSON.stringify({
    desktop: { apps: [{ pid: SELF_PID }, { pid: OTHER_PID }] },
  });
  const stripped = JSON.parse(stripSelfFromJsonText(payload, SELF_PID));
  assert.deepEqual(stripped.desktop.apps, [{ pid: OTHER_PID }]);
});

test("non-JSON payloads and payloads without host records are returned as-is", () => {
  const plain = "Screenshot captured: 1920x1080";
  assert.equal(stripSelfFromJsonText(plain, SELF_PID), plain);

  const malformed = "{not json";
  assert.equal(stripSelfFromJsonText(malformed, SELF_PID), malformed);

  // With no match it must not be re-serialized — avoiding needlessly rewriting the original
  // format the model sees.
  const clean = JSON.stringify({ windows: [{ window_id: 2, pid: OTHER_PID }] });
  assert.equal(stripSelfFromJsonText(clean, SELF_PID), clean);
});

test("no filtering when the host pid is unavailable", () => {
  const payload = JSON.stringify([{ pid: SELF_PID }]);
  assert.equal(stripSelfFromJsonText(payload, null), payload);
});

test("host pid / window_id wrapped inside target are intercepted as well", () => {
  // The upstream convention writes the target into the target object. Looking only at
  // top-level fields would let the official form pass straight through.
  assert.ok(
    refuseSelfTargetedCall({ target: { kind: "window", pid: SELF_PID }, x: 10, y: 10 }, SELF_PID),
  );
  assert.equal(
    refuseSelfTargetedCall({ target: { kind: "window", pid: OTHER_PID }, x: 10, y: 10 }, SELF_PID),
    null,
  );

  stripSelfFromJsonText(JSON.stringify([{ window_id: 7, pid: SELF_PID }]), SELF_PID);
  assert.ok(refuseSelfTargetedCall({ target: { kind: "window", window_id: 7 } }, SELF_PID));
  assert.equal(refuseSelfTargetedCall({ target: { kind: "window", window_id: 8 } }, SELF_PID), null);
});

test("aliases such as camelCase and owner_pid are covered too", () => {
  assert.ok(refuseSelfTargetedCall({ target: { processId: SELF_PID } }, SELF_PID));
  assert.ok(refuseSelfTargetedCall({ target: { owner_pid: SELF_PID } }, SELF_PID));

  stripSelfFromJsonText(JSON.stringify([{ windowId: 11, pid: SELF_PID }]), SELF_PID);
  assert.ok(refuseSelfTargetedCall({ windowId: 11 }, SELF_PID));
});

test("desktop-coordinate detection: an explicit window target does not count; desktop targets and flat coordinates both do", () => {
  assert.equal(
    usesDesktopScreenCoordinates({ target: { kind: "window", window_id: 9 }, x: 10, y: 10 }),
    false,
  );
  assert.ok(usesDesktopScreenCoordinates({ target: { kind: "desktop" }, x: 800, y: 400 }));
  // A flat form without target is treated as absolute screen coordinates.
  assert.ok(usesDesktopScreenCoordinates({ x: 800, y: 400 }));
  // Calls without coordinates are unrelated to this check.
  assert.equal(usesDesktopScreenCoordinates({ target: { kind: "desktop" } }), false);
  assert.equal(usesDesktopScreenCoordinates(undefined), false);
});

test("desktop coordinates inside the host window rectangle are rejected; those outside pass", () => {
  const rects = [{ x: 100, y: 100, width: 400, height: 300 }];

  assert.ok(refuseSelfRegionCall({ target: { kind: "desktop" }, x: 200, y: 200 }, rects));
  // Boundaries included: a click on the window border also falls on the host window.
  assert.ok(refuseSelfRegionCall({ x: 100, y: 100 }, rects));
  assert.ok(refuseSelfRegionCall({ x: 500, y: 400 }, rects));

  assert.equal(refuseSelfRegionCall({ x: 900, y: 200 }, rects), null);
  assert.equal(refuseSelfRegionCall({ x: 200, y: 900 }, rects), null);

  // For multi-point arguments like drags, if either end falls inside the host window it is
  // rejected.
  assert.ok(refuseSelfRegionCall({ start: { x: 900, y: 900 }, end: { x: 200, y: 200 } }, rects));

  // When the rectangle is unavailable (all host windows invisible / query failed), do not
  // intercept; better not to intercept than to hit a legitimate target.
  assert.equal(refuseSelfRegionCall({ x: 200, y: 200 }, []), null);
});

test("MCP text with a summary prefix is filtered too, with surrounding text preserved as-is", () => {
  const payload = `✅ Windows listed\n${JSON.stringify({
    windows: [
      { window_id: 1, pid: SELF_PID, app_name: "ReactorPro" },
      { window_id: 2, pid: OTHER_PID, app_name: "Safari" },
    ],
  })}\n(2 windows)`;

  const stripped = stripSelfFromJsonText(payload, SELF_PID);
  assert.ok(stripped.startsWith("✅ Windows listed\n"));
  assert.ok(stripped.endsWith("\n(2 windows)"));
  assert.equal(stripped.includes("ReactorPro"), false);

  // The host's window_id was learned along the way.
  assert.ok(refuseSelfTargetedCall({ window_id: 1 }, SELF_PID));
});

test("all JSON segments in one text are filtered, not just the first", () => {
  const payload = [
    "✅ Windows listed",
    JSON.stringify({ windows: [{ window_id: 1, pid: SELF_PID, app_name: "ReactorPro" }] }),
    "and apps:",
    JSON.stringify({ apps: [{ pid: SELF_PID, name: "ReactorPro" }, { pid: OTHER_PID }] }),
  ].join("\n");

  const stripped = stripSelfFromJsonText(payload, SELF_PID);
  assert.equal(stripped.includes("ReactorPro"), false);
  assert.ok(stripped.includes("and apps:"));
  assert.ok(stripped.includes(String(OTHER_PID)));
});

test("overly deep arguments are rejected rather than allowed when the scan cannot finish", () => {
  // Allowing when the scan cannot finish is a ready-made bypass: just bury the target deep.
  let deep = { pid: SELF_PID };
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  assert.ok(refuseSelfTargetedCall(deep, SELF_PID));

  // Deep structures without suspicious fields are rejected too — an unfinished scan means
  // unconfirmed.
  let benign = { note: "x" };
  for (let i = 0; i < 20; i++) benign = { nested: benign };
  assert.ok(refuseSelfTargetedCall(benign, SELF_PID));

  // Normal depth is unaffected.
  assert.equal(
    refuseSelfTargetedCall({ target: { kind: "window", window_id: 42 } }, SELF_PID),
    null,
  );
});

test("desktop keyboard calls with no explicit target are rejected when the host is in the foreground", () => {
  // v0.22.0 contract: press_key only requires key, hotkey only requires keys, type_text only
  // requires text; pid / window_id / coordinates are all optional, and input is delivered to
  // the foreground app. The two gates by pid and by coordinates do not participate at all for
  // such calls — skipping the foreground check is a ready-made bypass.
  const cases = [
    ["press_key", { scope: "desktop", key: "return" }],
    ["press_key", { target: { kind: "desktop", display_id: "primary" }, key: "return" }],
    ["hotkey", { scope: "desktop", keys: ["cmd", "q"] }],
    ["type_text", { scope: "desktop", text: "allow" }],
    // Flat form: not even scope is present, yet the delivery semantics are still the foreground.
    ["press_key", { key: "return" }],
  ];
  for (const [tool, args] of cases) {
    assert.ok(isDesktopKeyboardCall(tool, args), `${tool} should be recognized as a focus-delivery call`);
    assert.ok(
      refuseDesktopKeyboardCall(tool, args, SELF_PID, SELF_PID),
      `${tool} should be rejected when the host is in the foreground`,
    );
  }
});

test("keyboard calls pass when another app is in the foreground", () => {
  assert.equal(
    refuseDesktopKeyboardCall("press_key", { scope: "desktop", key: "return" }, SELF_PID, OTHER_PID),
    null,
  );
  assert.equal(
    refuseDesktopKeyboardCall("type_text", { scope: "desktop", text: "hi" }, SELF_PID, OTHER_PID),
    null,
  );
});

test("when the foreground cannot be determined, fail-closed and reject rather than allow", () => {
  // An unavailable window rectangle may be allowed (the real target below the rectangle is what
  // gets hit); an unavailable foreground may not — keyboard input has no such ambiguity, and
  // allowing it means the model can type any key into the host.
  assert.ok(refuseDesktopKeyboardCall("press_key", { scope: "desktop", key: "return" }, SELF_PID, null));
});

test("keyboard calls with an explicit non-host identity skip the foreground check", () => {
  // Calls carrying pid / window_id in the contract (including the desktop scope + pid
  // background-delivery form) are delivered to that window and do not follow focus; the host's
  // own identity has already been rejected by the pid gate before this.
  assert.equal(
    isDesktopKeyboardCall("press_key", { target: { kind: "window", pid: OTHER_PID }, key: "return" }),
    false,
  );
  assert.equal(
    isDesktopKeyboardCall("type_text", { scope: "desktop", pid: OTHER_PID, text: "hi" }),
    false,
  );
  assert.equal(
    refuseDesktopKeyboardCall(
      "press_key",
      { target: { kind: "window", pid: OTHER_PID }, key: "return" },
      SELF_PID,
      SELF_PID,
    ),
    null,
  );
});

test("non-keyboard tools are unaffected by the foreground check", () => {
  assert.equal(isDesktopKeyboardCall("click", { scope: "desktop", x: 1, y: 2 }), false);
  assert.equal(isDesktopKeyboardCall("get_desktop_state", {}), false);
  assert.equal(
    refuseDesktopKeyboardCall("click", { scope: "desktop", x: 1, y: 2 }, SELF_PID, SELF_PID),
    null,
  );
});

test("argument-shape fallback: unknown tool names carrying key / keys are treated as keyboard calls too", () => {
  // When upstream renames or adds tools like hold_key, payload features can still identify them.
  assert.ok(isDesktopKeyboardCall("hold_key", { scope: "desktop", key: "shift" }));
  assert.ok(isDesktopKeyboardCall("send_keys", { keys: ["cmd", "w"] }));
  // The text field deliberately does not participate in the shape fallback: clipboard_write /
  // search-type tools also carry text, and their delivery semantics are unrelated to focus;
  // type_text itself is already covered by the tool name.
  assert.equal(isDesktopKeyboardCall("clipboard_write", { text: "hello" }), false);
  assert.equal(isDesktopKeyboardCall("find_element", { scope: "desktop", text: "OK" }), false);
});

test("bracket pairing in JSON fragments recognizes string literals", () => {
  const payload = `Result:\n${JSON.stringify({
    windows: [{ window_id: 3, pid: SELF_PID, title: 'a } b " c' }],
  })}`;
  const stripped = stripSelfFromJsonText(payload, SELF_PID);
  assert.equal(stripped.includes("window_id"), false);
  assert.ok(stripped.startsWith("Result:\n"));
});
