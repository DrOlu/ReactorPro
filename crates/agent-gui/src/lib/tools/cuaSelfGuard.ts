import { invoke } from "@tauri-apps/api/core";

/**
 * Removes ReactorPro itself from cua-driver's view and range of operation.
 *
 * Why it is needed: cua-driver sees the entire desktop, including ReactorPro's own windows.
 * Letting the model operate the host UI is a dangerous self-reference — it could dismiss its
 * own approval dialog (effectively bypassing approval), change its own permission policy, or
 * simply shut itself down. Upstream has no "exclude an app" mechanism (the capability manifest
 * is a tool/resource allowlist, and under proxy mode it is managed by the CuaDriver.app daemon),
 * so this gate can only be opened on the host side.
 *
 * All four paths must be blocked:
 * - **Addressing by pid / window_id**: recursively scan the whole argument payload. Upstream
 *   currently wraps the target in a `target` object
 *   (`{"target":{"kind":"window","pid":…,"window_id":…}}`), so checking only top-level fields
 *   is as good as no check — an implementation that only recognized flat arguments could be
 *   bypassed outright by the official form.
 * - **Addressing by screen coordinates**: coordinates cannot be traced back to an owner, so
 *   compare them against the host windows' actual rectangles instead. The model can perfectly
 *   well measure the position of an "Allow" button from a full-screen screenshot and send it
 *   as `{"target":{"kind":"desktop"},"x":…,"y":…}`. The window rectangles are re-fetched before
 *   every call (see `loadSelfWindowRects`), so the check still holds after a window moves.
 * - **Targetless keyboard input**: `press_key` / `hotkey` / `type_text` do not require
 *   pid / window_id / coordinates under the desktop scope and deliver input to the
 *   **frontmost application** — neither gate above covers them. `{"scope":"desktop","key":"return"}`
 *   while the host is frontmost is equivalent to dismissing the approval dialog, and
 *   `{"keys":["cmd","q"]}` is equivalent to quitting the app. So such calls must query the
 *   current frontmost application once: reject if the frontmost is the host; **reject when it
 *   cannot be determined too** (fail-closed, explicit targets with pid / window_id are
 *   unaffected, so no capability is lost).
 * - **Output**: strip host records from the results of `list_windows` / `list_apps` /
 *   `get_accessibility_tree`. Otherwise the model's next step would be knocking with those ids,
 *   needlessly running into the input interception. Official MCP text blocks often carry a
 *   summary prefix like `✅ …`, so we cannot require the whole block to be pure JSON — the JSON
 *   fragment must first be sliced out of the text.
 *
 * Only cua-driver knows the mapping between window_id and pid, so the host's window_id is
 * learned incidentally during output filtering (see `learnedSelfWindowIds`). Before the first
 * window enumeration the model would not have any window_id anyway, so not being able to block
 * it also offers nothing to exploit.
 *
 * Residual surface (known and accepted): the host window can still be **seen** in full-screen
 * screenshots — an image cannot be structurally stripped the way JSON can. But seeing is not
 * operating: coordinate operations are blocked by rectangle comparison, and targetless keyboard
 * input is blocked by the frontmost check, so this is an information-visibility issue, not an
 * approval bypass.
 *
 * Known limit: there is a very short TOCTOU window between the frontmost check and the driver's
 * actual delivery (the check passes, then focus happens to switch to the host before the key
 * lands). A host-side guard cannot make those two steps atomic; the check is done at the moment
 * the call is issued, which is as tight as possible.
 *
 * Setting `cuaAllowSelfTargeting` to true disables this gate entirely — needed when using
 * ReactorPro to automate-test ReactorPro. Off by default.
 */

const SELF_TARGET_REFUSAL =
  "This target is a ReactorPro window and has been rejected: letting the model operate the host UI " +
  "could bypass tool approval, rewrite permission settings, or shut the app down directly. " +
  "Please operate on a different application instead. (If you really need to automate ReactorPro " +
  "itself, enable \"Allow operating ReactorPro itself\" in \"Settings → CUA\".)";

const SELF_REGION_REFUSAL =
  "These coordinates fall inside a ReactorPro window and have been rejected: operating the host " +
  "UI by screen coordinates with the desktop as the target could likewise dismiss the approval " +
  "dialog or rewrite permission settings. Please operate on another application's window instead. " +
  "(If you really need to automate ReactorPro itself, enable \"Allow operating ReactorPro itself\" " +
  "in \"Settings → CUA\".)";

