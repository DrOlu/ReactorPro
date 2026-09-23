#!/usr/bin/env python3
"""Fetch a prebuilt needle 3 engine bundle + weights into the Tauri resources
directory, so desktop releases ship neuralOS without any manual download.

Thin wrapper over the fetch machinery published in the cactus-needle package
(the same one the neuralOS skill's bootstrap_engine.py uses). Requires:

    python -m pip install cactus-needle

Usage:
    python scripts/neuralos/fetch_engine.py --platform macos-arm64 \
        --dest crates/agent-gui/src-tauri/resources/neuralos

The produced resources/neuralos/ holds the `needle` binary (+ .h/.a) and
needle3.cact; tauri.conf resources map bundles it as `neuralos/*`.
"""

import argparse
import os
import shutil
import stat
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True,
                        help="engine platform, e.g. macos-arm64, macos-x86_64, "
                             "windows-x86_64, linux-x86_64")
    parser.add_argument("--dest", required=True,
                        help="resources/neuralos directory to populate")
    args = parser.parse_args()

    try:
        from needle.agent import fetch
    except ImportError:
        raise SystemExit("cactus-needle is not installed for this Python "
                         f"({sys.executable}). Run: "
                         f"{sys.executable} -m pip install cactus-needle")

    if args.platform not in fetch.PLATFORMS:
        raise SystemExit(f"unknown platform {args.platform!r}; "
                         f"known: {', '.join(sorted(fetch.PLATFORMS))}")

    dest = os.path.abspath(args.dest)
    os.makedirs(dest, exist_ok=True)
    print(f"downloading engine bundle for {args.platform} -> {dest}/", flush=True)
    files = fetch.download_platform(args.platform,
                                    os.path.dirname(dest) or ".",
                                    generation=3, dest=dest)
    for path in files:
        print(f"  {path}")

    print("fetching base weights (needle3.cact, ~35 MB, cached) ...", flush=True)
    weights = fetch.fetch_weights(generation=3)
    target = os.path.join(dest, os.path.basename(weights))
    if os.path.abspath(weights) != os.path.abspath(target):
        shutil.copyfile(weights, target)
    print(f"  {target}")

    # The engine binary must stay executable through the bundler.
    for name in ("needle", "needle.exe"):
        binary = os.path.join(dest, name)
        if os.path.exists(binary) and name == "needle":
            mode = os.stat(binary).st_mode
            os.chmod(binary, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            print(f"  chmod +x {binary}")


if __name__ == "__main__":
    main()
