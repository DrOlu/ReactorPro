/** Floor navigation entry: a single message sent by the user. */
export type FloorEntry = {
  /** Virtual list row key (matching the row model's user-row key), used for jump positioning. */
  rowKey: string;
  /** Stable message id (persisted in SQLite, unchanged across restarts), used for favorites. */
  messageId: string;
  /** Leading characters of the user message, whitespace collapsed then truncated. */
  preview: string;
  /** Plain-text assistant summary immediately following that user message; tool calls and thinking content do not enter the hover preview. */
  responsePreview: string | null;
};

/**
 * Minimum shape of a floor source row: both the desktop render timeline
 * (RenderTimelineItem) and the WebUI transcript row (TranscriptRow) satisfy it,
 * so both sides can reuse this module directly.
 */
export type FloorSourceItem = {
  kind: string;
  key: string;
  text?: string;
  messageRef?: { messageId: string };
  rounds?: readonly {
    blocks: readonly {
      kind: string;
      text?: string;
    }[];
  }[];
};

const PREVIEW_MAX_CHARS = 48;
const RESPONSE_PREVIEW_MAX_CHARS = 180;

function buildTruncatedPreview(text: string, maxChars: number): string | null {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const chars = Array.from(collapsed);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : collapsed;
}

export function buildFloorPreview(text: string): string {
  return buildTruncatedPreview(text, PREVIEW_MAX_CHARS) ?? "…";
}

function buildFloorResponsePreview(item: FloorSourceItem): string | null {
  const text = (item.rounds ?? [])
    .flatMap((round) => round.blocks)
    .filter((block) => block.kind === "text")
    .map((block) => block.text ?? "")
    .join(" ");
  return buildTruncatedPreview(text, RESPONSE_PREVIEW_MAX_CHARS);
}

/**
 * Derives the floor list from the rendered row list. Keep only entries with
 * kind === "user" — tool calls/results are folded into assistant groups and
 * system prompts are not on the timeline, so naturally only user messages remain.
 */
export function buildFloorEntries(items: readonly FloorSourceItem[]): FloorEntry[] {
  const entries: FloorEntry[] = [];
  let pendingEntryIndex = -1;
  for (const item of items) {
    if (item.kind === "user") {
      entries.push({
        rowKey: item.key,
        messageId: item.messageRef?.messageId ?? item.key,
        preview: buildFloorPreview(item.text ?? ""),
        responsePreview: null,
      });
      pendingEntryIndex = entries.length - 1;
      continue;
    }
    if (item.kind !== "assistant" || pendingEntryIndex < 0) continue;
    const responsePreview = buildFloorResponsePreview(item);
    if (responsePreview) {
      entries[pendingEntryIndex] = {
        ...entries[pendingEntryIndex],
        responsePreview,
      };
    }
    pendingEntryIndex = -1;
  }
  return entries;
}

/**
 * Uniform sampling of collapsed-state tick marks: when the floor count exceeds
 * the cap, take maxMarkers evenly spaced entries (including the first and last),
 * always retaining mustKeep (favorited floors). Sampling uses "evenly divided
 * indexes" rather than a fixed step, so as the floor count crosses the cap the
 * marker count transitions continuously (n→n+1 never causes a sharp drop in
 * count).
 *
 * Note: the current floor does not participate in mustKeep — forcibly
 * inserting/removing it during scroll would make the entire marker column
 * jitter; callers should instead use resolveNearestSampledRowKey to land the
 * highlight on the nearest already-sampled marker.
 */
export function sampleFloorEntries(
  floors: FloorEntry[],
  maxMarkers: number,
  mustKeepRowKeys: ReadonlySet<string>,
): FloorEntry[] {
  if (maxMarkers <= 0) return [];
  if (floors.length <= maxMarkers) return floors;
  const picked = new Set<number>();
  const lastIndex = floors.length - 1;
  for (let i = 0; i < maxMarkers; i++) {
    picked.add(Math.round((i * lastIndex) / (maxMarkers - 1 || 1)));
  }
  return floors.filter((floor, index) => picked.has(index) || mustKeepRowKeys.has(floor.rowKey));
}

/**
 * Finds the sampled marker nearest to the current floor (by distance in the
 * original floor order), so the highlight always has a landing spot without
 * changing the sampled set itself.
 */
export function resolveNearestSampledRowKey(
  floors: FloorEntry[],
  sampled: FloorEntry[],
  activeRowKey: string | null,
): string | null {
  if (!activeRowKey || sampled.length === 0) return null;
  if (sampled.some((floor) => floor.rowKey === activeRowKey)) return activeRowKey;
  const activeIndex = floors.findIndex((floor) => floor.rowKey === activeRowKey);
  if (activeIndex === -1) return null;
  let nearest: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const marker of sampled) {
    const markerIndex = floors.findIndex((floor) => floor.rowKey === marker.rowKey);
    if (markerIndex === -1) continue;
    const distance = Math.abs(markerIndex - activeIndex);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = marker.rowKey;
    }
  }
  return nearest;
}
