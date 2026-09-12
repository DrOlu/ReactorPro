/**
 * Fallback derivation for existing sessions: `UiMessage[]` -> ledger.
 *
 * Sessions from before the trajectory feature shipped have no event log. This path reconstructs structure
 * from the messages themselves --- turns split on user-message boundaries, steps split on rounds, tools
 * paired by callId --- but **there is no timing information at all**.
 *
 * `hasTiming: false` is a hard signal to the UI: the Gantt chart must be locked to the sequence projection
 * and the Duration button grayed out. Never fabricate durations: a "duration" derived from message timestamp
 * differences is wrong for parallel tool batches, and a number that looks precise but is actually wrong is
 * far more harmful than an honest null.
 */

import type { UiMessage } from "../chat/uiMessages";
import { getRoundToolTrace } from "../chat/uiMessages";
import { trajectoryTurnByMessageId, walkTrajectoryTurns } from "./contentIndex";
import type {
  LedgerStep,
  LedgerToolCall,
  LedgerTurn,
  TrajectoryLedger,
  TrajectoryUsage,
} from "./types";

type UsageLike = {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

function normalizeUsage(value: unknown): TrajectoryUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const usage = value as UsageLike;
  const picked: TrajectoryUsage = {};
  if (typeof usage.totalTokens === "number") picked.totalTokens = usage.totalTokens;
  if (typeof usage.input === "number") picked.input = usage.input;
  if (typeof usage.output === "number") picked.output = usage.output;
  if (typeof usage.cacheRead === "number") picked.cacheRead = usage.cacheRead;
  if (typeof usage.cacheWrite === "number") picked.cacheWrite = usage.cacheWrite;
  if (typeof usage.reasoning === "number") picked.reasoning = usage.reasoning;
  return Object.keys(picked).length === 0 ? undefined : picked;
}

/**
 * Derive the fallback ledger from the message sequence.
 *
 * @param messages - The session's UI message sequence.
 * @returns A structurally complete ledger with all times null.
 */
export function deriveLedgerFromMessages(
  messages: readonly UiMessage[],
  authoritativeLedger?: TrajectoryLedger,
): TrajectoryLedger {
  const turns: LedgerTurn[] = [];
  const authoritativeTurns = trajectoryTurnByMessageId(authoritativeLedger);

  for (const entry of walkTrajectoryTurns(messages, authoritativeTurns)) {
    const steps: LedgerStep[] = [];
    for (const assistant of entry.assistants) {
      for (const round of assistant.rounds ?? []) {
        const tools: LedgerToolCall[] = getRoundToolTrace(round).map((item) => ({
          callId: item.toolCall.id,
          name: item.toolCall.name,
          startedAt: null,
          endedAt: null,
          // Messages have only a final state, no intermediate state: having a result means completed, no result means interrupted.
          status:
            item.toolResult === undefined
              ? "aborted"
              : item.toolResult.isError
                ? "error"
                : "complete",
          isError: item.toolResult?.isError === true,
          subagentRunIds: [],
        }));
        const usage = normalizeUsage(round.meta?.usage);
        steps.push({
          turn: entry.turn,
          step: round.round,
          startedAt: null,
          firstTokenAt: null,
          endedAt: null,
          status: "complete",
          ...(round.meta?.provider === undefined ? {} : { provider: round.meta.provider }),
          ...(round.meta?.model === undefined ? {} : { model: round.meta.model }),
          ...(round.meta?.api === undefined ? {} : { api: round.meta.api }),
          ...(round.meta?.stopReason === undefined ? {} : { stopReason: round.meta.stopReason }),
          ...(usage === undefined ? {} : { usage }),
          retries: [],
          failovers: [],
          transports: [],
          tools,
        });
      }
    }

    turns.push({
      turn: entry.turn,
      startedAt: null,
      endedAt: null,
      status: "complete",
      inputs:
        entry.user === undefined
          ? []
          : [
              {
                kind: "user",
                turn: entry.turn,
                at: null,
                ...(entry.user.messageIndex === undefined
                  ? {}
                  : { messageIndex: entry.user.messageIndex }),
                ...(entry.user.messageId === undefined ? {} : { messageId: entry.user.messageId }),
                ...(entry.user.text === "" ? {} : { text: entry.user.text }),
              },
            ],
      steps,
      compactions: [],
    });
  }

  return {
    turns,
    headers: new Map(),
    standaloneCompactions: [],
    hasTiming: false,
  };
}

/**
 * Preserve pre-trajectory turns from loaded messages while using recorded events as authority for
 * every turn they cover. This matters when an old conversation receives new turns after upgrade.
 */
export function mergeTrajectoryLedgerWithMessages(
  recorded: TrajectoryLedger,
  messages: readonly UiMessage[],
): TrajectoryLedger {
  const derived = deriveLedgerFromMessages(messages, recorded);
  const recordedTurns = new Map(recorded.turns.map((turn) => [turn.turn, turn]));
  for (const turn of derived.turns) {
    if (!recordedTurns.has(turn.turn)) recordedTurns.set(turn.turn, turn);
  }
  return {
    ...recorded,
    turns: [...recordedTurns.values()].sort((left, right) => left.turn - right.turn),
  };
}
