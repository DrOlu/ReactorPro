import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const toolPolicy = loader.loadModule("src/lib/tools/toolPolicy.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

const { resolveToolPolicy } = toolPolicy;
const { normalizeToolPolicies } = settings;

const meta = (over = {}) => ({
  groupId: "system",
  kind: "x",
  isReadOnly: false,
  displayCategory: "system",
  ...over,
});

test("explicit policy takes precedence over any default inference", () => {
  const policies = { Bash: "deny", plugin_a_x: "allow", Read: "ask" };
  assert.equal(resolveToolPolicy("Bash", meta({ groupId: "shell" }), policies), "deny");
  assert.equal(resolveToolPolicy("plugin_a_x", meta({ groupId: "plugin" }), policies), "allow");
  // An explicit ask overrides the always-allow default for read-only tools
  assert.equal(resolveToolPolicy("Read", meta({ isReadOnly: true }), policies), "ask");
});

test("default: read-only tools are always allowed", () => {
  assert.equal(resolveToolPolicy("Grep", meta({ isReadOnly: true, groupId: "fs" }), undefined), "allow");
  // Even a plugin's read-only tool is not blocked by default (reads have no side effects)
  assert.equal(
    resolveToolPolicy("plugin_a_read", meta({ isReadOnly: true, groupId: "plugin" }), undefined),
    "allow",
  );
});

test("default: built-in/mcp/unknown tools allow", () => {
  assert.equal(resolveToolPolicy("Bash", meta({ groupId: "shell" }), undefined), "allow");
  assert.equal(resolveToolPolicy("mcp_s_t", meta({ groupId: "mcp" }), undefined), "allow");
  // No metadata (unknown name) must not create a regression → allow
  assert.equal(resolveToolPolicy("Mystery", undefined, undefined), "allow");
});

test("normalizeToolPolicies drops invalid values and empty keys; an empty table normalizes to undefined", () => {
  assert.equal(normalizeToolPolicies(undefined), undefined);
  assert.equal(normalizeToolPolicies({ "": "deny", Bash: "nope" }), undefined);
  assert.deepEqual(normalizeToolPolicies({ Bash: "ask", " Write ": "deny", X: 1 }), {
    Bash: "ask",
    Write: "deny",
  });
});

test("normalizeSystemSettings passes through toolPolicies and does not error when a legacy snapshot lacks it", () => {
  const withPolicies = settings.normalizeSystemSettings({ toolPolicies: { Bash: "deny" } });
  assert.deepEqual(withPolicies.toolPolicies, { Bash: "deny" });
  const legacy = settings.normalizeSystemSettings({});
  assert.equal(legacy.toolPolicies, undefined);
});

// cua-driver is integrated as an ordinary MCP server, and its tools' groupId is "mcp". If it
// relied only on the "mcp defaults to allow" rule, kill_app / type_text / clipboard_write would be
// implicitly permitted.
const cuaDriverMeta = (over = {}) => ({
  groupId: "mcp",
  kind: "mcp",
  isReadOnly: false,
  displayCategory: "mcp",
  serverId: "cua-driver",
  // Computed and carried down by mcpServerDefaults from the server config when building the tool table.
  serverPolicyDefault: "ask",
  ...over,
});

test("cua-driver defaults to ask: with no user policy it does not take mcp's allow default", () => {
  assert.equal(resolveToolPolicy("mcp_cua-driver_click", cuaDriverMeta(), undefined), "ask");
  // A read-only tool still asks: a screenshot hands the entire desktop content to the model.
  assert.equal(
    resolveToolPolicy("mcp_cua-driver_get_desktop_state", cuaDriverMeta({ isReadOnly: true }), undefined),
    "ask",
  );
  // Other MCP servers are unaffected and remain allow.
  assert.equal(
    resolveToolPolicy(
      "mcp_other_t",
      cuaDriverMeta({ serverId: "other", serverPolicyDefault: undefined }),
      undefined,
    ),
    "allow",
  );
});

test("a user's explicit policy overrides cua-driver's ask default", () => {
  const meta = cuaDriverMeta();
  assert.equal(resolveToolPolicy("mcp_cua-driver_click", meta, { "server:cua-driver": "deny" }), "deny");
  assert.equal(
    resolveToolPolicy("mcp_cua-driver_click", meta, { "server:cua-driver": "allow" }),
    "allow",
  );
  assert.equal(
    resolveToolPolicy("mcp_cua-driver_click", meta, { "mcp_cua-driver_click": "deny" }),
    "deny",
  );
});

test("the server-level hardcoded default takes precedence over a group:mcp user policy", () => {
  // The user sets "all MCP tools" to allow, but cua-driver still stays ask on its own — a
  // group-level permit should not incidentally permit a server that can type on the keyboard and
  // kill processes; to permit it you must write server: explicitly.
  assert.equal(
    resolveToolPolicy("mcp_cua-driver_click", cuaDriverMeta(), { "group:mcp": "allow" }),
    "ask",
  );
});

const defaults = loader.loadModule("../agent-ui/src/contracts/mcpServerDefaults.ts");

test("the hardcoded default is decided by server config, not by id", () => {
  assert.equal(defaults.hardcodedServerPolicyDefault({ id: "cua-driver" }), "ask");
  assert.equal(defaults.hardcodedServerPolicyDefault({ id: "other" }), undefined);
  assert.equal(defaults.effectiveServerPolicyDefault({ id: "cua-driver" }), "ask");
  assert.equal(defaults.effectiveServerPolicyDefault({ id: "other" }), "allow");
  assert.equal(defaults.effectiveServerPolicyDefault(undefined), "allow");
});

test("id casing and whitespace do not affect the decision", () => {
  // A config written as CUA-DRIVER is still recognized as a managed entry: if this lookup missed,
  // the default would silently fall back from ask to mcp's catch-all allow — a security-side
  // default defeated by casing.
  assert.equal(defaults.hardcodedServerPolicyDefault({ id: "CUA-DRIVER" }), "ask");
  assert.equal(defaults.hardcodedServerPolicyDefault({ id: " Cua-Driver " }), "ask");
  assert.ok(defaults.isCuaDriverServerId("CUA-DRIVER"));
  assert.ok(defaults.isHubHiddenServerId(" CUA-Driver "));
});

test("an entry with a different id but a command still pointing at cua-driver is also treated as ask", () => {
  // This is the most critical one: id is a display identifier the user can change at will. If only
  // the id were trusted, naming the entry my-tools would let 60 click / type / kill-process tools
  // through with zero approval.
  const renamed = { id: "my-tools", command: "/Users/x/.local/bin/cua-driver" };
  assert.ok(defaults.isCuaDriverServer(renamed));
  assert.equal(defaults.effectiveServerPolicyDefault(renamed), "ask");

  // Path separators, extensions, and quotes must all be recognized.
  assert.ok(defaults.isCuaDriverServer({ id: "x", command: "C:\\bin\\CUA-Driver.exe" }));
  assert.ok(defaults.isCuaDriverServer({ id: "x", command: '"/opt/homebrew/bin/cua-driver"' }));
  assert.ok(defaults.isCuaDriverServer({ id: "x", command: "cua-driver" }));

  // A binary whose name contains cua-driver but is not it must not be misidentified.
  assert.equal(defaults.isCuaDriverServer({ id: "x", command: "/bin/cua-driver-proxy" }), false);
  assert.equal(defaults.isCuaDriverServer({ id: "x", command: "/opt/cua-driver/bin/serve" }), false);
  assert.equal(defaults.isCuaDriverServer({ id: "x", command: "" }), false);
  assert.equal(defaults.isCuaDriverServer(undefined), false);
});

test("Hub hiding looks only at id — a self-added entry should not become a ghost config nobody can delete", () => {
  assert.ok(defaults.isHubHiddenServerId("cua-driver"));
  // The command points at cua-driver but the id is user-chosen: it is handled as cua for security
  // but still remains visible and deletable in the Hub.
  assert.equal(defaults.isHubHiddenServerId("my-tools"), false);
});

test("server policy keys fall back to the normalized key when casing differs", () => {
  // The settings page writes keys using the entry's original text; the serverId seen at runtime
  // may differ only in casing. The original takes precedence, the normalized key is the fallback,
  // and explicit config therefore does not stop working.
  assert.equal(
    resolveToolPolicy("mcp_cua_click", cuaDriverMeta({ serverId: "CUA-DRIVER" }), {
      "server:CUA-DRIVER": "deny",
    }),
    "deny",
  );
  assert.equal(
    resolveToolPolicy("mcp_cua_click", cuaDriverMeta({ serverId: "CUA-DRIVER" }), {
      "server:cua-driver": "allow",
    }),
    "allow",
  );
  // The original key takes precedence over the normalized key.
  assert.equal(
    resolveToolPolicy("mcp_cua_click", cuaDriverMeta({ serverId: "CUA-DRIVER" }), {
      "server:CUA-DRIVER": "deny",
      "server:cua-driver": "allow",
    }),
    "deny",
  );
});

test("candidate key list: original first, normalized fallback, and only one when they coincide", () => {
  // This list is the single source of ordering shared by the runtime and the settings page; if the
  // order changes, both change together.
  assert.deepEqual(defaults.serverPolicyKeyCandidates("CUA-DRIVER"), [
    "server:CUA-DRIVER",
    "server:cua-driver",
  ]);
  assert.deepEqual(defaults.serverPolicyKeyCandidates("cua-driver"), ["server:cua-driver"]);
  // The original candidate is trimmed: policy-table keys are normalized by normalizeToolPolicies,
  // so a key with whitespace never exists, and an untrimmed original candidate would never find
  // anything.
  assert.deepEqual(defaults.serverPolicyKeyCandidates(" Cua-Driver "), [
    "server:Cua-Driver",
    "server:cua-driver",
  ]);
});
