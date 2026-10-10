#!/usr/bin/env python3
"""Generate a runnable needle instance from a neuralos profile + models.

Reads profile.json and models.py (both produced by this skill's earlier phases)
and writes an instance directory:

  needle_menu.json   the probe menu (name/description/args/triggers), also
                     usable directly by the standalone engine binary
  bridge.py          retrieval + parsing: reads the real source and validates
                     every record through the Pydantic models in models.py
  instance.py        the needle agent (Python runtime): menu wired as tools
                     with triggers, agentic loop, --coverage flag
  verify.py          Phase-4 checks: model coverage + selection test
  README.md          how to run, what to ask, how to extend

Usage:
  python gen_needle_instance.py --profile profile.json --models models.py \
      --out myfeed --db-dsn mysql://user:pw@host/db [--runtime python|engine]
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone

ENUM_MAX = 12
ROW_CAP = 25


def snake(name):
    name = re.sub(r"[^0-9a-zA-Z]+", "_", name).strip("_").lower()
    return name or "field"


def pascal(name):
    return "".join(p[:1].upper() + p[1:] for p in re.split(r"[^0-9a-zA-Z]+", name) if p) or "Record"


def enum_fields(fields):
    return [(f["name"], f["enum_values"]) for f in (fields or [])
            if f.get("enum_values") and f.get("distinct", 99) <= ENUM_MAX]


def num_fields(fields):
    return [f["name"] for f in (fields or [])
            if f.get("detected_type") in ("integer", "number")]


def menu_entry(name, description, params, triggers):
    """params: dict key -> property dict, with optional "__optional__": True marker."""
    props, required = {}, []
    for key, spec in params.items():
        spec = dict(spec)
        optional = spec.pop("__optional__", False)
        props[key] = spec
        if not optional:
            required.append(key)
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": props, "required": required},
            "triggers": triggers}


# ============================================================ menu building
def build_menu(profile, table, agent_name):
    kind = profile["source"]["kind"]
    menu = []
    S = lambda v, **kw: {"type": "string", "description": v, **kw}

    if kind == "database":
        # one table per instance: a 121M selector degrades beyond ~a dozen probes
        chosen_tables = [x for x in profile["source"].get("tables", [])
                         if not table or x["name"] == table]
        if table and not chosen_tables:
            have = [x["name"] for x in profile["source"].get("tables", [])]
            raise SystemExit(f"table {table!r} not in the profile; profiled tables: {have}")
        for t in chosen_tables:
            tname, tn = t["name"], snake(t["name"])
            menu.append(menu_entry(
                f"{tn}_count", f"Count rows in the {tname} table.", {},
                [f"how many {tn}", f"count all {tn} rows", f"{tn} total", f"{tn} row count"]))
            menu.append(menu_entry(
                f"{tn}_recent", f"Most recent rows from {tname}, newest first.",
                {"limit": {"type": "integer", "description": "how many rows, e.g. 10",
                           "minimum": 1, "maximum": 100, "__optional__": True}},
                [f"recent {tn}", f"latest {tn}", f"show {tn}", f"last {tn} rows"]))
            menu.append(menu_entry(
                f"{tn}_summary", f"Aggregate summary of {tname}: row count plus "
                                 f"count/min/max/average of every numeric column.", {},
                [f"{tn} summary", f"{tn} stats", f"aggregate {tn}", f"{tn} numbers"]))
            for col, values in enum_fields(t["columns"]):
                c = snake(col)
                menu.append(menu_entry(
                    f"{tn}_by_{c}", f"Count and list {tname} rows where {col} matches a "
                                    f"specific value. Values observed in the data: "
                                    f"{', '.join(map(str, values[:6]))}.",
                    {"value": {"type": "string", "description": f"exact value of {col}",
                               "enum": values[:ENUM_MAX]}},
                    [f"count {tn} by {c}", f"count {tn} where {c}", f"count {tn} where {c.replace(chr(95), chr(32))}", f"{tn} by {c}", f"{tn} where {c.replace(chr(95), chr(32))}", f"filter {tn} by {c}"]))
    elif kind == "log_lines":
        levels = sorted({lv for t in profile.get("log_templates", [])
                         for lv in t.get("distinct_values", {}).get("level", [])})
        menu.append(menu_entry(
            "parse_tail", "Parse the newest log lines through the typed templates.",
            {"lines": {"type": "integer", "description": "how many recent lines, e.g. 50",
                       "minimum": 1, "maximum": 2000, "__optional__": True}},
            ["parse tail", "recent lines", "last log lines", "parse logs"]))
        if levels:
            menu.append(menu_entry(
                "count_by_level", "Count log lines per level, or for one specific level.",
                {"level": {"type": "string", "description": "specific level, e.g. ERROR",
                           "enum": levels[:ENUM_MAX], "__optional__": True}},
                ["count by level", "errors in the log", "log level counts",
                 "how many errors"]))
        menu.append(menu_entry(
            "search_log", "Find log lines containing a substring.",
            {"contains": S("text to search for, e.g. an IP or service name")},
            ["search log", "find in log", "grep log", "log contains"]))
    else:  # delimited / json_lines / json_doc
        enums = enum_fields(profile.get("fields", []))
        menu.append(menu_entry(
            "peek", "Fetch the first records, parsed and validated through the model.",
            {"limit": {"type": "integer", "description": "how many records, e.g. 10",
                       "minimum": 1, "maximum": 100, "__optional__": True}},
            ["peek", "first records", "show records", "sample the data"]))
        menu.append(menu_entry(
            "count_records", "Count the records in the source.", {},
            ["how many records", "count records", "record count", "how many rows"]))
        menu.append(menu_entry(
            "summary", "Per-field summary: non-null counts, distinct values, top values "
                       "from a full scan of the source.", {},
            ["summary", "field summary", "data profile", "stats"]))
        for col, values in enums:
            c = snake(col)
            menu.append(menu_entry(
                f"count_by_{c}", f"Count records grouped by {col}, or for one value. "
                                 f"Observed values: {', '.join(map(str, values[:6]))}.",
                {"value": {"type": "string", "description": f"specific {col} value",
                           "enum": values[:ENUM_MAX], "__optional__": True}},
                [f"by {c}", f"group by {c}", f"count by {c}"]))
    # strip internal markers
    for entry in menu:
        for p in entry["parameters"]["properties"].values():
            p.pop("__optional__", None)
    return menu


# ============================================================ bridge
BRIDGE_HEAD = '''"""Retrieval + parsing bridge for the generated needle instance.

