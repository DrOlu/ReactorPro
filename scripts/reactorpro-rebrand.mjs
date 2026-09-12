#!/usr/bin/env node
/**
 * ReactorPro branding enforcement.
 *
 * This script is the single source of truth for the ReactorPro rebrand. It is
 * idempotent: running it repeatedly converges on the same result. The upstream
 * sync workflow runs it after every merge so that upstream changes can never
 * revert the product name, the app icons, the author metadata, or the language
 * policy (English only).
 *
 * Brand-owned files live under `branding/` and are copied verbatim into place.
 * Source strings are rewritten in place with conservative, targeted rules that
 * only ever touch the human-visible product name.
 *
 * Usage:
 *   node scripts/reactorpro-rebrand.mjs            # apply branding
 *   node scripts/reactorpro-rebrand.mjs --check    # verify only, no writes
 *
 * Exit codes:
 *   0  branding is correct (and, with --check, no Chinese text was found)
 *   1  branding was repaired / Chinese text was found
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const checkOnly = process.argv.includes("--check");

const BRAND = {
  name: "ReactorPro",
  legalName: "Hyperspace Technologies",
  email: "agent@reactorpro.ng",
  homepage: "https://reactorpro.ng",
  bundleIdentifier: "ng.reactorpro.app",
  upstreamSlug: "Stack-Cairn/LiveAgent",
};

/** Directories that are never scanned or rewritten. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "branding",
  ".protogen-tmp",
  "test-results",
  "coverage",
]);

/** Generated protocol bindings are owned by `make proto`, not by this script. */
const GENERATED_PROTO = [
  "crates/agent-gateway/internal/proto/v2/",
  "crates/agent-gateway/web/src/lib/proto/gen/",
];

/** Extensions that participate in the visible-name rewrite. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".rs",
  ".go",
  ".json",
  ".html",
  ".css",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".toml",
  ".proto",
  ".txt",
  ".svg",
  ".plist",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".ps1",
  ".bat",
  ".cmd",
  ".conf",
  ".env",
  ".properties",
]);

/**
 * Files this script must never rewrite, or it would clobber the rules it is
 * currently applying (its own pattern and documentation reference the upstream
 * product name on purpose).
 */
const SELF_EXCLUDE = new Set(["scripts/reactorpro-rebrand.mjs"]);

/** Files with no extension that still carry the visible product name. */
const EXTENSIONLESS_FILES = new Set(["Makefile", "Dockerfile", "Containerfile"]);

const changed = [];

function record(message) {
  changed.push(message);
}

function report(message) {
  console.log(`${checkOnly ? "[check]" : "[brand]"} ${message}`);
}

/* ------------------------------------------------------------------ *
 * 1. Brand-owned files are authoritative.
 * ------------------------------------------------------------------ */

const BRAND_COPIES = [
  ["branding/icons", "crates/agent-gui/src-tauri/icons"],
  ["branding/public/agent-gui-favicon.svg", "crates/agent-gui/public/favicon.svg"],
  ["branding/public/gateway-favicon.svg", "crates/agent-gateway/web/public/favicon.svg"],
  ["branding/public/gateway-icon-simple.png", "crates/agent-gateway/web/public/icon-simple.png"],
  ["branding/docs-images/banner.webp", "docs/images/banner.webp"],
  ["branding/README.md", "README.md"],
];

function restoreBrandFiles() {
  for (const [from, to] of BRAND_COPIES) {
    const source = join(repoRoot, from);
    const target = join(repoRoot, to);
    if (!existsSync(source)) {
      report(`missing brand asset: ${from}`);
      continue;
    }
    const stale = !existsSync(target) || !sameBytes(source, target);
    if (stale) {
      if (!checkOnly) {
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target, { recursive: true });
      }
      record(`${to} (restored from ${from})`);
    }
  }
}

