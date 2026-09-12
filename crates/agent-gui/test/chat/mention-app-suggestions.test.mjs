import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Coverage check for @-mentioning installed apps (computer use targets): the shared composer's
// appMention type must go through the full chip lifecycle (create chip / serialize / clipboard /
// draft restore), and the GUI-side gating must share the same source as cua-driver's security decision.

const chatComponentsRoot = new URL("../../../agent-ui/src/components/chat/", import.meta.url);
const agentUiRoot = new URL("../../../agent-ui/src/", import.meta.url);
const guiRoot = new URL("../../src/", import.meta.url);
const tauriRoot = new URL("../../src-tauri/src/", import.meta.url);

function source(root, relativePath) {
  // On Windows (autocrlf=true) checkouts, source lines end with CRLF; normalize to LF so that
  // LF-based slicing such as extractFunction's indexOf("\n}\n") is reproducible on any platform.
  return readFileSync(new URL(relativePath, root), "utf8").replace(/\r\n/g, "\n");
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = src.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `unterminated function ${name}`);
  return src.slice(start, end + 3);
}

const model = source(chatComponentsRoot, "MentionComposerModel.ts");
const internals = source(chatComponentsRoot, "MentionComposerInternals.tsx");
const composer = source(chatComponentsRoot, "MentionComposer.tsx");
const overlays = source(chatComponentsRoot, "MentionComposerOverlays.tsx");

test("the mention model declares the full appMention surface", () => {
  // The app arm must be present in all three places — suggestions, draft segments, and the draft collection list — missing one creates
  // a gap where "it can be selected into the editor but is lost on send" or "it can be sent but draft restore loses the chip".
  assert.match(model, /\{ type: "app"; app: MentionComposerApp \}/);
  assert.match(model, /\{ type: "appMention"; app: MentionComposerAppMention \}/);
  assert.match(model, /appMentions: MentionComposerAppMention\[\];/);
  assert.match(model, /APP_MENTION_NAME_ATTR = "data-app-name"/);
  assert.match(model, /APP_MENTION_BUNDLE_ID_ATTR = "data-app-bundle-id"/);
  assert.match(model, /APP_MENTION_PATH_ATTR = "data-app-path"/);
});