Every probe reads the real source and validates records through the strict
models in models.py. Secrets are baked here — never pass them to the model.
Generated by neuralos from profile.json at {now}.
"""
import csv
import io
import json
import os
import re
import subprocess

from models import {model_import}

ROW_CAP = 25
_VALIDATION = {{"parsed": 0, "failed": 0, "errors": []}}
'''

BRIDGE_TAIL_LOG = '''

def parse_tail(lines: int = 50) -> dict:
    lines = max(1, min(int(lines), 500))
    with open(SOURCE, "r", encoding="utf-8", errors="replace") as fh:
        recent = [l.rstrip("\\n") for l in fh if l.strip()][-lines:]
    parsed, unparsed = [], 0
    for line in recent:
        rec = M.parse_line(line)
        if rec is None:
            unparsed += 1
            continue
        parsed.append(rec.model_dump())
    _VALIDATION["parsed"] += len(parsed)
    _VALIDATION["failed"] += unparsed
    return {"lines_requested": lines, "parsed": len(parsed),
            "unparsed": unparsed, "records": parsed[:ROW_CAP]}


def count_by_level(level: str = "") -> dict:
    counts = {}
    with open(SOURCE, "r", encoding="utf-8", errors="replace") as fh:
        all_lines = [l.rstrip("\\n") for l in fh if l.strip()]
    for line in all_lines[-5000:]:
        rec = M.parse_line(line)
        lv = getattr(rec, "level", None) if rec else None
        if lv is not None:
            counts[lv] = counts.get(lv, 0) + 1
    if level:
        return {"level": level, "count": counts.get(level, 0)}
    return {"counts": counts}


def search_log(contains: str) -> dict:
    hits = [l for l in _tail(5000) if contains in l]
    return {"contains": contains, "matches": len(hits), "lines": hits[:ROW_CAP]}
'''

BRIDGE_TAIL_FILE = '''

def peek(limit: int = 10) -> dict:
    limit = max(1, min(int(limit), ROW_CAP))
    out = []
    for row in _rows():
        try:
            out.append(M.Record(**row).model_dump())
            _VALIDATION["parsed"] += 1
        except Exception as exc:
            _VALIDATION["failed"] += 1
            if len(_VALIDATION["errors"]) < 5:
                _VALIDATION["errors"].append(str(exc)[:200])
        if len(out) >= limit:
            break
    return {"returned": len(out), "records": out}


def count_records() -> dict:
    return {"count": sum(1 for _ in _rows())}


def summary() -> dict:
    counts, distinct = {}, {}
    for row in _rows():
        for k, v in row.items():
            if v not in (None, ""):
                counts[k] = counts.get(k, 0) + 1
                distinct.setdefault(k, {})
                distinct[k][v] = distinct[k].get(v, 0) + 1
    fields = {}
    for k, d in distinct.items():
        fields[k] = {"non_null": counts.get(k, 0), "distinct": len(d),
                     "top_values": sorted(d.items(), key=lambda kv: -kv[1])[:5]}
        if len(d) <= 12:
            fields[k]["values"] = sorted(d)
    return {"summary": fields}


def count_by_column(column: str, value: str = "") -> dict:
    counts = {}
    for row in _rows():
        key = row.get(column)
        if key is not None:
            counts[key] = counts.get(key, 0) + 1
    if value:
        return {"column": column, "value": value, "count": counts.get(value, 0)}
    return {"column": column,
            "counts": dict(sorted(counts.items(), key=lambda kv: -kv[1])[:ROW_CAP])}
'''


def bridge_database(profile, dsn, dsn_env):
    tables = profile["source"].get("tables", [])
    model_import = ", ".join(pascal(t["name"]) for t in tables) or "BaseModel"
    head = BRIDGE_HEAD.format(now=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                              model_import=model_import)
    body = head + f'''
DSN = os.environ.get("{dsn_env}", "{dsn}")


def _q(sql):
    proc = subprocess.run(["usql", DSN, "-c", "\\\\pset format csv", "-c", sql],
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=120)
    if proc.returncode != 0:
        # a LIST so the call-site guards (rows[0]) work — a bare dict raised
        # KeyError: 0 on every connection failure (caught live by eval #7)
        return [{{"error": (proc.stderr or proc.stdout).strip()[:300]}}]
    lines = [l for l in proc.stdout.splitlines() if l and not l.startswith("Output format")]
    rows = list(csv.DictReader(io.StringIO("\\n".join(lines))))
    # usql CSV prints NULL as an empty cell; the profiler models "" as null,
    # so coerce back — otherwise Optional columns fail on empty strings.
    for r in rows:
        for k in r:
            if r[k] == "":
                r[k] = None
    return rows



def _parse(model, rows):
    parsed, out = [], []
    for row in rows:
        try:
            parsed.append(model(**row).model_dump())
            _VALIDATION["parsed"] += 1
        except Exception as exc:
            _VALIDATION["failed"] += 1
            if len(_VALIDATION["errors"]) < 5:
                _VALIDATION["errors"].append(str(exc)[:200])
            out.append({{k: (str(v)[:80] if v is not None else None)
                        for k, v in row.items()}})
    return parsed, out

'''
    for t in tables:
        tname, tn, tcls = t["name"], snake(t["name"]), pascal(t["name"])
        q = lambda s: "`" + s + "`"
        body += f'''

def {tn}_count() -> dict:
    rows = _q("SELECT COUNT(*) AS n FROM {q(tname)}")
    if rows and "error" in rows[0]:
        return rows[0]
    return {{"table": "{tname}", "count": int(rows[0]["n"]) if rows else 0}}


def {tn}_recent(limit: int = 10, model=None) -> dict:
    model = model or {tcls}
    limit = max(1, min(int(limit), ROW_CAP))
    rows = _q("SELECT * FROM {q(tname)} ORDER BY 1 DESC LIMIT " + str(limit))
    if rows and "error" in rows[0]:
        return rows[0]
    out, _ = _parse(model, rows)
    return {{"table": "{tname}", "returned": len(out), "rows": out}}


def {tn}_summary() -> dict:
    numeric = {json.dumps(num_fields(t["columns"]))}
    summary = {{}}
    for col in numeric:
        rows = _q("SELECT COUNT(*) AS n, MIN(`" + col + "`) AS min_v, "
                  "MAX(`" + col + "`) AS max_v, AVG(`" + col + "`) AS avg_v "
                  "FROM {q(tname)}")
        if rows and "error" not in rows[0]:
            summary[col] = {{k: rows[0].get(k) for k in ("n", "min_v", "max_v", "avg_v")}}
    total = _q("SELECT COUNT(*) AS n FROM {q(tname)}")
    if total and "error" in total[0]:
        return total[0]
    return {{"table": "{tname}", "row_count": int(total[0]["n"]) if total else 0,
            "numeric_summary": summary}}

'''
        for col, values in enum_fields(t["columns"]):
            c = snake(col)
            body += f'''

def {tn}_by_{c}(value: str) -> dict:
    column = "{col}"
    val = str(value).replace("'", "''")   # enum-constrained upstream; escape anyway
    rows = _q("SELECT * FROM {q(tname)} WHERE `" + column + "` = '" + val +
              "' LIMIT " + str(ROW_CAP))
    if rows and "error" in rows[0]:
        return rows[0]
    out, _ = _parse({tcls}, rows)
    counted = _q("SELECT COUNT(*) AS n FROM {q(tname)} WHERE `" + column +
                 "` = '" + val + "'")
    if counted and "error" in counted[0]:
        return counted[0]
    return {{"table": "{tname}", "column": column, "value": str(value),
            "total_matches": int(counted[0]["n"]) if counted else 0,
            "returned": len(out), "rows": out}}

'''
    return body


def _append_enum_wrappers(code, profile):
    """The file/json menu advertises one `count_by_<column>` probe per
    low-cardinality column, but the base bridge only implements the generic
    `count_by_column`. Emit a thin wrapper per column so every advertised
    probe name resolves — otherwise the selector picks `count_by_status` and
    the direct `getattr(bridge, name)(...)` call raises AttributeError
    (caught live by the ask.py floor on a generated instance)."""
    wrappers = []
    for col, _values in enum_fields(profile.get("fields", [])):
        wrappers.append(
            '\n\n\ndef count_by_' + snake(col) + '(value: str = "") -> dict:\n'
            '    return count_by_column(' + json.dumps(col) + ', value)\n')
    return code + "".join(wrappers)


def bridge_files(profile, log, model_class="Record"):
    return _append_enum_wrappers(_bridge_files_base(profile, log, model_class), profile)


def _bridge_files_base(profile, log, model_class="Record"):
    model_import = "LogLine" if log else model_class
    head = BRIDGE_HEAD.format(now=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                              model_import=model_import)
    src_lit = json.dumps(profile["source"]["location"])
    mid = f'\nSOURCE = {src_lit}\n'
    if log:
        mid = ('\nimport models as M\n\nSOURCE = ' + src_lit + '\n'
               + '\n\ndef _tail(limit):\n'
                 '    with open(SOURCE, "r", encoding="utf-8", errors="replace") as fh:\n'
                 '        return [l.rstrip("\\n") for l in fh if l.strip()][-limit:]\n')
        return head + mid + BRIDGE_TAIL_LOG
    kind = profile["source"]["kind"]
    if kind == "json_lines":
        # JSONL/NDJSON: one object per line — json.load() on the whole file
        # dies with "Extra data" on line 2 (caught live by eval #4). Records
        # are FLATTENED exactly as the profiler did — the models are built
        # from flattened dot-paths, so raw nested rows fail extra="forbid"
        # (coverage 0%, caught live by eval #4 as well).
        read = ('''\ndef _flatten(obj, prefix="", depth=0, out=None):
    out = out if out is not None else {}
    if depth > 4:
        out[prefix] = json.dumps(obj)[:400]
        return out
    if isinstance(obj, dict):
        if not obj:
            out[prefix] = {}
            return out
        for k, v in obj.items():
            _flatten(v, f"{prefix}.{k}" if prefix else k, depth + 1, out)
    elif isinstance(obj, list):
        if not obj:
            out[prefix] = []
            return out
        _flatten(obj[0], f"{prefix}[]", depth + 1, out)
    else:
        out[prefix] = obj
    return out


def _rows():
    with open(SOURCE, "r", encoding="utf-8", errors="replace") as fh:
        out = []
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(_flatten(json.loads(line)))
            except json.JSONDecodeError:
                continue
        return out


''')
    elif kind.startswith("json"):
        read = ('''\ndef _flatten(obj, prefix="", depth=0, out=None):
    out = out if out is not None else {}
    if depth > 4:
        out[prefix] = json.dumps(obj)[:400]
        return out
    if isinstance(obj, dict):
        if not obj:
            out[prefix] = {}
            return out
        for k, v in obj.items():
            _flatten(v, f"{prefix}.{k}" if prefix else k, depth + 1, out)
    elif isinstance(obj, list):
        if not obj:
            out[prefix] = []
            return out
        _flatten(obj[0], f"{prefix}[]", depth + 1, out)
    else:
        out[prefix] = obj
    return out


def _rows():
    with open(SOURCE, "r", encoding="utf-8", errors="replace") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        data = next((v for v in data.values() if isinstance(v, list)), [])
    return [_flatten(r) for r in data]


''')
    else:
        read = ('''\ndef _rows():
    with open(SOURCE, "r", encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            # k is None when a row has more cells than the header (restkey) —
            # drop it instead of letting a TypeError masquerade as a parse failure
            yield {k: (v if v != "" else None) for k, v in row.items()
                   if k is not None}


''')
    return head + mid + read + BRIDGE_TAIL_FILE.replace("M.Record", model_class)


# ============================================================ instance
def tool_block(name, description, triggers, params, call):
    return ('\n\n@needle.tool(triggers=' + repr(triggers) + ')\n'
            + f'def {name}({params}) -> dict:\n'
            + f'    """{description}"""\n'
            + f'    return bridge.{call}\n'
            + f'TOOLS.append({name})\n')


def instance_code(profile, table, agent_name, example):
    kind = profile["source"]["kind"]
    tools = []

    def tool(name, description, triggers, params, call):
        tools.append(tool_block(name, description, triggers, params, call))

    if kind == "database":
        for t in profile["source"].get("tables", []):
            tname, tn, tcls = t["name"], snake(t["name"]), pascal(t["name"])
            tool(f"{tn}_count", f"Count rows in the {tname} table.",
                 [f"how many {tn}", f"count all {tn} rows", f"{tn} total", f"{tn} row count"],
                 "", f'{tn}_count()')
            tool(f"{tn}_recent", f"Most recent rows from {tname}, newest first.",
                 [f"recent {tn}", f"latest {tn}", f"show {tn}", f"last {tn} rows"],
                 "limit: int = 10",
                 f'{tn}_recent(limit=limit, model={tcls})')
            tool(f"{tn}_summary", f"Aggregate summary of {tname}: row count plus "
                 f"min/max/average of every numeric column.",
                 [f"{tn} summary", f"{tn} stats", f"aggregate {tn}", f"{tn} numbers"],
                 "", f'{tn}_summary()')
            for col, values in enum_fields(t["columns"]):
                c = snake(col)
                lit = "Literal[" + ", ".join(json.dumps(v) for v in values[:ENUM_MAX]) + "]"
                tool(f"{tn}_by_{c}", f"Count and list {tname} rows where {col} matches a "
                     f"specific value.", [f"{tn} by {c}", f"{tn} where {c}"],
                     f"value: {lit}",
                     f'{tn}_by_{c}(value=value)')
    elif kind == "log_lines":
        levels = sorted({lv for t in profile.get("log_templates", [])
                         for lv in t.get("distinct_values", {}).get("level", [])})
        tool("parse_tail", "Parse the newest log lines through the typed templates.",
             ["parse tail", "recent lines", "last log lines", "parse logs"],
             "lines: int = 50", "parse_tail(lines=lines)")
        if levels:
            lit = "Literal[" + ", ".join(json.dumps(v) for v in levels[:ENUM_MAX]) + "]"
            tool("count_by_level", "Count log lines per level, or one specific level.",
                 ["count by level", "errors in the log", "log level counts"],
                 f"level: {lit} = \"\"", "count_by_level(level=level)")
        tool("search_log", "Find log lines containing a substring.",
             ["search log", "find in log", "grep log"],
             'contains: str', "search_log(contains=contains)")
    else:
        tool("peek", "Fetch the first records, parsed and validated.",
             ["peek", "first records", "show records", "sample the data"],
             "limit: int = 10", "peek(limit=limit)")
        tool("count_records", "Count the records in the source.",
             ["how many records", "count records", "record count"], "", "count_records()")
        tool("summary", "Per-field summary: non-null counts, distinct and top values.",
             ["summary", "field summary", "data profile", "stats"], "", "summary()")
        for col, values in enum_fields(profile.get("fields", [])):
            c = snake(col)
            lit = "Literal[" + ", ".join(json.dumps(v) for v in values[:ENUM_MAX]) + "]"
            tool(f"count_by_{c}", f"Count records grouped by {col}, or for one value.",
                 [f"by {c}", f"group by {c}", f"count by {c}"],
                 f"value: {lit} = \"\"", f"count_by_column(column=\"{col}\", value=value)")

    model_imports = ""
    if kind == "database":
        model_imports = "from models import " + ", ".join(
            pascal(t["name"]) for t in profile["source"].get("tables", []))
    elif kind == "log_lines":
        model_imports = "import models as M"

    return f'''"""neuralOS/needle instance for {agent_name} — generated by neuralos.

