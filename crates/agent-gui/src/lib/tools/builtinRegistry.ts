import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { SystemToolRuntimeScope } from "@liveagent/ui/lib/tools/systemToolOptions";
import { homeDir } from "@tauri-apps/api/path";
import type { RuntimePlatform } from "../runtimePlatform";
import {
  type McpSettings,
  type McpSettingsOp,
  type ProviderId,
  type SshHostConfig,
  selectEnabledMcpServers,
} from "../settings";
import {
  createSendMessageTools,
  createSubagentTools,
  SUBAGENT_PARENT_ID,
  type SubagentRuntimeConfig,
} from "../subagents";
import type { AdditionalProjectRoot } from "./additionalProjectRoots";
import { createAskUserQuestionTools } from "./askUserQuestionTools";
import { createBrowserTools } from "./browserTools";
import type {
  BuiltinToolBundle,
  BuiltinToolExecutionContext,
  BuiltinToolMetadata,
} from "./builtinTypes";
import { createConversationTools } from "./conversationTools";
import { createCronTools } from "./cronTools";
import { createFileToolState, type FileToolState } from "./fileToolState";
import { createFsTools } from "./fsTools";
import { createMcpManagerTools } from "./mcpManagerTools";
import { createMcpTools } from "./mcpTools";
import { createMemoryTools } from "./memoryTools";
import { createExitPlanModeTools, isPlanModeAllowedTool } from "./planModeTools";
import { createShellTools, type ShellSandboxSettings } from "./shellTools";
import type { SkillAccessPolicy } from "./skillAccessPolicy";
import { createSkillTools } from "./skillTools";
import { createSSHManagerTools, type SshManagerSessionChange } from "./sshManagerTools";
import { createTaskTools, type TaskStateStore } from "./taskTools";
import { createTerminalTools } from "./terminalTools";
import { createToolSearchTools, shouldDeferMcpTools } from "./toolSearchTools";
import { createTunnelManagerTools, type TunnelManagerChange } from "./tunnelManagerTools";

export type BuiltinToolRegistry = {
  tools: BuiltinToolBundle["tools"];
  executeToolCall: (
    toolCall: ToolCall,
    signal?: AbortSignal,
    context?: BuiltinToolExecutionContext,
  ) => Promise<ToolResultMessage>;
  metadataByName: Map<string, BuiltinToolMetadata>;
  hasTool: (toolName: string) => boolean;
  /** MCP lazy loading is active: the caller should attach requestToolFilter to the runner
   * (inactive MCP tools do not enter model requests). The tools are still all present in
   * `tools` -- the execution layer must be able to find them. */
  mcpToolDeferralActive?: boolean;
};

// Tool names from third-party sources (MCP server / plugins) are outside our control and may
// collide. On collision we must not throw and abort the whole turn like builtin tools do -- that
// would let one bad plugin kill the entire conversation. Instead: first come, first served, skip
// later comers and warn; only throw when both sides are trusted builtin groups (that is a
// compile-time development bug).
const UNTRUSTED_TOOL_GROUPS: ReadonlySet<BuiltinToolBundle["groupId"]> = new Set(["mcp"]);
// We no longer declare JSON-schema constrained sampling (strict) for builtin tools. "prefer" was
// declared at one point (introduced with the pi 0.84.2 upgrade), but some OpenAI-compatible
// providers (such as Moonshot/Kimi) validate schema keywords against an allowlist in strict mode,
// so keywords commonly used by builtin tools such as minimum / maxItems always return 400, and a
// single tool's schema kills the whole turn; pi-ai's local pre-check (makeStrictJsonSchema) only
// catches structural problems and cannot intercept this kind of keyword-allowlist discrepancy, so
// the "prefer" degradation check fails entirely here. v1.2.4 and earlier declared no strict, and
// every provider worked -- return to that behavior. Bad calls that constrained sampling could
// eliminate ("misspelled parameter name, omitted required argument") are backstopped by the tools'
// own parameter validation.

