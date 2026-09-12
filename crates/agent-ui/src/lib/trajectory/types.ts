/**
 * Single source of truth for trajectory-domain types.
 *
 * The three forms are strictly separated:
 * - `TrajectoryEvent` is the **wire format**: short field names, goes over the live channel and is
 *   persisted, fields are append-only.
 * - `TrajectoryLedger` is the **normalized intermediate form**: the readable structure after
 *   eventLog converges, purely in memory.
 * - `TrajectoryRecord` is the **visual record**: the layout product; the UI recognizes only this.
 */

/** Terminal state of an operation. `running` appears only in the live ledger. */
export type TrajectoryStatus = "running" | "complete" | "error" | "aborted";

/** Ledger row kind, corresponding one-to-one with lane membership. */
export type TrajectoryRecordKind =
  | "system"
  | "user"
  | "context"
  | "compacted"
  | "message"
  | "tool"
  | "subtool";

/** Aligned with `UsagePanelUsage`, plus reasoning tokens. */
export type TrajectoryUsage = {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

/**
 * Fixed slot order in the wire format. Only append to the end: the first six are already persisted,
 * and reordering would misread old events' toolsSuffix/toolCatalog as something else.
 */
export const TRAJECTORY_SECTION_SLOTS = [
  "base",
  "agent",
  "skills",
  "memory",
  "toolsSuffix",
  "toolCatalog",
  "runtime",
] as const;

export type TrajectorySectionSlot = (typeof TRAJECTORY_SECTION_SLOTS)[number];

/** The order in which the system prompt is concatenated as the model actually sees it; toolCatalog
 * is a request parameter and does not enter the body. */
export const TRAJECTORY_PROMPT_SECTION_SLOTS = [
  "base",
  "agent",
  "skills",
  "memory",
  "runtime",
  "toolsSuffix",
] as const satisfies readonly TrajectorySectionSlot[];

/** sectionId per slot, defaulting to null; old records may be shorter than the current slot count. */
export type TrajectorySectionRefs = readonly (string | null)[];

/** Category of change of a request header relative to the previous one. */
export type TrajectoryHeaderChange = "initial" | "system" | "tools" | "system-and-tools" | "none";

/** One section of content, content-addressed. */
export type TrajectorySection = {
  sectionId: string;
  slot: TrajectorySectionSlot;
  content: string;
};

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Compact events shared by persistence and the live channel. Field names are deliberately short: a
 * long turn with 50 tool calls is about 150 events, and short names keep it under ~18 KB, far below
 * the relay window's 8 MiB limit.
 */
export type TrajectoryEvent =
  /** A user message opens a turn. `mi` is the in-conversation messageIndex, used for cross-view
   * positioning. */
  | { k: "user"; t: number; at: number; mi?: number; id?: string; tx?: string }
  /** Context injection. */
  | { k: "context"; t: number; at: number; src?: string; tx?: string }
  /** Request header snapshot. `sec` is the sectionId arranged by wire-format slot, `ch` the change
   * category, `prev` the previous headerId. */
  | {
      k: "header";
      /** Header slot layout version. Missing/1 is the legacy six-slot layout. */
      v?: number;
      at: number;
      hid: string;
      sec: TrajectorySectionRefs;
      ch: TrajectoryHeaderChange;
      prev?: string;
    }
  /** A provider request begins. */
  | { k: "step_start"; t: number; s: number; at: number; hid?: string }
  /** The first text/thinking delta, used to derive TTFT. */
  | { k: "first_token"; t: number; s: number; at: number }
  /** Request ends. `sr` is the stopReason. */
  | {
      k: "step_end";
      t: number;
      s: number;
      at: number;
      st: TrajectoryStatus;
      u?: TrajectoryUsage;
      p?: string;
      m?: string;
      api?: string;
      sr?: string;
      err?: string;
    }
  /** Retry record after a failure. `p` is the candidate label ("Provider · model"), distinguishing
   * each candidate's retries under failover. */
  | {
      k: "retry";
      t: number;
      s: number;
      at: number;
      n: number;
      max?: number;
      delay?: number;
      err?: string;
      p?: string;
    }
  /** Cross-provider switch record. `n` is the switch sequence number within this request, `ti` the
   * target's index in the candidate queue. */
  | {
      k: "failover";
      t: number;
      s: number;
      at: number;
      n: number;
      from?: string;
      to?: string;
      ti?: number;
      err?: string;
    }
  /**
   * Transport assembly snapshot of one actual attempt. Redaction invariant: contains only header
   * names (`hn`) and routing flags, never any header value or secret; `o` is the upstream origin
   * (scheme+host).
   */
  | {
      k: "transport";
      t: number;
      s: number;
      at: number;
      p?: string;
      o?: string;
      sp?: boolean;
      fu?: boolean;
      hn?: readonly string[];
    }
  /** Tool begins execution. `a` is the truncated argument text. */
  | { k: "tool_start"; t: number; s: number; at: number; id: string; n: string; a?: string }
  /** Tool ends. `run` is the subagent runId derived by the Agent tool. */
  | {
      k: "tool_end";
      at: number;
      id: string;
      /** New writers include the host; old persisted events remain valid without it. */
      t?: number;
      s?: number;
      err?: boolean;
      sum?: string;
      run?: readonly string[];
    }
  /** Context compaction begins. turn null means manual compaction between two turns. */
  | { k: "compaction_start"; t: number | null; at: number }
  /** Context compaction ends, with tokens before and after. */
  | {
      k: "compaction_end";
      t: number | null;
      at: number;
      st: TrajectoryStatus;
      before?: number;
      after?: number;
      err?: string;
    }
  /** A turn ends. */
  | { k: "turn_end"; t: number; at: number; st: TrajectoryStatus; err?: string };

export type TrajectoryEventKind = TrajectoryEvent["k"];

// ---------------------------------------------------------------------------
// Normalized intermediate form
// ---------------------------------------------------------------------------

export type LedgerRetry = {
  attempt: number;
  at: number;
  maxRetries?: number;
  delayMs?: number;
  error?: string;
  /** Candidate label ("Provider · model"); distinguishes each candidate's own retries under
   * failover. */
  provider?: string;
};

export type LedgerFailover = {
  attempt: number;
  at: number;
  fromLabel?: string;
  toLabel?: string;
  /** Stable index of the target in the candidate queue (0 = primary). */
  targetIndex?: number;
  error?: string;
};

/** Transport assembly snapshot of one actual attempt. Contains only header names and routing flags,
 * never header values. */
export type LedgerTransport = {
  at: number;
  provider?: string;
  upstreamOrigin?: string;
  useSystemProxy?: boolean;
  fullUrl?: boolean;
  headerNames?: readonly string[];
};

export type LedgerToolCall = {
  callId: string;
  name: string;
  args?: string;
  startedAt: number | null;
  endedAt: number | null;
  status: TrajectoryStatus;
  isError: boolean;
  summary?: string;
  subagentRunIds: readonly string[];
};

export type LedgerStep = {
  turn: number;
  step: number;
  startedAt: number | null;
  firstTokenAt: number | null;
  endedAt: number | null;
  status: TrajectoryStatus;
  error?: string;
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  usage?: TrajectoryUsage;
  headerId?: string;
  retries: readonly LedgerRetry[];
  failovers: readonly LedgerFailover[];
  transports: readonly LedgerTransport[];
  tools: readonly LedgerToolCall[];
};

export type LedgerCompaction = {
  turn: number | null;
  startedAt: number | null;
  endedAt: number | null;
  status: TrajectoryStatus;
  tokensBefore?: number;
  tokensAfter?: number;
  error?: string;
};

export type LedgerInput = {
  kind: "user" | "context";
  turn: number;
  at: number | null;
  /** Stable identity of the source event; keeps same-millisecond inputs distinct. */
  eventId?: string;
  messageIndex?: number;
  messageId?: string;
  source?: string;
  text?: string;
};

export type LedgerTurn = {
  turn: number;
  startedAt: number | null;
  endedAt: number | null;
  status: TrajectoryStatus;
  error?: string;
  inputs: readonly LedgerInput[];
  steps: readonly LedgerStep[];
  compactions: readonly LedgerCompaction[];
};

export type LedgerHeader = {
  /** Stable occurrence identity. The same content can become active more than once. */
  headerId: string;
  /** Content-addressed id carried on the wire (`TrajectoryEvent.hid`). */
  contentId: string;
  at: number;
  sections: TrajectorySectionRefs;
  change: TrajectoryHeaderChange;
  previousHeaderId?: string;
};

/**
 * The converged product of eventLog. `hasTiming` false means this ledger was derived by degrading
 * from messages: structurally complete but all durations are null, so the Gantt chart must be locked
 * to the sequence projection.
 */
export type TrajectoryLedger = {
  turns: readonly LedgerTurn[];
  headers: ReadonlyMap<string, LedgerHeader>;
  /** Compactions that occurred between two turns and belong to no turn. */
  standaloneCompactions: readonly LedgerCompaction[];
  hasTiming: boolean;
};

/** Empty-ledger constant, reused by the unloaded state as the same reference to avoid re-renders. */
export const EMPTY_TRAJECTORY_LEDGER: TrajectoryLedger = {
  turns: [],
  headers: new Map(),
  standaloneCompactions: [],
  hasTiming: false,
};

// ---------------------------------------------------------------------------
// Visual record
// ---------------------------------------------------------------------------

/** Summary of one subagent run, prefetched by the host and passed into layout. */
export type TrajectorySubagentRun = {
  runId: string;
  agentId: string;
  name?: string;
  mode?: string;
  status: TrajectoryStatus;
  startedAt: number | null;
  endedAt: number | null;
  steps: readonly {
    step: number;
    startedAt: number | null;
    endedAt: number | null;
    tools: readonly {
      callId: string;
      name: string;
      isError: boolean;
      /** The tool's own start/end (from subagent message timestamps); when missing, the layout layer
       * falls back to the step span. */
      startedAt?: number | null;
      endedAt?: number | null;
    }[];
  }[];
};

/** One raw content block for the detail panel, preserving model order. */
export type TrajectorySourceBlock = {
  type: string;
  content: string;
  callId?: string;
  toolName?: string;
  imageSrc?: string;
  imageAlt?: string;
  filePath?: string;
  fileSource?: "absolute" | "relative" | "file-url";
};

/** Assistant-specific timing facts, used for TTFT / decode throughput. */
export type TrajectoryAssistantMetrics = {
  timingRecorded: boolean;
  stepStartAt: number | null;
  firstTokenAt: number | null;
  completedAt: number | null;
  outputTokens: number | null;
};

/** One ledger row. `index` is the global 1-based sequence number, shared by rendering and the
 * timeline. */
export type TrajectoryRecord = {
  index: number;
  recordId: string;
  kind: TrajectoryRecordKind;
  /** Single-line summary text; overflow is ellipsized by CSS. */
  text: string;
  /** Tool result summary, shown on the same line as the call. */
  result?: string;
  turn: number | null;
  step: number | null;
  status: TrajectoryStatus;
  isError: boolean;
  /** Own duration in seconds. null means unknown -- a degraded ledger is all null. */
  timeSeconds: number | null;
  startedAt: number | null;
  callId?: string;
  toolName?: string;
  messageIndex?: number;
  headerId?: string;
  previousHeaderId?: string;
  headerChange?: TrajectoryHeaderChange;
  usage?: TrajectoryUsage;
  cumulativeUsage?: TrajectoryUsage;
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  error?: string;
  retries?: readonly LedgerRetry[];
  failovers?: readonly LedgerFailover[];
  transports?: readonly LedgerTransport[];
  assistantMetrics?: TrajectoryAssistantMetrics;
  inputDetail?: string;
  outputDetail?: string;
  thinkingDetail?: string;
  schemaDetail?: string;
  sourceBlocks?: readonly TrajectorySourceBlock[];
  outputBlocks?: readonly TrajectorySourceBlock[];
  tokensBefore?: number;
  tokensAfter?: number;
  subagentRunId?: string;
  /** A row that serves only as a request-separator anchor and renders no content. */
  requestOnly?: boolean;
};

/** A group of records within a turn (`Message` or `Step N`). */
export type TrajectoryGroupModel = {
  title: string;
  description?: string;
  records: readonly TrajectoryRecord[];
};

/** A turn, or a standalone compaction segment between two turns (turn null). */
export type TrajectoryTurnModel = {
  turn: number | null;
  groups: readonly TrajectoryGroupModel[];
};