Run:      {sys.executable} instance.py "your question in plain English"
Coverage: {sys.executable} instance.py --coverage   (after running probes)
"""

import json
import sys
from typing import Literal

import needle

import bridge
{model_imports}

TOOLS = []
{"".join(tools)}

# Reproducibility posture (live lessons from the chinook/soc instances):
# - fixed system facts + auto_date=False: the drifting date fact flips
#   121M tool selection between runs
# - max_steps=1: the probes are self-contained; over-calling (one correct
#   probe plus a bonus unrelated call) was observed with the default 8
# - tool_index_path above ~12 tools: in-context tool sets misroute past that
SYSTEM_FACTS = "A data instance. Pick the ONE best probe for the request; after its result, answer immediately."


def main() -> None:
    if "--coverage" in sys.argv:
        print(json.dumps(getattr(bridge, "_VALIDATION", {{}}), indent=2))
        total = bridge._VALIDATION.get("parsed", 0) + bridge._VALIDATION.get("failed", 0)
        if total:
            print("coverage: %.1f%% of records parsed cleanly"
                  % (100 * bridge._VALIDATION["parsed"] / total))
        return
    question = " ".join(sys.argv[1:]).strip() or {example!r}
    print("question:", question)
    agent = needle.Needle(
        tools=TOOLS, system=SYSTEM_FACTS, auto_date=False,
        tool_index_path=".tool_index.json" if len(TOOLS) > 12 else None)
    try:
        response = agent.run(question, max_steps=1)
    finally:
        agent.close()
    print()
    print("reasoning :", response.get("reasoning"))
    print("confidence:", response.get("confidence"))
    for result in response.get("results") or []:
        print("result    :", json.dumps(result, ensure_ascii=False, default=str)[:1500])


if __name__ == "__main__":
    main()
'''


# ============================================================ verify / readme
VERIFY = '''#!/usr/bin/env python3
"""Phase-4 verification: model coverage + selection test.

    python verify.py            # fetch a sample, then report coverage
    python verify.py --full     # also run a 3-phrasing selection test
