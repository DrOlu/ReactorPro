#!/usr/bin/env python3
"""Build the synapse-gateway distribution set (PyPI wheels + npm packages).

Bundles the reactorpro-gateway + reactorpro-agentd binaries from a GitHub
release into per-platform packages so `pip install synapse-gateway` and
`npm i -g @hyperspaceng/synapse-gateway` work offline on any supported host.

  Go target            PyPI wheel tag            npm platform pkg
  linux/amd64          manylinux2014_x86_64      -linux-x64-gnu
  linux/arm64          manylinux2014_aarch64     -linux-arm64-gnu
  darwin/amd64         macosx_11_0_x86_64        -darwin-x64
  darwin/arm64         macosx_11_0_arm64         -darwin-arm64
  windows/amd64        win_amd64                 -win32-x64

Binaries + SHA256SUMS come from:
  https://github.com/DrOlu/ReactorPro/releases/download/<tag>/

Usage:
  python scripts/build_synapse_gateway_packages.py --release-tag v1.7.6
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NPM = ROOT / "npm-synapse"
DIST = ROOT / "synapse-dist"
RELEASE_BASE = "https://github.com/DrOlu/ReactorPro/releases/download"
NPM_SCOPE = "@hyperspaceng"

TARGETS = {
    "linux-amd64": {"wheel": "manylinux2014_x86_64", "npm": "linux-x64-gnu",
                    "bin": "reactorpro-gateway-linux-amd64", "agentd": "reactorpro-agentd-linux-amd64"},
    "linux-arm64": {"wheel": "manylinux2014_aarch64", "npm": "linux-arm64-gnu",
                    "bin": "reactorpro-gateway-linux-arm64", "agentd": "reactorpro-agentd-linux-arm64"},
    "darwin-amd64": {"wheel": "macosx_11_0_x86_64", "npm": "darwin-x64",
                     "bin": "reactorpro-gateway-darwin-amd64", "agentd": "reactorpro-agentd-darwin-amd64"},
    "darwin-arm64": {"wheel": "macosx_11_0_arm64", "npm": "darwin-arm64",
                     "bin": "reactorpro-gateway-darwin-arm64", "agentd": "reactorpro-agentd-darwin-arm64"},
    "windows-amd64": {"wheel": "win_amd64", "npm": "win32-x64",
                      "bin": "reactorpro-gateway-windows-amd64.exe",
                      "agentd": "reactorpro-agentd-windows-amd64.exe"},
}


def http_download(url: str, dest: Path) -> Path:
    print(f"downloading {url}", flush=True)
    request = urllib.request.Request(url, headers={"User-Agent": "synapse-gateway-build/1.0"})
    with urllib.request.urlopen(request, timeout=600) as response, open(dest, "wb") as out:
        shutil.copyfileobj(response, out)
    return dest


def fetch_binaries(tag: str, targets: list[str], cache: Path) -> dict:
    """Download gateway + agentd per target; verify against SHA256SUMS when present."""
    sums: dict[str, str] = {}
    sums_path = cache / "SHA256SUMS"
    try:
        http_download(f"{RELEASE_BASE}/{tag}/SHA256SUMS", sums_path)
        for line in sums_path.read_text().splitlines():
            parts = line.split()
            if len(parts) == 2:
                sums[parts[1]] = parts[0]
    except Exception as exc:
        print(f"WARNING: SHA256SUMS unavailable ({exc}); skipping verification")

    import hashlib

    binaries = {}
    for target in targets:
        entry = {}
        for key in ("bin", "agentd"):
            asset = TARGETS[target][key]
            dest = cache / asset
            if not dest.exists():
                http_download(f"{RELEASE_BASE}/{tag}/{asset}", dest)
            if asset in sums:
                actual = hashlib.sha256(dest.read_bytes()).hexdigest()
                if actual != sums[asset]:
                    raise SystemExit(f"checksum mismatch for {asset}")
            entry[key] = dest
        binaries[target] = entry
    return binaries


# ─────────────────────────── PyPI ────────────────────────────────────────────

LAUNCHER_BODY = '''
import os
import subprocess
import sys
from pathlib import Path

_BIN_DIR = Path(__file__).resolve().parent / "bin"


def _binary(name: str) -> Path:
    exe = name + (".exe" if os.name == "nt" else "")
    path = _BIN_DIR / exe
    if not path.is_file():
        raise SystemExit(
            f"synapse-gateway: {exe} is not bundled in this wheel. "
            "Reinstall with --only-binary=:all:, or grab a binary from "
            "https://github.com/DrOlu/ReactorPro/releases")
    if os.name != "nt":
        mode = path.stat().st_mode
        if not mode & 0o100:
            path.chmod(mode | 0o111)
    return path


def _run(name: str, argv: list[str]) -> int:
    exe = _binary(name)
    if os.name == "nt":
        return subprocess.call([str(exe), *argv])
    os.execv(str(exe), [str(exe), *argv])
    return 0  # pragma: no cover


def main_gateway() -> int:
    return _run("reactorpro-gateway", sys.argv[1:])


def main_agentd() -> int:
    return _run("reactorpro-agentd", sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main_gateway())
'''

PYPROJECT = '''\
[build-system]
requires = ["setuptools>=68.0"]
build-backend = "setuptools.build_meta"

[project]
name = "synapse-gateway"
dynamic = ["version"]
description = "ReactorPro Gateway (Synapse) as a pip-installable native binary - headless agent mesh gateway + agentd worker"
requires-python = ">=3.9"
readme = "README.md"
license = { text = "Apache-2.0" }

[project.scripts]
synapse-gateway = "synapse_gateway:main_gateway"
synapse-agentd = "synapse_gateway:main_agentd"

[tool.setuptools.packages.find]
where = ["src"]

[tool.setuptools.package-data]
synapse_gateway = ["bin/*"]
'''


def build_pypi(version: str, targets: list[str], binaries: dict, dist: Path) -> list[Path]:
    work = dist / "_pypi"
    pkg = work / "src" / "synapse_gateway"
    pkg.mkdir(parents=True, exist_ok=True)
    (work / "README.md").write_text(
        "# synapse-gateway\n\nThe ReactorPro Gateway (Synapse agent mesh) as native binaries:\n"
        "`pip install synapse-gateway` then run `synapse-gateway` / `synapse-agentd`.\n")
    (work / "pyproject.toml").write_text(PYPROJECT)

    def one_any_wheel() -> Path:
        expected = dist / f"synapse_gateway-{version}-py3-none-any.whl"
        expected.unlink(missing_ok=True)
        # setuptools does NOT clean build/: stale binaries leak between wheels.
        for residue in (work / "build", *work.glob("*.egg-info")):
            shutil.rmtree(residue, ignore_errors=True)
        subprocess.run([sys.executable, "-m", "build", "--wheel", "--no-isolation",
                        "--outdir", str(dist)], check=True, cwd=work)
        if not expected.exists():
            raise SystemExit(f"wheel build did not produce {expected.name}")
        return expected

    def retag(wheel: Path, platform_tag: str) -> Path:
        # wheel >= 0.45 dropped --dest-dir: output lands next to the original.
        subprocess.run([sys.executable, "-m", "wheel", "tags", "--platform-tag", platform_tag,
                        "--remove", str(wheel)], check=True, cwd=work)
        retagged = wheel.with_name(wheel.name.replace("-any.whl", f"-{platform_tag}.whl"))
        if not retagged.exists():
            raise SystemExit(f"retagging failed: {retagged}")
        return retagged

    bindir = pkg / "bin"
    produced = []

    # fallback wheel: no binaries, launcher explains where to get them
    shutil.rmtree(bindir, ignore_errors=True)
    (pkg / "__init__.py").write_text(
        f'"""synapse-gateway - the ReactorPro Gateway (Synapse) native runtime."""\n\n'
        f'__version__ = "{version}"\n' + LAUNCHER_BODY)
    produced.append(one_any_wheel())
    print(f"built {produced[-1].name}")

    for target in targets:
        spec = TARGETS[target]
        shutil.rmtree(bindir, ignore_errors=True)
        bindir.mkdir(parents=True)
        for key in ("bin", "agentd"):
            src = binaries[target][key]
            dest = bindir / src.name
            shutil.copy2(src, dest)
            dest.chmod(dest.stat().st_mode | 0o111)
        wheel = retag(one_any_wheel(), spec["wheel"])
        print(f"built {wheel.name}")
        produced.append(wheel)

    shutil.rmtree(bindir, ignore_errors=True)
    return produced


# ─────────────────────────── npm ─────────────────────────────────────────────

def build_npm(version: str, targets: list[str], binaries: dict, dist: Path) -> list[Path]:
    produced = []
    for target in targets:
        spec = TARGETS[target]
        goos, goarch = target.split("-")
        pkg_dir = dist / "npm" / spec["npm"]
        (pkg_dir / "bin").mkdir(parents=True, exist_ok=True)
        for key in ("bin", "agentd"):
            shutil.copy2(binaries[target][key], pkg_dir / "bin" / binaries[target][key].name)
        manifest = {
            "name": f"{NPM_SCOPE}/synapse-gateway-{spec['npm']}",
            "version": version,
            "description": f"ReactorPro Gateway (Synapse) binaries for {target}",
            "os": {"linux": ["linux"], "darwin": ["darwin"], "windows": ["win32"]}[goos],
            "cpu": {"amd64": ["x64"], "arm64": ["arm64"]}[goarch],
            **({"libc": ["glibc"]} if goos == "linux" else {}),
            "files": ["bin"],
            "license": "Apache-2.0",
            "repository": {"type": "git", "url": "git+https://github.com/DrOlu/ReactorPro.git"},
        }
        (pkg_dir / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")
        produced.append(pkg_dir)

    main_dir = dist / "npm" / "main"
    if main_dir.exists():
        shutil.rmtree(main_dir)
    shutil.copytree(NPM, main_dir, ignore=shutil.ignore_patterns("dist", "node_modules"))
    manifest_path = main_dir / "package.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["version"] = version
    manifest["optionalDependencies"] = {
        f"{NPM_SCOPE}/synapse-gateway-{TARGETS[t]['npm']}": version for t in targets
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    produced.append(main_dir)
    return produced


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-tag", required=True, help="gateway release tag, e.g. v1.7.6")
    parser.add_argument("--version", default=None,
                        help="package version (default: release tag without the v)")
    parser.add_argument("--targets", default=",".join(TARGETS))
    parser.add_argument("--out", default=str(DIST))
    parser.add_argument("--skip-pypi", action="store_true")
    parser.add_argument("--skip-npm", action="store_true")
    args = parser.parse_args()

    version = args.version or args.release_tag.lstrip("v")
    if not re.match(r"^\d+\.\d+\.\d+$", version):
        raise SystemExit(f"invalid version: {version!r}")

    targets = [t for t in args.targets.split(",") if t]
    for t in targets:
        if t not in TARGETS:
            raise SystemExit(f"unknown target: {t}")

    dist = Path(args.out)
    if dist.exists():
        shutil.rmtree(dist)
    dist.mkdir(parents=True)

    cache = Path(tempfile.mkdtemp(prefix="synapse-gw-binaries-"))
    binaries = fetch_binaries(args.release_tag, targets, cache)

    if not args.skip_pypi:
        wheels = build_pypi(version, targets, binaries, dist)
        print("\nPyPI wheels:")
        for w in wheels:
            print(f"  {w}")
    if not args.skip_npm:
        pkgs = build_npm(version, targets, binaries, dist)
        print("\nnpm packages:")
        for p in pkgs:
            print(f"  {p}")


if __name__ == "__main__":
    main()
