# Composer Prompt Clarification · Plan 1: agent-ui Shared Components + Desktop GUI Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a "Clarify" button next to the chat composer: a small LLM conversation keeps asking the user follow-up questions to clarify requirements, then produces an optimized prompt and puts it back into the composer (replacing only the text segment; attachments and mentions are preserved).

**Architecture:** agent-ui adds a new `components/chat/clarify/` module (types + protocol parsing + state machine + panel component); `ChatComposerBar` injects the LLM executor via two new optional props `runClarifyTurn` / `clarifyContext`, and renders no button when absent; the desktop host (the composer binding in `ChatPage.tsx`) wraps the existing text-only `streamAssistantMessage` call. Web (agent-gateway) wiring is a separate Plan 2 and is out of scope here.

**Tech Stack:** TypeScript / React (no new dependencies), `@earendil-works/pi-ai` Context types, `node:test` (via the TS loader in `crates/agent-gui/test/helpers/load-ts-module.mjs`).

**Spec:** `docs/superpowers/specs/2026-08-30-composer-clarify-design.md`

## Global Constraints

- Final-draft protocol markers: `[CLARIFY_QUESTION]` / `[CLARIFY_FINAL]`, placed on a single line at the start of the reply (spec "final-draft protocol" section).
- At most 5 rounds of questions; from round 6 the frontend automatically injects the final-draft instruction (spec "error handling" table).
- Applying the result to the composer: replace only draft segments with `type: "text"`, keeping all other segments and pendingUploadedFiles unchanged (spec "final draft into composer").
- i18n: all UI copy goes through `chat.clarify.*` keys, in both `zhCNCommon.ts` and `enUSCommon.ts` (spec "i18n").
- Clarify sessions are not persisted and do not enter conversation history; closing the panel discards them (spec "error handling" table).
- The send button is disabled while the panel is open (guard in `handleComposerSend`); the composer body itself remains editable.
- Tests use `node:test` + `createTsModuleLoader`, placed under `crates/agent-gui/test/chat/`, with no new test framework (spec "testing").
- Code comment style follows the surroundings: Chinese comments explaining "why".

## Existing Code Facts (required reading for implementers)

- `MentionComposerHandle` (`crates/agent-ui/src/components/chat/MentionComposerModel.ts:104`): `getDraft()` returns `MentionComposerDraft` (`segments: MentionComposerDraftSegment[]`, segment discriminant field `type: "text" | "fileMention" | ...`); `setDraft(draft)` clears the editor and rebuilds the DOM segment by segment from `draft.segments` (`MentionComposer.tsx:806`), and stale derived fields (text/mentions arrays) are ignored; `focus()`.
- `streamAssistantMessage` (`crates/agent-gui/src/lib/providers/runtime/textOnlyRuntime.ts:183`): parameters `providerId / model / runtime / context {systemPrompt, messages:[{role,content,timestamp}]} / signal / onTextDelta / cacheRetention / nativeWebSearch`; returns the assistant message, converted to plain text with `assistantMessageToText` (`crates/agent-gui/src/lib/providers/llm.ts`). See `conversationTitleJob.ts` for the calling pattern.
- Model resolution: `resolveEffectiveChatModelSelection({ settings, conversationSelectedModel })` (`crates/agent-gui/src/pages/chat/runtime/modelSelection.ts:28`) returns `{ provider, providerId, model }`; construct the runtime with `createProviderRuntimeConfig(provider, model, runtimeControls)` (`crates/agent-gui/src/lib/providers/llm.ts`).
- `ChatComposerBar` (`crates/agent-ui/src/pages/chat/ChatComposerBar.tsx:313`): the bottom toolbar row is at `ChatComposerBar.tsx:1010`: `<div className="relative flex items-center justify-between gap-2 px-3 pb-2 pt-1">`, with the left cluster `<div className="flex min-w-0 flex-1 items-center gap-1">` (starting at line 1011: plus menu → plan mode pill → STT button). Panels (queue/approval bar) are inserted outside the `glassCardRef` card (starting at line 887) and above it — `approvalBar` renders at line 885. The editor container is at line 980.
- GUI host composer binding: the `composer: {...}` object at `crates/agent-gui/src/pages/ChatPage.tsx:2988`; `ConversationComposerBindings` (`ConversationPaneHostEnvironment.tsx:25`) is `Omit<ChatComposerBarProps, ...>`, so new props pass through automatically without modifying that file.
- Icons: `crates/agent-ui/src/components/IconSet.tsx` already exports `WandSparkles` (line 621), `Loader2`, etc.; direct imports from lucide `~icons` also work.
- i18n: `crates/agent-ui/src/i18n/translations/zhCNCommon.ts` / `enUSCommon.ts` flat keys (e.g. `"chat.queue.title": "Waiting queue {count}"`).
- Tests: `.mjs` files under `crates/agent-gui/test/`, `import test from "node:test"` + `createTsModuleLoader` (see the top of `test/providers/text-only-failover.test.mjs`); run with `cd crates/agent-gui && npm test` (`scripts/run-node-tests.mjs test`).
- Type checking: `cd crates/agent-gui && npx tsc --noEmit` (when agent-ui has no independent tsconfig reference chain, use the actual command per repo state; default to the GUI-side tsc).

---

### Task 1: clarifyTypes + clarifyProtocol (marker parsing + system prompt)

**Files:**
- Create: `crates/agent-ui/src/components/chat/clarify/clarifyTypes.ts`
- Create: `crates/agent-ui/src/components/chat/clarify/clarifyProtocol.ts`
- Test: `crates/agent-gui/test/chat/clarify-protocol.test.mjs`

