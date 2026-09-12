import type { Locale } from "@liveagent/app/i18n/config";
import type { ThinkingLevel } from "@liveagent/ui/lib/models/modelThinking";
import type { WorkspaceProjectGroup } from "@liveagent/ui/lib/workspaceProjectTypes";

import type { SidebarShortcuts } from "./sidebarShortcuts";

export type ProviderId = "codex" | "claude_code" | "gemini" | "xai" | "deepseek";

export type ExecutionMode = "text" | "tools" | "agent-dev";

export type CodexRequestFormat = "openai-completions" | "openai-responses";

export type ReasoningLevel = "off" | ThinkingLevel;

export type McpTransport = "stdio" | "http" | "sse";

/**
 * MCP OAuth authentication config (docs/design/mcp-oauth.md). Default = "none" (the status quo,
 * with static headers still taking effect). The token never lands in settings - it is stored only
 * in the keychain (Rust side), so this structure can safely go into Gateway sync and WebDAV backups.
 */
export type McpAuthType = "none" | "oauth";

export type McpAuthConfig = {
  type: McpAuthType;
  /** A space-separated scope list that overrides PRM scopes_supported. */
  scope?: string;
  /** Static client_id (enterprise AS); by default it uses RFC 7591 dynamic registration. */
  clientId?: string;
};

export type McpServerConfig = {
  id: string;
  description?: string;
  docsUrl?: string;
  enabled: boolean;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  messageUrl?: string;
  auth?: McpAuthConfig;
};

export type McpSettings = {
  servers: McpServerConfig[];
  selected: string[];
};

export type SkillsSettings = {
  enabled: boolean;
  selected: string[];
};

export type MemoryOrganizerScope = "all" | "global" | "projects" | "current-project";

export type MemoryOrganizerMode = "conservative" | "standard" | "aggressive";

export type MemoryOrganizerFrequency = "none" | "daily" | "weekly";

export type MemoryOrganizerSchedule = {
  frequency: MemoryOrganizerFrequency;
  timeLocal: string;
  weekday?: number;
  timezone: string;
};

export type MemorySettings = {
  organizerModel?: SelectedModel;
  summaryModel?: SelectedModel;
  organizerEnabled: boolean;
  organizerSchedule: MemoryOrganizerSchedule;
  organizerScope: MemoryOrganizerScope;
  organizerMode: MemoryOrganizerMode;
  organizerLastRunAt?: number;
  organizerNextRunAt?: number;
};

export type ChatSidebarSettings = {
  projectsCollapsed: boolean;
  recentCollapsed: boolean;
};

export const RIGHT_DOCK_TOOL_KINDS = ["fileTree", "gitReview", "tunnel", "sshTunnel"] as const;

export type RightDockToolKind = (typeof RIGHT_DOCK_TOOL_KINDS)[number];

export type RightDockTabKind = RightDockToolKind | "terminal" | "backgroundTasks";

export type RightDockToolTab = {
  openedAt: number;
  uiState?: Record<string, unknown>;
};

// Stable id of the derived background-tasks tab (not a RightDockToolKind:
// its existence also derives from the managed-process store at render time).
export const RIGHT_DOCK_BACKGROUND_TASKS_TAB_ID = "background-tasks";

// Cross-client visibility intent for the background-tasks tab. `opened`
// keeps the tab visible with no processes; `dismissedIds` snapshots the
// process ids visible at close time — a process id outside the snapshot
// re-derives the tab on every client.
export type RightDockBackgroundTasksState = {
  opened: boolean;
  dismissedIds: string[];
};

// Persisted dock state is user intent only: terminal tab existence is derived
// from live sessions at render time, so tabOrder may contain session ids that
// are dead or not yet loaded — they are preserved here and lazily collected on
// user gestures once the session list is known.
export type RightDockProjectState = {
  activeTabId?: string;
  tabOrder: string[];
  tools: Partial<Record<RightDockToolKind, RightDockToolTab>>;
  backgroundTasks: RightDockBackgroundTasksState;
  openVersion: number;
  stateVersion: number;
  writerId: string;
  lastUsedAt: number;
};

export type RightDockSettings = {
  width: number;
  projects: Record<string, RightDockProjectState>;
};

export type RightDockFileTreeState = {
  query: string;
  selectedPath: string;
  expandedPaths: string[];
  showHidden: boolean;
  // Reveal nonce: bumped (via bumpRevision) when another surface asks the
  // file tree to reveal selectedPath (expand ancestors + scroll into view).
  // Content refreshes are driven by workspace-activity invalidation, and
  // merge ordering is covered by the project-level stateVersion.
  revision: number;
};

