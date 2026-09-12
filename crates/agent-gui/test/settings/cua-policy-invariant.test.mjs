import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * Cross-module invariant: **the approval level shown in the CUA settings page ===
 * the level actually enforced at runtime.**
 *
 * Each side has its own unit tests (the settings page can read lowercase entries,
 * the runtime falls back to normalized keys), but testing them separately cannot
 * guarantee this invariant itself -- historically it was "the runtime added a
 * fallback, the settings page did not" that produced "the page shows ask, the
 * runtime enforces allow". Here both modules are put into the same config matrix
 * and compared cell by cell, so any one-sided change to the lookup order turns
 * this red first.
 */

const loader = createTsModuleLoader();
const form = loader.loadModule("../agent-ui/src/pages/settings/cuaDriverForm.ts");
const toolPolicy = loader.loadModule("src/lib/tools/toolPolicy.ts");
const defaults = loader.loadModule("../agent-ui/src/contracts/mcpServerDefaults.ts");

const entryOf = (id) => ({
  id,
  enabled: true,
  transport: "stdio",
  command: "/Users/x/.local/bin/cua-driver",
  args: ["mcp"],
  url: "",
  timeoutMs: 60_000,
});

/** Consistent with how mcpTools.ts builds the tool table: serverId takes the entry raw text, and the default is computed from the config and carried down. */
const metadataOf = (entry) => ({
  groupId: "mcp",
  kind: "mcp",
  isReadOnly: false,
  displayCategory: "mcp",
  serverId: entry.id,
  serverPolicyDefault: defaults.hardcodedServerPolicyDefault(entry),
});

const ids = ["cua-driver", "CUA-DRIVER", " Cua-Driver "];
const policyTables = [
  undefined,
  {},
  { "server:cua-driver": "allow" },
  { "server:cua-driver": "deny" },
  { "server:CUA-DRIVER": "allow" },
  { "server:CUA-DRIVER": "deny" },
  // Both the raw key and the normalized key present (ghosting left by historical writes).
  { "server:CUA-DRIVER": "deny", "server:cua-driver": "allow" },
  { "server:cua-driver": "ask", "server:CUA-DRIVER": "allow" },
  // Unrelated keys do not interfere.
  { Bash: "deny", "group:mcp": "allow" },
];

test("settings page displayed value === runtime enforced value (full matrix)", () => {
  for (const id of ids) {
    const entry = entryOf(id);
    const metadata = metadataOf(entry);
    for (const policies of policyTables) {
      const uiPolicy = form.readCuaPolicy(policies, entry);
      const runtimePolicy = toolPolicy.resolveToolPolicy("mcp_cua_click", metadata, policies);
      assert.equal(
        uiPolicy,
        runtimePolicy,
        `id=${JSON.stringify(id)} policies=${JSON.stringify(policies)}: page shows ${uiPolicy}, runtime enforces ${runtimePolicy}`,
      );
    }
  }
});

test("the invariant still holds after write-back (the write path creates no new mismatch)", () => {
  for (const id of ids) {
    const entry = entryOf(id);
    const metadata = metadataOf(entry);
    // Starting from a ghosted table, write each of the three levels once.
    for (const next of ["allow", "ask", "deny"]) {
      const written = form.applyCuaPolicy(
        { "server:cua-driver": "allow", "server:CUA-DRIVER": "deny", Bash: "deny" },
        entry,
        next,
      );
      const uiPolicy = form.readCuaPolicy(written, entry);
      const runtimePolicy = toolPolicy.resolveToolPolicy("mcp_cua_click", metadata, written);
      assert.equal(uiPolicy, next, `after writing ${next} the page should show ${next}`);
      assert.equal(runtimePolicy, next, `after writing ${next} the runtime should enforce ${next}`);
    }
  }
});
