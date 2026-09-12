import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const guard = loader.loadModule("src/lib/system/webviewNavigationGuard.ts");

const PROD = { isMac: false, allowReloadChords: false };
const PROD_MAC = { isMac: true, allowReloadChords: false };
const DEV = { isMac: false, allowReloadChords: true };

function key(overrides) {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
  };
}

test("the whole reload family is blocked under the production config", () => {
  const reloadChords = [
    key({ key: "F5", code: "F5" }),
    key({ key: "F5", code: "F5", ctrlKey: true }),
    key({ key: "F5", code: "F5", shiftKey: true }),
    key({ key: "F5", code: "F5", ctrlKey: true, shiftKey: true }),
    key({ key: "BrowserRefresh", code: "BrowserRefresh" }),
    key({ key: "r", code: "KeyR", ctrlKey: true }),
    key({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true }),
    key({ key: "r", code: "KeyR", metaKey: true }),
    // Cyrillic layout: key is a local character while the physical key code is still KeyR.
    key({ key: "к", code: "KeyR", ctrlKey: true }),
  ];
  for (const event of reloadChords) {
    assert.equal(guard.shouldBlockBrowserKeyDefault(event, PROD), true, JSON.stringify(event));
    assert.equal(guard.shouldBlockBrowserKeyDefault(event, PROD_MAC), true, JSON.stringify(event));
  }
});

test("the dev config allows reload chords but still blocks other browser accelerators", () => {
  assert.equal(guard.shouldBlockBrowserKeyDefault(key({ key: "F5", code: "F5" }), DEV), false);
  assert.equal(
    guard.shouldBlockBrowserKeyDefault(key({ key: "r", code: "KeyR", ctrlKey: true }), DEV),
    false,
  );
  assert.equal(
    guard.shouldBlockBrowserKeyDefault(key({ key: "BrowserRefresh", code: "BrowserRefresh" }), DEV),
    false,
  );
  assert.equal(
    guard.shouldBlockBrowserKeyDefault(key({ key: "p", code: "KeyP", ctrlKey: true }), DEV),
    true,
  );
});

test("Ctrl/Cmd combinations for print, find, save, open, and view-source are blocked", () => {
  for (const [k, code] of [
    ["p", "KeyP"],
    ["f", "KeyF"],
    ["s", "KeyS"],
    ["o", "KeyO"],
    ["u", "KeyU"],
  ]) {
    assert.equal(
      guard.shouldBlockBrowserKeyDefault(key({ key: k, code, ctrlKey: true }), PROD),
      true,
      `Ctrl+${k}`,
    );
    assert.equal(
      guard.shouldBlockBrowserKeyDefault(key({ key: k, code, metaKey: true }), PROD_MAC),
      true,
      `Cmd+${k}`,
    );
  }
});

test("F3/F7 and keyboard-navigation media keys are blocked", () => {
  for (const k of [
    "F3",
    "F7",
    "BrowserBack",
    "BrowserForward",
    "BrowserHome",
    "BrowserSearch",
    "BrowserFavorites",
    "BrowserStop",
  ]) {
    assert.equal(guard.shouldBlockBrowserKeyDefault(key({ key: k, code: k }), PROD), true, k);
  }
});

test("Alt+arrow history navigation is blocked only off mac (on mac it moves the cursor by word)", () => {
  for (const k of ["ArrowLeft", "ArrowRight", "Home"]) {
    assert.equal(
      guard.shouldBlockBrowserKeyDefault(key({ key: k, code: k, altKey: true }), PROD),
      true,
      `win/linux Alt+${k}`,
    );
    assert.equal(
      guard.shouldBlockBrowserKeyDefault(key({ key: k, code: k, altKey: true }), PROD_MAC),
      false,
      `mac Option+${k}`,
    );
  }
  // Arrow keys without Alt are never blocked.
  assert.equal(
    guard.shouldBlockBrowserKeyDefault(key({ key: "ArrowLeft", code: "ArrowLeft" }), PROD),
    false,
  );
});

test("ordinary input and application shortcuts are unaffected", () => {
  const passThrough = [
    key({ key: "a", code: "KeyA" }),
    key({ key: "a", code: "KeyA", ctrlKey: true }),
    key({ key: "c", code: "KeyC", ctrlKey: true }),
    key({ key: "v", code: "KeyV", ctrlKey: true }),
    key({ key: "z", code: "KeyZ", ctrlKey: true }),
    key({ key: "Enter", code: "Enter" }),
    key({ key: "F1", code: "F1" }),
    key({ key: "F12", code: "F12" }),
    // AltGr (reported as ctrl+alt on Windows) types special characters and must be allowed through.
    key({ key: "ŕ", code: "KeyR", ctrlKey: true, altKey: true }),
    key({ key: "þ", code: "KeyP", ctrlKey: true, altKey: true }),
  ];
  for (const event of passThrough) {
    assert.equal(guard.shouldBlockBrowserKeyDefault(event, PROD), false, JSON.stringify(event));
  }
});