export type RightDockFileTreeStatePatch = Partial<RightDockFileTreeState> & {
  bumpRevision?: boolean;
};

export type FontScaleSettings = {
  sidebar: number;
  chat: number;
  rightDock: number;
};

export type ChatTranscriptSettings = {
  width: number;
};

/**
 * The three display styles for composer context usage (docs/design/composer-context-stats-bar.md §4.7):
 * "statsBar" shows only the conversation stats bar below the card (including the usage reading),
 * with no usage ring rendered;
 * "both" shows the stats bar and the always-visible usage ring together;
 * "ring" shows only the always-visible usage ring (starting at 0%), with no stats bar rendered.
 * All three keep the manual compaction entry point at >=50%.
 */
export type ComposerContextDisplayMode = "statsBar" | "both" | "ring";

export type CustomSettings = {
  sidebarShortcuts: SidebarShortcuts;
  conversationTitleModel?: SelectedModel;
  // AI commit-message generation in the Git review dock. Unset means "follow
  // the current conversation model"; a stored selection whose provider/model
  // is no longer active normalizes back to unset, restoring that fallback.
  commitMessageModel?: SelectedModel;
  // Composer prompt-clarify. The master switch hides the composer
  // wand button on both surfaces when off. The model override follows the
  // commitMessageModel contract: unset means "follow the current conversation
  // model", and a stored selection whose provider/model is no longer active
  // normalizes back to unset.
  promptClarifyEnabled: boolean;
  promptClarifyModel?: SelectedModel;
  chatSidebar: ChatSidebarSettings;
  chatTranscript: ChatTranscriptSettings;
  rightDock: RightDockSettings;
  composerContextDisplay: ComposerContextDisplayMode;
  // Empty strings select the built-in stacks for each typography role.
  interfaceFontFamily: string;
  chatFontFamily: string;
  codeFontFamily: string;
  fontScale: FontScaleSettings;
};

export type UpdateSettings = {
  includePrereleases: boolean;
};

/**
 * cc-switch style automatic provider failover: an ordered fallback queue of
 * same-vendor *providers* tried when the active model's request fails with a
 * provider-fault-class error, plus circuit breaker knobs mirroring cc-switch's
 * failure threshold / cooldown time settings.
 *
 * Failover switches providers, never models (matching cc-switch): the failed
 * request is re-sent to the next provider in the queue with the *same model
 * id* the conversation was using. Providers that don't have that model active
 * are skipped at plan time.
 *
 * Failover is scoped per vendor type (mirroring cc-switch's Claude/Codex/
 * Gemini app tabs): a Claude request only fails over to Claude providers, a
 * Codex request only to Codex providers, never across vendors.
 */
export type ProviderFailoverSettings = {
  enabled: boolean;
  /** Ordered fallback provider ids (P1 → P2 → …), same vendor type only. */
  queue: string[];
  /** Max provider switches per request (attempts = switches + 1). */
  maxSwitches: number;
  /** Consecutive failures before a target's circuit breaker opens. */
  failureThreshold: number;
  /** Seconds an open breaker skips its target before a half-open probe. */
  cooldownSeconds: number;
};

/** Per-vendor failover settings, keyed by the provider tab type. */
export type ModelFailoverSettings = Record<ProviderId, ProviderFailoverSettings>;

export const MODEL_FAILOVER_QUEUE_LIMIT = 8;

export const PROVIDER_FAILOVER_TYPES: readonly ProviderId[] = [
  "claude_code",
  "codex",
  "gemini",
  "xai",
  "deepseek",
];

export const DEFAULT_PROVIDER_FAILOVER_SETTINGS: ProviderFailoverSettings = {
  enabled: false,
  queue: [],
  maxSwitches: 3,
  failureThreshold: 4,
  cooldownSeconds: 60,
};

export function getDefaultModelFailoverSettings(): ModelFailoverSettings {
  return {
    claude_code: { ...DEFAULT_PROVIDER_FAILOVER_SETTINGS },
    codex: { ...DEFAULT_PROVIDER_FAILOVER_SETTINGS },
    gemini: { ...DEFAULT_PROVIDER_FAILOVER_SETTINGS },
    xai: { ...DEFAULT_PROVIDER_FAILOVER_SETTINGS },
    deepseek: { ...DEFAULT_PROVIDER_FAILOVER_SETTINGS },
  };
}