const SELF_FOREGROUND_REFUSAL =
  "ReactorPro is currently the frontmost application, so this desktop keyboard input with no " +
  "explicit target would land directly on the host UI (it could dismiss the approval dialog or " +
  "quit the app with a shortcut), and has been rejected. Please focus the target application " +
  "first (for example, click its window), or switch to an explicit window target with " +
  "pid / window_id. (If you really need to automate ReactorPro itself, enable \"Allow operating " +
  "ReactorPro itself\" in \"Settings → CUA\".)";

const SELF_FOREGROUND_UNKNOWN_REFUSAL =
  "The current frontmost application cannot be confirmed, so this desktop keyboard input with " +
  "no explicit target has been rejected: we cannot confirm it will not land on ReactorPro itself. " +
  "Please switch to an explicit window target with pid / window_id, or retry later.";

type SelfIdentity = { pid: number };

/** The host window's rectangle in screen coordinates, in the same units as cua-driver desktop coordinates. */
export type SelfWindowRect = { x: number; y: number; width: number; height: number };

/**
 * Cache for the host pid.
 *
 * **Only successful results are cached.** It used to be
 * `promise ??= invoke(...).catch(() => null)` — which cached a transient IPC failure as a
 * permanent null, after which every conversation turn's guard returned null directly (the
 * whole gate shut), with no indication to the user. A cache on the security side must not
 * remember failures.
 */
let selfPidPromise: Promise<number | null> | null = null;

async function loadSelfPid(): Promise<number | null> {
  if (selfPidPromise) {
    const cached = await selfPidPromise;
    if (cached !== null) return cached;
  }
  const attempt = invoke<SelfIdentity>("cua_driver_self_identity")
    .then((identity) => readNumber(identity?.pid))
    .catch(() => null);
  selfPidPromise = attempt;
  return attempt;
}

/**
 * Short-lived cache for window rectangles.
 *
 * They cannot be fetched once like the pid — windows get dragged and resized. But they may
 * be asked for repeatedly within a single tool call, and GUI operations themselves are on the
 * order of seconds, so reuse within a few hundred milliseconds does not distort the decision
 * while avoiding an IPC round trip on every call.
 */
const SELF_RECTS_TTL_MS = 400;

let selfRectsCache: { at: number; rects: SelfWindowRect[] } | null = null;

async function loadSelfWindowRects(): Promise<SelfWindowRect[]> {
  if (selfRectsCache && Date.now() - selfRectsCache.at <= SELF_RECTS_TTL_MS) {
    return selfRectsCache.rects;
  }
  const rects = await invoke<SelfWindowRect[]>("cua_driver_self_windows").catch(() => []);
  selfRectsCache = { at: Date.now(), rects: Array.isArray(rects) ? rects : [] };
  return selfRectsCache.rects;
}

/**
 * The pid of the current frontmost application. **Not cached**: focus changes on the order of
 * hundreds of milliseconds and keyboard calls are not high-frequency, so an IPC round trip per
 * decision buys a judgment always grounded in the present facts. Returns null when unavailable,
 * and the caller handles it fail-closed.
 */
async function loadFrontmostPid(): Promise<number | null> {
  try {
    return readNumber(await invoke<number>("cua_driver_frontmost_pid"));
  } catch {
    return null;
  }
}

/** Host window_id learned during output filtering. Process-level cache, no persistence needed. */
const learnedSelfWindowIds = new Set<number>();

/**
 * Recursion depth limit. The arguments are MCP JSON parameters, normally at most two or three
 * levels deep; even with ample margin it is capped, so a malformed (or deliberately constructed)
 * deep structure cannot drag the scan down.
 *
 * Exceeding the limit is treated as a **hit** (see `refuseSelfTargetedCall`). Allowing a scan
 * that cannot complete would be handing out a ready-made bypass: just bury the target at level 13.
 * Better to reject a request too malformed to look like a real call.
 */
const MAX_SCAN_DEPTH = 12;

/** Explanation given to the model when rejecting an argument too deep to finish scanning. */
const SELF_SCAN_DEPTH_REFUSAL =
  "The call arguments' nesting depth exceeds the security-check limit and has been rejected: " +
  "we cannot confirm whether it targets ReactorPro itself. Please retry with flatter arguments.";

/** Field names used by various conventions to denote a process id. */
const PID_KEYS = ["pid", "process_id", "processId", "owner_pid", "ownerPid"] as const;

/** Field names used by various conventions to denote a window id. */
const WINDOW_ID_KEYS = ["window_id", "windowId"] as const;