"""
import json
import os
import subprocess
import sys

import bridge

SAMPLE_CALL = lambda: {sample_call}   # executed, not printed
PHRASINGS = {phrasings}


def fetch_sample():
    print("== fetching a sample through the bridge ==")
    result = SAMPLE_CALL()
    print(json.dumps(result, ensure_ascii=False, default=str)[:400])


def coverage():
    print("== model coverage ==")
    v = getattr(bridge, "_VALIDATION", {})
    print(json.dumps(v, indent=2))
    total = v.get("parsed", 0) + v.get("failed", 0)
    if total:
        print("coverage: %.1f%% (%d/%d records parsed cleanly)"
              % (100 * v["parsed"] / total, v["parsed"], total))
    else:
        print("coverage: no records parsed yet — fetch_sample above must have failed; "
              "check the bridge error output")


def selection():
    print("== selection test (3 phrasings) ==")
    if not os.path.exists("instance.py"):
        print("(engine runtime: no instance.py generated — run the engine binary "
              "with needle_menu.json and the same phrasings instead)")
        return
    for phrasing in PHRASINGS:
        out = subprocess.run([sys.executable, "instance.py", phrasing],
                             capture_output=True, text=True)
        for line in out.stdout.splitlines():
            if line.startswith("reasoning") or line.startswith("result"):
                print(f"  [{phrasing!r}] {line[:160]}")


if __name__ == "__main__":
    fetch_sample()
    coverage()
    if "--full" in sys.argv:
        selection()
'''

# The deterministic-first ask path (the "ask.py lexical floor" from the
# neuralOS contract: floor in ask.py, gates in the Router, banks in CI).
# Standard library only; import-safe.
ASK = '''#!/usr/bin/env python3
"""{agent} - deterministic-first ask path (the ask.py lexical floor).

Per the neuralOS instance contract the ANSWERING SURFACE IS DETERMINISTIC
CODE: this lexical floor decides from the probe menu and the engine is only
a fallback seat. It refuses ("no probe matched") when the best overlap score
is <= 0 instead of guessing.

    python ask.py "your question in plain English"
    python ask.py "..." --engine ./needle --model needle3.cact

stdout is one JSON envelope:
    {"instance","question","probe","arguments","score","confidence",
      "refused","result"|"error"}
exit 0 = answered, 1 = refused/failed.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MENU = os.path.join(HERE, "needle_menu.json")
TOKEN_RE = re.compile("[a-z0-9]+")
STOP = set((
    "the a an of in on for to and or all me show give please how many much "
    "what is are count list get by with from rows row table data"
).split())


def tokens(text):
    return [t for t in TOKEN_RE.findall((text or "").lower())
            if t not in STOP and len(t) > 1]


def load_menu():
    """The probe menu.

    READ-side tolerant (a bare array, or the {"probes": [...]} / {"menu": [...]}
    wrappers seen in the wild) but LOUD on an unrecognised shape: a silently
    empty menu is how a working instance turns into a refusal machine with no
    error anywhere.
    """
    with open(MENU, encoding="utf-8") as fh:
        menu = json.load(fh)
    if isinstance(menu, list):
        return menu
    if isinstance(menu, dict):
        for key in ("probes", "menu", "tools"):
            entries = menu.get(key)
            if isinstance(entries, list):
                return entries
    raise SystemExit(
        "needle_menu.json has an unrecognised shape: expected a bare JSON "
        "array (or one of probes/menu/tools), got %s" % type(menu).__name__)


COUNT_WORDS = ("how many", "count", "total", "number of")


# Caged fast paths, carried over by `--migrate-ask`: a list of
# (regex, probe, score). A declared cage is an explicit route — "show page 9"
# must beat "page count" — so a hit here also exempts the question from the
# gate's vocabulary rules (action-intent still applies).
FAST_PATHS = []


# Words that introduce a free-text argument ("which pages MENTION corporate
# governance", "search the report FOR revenue"). Stripped when binding a plain
# string argument that the menu does not cage.
ROUTING_WORDS = frozenset("""
    search find look mention mentions about for in into the a an of on
    report document pdf pages page which what list show me
""".split())


def free_text(question):
    """The payload of a search-style question, minus its routing words."""
    words = [w for w in re.findall(r"[A-Za-z0-9_.-]+", question)
             if w.lower() not in ROUTING_WORDS]
    return " ".join(words).strip()


def fast_path(question):
    """(probe, score) for the first declared cage that matches, else (None, 0)."""
    for pattern, probe, score in FAST_PATHS:
        try:
            if re.search(pattern, question, re.IGNORECASE):
                return probe, float(score)
        except re.error:
            continue
    return None, 0.0