/**
 * Cloudflare 5xx status codes that relays surface when their origin
 * errors. pi-ai's `isRetryableAssistantError` already retries 524; these are
 * the rest of Cloudflare's transient 5xx family (#608). Offered as toggleable
 * presets in the settings UI; the runtime retries any error message that
 * contains the code as a standalone number.
 */
export const RETRYABLE_PRESET_HTTP_STATUS_CODES = [520, 521, 522, 523, 525, 526, 527] as const;

/**
 * User-defined retry-error classification, layered on top of pi-ai's
 * `isRetryableAssistantError`. Lets users decide which errors the stream-retry
 * loop should treat as transient (#608) — preset Cloudflare 5xx toggles plus
 * free-text substrings for relay/gateway wording pi-ai doesn't recognize.
 */
export type RetryErrorSettings = {
  /**
   * HTTP status codes (from `RETRYABLE_PRESET_HTTP_STATUS_CODES`) the user has
   * enabled. Defaults to all presets on so relays self-heal out of the box.
   */
  presetStatusCodes: number[];
  /**
   * Free-text substrings matched case-insensitively against the error message.
   * An error containing any of these is retried. e.g. "SSL handshake failed".
   */
  customPatterns: string[];
};

export const DEFAULT_RETRY_ERROR_SETTINGS: RetryErrorSettings = {
  presetStatusCodes: [...RETRYABLE_PRESET_HTTP_STATUS_CODES],
  customPatterns: [],
};

export type SystemProxyType = "socks5" | "http";

// System-level outbound proxy: injected into the local shell command env, and used by provider
// model requests that have useSystemProxy checked (the proxy connection is made on the desktop
// Rust side, and credentials do not enter frontend requests).
export type SystemProxyConfig = {
  enabled: boolean;
  type: SystemProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
  passwordConfigured?: boolean;
};

/** Tool approval policy: allow = execute directly, ask = request user approval before executing, deny = reject outright. */
export type ToolPolicy = "allow" | "ask" | "deny";

// Command execution mode (switched in the dialog, a single mutually exclusive dimension):
// - ask: every tool call with side effects requests user approval (read-only tools are not blocked).
// - auto: execute directly per the tool approval policy (the existing default behavior).
// - sandbox / sandboxOffline: Bash and long-running processes execute inside an OS-level sandbox
//   (macOS Seatbelt / Linux bubblewrap / Windows restricted token WRITE_RESTRICTED), with writes
//   limited to the workspace + temp directory; the offline variant additionally cuts off the
//   network. Windows has two admin-free backends: sandbox = restricted token (fences writes only,
//   reads allowed); sandboxOffline = AppContainer (WFP kernel-level full network cut including
//   loopback, denying reads by default => system directories/workspace readable, and reads of
//   sensitive directories such as the user home are masked).
export type CommandSafetyMode = "ask" | "auto" | "sandbox" | "sandboxOffline";

export const COMMAND_SAFETY_MODES: readonly CommandSafetyMode[] = [
  "ask",
  "auto",
  "sandbox",
  "sandboxOffline",
];

// Browser tool's browser access mode:
// - auto: use the user's everyday browser (with login state) if the extension is connected,
//   otherwise fall back to an isolated profile.
// - userProfile: use only the user's everyday browser; if the extension is not connected it
//   errors and guides installation, never falling back (when the user explicitly wants login
//   state, silently degrading to an isolated browser without login state would create the false
//   impression of "seemingly operating my account but actually not").
// - isolated: use only a dedicated browser with an isolated profile, never touching the user's
//   browser even if the extension is online.
export type BrowserAutomationMode = "auto" | "userProfile" | "isolated";

export const BROWSER_AUTOMATION_MODES: readonly BrowserAutomationMode[] = [
  "auto",
  "userProfile",
  "isolated",
];

