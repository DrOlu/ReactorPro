// ask.py lineage + migration (consolidates the three floors in the wild onto
// the generated template WITHOUT losing an instance's own caged routes).
//
// Drives the REAL bundled generator's --migrate-ask against temp fixtures, so
// a future change that drops the gate, silently discards a fast path, or
// writes without a backup fails CI.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const GENERATOR = join(REPO, "crates/agent-gui/src-tauri/resources/neuralos/generator/gen_needle_instance.py");
const PY = process.env.NEURALOS_PYTHON || "python3";

function pythonAvailable() {
  try {
    execFileSync(PY, ["-c", "pass"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !pythonAvailable() || !existsSync(GENERATOR)
  ? "python3 or the bundled generator is unavailable"
  : false;

// A legacy hand-written floor: no gate, and one caged fast path worth keeping.
const LEGACY_ASK = [
  "#!/usr/bin/env python3",
  '"""ask.py - code-gate entry: lexical top-K over triggers, floor at score<=0."""',
  "import json, re, sys, os",
  "HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)",
  "sys.path.insert(0, HERE)",
  "import bridge",
  "",
  "def route(q):",
  '    if re.search(r"\\b(?:show|read|open)\\s+page\\s+\\d{1,3}\\b", q, re.I):',
  '        return "get_page", 99.0',
  '    return "open_incidents", 3.0',
  "",
  "def main():",
  '    q = " ".join(sys.argv[1:]).strip()',
  "    print(json.dumps(route(q)))",
  "",
  'if __name__ == "__main__":',
  "    main()",
  "",
].join("\n");

// A legacy floor whose regex flow cannot be mapped to a probe crate.
const UNMAPPABLE_ASK = [
  "import json, re, sys",
  "def route(q):",
  '    if re.search(r"(\\d+)", q):',
  '        return "mystery"',
  "    return None",
  "print(json.dumps({'probe': None}))",
  "",
].join("\n");

// mtn-build's idiom: one route, several phrasings OR-ed together.
const OR_CHAIN_ASK = [
  "import json, re, sys, os",
  "HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE)",
  "sys.path.insert(0, HERE)",
  "import bridge",
  "def route(q):",
  '    if re.search(r"\\b(?:show|read|open)\\s+page\\s+\\d{1,3}\\b", q, re.I) \\',
  '            or re.search(r"\\bwhat is on page\\s+\\d{1,3}\\b", q, re.I):',
  '        return "get_page", 99.0',
  '    return "open_incidents", 3.0',
  "print(json.dumps(route(' '.join(sys.argv[1:]))))",
  "",
].join("\n");

const MENU = [
  { name: "open_incidents", description: "Count open incidents.",
    parameters: { type: "object", properties: {}, required: [] },
    triggers: ["how many open incidents"] },
  { name: "search_report", description: "Search the report for a fragment.",
    parameters: { type: "object",
      properties: { q: { type: "string", description: "text to search for" },
                    limit: { type: "integer", description: "max hits" } },
      required: [] },
    triggers: ["search the report", "which pages mention", "find in the report"] },
  { name: "get_page", description: "Text of one page.",
    parameters: { type: "object",
      properties: { n: { type: "integer", description: "page number" } },
      required: [] },
    triggers: ["show page", "page content"] },
];

const BRIDGE = [
  "def open_incidents():\n    return {'count': 24}\n",
  "def get_page(n=1):\n    return {'page': n}\n",
  "def search_report(q='', limit=10):\n    return {'term': q}\n",
].join("\n");

function fixture(kind) {
  const root = mkdtempSync(join(tmpdir(), "neuralos-migrate-"));
  const inst = join(root, kind);
  mkdirSync(inst, { recursive: true });
  writeFileSync(join(inst, "needle_menu.json"), JSON.stringify(MENU, null, 2));
  writeFileSync(join(inst, "bridge.py"), BRIDGE);
  if (kind === "legacy") {
    writeFileSync(join(inst, "ask.py"), LEGACY_ASK);
  } else if (kind === "unmappable") {
    writeFileSync(join(inst, "ask.py"), UNMAPPABLE_ASK);
  } else if (kind === "gated") {
    // Render the current template the same way the generator does.
    const shim = join(root, "_render.py");
    writeFileSync(join(shim), [
      "import importlib.util, io, sys",
      "spec = importlib.util.spec_from_file_location('gen', sys.argv[1])",
      "gen = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(gen)",
      "io.open(sys.argv[2], 'w', encoding='utf-8').write(gen.render_ask('gated', ''))",
      "",
    ].join("\n"));
    execFileSync(PY, [shim, GENERATOR, join(inst, "ask.py")], { stdio: "pipe" });
  }
  return { root, inst };
}

function migrate(path, extra = []) {
  try {
    const stdout = execFileSync(PY, [GENERATOR, "--migrate-ask", path, ...extra],
      { stdio: "pipe", encoding: "utf-8" });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status, out: String(error.stdout || "") };
  }
}

function ask(inst, question) {
  try {
    const stdout = execFileSync(PY, ["ask.py", question], {
      cwd: inst, stdio: "pipe", encoding: "utf-8",
      env: { ...process.env, PYTHONPATH: inst, NEEDLE_TELEMETRY: "0", DO_NOT_TRACK: "1" },
    });
    return { code: 0, envelope: JSON.parse(stdout) };
  } catch (error) {
    const stdout = String(error.stdout || "");
    if (stdout.trim()) {
      try {
        return { code: error.status, envelope: JSON.parse(stdout) };
      } catch {
        return { code: error.status, envelope: null };
      }
    }
    return { code: error.status, envelope: null };
  }
}

test("the three lineages are told apart", { skip: SKIP }, () => {
  const gated = fixture("gated");
  const legacy = fixture("legacy");
  const absent = fixture("empty");
  try {
    assert.match(migrate(gated.inst).out, /^gated\s+\S+\s+noop/m, "a gated file is a no-op");
    assert.match(migrate(legacy.inst).out, /^legacy\s+\S+\s+migrate/m, "a legacy file migrates");
    assert.match(migrate(absent.inst).out, /^empty\s+\S+\s+absent/m, "a missing ask.py is reported");
  } finally {
    for (const f of [gated, legacy, absent]) {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("a dry run writes nothing; --apply writes and backs up", { skip: SKIP }, () => {
  const { root, inst } = fixture("legacy");
  const path = join(inst, "ask.py");
  try {
    const before = readFileSync(path, "utf-8");
    migrate(inst);
    assert.equal(readFileSync(path, "utf-8"), before, "dry run must not touch the file");
    assert.equal(readdirSync(inst).filter((f) => f.includes("premigrate")).length, 0,
      "dry run must not leave a backup");

    migrate(inst, ["--apply"]);
    const after = readFileSync(path, "utf-8");
    assert.notEqual(after, before, "--apply must rewrite the file");
    assert.match(after, /GATE_VERSION = 1/, "the migrated floor must carry the gate");
    assert.equal(readdirSync(inst).filter((f) => f.includes("premigrate")).length, 1,
      "--apply must keep exactly one backup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an instance's own caged route survives the migration", { skip: SKIP }, () => {
  const { root, inst } = fixture("legacy");
  try {
    migrate(inst, ["--apply"]);
    const text = readFileSync(join(inst, "ask.py"), "utf-8");
    assert.match(text, /FAST_PATHS = \[/, "the declared cage must be carried");
    assert.match(text, /'get_page'/, "the carried cage must keep its probe");

    // And it must still work: the cage beats lexical scoring.
    const caged = ask(inst, "show page 60 content");
    assert.equal(caged.envelope.probe, "get_page", "the carried cage must route");
    assert.equal(caged.envelope.refused, false);
    const plain = ask(inst, "how many open incidents");
    assert.equal(plain.envelope.probe, "open_incidents", "ordinary routing still works");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a migrated instance refuses and answers exactly like a generated one", { skip: SKIP }, () => {
  const { root, inst } = fixture("legacy");
  try {
    migrate(inst, ["--apply"]);
    const refused = ask(inst, "how many incident attachments exist");
    assert.equal(refused.envelope.refused, true, "out-of-scope must be refused");
    assert.equal(refused.envelope.refusal_reason, "no_probe_matches");
    assert.equal(refused.code, 1, "a refusal exits 1");

    const action = ask(inst, "delete all open incidents");
    assert.equal(action.envelope.refusal_reason, "action_intent",
      "an imperative action must be refused");

    const answered = ask(inst, "how many open incidents");
    assert.equal(answered.envelope.refused, false);
    assert.equal(answered.envelope.gate_version, 1, "the answer declares its gate version");
    assert.equal(answered.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration is idempotent", { skip: SKIP }, () => {
  const { root, inst } = fixture("legacy");
  try {
    migrate(inst, ["--apply"]);
    const once = readFileSync(join(inst, "ask.py"), "utf-8");
    const second = migrate(inst, ["--apply"]);
    assert.match(second.out, /noop/, "the second run must be a no-op");
    assert.equal(readFileSync(join(inst, "ask.py"), "utf-8"), once,
      "a no-op must not rewrite the file");
    assert.equal(readdirSync(inst).filter((f) => f.includes("premigrate")).length, 1,
      "a no-op must not add another backup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable caged flow blocks the migration instead of guessing", { skip: SKIP }, () => {
  const { root, inst } = fixture("unmappable");
  const path = join(inst, "ask.py");
  try {
    const before = readFileSync(path, "utf-8");
    const blocked = migrate(inst, ["--apply"]);
    assert.equal(blocked.code, 1, "a blocked migration must fail loudly");
    assert.match(blocked.out, /blocked/, "and say so");
    assert.match(blocked.out, /review:/, "with the reason");
    assert.equal(readFileSync(path, "utf-8"), before, "nothing may be written");

    // --force is the explicit escape hatch.
    const forced = migrate(inst, ["--apply", "--force"]);
    assert.equal(forced.code, 0, "force clears the block");
    assert.match(readFileSync(path, "utf-8"), /GATE_VERSION = 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fleet sweep classifies every instance", { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "neuralos-fleet-"));
  const fleet = join(root, "fleet");
  mkdirSync(fleet, { recursive: true });
  for (const kind of ["legacy", "gated", "empty"]) {
    const inst = join(fleet, kind);
    mkdirSync(inst, { recursive: true });
    writeFileSync(join(inst, "needle_menu.json"), JSON.stringify(MENU, null, 2));
    writeFileSync(join(inst, "bridge.py"), BRIDGE);
    if (kind === "legacy") {
      writeFileSync(join(inst, "ask.py"), LEGACY_ASK);
    }
  }
  const shim = join(root, "_render.py");
  writeFileSync(shim, [
    "import importlib.util, io, sys",
    "spec = importlib.util.spec_from_file_location('gen', sys.argv[1])",
    "gen = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(gen)",
    "io.open(sys.argv[2], 'w', encoding='utf-8').write(gen.render_ask('gated', ''))",
    "",
  ].join("\n"));
  execFileSync(PY, [shim, GENERATOR, join(fleet, "gated", "ask.py")], { stdio: "pipe" });
  try {
    const out = migrate(fleet, ["--fleet"]).out;
    assert.match(out, /^legacy\s+\S+\s+migrate/m);
    assert.match(out, /^gated\s+\S+\s+noop/m);
    assert.match(out, /^empty\s+\S+\s+absent/m);
    assert.match(out, /dry run/, "a sweep defaults to a dry run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an OR-chained caged route carries every pattern", { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "neuralos-orchain-"));
  const inst = join(root, "orchain");
  mkdirSync(inst, { recursive: true });
  writeFileSync(join(inst, "needle_menu.json"), JSON.stringify(MENU, null, 2));
  writeFileSync(join(inst, "bridge.py"), BRIDGE);
  writeFileSync(join(inst, "ask.py"), OR_CHAIN_ASK);
  try {
    const dry = migrate(inst).out;
    assert.match(dry, /legacy\s+migrate/, "an OR-chain is migratable, not ambiguous");
    assert.match(dry, /carried=2/, "both phrasings of the route must be carried");

    migrate(inst, ["--apply"]);
    const text = readFileSync(join(inst, "ask.py"), "utf-8");
    assert.match(text, /what is on page/, "the second phrasing must survive");
    const routed = ask(inst, "show page 60 content");
    assert.equal(routed.envelope.probe, "get_page");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rich legacy floor is never silently replaced", { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "neuralos-rich-"));
  const inst = join(root, "rich");
  mkdirSync(inst, { recursive: true });
  writeFileSync(join(inst, "needle_menu.json"), JSON.stringify(MENU, null, 2));
  writeFileSync(join(inst, "bridge.py"), BRIDGE);
  const rich = [
    "import json, hashlib, sys",
    "CACHE = {}",
    "def ask(q):",
    "    key = hashlib.sha256(q.encode()).hexdigest()",
    "    CACHE[key] = 1",
    "    return {'audit': key}",
    "print(json.dumps(ask(' '.join(sys.argv[1:]))))",
    "",
  ].join("\n");
  writeFileSync(join(inst, "ask.py"), rich);
  const path = join(inst, "ask.py");
  try {
    const before = readFileSync(path, "utf-8");
    const blocked = migrate(inst, ["--apply"]);
    assert.equal(blocked.code, 1, "a rich floor must block");
    assert.match(blocked.out, /does not implement/, "and name what would be lost");
    assert.equal(readFileSync(path, "utf-8"), before, "nothing may be replaced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uncaged string argument is bound, never silently dropped", { skip: SKIP }, () => {
  const { root, inst } = fixture("legacy");
  try {
    migrate(inst, ["--apply"]);
    const routed = ask(inst, "which pages mention revenue");
    assert.equal(routed.envelope.refused, false, "a search question must be answered");
    assert.equal(routed.envelope.probe, "search_report");
    assert.equal(routed.envelope.arguments.q, "revenue",
      "the payload must reach the bridge, not be dropped (missing positional 'q')");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