# ── refusal gate ──────────────────────────────────────────────────────────
# Deterministic and menu-only: a question this instance cannot honestly answer
# is REFUSED rather than answered with the nearest probe's number. A confident
# wrong number is worse than a refusal. GATE_VERSION is asserted by the fleet
# guard (check_menu_bridge_alignment.py), so a regenerated ask.py cannot
# silently drop this block.
GATE_VERSION = 1
# The SHARED exit-code contract across neuralOSd / SuperAgent / ReactorPro:
# 0 = answered, 2 = nothing produced (refused or failed). Consumers keying on
# "nothing produced" must not have to know which product they are talking to.
ANSWERED_EXIT = 0
REFUSED_EXIT = 2

GENERIC_INTENT = frozenset("""
    how many much show list give tell me find get what which who where when
    top best most least first last sample example preview all any
    are is there exist exists please number status break down
    some few several couple
    a an the my our your their its
    has have had
""".split())

# An imperative ACTION is not a question. A read-only instance must refuse
# rather than answer with the nearest data.
ACTION_VERBS = ("play", "erase", "delete", "remove", "drop", "wipe", "purge",
                "send", "execute", "restart", "shutdown", "kill", "exploit",
                "deploy", "cancel")

# Status/time QUALIFIERS. A question carrying one the winning probe does not
# carry is a dropped filter - "work orders are blocked" answered with an open
# count is a wrong answer that looks right.
QUALIFIERS = ("blocked", "overdue", "rejected", "closed", "resolved",
              "pending", "escalated", "cancelled", "archived", "on hold",
              "last week", "last month", "last year", "this week",
              "this month", "yesterday", "today", "unassigned")

# Fraction of the question's domain nouns the winner must know.
MIN_QUESTION_COVERAGE = 0.5


def entry_vocab(entry):
    """Every token a probe can be said to know: triggers, name, enum values."""
    v = set(tokens(" ".join(entry.get("triggers") or [])))
    v.update(tokens((entry.get("name") or "").replace("_", " ")))
    props = ((entry.get("parameters") or {}).get("properties") or {})
    for spec in props.values():
        if isinstance(spec, dict):
            for val in spec.get("enum") or []:
                v.update(tokens(str(val)))
    return frozenset(v)


def plural_insensitive(token_set):
    return set(t[:-1] if len(t) > 3 and t.endswith("s") else t
               for t in token_set)


def known_anywhere(token, menu_vocab):
    if token in menu_vocab:
        return True
    if len(token) > 3 and token.endswith("s") and token[:-1] in menu_vocab:
        return True
    if len(token) > 3 and (token + "s") in menu_vocab:
        return True
    return False


def action_intent_reason(question, menu):
    """'action_intent' when the question opens with an imperative verb the menu
    does not know — i.e. the user asked for an ACTION, not for data."""
    menu_vocab = (frozenset().union(*[entry_vocab(e) for e in menu])
                  if menu else frozenset())
    first = (question or "").split()[:1]
    if first and first[0].lower() in ACTION_VERBS \
            and first[0].lower() not in menu_vocab:
        return "action_intent"
    return None


def gate_reason(question, entry, menu, arguments, fast_hit=False):
    """(reason, detail) to refuse, or (None, None) to answer.

    `reason` is a BARE token from the shared grammar — action_intent,
    dropped_filter, no_probe_matches, low_coverage — so exact-match consumers
    work identically across neuralOSd, SuperAgent and ReactorPro. The
    specifics live in `detail`, a separate envelope field.

    Computed from the MENU and the QUESTION only: no probe runs, no model is
    called. Qualifiers match whole words ("resolved" must not fire inside
    "unresolved") and articles/auxiliaries count as generic intent.
    """
    q_norm = " ".join(tokens(question))
    lowered = (question or "").lower()
    menu_vocab = (frozenset().union(*[entry_vocab(e) for e in menu])
                  if menu else frozenset())

    first = (question or "").split()[:1]
    if first and first[0].lower() in ACTION_VERBS \
            and first[0].lower() not in menu_vocab:
        return "action_intent", {"rule": "action_intent",
                                 "verb": first[0].lower()}

    # A declared cage ("show page N") is the confidence signal: an explicit
    # route is not a guess. action_intent above still outranks it.
    if fast_hit:
        return None, None

    # An extracted entity IS the confidence signal.
    for value in (arguments or {}).values():
        if value in (None, ""):
            continue
        needle = " ".join(tokens(str(value)))
        if needle and needle in q_norm:
            return None, None

    words = set(re.findall(r"[a-z0-9]+", lowered))
    vocab = entry_vocab(entry)
    for qual in QUALIFIERS:
        qw = qual.split()
        hit = (qw[0] in words) if len(qw) == 1 else (qual in lowered)
        if hit and qw[0] not in vocab:
            return "dropped_filter", {"rule": "dropped_filter", "word": qw[0]}

    qt = set(tokens(question))
    domain = set(t for t in qt - GENERIC_INTENT if not t.isdigit())
    if not domain:
        domain = set(qt - GENERIC_INTENT) or qt
    unknown = sorted(t for t in domain if not known_anywhere(t, menu_vocab))
    if unknown:
        return "no_probe_matches", {"rule": "no_probe_matches", "unknown": unknown}

    # Coverage is measured against the winner's FAMILY (probes sharing its first
    # name token), not the winner alone: "count records by status" is answered by
    # count_by_status while "records" is the count_records family's noun, and
    # scoring it against the single winner false-refused that phrasing.
    family = frozenset(
        t for e in menu
        if (e.get("name") or "").split("_")[0] == (entry.get("name") or "").split("_")[0]
        for t in entry_vocab(e))
    d = plural_insensitive(domain) | set(domain)
    known = plural_insensitive(vocab) | set(vocab) | plural_insensitive(family) | set(family)
    coverage = len(d.intersection(known)) / max(1, len(d))
    if MIN_QUESTION_COVERAGE > 0 and coverage < MIN_QUESTION_COVERAGE:
        return "low_coverage", {"rule": "low_coverage", "coverage": round(coverage, 4)}
    return None, None



def score(question_tokens, entry, count_intent):
    """A token in the probe NAME is worth 2, elsewhere 1; a count-shaped
    question gets a nudge toward `*count*` probes so "how many records" lands
    on count_records rather than the generic peek."""
    name_tokens = set(tokens(entry.get("name", "")))
    hay = set(name_tokens)
    hay.update(tokens(entry.get("description", "")))
    for trigger in entry.get("triggers") or []:
        hay.update(tokens(trigger))
    s = sum(2 if t in name_tokens else 1 for t in set(question_tokens) if t in hay)
    if count_intent and "count" in entry.get("name", ""):
        s += 1
    return s


def pick(question, menu):
    qt = tokens(question)
    if not qt:
        return None, 0
    count_intent = any(w in question.lower() for w in COUNT_WORDS)
    best, best_score = None, 0
    for entry in menu:
        s = score(qt, entry, count_intent)
        if s > best_score:
            best, best_score = entry, s
    return best, best_score