export type SystemSettings = {
  executionMode: ExecutionMode;
  workdir: string;
  /**
   * Override approval policies by canonical tool name (built-in names / `mcp_*`); by default
   * resolveToolPolicy infers by source (built-in/mcp = allow, read-only tools always allow).
   * Optional: when an old snapshot lacks this field it is treated as an empty table (all go
   * through defaults), ensuring zero regression.
   */
  toolPolicies?: Record<string, ToolPolicy>;
  /**
   * Allow CUA tools to target ReactorPro itself. Default false.
   *
   * When off (the default) the host's windows neither appear in cua-driver's enumeration results
   * nor can be addressed directly - letting the model operate the host UI would mean it could
   * dismiss its own approval dialogs, rewrite this permission setting, or shut the app down
   * outright. There is only one legitimate reason to turn it on: using ReactorPro to
   * automatically test ReactorPro. See `lib/tools/cuaSelfGuard.ts` for the implementation.
   */
  cuaAllowSelfTargeting?: boolean;
  commandSafetyMode: CommandSafetyMode;
  /** Browser tool's browser access mode; defaults to auto (also auto when an old snapshot lacks the field). */
  browserAutomationMode: BrowserAutomationMode;
  workspaceProjects: WorkspaceProject[];
  workspaceProjectGroups: WorkspaceProjectGroup[];
  workspaceProjectOrder?: string[];
  sidebarPinnedOrder?: string[];
  activeWorkspaceProjectId?: string;
  hiddenWorkspaceProjectPaths: string[];
  missingWorkspaceProjectPaths: string[];
  // Archived workspaces (path-keyed, like hidden/missing). Archived rows stay
  // in the merged list but render disabled and can never be active.
  archivedWorkspaceProjectPaths: string[];
  workspaceResourceSettings: Record<string, WorkspaceResourceSettings>;
  systemProxy: SystemProxyConfig;
};

export type WorkspaceResourceSettingsMode = "inherit" | "custom" | "off";

export type ProjectPromptStrategy = "append" | "replace";

export type WorkspaceResourceSettings = {
  mode: WorkspaceResourceSettingsMode;
  skillNames: string[];
  mcpServerIds: string[];
  projectPrompt: string;
  projectPromptStrategy: ProjectPromptStrategy;
  stateVersion: number;
  writerId: string;
  updatedAt: number;
};

export type EffectiveWorkspaceResources = {
  mode: WorkspaceResourceSettingsMode;
  skillsEnabled: boolean;
  skillNames: string[];
  mcpServerIds: string[];
  mcpServers: McpServerConfig[];
};

export type EffectivePromptSettings = {
  globalTemplates: AgentPromptTemplate[];
  globalPrompt: string;
  projectPrompt: string;
  projectPromptStrategy: ProjectPromptStrategy;
  prompt: string;
};

export type WorkspaceProjectKind = "managed" | "folder" | "history";

export type WorkspaceProject = {
  id: string;
  name: string;
  path: string;
  kind: WorkspaceProjectKind;
  worktree?: {
    repositoryPath: string;
    branch?: string;
  };
  createdAt: number;
  updatedAt: number;
  lastConversationAt?: number;
  isPinned?: boolean;
  pinnedAt?: number | null;
};

export type SelectedModel = {
  customProviderId: string;
  model: string;
};

export type PromptCacheHintMode = "auto" | "openai-key" | "openrouter-session" | "none";

/**
 * Limit source: catalog (catalog hit) > provider (a declared value bundled with the provider API)
 * > fallback (best-effort guess); user means manually changed by the user and is never
 * automatically overwritten. When missing (old archives) it is filled in one go per
 * normalizeProviderModelConfig's migration inference rules.
 */
export type ModelLimitsSource = "catalog" | "provider" | "fallback" | "user";

/** The complete set of valid model input modalities (the single source for runtime validation and types). */
export const MODEL_INPUT_MODALITIES = ["text", "image"] as const;

/** Model input modality; when absent it is inferred from the provider's built-in rules. */
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

/**
 * The canonical shapes of a normalized input-modality override: the chat protocol always sends
 * text, so "text" is always first; the normalizer only produces these two shapes.
 */
export type ModelInputModalitiesOverride = ["text"] | ["text", "image"];

export type ProviderModelConfig = {
  id: string;
  /** /models metadata; when absent, backward compatibility with the old settings format is preserved. */
  ownedBy?: string;
  contextWindow: number;
  maxOutputToken: number;
  limitsSource?: ModelLimitsSource;
  /** The cache hint protocol for OpenAI-compatible endpoints; when absent it inherits the provider setting. */
  promptCacheHintMode?: PromptCacheHintMode;
  /**
   * The user's manual input-modality override (e.g. ["text","image"] forces image input on).
   * When absent it is inferred from the provider's built-in heuristics (allowlist/officially known
   * model catalogs). Scope: only codex/xai/gemini providers (attachment sending on these paths is
   * gated by model.input); the deepseek wire layer hard-rejects images, and the anthropic
   * attachment path does not read model.input, so this field has no effect on those two provider
   * types. It must be normalized via normalizeInputModalities before being read.
   */
  inputModalities?: ModelInputModalitiesOverride;
};

