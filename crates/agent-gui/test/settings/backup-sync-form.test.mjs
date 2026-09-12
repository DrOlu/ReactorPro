import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * Pure logic of the WebDAV sync settings panel. It covers the decisions users only notice when
 * something goes wrong: whether a connection can be auto-tested after saving, and when the
 * background-sync failure banner appears and disappears.
 */

const loader = createTsModuleLoader();
const form = loader.loadModule("src/pages/settings/backupSyncForm.ts");

/** A complete, valid backend view; each test overrides fields as needed. */
function makeView(overrides = {}) {
  return {
    url: "https://dav.example.test/dav/",
    username: "alice",
    hasPassword: true,
    remoteDir: "liveagent",
    profile: "default",
    autoSync: false,
    lastSyncAt: null,
    lastError: null,
    ...overrides,
  };
}

test("preset detection matches on host, not substring", () => {
  assert.equal(form.detectPreset("https://dav.jianguoyun.com/dav/"), "jianguoyun");
  // Key point: `dav.jianguoyun.com.evil.test` is not Jianguoyun, and only a host-based check catches it.
  assert.equal(form.detectPreset("https://dav.jianguoyun.com.evil.test/dav/"), "custom");
  assert.equal(form.detectPreset("https://server/remote.php/dav/files/USER/"), "nextcloud");
  assert.equal(form.detectPreset("http://192.168.1.2:5005/"), "synology");
  assert.equal(form.detectPreset("http://192.168.1.2:5006/"), "synology");
  assert.equal(form.detectPreset(""), "custom");
  assert.equal(form.detectPreset("not a url"), "custom");
});

test("the form starts with an empty password and is clean right after loading", () => {
  const view = makeView({ autoSync: true, lastSyncAt: 1_700_000_000_000 });
  const loaded = form.formFromView(view);

  // The backend never returns the password; if the form backfilled a placeholder, submitting as-is would write the placeholder as the real password.
  assert.equal(loaded.password, "");
  assert.equal(loaded.passwordTouched, false);
  assert.equal(form.isDirty(loaded, view), false, "a freshly loaded form must not be treated as having unsaved changes");
});

test("touching the password alone makes the form dirty", () => {
  const view = makeView();
  const touched = { ...form.formFromView(view), password: "s3cret", passwordTouched: true };

  // The password is not in the view, so only passwordTouched can decide --- otherwise after changing
  // the password the "Test connection" button would still be enabled yet test the old stored password.
  assert.equal(form.isDirty(touched, view), true);
});

test("a null view is always dirty so upload/download stay disabled before load", () => {
  assert.equal(form.isDirty(form.emptyForm(), null), true);
});

test("connection test is skipped until every credential field is filled", () => {
  assert.equal(form.canTestSyncConnection(makeView()), true);
  // Filling in only the URL and saving a first version is a normal action; auto-testing the connection
  // then necessarily fails and would render a successful save as a red error.
  assert.equal(form.canTestSyncConnection(makeView({ username: "" })), false);
  assert.equal(form.canTestSyncConnection(makeView({ hasPassword: false })), false);
  assert.equal(form.canTestSyncConnection(makeView({ url: "" })), false);
});

test("an auto-sync failure event raises the persistent banner", () => {
  const prev = makeView({ lastSyncAt: 1_700_000_000_000 });
  const next = form.applySyncStatusEvent(prev, {
    lastSyncAt: null,
    lastError: "WebDAV authentication failed (401)",
  });

  assert.equal(next.lastError, "WebDAV authentication failed (401)");
  // A failure must not wipe the last success time --- users need to know when the configuration stopped syncing.
  assert.equal(next.lastSyncAt, prev.lastSyncAt);
  assert.equal(form.isAutoSyncSuccess({ lastSyncAt: null, lastError: "boom" }), false);
});

test("a later success clears the stale failure banner", () => {
  const failed = form.applySyncStatusEvent(makeView(), { lastSyncAt: null, lastError: "boom" });
  const recovered = form.applySyncStatusEvent(failed, {
    lastSyncAt: 1_700_000_123_000,
    lastError: null,
  });

  assert.equal(recovered.lastError, null, "the old banner must disappear once the link recovers");
  assert.equal(recovered.lastSyncAt, 1_700_000_123_000);
  assert.equal(form.isAutoSyncSuccess({ lastSyncAt: 1_700_000_123_000, lastError: null }), true);
});

test("status events before the view loads are ignored instead of synthesizing one", () => {
  // When an event arrives before the view has finished loading, return null rather than synthesizing a partial view from the event.
  assert.equal(form.applySyncStatusEvent(null, { lastSyncAt: 1, lastError: null }), null);

  // An event with neither a time nor an error does not count as success, and must not produce a new object that triggers a pointless re-render.
  const view = makeView();
  assert.equal(form.applySyncStatusEvent(view, { lastSyncAt: null, lastError: null }), view);
  assert.equal(form.isAutoSyncSuccess({ lastSyncAt: null, lastError: null }), false);
});
