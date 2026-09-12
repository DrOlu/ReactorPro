import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * Pure logic for the CUA settings page. Everything it covers is a judgment "only discovered when something
 * goes wrong": compute the wrong policy key and the approval tier shown on the page differs from the one actually
 * enforced; miss the timeout clamp and "6" is stored as 6ms; omit the drift check and the UI shows a path that
 * would never actually be executed.
 */

const loader = createTsModuleLoader();
const form = loader.loadModule("../agent-ui/src/pages/settings/cuaDriverForm.ts");

const managed = (over = {}) => ({
  id: "cua-driver",
  enabled: true,
  transport: "stdio",
  command: "/Users/x/.local/bin/cua-driver",
  args: ["mcp"],
  url: "",
  timeoutMs: 60_000,
  ...over,
});

test.beforeEach(() => form.resetCuaProbeCache());

test("managed entry lookup is case- and whitespace-insensitive", () => {
  const servers = [managed({ id: "other" }), managed({ id: " CUA-Driver " })];
  assert.equal(form.findCuaDriverServer(servers)?.id, " CUA-Driver ");
  assert.equal(form.findCuaDriverServerIndex(servers), 1);
  assert.equal(form.findCuaDriverServer([]), undefined);
  assert.equal(form.findCuaDriverServerIndex([]), -1);
});

test("the policy key follows the literal id from the entry", () => {
  // At runtime the lookup uses the literal server:CUA-DRIVER; if server:cua-driver were hardcoded here, the
  // tier shown on the page would differ from the one actually enforced.
  assert.equal(form.cuaServerPolicyKey(managed({ id: "CUA-DRIVER" })), "server:CUA-DRIVER");
  assert.equal(form.cuaServerPolicyKey(managed()), "server:cua-driver");
  // Falls back to the constant when the entry does not exist yet.
  assert.equal(form.cuaServerPolicyKey(undefined), "server:cua-driver");
});

test("the default is ask, and explicit configuration wins", () => {
  assert.equal(form.cuaDefaultPolicy(managed()), "ask");
  assert.equal(form.readCuaPolicy(undefined, managed()), "ask");
  assert.equal(form.readCuaPolicy({ "server:cua-driver": "allow" }, managed()), "allow");
});

test("reads follow the same candidate order as runtime: literal first, normalized as fallback", () => {
  // A legacy config with the id written as CUA-DRIVER but the policy on the normalized key. At runtime it falls
  // back to server:cua-driver and reads allow; if this page only looked up the literal key it would show ask --
  // the permission state told to the user would differ from the one actually enforced.
  const entry = managed({ id: "CUA-DRIVER" });
  assert.equal(form.readCuaPolicy({ "server:cua-driver": "allow" }, entry), "allow");
  // The literal key takes precedence over the normalized key, consistent with runtime.
  assert.equal(
    form.readCuaPolicy({ "server:CUA-DRIVER": "deny", "server:cua-driver": "allow" }, entry),
    "deny",
  );
  assert.deepEqual(form.cuaPolicyKeyCandidates(entry), [
    "server:CUA-DRIVER",
    "server:cua-driver",
  ]);
});

test("policy write-back: delete the key only when equal to the default, and clear case duplicates", () => {
  const entry = managed({ id: "CUA-DRIVER" });

  // "Always allow" must be explicitly persisted -- deleting it would fall back to ask.
  assert.deepEqual(form.applyCuaPolicy(undefined, entry, "allow"), {
    "server:CUA-DRIVER": "allow",
  });

  // Returning to the default deletes the key; an empty table returns undefined, consistent with other settings.
  assert.equal(form.applyCuaPolicy({ "server:CUA-DRIVER": "allow" }, entry, "ask"), undefined);

  // The duplicate on the normalized key is cleared as well, or resolveToolPolicy's fallback would read the stale value.
  assert.deepEqual(
    form.applyCuaPolicy({ "server:cua-driver": "allow", Bash: "deny" }, entry, "deny"),
    { Bash: "deny", "server:CUA-DRIVER": "deny" },
  );

  // Other tools' policies are unaffected.
  assert.deepEqual(form.applyCuaPolicy({ Bash: "deny" }, managed(), "ask"), { Bash: "deny" });
});

test("timeout clamping: invalid values fall back, valid values are bound by the limits", () => {
  assert.equal(form.clampCuaTimeoutMs("90000", 60_000), 90_000);
  assert.equal(form.clampCuaTimeoutMs("  120000  ", 60_000), 120_000);
  // Upper bound.
  assert.equal(form.clampCuaTimeoutMs("99999999", 60_000), form.CUA_MAX_TIMEOUT_MS);
  // Lower bound: a value like 6ms effectively disables the feature, since every call would inevitably time out.
  assert.equal(form.clampCuaTimeoutMs("6", 60_000), form.CUA_MIN_TIMEOUT_MS);
  // Invalid input falls back to the current value, not to some constant -- otherwise clearing the input box
  // would silently change it to the default.
  assert.equal(form.clampCuaTimeoutMs("", 30_000), 30_000);
  assert.equal(form.clampCuaTimeoutMs("abc", 30_000), 30_000);
  assert.equal(form.clampCuaTimeoutMs("-5", 30_000), 30_000);
  assert.equal(form.clampCuaTimeoutMs("0", 30_000), 30_000);
});