export type ChatRuntimeControls = {
  thinkingEnabled: boolean;
  nativeWebSearchEnabled: boolean;
  /** Plan mode: only read-only tools are injected this turn, and execution begins only after ExitPlanMode approval. */
  planModeEnabled: boolean;
  reasoning: ReasoningLevel;
  reasoningByProvider: Partial<Record<ChatRuntimeReasoningProviderKey, ReasoningLevel>>;
};

export type ChatRuntimeReasoningProviderKey =
  | "claude_code"
  | "codex_openai_responses"
  | "codex_openai_completions"
  | "gemini"
  | "xai"
  | "deepseek";

export type AgentPromptTemplate = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
};

export type SshAuthType = "password" | "privateKey" | "keyboardInteractive";

export type SshProxyType = "socks5" | "http";

export type SshProxyConfig = {
  type: SshProxyType;
  url: string;
  port: number;
  username: string;
  password: string;
  passwordConfigured?: boolean;
  /** Reuse "System Settings -> Application Proxy" (systemProxy) directly; when on, the manual proxy fields are ignored. */
  useSystemProxy: boolean;
};

export type SshHostConfig = {
  id: string;
  name: string;
  description: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  password: string;
  passwordConfigured?: boolean;
  privateKey: string;
  privateKeyPath: string;
  privateKeyConfigured?: boolean;
  privateKeyPassphrase: string;
  privateKeyPassphraseConfigured?: boolean;
  proxy: SshProxyConfig;
};

export type SshSettings = {
  hosts: SshHostConfig[];
  projectHostAssociations: Record<string, string[]>;
};

export type UsageQueryMode = "coding-plan" | "balance" | "general" | "newapi" | "custom";

export type UsageQueryScripts = Partial<Record<"custom" | "general" | "newapi", string>>;

export type UsageQueryCodingPlanProvider =
  | ""
  | "kimi"
  | "zhipu"
  | "zhipu_team"
  | "minimax"
  | "zenmux"
  | "volcengine";

export type UsageQueryConfig = {
  enabled: boolean;
  mode: UsageQueryMode;
  /** The effective script for the current mode (the Rust execution layer reads only this field). */
  script: string;
  /** A separate script per script mode: switching query modes does not cross-contaminate, and unset ones show the template preset. */
  scripts: UsageQueryScripts;
  baseUrl: string;
  /** Query-specific API Key override (empty falls back to the provider's own apiKey). */
  apiKey: string;
  apiKeyConfigured?: boolean;
  accessToken: string;
  accessTokenConfigured?: boolean;
  userId: string;
  accessKeyId: string;
  secretAccessKey: string;
  secretAccessKeyConfigured?: boolean;
  /** Token Plan provider (empty = auto-detect from the Base URL; the Zhipu team plan must be selected explicitly). */
  codingPlanProvider: UsageQueryCodingPlanProvider;
  /** Zhipu team plan: organization/project ID (sent as the bigmodel-organization / bigmodel-project request headers). */
  teamOrganizationId: string;
  teamProjectId: string;
  /** Request timeout (seconds, 2-30). */
  timeoutSecs: number;
};

export const USAGE_QUERY_TIMEOUT_MIN_SECS = 2;

export const USAGE_QUERY_TIMEOUT_MAX_SECS = 30;

export const USAGE_QUERY_TIMEOUT_DEFAULT_SECS = 10;

export function getDefaultUsageQueryConfig(): UsageQueryConfig {
  return {
    enabled: false,
    mode: "newapi",
    script: "",
    scripts: {},
    baseUrl: "",
    apiKey: "",
    apiKeyConfigured: false,
    accessToken: "",
    accessTokenConfigured: false,
    userId: "",
    accessKeyId: "",
    secretAccessKey: "",
    secretAccessKeyConfigured: false,
    codingPlanProvider: "",
    teamOrganizationId: "",
    teamProjectId: "",
    timeoutSecs: USAGE_QUERY_TIMEOUT_DEFAULT_SECS,
  };
}

