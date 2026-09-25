#!/usr/bin/env node
// reactorpro CLI — installs the ReactorPro gateway / agentd binaries
// from the official GitHub releases for the current platform.

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { homedir, platform, arch } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const VERSION = "1.7.3";
const OWNER = "DrOlu";
const REPO = "ReactorPro";
const INSTALL_DIR = path.join(homedir(), ".reactorpro", "bin");

const TARGETS = {
  "darwin-arm64": { ext: "" },
  "darwin-x64": { ext: "", alias: "darwin-amd64" },
  "linux-x64": { ext: "", alias: "linux-amd64" },
  "linux-arm64": { ext: "" },
  "win32-x64": { ext: ".exe", alias: "windows-amd64" },
};

const COMPONENTS = ["gateway", "agentd"];

function usage() {
  console.log(`reactorpro v${VERSION} — ReactorPro CLI

Usage:
  reactorpro install <component>   Download + install a component (${COMPONENTS.join(", ")})
  reactorpro install all           Install every component
  reactorpro --version             Print the CLI version
  reactorpro help                  Show this help

Components are downloaded from the official GitHub releases and installed
into ~/.reactorpro/bin.`);
}

function resolveTarget() {
  const key = `${platform()}-${arch()}`;
  const target = TARGETS[key];
  if (!target) return null;
  return { assetArch: target.alias ?? key.replace("-", "-"), ext: target.ext, key };
}

function assetName(component, target) {
  return `reactorpro-${component}-${target.assetArch}${target.ext}`;
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (HTTP ${response.status}) for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
  if (platform() !== "win32") await chmod(destPath, 0o755);
}

async function install(component) {
  const target = resolveTarget();
  if (!target) {
    console.error(`Unsupported platform: ${platform()}-${arch()}`);
    process.exitCode = 1;
    return;
  }
  const name = assetName(component, target);
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/${name}`;
  const destPath = path.join(INSTALL_DIR, `reactorpro-${component}${target.ext}`);
  await mkdir(INSTALL_DIR, { recursive: true });
  process.stdout.write(`Installing ${component} v${VERSION} (${target.key}) → ${destPath}\n`);
  try {
    await downloadTo(url, destPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Done. Binary at ${destPath}\n`);
  if (platform() === "win32") {
    const shimPath = path.join(INSTALL_DIR, `reactorpro-${component}.cmd`);
    await writeFile(shimPath, `@"${destPath}" %*\r\n`, "utf8");
    process.stdout.write(`Shim at ${shimPath}\n`);
  }
  process.stdout.write(`Add it to PATH:\n  export PATH="${INSTALL_DIR}:$PATH"\n`);
}

const [command, arg] = process.argv.slice(2);

if (command === "--version" || command === "-v" || command === "version") {
  console.log(VERSION);
} else if (command === "install") {
  if (arg === "all") {
    for (const component of COMPONENTS) await install(component);
  } else if (COMPONENTS.includes(arg)) {
    await install(arg);
  } else {
    usage();
    process.exitCode = 1;
  }
} else {
  usage();
  if (command !== "help" && command !== undefined) process.exitCode = 1;
}