/**
 * The `target.kind` values that denote "some window / app / element".
 *
 * Enumerating only this side and treating everything else (`desktop` / `screen` / `display` /
 * no target at all) as screen-absolute coordinates is a deliberate fail-closed choice: when
 * upstream adds a new desktop-level target, it will not slip through merely because it was not
 * registered.
 */
const SCOPED_TARGET_KINDS = new Set(["window", "app", "application", "element"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type ScanResult = "hit" | "truncated" | "clear";

/**
 * Depth-first traversal, calling `visit` on each object node.
 *
 * Returns `hit` (visit matched), `truncated` (no match, but a branch is too deep to finish
 * scanning), or `clear` (fully scanned with no match). Three states rather than a boolean
 * because the caller must distinguish "confirmed safe" from "could not confirm" — in a
 * security decision those two must not both be treated as allow.
 */
function scanRecords(
  node: unknown,
  visit: (record: Record<string, unknown>) => boolean,
  depth = 0,
): ScanResult {
  if (depth > MAX_SCAN_DEPTH) return "truncated";

  const children = Array.isArray(node) ? node : null;
  if (!children) {
    const record = asRecord(node);
    if (!record) return "clear";
    if (visit(record)) return "hit";
    return scanChildren(Object.values(record), visit, depth);
  }
  return scanChildren(children, visit, depth);
}

function scanChildren(
  values: unknown[],
  visit: (record: Record<string, unknown>) => boolean,
  depth: number,
): ScanResult {
  let truncated = false;
  for (const value of values) {
    const result = scanRecords(value, visit, depth + 1);
    if (result === "hit") return "hit";
    if (result === "truncated") truncated = true;
  }
  return truncated ? "truncated" : "clear";
}

/**
 * Argument check: self-targeted calls addressed by pid / window_id. Returns the rejection
 * reason, or null to allow.
 *
 * The whole argument tree must be scanned, not just the top level: upstream wraps the target
 * in a `target` object, so looking only at top-level `pid` / `window_id` would let the official
 * form pass through unchanged. An incomplete scan (exceeding the depth limit) is likewise rejected.
 */
export function refuseSelfTargetedCall(
  args: Record<string, unknown> | undefined,
  selfPid: number | null,
): string | null {
  if (!args) return null;

  const result = scanRecords(args, (record) => {
    if (selfPid !== null && PID_KEYS.some((key) => readNumber(record[key]) === selfPid)) {
      return true;
    }
    return WINDOW_ID_KEYS.some((key) => {
      const windowId = readNumber(record[key]);
      return windowId !== null && learnedSelfWindowIds.has(windowId);
    });
  });

  if (result === "hit") return SELF_TARGET_REFUSAL;
  if (result === "truncated") return SELF_SCAN_DEPTH_REFUSAL;
  return null;
}

/**
 * Whether this call targets the "whole desktop" and carries screen coordinates.
 *
 * Returns false when it explicitly points at a window / element: those coordinates are
 * relative to that window, and whether the window itself is the host has already been decided
 * by `refuseSelfTargetedCall`, so comparing screen coordinates again here would only cause
 * false positives. A flat form with no target field is treated as desktop — coordinates in the
 * early API were screen-absolute.
 */
export function usesDesktopScreenCoordinates(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;

  let scoped = false;
  scanRecords(args, (record) => {
    const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : null;
    if (kind && SCOPED_TARGET_KINDS.has(kind)) {
      scoped = true;
      return true;
    }
    return false;
  });
  if (scoped) return false;

  return collectScreenPoints(args).length > 0;
}

/** Collect all points of the form `{x, y}` in the arguments. */
function collectScreenPoints(args: Record<string, unknown>): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  scanRecords(args, (record) => {
    const x = readNumber(record.x);
    const y = readNumber(record.y);
    if (x !== null && y !== null) points.push({ x, y });
    return false;
  });
  return points;
}

function pointInRect(point: { x: number; y: number }, rect: SelfWindowRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Argument check: calls targeting the desktop whose coordinates fall inside a host window rectangle.
 *
 * Only meaningful when `usesDesktopScreenCoordinates` is true; when the rectangle list is empty
 * (unavailable, or all host windows invisible) it always allows — better not to block than to
 * harm legitimate targets.
 */
export function refuseSelfRegionCall(
  args: Record<string, unknown> | undefined,
  rects: SelfWindowRect[],
): string | null {
  if (!args || rects.length === 0) return null;
  const points = collectScreenPoints(args);
  const hit = points.some((point) => rects.some((rect) => pointInRect(point, rect)));
  return hit ? SELF_REGION_REFUSAL : null;
}

/**
 * Tools whose delivery semantics are "send to the keyboard focus": under the desktop scope they
 * take effect without pid / window_id / coordinates. In the v0.22.0 contract `press_key` requires
 * only `key`, `hotkey` only `keys`, and `type_text` only `text`.
 */
const FOCUS_DELIVERY_TOOLS = new Set(["type_text", "press_key", "hotkey"]);

/**
 * Whether this call is "keyboard input with no explicit process identity" — i.e. the kind whose
 * delivery target is determined by the **current focus** rather than by the arguments.
 *
 * Two conditions:
 * - It is a keyboard / text injection call. Besides recognizing it by tool name (the three
 *   upstream currently has), fall back on argument shape: any call carrying a string `key` or a
 *   string array `keys` counts — so upstream renaming or adding a tool like `hold_key` does not
 *   slip through. The `text` field deliberately does **not** participate in the shape fallback:
 *   `clipboard_write` / lookup tools also carry text, their delivery semantics are unrelated to
 *   focus, and hitting them would only make the guard look unpredictable; `type_text` is already
 *   covered by its tool name.
 * - The arguments contain **no** pid / window_id at all. By contract, calls carrying an identity
 *   (including the desktop scope + pid background-delivery form) deliver to that window and do
 *   not follow focus; the host's own identity has already been rejected by
 *   `refuseSelfTargetedCall` before this point, so any identity reaching here must point to
 *   another application. We deliberately ignore `target.kind`: a call with `kind: "window"` but
 *   no identity cannot address any window anyway, so treating it as focus delivery is fail-closed.
 */
export function isDesktopKeyboardCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
): boolean {
  const name = toolName.trim().toLowerCase();
  const byName = FOCUS_DELIVERY_TOOLS.has(name);
  const byShape =
    !byName &&
    args !== undefined &&
    scanRecords(args, (record) => {
      if (typeof record.key === "string") return true;
      return Array.isArray(record.keys) && record.keys.some((k) => typeof k === "string");
    }) === "hit";
  if (!byName && !byShape) return false;

  const identified =
    args !== undefined &&
    scanRecords(args, (record) =>
      [...PID_KEYS, ...WINDOW_ID_KEYS].some((key) => readNumber(record[key]) !== null),
    ) === "hit";
  return !identified;
}

/**
 * Argument check: keyboard input with no explicit target, rejected when the host is frontmost
 * (or the frontmost is unknown).
 *
 * It **also rejects** when `frontmostPid` is null (query failed / platform unsupported): we must
 * not follow the window-rectangle approach of "allow when unavailable" — keyboard input has no
 * ambiguity about "hitting the real target below the rectangle", and the cost of allowing it is
 * that the model can type arbitrary keys at the host. The rejection message guides the model to
 * switch to an explicit target with pid / window_id, so no capability is lost.
 */
export function refuseDesktopKeyboardCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
  selfPid: number,
  frontmostPid: number | null,
): string | null {
  if (!isDesktopKeyboardCall(toolName, args)) return null;
  if (frontmostPid === null) return SELF_FOREGROUND_UNKNOWN_REFUSAL;
  return frontmostPid === selfPid ? SELF_FOREGROUND_REFUSAL : null;
}