test("entries are generated from probe results, and the manifest-provided invocation wins over the bare path", () => {
  const config = form.buildCuaServerConfig({
    installed: true,
    path: "/usr/local/bin/cua-driver",
    mcpCommand: "/Users/x/.local/bin/cua-driver",
    mcpArgs: ["mcp", "--verbose"],
  });
  assert.equal(config.id, "cua-driver");
  assert.equal(config.command, "/Users/x/.local/bin/cua-driver");
  assert.deepEqual(config.args, ["mcp", "--verbose"]);

  // Falls back when the manifest does not provide it. Deliberately without --direct: that would attribute TCC to the host process.
  const fallback = form.buildCuaServerConfig({ installed: true, path: "/usr/local/bin/cua-driver" });
  assert.equal(fallback.command, "/usr/local/bin/cua-driver");
  assert.deepEqual(fallback.args, ["mcp"]);
  assert.equal(fallback.args.includes("--direct"), false);
});

test("displays the command that will be executed, not the one that happened to be probed", () => {
  const probe = { installed: true, path: "/usr/local/bin/cua-driver" };
  const entry = managed({ command: "/opt/custom/cua-driver" });

  assert.equal(form.cuaDisplayCommand(entry, probe), "/opt/custom/cua-driver");
  // Falls back to the probed path only when there is no entry.
  assert.equal(form.cuaDisplayCommand(undefined, probe), "/usr/local/bin/cua-driver");
  assert.equal(form.cuaDisplayCommand(undefined, null), null);
});

test("config drift: reported when they differ, not when they match or the information is incomplete", () => {
  const probe = { installed: true, path: "/usr/local/bin/cua-driver" };

  assert.deepEqual(form.cuaCommandDrift(managed({ command: "/opt/custom/cua-driver" }), probe), {
    configured: "/opt/custom/cua-driver",
    probed: "/usr/local/bin/cua-driver",
  });
  assert.equal(form.cuaCommandDrift(managed({ command: probe.path }), probe), null);
  assert.equal(form.cuaCommandDrift(undefined, probe), null);
  assert.equal(form.cuaCommandDrift(managed(), null), null);

  // Compares the one that would actually launch: when the manifest provides the invocation, that wins.
  assert.equal(
    form.cuaCommandDrift(managed({ command: "/from/manifest/cua-driver" }), {
      installed: true,
      path: "/usr/local/bin/cua-driver",
      mcpCommand: "/from/manifest/cua-driver",
    }),
    null,
  );
});

test("realigning the command changes only command / args and preserves other customizations", () => {
  const entry = managed({ command: "/stale/cua-driver", args: ["mcp"], timeoutMs: 123_000 });
  const next = form.realignCuaServerConfig(entry, {
    installed: true,
    path: "/usr/local/bin/cua-driver",
    mcpArgs: ["mcp", "--verbose"],
  });
  assert.equal(next.command, "/usr/local/bin/cua-driver");
  assert.deepEqual(next.args, ["mcp", "--verbose"]);
  assert.equal(next.timeoutMs, 123_000, "a user-modified timeout should not be overwritten as a side effect");
  assert.equal(next.enabled, true);
});

test("the probe cache expires by TTL", () => {
  const probe = { installed: true, path: "/usr/local/bin/cua-driver" };
  const permissions = { supported: true, accessibility: true, screenRecording: true };

  assert.equal(form.readCuaProbeCache(0), null);

  form.writeCuaProbeCache(probe, permissions, 1_000);
  assert.equal(form.readCuaProbeCache(1_000)?.probe, probe);
  assert.equal(form.readCuaProbeCache(1_000 + form.CUA_PROBE_CACHE_TTL_MS)?.probe, probe);
  assert.equal(form.readCuaProbeCache(1_001 + form.CUA_PROBE_CACHE_TTL_MS), null);
});

test("when the authorization state just changed, only that half is updated and the probe result is not invalidated", () => {
  const probe = { installed: true, path: "/usr/local/bin/cua-driver" };
  form.writeCuaProbeCache(probe, null, 1_000);

  const granted = { supported: true, accessibility: true, screenRecording: true };
  form.patchCuaProbeCachePermissions(granted);

  const cached = form.readCuaProbeCache(1_000);
  assert.equal(cached?.probe, probe);
  assert.equal(cached?.permissions, granted);
});
