// neuralOS refusal gate + menu integrity (regression guard for the operator
// survey: a refusal must be terminal, a generated ask.py must carry the gate,
// and the menu writer must not lose caged argument specs).
//
// Everything here runs against the REAL bundled generator/exporter, in a temp
// fixture, so a regeneration that drops the gate fails CI instead of silently
// turning an instance into a confident-wrong-number machine.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const NEURALOS = join(REPO, "crates/agent-gui/src-tauri/resources/neuralos");
const GENERATOR = join(NEURALOS, "generator/gen_needle_instance.py");
const EXPORTER = join(NEURALOS, "scripts/export_tools.py");
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

// The fixture menu mirrors the live fleet: incident/work-order/problem probes
// plus a report probe whose search term is pattern-caged.
const MENU = [
  { name: "open_incidents", description: "Count open incidents.",
    parameters: { type: "object", properties: {}, required: [] },
    triggers: ["how many open incidents", "open incidents"] },
  { name: "unresolved_incidents", description: "Count unresolved incidents.",
    parameters: { type: "object", properties: {}, required: [] },
    triggers: ["how many unresolved incidents", "unresolved incidents"] },
  { name: "itsm_overview", description: "Overall ITSM counts.",
    parameters: { type: "object", properties: {}, required: [] },
    triggers: ["give me an itsm overview", "itsm overview"] },
  { name: "open_problems", description: "Count open problems.",
    parameters: { type: "object", properties: {}, required: [] },
    triggers: ["how many open problems", "open problems"] },
  { name: "open_work_orders", description: "Count open work orders.",
    parameters: { type: "object", properties: {}, required: [] },
    triggers: ["how many open work orders", "open work orders"] },
  { name: "sales_by_region", description: "Sales by region.",
    parameters: { type: "object", properties: {}, required: [] },
    triggers: ["which region has the highest sales", "sales by region", "top region"] },
  { name: "count_records", description: "Count the records in the source.",
    parameters: { type: "object", properties: {}, required: [] },
    triggers: ["how many records", "count records", "record count"] },
  { name: "count_by_status", description: "Count records grouped by status.",
    parameters: { type: "object",
      properties: { value: { type: "string", description: "a status value",
                             enum: ["paid", "unpaid"] } },
      required: [] },
    triggers: ["count records by status", "count by status"] },
  { name: "report_pages", description: "Pages with extractable text.",
    parameters: { type: "object", properties: {}, required: [] },
    triggers: ["how many pages", "page count", "report length"] },
  { name: "search_report", description: "Search the report for a fragment.",
    parameters: { type: "object",
      properties: { q: { type: "string", description: "text to search for",
                         pattern: "(?:mention|about)\\s+(.{3,60})" } },
      required: [] },
    triggers: ["search the report", "which pages mention", "find in the report"] },
  { name: "get_page", description: "Text of one page.",
    parameters: { type: "object",
      properties: { n: { type: "integer", description: "page number", minimum: 1 } },
      required: [] },
    triggers: ["show page", "page content", "read page"] },
];

const BRIDGE = [
  "def open_incidents():\n    return {'count': 24}\n",
  "def unresolved_incidents():\n    return {'count': 6}\n",
  "def itsm_overview():\n    return {'incidents': 24}\n",
  "def open_problems():\n    return {'count': 8}\n",
  "def open_work_orders():\n    return {'count': 12}\n",
  "def sales_by_region():\n    return {'region': 'west'}\n",
  "def report_pages():\n    return {'pages_with_text': 123}\n",
  "def count_records():\n    return {'count': 30}\n",
  "def count_by_status(value=''):\n    return {'column': 'status', 'value': value}\n",
  "def search_report(q='', limit=10):\n    return {'term': q, 'pages_matched': 0}\n",
  "def get_page(n=1):\n    return {'page': n, 'chars': 10}\n",
].join("\n\n");

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "neuralos-gate-"));
  writeFileSync(join(dir, "needle_menu.json"), JSON.stringify(MENU, null, 2));
  writeFileSync(join(dir, "bridge.py"), BRIDGE);
  // ask.py exactly as the bundled generator writes it (its embedded template).
  const shim = [
    "import importlib.util, io, sys",
    "spec = importlib.util.spec_from_file_location('gen', sys.argv[1])",
    "gen = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(gen)",
    "text = gen.ASK.replace('{agent}', repr('fixture')).replace('{example}', repr('how many open incidents'))",
    "io.open(sys.argv[2], 'w', encoding='utf-8').write(text)",
  ].join("\n");
  writeFileSync(join(dir, "_make_ask.py"), shim + "\n");
  execFileSync(PY, [join(dir, "_make_ask.py"), GENERATOR, join(dir, "ask.py")], { stdio: "pipe" });
  return dir;
}