function createFakeWindow() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, options });
    },
    removeEventListener(type, listener) {
      const index = listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener,
      );
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch(type, event) {
      for (const entry of [...listeners]) {
        if (entry.type === type) entry.listener(event);
      }
    },
  };
}

function fakeEvent(overrides) {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    ...overrides,
  };
  return event;
}

test("installer: blocks F5 in the keydown capture phase and stops blocking after uninstall", () => {
  const win = createFakeWindow();
  const uninstall = guard.installWebviewNavigationGuard({ isMac: false }, win);

  const keydownEntry = win.listeners.find((entry) => entry.type === "keydown");
  assert.ok(keydownEntry, "keydown is registered");
  assert.equal(keydownEntry.options?.capture, true, "keydown uses the capture phase");

  const f5 = fakeEvent(key({ key: "F5", code: "F5" }));
  win.dispatch("keydown", f5);
  assert.equal(f5.defaultPrevented, true);

  uninstall();
  assert.equal(win.listeners.length, 0, "no leftover listeners after uninstall");
});

test("installer: mouse side-button forward/back are cancelled while normal clicks are unaffected", () => {
  const win = createFakeWindow();
  const uninstall = guard.installWebviewNavigationGuard({ isMac: false }, win);

  const back = fakeEvent({ button: 3 });
  win.dispatch("mouseup", back);
  assert.equal(back.defaultPrevented, true);

  const forwardDown = fakeEvent({ button: 4 });
  win.dispatch("mousedown", forwardDown);
  assert.equal(forwardDown.defaultPrevented, true);

  const leftClick = fakeEvent({ button: 0 });
  win.dispatch("mouseup", leftClick);
  assert.equal(leftClick.defaultPrevented, false);

  uninstall();
});

test("installer: in-page drag-and-drop fallback cancels navigation, while editable targets and handled events pass through", () => {
  const win = createFakeWindow();
  const uninstall = guard.installWebviewNavigationGuard({ isMac: false }, win);

  // A drag-and-drop not handled by any component: cancel the default navigation and mark it non-droppable.
  const dataTransfer = { dropEffect: "copy" };
  const dragOver = fakeEvent({ target: { tagName: "DIV" }, dataTransfer });
  win.dispatch("dragover", dragOver);
  assert.equal(dragOver.defaultPrevented, true);
  assert.equal(dataTransfer.dropEffect, "none");

  const drop = fakeEvent({ target: { tagName: "DIV" }, dataTransfer: null });
  win.dispatch("drop", drop);
  assert.equal(drop.defaultPrevented, true);

  // Dropping into an input box/rich text is a legitimate editing operation.
  for (const target of [
    { tagName: "TEXTAREA" },
    { tagName: "INPUT" },
    { tagName: "DIV", isContentEditable: true },
  ]) {
    const editableDrop = fakeEvent({ target, dataTransfer: null });
    win.dispatch("drop", editableDrop);
    assert.equal(editableDrop.defaultPrevented, false, JSON.stringify(target));
  }

  // Events already preventDefault'd by a component are left alone (dropEffect keeps the value the component set).
  const handledTransfer = { dropEffect: "move" };
  const handled = fakeEvent({ target: { tagName: "DIV" }, dataTransfer: handledTransfer });
  handled.preventDefault();
  win.dispatch("dragover", handled);
  assert.equal(handledTransfer.dropEffect, "move");

  uninstall();
});

test("installer: unhandled form submissions are cancelled by the fallback; repeated installs stay idempotent", () => {
  const win = createFakeWindow();
  const first = guard.installWebviewNavigationGuard({ isMac: false }, win);

  const submit = fakeEvent({});
  win.dispatch("submit", submit);
  assert.equal(submit.defaultPrevented, true);

  const before = win.listeners.length;
  const second = guard.installWebviewNavigationGuard({ isMac: false }, win);
  assert.equal(win.listeners.length, before, "repeated install uninstalls the old listeners first");

  second();
  assert.equal(win.listeners.length, 0);
  // Calling the old uninstall function again should neither throw nor remove the wrong listeners.
  first();
});