def bind_arguments(entry, question):
    """Fill the probe arguments from the question; refuse rather than fabricate."""
    spec = entry.get("parameters") or {}
    props = spec.get("properties") or {}
    required = spec.get("required") or []
    numbers = [int(n) for n in re.findall("[0-9]+", question)]
    words = set(TOKEN_RE.findall(question.lower()))
    args = {}
    for key, prop in props.items():
        if prop.get("enum"):
            hit = next((v for v in prop["enum"] if str(v).lower() in words), None)
            if hit is not None:
                args[key] = hit
            elif key in required:
                return None, "argument " + repr(key) + " is required; its value is not in the question"
            continue
        if prop.get("pattern"):
            # Pattern-caged args (free-text search terms, ids, logins). Without
            # this branch such an arg is never bound, so a search probe is
            # called with no term at all — and the gate cannot see the entity
            # that should exempt the question from its vocabulary check.
            match = re.search(prop["pattern"], question, re.IGNORECASE)
            if match and match.groups():
                args[key] = match.group(1).strip()
            elif key in required:
                return None, ("argument " + repr(key) + " is required and "
                              "cannot be resolved from the question")
            continue
        if prop.get("type") == "integer":
            if numbers:
                args[key] = numbers[0]
            elif key not in required:
                args[key] = 10
            continue
        if key in required:
            return None, "argument " + repr(key) + " is required and cannot be resolved from the question"
        # A plain (uncaged) string argument — a search term, a name, a filter
        # value. Leaving it unbound is how a search probe ends up called with no
        # term at all ("missing positional 'q'"), so bind the question's payload.
        if prop.get("type") in (None, "string"):
            payload = free_text(question)
            if payload:
                args[key] = payload
    return args, None


def execute(probe, arguments):
    sys.path.insert(0, HERE)
    import bridge
    return getattr(bridge, probe)(**arguments)


def engine_select(engine, model, question, menu):
    proc = subprocess.run(
        [engine, "--model", model, "--tools", MENU, "--prompt", question],
        capture_output=True, text=True, timeout=60)
    raw = proc.stdout.strip()
    payload = json.loads(raw) if raw else {}
    name = payload.get("name") or payload.get("tool")
    if name and any(e.get("name") == name for e in menu):
        return name, payload.get("arguments") or {}, float(payload.get("confidence") or 0.0)
    return None, {}, 0.0


def main(argv):
    engine = model = None
    if "--engine" in argv and argv.index("--engine") + 1 < len(argv):
        engine = argv[argv.index("--engine") + 1]
    if "--model" in argv and argv.index("--model") + 1 < len(argv):
        model = argv[argv.index("--model") + 1]
    question = " ".join(a for a in argv if not a.startswith("--")).strip() or {example}

    env = {"instance": {agent}, "question": question, "probe": None,
           "arguments": {}, "score": 0, "confidence": 0.0, "refused": False,
           "refusal_reason": None, "refusal_detail": None,
           "gate_version": GATE_VERSION}
    menu = load_menu()

    # An imperative ACTION outranks everything: "delete all returned orders" is
    # a request to DO something, not a question, and it must be refused as such
    # even when nothing on the menu scores (otherwise it degrades into a bland
    # "no probe matched" and the real reason is lost).
    action = action_intent_reason(question, menu)
    if action:
        env.update(probe=None, refused=True, refusal_reason=action,
                   refusal_detail={"rule": action},
                   gate_version=GATE_VERSION,
                   error="refused (" + action + "): this instance only answers questions")
        print(json.dumps(env, ensure_ascii=False, default=str))
        return REFUSED_EXIT

    entry, best = pick(question, menu)

    fast_probe, fast_score = fast_path(question)
    fast_hit = False
    if fast_probe:
        caged = next((e for e in menu if e.get("name") == fast_probe), None)
        if caged is not None:
            entry, best, fast_hit = caged, max(int(fast_score), 1), True

    if entry is None or best <= 0:
        if engine and model:
            try:
                name, arguments, confidence = engine_select(engine, model, question, menu)
            except Exception as exc:
                name, arguments, confidence = None, {}, 0.0
                env["error"] = "engine fallback failed: " + str(exc)
            if name:
                env.update(probe=name, arguments=arguments, confidence=confidence)
            else:
                env.update(refused=True, refusal_reason="no_probe_matches",
                           refusal_detail={"rule": "no_probe_matches", "why": "engine returned nothing usable"},
                           error=env.get("error", "no probe matched (engine returned nothing usable)"))
        else:
            env.update(refused=True, refusal_reason="no_probe_matches",
                       refusal_detail={"rule": "no_probe_matches", "why": "no lexical overlap"},
                       error="no probe matched")
        print(json.dumps(env, ensure_ascii=False, default=str))
        return REFUSED_EXIT

    arguments, why = bind_arguments(entry, question)
    if why:
        env.update(probe=entry["name"], score=best, refused=True,
                   refusal_reason="unbound_argument",
                   refusal_detail={"rule": "unbound_argument", "why": why},
                   error=why)
        print(json.dumps(env, ensure_ascii=False, default=str))
        return REFUSED_EXIT
    reason, detail = gate_reason(question, entry, menu, arguments, fast_hit=fast_hit)
    if reason:
        env.update(probe=None, score=best, refused=True,
                   refusal_reason=reason, refusal_detail=detail,
                   gate_version=GATE_VERSION,
                   error="refused (" + reason + "): the best match could not "
                         "honestly answer this question")
        print(json.dumps(env, ensure_ascii=False, default=str))
        return REFUSED_EXIT
    env.update(probe=entry["name"], arguments=arguments, score=best, confidence=1.0)
    try:
        env["result"] = execute(entry["name"], arguments)
    except Exception as exc:
        env.update(refused=True, refusal_reason="probe_error",
                   refusal_detail={"rule": "probe_error", "probe": entry["name"],
                                   "error": str(exc)},
                   error="probe " + entry["name"] + " failed: " + str(exc))
        print(json.dumps(env, ensure_ascii=False, default=str))
        return REFUSED_EXIT
    print(json.dumps(env, ensure_ascii=False, default=str))
    return ANSWERED_EXIT


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
'''

README = '''# {agent} — generated needle instance

Source kind : {kind}
Runtime     : {runtime}
Menu        : needle_menu.json ({n_probes} probes)

## Run (Python runtime)

    {py} instance.py "your question in plain English"

## Verify (Phase 4 — never skip)

    {py} verify.py            # model coverage
    {py} verify.py --full     # + 3-phrasing selection test
Then compare one relayed number against a direct query of the source and
record all three results in verification.txt.

## Ask (deterministic floor)

    {py} ask.py "your question in plain English"

ask.py is the deterministic-first entrance: it answers from the menu triggers
when the lexical overlap is positive and refuses ("no probe matched") when it
is not. The on-device engine is only a fallback seat (add
`--engine <needle> --model needle3.cact` to enable it). ReactorPro calls
ask.py before the engine so refusals stay honest.

## Engine runtime

`needle_menu.json` feeds the standalone engine directly:

    ./<platform>/needle --model <archive> --tools {out}/needle_menu.json --prompt "..."

The engine selects and fills the call; execution stays with this directory's
`bridge.py`.

## Extending

