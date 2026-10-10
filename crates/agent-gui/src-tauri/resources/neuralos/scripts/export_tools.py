#!/usr/bin/env python3
"""Export @needle.tool schemas from a Python module to tools.json.

Produces the JSON array the standalone engine binary (--tools) and
`needle run --tools` consume, straight from the decorated functions — so the
Python API and the engine always share one source of truth.

Usage:
    python export_tools.py my_tools_module.py                    # all tools
    python export_tools.py my_tools_module.py tool_a tool_b       # subset
    python export_tools.py my_tools_module.py -o tools.json

Notes:
  - The module is imported, so its top-level code runs. Keep tool modules
    import-safe (no side effects beyond defining functions/constants).
  - Tools are discovered via the `_needle_tool` schema the decorator
    attaches, so triggers, Field constraints and Args: descriptions are all
    carried over.
"""

import argparse
import importlib.util
import json
import os
import sys


def load_module(path: str):
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        raise SystemExit(f"no such file: {path}")
    spec = importlib.util.spec_from_file_location(
        "_export_tools_target", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        raise SystemExit(f"importing {path} failed: {exc}\n"
                         "(tool modules must be import-safe — no side "
                         "effects at top level)")
    return module



# ── faithful argument specs (Bug 5) ─────────────────────────────────────────
# The menu is the engine's grammar AND the ask path's caging. A caged argument
# exported without its constraint ("type": "pattern" with no regex, or a plain
# "string" where the source declared a pattern) silently breaks both layers, so
# the writer re-derives every constraint from the real function signature and
# refuses to write a menu it cannot verify.

_VALID_TYPES = {"string", "integer", "number", "boolean", "array", "object"}


def _annotation_spec(annotation):
    """(json_type, enum) for a Python annotation, or (None, None)."""
    import typing

    origin = typing.get_origin(annotation)
    if origin is typing.Annotated:
        # Annotated[X, ...] carries the constraints; the JSON type is X's.
        return _annotation_spec(typing.get_args(annotation)[0])
    if origin is typing.Literal:
        values = list(typing.get_args(annotation))
        return "string", [str(v) for v in values]
    if origin is typing.Union:
        args = [a for a in typing.get_args(annotation) if a is not type(None)]
        return _annotation_spec(args[0]) if len(args) == 1 else (None, None)
    return {int: ("integer", None), float: ("number", None),
            bool: ("boolean", None), str: ("string", None),
            list: ("array", None), dict: ("object", None)}.get(annotation, (None, None))


def _constraint_spec(annotation):
    """Constraints carried by Annotated[...]/Field metadata (duck-typed)."""
    import typing

    out = {}
    if typing.get_origin(annotation) is not typing.Annotated:
        return out
    for meta in typing.get_args(annotation)[1:]:
        for attr, key in (("ge", "minimum"), ("gt", "exclusiveMinimum"),
                          ("le", "maximum"), ("lt", "exclusiveMaximum"),
                          ("pattern", "pattern"), ("regex", "pattern"),
                          ("min_length", "minLength"), ("max_length", "maxLength")):
            value = getattr(meta, attr, None)
            if value is not None:
                out[key] = value
        enum = getattr(meta, "enum", None)
        if enum:
            out["enum"] = [str(v) for v in enum]
    return out


def derive_parameters(fn):
    """JSON-Schema `parameters` straight from the function signature."""
    import inspect
    import typing

    signature = inspect.signature(fn)
    properties, required = {}, []
    hints = typing.get_type_hints(fn, include_extras=True)
    for name, param in signature.parameters.items():
        if name in ("self", "cls") or param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        annotation = hints.get(name, param.annotation)
        json_type, enum = _annotation_spec(annotation)
        spec = {}
        if json_type:
            spec["type"] = json_type
        if enum:
            spec["type"] = "string"
            spec["enum"] = enum
        spec.update(_constraint_spec(annotation))
        if param.default is not inspect.Parameter.empty:
            if param.default is not None and "enum" not in spec:
                spec["default"] = param.default
        else:
            required.append(name)
        existing = properties.get(name) or {}
        existing.update({k: v for k, v in spec.items() if v is not None})
        properties[name] = existing
    return {"type": "object", "properties": properties, "required": required}


def normalise_schemas(schemas):
    """Merge signature-derived specs over the decorated ones and VALIDATE.

    Raises SystemExit on anything it cannot verify — a menu that silently
    drops a caging constraint is worse than a failed export.
    """
    for schema in schemas:
        name = schema.get("name") or "<unnamed>"
        fn = schema.pop("_fn", None)
        if fn is not None:
            derived = derive_parameters(fn)
            current = schema.get("parameters") or {}
            for key, spec in derived["properties"].items():
                merged = dict(current.get("properties", {}).get(key) or {})
                merged.update({k: v for k, v in spec.items() if v is not None})
                current.setdefault("properties", {})[key] = merged
            current["type"] = "object"
            current["required"] = derived["required"]
            schema["parameters"] = current

        spec = schema.get("parameters") or {}
        props = spec.get("properties") or {}
        for key, prop in props.items():
            if not isinstance(prop, dict):
                raise SystemExit("menu %s: argument %r is not a schema object" % (name, key))
            declared = prop.get("type")
            if declared == "pattern":          # legacy lossy spelling
                prop["type"] = "string"
                declared = "string"
                if not prop.get("pattern"):
                    raise SystemExit(
                        "menu %s: argument %r declares a pattern cage but no "
                        "pattern regex — refusing to export a menu whose caging "
                        "is gone" % (name, key))
            if declared is not None and declared not in _VALID_TYPES:
                raise SystemExit("menu %s: argument %r has unknown type %r"
                                 % (name, key, declared))
            if prop.get("enum"):
                prop["type"] = "string"
        for key in spec.get("required") or []:
            if key not in props:
                raise SystemExit("menu %s: required argument %r is not declared"
                                 % (name, key))
    return schemas

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("module", help="path to a .py file with @needle.tool functions")
    parser.add_argument("tools", nargs="*",
                        help="optional tool/function names to include (default: all)")
    parser.add_argument("-o", "--out", default="tools.json",
                        help="output path (default: ./tools.json)")
    args = parser.parse_args()

    try:
        import needle  # noqa: F401
    except ImportError:
        # Exporting only needs the module's own decorated functions. Warn
        # instead of failing so a menu can be rebuilt on a machine without the
        # runtime installed (CI, an operator box).
        print("warning: cactus-needle is not installed for this Python "
              f"({sys.executable}); exporting from the module's own schemas",
              file=sys.stderr)

    module = load_module(args.module)
    found = {}
    for name in dir(module):
        member = getattr(module, name, None)
        if callable(member) and hasattr(member, "_needle_tool"):
            schema = dict(member._needle_tool)
            schema["_fn"] = member          # source of truth for the caging
            found[name] = schema

    if not found:
        raise SystemExit(f"no @needle.tool functions found in {args.module}")

    if args.tools:
        missing = [t for t in args.tools if t not in found]
        if missing:
            raise SystemExit(f"not tool functions in module: {missing}\n"
                             f"available: {sorted(found)}")
        selected = {t: found[t] for t in args.tools}
    else:
        selected = found

    schemas = normalise_schemas(list(selected.values()))
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(schemas, handle, indent=2, ensure_ascii=False)
    print(f"wrote {args.out}: {[s['name'] for s in schemas]}")


if __name__ == "__main__":
    main()
