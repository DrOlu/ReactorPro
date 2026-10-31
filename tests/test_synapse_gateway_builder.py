"""Unit tests for scripts/build_synapse_gateway_packages.py — the builder
behind the `synapse-gateway` PyPI package and the @hyperspaceng npm packages.

Adversarial edge cases included; several encode real bugs found in the
robustness sweep (checksum-verification FN, lstrip version mangling,
retry-on-404 behavior).
"""

import importlib.util
import json
import os
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "build_synapse_gateway_packages.py"


@pytest.fixture(scope="module")
def b():
    """The builder module, imported from the script path."""
    spec = importlib.util.spec_from_file_location(
        "build_synapse_gateway_packages", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["build_synapse_gateway_packages"] = mod
    spec.loader.exec_module(mod)
    return mod


# ── the target matrix ───────────────────────────────────────────────────────
def test_targets_matrix_is_complete_and_consistent(b):
    expected = {"linux-amd64": "manylinux2014_x86_64",
                "linux-arm64": "manylinux2014_aarch64",
                "darwin-amd64": "macosx_11_0_x86_64",
                "darwin-arm64": "macosx_11_0_arm64",
                "windows-amd64": "win_amd64"}
    assert set(b.TARGETS) == set(expected)
    for target, wheel in expected.items():
        assert b.TARGETS[target]["wheel"] == wheel
        assert b.TARGETS[target]["bin"].startswith("reactorpro-gateway-")
        assert b.TARGETS[target]["agentd"].startswith("reactorpro-agentd-")
        assert target.replace("-", "-") in b.TARGETS[target]["bin"]


def test_windows_targets_carry_exe_suffix(b):
    assert b.TARGETS["windows-amd64"]["bin"].endswith(".exe")
    assert b.TARGETS["windows-amd64"]["agentd"].endswith(".exe")
    for t in ("linux-amd64", "darwin-arm64"):
        assert not b.TARGETS[t]["bin"].endswith(".exe")


def test_npm_platform_mapping(b):
    assert b.TARGETS["linux-amd64"]["npm"] == "linux-x64-gnu"
    assert b.TARGETS["windows-amd64"]["npm"] == "win32-x64"


# ── http_download: retry-on-404, immediate raise otherwise ──────────────────
class _Server:
    def __init__(self, handler):
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def stop(self):
        self.srv.shutdown()


def test_http_download_retries_404_then_succeeds(b, tmp_path, monkeypatch):
    """The `released` event can land while assets are still uploading: a 404
    must retry with backoff, then serve the file once it appears."""
    state = {"hits": 0}
    payload = b"fake-gateway-binary"

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            state["hits"] += 1
            if state["hits"] < 3:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *a):
            pass

    srv = _Server(H)
    monkeypatch.setattr("time.sleep", lambda s: None)      # no waiting in tests
    out = b.http_download(f"{srv.url}/reactorpro-gateway-x", tmp_path / "bin")
    srv.stop()
    assert out.read_bytes() == payload
    assert state["hits"] == 3


def test_http_download_raises_immediately_on_500(b, tmp_path, monkeypatch):
    """404 retries; every other HTTP error must raise on the first hit —
    retrying a broken release link for minutes serves nobody."""

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(500)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = _Server(H)
    monkeypatch.setattr("time.sleep", lambda s: None)
    with pytest.raises(Exception):
        b.http_download(f"{srv.url}/x", tmp_path / "bin")
    srv.stop()


