#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  findRetiredSharedDeclarations,
  rendersImportedComponent,
} from "./ui-boundary-declarations.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const toPosixPath = (path) => path.split(sep).join("/");

function listSourceFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = join(directory, entry);
    if (statSync(absolutePath).isDirectory()) {
      files.push(...listSourceFiles(root, absolutePath));
    } else if (/\.(?:ts|tsx)$/.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function listUiFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = join(directory, entry);
    if (statSync(absolutePath).isDirectory()) {
      files.push(...listUiFiles(root, absolutePath));
    } else if (/\.(?:css|ts|tsx)$/.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

const checks = [
  {
    root: join(repoRoot, "crates/agent-ui/src"),
    forbidden: [
      {
        pattern: /(?:from\s+|import\s*\(\s*|import\s+)["']@tauri-apps\//,
        reason: "The shared layer must access app capabilities through @liveagent/adapters",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*)["'][^"']*crates\/agent-(?:gui|gateway)/,
        reason: "The shared layer must not depend on specific app paths in reverse",
      },
    ],
  },
  {
    root: join(repoRoot, "crates/agent-gateway/web/src"),
    forbidden: [
      {
        pattern: /(?:from\s+|import\s*\(\s*|import\s+)["']@tauri-apps\//,
        reason: "WebUI must not import the Tauri API directly",
      },
      {
        pattern: /(?:from\s+|import\s*\(\s*)["'][^"']*crates\/agent-gui/,
        reason: "WebUI must not depend on desktop app source",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["'](?:@\/|\.{1,2}\/)[^"']*ChatComposerBar["']/,
        reason: "The chat composer bar must use @liveagent/ui/pages/chat/ChatComposerBar",
      },
      {
        pattern: /chat-(?:user-bubble|assistant)-action/,
        reason:
          "The message actions bar must use @liveagent/ui/components/chat/TranscriptMessageActions",
      },
      {
        pattern:
          /(?:function|const)\s+(?:ContextCheckpointCard|RetryDetailsBlock)\b|checkpoint-card|retry-details-toggle/,
        reason: "Context checkpoints and retry details must use the @liveagent/ui shared components",
      },
      {
        pattern:
          /(?:function\s+normalizeLiveToolStatus|const\s+VIBING_STATUS\s*=|function\s+buildContextUsageScanItems)\b/,
        reason: "Chat live status and context usage projection must use the @liveagent/ui shared logic",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']@liveagent\/ui\/(?:components\/chat\/ChatHeader|pages\/(?:skills-hub\/SkillsHubPage|mcp-hub\/McpHubPage))["']/,
        reason: "Common pages and the chat top bar must be assembled uniformly by the shared ApplicationView",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']@\/pages\/chat\/(?:AssistantBubble|useChatSkills|queue\/chatTurnQueue|assistant-bubble\/[^"']+)["']/,
        reason: "Chat rendering, Skill, and queue common logic must use the agent-ui shared implementation",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']\.\/(?:FileDropOverlay|WorkspaceOverlayHost)["']/,
        reason: "The chat Overlay must use the agent-ui shared implementation",
      },
    ],
  },
  {
    root: join(repoRoot, "crates/agent-gui/src"),
    forbidden: [
      {
        pattern:
          /(?:from\s+|import\s*\(\s*)["'][^"']*crates\/agent-gateway\/web/,
        reason: "The GUI must not depend on WebUI app source",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']\.{1,2}\/[^"']*ChatComposerBar["']/,
        reason: "The chat composer bar must use @liveagent/ui/pages/chat/ChatComposerBar",
      },
      {
        pattern: /chat-(?:user-bubble|assistant)-action/,
        reason:
          "The message actions bar must use @liveagent/ui/components/chat/TranscriptMessageActions",
      },
      {
        pattern:
          /(?:function|const)\s+(?:ContextCheckpointCard|RetryDetailsBlock)\b|checkpoint-card|retry-details-toggle/,
        reason: "Context checkpoints and retry details must use the @liveagent/ui shared components",
      },
      {
        pattern:
          /(?:function\s+normalizeLiveToolStatus|const\s+VIBING_STATUS\s*=|function\s+buildContextUsageScanItems)\b/,
        reason: "Chat live status and context usage projection must use the @liveagent/ui shared logic",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']@liveagent\/ui\/(?:components\/chat\/ChatHeader|pages\/(?:skills-hub\/SkillsHubPage|mcp-hub\/McpHubPage))["']/,
        reason: "Common pages and the chat top bar must be assembled uniformly by the shared ApplicationView",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']\.{1,2}\/(?:components\/(?:ChatFileDropOverlay|WorkspaceOverlayHost|assistant-bubble\/[^"']+)|hooks\/useChatSkills)["']/,
        reason: "Chat rendering, Overlay, and Skill common logic must use the agent-ui shared implementation",
      },
    ],
  },
];

let failures = 0;
for (const check of checks) {
  for (const file of listSourceFiles(check.root)) {
    const source = readFileSync(file, "utf8");
    for (const rule of check.forbidden) {
      if (!rule.pattern.test(source)) continue;
      failures += 1;
      console.error(`${relative(repoRoot, file)}: ${rule.reason}`);
    }
  }
}

const retiredDialogPatterns = [
  {
    pattern:
      /\b(?:settings-modal-(?:overlay|panel|header|subheader|body|footer|actions|step-row)|(?:external-link|history-share)-modal-(?:overlay|panel)|modal-dialog-(?:backdrop|popup|viewport)|ssh-forward-dialog-(?:backdrop|popup))\b/,
    reason: "Dialog visibility, animation, and layering must be managed by the shared Dialog/Sheet primitives",
  },
  {
    pattern: /\buseModalMotion\b/,
    reason:
      "Dialog exit must use Base UI onOpenChangeComplete; do not reintroduce hand-written timers",
  },
  {
    pattern: /\brole=["']dialog["']/,
    reason: "Business components must not hand-write dialog semantics; use the shared Dialog/AlertDialog",
  },
  {
    pattern:
      /\b(?:overlayClassName|viewportClassName|backdropClassName|portalProps)\b/,
    reason:
      "Business components must not override overlay infrastructure; layout should stay within the Content/Sheet semantic API",
  },
  {
    pattern: /\bz-\[\d+\]/,
    reason: "Layering must use semantic tokens such as layer-popover/layer-modal/layer-toast",
  },
  {
    pattern: /\brounded-\[(?:\d|\.\d)[^\]]*\]/,
    reason: "Border radius must use the standard rounded-* tokens derived from --radius",
  },
];
for (const root of [
  join(repoRoot, "crates/agent-ui/src"),
  join(repoRoot, "crates/agent-gui/src"),
  join(repoRoot, "crates/agent-gateway/web/src"),
]) {
  for (const file of listUiFiles(root)) {
    const source = readFileSync(file, "utf8");
    const filePath = toPosixPath(relative(repoRoot, file));
    if (
      /from\s+["']@base-ui\/react(?:\/[^"']+)?["']/.test(source) &&
      !filePath.startsWith("crates/agent-ui/src/components/ui/")
    ) {
      failures += 1;
      console.error(
        `${filePath}: Base UI may only be imported directly by agent-ui shared UI primitives`,
      );
    }
    for (const rule of retiredDialogPatterns) {
      if (!rule.pattern.test(source)) continue;
      failures += 1;
      console.error(`${filePath}: ${rule.reason}`);
    }
  }
}

const sharedRoot = join(repoRoot, "crates/agent-ui/src");
const sharedFacades = new Map([
  [
    "crates/agent-gui/src/lib/settings/index.ts",
    `export * from "@liveagent/ui/lib/settings";

export {
  applyMcpOps,
  applyMcpOpsToAppSettings,
  type McpSettingsOp,
  selectEnabledMcpServers,
} from "./mcpOps";
`,
  ],
  [
    "crates/agent-gateway/web/src/lib/settings/index.ts",
    `export * from "@liveagent/ui/lib/settings";
`,
  ],
  [
    "crates/agent-gateway/web/src/lib/chat/uiMessages.ts",
    `export * from "@liveagent/ui/lib/chat/uiMessages";
`,
  ],
]);
for (const [facadePath, expectedSource] of sharedFacades) {
  const absolutePath = join(repoRoot, facadePath);
  if (!existsSync(absolutePath)) continue;
  if (readFileSync(absolutePath, "utf8") === expectedSource) continue;
  failures += 1;
  console.error(`${facadePath}: The shared compatibility entry may only re-export the agent-ui source of truth`);
}

const appRoots = [
  join(repoRoot, "crates/agent-gui/src"),
  join(repoRoot, "crates/agent-gateway/web/src"),
];
const retiredSharedDeclarations = [
  "buildGatewayMessageRefPayload",
  "buildHistoryMessageRefPayload",
  "normalizeSftpEntry",
  "normalizeSftpTransfer",
  "normalizeSftpListResponse",
  "normalizeSftpStatResponse",
  "normalizeSftpActionResponse",
  "normalizeSftpTransferResponse",
  "normalizeSftpTransferEvent",
  "normalizeTerminalSession",
  "normalizeTerminalSshMetadata",
  "normalizeTerminalSshPrompt",
  "normalizeTerminalSshLatency",
  "normalizeTerminalShellOptions",
  "normalizeSshTerminalTab",
  "normalizeSshTerminalTabsSnapshot",
  "normalizeTerminalSnapshot",
  "normalizeTerminalSshCreateResult",
  "normalizeTerminalEvent",
  "normalizeUnknownTerminalSession",
  "normalizeTerminalByteContainer",
  "buildTerminalCreatePayload",
  "buildTerminalSshCreatePayload",
  "buildTerminalSshPromptAnswerPayload",
];
const retiredSharedDeclarationNames = new Set(retiredSharedDeclarations);
for (const appRoot of appRoots) {
  for (const file of listSourceFiles(appRoot)) {
    const source = readFileSync(file, "utf8");
    for (const declaration of findRetiredSharedDeclarations(
      source,
      file,
      retiredSharedDeclarationNames,
    )) {
      failures += 1;
      console.error(
        `${relative(repoRoot, file)}:${declaration.line}:${declaration.column}: ${declaration.name} has migrated to agent-ui; hosts may only import the shared implementation`,
      );
    }
  }
}
for (const sharedFile of listSourceFiles(sharedRoot)) {
  const sharedRelativePath = relative(sharedRoot, sharedFile);
  for (const appRoot of appRoots) {
    const appFile = join(appRoot, sharedRelativePath);
    if (!existsSync(appFile)) continue;
    if (sharedFacades.has(toPosixPath(relative(repoRoot, appFile)))) continue;
    failures += 1;
    console.error(
      `${toPosixPath(relative(repoRoot, appFile))}: Shared source must not keep a same-path copy in the app directory`,
    );
  }
}

const retiredSharedCopies = [
  "crates/agent-gui/src/components/icons.tsx",
  "crates/agent-gui/src/agent-ui-adapters/chatModelOptions.ts",
  "crates/agent-gui/src/agent-ui-adapters/mentionReferences.ts",
  "crates/agent-gui/src/lib/chat/changedFilesAdapter.ts",
  "crates/agent-gui/src/lib/chat/assistantBubbleAdapter.ts",
  "crates/agent-gui/src/lib/chat/chatPageHelpersAdapter.ts",
  "crates/agent-gui/src/lib/chat/messages/changedFiles.ts",
  "crates/agent-gui/src/lib/chat/messages/fileChangeStats.ts",
  "crates/agent-gui/src/lib/chat/messages/hostedSearch.ts",
  "crates/agent-gui/src/lib/chat/messages/mentionReferences.ts",
  "crates/agent-gui/src/lib/chat/messages/toolPreview.ts",
  "crates/agent-gui/src/lib/chat/messages/uploadedFiles.ts",
  "crates/agent-gui/src/lib/chat/messages/userMessageContent.tsx",
  "crates/agent-gui/src/lib/chat/toolPreviewAdapter.ts",
  "crates/agent-gui/src/lib/system/fontFamily.ts",
  "crates/agent-gui/src/lib/settings/index.ts",
  "crates/agent-gui/src/pages/chat/components/ChatFileDropOverlay.tsx",
  "crates/agent-gui/src/pages/chat/components/WorkspaceOverlayHost.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/RoundContent.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/ToolCallItem.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/ToolImages.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/ToolResultDisplay.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/ToolTraceGroup.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/assistantBubbleUtils.ts",
  "crates/agent-gui/src/pages/chat/hooks/useChatSkills.ts",
  "crates/agent-gui/src/pages/chat/transcript/EditableUserMessageBubble.tsx",
  "crates/agent-gui/src/pages/chat/workspace/useWorkspaceOverlays.ts",
  "crates/agent-gui/src/pages/settings/memory/platform.tsx",
  "crates/agent-gateway/web/src/components/icons.tsx",
  "crates/agent-gateway/web/src/agent-ui-adapters/chatModelOptions.ts",
  "crates/agent-gateway/web/src/agent-ui-adapters/mentionReferences.ts",
  "crates/agent-gateway/web/src/app/FileDropOverlay.tsx",
  "crates/agent-gateway/web/src/app/WorkspaceOverlayHost.tsx",
  "crates/agent-gateway/web/src/lib/chat/changedFiles.ts",
  "crates/agent-gateway/web/src/lib/chat/assistantBubbleAdapter.ts",
  "crates/agent-gateway/web/src/lib/chat/changedFilesAdapter.ts",
  "crates/agent-gateway/web/src/lib/chat/chatPageHelpersAdapter.ts",
  "crates/agent-gateway/web/src/lib/chat/fileChangeStats.ts",
  "crates/agent-gateway/web/src/lib/chat/hostedSearch.ts",
  "crates/agent-gateway/web/src/lib/chat/mentionReferences.ts",
  "crates/agent-gateway/web/src/lib/chat/toolPreview.ts",
  "crates/agent-gateway/web/src/lib/chat/toolPreviewAdapter.ts",
  "crates/agent-gateway/web/src/lib/chat/uploadedFiles.ts",
  "crates/agent-gateway/web/src/lib/chat/userMessageContent.tsx",
  "crates/agent-gateway/web/src/lib/chat/uiMessages.ts",
  "crates/agent-gateway/web/src/lib/fontFamily.ts",
  "crates/agent-gateway/web/src/lib/settings/index.ts",
  "crates/agent-gateway/web/src/pages/chat/AssistantBubble.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/RoundContent.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/ToolCallItem.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/ToolImages.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/ToolResultDisplay.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/ToolTraceGroup.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/assistantBubbleUtils.ts",
  "crates/agent-gateway/web/src/pages/chat/queue/chatTurnQueue.ts",
  "crates/agent-gateway/web/src/pages/chat/useChatSkills.ts",
  "crates/agent-gateway/web/src/pages/settings/memory/platform.tsx",
];
for (const retiredPath of retiredSharedCopies) {
  if (sharedFacades.has(retiredPath)) continue;
  if (!existsSync(join(repoRoot, retiredPath))) continue;
  failures += 1;
  console.error(
    `${retiredPath}: Shared source migrated to agent-ui must not be recreated in the host directory`,
  );
}

const applicationEntries = [
  [
    join(repoRoot, "crates/agent-gui/src/pages/ChatPage.tsx"),
    join(repoRoot, "crates/agent-gui/src/pages/ChatPage.tsx"),
  ],
  [
    join(repoRoot, "crates/agent-gateway/web/src/app/GatewayApp.tsx"),
    join(repoRoot, "crates/agent-gateway/web/src/app/GatewayAppView.tsx"),
  ],
];
for (const [entryFile, viewFile] of applicationEntries) {
  const entrySource = readFileSync(entryFile, "utf8");
  const viewSource = readFileSync(viewFile, "utf8");
  const viewComponentName = basename(viewFile, ".tsx");
  // Assert real render delegation, not textual coincidence: the entry must actually render the View component via JSX
  // (import type alone does not count), and the View must import the shared ApplicationView and render it
  // (a path string appearing in a comment does not count).
  const delegatesToView =
    entryFile === viewFile ||
    rendersImportedComponent(
      entrySource,
      entryFile,
      `./${viewComponentName}`,
      viewComponentName,
    );
  const rendersSharedApplicationView = rendersImportedComponent(
    viewSource,
    viewFile,
    "@liveagent/ui/application/ApplicationView",
    "ApplicationView",
  );
  if (delegatesToView && rendersSharedApplicationView) continue;
  failures += 1;
  console.error(
    `${relative(repoRoot, entryFile)}: The app must render the main view through the shared ApplicationView`,
  );
}

if (failures > 0) process.exit(1);
console.log("UI boundary check passed.");