/**
 * Find the next structurally complete JSON segment starting from `from`, returning its range in
 * the original text.
 *
 * An official MCP text block is usually "a one-line `✅ Windows listed` summary + a JSON segment",
 * so requiring the whole block after trim to start with `{` / `[` would let such results slip past
 * filtering entirely. The scan must recognize string literals and escapes, or a string containing
 * braces inside the payload would miscount the pairing.
 */
function findJsonSpan(text: string, from = 0): { start: number; end: number } | null {
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (char !== "{" && char !== "[") continue;

    const closing = char === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j++) {
      const current = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') inString = false;
        continue;
      }
      if (current === '"') {
        inString = true;
        continue;
      }
      if (current === char) depth++;
      else if (current === closing) {
        depth--;
        if (depth === 0) return { start: i, end: j + 1 };
      }
    }
    // The bracket starting at this position is unbalanced; searching further would only land in
    // the same unclosed text.
    return null;
  }
  return null;
}

/**
 * Strip host records from a result text, incidentally recording the host's window_id.
 *
 * Returns it unchanged when the text contains no parseable JSON (screenshot captions, plain-text
 * reports): such payloads have no addressable records to strip. The summary text before and after
 * the JSON segment is preserved as-is — it is context for the model, and rewriting it is unnecessary.
 */