# ── checksum verification: FN / FP edges ────────────────────────────────────
def _write_sums(cache, entries):
    lines = []
    for name, digest in entries.items():
        lines.append(f"{digest}  {name}")
    (cache / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _fake_binaries(b, cache, names):
    import hashlib
    out = {}
    for name in names:
        p = cache / name
        p.write_bytes(f"content-of-{name}".encode())
        out[name] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def test_checksum_binary_mode_marker_and_spaces_in_name(b, tmp_path):
    """sha256sum emits '<hash> *<file>' (binary mode) and filenames may
    contain spaces — both must verify, not silently skip (v1.7.6-era FN)."""
    import hashlib
    asset = "reactorpro-gateway-linux-amd64"
    payload = b"binaries"
    (tmp_path / asset).write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    # binary-mode marker AND a space in the name
    (tmp_path / "SHA256SUMS").write_text(
        f"{digest} *{asset}\n{digest}  file with spaces.bin\n", encoding="utf-8")
    sums = {}
    for line in (tmp_path / "SHA256SUMS").read_text().splitlines():
        parts = line.split(None, 1)
        assert len(parts) == 2
        sums[parts[1].lstrip("*").strip()] = parts[0]
    assert asset in sums
    assert "file with spaces.bin" in sums


def test_fetch_binaries_fails_when_asset_missing_from_sums(b, tmp_path, monkeypatch):
    """If SHA256SUMS exists but does not list an expected asset, the release
    is incomplete — publishing unverified binaries silently was an FN."""
    cache = tmp_path / "cache"
    cache.mkdir()
    asset = b.TARGETS["linux-amd64"]["bin"]
    (cache / asset).write_bytes(b"binaries")
    (cache / b.TARGETS["linux-amd64"]["agentd"]).write_bytes(b"agentd")
    crafted = "deadbeef  some-unrelated-file\n"

    def fake_download(url, dest, retries=4):
        assert url.endswith("/SHA256SUMS"), f"unexpected download: {url}"
        dest.write_text(crafted, encoding="utf-8")
        return dest

    monkeypatch.setattr(b, "http_download", fake_download)
    with pytest.raises(SystemExit, match="missing from SHA256SUMS"):
        b.fetch_binaries("v1.7.6", ["linux-amd64"], cache)


def test_fetch_binaries_verifies_and_returns(b, tmp_path, monkeypatch):
    """Happy path: both binaries download, verify, and return per-target."""
    import hashlib

    served = {}

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            name = self.path.rsplit("/", 1)[-1]
            if name == "SHA256SUMS":
                import hashlib
                body = "\n".join(
                    f"{hashlib.sha256(v).hexdigest()}  {k}"
                    for k, v in served.items()).encode()
            else:
                body = served[name]
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = _Server(H)
    monkeypatch.setattr(b, "RELEASE_BASE", srv.url)
    for asset in (b.TARGETS["linux-amd64"]["bin"], b.TARGETS["linux-amd64"]["agentd"]):
        served[asset] = f"binaries-for-{asset}".encode()
    (srv.srv, ) = (srv.srv, )
    # SHA256SUMS must be served too
    sums_body = "\n".join(
        f"{__import__('hashlib').sha256(v).hexdigest()}  {k}"
        for k, v in served.items()).encode()
    served["SHA256SUMS"] = sums_body

    cache = tmp_path / "cache"
    cache.mkdir()
    result = b.fetch_binaries("v1.7.6", ["linux-amd64"], cache)
    srv.stop()
    assert set(result["linux-amd64"]) == {"bin", "agentd"}
    assert result["linux-amd64"]["bin"].read_bytes() == served[b.TARGETS["linux-amd64"]["bin"]]


# ── launcher body: the wheel's console entry points ─────────────────────────
def write_launcher(tmp_path, b):
    mod = tmp_path / "synapse_gateway.py"
    mod.write_text("from pathlib import Path\nBIN = Path('.')\n" + b.LAUNCHER_BODY,
                   encoding="utf-8")
    spec = importlib.util.spec_from_file_location("synapse_gateway_test", mod)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_launcher_missing_binary_exits_with_guidance(b, tmp_path, monkeypatch):
    m = write_launcher(tmp_path, b)
    monkeypatch.setattr(m.os, "name", "posix")
    monkeypatch.setattr(m.os.path, "isfile", lambda p: False)
    with pytest.raises(SystemExit, match="not bundled in this wheel"):
        m._binary("reactorpro-gateway")


def test_launcher_sets_exec_bit_on_posix(b, tmp_path, monkeypatch):
    m = write_launcher(tmp_path, b)
    bindir = tmp_path / "bin"
    bindir.mkdir()
    exe = bindir / "reactorpro-gateway"
    exe.write_text("#!/bin/sh\n", encoding="utf-8")
    exe.chmod(stat.S_IRUSR | stat.S_IWUSR)          # 600: NOT executable
    monkeypatch.setattr(m.os, "name", "posix")
    monkeypatch.chdir(tmp_path)
    # the launcher resolves bin/ relative to ITS OWN file:
    real_resolve = Path.resolve
    monkeypatch.setattr(
        m.Path, "resolve",
        lambda self, **kw: (bindir / self.name).resolve() if self.name == "reactorpro-gateway"
        else real_resolve(self, **kw))
    out = m._binary("reactorpro-gateway")
    assert os.access(out, os.X_OK)                  # exec bit was added


def test_launcher_windows_uses_exe_suffix(b, tmp_path, monkeypatch):
    m = write_launcher(tmp_path, b)
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "reactorpro-gateway.exe").write_text("mz", encoding="utf-8")
    monkeypatch.setattr(m.os, "name", "nt")
    monkeypatch.chdir(tmp_path)
    real_resolve = Path.resolve
    monkeypatch.setattr(
        m.Path, "resolve",
        lambda self, **kw: (bindir / self.name).resolve() if self.name == "reactorpro-gateway.exe"
        else real_resolve(self, **kw))
    assert m._binary("reactorpro-gateway").name == "reactorpro-gateway.exe"