function createBuiltinToolRegistry(bundles: BuiltinToolBundle[]): BuiltinToolRegistry {
  const tools: BuiltinToolBundle["tools"] = [];
  const metadataByName = new Map<string, BuiltinToolMetadata>();
  const executorsByName = new Map<string, BuiltinToolBundle["executeToolCall"]>();
  const groupIdByToolName = new Map<string, BuiltinToolBundle["groupId"]>();
  const canonicalToolNameByLookupKey = new Map<string, string | null>();

  const registerCanonicalToolName = (toolName: string) => {
    const key = toolName.trim().toLowerCase();
    if (!key) return;
    const existing = canonicalToolNameByLookupKey.get(key);
    if (existing === undefined) {
      canonicalToolNameByLookupKey.set(key, toolName);
    } else if (existing !== toolName) {
      canonicalToolNameByLookupKey.set(key, null);
    }
  };

  const resolveToolName = (toolName: string) => {
    if (executorsByName.has(toolName)) return toolName;
    const canonical = canonicalToolNameByLookupKey.get(toolName.trim().toLowerCase());
    return canonical && executorsByName.has(canonical) ? canonical : null;
  };

  for (const bundle of bundles) {
    for (const tool of bundle.tools) {
      if (executorsByName.has(tool.name)) {
        const existingGroup = groupIdByToolName.get(tool.name);
        const bothTrusted =
          !UNTRUSTED_TOOL_GROUPS.has(bundle.groupId) &&
          existingGroup !== undefined &&
          !UNTRUSTED_TOOL_GROUPS.has(existingGroup);
        if (bothTrusted) {
          // Two builtin tools share a name: a development bug that should be fixed at compile time; keep failing hard.
          throw new Error(`Duplicate builtin tool name detected: ${tool.name}`);
        }
        // A collision involving MCP/plugins: first come, first served, skip later comers, never abort the whole turn.
        console.warn(
          `[tools] Tool name "${tool.name}" from group "${bundle.groupId}" collides with an ` +
            `already-registered tool (group "${existingGroup ?? "unknown"}"); skipping the newcomer.`,
        );
        continue;
      }
      tools.push(tool);
      executorsByName.set(tool.name, bundle.executeToolCall);
      groupIdByToolName.set(tool.name, bundle.groupId);
      registerCanonicalToolName(tool.name);
      const metadata = bundle.metadataByName.get(tool.name);
      if (metadata) {
        metadataByName.set(tool.name, metadata);
      }
    }
  }

  return {
    tools,
    metadataByName,
    hasTool: (toolName) => resolveToolName(toolName) !== null,
    async executeToolCall(toolCall, signal, context) {
      const resolvedToolName = resolveToolName(toolCall.name);
      if (!resolvedToolName) {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        };
      }
      const execute = executorsByName.get(resolvedToolName);
      if (!execute) {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        };
      }
      const effectiveToolCall =
        resolvedToolName === toolCall.name ? toolCall : { ...toolCall, name: resolvedToolName };
      return execute(effectiveToolCall, signal, context);
    },
  };
}

type BuildBuiltinBaseToolRegistryParams = {
  workdir: string;
  /** Structured file-tool roots only; never forwarded to shell/process tools. */
  additionalRoots?: readonly AdditionalProjectRoot[];
  providerId: ProviderId;
  runtimePlatform?: RuntimePlatform;
  fileState: FileToolState;
  /** OS-level sandbox settings; passed through to the Bash / ManagedProcess execution layer. */
  sandbox?: ShellSandboxSettings;
  skillsEnabled: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  onManagedSkillsChanged?: (change: {
    action: "install" | "create" | "delete";
    names: string[];
    baseDirs: string[];
  }) => void | Promise<void>;
  runtimeScope: SystemToolRuntimeScope;
  /** Conversation checkpoint context; supplied in chat scenarios and absent in automation
   * scenarios such as Cron (no before-image is captured). turnId is a stable ID unique to each
   * user turn (independent of the clock), and sequence numbers are assigned by the Rust side. */
  checkpoint?: { conversationId: string; turnId: string };
  currentChatModel?: {
    customProviderId: string;
    model: string;
  };
  /** Live read of the authoritative MCP settings (never a turn-level snapshot). */
  getMcpSettings: () => McpSettings;
  /** Id-keyed merge commit into the authoritative settings; absent in read-only scopes. */
  applyMcpOps?: (ops: McpSettingsOp[]) => void;
  onMcpLoadError?: (message: string) => void;
  mcpLoadFailureMode?: "continue" | "throw";
  /** Allows CUA tools to target ReactorPro itself; defaults to false, see cuaSelfGuard.ts. */
  cuaAllowSelfTargeting?: boolean;
  memoryToolMode?: "rw" | "ro";
  remoteWebTunnelsEnabled?: boolean;
  tunnelProjectPathKey?: string;
  tunnelPublicBaseUrl?: string;
  sshHosts?: SshHostConfig[];
  associatedSshHostIds?: string[];
  sshManagerRemoteAllowed?: boolean;
  onSshSessionsChanged?: (change: SshManagerSessionChange) => void | Promise<void>;
  onTunnelsChanged?: (change: TunnelManagerChange) => void | Promise<void>;
};