Data changed shape? Re-run the neuralos workflow (profile → model →
generate) and diff. New write-capable probes: only behind an explicit approval
flag, with identity checks in the bridge.
'''



# ── ask.py lineages and migration ───────────────────────────────────────────
# ask.py exists in at least three lineages in the wild: the gated template this
# generator writes, an earlier generator template, and older hand-written
# lexical+cache floors (wema-bmc 8 KB, mtn-annual-2019 1.6 KB). `--migrate-ask`
# consolidates them onto the one generated implementation WITHOUT losing what an
# instance added locally: declared caged routes move across verbatim, and
# anything this tool cannot read with certainty is reported, never guessed.

ASK_LINEAGE_GATED = "gated"
ASK_LINEAGE_TEMPLATE = "template"
ASK_LINEAGE_LEGACY = "legacy"

_FAST_PATH_DECL = re.compile(r"^\s*FAST_PATHS\s*=\s*(\[.*?\])\s*$", re.M | re.S)
_CAGED_RETURN = re.compile(
    r"re\.search\(\s*r?[\"'](?P<pattern>(?:[^\"']|\\.)*)[\"']\s*,[^)]*\)"
    r"(?P<body>.{0,200}?)return\s+[\"'](?P<probe>[a-z_][a-z0-9_]*)[\"']\s*,\s*(?P<score>[0-9.]+)",
    re.S)
# A whole caged route: one or more `re.search(...)` tests, optionally chained
# with `or`, that funnel into a single `return "<probe>", <score>`. This is how
# hand-written floors spell "these phrasings mean this probe" (mtn-build's
# "show page N" is an OR of three patterns) — all its patterns are one route.
# The whole `if <condition>:` block (condition may span lines with backslash
# continuations) whose body is `return "<probe>", <score>`.
_CAGED_ROUTE = re.compile(
    r"if\s+(?P<cond>.*?):[ \t]*\n[ \t]*return\s+"
    r"[\"'](?P<probe>[a-z_][a-z0-9_]*)[\"']\s*,\s*(?P<score>[0-9.]+)", re.S)
_COND_PATTERN = re.compile(r"re\.search\(\s*r?[\"'](?P<pattern>(?:[^\"']|\\.)*)[\"']")


def ask_lineage(text):
    """Which ask.py flavour is this?"""
    if "GATE_VERSION" in text or "def gate_reason(" in text:
        return ASK_LINEAGE_GATED
    if "FAST_PATHS" in text or "bind_arguments" in text:
        return ASK_LINEAGE_TEMPLATE
    return ASK_LINEAGE_LEGACY


def extract_fast_paths(text):
    """(carried, review): declared caged routes we can move verbatim, and the
    ones we cannot read with certainty (reported, never guessed)."""
    import ast

    carried, review = [], []
    decl = _FAST_PATH_DECL.search(text)
    if decl:
        try:
            for pattern, probe, score in ast.literal_eval(decl.group(1)):
                carried.append([str(pattern), str(probe), float(score)])
            return carried, review
        except Exception as exc:
            review.append("FAST_PATHS is declared but unreadable (%s)" % exc)
            return carried, review
    routes = list(_CAGED_ROUTE.finditer(text))
    if routes:
        for route in routes:
            patterns = [m.group("pattern") for m in _COND_PATTERN.finditer(route.group("cond"))]
            if not patterns:
                review.append("caged route for %r has no readable pattern" % route.group("probe"))
                continue
            for pattern in patterns:
                carried.append([pattern, route.group("probe"), float(route.group("score"))])
        return carried, review
    for match in _CAGED_RETURN.finditer(text):
        if "re.search" in match.group("body"):
            review.append("caged route for %r is ambiguous" % match.group("probe"))
            continue
        carried.append([match.group("pattern"), match.group("probe"),
                        float(match.group("score"))])
    if not carried and re.search(r"re\.search\(", text):
        review.append("regex-gated flow that cannot be mapped to a probe")
    # A RICH legacy floor (audit trail, TTL cache, hashing) implements more than
    # this template carries. Replacing it would silently drop those features, so
    # it is reported for review rather than migrated — even though the gate +
    # caged routes would transfer cleanly. Only --force overrides.
    rich = sorted(set(re.findall(r"\b(cache|audit|ttl|hashlib)\b", text, re.I)))
    if rich:
        review.append("legacy floor carries %s this template does not implement"
                      % ", ".join(rich))
    return carried, review


def render_ask(agent, example, fast_paths=None):
    """The current template, with any carried caged routes spliced in."""
    text = ASK.replace("{agent}", repr(agent)).replace("{example}", repr(example))
    if fast_paths:
        literal = "FAST_PATHS = [\n" + "".join(
            "    (%r, %r, %r),\n" % (pattern, probe, score)
            for pattern, probe, score in fast_paths) + "]"
        text = text.replace("FAST_PATHS = []", literal, 1)
    return text


def migrate_ask_file(path, apply_=False, force=False):
    """Plan (and optionally apply) one instance's ask.py migration."""
    report = {"instance": os.path.basename(os.path.dirname(path)),
              "path": path, "lineage": None, "action": None,
              "carried": [], "review": [], "changed": False}
    if not os.path.exists(path):
        report["action"] = "absent"
        return report
    current = open(path, encoding="utf-8").read()
    report["lineage"] = ask_lineage(current)
    carried, review = extract_fast_paths(current)
    report["carried"], report["review"] = carried, review
    proposed = render_ask(report["instance"], "", carried)
    if proposed == current:
        report["action"] = "noop"
        return report
    if review and not force:
        report["action"] = "blocked (needs review; --force to override)"
        return report
    report["action"] = "migrate"
    if apply_:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, path + ".premigrate-" + stamp)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(proposed)
        report["changed"] = True
        report["backup"] = path + ".premigrate-" + stamp
    return report


def migrate_ask(path, apply_=False, force=False, fleet=False):
    """One instance directory, or every instance under a fleet root."""
    looks_like_instance = os.path.exists(os.path.join(path, "ask.py")) or \
        os.path.exists(os.path.join(path, "needle_menu.json"))
    if not fleet and looks_like_instance:
        return [migrate_ask_file(os.path.join(path, "ask.py"), apply_, force)]
    reports = []
    for entry in sorted(os.listdir(path)):
        instance = os.path.join(path, entry)
        if not os.path.isdir(instance) or entry.startswith("."):
            continue
        if not os.path.exists(os.path.join(instance, "needle_menu.json")):
            continue
        reports.append(migrate_ask_file(os.path.join(instance, "ask.py"), apply_, force))
    return reports


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", default="profile.json")
    ap.add_argument("--models", default="models.py")
    ap.add_argument("--out", default="instance")
    ap.add_argument("--db-dsn", default="", help="DSN baked into the bridge")
    ap.add_argument("--dsn-env", default="NEURALOS_DSN")
    ap.add_argument("--runtime", choices=["python", "engine"], default="python")
    ap.add_argument("--agent-name")
    ap.add_argument("--table", help="database table (default: first profiled)")
    ap.add_argument("--migrate-ask", metavar="PATH",
                    help="consolidate an instance's (or a fleet's) ask.py onto the "
                         "current generated implementation")
    ap.add_argument("--fleet", action="store_true",
                    help="treat --migrate-ask PATH as a fleet root")
    ap.add_argument("--apply", action="store_true",
                    help="with --migrate-ask: write (default is a dry run)")
    ap.add_argument("--force", action="store_true",
                    help="with --migrate-ask: migrate even when something needs review")
    args = ap.parse_args()

    if args.migrate_ask:
        reports = migrate_ask(args.migrate_ask, apply_=args.apply,
                              force=args.force, fleet=args.fleet)
        blocked = 0
        for report in reports:
            print("%-22s %-9s %-9s carried=%d review=%d%s"
                  % (report["instance"], report["lineage"] or "-", report["action"],
                     len(report["carried"]), len(report["review"]),
                     "  (dry run)" if report["action"] == "migrate" and not args.apply else ""))
            for note in report["review"]:
                print("    review: %s" % note)
            if report["action"].startswith("blocked"):
                blocked += 1
        if not args.apply:
            print("\ndry run: nothing written (re-run with --apply)")
        return 1 if blocked else 0

    profile = json.load(open(args.profile, encoding="utf-8"))
    kind = profile["source"]["kind"]
    # Detect the first model class from the SOURCE models.py (the copy into
    # --out happens later — scanning the out dir here always missed it and
    # left file-source bridges importing a nonexistent "Record").
    model_class = "Record"
    if os.path.exists(args.models):
        for line in open(args.models, encoding="utf-8"):
            mcls = re.match(r"class (\w+)\(", line)
            if mcls:
                model_class = mcls.group(1)
                break
    table = args.table or (profile["source"].get("tables") or [{}])[0].get("name")
    agent_name = args.agent_name or snake(os.path.basename(
        profile["source"]["location"]).split(".")[0].replace(":", "_")) or "feed"

    os.makedirs(args.out, exist_ok=True)
    if os.path.exists(args.models):
        import shutil
        src_m, dst_m = os.path.abspath(args.models), os.path.abspath(
            os.path.join(args.out, "models.py"))
        if src_m != dst_m:
            shutil.copy(src_m, dst_m)
    menu = build_menu(profile, table, agent_name)
    menu_path = os.path.join(args.out, "needle_menu.json")
    with open(menu_path, "w", encoding="utf-8") as fh:
        json.dump(menu, fh, indent=2, ensure_ascii=False)

    loc = profile["source"]["location"]
    if kind != "database" and loc.lower().endswith((".xlsx", ".xls")):
        # The bridge reads delimited text — a binary xlsx read as CSV yields
        # garbage (0% coverage, caught live by eval #6). Convert values-only
        # to a CSV snapshot beside the instance, exactly as the profiler did.
        try:
            import openpyxl
        except ImportError:
            raise SystemExit("xlsx instances need openpyxl: pip install openpyxl")
        wb = openpyxl.load_workbook(loc, read_only=True, data_only=True)
        ws = wb[wb.sheetnames[0]]
        os.makedirs(args.out, exist_ok=True)
        snap = os.path.abspath(os.path.join(args.out, "source_snapshot.csv"))
        import csv as _csv
        with open(snap, "w", newline="", encoding="utf-8") as fh:
            cw = _csv.writer(fh)
            for row in ws.iter_rows(values_only=True):
                cw.writerow(["" if c is None else str(c) for c in row])
        profile["source"]["location"] = snap
        profile["source"]["origin_workbook"] = loc
    elif kind != "database" and loc.startswith("http"):
        # URL-sourced profile: the bridge cannot open() an https:// path
        # (caught live by eval #5 — FileNotFoundError on the URL). Snapshot
        # the fetched body beside the instance so it stays offline-runnable,
        # and record the origin in the profile.
        import urllib.request
        req = urllib.request.Request(loc, headers={"User-Agent": "neuralos-generator/1.0"})
        body = urllib.request.urlopen(req, timeout=60).read(4 * 1024 * 1024)
        os.makedirs(args.out, exist_ok=True)
        snap = os.path.abspath(os.path.join(args.out, "source_snapshot"))
        open(snap, "wb").write(body)
        profile["source"]["location"] = snap
        profile["source"]["origin_url"] = loc
    elif kind != "database" and not loc.startswith("/") and os.path.exists(loc):
        profile["source"]["location"] = os.path.abspath(loc)
    dsn = args.db_dsn or (profile["source"]["location"] if kind == "database" else "")
    if kind == "database" and dsn.startswith("sqlite:///"):
        _sp = dsn[len("sqlite:///"):]
        if not os.path.isabs(_sp):
            # relative sqlite path breaks when the instance runs from its own
            # directory (caught live by eval #7) — bake the absolute path
            # "sqlite://" + abspath == exactly 3 slashes before the path;
            # a 4th slash makes usql fail to open the file (caught by eval #7)
            dsn = "sqlite://" + os.path.abspath(_sp)
    bridge_code = (bridge_database(profile, dsn, args.dsn_env)
                   if kind == "database" else bridge_files(profile, log=(kind == "log_lines"), model_class=model_class))
    open(os.path.join(args.out, "bridge.py"), "w", encoding="utf-8").write(bridge_code)

    # Graph layer (Phase-1 relationship discovery, optional): when its outputs
    # exist beside the profile, ride them along so the instance directory
    # matches the SKILL.md contract (graph_edges.json + graph_bridge.py).
    import shutil
    graph_edges = os.path.join(
        os.path.dirname(os.path.abspath(args.profile)), "graph_edges.json")
    if os.path.exists(graph_edges):
        shutil.copy(graph_edges, os.path.join(args.out, "graph_edges.json"))
    graph_bridge_src = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "graph_bridge.py")
    if os.path.exists(graph_bridge_src):
        shutil.copy(graph_bridge_src, os.path.join(args.out, "graph_bridge.py"))

    example = (f"give me the {snake(table or agent_name)} summary"
               if kind == "database" else "show me a summary of the data")
    if args.runtime == "python":
        open(os.path.join(args.out, "instance.py"), "w", encoding="utf-8").write(
            instance_code(profile, table, agent_name, example))

    model_cls = pascal(table) if kind == "database" else ("LogLine" if kind == "log_lines" else "Record")
    if kind == "database":
        sample_call = f'bridge.{snake(table)}_recent(limit=10, model={pascal(table)})'
        phrasings = [f"how many {snake(table)}", f"count all {snake(table)} rows",
                     f"{snake(table)} total"]
    elif kind == "log_lines":
        sample_call = "bridge.parse_tail(lines=50)"
        phrasings = ["count by level", "errors in the log", "log level counts"]
    else:
        sample_call = "bridge.peek(limit=10)"
        phrasings = ["how many records", "count records", "record count"]
    verify_code = VERIFY.replace("{sample_call}", sample_call).replace(
        "{phrasings}", repr(phrasings))
    if kind == "database":
        verify_code = verify_code.replace(
            "import bridge\n",
            "import bridge\nfrom models import " + pascal(table) + "\n")
    open(os.path.join(args.out, "verify.py"), "w", encoding="utf-8").write(verify_code)
    # The deterministic-first entrance every instance ships and ReactorPro
    # calls before the engine (see the neuralOS ask.py floor contract).
    open(os.path.join(args.out, "ask.py"), "w", encoding="utf-8").write(
        ASK.replace("{agent}", repr(agent_name)).replace("{example}", repr(example)))
    open(os.path.join(args.out, "README.md"), "w", encoding="utf-8").write(
        README.format(agent=agent_name, kind=kind, runtime=args.runtime,
                      n_probes=len(menu), out=os.path.abspath(args.out),
                      py=sys.executable))

    print(f"instance written: {args.out}/")
    print(f"  probes on menu : {len(menu)} -> " + ", ".join(m["name"] for m in menu))
    print(f"  runtime        : {args.runtime}")


if __name__ == "__main__":
    # main() returns an exit code for the ask.py migration modes (1 = blocked).
    raise SystemExit(main())