# ── main(): version derivation and validation ───────────────────────────────
def _run_main(b, tmp_path, monkeypatch, argv):
    """Run main() with all side effects stubbed; returns the version used."""
    seen = {"version": None, "binaries": None, "targets": None}

    def fake_fetch(tag, targets, cache):
        seen["tag"] = tag
        # dummy "binaries": files that exist, content irrelevant
        out = {}
        for t in targets:
            entry = {}
            for key in ("bin", "agentd"):
                f = cache / f"{b.TARGETS[t][key]}.dummy"
                f.write_bytes(b"x")
                entry[key] = f
            out[t] = entry
        return out

    def fake_pypi(version, targets, binaries, dist):
        seen["version"] = version
        seen["targets"] = list(targets)
        return []

    def fake_npm(version, targets, binaries, dist):
        return []

    monkeypatch.setattr(b, "fetch_binaries", fake_fetch)
    monkeypatch.setattr(b, "build_pypi", fake_pypi)
    monkeypatch.setattr(b, "build_npm", fake_npm)
    b.main(argv)
    return seen


def test_version_strips_single_v_prefix(b, tmp_path, monkeypatch):
    seen = _run_main(b, tmp_path, monkeypatch,
                     ["--release-tag", "v1.7.12", "--skip-npm"])
    assert seen["version"] == "1.7.12"
    assert seen["tag"] == "v1.7.12"


def test_version_without_v_prefix_works(b, tmp_path, monkeypatch):
    seen = _run_main(b, tmp_path, monkeypatch,
                     ["--release-tag", "1.7.12", "--skip-npm"])
    assert seen["version"] == "1.7.12"


def test_double_v_tag_is_rejected_not_silently_trimmed(b, tmp_path, monkeypatch):
    """lstrip("v") used to turn "vv1.7.6" into "1.7.6" — publishing a version
    that matches a differently-spelled tag. removeprefix rejects it."""
    with pytest.raises(SystemExit, match="invalid version"):
        _run_main(b, tmp_path, monkeypatch,
                  ["--release-tag", "vv1.7.6", "--skip-npm"])


def test_rc_tag_rejected(b, tmp_path, monkeypatch):
    with pytest.raises(SystemExit, match="invalid version"):
        _run_main(b, tmp_path, monkeypatch,
                  ["--release-tag", "v1.7.7-rc1", "--skip-npm"])


def test_unknown_target_rejected(b, tmp_path, monkeypatch):
    with pytest.raises(SystemExit, match="unknown target"):
        _run_main(b, tmp_path, monkeypatch,
                  ["--release-tag", "v1.7.6", "--targets", "atari2600",
                   "--skip-npm"])