const resolveHomeDir = () => homeDir();

type McpBusinessToolBundle = Awaited<ReturnType<typeof createMcpTools>>;

type BaseBuiltinToolBundles = {
  bundles: BuiltinToolBundle[];
  /** MCP business tool bundle (input to the lazy-loading decision and the ToolSearch catalog).
   * McpManager shares groupId "mcp" with it, so it must never be located by searching on
   * groupId -- this direct reference must be held. */
  mcpBusinessBundle: McpBusinessToolBundle | undefined;
};

async function buildBaseBuiltinToolBundles(
  params: BuildBuiltinBaseToolRegistryParams,
): Promise<BaseBuiltinToolBundles> {
  const baseBundles: BuiltinToolBundle[] = [
    createFsTools({
      workdir: params.workdir,
      additionalRoots: params.additionalRoots,
      fileState: params.fileState,
      skillsRootEnabled: params.skillsEnabled,
      skillsRootDir: params.skillsRootDir,
      skillAccessPolicy: params.skillAccessPolicy,
      resolveHomeDir,
      checkpoint: params.checkpoint,
    }),
    createShellTools({
      workdir: params.workdir,
      providerId: params.providerId,
      runtimePlatform: params.runtimePlatform,
      skillsRootEnabled: params.skillsEnabled,
      skillsRootDir: params.skillsRootDir,
      skillAccessPolicy: params.skillAccessPolicy,
      managedProcessEnabled: params.runtimeScope === "chat",
      resumableShellEnabled: params.runtimeScope === "chat",
      resolveHomeDir,
      sandbox: params.sandbox,
    }),
    ...(params.skillsEnabled
      ? [
          createSkillTools({
            workdir: params.workdir,
            skillAccessPolicy: params.skillAccessPolicy,
            onManagedSkillsChanged: params.onManagedSkillsChanged,
          }),
        ]
      : []),
    createCronTools({
      currentChatModel: params.currentChatModel,
      workdir: params.workdir,
    }),
    createMcpManagerTools({
      workdir: params.workdir,
      getMcpSettings: params.getMcpSettings,
      applyMcpOps: params.applyMcpOps,
      runtimeScope: params.runtimeScope,
      // In sandbox mode McpManager must not become an unfenced stdio spawn entry point (P1#1):
      // runtime probing and the create/update/enable write paths all reject stdio.
      sandbox: params.sandbox,
      resolveHomeDir,
    }),
    createMemoryTools({
      workdir: params.workdir,
      mode: params.memoryToolMode ?? "rw",
    }),
    createTunnelManagerTools({
      enabled: params.remoteWebTunnelsEnabled === true && params.runtimeScope === "chat",
      runtimeScope: params.runtimeScope,
      projectPathKey: params.tunnelProjectPathKey,
      publicBaseUrl: params.tunnelPublicBaseUrl,
      onTunnelsChanged: params.onTunnelsChanged,
    }),
    createSSHManagerTools({
      enabled:
        params.runtimeScope === "chat" &&
        params.sshManagerRemoteAllowed !== false &&
        (params.associatedSshHostIds?.length ?? 0) > 0,
      runtimeScope: params.runtimeScope,
      workdir: params.workdir,
      projectPathKey: params.tunnelProjectPathKey,
      hosts: params.sshHosts,
      associatedHostIds: params.associatedSshHostIds,
      resolveHomeDir,
      onSshSessionsChanged: params.onSshSessionsChanged,
    }),
    ...(params.runtimeScope === "chat"
      ? [
          createTerminalTools({
            workdir: params.workdir,
          }),
        ]
      : []),
    // Under sandboxOffline (enabled and !allowNetwork), browser network egress violates offline
    // semantics, so the whole bundle is not registered and is invisible in the model's tool table;
    // the executor has an additional fail-closed backstop.
    ...(params.sandbox?.enabled === true && !params.sandbox.allowNetwork
      ? []
      : [
          createBrowserTools({
            sandbox: params.sandbox,
          }),
        ]),
  ];

  const enabledServers = selectEnabledMcpServers(params.getMcpSettings());
  let mcpBusinessBundle: McpBusinessToolBundle | undefined;
  if (enabledServers.length > 0) {
    mcpBusinessBundle = await createMcpTools({
      servers: enabledServers,
      onLoadError: params.onMcpLoadError,
      loadFailureMode: params.mcpLoadFailureMode,
      cuaAllowSelfTargeting: params.cuaAllowSelfTargeting,
    });
    baseBundles.push(mcpBusinessBundle);
  }

  return { bundles: baseBundles, mcpBusinessBundle };
}