**Interfaces:**
- Consumes: none (first task).
- Produces (exact signatures that subsequent tasks depend on):
  - `type ClarifyMessage = { role: "user" | "assistant" | "system"; content: string }`
  - `type ClarifyContext = { workdir: string; gitBranch?: string }`
  - `type RunClarifyTurn = (messages: ClarifyMessage[], signal: AbortSignal, onTextDelta?: (delta: string) => void) => Promise<string>` (returns the full reply text)
  - `const CLARIFY_QUESTION_MARKER = "[CLARIFY_QUESTION]"`; `const CLARIFY_FINAL_MARKER = "[CLARIFY_FINAL]"`; `const CLARIFY_MAX_QUESTIONS = 5`
  - `parseClarifyTurn(raw: string): { kind: "question" | "final"; text: string }`
  - `stripLeadingMarker(partial: string): string` (for streaming display)
  - `buildClarifySystemPrompt(context?: ClarifyContext): string`
  - `buildForceFinalInstruction(): string`
  - `buildClarifyMessages(sessionMessages: ClarifyMessage[], context?: ClarifyContext): ClarifyMessage[]` (prepends a system message)

- [ ] **Step 1: Write the failing test**

```js
// crates/agent-gui/test/chat/clarify-protocol.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);
const loader = createTsModuleLoader({ mocks: {} });
const protocol = await loader.import(
  abs("../agent-ui/src/components/chat/clarify/clarifyProtocol.ts"),
);

test("question marker parses", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_QUESTION]\nWhat feature do you want to build?");
  assert.equal(r.kind, "question");
  assert.equal(r.text, "What feature do you want to build?");
});

test("final marker parses", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_FINAL]\nOptimized prompt body");
  assert.equal(r.kind, "final");
  assert.equal(r.text, "Optimized prompt body");
});

test("no marker falls back to question", () => {
  const r = protocol.parseClarifyTurn("A plain sentence without a marker");
  assert.equal(r.kind, "question");
  assert.equal(r.text, "A plain sentence without a marker");
});

test("marker after body text still recognized", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_FINAL]\n\n  Final draft with blank lines  ");
  assert.equal(r.kind, "final");
  assert.equal(r.text, "Final draft with blank lines");
});

test("stripLeadingMarker hides complete and partial markers during streaming", () => {
  assert.equal(protocol.stripLeadingMarker("[CLARIFY_QUE"), "");
  assert.equal(protocol.stripLeadingMarker("[CLARIFY_QUESTION]\nQuestion body"), "Question body");
  assert.equal(protocol.stripLeadingMarker("plain text"), "plain text");
});

test("system prompt contains workspace context and rules", () => {
  const p = protocol.buildClarifySystemPrompt({ workdir: "/repo/x", gitBranch: "main" });
  assert.match(p, /\/repo\/x/);
  assert.match(p, /main/);
  assert.match(p, /Ask exactly ONE question per reply/);
  const bare = protocol.buildClarifySystemPrompt();
  assert.doesNotMatch(bare, /workdir/i);
});

test("buildClarifyMessages prepends system", () => {
  const msgs = protocol.buildClarifyMessages(
    [{ role: "user", content: "hi" }],
    { workdir: "/w" },
  );
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs.length, 2);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-protocol.test.mjs`
Expected: FAIL (module does not exist / import error)

- [ ] **Step 3: Implement**

```ts
// crates/agent-ui/src/components/chat/clarify/clarifyTypes.ts
/** Messages of the small clarification conversation. Isomorphic to pi-ai Context messages, but independent of the conversation runtime. */
export type ClarifyMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/** Lightweight workspace info: only feeds the path/branch, no file contents (see the design doc "context awareness"). */
export type ClarifyContext = {
  workdir: string;
  gitBranch?: string;
};

/**
 * Execute one round of clarification completion. messages include the system message; returns the full reply text (already assembled by the host).
 * onTextDelta is used for streaming into the panel; signal threads cancellation through the state machine.
 */
export type RunClarifyTurn = (
  messages: ClarifyMessage[],
  signal: AbortSignal,
  onTextDelta?: (delta: string) => void,
) => Promise<string>;
```

```ts
// crates/agent-ui/src/components/chat/clarify/clarifyProtocol.ts
import type { ClarifyContext, ClarifyMessage } from "./clarifyTypes";

export const CLARIFY_QUESTION_MARKER = "[CLARIFY_QUESTION]";
export const CLARIFY_FINAL_MARKER = "[CLARIFY_FINAL]";
/** After the hard cap is exceeded, the frontend force-injects the final-draft instruction to prevent the LLM from asking unlimited questions (design doc "error handling"). */
export const CLARIFY_MAX_QUESTIONS = 5;

export type ParsedClarifyTurn = { kind: "question" | "final"; text: string };

/** Full reply parsing: recognizes a marker on the first line; with no marker, treats the whole thing as a question fallback. */
export function parseClarifyTurn(raw: string): ParsedClarifyTurn {
  const value = raw ?? "";
  for (const [marker, kind] of [
    [CLARIFY_FINAL_MARKER, "final"],
    [CLARIFY_QUESTION_MARKER, "question"],
  ] as const) {
    if (value.startsWith(marker)) {
      return { kind, text: value.slice(marker.length).trim() };
    }
  }
  return { kind: "question", text: value.trim() };
}

/**
 * For streaming display: strips a complete or partial marker prefix at the start. The first token of a stream
 * is often split in the middle of the marker, so the first 20 characters are hidden until the marker is
 * assembled (or confirmed not to be a marker).
 */
export function stripLeadingMarker(partial: string): string {
  const value = partial ?? "";
  if (value.startsWith(CLARIFY_FINAL_MARKER)) {
    return value.slice(CLARIFY_FINAL_MARKER.length).replace(/^\s+/, "");
  }
  if (value.startsWith(CLARIFY_QUESTION_MARKER)) {
    return value.slice(CLARIFY_QUESTION_MARKER.length).replace(/^\s+/, "");
  }
  // The marker possibility is not yet ruled out: the longest marker is 16 characters, so when the prefix is
  // shorter than 16 characters and every character matches a marker prefix, hide it first to avoid marker
  // fragments flashing in the bubble.
  const prefixWindow = value.slice(0, CLARIFY_QUESTION_MARKER.length);
  const couldBeMarker =
    CLARIFY_QUESTION_MARKER.startsWith(prefixWindow) ||
    CLARIFY_FINAL_MARKER.startsWith(prefixWindow);
  if (couldBeMarker && prefixWindow.length < CLARIFY_QUESTION_MARKER.length) {
    return "";
  }
  return value;
}

/** Adapted from the superpowers brainstorming skill: one question at a time, focused on purpose/constraints/success criteria. */
export function buildClarifySystemPrompt(context?: ClarifyContext): string {
  const workspace = context?.workdir?.trim();
  const branch = context?.gitBranch?.trim();
  const workspaceLines = workspace
    ? [`Workspace: ${workspace}${branch ? ` (branch: ${branch})` : ""}`]
    : [];
  return [
    "You are a prompt clarification assistant. The user gives a rough draft prompt; your job is to turn it into a well-specified, directly executable prompt through a short conversation.",
    "",
    "Rules:",
    `- Ask exactly ONE question per reply. Start every reply with the line "${CLARIFY_QUESTION_MARKER}".`,
    `- Prefer 2-4 concrete options the user can pick from (e.g. "A) ... B) ... C) ..."), or an open question when options would mislead.`,
    "  You may ask the user to choose \"Other\" and type freely.",
    "- Focus on: purpose (what outcome they want), constraints (tech/scope/style), and success criteria (what \"done\" looks like).",
    "- Never re-ask what the draft already makes clear. At most 5 questions total.",
    "- When the requirement is clear enough (or you have asked 5 questions), stop asking: start your reply with the line",
    `  "${CLARIFY_FINAL_MARKER}" and write the full optimized prompt. The final prompt must be a single ready-to-send message in the user's language, incorporating every answer given so far. Do not add explanations around it.`,
    "- Always reply in the language of the user's draft.",
    ...workspaceLines,
  ].join("\n");
}