export type CustomProvider = {
  id: string;
  name: string;
  type: ProviderId;
  baseUrl: string;
  /** Treat baseUrl as the final request address; a local reverse proxy no longer appends the protocol endpoint path. */
  isFullUrl: boolean;
  /** Optional full address of the model list; when empty it is derived automatically from baseUrl. */
  modelsUrl?: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  customHeaders?: { key: string; value: string }[];
  models: ProviderModelConfig[];
  modelOrder?: string[];
  activeModels: string[];
  requestFormat?: CodexRequestFormat;
  reasoning: ReasoningLevel;
  promptCachingEnabled: boolean;
  /** The cache hint protocol for OpenAI-compatible endpoints; old configs migrate from promptCachingEnabled. */
  promptCacheHintMode?: PromptCacheHintMode;
  /** Anthropic only: the ephemeral cache retention tier; long maps to a 1h TTL on the official API. */
  promptCacheRetention?: "short" | "long";
  nativeWebSearchEnabled: boolean;
  useSystemProxy: boolean;
  /** In-stream retry policy; default = global default behavior (equivalent to mode:"default"). */
  retryPolicy?: ProviderRetryPolicy;
  usageQuery: UsageQueryConfig;
};

/**
 * Provider-level in-stream retry policy.
 *
 * - default: use the global default (5 retries, i.e. DEFAULT_STREAM_RETRY_MAX_ATTEMPTS-1)
 *   - equivalent to being unset, so normalization omits the field entirely, ensuring zero
 *   migration for old configs;
 * - off: disable in-stream retries (does not affect cross-provider failover);
 * - custom: use maxRetries - the number of retries after the first failure, excluding the first
 *   request (clamped to 1..10; for 0 retries choose off directly). Same denominator as the m in
 *   the retry status prompt "retrying (n/m)".
 */
export type ProviderRetryPolicy = { mode: "off" } | { mode: "custom"; maxRetries: number };

export const PROVIDER_RETRY_MAX_RETRIES_LIMITS = {
  min: 1,
  max: 10,
} as const;

/**
 * UI display mirror of the global default in-stream retry count (excluding the first request).
 * The runtime source of truth is DEFAULT_STREAM_RETRY_MAX_ATTEMPTS in agent-gui streamRetry.ts
 * (total attempts = retries + 1; the UI boundary forbids reverse dependencies); their consistency
 * is pinned by the provider-retry-policy unit test.
 */
export const PROVIDER_RETRY_DEFAULT_MAX_RETRIES = 5;

export type EffectiveTheme = "light" | "dark";

export type Theme = EffectiveTheme | "system";

export type CloseWindowBehavior = "minimize" | "exit";

export const THEME_OPTIONS = ["light", "dark", "system"] as const satisfies readonly Theme[];

export const CLOSE_WINDOW_BEHAVIOR_OPTIONS = [
  "minimize",
  "exit",
] as const satisfies readonly CloseWindowBehavior[];

export type RemoteSettings = {
  enabled: boolean;
  gatewayUrl: string;
  gatewayPort: number;
  token: string;
  agentId: string;
  autoReconnect: boolean;
  heartbeatInterval: number;
  enableWebTerminal: boolean;
  enableWebSshTerminal: boolean;
  enableWebGit: boolean;
  enableWebTunnels: boolean;
};

export type AppSettings = {
  system: SystemSettings;
  customProviders: CustomProvider[];
  mcp: McpSettings;
  agents: AgentPromptTemplate[];
  ssh: SshSettings;
  remote: RemoteSettings;
  memory: MemorySettings;
  customSettings: CustomSettings;
  modelFailover: ModelFailoverSettings;
  retryErrorSettings: RetryErrorSettings;
  updates: UpdateSettings;
  skills: SkillsSettings;
  chatRuntimeControls: ChatRuntimeControls;
  selectedModel?: SelectedModel;
  theme: Theme;
  locale: Locale;
  /** Desktop-only: close title-bar X to hide to tray or exit the application. */
  closeWindowBehavior: CloseWindowBehavior;
};

export const CODEX_REQUEST_FORMAT_LABELS: Record<CodexRequestFormat, string> = {
  "openai-completions": "OpenAI-Completions",
  "openai-responses": "Responses API",
};

export const PROMPT_CACHE_HINT_MODES = [
  "auto",
  "openai-key",
  "openrouter-session",
  "none",
] as const satisfies readonly PromptCacheHintMode[];

export const DEFAULT_CHAT_RUNTIME_CONTROLS: ChatRuntimeControls = {
  thinkingEnabled: true,
  nativeWebSearchEnabled: true,
  planModeEnabled: false,
  reasoning: "high",
  reasoningByProvider: {
    claude_code: "high",
    codex_openai_responses: "high",
    codex_openai_completions: "high",
    gemini: "high",
    xai: "high",
    deepseek: "high",
  },
};

export const DEFAULT_WORKSPACE_PROJECT_ID = "default-project";

export const DEFAULT_WORKSPACE_PROJECT_NAME = "Default Project";
