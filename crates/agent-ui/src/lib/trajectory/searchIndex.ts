/**
 * Incremental full-text index for the ledger.
 *
 * Resident per conversation: a record's index entry is rebuilt only when its source fields
 * actually change, since recomputing the entire conversation repeatedly during streaming would
 * overwhelm the main thread.
 */

import { flattenTrajectoryRecords } from "./layout";
import type { TrajectoryRecord, TrajectoryTurnModel } from "./types";

type SearchEntry = {
  readonly sources: readonly string[];
  readonly text: string;
};

function sameSources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordSources(
  turn: number | null,
  group: string,
  record: TrajectoryRecord,
): readonly string[] {
  const blocks = [...(record.sourceBlocks ?? []), ...(record.outputBlocks ?? [])];
  return [
    turn === null ? "between turns" : `turn ${turn}`,
    group,
    record.kind,
    record.kind === "message" ? "assistant" : "",
    record.text,
    record.result ?? "",
    record.inputDetail ?? "",
    record.outputDetail ?? "",
    record.schemaDetail ?? "",
    record.callId ?? "",
    record.toolName ?? "",
    record.provider ?? "",
    record.model ?? "",
    record.stopReason ?? "",
    record.error ?? "",
    ...blocks.flatMap((block) => [
      block.type,
      block.content,
      block.callId ?? "",
      block.toolName ?? "",
      block.imageAlt ?? "",
    ]),
  ];
}

/** View-level index instance; created and destroyed with the conversation view. */
export class TrajectorySearchIndex {
  private readonly entries = new Map<string, SearchEntry>();
  private source: readonly (readonly TrajectoryTurnModel[])[] | undefined;

  /**
   * Synchronizes a batch of layout slices (completed layouts + streaming layout).
   *
   * @param layouts - layout slices of the same view.
   * @returns whether the index version changed.
   */
  update(layouts: readonly (readonly TrajectoryTurnModel[])[]): boolean {
    if (this.source === layouts) return false;
    this.source = layouts;
    const seen = new Set<string>();
    for (const turns of layouts) {
      for (const turn of turns) {
        for (const group of turn.groups) {
          for (const record of group.records) {
            if (record.requestOnly === true) continue;
            const sources = recordSources(turn.turn, group.title, record);
            const previous = this.entries.get(record.recordId);
            const entry =
              previous !== undefined && sameSources(previous.sources, sources)
                ? previous
                : { sources, text: sources.join("\n").toLocaleLowerCase() };
            this.entries.set(record.recordId, entry);
            seen.add(record.recordId);
          }
        }
      }
    }
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) this.entries.delete(id);
    }
    return true;
  }

  /**
   * Matches a query against the latest index version.
   *
   * @param query - space-separated case-insensitive terms; all must hit to count as a match.
   * @returns the identities of matching records; an empty query returns null meaning "no filtering".
   */
  search(query: string): ReadonlySet<string> | null {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    const matches = new Set<string>();
    for (const [id, entry] of this.entries) {
      if (terms.every((term) => entry.text.includes(term))) matches.add(id);
    }
    return matches;
  }
}

/**
 * Converts matching record identities into record indexes, shared by timeline highlighting and
 * ledger filtering.
 *
 * @param layouts - layout slices from the same source as the index.
 * @param matched - the return value of `search`.
 * @returns the set of matching indexes; returns null when `matched` is null as well.
 */
export function trajectorySearchMatchIndexes(
  layouts: readonly (readonly TrajectoryTurnModel[])[],
  matched: ReadonlySet<string> | null,
): ReadonlySet<number> | null {
  if (matched === null) return null;
  const indexes = new Set<number>();
  for (const turns of layouts) {
    for (const record of flattenTrajectoryRecords(turns)) {
      if (matched.has(record.recordId)) indexes.add(record.index);
    }
  }
  return indexes;
}