function ask(dir, question) {
  try {
    const stdout = execFileSync(PY, ["ask.py", question], {
      cwd: dir, stdio: "pipe", encoding: "utf-8",
      env: { ...process.env, PYTHONPATH: dir, NEEDLE_TELEMETRY: "0", DO_NOT_TRACK: "1" },
    });
    return { code: 0, envelope: JSON.parse(stdout) };
  } catch (error) {
    const stdout = String(error.stdout || "");
    if (stdout.trim()) {
      try {
        return { code: error.status, envelope: JSON.parse(stdout) };
      } catch {
        return { code: error.status, envelope: null, raw: stdout };
      }
    }
    return { code: error.status, envelope: null, raw: String(error.stderr || "") };
  }
}

test("a generated ask.py carries the refusal gate", { skip: SKIP }, () => {
  const dir = makeFixture();
  try {
    const text = readFileSync(join(dir, "ask.py"), "utf-8");
    assert.match(text, /GATE_VERSION = 1/, "the gate marker must ship");
    assert.match(text, /def gate_reason\(/, "the gate itself must ship");
    assert.match(text, /"refusal_reason": None/, "the envelope must carry refusal_reason");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("out-of-scope questions are refused, with a reason", { skip: SKIP }, () => {
  const dir = makeFixture();
  const cases = [
    ["how many incident attachments exist", "no_probe_matches"],
    ["how many problems were closed last month", "dropped_filter:closed"],
    ["how many work orders are blocked", "dropped_filter:blocked"],
    ["which incidents have a parent problem", "no_probe_matches"],
    ["how many incidents came from email", "no_probe_matches"],
    ["delete all returned orders", "action_intent"],
  ];
  try {
    for (const [question, expected] of cases) {
      const { code, envelope } = ask(dir, question);
      assert.ok(envelope, question + ": no envelope (" + JSON.stringify(envelope) + ")");
      assert.equal(envelope.refused, true, question + " must be refused");
      assert.equal(envelope.probe, null, question + " must not name a probe");
      assert.equal(envelope.gate_version, 1, question + " must declare the gate version");
      assert.ok(
        String(envelope.refusal_reason || "").startsWith(expected),
        question + ": expected " + expected + ", got " + envelope.refusal_reason,
      );
      assert.equal(code, 1, question + " must exit 1");
      assert.ok(!("result" in envelope), question + " must not run a probe");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("answerable questions are still answered (no false refusals)", { skip: SKIP }, () => {
  const dir = makeFixture();
  const cases = [
    ["how many open incidents", "open_incidents"],
    ["how many unresolved incidents", "unresolved_incidents"],
    ["give me an itsm overview", "itsm_overview"],
    ["which region has the highest sales", "sales_by_region"],
    ["show page 60 content", "get_page"],
    ["which pages mention corporate governance", "search_report"],
  ];
  try {
    for (const [question, probe] of cases) {
      const { code, envelope } = ask(dir, question);
      assert.ok(envelope, question + ": no envelope");
      assert.notEqual(envelope.refused, true, question + " must not be refused");
      assert.equal(envelope.probe, probe, question + " routed to the wrong probe");
      assert.ok(envelope.result, question + " must carry a result");
      assert.equal(code, 0, question + " must exit 0");
    }
    // The pattern-caged search term must actually be bound (Bug 3).
    const { envelope } = ask(dir, "which pages mention corporate governance");
    assert.equal(envelope.arguments.q, "corporate governance");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every probe's first trigger survives the gate (sweep)", { skip: SKIP }, () => {
  const dir = makeFixture();
  try {
    for (const probe of MENU) {
      const question = probe.triggers[0];
      const { envelope } = ask(dir, question);
      assert.ok(envelope, question + ": no envelope");
      assert.notEqual(envelope.refused, true,
        "false refusal on " + probe.name + " trigger " + JSON.stringify(question)
        + ": " + (envelope && envelope.refusal_reason));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unrecognised menu shape fails loudly, not silently empty", { skip: SKIP }, () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "needle_menu.json"), JSON.stringify({ nope: 1 }));
    const { envelope, raw } = ask(dir, "how many open incidents");
    assert.equal(envelope, null, "must not answer from an unreadable menu");
    assert.match(String(raw || ""), /unrecognised shape/, "must say what is wrong");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the menu writer keeps pattern, enum, bounds, defaults and required", { skip: SKIP }, () => {
  if (!existsSync(EXPORTER)) {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "neuralos-export-"));
  const module = [
    "from typing import Annotated, Literal",
    "",
    "class Field:  # stand-in for pydantic Field metadata",
    "    def __init__(self, pattern=None, ge=None, le=None, enum=None):",
    "        self.pattern = pattern",
    "        self.ge = ge",
    "        self.le = le",
    "        self.enum = enum",
    "",
    "def tool(**kw):",
    "    def deco(fn):",
    "        # deliberately LOSSY, exactly as the live decorators export it:",
    "        # the caging is declared on the signature, not in this dict",
    "        fn._needle_tool = {'name': fn.__name__,",
    "                           'description': kw.get('description', ''),",
    "                           'triggers': kw.get('triggers', []),",
    "                           'parameters': kw.get('parameters',",
    "                               {'type': 'object', 'properties': {}, 'required': []})}",
    "        return fn",
    "    return deco",
    "",
    "@tool(description='Search the report.', triggers=['search the report'],",
    "      parameters={'type': 'object',",
    "                  'properties': {'q': {'type': 'pattern'}},",
    "                  'required': []})",
    "def search_report(",
    "        q: Annotated[str, Field(pattern='(?:mention|about)\\\\s+(.{3,60})')] = '',",
    "        limit: Annotated[int, Field(ge=1, le=50)] = 10):",
    "    return {}",
    "",
    "@tool(description='Count rows.', triggers=['how many rows'])",
    "def row_count() -> dict:",
    "    return {}",
    "",
    "@tool(description='Filter by status.', triggers=['filter by status'])",
    "def by_status(status: Literal['paid', 'unpaid'] = 'paid'):",
    "    return {}",
    "",
  ].join("\n");
  writeFileSync(join(dir, "probes.py"), module);
  try {
    execFileSync(PY, [EXPORTER, "probes.py", "-o", "menu.json"], { cwd: dir, stdio: "pipe" });
    const menu = JSON.parse(readFileSync(join(dir, "menu.json"), "utf-8"));
    const byName = Object.fromEntries(menu.map((entry) => [entry.name, entry]));

    const search = byName.search_report.parameters.properties.q;
    assert.equal(search.type, "string", "a legacy 'pattern' type must become a string");
    assert.ok(search.pattern, "the pattern regex must survive the export");
    assert.ok(!("_fn" in byName.search_report), "internal handles must not be exported");

    const limit = byName.search_report.parameters.properties.limit;
    assert.equal(limit.type, "integer");
    assert.equal(limit.minimum, 1);
    assert.equal(limit.maximum, 50);
    assert.equal(limit.default, 10);

    const status = byName.by_status.parameters.properties.status;
    assert.deepEqual(status.enum, ["paid", "unpaid"], "a Literal must export as an enum");

    // Round-trip: read it back and re-check the caging is still declared.
    const reread = JSON.parse(readFileSync(join(dir, "menu.json"), "utf-8"));
    assert.ok(reread.find((e) => e.name === "search_report")
      .parameters.properties.q.pattern, "pattern must round-trip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sibling probe's noun is not a low-coverage refusal", { skip: SKIP }, () => {
  // Regression (found testing the shipped 1.7.10 app): "count records by status"
  // is answered by count_by_status while "records" belongs to the count_records
  // family, so scoring coverage against the single winner false-refused it.
  const dir = makeFixture();
  try {
    const { code, envelope } = ask(dir, "count records by status");
    assert.notEqual(envelope.refused, true,
      "a family phrasing must not be refused: " + JSON.stringify(envelope.refusal_reason));
    assert.equal(envelope.probe, "count_by_status");
    assert.equal(code, 0);
    assert.equal(ask(dir, "how many records").envelope.probe, "count_records");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an imperative action is refused as action_intent even when nothing scores", { skip: SKIP }, () => {
  // Regression: the floor's own score<=0 miss used to fire first and report a
  // bland no_probe_matches, losing the fact that the user asked for an ACTION.
  const dir = makeFixture();
  try {
    const { envelope } = ask(dir, "delete all invoices");
    assert.equal(envelope.refused, true);
    assert.equal(envelope.refusal_reason, "action_intent",
      "an action verb must outrank the floor's own miss");
    assert.equal(envelope.probe, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