export async function buildBuiltinToolRegistry(
  params: BuildBuiltinBaseToolRegistryParams & {
    subagentRuntime?: SubagentRuntimeConfig;
    taskStateStore?: TaskStateStore;
    /** Injects the interactive question tool in chat scenarios; not registered in unattended subagent/automation scenarios. */
    askUserQuestionConversationId?: string;
    /** Plan mode: non-read-only tools do not enter the registry, ExitPlanMode is injected, and subagents are forced read-only. */
    planMode?: {
      conversationId: string;
    };
    /** MCP lazy loading: ToolSearch is injected when total schema size exceeds the threshold, and
     * MCP tools enter model requests only after activation (the execution layer always registers
     * them all). Chat scenarios only; meaningless under plan mode (MCP tools are not read-only and
     * are already absent from the table). */
    toolSearch?: {
      conversationId: string;
    };
    /** Earlier conversations explicitly selected through structured @ mentions this turn. */
    referencedConversations?: readonly ConversationMentionReference[];
    currentConversationId?: string;
  },
) {
  const planModeActive = Boolean(params.planMode);
  const { bundles: baseBundles, mcpBusinessBundle } = await buildBaseBuiltinToolBundles(params);
  // MCP lazy-loading decision: estimate tokens on the "schema JSON that would enter the request"
  // (same measure as tokenLedger) and enable only above the threshold -- the cost of one extra
  // retrieval turn is only worth it when it truly saves significant context. The decision and
  // catalog input must be a direct reference to the MCP business tool bundle: McpManager is also
  // registered under groupId "mcp" and is enqueued first, so finding by groupId would hit it and
  // permanently defeat the deferral decision.
  const mcpToolDeferralActive = Boolean(
    params.toolSearch &&
      params.runtimeScope === "chat" &&
      !planModeActive &&
      mcpBusinessBundle &&
      shouldDeferMcpTools(mcpBusinessBundle.tools),
  );
  const toolSearchBundles =
    mcpToolDeferralActive && params.toolSearch && mcpBusinessBundle
      ? [
          createToolSearchTools({
            conversationId: params.toolSearch.conversationId,
            entries: mcpBusinessBundle.tools.map((tool) => ({
              tool,
              serverLabel: mcpBusinessBundle.toolNameMap.get(tool.name)?.serverLabel ?? "",
            })),
          }),
        ]
      : [];
  const taskBundles =
    params.runtimeScope === "chat" && params.taskStateStore
      ? [createTaskTools(params.taskStateStore)]
      : [];
  const askUserQuestionBundles =
    params.runtimeScope === "chat" && params.askUserQuestionConversationId
      ? [createAskUserQuestionTools({ conversationId: params.askUserQuestionConversationId })]
      : [];
  const planModeBundles =
    params.runtimeScope === "chat" && params.planMode
      ? [
          createExitPlanModeTools({
            conversationId: params.planMode.conversationId,
          }),
        ]
      : [];
  const conversationBundles =
    params.runtimeScope === "chat" &&
    params.currentConversationId &&
    params.referencedConversations?.length
      ? [
          createConversationTools({
            references: params.referencedConversations,
            currentConversationId: params.currentConversationId,
          }),
        ]
      : [];
  const chatBundles = [
    ...taskBundles,
    ...askUserQuestionBundles,
    ...planModeBundles,
    ...conversationBundles,
    ...toolSearchBundles,
  ];

  // Plan mode: trim non-read-only tools at the registry assembly layer (rather than a deny
  // backstop) -- the model cannot see write tools at all, so no tokens are wasted and there is no
  // leak surface. Subagent collaboration tools (Agent/SendMessage) are kept, and Agent is forced
  // read-only by forceReadonly at the validate layer.
  const filterForPlanMode = (registry: ReturnType<typeof createBuiltinToolRegistry>) => {
    const withDeferralFlag: BuiltinToolRegistry = {
      ...registry,
      mcpToolDeferralActive,
    };
    if (!planModeActive) return withDeferralFlag;
    return {
      ...withDeferralFlag,
      tools: withDeferralFlag.tools.filter((tool) =>
        isPlanModeAllowedTool(tool.name, withDeferralFlag.metadataByName.get(tool.name)),
      ),
    };
  };

  const subagentRuntime = params.subagentRuntime;
  if (!subagentRuntime) {
    return filterForPlanMode(createBuiltinToolRegistry([...baseBundles, ...chatBundles]));
  }
  const subagentAdditionalRoots = params.additionalRoots?.map((root) => ({
    ...root,
    // Delegated agents can inspect parent-granted roots, but they never
    // inherit mutation capability for shared directories implicitly.
    access: "read" as const,
  }));

  const baseRegistry = createBuiltinToolRegistry(baseBundles);
  // The Agent tool description embeds the roster, so the store must be
  // hydrated before the bundle is created. Roster load failures degrade to an
  // empty roster instead of blocking the whole registry.
  try {
    await subagentRuntime.store.ready();
  } catch (error) {
    console.warn("Failed to load subagent roster for the Agent tool", error);
  }
  const parentMessageBundle = subagentRuntime.store.conversationId
    ? createSendMessageTools({
        store: subagentRuntime.store,
        senderId: SUBAGENT_PARENT_ID,
        senderName: "Parent Agent",
      })
    : null;
  const parentBundles = parentMessageBundle ? [...baseBundles, parentMessageBundle] : baseBundles;
  return filterForPlanMode(
    createBuiltinToolRegistry([
      ...parentBundles,
      ...chatBundles,
      createSubagentTools({
        providerId: subagentRuntime.providerId,
        model: subagentRuntime.model,
        runtime: subagentRuntime.runtime,
        runtimePlatform: params.runtimePlatform,
        workdir: params.workdir,
        resolveHomeDir,
        sessionId: subagentRuntime.sessionId,
        templates: subagentRuntime.templates,
        store: subagentRuntime.store,
        scheduler: subagentRuntime.scheduler,
        baseTools: baseRegistry.tools,
        executeToolCall: baseRegistry.executeToolCall,
        metadataByName: baseRegistry.metadataByName,
        additionalRoots: subagentAdditionalRoots,
        // Plan mode: subagents are read-only only, and worktree requests are rejected as parameter errors.
        forceReadonly: planModeActive,
        // Only for worktree apply to capture the before-image before merging back into the parent
        // workspace (blocker-2); it does not enter the subagent's own tool registry (see
        // checkpoint: undefined below).
        checkpoint: params.checkpoint,
        createSubagentToolRegistry: async (workdir) =>
          createBuiltinToolRegistry(
            (
              await buildBaseBuiltinToolBundles({
                ...params,
                workdir,
                additionalRoots: subagentAdditionalRoots,
                fileState: createFileToolState(),
                skillsEnabled: false,
                applyMcpOps: undefined,
                mcpLoadFailureMode: "continue",
                memoryToolMode: "ro",
                // A worktree subagent's workdir is a temporary git worktree, and the temp directory
                // is cleaned up once changes are merged back into the parent workspace via apply -- if
                // the parent turn's checkpoint were inherited, the captured before-image would point
                // to a dead path, and rewind would "restore" a temp directory that no longer exists.
                // The parent workspace's real before-image is captured by subagent_worktree_apply
                // before the merge.
                checkpoint: undefined,
              })
            ).bundles,
          ),
      }),
    ]),
  );
}