/** User instruction injected on "generate now" / when the round cap is exceeded: bypass the remaining questions and produce the final draft directly. */
export function buildForceFinalInstruction(): string {
  return "Give the final optimized prompt directly (starting with " + CLARIFY_FINAL_MARKER + "), and do not ask any more questions.";
}

/** Full LLM input: system prepended + session messages. */
export function buildClarifyMessages(
  sessionMessages: ClarifyMessage[],
  context?: ClarifyContext,
): ClarifyMessage[] {
  return [{ role: "system", content: buildClarifySystemPrompt(context) }, ...sessionMessages];
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-protocol.test.mjs`
Expected: PASS (all 7 cases)

- [ ] **Step 5: Commit**

```bash
git add crates/agent-ui/src/components/chat/clarify/ crates/agent-gui/test/chat/clarify-protocol.test.mjs
git commit -m "feat(clarify): add protocol parsing and system prompt for composer clarify"
```

---

### Task 2: useClarifySession state machine

**Files:**
- Create: `crates/agent-ui/src/components/chat/clarify/useClarifySession.ts`
- Test: `crates/agent-gui/test/chat/clarify-session.test.mjs`

**Interfaces:**
- Consumes: Task 1's `ClarifyMessage`, `RunClarifyTurn`, `parseClarifyTurn`, `buildClarifyMessages`, `buildForceFinalInstruction`, `CLARIFY_MAX_QUESTIONS`.
- Produces:
  - `type ClarifySessionStatus = "idle" | "asking" | "awaitingInput" | "synthesizing" | "done" | "error"`
  - `type ClarifySessionState = { status; visibleMessages: ClarifyMessage[]; streamingText: string; error: string | null; questionCount: number; finalText: string | null }`
  - `useClarifySession(runTurn: RunClarifyTurn, clarifyContext: ClarifyContext | undefined, callbacks: { onFinal: (text: string) => void }): { state; start(draftText: string): void; submitAnswer(text: string): void; forceFinal(): void; retry(): void; close(): void }`

- [ ] **Step 1: Write the failing test**

```js
// crates/agent-gui/test/chat/clarify-session.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

// React mock: the hook only uses useState/useRef/useCallback/useEffect, all with no-op implementations.
const reactMock = {
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useEffect: (fn) => (fn(), () => {}),
};
const loader = createTsModuleLoader({
  mocks: { [abs("react")]: reactMock },
});
const mod = await loader.import(
  abs("../agent-ui/src/components/chat/clarify/useClarifySession.ts"),
);
const protocol = await loader.import(
  abs("../agent-ui/src/components/chat/clarify/clarifyProtocol.ts"),
);

const QUESTION = "[CLARIFY_QUESTION]\nWhat feature do you want to build?";
const FINAL = "[CLARIFY_FINAL]\nOptimized prompt";

test("happy path: question then final", async () => {
  const seenInputs = [];
  const runTurn = async (messages, _signal, onDelta) => {
    seenInputs.push(messages);
    if (onDelta) onDelta(QUESTION.slice(0, 10));
    return seenInputs.length === 1 ? QUESTION : FINAL;
  };
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("Help me write a script");
  assert.equal(session.getState().status, "awaitingInput");
  assert.equal(session.getState().questionCount, 1);
  await session.submitAnswer("Rename files in bulk");
  assert.equal(session.getState().status, "done");
  assert.deepEqual(finals, ["Optimized prompt"]);
  // The second round's input should contain the first round's Q&A + system
  const second = seenInputs[1];
  assert.equal(second[0].role, "system");
  assert.equal(second.filter((m) => m.role === "assistant").length, 1);
});

test("exceeding max questions force-injects final instruction", async () => {
  let calls = 0;
  const runTurn = async (messages) => {
    calls += 1;
    if (messages.at(-1).content.includes("CLARIFY_FINAL")) {
      return FINAL; // already the forced-instruction round
    }
    return QUESTION;
  };
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("draft");
  for (let i = 0; i < mod.CLARIFY_MAX_QUESTIONS; i++) {
    await session.submitAnswer(`a${i}`);
  }
  // Round 6: no further question is appended; the final draft is forced directly
  assert.equal(session.getState().status, "done");
  assert.ok(calls <= mod.CLARIFY_MAX_QUESTIONS + 1);
});

test("forceFinal injects instruction and produces final", async () => {
  const runTurn = async (messages) =>
    messages.at(-1).content.includes("CLARIFY_FINAL") ? FINAL : QUESTION;
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("d");
  await session.forceFinal();
  assert.deepEqual(finals, ["Optimized prompt"]);
});

test("error state keeps messages; retry resends", async () => {
  let fail = true;
  const runTurn = async () => {
    if (fail) throw new Error("boom");
    return FINAL;
  };
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("d");
  assert.equal(session.getState().status, "error");
  assert.match(session.getState().error, /boom/);
  fail = false;
  await session.retry();
  assert.equal(session.getState().status, "done");
  assert.deepEqual(finals, ["Optimized prompt"]);
});

test("unmarked reply falls back to question", async () => {
  const runTurn = async () => "A sentence with no marker";
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("d");
  assert.equal(session.getState().status, "awaitingInput");
  assert.equal(session.getState().visibleMessages.at(-1).content, "A sentence with no marker");
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-session.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**

```ts
// crates/agent-ui/src/components/chat/clarify/useClarifySession.ts
import { useCallback, useRef, useState } from "react";
import {
  buildClarifyMessages,
  buildForceFinalInstruction,
  CLARIFY_MAX_QUESTIONS,
  parseClarifyTurn,
} from "./clarifyProtocol";
import type { ClarifyContext, ClarifyMessage, RunClarifyTurn } from "./clarifyTypes";

export type ClarifySessionStatus =
  | "idle"
  | "asking"
  | "awaitingInput"
  | "synthesizing"
  | "done"
  | "error";

export type ClarifySessionState = {
  status: ClarifySessionStatus;
  /** Panel-visible messages (excluding system). */
  visibleMessages: ClarifyMessage[];
  /** Streaming text for the current round (unparsed; the marker prefix is stripped at render time). */
  streamingText: string;
  error: string | null;
  questionCount: number;
  finalText: string | null;
};

export const EMPTY_CLARIFY_SESSION_STATE: ClarifySessionState = {
  status: "idle",
  visibleMessages: [],
  streamingText: "",
  error: null,
  questionCount: 0,
  finalText: null,
};

export type ClarifySessionCore = {
  getState(): ClarifySessionState;
  start(draftText: string): Promise<void>;
  submitAnswer(text: string): Promise<void>;
  forceFinal(): Promise<void>;
  retry(): Promise<void>;
  close(): void;
};

/**
 * Clarify session core (framework-agnostic, so node:test can test it directly). The React hook merely mirrors
 * the core's state into useState. One start corresponds to one session; close discards all state.
 */
export function createClarifySessionCore(
  runTurn: RunClarifyTurn,
  callbacks: { onFinal: (text: string) => void },
): ClarifySessionCore {
  let state: ClarifySessionState = { ...EMPTY_CLARIFY_SESSION_STATE };
  let sessionMessages: ClarifyMessage[] = [];
  let questionCount = 0;
  let controller: AbortController | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const setState = (patch: Partial<ClarifySessionState>) => {
    state = { ...state, ...patch };
    emit();
  };

  const ask = async (extraUser?: ClarifyMessage) => {
    if (extraUser) sessionMessages.push(extraUser);
    controller = new AbortController();
    setState({ status: "asking", streamingText: "", error: null });
    try {
      const raw = await runTurn(
        buildClarifyMessages(sessionMessages),
        controller.signal,
        (delta) => setState({ streamingText: state.streamingText + delta }),
      );
      const parsed = parseClarifyTurn(raw);
      if (parsed.kind === "final") {
        setState({ status: "synthesizing", streamingText: "" });
        sessionMessages.push({ role: "assistant", content: raw });
        setState({ status: "done", finalText: parsed.text, visibleMessages: sessionMessages.slice() });
        callbacks.onFinal(parsed.text);
        return;
      }
      questionCount += 1;
      sessionMessages.push({ role: "assistant", content: raw });
      setState({
        status: "awaitingInput",
        streamingText: "",
        questionCount,
        visibleMessages: sessionMessages.slice(),
      });
    } catch (error) {
      // User cancellation goes through close() and does not produce an error state; only network/model errors are handled here.
      setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      controller = null;
    }
  };

  return {
    getState: () => state,
    start(draftText) {
      sessionMessages = [{ role: "user", content: draftText }];
      questionCount = 0;
      setState({
        ...EMPTY_CLARIFY_SESSION_STATE,
        visibleMessages: sessionMessages.slice(),
      });
      return ask();
    },
    submitAnswer(text) {
      sessionMessages.push({ role: "user", content: text });
      setState({ visibleMessages: sessionMessages.slice() });
      if (questionCount >= CLARIFY_MAX_QUESTIONS) {
        // Hard cap: no more questions are allowed; inject the final-draft instruction directly (design doc "error handling").
        return ask({ role: "user", content: buildForceFinalInstruction() });
      }
      return ask();
    },
    forceFinal() {
      return ask({ role: "user", content: buildForceFinalInstruction() });
    },
    retry() {
      // Retry resends the current round: resend the tail after the last assistant message as-is.
      const last = sessionMessages.at(-1);
      if (last?.role === "user" && state.status === "error") {
        const retryTail = last;
        sessionMessages.pop();
        return ask(retryTail);
      }
      return Promise.resolve();
    },
    close() {
      controller?.abort();
      controller = null;
      sessionMessages = [];
      questionCount = 0;
      state = { ...EMPTY_CLARIFY_SESSION_STATE };
      emit();
    },
  };
}

/** React wrapper: mirrors the core state into component state. */
export function useClarifySession(
  runTurn: RunClarifyTurn,
  _clarifyContext: ClarifyContext | undefined,
  callbacks: { onFinal: (text: string) => void },
) {
  const [state, setState] = useState<ClarifySessionState>(EMPTY_CLARIFY_SESSION_STATE);
  const coreRef = useRef<ClarifySessionCore | null>(null);
  if (!coreRef.current) {
    const core = createClarifySessionCore(runTurn, callbacks);
    core.subscribe = (listener: () => void) => {
      // When createClarifySessionCore does not export subscribe, add it here (see below).
      return () => {};
    };
    coreRef.current = core;
  }
  return { state, core: coreRef.current };
}
```

Note: the `useClarifySession` above is a placeholder draft — during implementation, add `subscribe(listener): () => void` to `createClarifySessionCore` and return it (`emit` already exists), drive re-renders in the hook with `useSyncExternalStore(core.subscribe, core.getState)`, and keep `runTurn`/`callbacks` current via refs. Tests only cover `createClarifySessionCore`; the hook part is manually tested (Task 5).

- [ ] **Step 4: Run to confirm it passes**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-session.test.mjs`
Expected: PASS (5 cases)

- [ ] **Step 5: Commit**

```bash
git add crates/agent-ui/src/components/chat/clarify/useClarifySession.ts crates/agent-gui/test/chat/clarify-session.test.mjs
git commit -m "feat(clarify): add clarify session state machine"
```

---

### Task 3: ClarifyPanel component + i18n keys

**Files:**
- Create: `crates/agent-ui/src/components/chat/clarify/ClarifyPanel.tsx`
- Modify: `crates/agent-ui/src/i18n/translations/zhCNCommon.ts` (near the `chat.*` key area at the end of the file, adding a new section)
- Modify: `crates/agent-ui/src/i18n/translations/enUSCommon.ts` (same as above)

**Interfaces:**
- Consumes: Task 1 `stripLeadingMarker`; Task 2 `useClarifySession`, `ClarifySessionState`.
- Produces:
  - `ClarifyPanel(props: { state: ClarifySessionState; onSubmitAnswer: (text: string) => void; onForceFinal: () => void; onRetry: () => void; onClose: () => void; busy: boolean }): JSX.Element`
  - i18n keys (both files): `chat.clarify.title`, `chat.clarify.buttonTitle`, `chat.clarify.buttonDisabled`, `chat.clarify.answerPlaceholder`, `chat.clarify.generate`, `chat.clarify.retry`, `chat.clarify.close`, `chat.clarify.thinking`, `chat.clarify.writing`, `chat.clarify.applied`, `chat.clarify.errorPrefix`

- [ ] **Step 1: Add the i18n keys**

`zhCNCommon.ts` (append near the existing `chat.queue.*` key group):

```ts
  // Prompt clarify panel (opened from the composer toolbar button)
  "chat.clarify.title": "Clarify prompt",
  "chat.clarify.buttonTitle": "Clarify prompt",
  "chat.clarify.buttonDisabled": "Type a draft prompt first",
  "chat.clarify.answerPlaceholder": "Answer or add details… (Enter to send)",
  "chat.clarify.generate": "Generate prompt now",
  "chat.clarify.retry": "Retry",
  "chat.clarify.close": "Close",
  "chat.clarify.thinking": "Thinking…",
  "chat.clarify.writing": "Writing the final prompt…",
  "chat.clarify.applied": "Applied to the composer — edit freely",
  "chat.clarify.errorPrefix": "Request failed",
```

`enUSCommon.ts` corresponding English:

```ts
  // Prompt clarify panel (opened from the composer toolbar button)
  "chat.clarify.title": "Clarify prompt",
  "chat.clarify.buttonTitle": "Clarify prompt",
  "chat.clarify.buttonDisabled": "Type a draft prompt first",
  "chat.clarify.answerPlaceholder": "Answer or add details… (Enter to send)",
  "chat.clarify.generate": "Generate prompt now",
  "chat.clarify.retry": "Retry",
  "chat.clarify.close": "Close",
  "chat.clarify.thinking": "Thinking…",
  "chat.clarify.writing": "Writing the final prompt…",
  "chat.clarify.applied": "Applied to the composer — edit freely",
  "chat.clarify.errorPrefix": "Request failed",
```

- [ ] **Step 2: Implement ClarifyPanel**

There is no component testing infrastructure (the repo has no react-testing library), so this task is accepted via type checking + manual testing (Task 5).

```tsx
// crates/agent-ui/src/components/chat/clarify/ClarifyPanel.tsx
import { Loader2, RefreshCw, WandSparkles, X } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState, type KeyboardEvent } from "react";
import { stripLeadingMarker } from "./clarifyProtocol";
import type { ClarifySessionState } from "./useClarifySession";

type ClarifyPanelProps = {
  state: ClarifySessionState;
  busy: boolean;
  onSubmitAnswer: (text: string) => void;
  onForceFinal: () => void;
  onRetry: () => void;
  onClose: () => void;
};

/** Clarify panel embedded above the composer: Q&A bubbles + answer input row + action buttons. */
export function ClarifyPanel(props: ClarifyPanelProps) {
  const { state, busy, onSubmitAnswer, onForceFinal, onRetry, onClose } = props;
  const { t } = useLocale();
  const [answer, setAnswer] = useState("");

  const submit = () => {
    const text = answer.trim();
    if (!text || busy) return;
    setAnswer("");
    onSubmitAnswer(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const canAnswer = state.status === "awaitingInput";
  const canGenerate = !busy && state.status !== "done";

  return (
    <div
      data-clarify-panel=""
      className="mx-4 mb-1 mt-2 flex max-h-[40vh] flex-col overflow-hidden rounded-2xl border border-black/[0.055] bg-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-2xl dark:border-white/[0.10] dark:bg-white/[0.06]"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground">
          <WandSparkles className="h-3.5 w-3.5" />
          {t("chat.clarify.title")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("chat.clarify.close")}
          title={t("chat.clarify.close")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="chat-queue-scroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-2">
        {state.visibleMessages.map((message, index) => (
          <div
            key={index}
            className={cn(
              "max-w-[92%] whitespace-pre-wrap rounded-xl px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] leading-relaxed",
              message.role === "user"
                ? "self-end bg-primary/10 text-foreground"
                : "self-start bg-muted/60 text-foreground/90",
            )}
          >
            {message.role === "assistant" ? stripLeadingMarker(message.content) : message.content}
          </div>
        ))}
        {busy && state.streamingText ? (
          <div className="max-w-[92%] self-start whitespace-pre-wrap rounded-xl bg-muted/60 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] leading-relaxed text-foreground/90">
            {stripLeadingMarker(state.streamingText)}
          </div>
        ) : null}
        {state.status === "asking" && !state.streamingText ? (
          <div className="flex items-center gap-1.5 self-start rounded-xl bg-muted/60 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("chat.clarify.thinking")}
          </div>
        ) : null}
        {state.status === "synthesizing" ? (
          <div className="flex items-center gap-1.5 self-start rounded-xl bg-muted/60 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("chat.clarify.writing")}
          </div>
        ) : null}
        {state.status === "done" ? (
          <div className="self-start rounded-xl bg-primary/10 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-foreground/90">
            {t("chat.clarify.applied")}
          </div>
        ) : null}
        {state.status === "error" && state.error ? (
          <div className="flex items-center gap-2 self-start rounded-xl bg-destructive/10 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-destructive">
            <span className="min-w-0 flex-1">
              {t("chat.clarify.errorPrefix")}: {state.error}
            </span>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors hover:bg-destructive/15"
            >
              <RefreshCw className="h-3 w-3" />
              {t("chat.clarify.retry")}
            </button>
          </div>
        ) : null}
      </div>

      {canAnswer ? (
        <div className="flex items-end gap-1.5 border-t border-black/[0.05] px-2.5 py-1.5 dark:border-white/[0.08]">
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={t("chat.clarify.answerPlaceholder")}
            className="max-h-24 min-h-[28px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[calc(12px*var(--zone-font-scale,1))] leading-relaxed outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            onClick={onForceFinal}
            disabled={!canGenerate}
            title={t("chat.clarify.generate")}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-black/[0.06] px-2.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40 dark:border-white/[0.12]"
          >
            <WandSparkles className="h-3 w-3" />
            <span className="whitespace-nowrap">{t("chat.clarify.generate")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
```

(If `RefreshCw` or `X` are not exported by IconSet, import them directly from `~icons/lucide/refresh-cw` and `~icons/lucide/x` — the repo already configures unplugin-icons; see usage in IconSet.tsx.)

- [ ] **Step 3: Type check**

Run: `cd crates/agent-gui && npx tsc --noEmit`
Expected: no errors (if the repo has a separate lint script, run `npm run lint` as well)

- [ ] **Step 4: Commit**

```bash
git add crates/agent-ui/src/components/chat/clarify/ClarifyPanel.tsx crates/agent-ui/src/i18n/translations/zhCNCommon.ts crates/agent-ui/src/i18n/translations/enUSCommon.ts
git commit -m "feat(clarify): add ClarifyPanel UI component and i18n strings"
```

---

### Task 4: ChatComposerBar integration (button + panel + applying the result)

**Files:**
- Modify: `crates/agent-ui/src/pages/chat/ChatComposerBar.tsx` (props type from line 229, component top-level destructuring, toolbar row 1010-1127, editor container line 980, send guard `handleComposerSend` line 507)

**Interfaces:**
- Consumes: all Task 1-3 outputs (`RunClarifyTurn`, `ClarifyContext`, `useClarifySession`, `ClarifyPanel`).
- Produces: new optional fields on `ChatComposerBarProps`:
  - `runClarifyTurn?: RunClarifyTurn`
  - `clarifyContext?: ClarifyContext`

- [ ] **Step 1: props and state**

In `ChatComposerBarProps` (`ChatComposerBar.tsx:229`), before `onHeightChange?: (height: number) => void;`, add:

```ts
  /** Prompt clarify executor: once injected, renders the "Clarify" button in the toolbar row (GUI already wired; Web is Plan 2). */
  runClarifyTurn?: RunClarifyTurn;
  /** Lightweight workspace info attached to the clarify system prompt. */
  clarifyContext?: ClarifyContext;
```

Top imports:

```ts
import { ClarifyPanel } from "@liveagent/ui/components/chat/clarify/ClarifyPanel";
import type {
  ClarifyContext,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { useClarifySession } from "@liveagent/ui/components/chat/clarify/useClarifySession";
```

(Import style: this file uniformly uses `@liveagent/ui/...` absolute paths; copy that.)

Add `runClarifyTurn, clarifyContext` to the component destructuring; add to the body:

```tsx
  // Clarify session: the panel is usable immediately and discarded on close (design doc: not persisted).
  const [clarifyOpen, setClarifyOpen] = useState(false);
  const applyClarifyFinal = useCallback(
    (finalText: string) => {
      const composer = composerRef.current;
      if (!composer) return;
      // Replace only text segments: attachment/mention chips are preserved as-is (design doc "final draft into composer").
      // setDraft rebuilds the DOM from segments, and stale derived fields are ignored.
      const draft = composer.getDraft();
      const preserved = draft.segments.filter((segment) => segment.type !== "text");
      composer.setDraft({
        ...draft,
        segments: [{ type: "text", text: finalText }, ...preserved],
      });
      setClarifyOpen(false);
      composer.focus();
    },
    [composerRef],
  );
  const clarifySession = useClarifySession(runClarifyTurn, clarifyContext, {
    onFinal: applyClarifyFinal,
  });
  const clarifyEnabled = Boolean(runClarifyTurn) && hasModels;
  const clarifyButtonDisabled = !clarifyEnabled || composerIsEmpty;
  const handleClarifyToggle = useCallback(() => {
    if (!clarifyEnabled) return;
    if (clarifyOpen) {
      clarifySession.core.close();
      setClarifyOpen(false);
      return;
    }
    const composer = composerRef.current;
    const draftText = composer?.getDraft().textWithoutLargePastes.trim() || "";
    if (!draftText) return;
    setClarifyOpen(true);
    void clarifySession.core.start(draftText);
  }, [clarifyEnabled, clarifyOpen, clarifySession.core]);
  // Discard any in-progress clarification when switching conversations (the component remounts by conversationId; also close explicitly to be safe).
  useEffect(() => {
    clarifySession.core.close();
    setClarifyOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
```

Send guard (`handleComposerSend`, line 507):

```tsx
  const handleComposerSend = useCallback(() => {
    // Block sending while clarification is in progress: avoid sending a half-finished draft (design doc "interaction").
    if (clarifyOpen) return;
    setComposerExpanded(false);
    onSend();
  }, [clarifyOpen, onSend, setComposerExpanded]);
```

- [ ] **Step 2: Toolbar row button**

Insert after the plan mode pill (lines 1113-1125 `{isAgentMode && chatRuntimeControls.planModeEnabled ? (...) : null}` and before the STT block `{stt.available ? (`):

```tsx
              {clarifyEnabled ? (
                <RuntimeControlTooltip label={t("chat.clarify.buttonTitle")}>
                  <button
                    type="button"
                    disabled={clarifyButtonDisabled}
                    onClick={handleClarifyToggle}
                    aria-label={t("chat.clarify.buttonTitle")}
                    aria-pressed={clarifyOpen}
                    title={clarifyButtonDisabled ? t("chat.clarify.buttonDisabled") : undefined}
                    className={cn(
                      "composer-toolbar-action inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
                      "disabled:pointer-events-none disabled:opacity-40",
                      clarifyOpen && "bg-muted/60 text-foreground",
                    )}
                  >
                    <WandSparkles className="h-4 w-4" />
                  </button>
                </RuntimeControlTooltip>
              ) : null}
```

Add `WandSparkles` to this file's IconSet import.

- [ ] **Step 3: Panel rendering**

Insert before the editor container (line 980 `<div className={cn("relative flex flex-1 pl-4 pr-12", ...)}>` and after the usage ring container (lines 959-968)):

```tsx
          {clarifyOpen && runClarifyTurn ? (
            <ClarifyPanel
              state={clarifySession.state}
              busy={clarifySession.state.status === "asking" || clarifySession.state.status === "synthesizing"}
              onSubmitAnswer={(text) => void clarifySession.core.submitAnswer(text)}
              onForceFinal={() => void clarifySession.core.forceFinal()}
              onRetry={() => void clarifySession.core.retry()}
              onClose={() => {
                clarifySession.core.close();
                setClarifyOpen(false);
              }}
            />
          ) : null}
```

- [ ] **Step 4: Type check + full test run**

Run: `cd crates/agent-gui && npx tsc --noEmit && npm test`
Expected: tsc has no errors; all existing tests pass (this task adds no new tests — the logic was tested in Tasks 1/2, and the component wiring is manually tested).

- [ ] **Step 5: Commit**

```bash
git add crates/agent-ui/src/pages/chat/ChatComposerBar.tsx
git commit -m "feat(clarify): wire clarify panel and toolbar button into ChatComposerBar"
```

---

### Task 5: GUI host wiring (ChatPage → streamAssistantMessage)

**Files:**
- Modify: `crates/agent-gui/src/pages/ChatPage.tsx` (composer binding, from line 2988)
- Test: `crates/agent-gui/test/chat/clarify-runner.test.mjs`

**Interfaces:**
- Consumes: Task 1 `RunClarifyTurn`; `streamAssistantMessage` / `assistantMessageToText` (`crates/agent-gui/src/lib/providers/llm.ts`), `resolveEffectiveChatModelSelection` (`runtime/modelSelection.ts`), `createProviderRuntimeConfig` (`lib/providers/llm.ts`).
- Produces: no downstream dependency (terminal wiring task).

- [ ] **Step 1: Write the failing test (runner wrapper function)**

For testability, put the wrapper function in its own file `crates/agent-gui/src/pages/chat/runtime/clarifyRunner.ts` (same directory as conversationTitleJob), and mock `streamAssistantMessage` in the test:

```js
// crates/agent-gui/test/chat/clarify-runner.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

const calls = [];
const loader = createTsModuleLoader({
  mocks: {
    [abs("src/lib/providers/llm.ts")]: {
      streamAssistantMessage: async (params) => {
        calls.push(params);
        return { role: "assistant", content: "[CLARIFY_QUESTION]\nQ1" };
      },
      assistantMessageToText: (m) => m.content,
    },
  },
});
const mod = await loader.import(abs("src/pages/chat/runtime/clarifyRunner.ts"));

test("runGuiClarifyTurn maps messages into a text-only stream call", async () => {
  const runtime = {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    requestFormat: "openai",
    reasoning: "off",
    promptCachingEnabled: false,
    retryPolicy: { maxAttempts: 1, initialDelayMs: 1 },
  };
  const provider = { id: "p1", type: "openai", baseUrl: "https://api.example.com", apiKey: "k", requestFormat: "openai", activeModels: ["m1"] };
  const selection = { selectedModel: { customProviderId: "p1", model: "m1" }, provider, providerId: "openai", model: "m1" };
  const out = await mod.createGuiClarifyRunner(
    () => selection,
    () => runtime,
  )([{ role: "user", content: "hi" }], new AbortController().signal);
  assert.equal(out, "[CLARIFY_QUESTION]\nQ1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerId, "openai");
  assert.equal(calls[0].model, "m1");
  assert.equal(calls[0].context.systemPrompt.length > 0, true);
  assert.equal(calls[0].context.messages.length, 1);
  assert.equal(calls[0].context.messages[0].role, "user");
  assert.equal(calls[0].nativeWebSearch, false);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-runner.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement clarifyRunner**

```ts
// crates/agent-gui/src/pages/chat/runtime/clarifyRunner.ts
import type { ClarifyMessage, RunClarifyTurn } from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { assistantMessageToText, streamAssistantMessage } from "../../../lib/providers/llm";
import type { EffectiveChatModelSelection } from "./modelSelection";

type RuntimeLike = Parameters<typeof streamAssistantMessage>[0]["runtime"];

/**
 * Clarify executor for the desktop host: runs one text-only completion with the current conversation model.
 * The model/runtime are resolved lazily on every call (getters), so clarification always uses the selection
 * from when the panel was opened.
 */
export function createGuiClarifyRunner(
  getSelection: () => EffectiveChatModelSelection,
  getRuntime: () => RuntimeLike,
): RunClarifyTurn {
  return async (messages: ClarifyMessage[], signal: AbortSignal, onTextDelta?: (delta: string) => void) => {
    const selection = getSelection();
    const assistant = await streamAssistantMessage({
      providerId: selection.providerId,
      model: selection.model,
      runtime: getRuntime(),
      signal,
      cacheRetention: "none",
      nativeWebSearch: false,
      context: {
        systemPrompt: "",
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
          timestamp: Date.now(),
        })),
      },
      onTextDelta,
    });
    return assistantMessageToText(assistant);
  };
}
```

Note: `buildClarifyMessages` (Task 1) already prepends the system message to the message array; leaving `streamAssistantMessage`'s `context.systemPrompt` empty is fine — `buildTextOnlyCallContext` appends the text-only suffix. If implementation reveals that pi-ai requires a non-empty systemPrompt, move the system message into the `context.systemPrompt` field and assert that in the test, keeping the LLM input semantics unchanged.

- [ ] **Step 4: Run to confirm it passes**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-runner.test.mjs`
Expected: PASS

- [ ] **Step 5: ChatPage wiring**

In `crates/agent-gui/src/pages/ChatPage.tsx` composer binding (inside the `composer: {` object at line 2988, near `loadHistoryPrompts`), add:

```tsx
        runClarifyTurn: useMemo(
          () =>
            createGuiClarifyRunner(
              () => resolveEffectiveChatModelSelection({ settings }),
              () =>
                createProviderRuntimeConfig(
                  resolveEffectiveChatModelSelection({ settings }).provider,
                  resolveEffectiveChatModelSelection({ settings }).model,
                  chatRuntimeControlsForCurrentProvider,
                ),
            ),
          [settings, chatRuntimeControlsForCurrentProvider],
        ),
        clarifyContext: {
          workdir: workspaceRoot ?? "",
          gitBranch: currentGitBranch,
        },
```

Wiring details (implementers adjust to the actual repo, semantics unchanged):
- Use the current pane's conversation model for `resolveEffectiveChatModelSelection`'s `conversationSelectedModel` — same source as `currentModelLabel: paneModelLabel` (grep the upstream of `paneModelLabel`). If the pane model is unavailable at that binding, fall back to `{ settings }`, i.e. the page-level selected model, and explain in a comment.
- `currentGitBranch`: if ChatPage has no existing branch state, pass `undefined` first (`clarifyContext.gitBranch` is optional); do not fetch git state just for this.
- Import `createProviderRuntimeConfig` and `resolveEffectiveChatModelSelection` from `../../../lib/providers/llm` / `./chat/runtime/modelSelection` (in ChatPage's existing import section).

- [ ] **Step 6: Full verification**

Run: `cd crates/agent-gui && npx tsc --noEmit && npm test`
Expected: all green

- [ ] **Step 7: Commit**

```bash
git add crates/agent-gui/src/pages/chat/runtime/clarifyRunner.ts crates/agent-gui/src/pages/ChatPage.tsx crates/agent-gui/test/chat/clarify-runner.test.mjs
git commit -m "feat(clarify): wire GUI host clarify runner into composer binding"
```

---

### Task 6: End-to-end manual testing

**Files:** no new files (verification task).

- [ ] **Step 1: Start the app**

Start the desktop GUI using the `run` skill (or the repo's existing startup method).

- [ ] **Step 2: Acceptance checklist (item by item from the design doc "interaction" and "error handling")**

1. Type a vague draft in the composer (e.g. "Help me improve the login page") → click the wand button → the panel appears above the composer and the first question appears
2. Answer 1-2 rounds → click "Generate prompt now" → the final draft is written into the composer and the panel closes
3. The draft contains an @file mention → after clarification the file chip is still there and the text is replaced
4. Press Enter while clarification is in progress → the main conversation is not sent
5. Offline/bad key scenario → an error row appears in the panel and retry recovers
6. The draft is empty → the button is disabled with a title hint
7. Ask 5 rounds in a row → the final draft is produced automatically after the 6th answer
8. Switch the UI between Chinese and English → the copy is correct

- [ ] **Step 3: Fix any issues found (run `npm test` after each fix), and once everything passes, finish with a commit**

```bash
git add -A
git commit -m "fix(clarify): polish from manual verification pass"
```
(Skip this step if there are no issues.)

---

## Self-Review Notes

- Spec coverage: UI shape (T3/T4), current conversation model (T5), LLM decision + manual fallback (T1/T2), 5-round cap (T2), text-only replacement preserving attachments (T4), lightweight workspace (T1/T5), full error-handling table (T2/T3/T6), i18n (T3), tests (inline in T1/T2/T5 respectively) — all have corresponding tasks. The Web surface belongs to Plan 2.
- Placeholders: the `useClarifySession` hook part of T2 is marked "complete during implementation with useSyncExternalStore" — the core code is complete and testable, and the hook is a 10-line mirror, so this is an implementation guide rather than a placeholder; T5 Step 5 marks two "adjust to the actual repo" wiring points whose semantics are already locked down.
- Type consistency: `RunClarifyTurn(messages, signal, onTextDelta?)` runs through T1/T2/T4/T5; the `ClarifySessionState` field names are consistent across T2/T3/T4.