test("app chips round-trip through DOM serialization and the clipboard payload", () => {
  // DOM -> draft segments
  assert.match(internals, /el\.hasAttribute\(APP_MENTION_NAME_ATTR\)/);
  // draft segments -> send text
  assert.match(
    internals,
    /if \(segment\.type === "appMention"\) return formatAppMentionToken\(segment\.app\);/,
  );
  // private clipboard channel restore
  assert.match(internals, /if \(type === "appMention"\) \{/);
  // paste/setDraft rebuilds the chip
  assert.match(internals, /if \(segment\.type === "appMention"\) \{\s*return createAppMentionChip\(segment\.app\);/);
  // atomic cursor stepping/deletion treats the app chip as a single unit
  const chipGuard = extractFunction(internals, "isComposerChipElement");
  assert.match(chipGuard, /APP_MENTION_NAME_ATTR/);
});

test("the app token carries a stable identity the model can hand to CUA tools", () => {
  // Token serialization has only one implementation, in lib/chat/mentionReferences; the in-component serialization and
  // the send path (composerDraft) both import from here — no second copy is allowed.
  const references = source(agentUiRoot, "lib/chat/mentionReferences.ts");
  assert.doesNotMatch(internals, /function formatAppMentionToken/);
  assert.match(internals, /formatAppMentionToken,/);
  const composerDraftSrc = source(agentUiRoot, "lib/chat/composerDraft.ts");
  assert.doesNotMatch(composerDraftSrc, /function formatComposerAppMention/);
  const body = extractFunction(references, "formatAppMentionToken").replace(
    /\(app: AppMentionReference\)/,
    "(app)",
  );
  const formatAppMentionToken = new Function(`${body}; return formatAppMentionToken;`)();
  assert.equal(
    formatAppMentionToken({ name: "Safari", bundleId: "com.apple.Safari", path: "/Applications/Safari.app" }),
    'app "Safari" (com.apple.Safari)',
  );
  // Platforms without a bundle id fall back to the install path; with no identity at all, only the name is kept.
  assert.equal(
    formatAppMentionToken({ name: "Tool", bundleId: "", path: "/opt/tool" }),
    'app "Tool" (/opt/tool)',
  );
  assert.equal(formatAppMentionToken({ name: "Tool", bundleId: "", path: "" }), 'app "Tool"');
});

test("app suggestions ride the @ trigger and are host-gated by the mentionApps prop", () => {
  // App candidates come only from props — composer itself must never invoke Tauri (the component is
  // shared by both ends, and the WebUI intentionally does not wire up this capability).
  assert.match(composer, /mentionApps = \[\]/);
  assert.doesNotMatch(composer, /invoke\(["']cua_driver/);
  assert.match(composer, /next\.push\(\{ type: "app", app \}\)/);
  assert.match(composer, /insertAppMentionChip\(mentionCtx, suggestion\.app\)/);
});

test("the root popup folds available installed apps into a dedicated submenu", () => {
  // The root level shows only category entries; app candidates, like file and conversation candidates, are generated
  // only after entering a second-level menu. The app submenu keeps the uniform 30-item cap and is no longer trimmed to 3 items for root-level mixing.
  assert.match(model, /category: "apps" \| "files" \| "conversations"/);
  assert.match(model, /MentionMenuMode = "root" \| "apps" \| "files" \| "conversations"/);
  assert.match(composer, /\{ type: "category", category: "apps" \}/);
  assert.match(composer, /if \(mentionMenuMode === "apps"\)/);
  assert.match(
    composer,
    /sortAppsByMentionRecency\(availableMentionApps, readAppMentionRecents\(\)\)/,
  );
  assert.match(composer, /if \(next\.length >= MAX_SUGGESTIONS\) break/);
  assert.doesNotMatch(composer, /MAX_APP_SUGGESTIONS/);
  assert.match(overlays, /mode === "apps"/);
  assert.match(overlays, /category === "apps"/);
  // App rows preferentially render the real icon provided by the host (data URL), falling back to a placeholder icon when missing.
  assert.match(overlays, /app\?\.iconDataUrl \?/);
  assert.match(overlays, /img src=\{app\.iconDataUrl\}/);
  assert.match(overlays, /<AppWindow className/);
});

test("selecting an app records it and the next @ popup ranks recents first", () => {
  // Selection writes to the leaderboard (a versioned localStorage key); the next time the @ conversation opens, it re-reads
  // and moves the most recently used apps to the front of the group; apps not on the board keep the host's alphabetical order.
  assert.match(composer, /recordAppMentionUse\(suggestion\.app\)/);
  assert.match(
    composer,
    /sortAppsByMentionRecency\(availableMentionApps, readAppMentionRecents\(\)\)/,
  );
  const recency = source(agentUiRoot, "lib/chat/appMentionRecency.ts");
  assert.match(recency, /"liveagent\.app-mention-recents\.v1"/);
  // The identity key must reuse the same decision as the icon registry (bundle id > path > name);
  // a second priority list must not be maintained in recency.
  assert.match(recency, /identityKeys\(identity\)\[0\] \?\? ""/);

  // Executable override: identity key priority + recency ordering (listed entries first by leaderboard order, unlisted ones
  // keep the input order). Type annotations are stripped before evaluation.
  const icons = source(agentUiRoot, "lib/chat/appMentionIcons.ts");
  const identityKeysFn = extractFunction(icons, "identityKeys")
    .replace(/\(identity: AppMentionIconIdentity\): string\[\]/, "(identity)")
    .replace(/const keys: string\[\] = \[\];/, "const keys = [];");
  const keyFn = extractFunction(recency, "appMentionRecencyKey").replace(
    /\(identity: AppMentionRecencyIdentity\): string/,
    "(identity)",
  );
  const sortStart = recency.indexOf("function sortAppsByMentionRecency");
  assert.notEqual(sortStart, -1, "missing function sortAppsByMentionRecency");
  const sortEnd = recency.indexOf("\n}\n", sortStart);
  const sortFn = recency
    .slice(sortStart, sortEnd + 3)
    .replace(
      /function sortAppsByMentionRecency[\s\S]*?\{/,
      "function sortAppsByMentionRecency(apps, recentKeys) {",
    )
    .replace(/\(app: T\)/, "(app)");
  const { appMentionRecencyKey, sortAppsByMentionRecency } = new Function(
    `${identityKeysFn}\n${keyFn}\n${sortFn}\nreturn { appMentionRecencyKey, sortAppsByMentionRecency };`,
  )();

  assert.equal(
    appMentionRecencyKey({
      name: "Safari",
      bundleId: "com.apple.Safari",
      path: "/Applications/Safari.app",
    }),
    "bundle:com.apple.safari",
  );
  assert.equal(appMentionRecencyKey({ name: "Tool", path: "/opt/tool" }), "path:/opt/tool");
  assert.equal(appMentionRecencyKey({ name: "Tool" }), "name:tool");
  assert.equal(appMentionRecencyKey({}), "");

  const apps = [
    { name: "Arc" },
    { name: "Mail" },
    { name: "Safari", bundleId: "com.apple.Safari" },
    { name: "Terminal" },
  ];
  const sorted = sortAppsByMentionRecency(apps, ["bundle:com.apple.safari", "name:mail"]);
  assert.deepEqual(
    sorted.map((app) => app.name),
    ["Safari", "Mail", "Arc", "Terminal"],
  );
  // Inputs are not modified in place.
  assert.deepEqual(
    apps.map((app) => app.name),
    ["Arc", "Mail", "Safari", "Terminal"],
  );
});

test("an app already mentioned is excluded and cannot be inserted again", () => {
  assert.match(composer, /const selectedAppMentionKeys = useMemo/);
  assert.match(composer, /const availableMentionApps = useMemo/);
  assert.match(composer, /availableMentionApps\.length > 0/);
  assert.match(composer, /collectAppMentionKeys\(editor\)\.includes\(key\)/);
  assert.match(composer, /sanitizeAppMentionSegments\(/);
  assert.match(composer, /enforceUniqueAppMentionsInEditor\(el\)/);
});

test("the chip shows the real app logo via the icon registry, never via DOM attributes", () => {
  // The icon is a multi-KB data URL: putting it into a chip property would carry it into the clipboard JSON and draft serialization.
  // So chip rendering looks up the image from the process-level registry by identity (name/bundleId/path),
  // keeping the serialized payload to just the identity triple; chip rebuild (setDraft/paste) restores it by re-querying.
  assert.match(internals, /getAppMentionIconDataUrl\(app\)/);
  assert.match(internals, /createAppMentionIcon\(app\)/);
  // The property surface is fixed to the identity triple — no new icon property may be added.
  const chipFactory = extractFunction(internals, "createAppMentionChip");
  const setAttrs = [...chipFactory.matchAll(/setAttribute\((APP_MENTION_[A-Z_]+)/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(setAttrs, [
    "APP_MENTION_NAME_ATTR",
    "APP_MENTION_BUNDLE_ID_ATTR",
    "APP_MENTION_PATH_ATTR",
  ]);
  // Registry registration happens when the host fetches the list (the GUI and WebUI share the same hook).
  const hook = source(agentUiRoot, "lib/chat/useMentionApps.ts");
  assert.match(hook, /registerAppMentionIcons\(mapped\)/);
});

test("user bubbles tokenize app mention tokens back into chips", () => {
  const bubble = source(agentUiRoot, "lib/chat/userMessageContent.tsx");
  assert.match(bubble, /\{ type: "app"; app: AppDisplayReference \}/);
  assert.match(bubble, /<AppMentionChip key=\{key\} app=\{part\.app\} \/>/);
  assert.match(bubble, /useAppMentionIcon\(app\)/);
  // When hasChip lacks the app arm, a pure app-mention message entirely takes the no-chip shortcut path.
  assert.match(bubble, /part\.type === "app" \|\|/);

  // Semantics of the token inverse transform: only the complete form is recognized, and identity is classified by the path separator.
  const stripTypes = (src) =>
    src
      .replace(/\(text: string, index: number\)/g, "(text, index)")
      .replace(/ satisfies AppDisplayReference/g, "");
  const helpers = [
    stripTypes(extractFunction(bubble, "isTokenBoundary")),
    stripTypes(extractFunction(bubble, "inlineAppReferenceAt")),
  ].join("\n");
  const inlineAppReferenceAt = new Function(`${helpers}; return inlineAppReferenceAt;`)();
  assert.deepEqual(inlineAppReferenceAt('app "Safari" (com.apple.Safari)', 0)?.app, {
    name: "Safari",
    bundleId: "com.apple.Safari",
    path: undefined,
  });
  assert.deepEqual(inlineAppReferenceAt('app "Tool" (/opt/tool)', 0)?.app, {
    name: "Tool",
    bundleId: undefined,
    path: "/opt/tool",
  });
  // A bare `app "Name"` is a common natural-language form and is not treated as a token.
  assert.equal(inlineAppReferenceAt('app "Safari" is great', 0), null);
  // Non-word boundaries do not trigger (avoiding splitting "myapp \"x\" (y)").
  assert.equal(inlineAppReferenceAt('myapp "Safari" (com.apple.Safari)', 2), null);

  // Plain-text paste (the clipboard's third layer) also restores into a chip via the same token.
  assert.match(internals, /segment\.type === "app"/);
  assert.match(internals, /type: "appMention",\s*app: normalizeAppMention\(/);
});

test("the send path serializes appMention segments in both draft pipelines", () => {
  // buildDraft (in-component) and buildTextFromComposerDraft (send path) each have their own
  // serialization, and both must have the app arm.
  assert.match(composer, /appMentions\.push\(segment\.app\)/);
  const composerDraft = source(agentUiRoot, "lib/chat/composerDraft.ts");
  assert.match(
    composerDraft,
    /if \(segment\.type === "appMention"\) return formatAppMentionToken\(segment\.app\);/,
  );
  assert.match(composerDraft, /appMentions: \[\],/);
  const paneSend = source(guiRoot, "pages/chat/surfaces/paneComposerSend.ts");
  assert.match(paneSend, /appMentions: \[\],/);
});

test("both hosts gate apps by the cua-driver identity ruling via the shared hook", () => {
  const hook = source(agentUiRoot, "lib/chat/useMentionApps.ts");
  // Gating must go through the same decision in contracts (by id or command); it must not
  // compare strings itself — otherwise it would misalign with the approval-default/self-targeting gate decisions.
  assert.match(hook, /isCuaDriverServer\(server\)/);
  assert.match(hook, /from "@liveagent\/ui\/contracts\/mcpServerDefaults"/);
  assert.match(hook, /cua_driver_list_installed_apps/);
  // invoke must be resolved through the @liveagent/app shim: GUI talks to the Tauri command directly, while the WebUI
  // uses the shim to relay the same-named command through the Gateway to the desktop host. The hook itself must not
  // import @tauri-apps — that would weld the shared package to the desktop.
  assert.match(hook, /from "@liveagent\/app\/shims\/tauriCore"/);
  assert.doesNotMatch(hook, /@tauri-apps/);
  const chatPage = source(guiRoot, "pages/ChatPage.tsx");
  assert.match(chatPage, /useMentionApps\(activeWorkspaceResources\.mcpServers, isAgentMode\)/);
  // WebUI wiring: gating inputs come from the same source (agent mode + workspace mcpServers), and the list
  // is passed into composer; it lists apps from the connected desktop host (cua tools operate the desktop).
  const gatewayApp = readFileSync(
    new URL("../../../agent-gateway/web/src/app/GatewayApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(gatewayApp, /useMentionApps\(workspaceResources\.mcpServers, isAgentMode\)/);
  const gatewayView = readFileSync(
    new URL("../../../agent-gateway/web/src/app/GatewayAppView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(gatewayView, /mentionApps=\{mentionApps\}/);
});

test("the gateway relays installed apps as a vetted pass-through frame", () => {
  // Pass-through chain: proto arm (numbering only grows, never changes) -> Go allowlist -> desktop dispatch and bridge
  // -> WebUI shim reusing the GUI's same-named invoke command. A missing link makes the WebUI's app group
  // silently disappear, so every link is covered.
  const proto = readFileSync(
    new URL("../../../agent-gateway/proto/v2/gateway.proto", import.meta.url),
    "utf8",
  );
  assert.match(proto, /InstalledAppsListRequest installed_apps_list = 100;/);
  assert.match(proto, /InstalledAppsListResponse installed_apps_list_resp = 105;/);
  const guard = readFileSync(
    new URL("../../../agent-gateway/internal/protocol/pbws/guard.go", import.meta.url),
    "utf8",
  );
  assert.match(guard, /GatewayEnvelope_InstalledAppsList/);
  const envelope = source(tauriRoot, "services/gateway/envelope_handler.rs");
  assert.match(envelope, /Payload::InstalledAppsList/);
  assert.match(envelope, /InstalledAppsListResp/);
  const bridge = source(tauriRoot, "services/gateway_bridge.rs");
  assert.match(bridge, /handle_installed_apps_list/);
  const shim = readFileSync(
    new URL("../../../agent-gateway/web/src/shims/tauriCore.ts", import.meta.url),
    "utf8",
  );
  assert.match(shim, /case "cua_driver_list_installed_apps":/);
  assert.match(shim, /listInstalledApps\(\)/);
});

test("the Rust command excludes the host on every platform and is registered", () => {
  const service = source(tauriRoot, "services/cua_driver/installed_apps.rs");
  // macOS excludes by host bundle id; Windows has no bundle id, so exclude by the current process's
  // exe path — both paths must exist; missing one puts the host itself in its own candidates.
  assert.match(service, /eq_ignore_ascii_case\(exclude_bundle_id\)/);
  assert.match(service, /std::env::current_exe\(\)/);
  assert.match(service, /list_windows_apps/);
  // On Windows identity is carried by path: bundle_id is left empty and mapped to undefined by the frontend.
  assert.match(service, /bundle_id: String::new\(\)/);
  const command = source(tauriRoot, "commands/integration/cua_driver.rs");
  assert.match(command, /app\.config\(\)\.identifier\.clone\(\)/);
  const lib = source(tauriRoot, "lib.rs");
  assert.match(lib, /commands::cua_driver::cua_driver_list_installed_apps,/);
});
