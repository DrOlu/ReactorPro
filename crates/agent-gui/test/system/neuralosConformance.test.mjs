// SHARED refusal-gate conformance suite runner.
//
// Reads resources/neuralos/conformance/refusal_gate.json — the product-agnostic
// fixture set — builds a real instance from the bundled generator template and
// asserts every case. The same fixture is what SuperAgent and neuralOSd run, so
// a divergence in the reason grammar or exit codes fails a build here instead of
// being discovered by hand.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const NEURALOS = join(REPO, "crates/agent-gui/src-tauri/resources/neuralos");
const FIXTURE = join(NEURALOS, "conformance/refusal_gate.json");
const GENERATOR = join(NEURALOS, "generator/gen_needle_instance.py");
const PY = process.env.NEURALOS_PYTHON || "python3";

function pythonAvailable() {
  try {
    execFileSync(PY, ["-c", "pass"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !pythonAvailable() || !existsSync(FIXTURE) || !existsSync(GENERATOR)
  ? "python3, the conformance fixture or the bundled generator is unavailable"
  : false;

function buildInstance(spec) {
  const dir = mkdtempSync(join(tmpdir(), "neuralos-conf-"));
  writeFileSync(join(dir, "needle_menu.json"), JSON.stringify(spec.menu, null, 2));
  const lines = [];
  for (const [name, payload] of Object.entries(spec.bridge)) {
    lines.push("def " + name + "(*args, **kwargs):");
    lines.push("    return " + JSON.stringify(payload));
    lines.push("");
  }
  writeFileSync(join(dir, "bridge.py"), lines.join("\n"));
  const shim = join(dir, "_render.py");
  writeFileSync(shim, [
    "import importlib.util, io, sys",
    "spec = importlib.util.spec_from_file_location('gen', sys.argv[1])",
    "gen = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(gen)",
    "io.open(sys.argv[2], 'w', encoding='utf-8').write(gen.render_ask('conformance', ''))",
    "",
  ].join("\n"));
  execFileSync(PY, [shim, GENERATOR, join(dir, "ask.py")], { stdio: "pipe" });
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
        return { code: error.status, envelope: null };
      }
    }
    return { code: error.status, envelope: null };
  }
}

test("the conformance fixture declares the shared contract", { skip: SKIP }, () => {
  const spec = JSON.parse(readFileSync(FIXTURE, "utf-8"));
  assert.equal(spec.gate_version, 1, "the fixture pins the gate version it was written for");
  assert.deepEqual(spec.contract.exit_codes, { answered: 0, refused: 2 },
    "the shared exit-code contract is 0 answered / 2 nothing produced");
  assert.equal(spec.contract.reasons_are_bare_tokens, true,
    "consumers must be able to exact-match a reason across products");
  assert.equal(spec.contract.detail_field, "refusal_detail");
  assert.ok(spec.cases.length >= 10, "a conformance suite needs real coverage");
});

test("every conformance case passes on a generated instance", { skip: SKIP }, () => {
  const spec = JSON.parse(readFileSync(FIXTURE, "utf-8"));
  const dir = buildInstance(spec);
  try {
    const failures = [];
    for (const item of spec.cases) {
      const { code, envelope } = ask(dir, item.question);
      if (!envelope) {
        failures.push(item.question + ": no envelope");
        continue;
      }
      const reasons = spec.contract.refusal_reasons;
      if (item.kind === "answer") {
        if (envelope.refused === true) {
          failures.push(item.question + ": refused as " + envelope.refusal_reason);
        } else if (envelope.probe !== item.probe) {
          failures.push(item.question + ": probe " + envelope.probe + " != " + item.probe);
        } else if (code !== spec.contract.exit_codes.answered) {
          failures.push(item.question + ": exit " + code + " != 0");
        } else if (reasons.includes(envelope.refusal_reason)) {
          failures.push(item.question + ": answered but carries a refusal reason");
        }
      } else {
        if (envelope.refused !== true) {
          failures.push(item.question + ": not refused (probe " + envelope.probe + ")");
        } else if (envelope.refusal_reason !== item.reason) {
          failures.push(item.question + ": reason " + envelope.refusal_reason + " != " + item.reason);
        } else if (!reasons.includes(envelope.refusal_reason)) {
          failures.push(item.question + ": reason outside the shared grammar");
        } else if (code !== spec.contract.exit_codes.refused) {
          failures.push(item.question + ": exit " + code + " != 2");
        } else if (envelope.probe !== null && envelope.probe !== undefined) {
          failures.push(item.question + ": a refusal must not name a probe");
        } else if (!("result" in envelope)) {
          // a refusal must never carry a result payload
        } else {
          failures.push(item.question + ": a refusal must not run a probe");
        }
      }
    }
    assert.deepEqual(failures, [], "conformance failures:\n  " + failures.join("\n  "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the false-refusal sweep in the fixture also passes", { skip: SKIP }, () => {
  const spec = JSON.parse(readFileSync(FIXTURE, "utf-8"));
  const dir = buildInstance(spec);
  try {
    const failures = [];
    for (const entry of spec.menu) {
      const question = (entry.triggers || [entry.name])[0];
      const { envelope } = ask(dir, question);
      if (!envelope || envelope.refused === true) {
        failures.push(entry.name + " trigger " + JSON.stringify(question) + " was refused"
          + (envelope ? " (" + envelope.refusal_reason + ")" : ""));
      }
    }
    assert.deepEqual(failures, [], "false refusals:\n  " + failures.join("\n  "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the template stamps the shared constants and never formats a reason", { skip: SKIP }, () => {
  const dir = buildInstance(JSON.parse(readFileSync(FIXTURE, "utf-8")));
  try {
    const text = readFileSync(join(dir, "ask.py"), "utf-8");
    assert.match(text, /GATE_VERSION = 1/);
    assert.match(text, /ANSWERED_EXIT = 0/);
    assert.match(text, /REFUSED_EXIT = 2/);
    assert.match(text, /"refusal_detail": None/);
    // No reason may carry a parenthesised payload — that is what refusal_detail is for.
    assert.ok(!/refusal_reason\s*=\s*"[a-z_]+\(/.test(text),
      "reasons must be bare tokens, not formatted strings");
    assert.ok(!/no_probe_matches\(unknown/.test(text), "no formatted no_probe_matches");
    assert.ok(!/low_coverage\(%/.test(text), "no formatted low_coverage");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