export function stripSelfFromJsonText(text: string, selfPid: number | null): string {
  if (selfPid === null) return text;

  // There may be more than one JSON segment in the text (merged results of multiple calls,
  // summary + details). Handling only the first would let the later ones reach the model as-is,
  // so scan all the way to the end, segment by segment.
  let out = "";
  let cursor = 0;
  let changedAny = false;

  for (let span = findJsonSpan(text, cursor); span; span = findJsonSpan(text, cursor)) {
    const raw = text.slice(span.start, span.end);
    const stripped = stripSelfFromJsonValue(raw, selfPid);
    out += text.slice(cursor, span.start) + (stripped ?? raw);
    if (stripped !== null) changedAny = true;
    cursor = span.end;
  }

  // If nothing matched, return the original text without re-joining — avoid needlessly rewriting
  // the original format the model sees.
  if (!changedAny) return text;
  return out + text.slice(cursor);
}

/**
 * Strip host records from one JSON text segment. Returns the new serialized result when changed,
 * or null when unchanged or parsing fails (the caller then keeps the original text).
 */
function stripSelfFromJsonValue(raw: string, selfPid: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  let changed = false;

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const kept = node.filter((entry) => {
        const record = asRecord(entry);
        if (!record) return true;
        if (!PID_KEYS.some((key) => readNumber(record[key]) === selfPid)) return true;
        for (const key of WINDOW_ID_KEYS) {
          const windowId = readNumber(record[key]);
          if (windowId !== null) learnedSelfWindowIds.add(windowId);
        }
        changed = true;
        return false;
      });
      return kept.map(visit);
    }
    const record = asRecord(node);
    if (!record) return node;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) next[key] = visit(value);
    return next;
  };

  const result = visit(parsed);
  return changed ? JSON.stringify(result) : null;
}

/** Reset the process-level caches (for tests). */
export function resetCuaSelfGuardCaches() {
  selfPidPromise = null;
  selfRectsCache = null;
  learnedSelfWindowIds.clear();
}

export type CuaSelfGuard = {
  /** Pre-call check; returns the rejection reason or null. `toolName` is the raw MCP-side tool name. */
  refuse: (toolName: string, args: Record<string, unknown> | undefined) => Promise<string | null>;
  /** Result-text filtering. */
  strip: (text: string) => string;
};

/**
 * Obtain the currently effective guard. Returns null when `allowSelfTargeting` is true, or when
 * the host identity cannot be found (non-desktop) — the caller then skips this layer entirely.
 */
export async function resolveCuaSelfGuard(
  allowSelfTargeting: boolean,
): Promise<CuaSelfGuard | null> {
  if (allowSelfTargeting) return null;
  const selfPid = await loadSelfPid();
  if (selfPid === null) return null;
  return {
    refuse: async (toolName, args) => {
      const targeted = refuseSelfTargetedCall(args, selfPid);
      if (targeted) return targeted;
      // Keyboard input with no explicit target follows focus, so reject when the frontmost is
      // the host (or unknown). The frontmost query costs an IPC round trip, so only fetch it
      // when this call really belongs to that class.
      if (isDesktopKeyboardCall(toolName, args)) {
        const keyboard = refuseDesktopKeyboardCall(
          toolName,
          args,
          selfPid,
          await loadFrontmostPid(),
        );
        if (keyboard) return keyboard;
      }
      // Same for window rectangles: only fetch them when this call actually carries desktop coordinates.
      if (!usesDesktopScreenCoordinates(args)) return null;
      return refuseSelfRegionCall(args, await loadSelfWindowRects());
    },
    strip: (text) => stripSelfFromJsonText(text, selfPid),
  };
}

export const CUA_SELF_TARGET_REFUSAL = SELF_TARGET_REFUSAL;
export const CUA_SELF_REGION_REFUSAL = SELF_REGION_REFUSAL;
export const CUA_SELF_SCAN_DEPTH_REFUSAL = SELF_SCAN_DEPTH_REFUSAL;
export const CUA_SELF_FOREGROUND_REFUSAL = SELF_FOREGROUND_REFUSAL;
export const CUA_SELF_FOREGROUND_UNKNOWN_REFUSAL = SELF_FOREGROUND_UNKNOWN_REFUSAL;