function sameBytes(a, b) {
  try {
    const left = statSync(a);
    if (left.isDirectory()) return true; // directory copies are handled file-by-file below
    const right = statSync(b);
    if (left.size !== right.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 2. Product identity in manifests.
 * ------------------------------------------------------------------ */

function editJson(relPath, mutate) {
  const path = join(repoRoot, relPath);
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    report(`skipping unparsable JSON: ${relPath}`);
    return;
  }
  const before = JSON.stringify(parsed);
  mutate(parsed);
  const after = JSON.stringify(parsed);
  if (before !== after) {
    if (!checkOnly) writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    record(relPath);
  }
}

function editText(relPath, mutate) {
  const path = join(repoRoot, relPath);
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = mutate(before);
  if (after !== before) {
    if (!checkOnly) writeFileSync(path, after);
    record(relPath);
  }
}

function applyIdentity() {
  editJson("crates/agent-gui/src-tauri/tauri.conf.json", (conf) => {
    conf.productName = BRAND.name;
    conf.identifier = BRAND.bundleIdentifier;
  });
  for (const rel of [
    "crates/agent-gui/src-tauri/tauri.windows.conf.json",
    "crates/agent-gui/src-tauri/tauri.windows.release.conf.json",
  ]) {
    editJson(rel, (conf) => {
      for (const window of conf.app?.windows ?? []) window.title = BRAND.name;
    });
  }

  editText("crates/agent-gui/src-tauri/Cargo.toml", (text) =>
    text
      .replace(/^description = ".*"$/m, `description = "${BRAND.name} desktop application"`)
      .replace(/^authors = \[.*\]$/m, `authors = ["${BRAND.legalName} <${BRAND.email}>"]`),
  );

  const authorBlock = {
    description: `${BRAND.name} - AI Agent desktop client with WebUI access, built and maintained by ${BRAND.legalName}.`,
    author: `${BRAND.legalName} <${BRAND.email}>`,
    license: "MIT",
    homepage: BRAND.homepage,
    repository: { type: "git", url: "git+https://github.com/DrOlu/ReactorPro.git" },
  };
  editJson("package.json", (pkg) => Object.assign(pkg, authorBlock));
  editJson("crates/agent-gui/package.json", (pkg) => {
    pkg.description = `${BRAND.name} desktop application by ${BRAND.legalName}.`;
    pkg.author = `${BRAND.legalName} <${BRAND.email}>`;
    pkg.license = "MIT";
  });
}

function applyReadmeCredits() {
  editText("LICENSE", (text) => {
    if (text.includes(BRAND.legalName)) return text;
    return text.replace(/^(Copyright \(c\) \d{4} .*)$/m, `$1\nCopyright (c) 2026 ${BRAND.legalName}`);
  });
}

/* ------------------------------------------------------------------ *
 * 3. Visible product name in source.
 * ------------------------------------------------------------------ */

/**
 * Rewrite the human-visible product name only.
 *
 * Deliberately NOT rewritten:
 *   - `liveagent` / `LIVEAGENT` / `@liveagent/*`  internal identifiers, package
 *     scope, data directory, environment variables and crate names
 *   - `LiveAgentSkillFileRules`                   internal prompt guard tag
 *   - `Stack-Cairn/LiveAgent`                     upstream repository references
 */
function rebrandVisibleName(text) {
  const singleWord = text.replace(
    /LiveAgent(?!SshClient|SkillFileRules|-?Proxy-Token)/g,
    (match, offset, whole) => {
      // `Stack-Cairn/LiveAgent` points at the upstream project and must keep its
      // real name; every other occurrence is our own product name.
      if (whole.slice(Math.max(0, offset - 12), offset).endsWith("Stack-Cairn/")) return match;
      return BRAND.name;
    },
  );
  // The sidebar brand renders the product name as two words ("Live Agent"),
  // which the single-word rule above never saw. Only the capitalised brand form
  // is rewritten: lower-case "live agent" prose means a running agent.
  return singleWord.replace(/\bLive Agent\b/g, BRAND.name);
}

/**
 * Files whose `Stack-Cairn/LiveAgent` references are *defaults and links that
 * belong to this product* — the auto-update source, OAuth client URI, security
 * advisories, issue templates and deployment docs. These must point at the
 * ReactorPro repository, otherwise a build would fetch upstream releases.
 *
 * Upstream *citations* (issue links in worklogs, the sync workflow itself) are
 * deliberately not in this list.
 */
const REPO_REF_FILES = new Set([
  "crates/agent-gui/src-tauri/src/commands/app/update.rs",
  "crates/agent-gui/src-tauri/src/services/mcp_oauth/register.rs",
  "crates/agent-gui/test/settings/app-updates.test.mjs",
  "crates/agent-gui/test/backend/release-manifest.test.mjs",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/CONTRIBUTING.md",
  "docs/operations/deployment.md",
  "scripts/release/create-ai-release-notes.mjs",
  ".github/workflows/update-star-history.yml",
]);

function applyRepositoryReferences() {
  for (const rel of REPO_REF_FILES) {
    editText(rel, (text) => text.replaceAll(BRAND.upstreamSlug, "DrOlu/ReactorPro"));
  }
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function isGeneratedProto(relPath) {
  return GENERATED_PROTO.some((prefix) => relPath.startsWith(prefix));
}

function applyVisibleName() {
  const roots = ["crates", "scripts", "docs", ".github", "Makefile", "Dockerfile", "mise.toml", "railway.json"];
  for (const root of roots) {
    const full = join(repoRoot, root);
    if (!existsSync(full)) continue;
    const targets = statSync(full).isDirectory() ? walk(full) : [full];
    for (const file of targets) {
      const rel = relative(repoRoot, file);
      if (isGeneratedProto(rel)) continue;
      if (SELF_EXCLUDE.has(rel)) continue;
      const base = file.slice(file.lastIndexOf("/") + 1);
      const dot = base.lastIndexOf(".");
      const ext = dot > 0 ? base.slice(dot) : "";
      if (!TEXT_EXTENSIONS.has(ext) && !EXTENSIONLESS_FILES.has(base)) continue;
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const next = rebrandVisibleName(text);
      if (next !== text) {
        if (!checkOnly) writeFileSync(file, next);
        record(rel);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 4. Language policy: English only.
 * ------------------------------------------------------------------ */

/**
 * The zh-CN locale is retained so the two-locale infrastructure and every
 * translation key stay intact, but it must render English like en-US. The
 * active default is en-US.
 */
function applyLanguagePolicy() {
  editText("crates/agent-ui/src/i18n/hostTranslations.ts", (text) =>
    text.replace(
      /export const DEFAULT_LOCALE: Locale = "zh-CN";/,
      'export const DEFAULT_LOCALE: Locale = "en-US";',
    ),
  );

  // Document language attributes must not advertise Chinese.
  for (const rel of ["crates/agent-gateway/web/index.html", "crates/agent-gui/index.html"]) {
    editText(rel, (text) => text.replace(/lang="zh(?:-CN)?"/g, 'lang="en"'));
  }
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/;

function scanForChinese() {
  const offenders = [];
  for (const root of ["crates", "docs", "scripts", ".github", "Makefile", "mise.toml"]) {
    const full = join(repoRoot, root);
    if (!existsSync(full)) continue;
    const targets = statSync(full).isDirectory() ? walk(full) : [full];
    for (const file of targets) {
      const rel = relative(repoRoot, file);
      if (isGeneratedProto(rel)) continue;
      // This script necessarily contains the CJK ranges it searches for.
      if (SELF_EXCLUDE.has(rel)) continue;
      let buffer;
      try {
        buffer = readFileSync(file);
      } catch {
        continue;
      }
      // Binary assets (screenshots, archives, fonts) decode to garbage that can
      // coincidentally match CJK ranges. Only text files are scannable.
      if (buffer.subarray(0, 8192).includes(0)) continue;
      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      const hits = lines.reduce((count, line) => count + (CJK.test(line) ? 1 : 0), 0);
      if (hits > 0) offenders.push(`${rel} (${hits} line${hits === 1 ? "" : "s"})`);
    }
  }
  return offenders;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

restoreBrandFiles();
applyIdentity();
applyReadmeCredits();
applyVisibleName();
applyRepositoryReferences();
applyLanguagePolicy();

const chinese = scanForChinese();

if (changed.length > 0) {
  console.log(`\nRebranded ${changed.length} path(s):`);
  for (const item of changed) console.log(`  - ${item}`);
} else {
  console.log("\nBranding already correct.");
}

if (chinese.length > 0) {
  console.error(`\nChinese text found in ${chinese.length} file(s). The project is English-only:`);
  for (const item of chinese) console.error(`  - ${item}`);
  console.error("\nTranslate these to English, then re-run this script.");
  process.exit(1);
}

console.log("\nLanguage policy OK: no Chinese text found.");
process.exit(changed.length > 0 && checkOnly ? 1 : 0);