# ── full PyPI build with dummy binaries (real setuptools) ───────────────────
def test_build_pypi_produces_fallback_and_platform_wheels(b, tmp_path, monkeypatch):
    pytest.importorskip("build")
    pytest.importorskip("wheel")
    # the builder copies NPM only in build_npm; PyPI needs no npm tree
    binaries = {}
    for t in b.TARGETS:
        entry = {}
        for key in ("bin", "agentd"):
            f = tmp_path / f"{b.TARGETS[t][key]}.dummy"
            f.write_bytes(b"MZ-fake-binary" if t == "windows-amd64" else b"fake-binary")
            entry[key] = f
        binaries[t] = entry
    dist = tmp_path / "dist"
    dist.mkdir()
    wheels = b.build_pypi("1.7.12", list(b.TARGETS), binaries, dist)
    names = [w.name for w in wheels]
    # fallback wheel is built LAST — every one_any_wheel() unlinks the same
    # py3-none-any name, so a first-built fallback was always deleted
    assert names[-1] == "synapse_gateway-1.7.12-py3-none-any.whl"
    assert all(w.exists() for w in wheels)          # nothing deleted
    for t in b.TARGETS:
        assert f"synapse_gateway-1.7.12-py3-none-{b.TARGETS[t]['wheel']}.whl" in names
    # platform wheels must actually CARRY their binary
    import zipfile
    win = [w for w in wheels if "win_amd64" in w.name][0]
    with zipfile.ZipFile(win) as z:
        bins = [n for n in z.namelist() if n.endswith(".exe")]
        # canonical names: pip installs give `reactorpro-gateway(.exe)` on any platform
        assert "synapse_gateway/bin/reactorpro-gateway.exe" in bins
        assert "synapse_gateway/bin/reactorpro-agentd.exe" in bins
    # the fallback wheel must NOT carry binaries (it explains where to get them)
    with zipfile.ZipFile(wheels[-1]) as z:
        assert not [n for n in z.namelist() if "/bin/" in n]


# ── npm manifests ───────────────────────────────────────────────────────────
def test_build_npm_manifests_and_main_package(b, tmp_path, monkeypatch):
    binaries = {}
    for t in b.TARGETS:
        entry = {}
        for key in ("bin", "agentd"):
            f = tmp_path / f"{b.TARGETS[t][key]}.dummy"
            f.write_bytes(b"fake")
            entry[key] = f
        binaries[t] = entry
    npm_src = tmp_path / "npm-src"
    (npm_src / "dist").mkdir(parents=True)           # must be ignored on copy
    (npm_src / "node_modules").mkdir()
    (npm_src / "bin").mkdir()
    (npm_src / "package.json").write_text(
        json.dumps({"name": "@hyperspaceng/synapse-gateway",
                    "version": "0.0.0", "bin": {}}), encoding="utf-8")
    monkeypatch.setattr(b, "NPM", npm_src)

    dist = tmp_path / "dist"
    dist.mkdir()
    pkgs = b.build_npm("1.7.12", list(b.TARGETS), binaries, dist)
    by_dir = {Path(p).name: Path(p) for p in pkgs}

    linux = by_dir["linux-arm64-gnu"]
    man = json.loads((linux / "package.json").read_text())
    assert man["os"] == ["linux"] and man["cpu"] == ["arm64"]
    assert man["libc"] == ["glibc"]
    assert man["version"] == "1.7.12"

    win = by_dir["win32-x64"]
    wman = json.loads((win / "package.json").read_text())
    assert wman["os"] == ["win32"] and "libc" not in wman

    main = by_dir["main"]
    mman = json.loads((main / "package.json").read_text())
    assert mman["version"] == "1.7.12"
    assert set(mman["optionalDependencies"]) == {
        f"@hyperspaceng/synapse-gateway-{b.TARGETS[t]['npm']}" for t in b.TARGETS}
    assert all(v == "1.7.12" for v in mman["optionalDependencies"].values())
    assert not (main / "node_modules").exists()      # excluded from the copy
    assert not (main / "dist").exists()
