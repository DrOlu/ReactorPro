'use strict';

/**
 * Resolve the platform engine package (@hyperspaceng/synapse-gateway-<key>)
 * installed via optionalDependencies, and return the requested binary path.
 */

const PLATFORM_PACKAGES = {
  'darwin-arm64': { pkg: '@hyperspaceng/synapse-gateway-darwin-arm64' },
  'darwin-x64': { pkg: '@hyperspaceng/synapse-gateway-darwin-x64' },
  'linux-x64-gnu': { pkg: '@hyperspaceng/synapse-gateway-linux-x64-gnu' },
  'linux-arm64-gnu': { pkg: '@hyperspaceng/synapse-gateway-linux-arm64-gnu' },
  'win32-x64': { pkg: '@hyperspaceng/synapse-gateway-win32-x64' },
};

function platformKey() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin') return a === 'arm64' ? 'darwin-arm64' : (a === 'x64' ? 'darwin-x64' : null);
  if (p === 'win32') return a === 'x64' ? 'win32-x64' : null;
  if (p === 'linux') {
    if (a !== 'x64' && a !== 'arm64') return null;
    try {
      const report = process.report && process.report.getReport && process.report.getReport();
      if (report && report.header && !report.header.glibcVersionRuntime) return null; // musl not bundled
    } catch (_) { /* assume glibc */ }
    return a === 'x64' ? 'linux-x64-gnu' : 'linux-arm64-gnu';
  }
  return null;
}

function binaryPath(name) {
  const key = platformKey();
  if (!key) {
    throw new Error(
      `synapse-gateway: no bundled binary for ${process.platform}/${process.arch}. ` +
      'Supported: darwin arm64/x64, linux x64/arm64 (glibc), win32 x64.');
  }
  const spec = PLATFORM_PACKAGES[key];
  let dir;
  try {
    dir = path.dirname(require.resolve(spec.pkg + '/package.json'));
  } catch (err) {
    throw new Error(
      `synapse-gateway: engine package ${spec.pkg} is not installed. ` +
      'Reinstall with optional dependencies allowed: npm i @hyperspaceng/synapse-gateway --include=optional');
  }
  const exe = name + (process.platform === 'win32' ? '.exe' : '');
  return path.join(dir, 'bin', exe);
}

const path = require('path');
const { spawnSync } = require('child_process');

function run(name) {
  let exe;
  try {
    exe = binaryPath(name);
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }
  const result = spawnSync(exe, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

module.exports = { platformKey, binaryPath, run };
