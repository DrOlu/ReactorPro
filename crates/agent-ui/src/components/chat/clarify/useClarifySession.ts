// crates/agent-ui/src/components/chat/clarify/useClarifySession.ts
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  buildClarifyAnswersMessage,
  buildClarifyMessages,
  CLARIFY_FORCE_FINAL_INSTRUCTION,
  CLARIFY_MAX_ROUNDS,
  clarifyStreamPreview,
  parseClarifyTurn,
} from "./clarifyProtocol";
import type {
  ClarifyAnswer,
  ClarifyContext,
  ClarifyMessage,
  ClarifyRound,
  RunClarifyTurn,
} from "./clarifyTypes";

// Tests read the limit constants through this module (the single source of
// truth is still in clarifyProtocol).
export { CLARIFY_MAX_ROUNDS };

export type ClarifySessionStatus = "idle" | "asking" | "awaitingInput" | "done" | "error";

export type ClarifySessionState = {
  status: ClarifySessionStatus;
  /** The user draft at the start of the session (shown as a quote in the panel header). */
  draftText: string;
  /** Q&A rounds. The last round with answers === null is the question group currently awaiting answers. */
  rounds: ClarifyRound[];
  /** Streaming preview text for the final-draft round (question rounds stream JSON, so it is always an empty string). */
  streamingText: string;
  error: string | null;
  roundCount: number;
  finalText: string | null;
};

export const EMPTY_CLARIFY_SESSION_STATE: ClarifySessionState = {
  status: "idle",
  draftText: "",
  rounds: [],
  streamingText: "",
  error: null,
  roundCount: 0,
  finalText: null,
};

export type ClarifySessionCore = {
  getState(): ClarifySessionState;
  /** Subscribe to external (React useSyncExternalStore) state changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  start(draftText: string): Promise<void>;
  /** Submit all answers for the current round; the model uses them to decide whether to ask another round or produce the final draft directly. */
  submitAnswers(answers: ClarifyAnswer[]): Promise<void>;
  /** Generate the final draft directly from the existing answers (including partial selections in the current round) without waiting for the remaining questions. */
  generateNow(answers?: ClarifyAnswer[]): Promise<void>;
  retry(): Promise<void>;
  close(): void;
};

/** At least one answer actually provided content (selected an option or wrote free text). */
function hasAnsweredContent(answers: ClarifyAnswer[]): boolean {
  return answers.some(
    (answer) => answer.selectedLabels.length > 0 || (answer.customText?.trim().length ?? 0) > 0,
  );
}

/**
 * Clarify-session core (framework-agnostic, easy to test directly with
 * node:test). The React hook merely mirrors the core's state into
 * useSyncExternalStore. One start corresponds to one session; close discards
 * all state.
 */
export function createClarifySessionCore(
  runTurn: RunClarifyTurn,
  callbacks: { onFinal: (text: string) => void },
  getContext?: () => ClarifyContext | undefined,
): ClarifySessionCore {
  let state: ClarifySessionState = { ...EMPTY_CLARIFY_SESSION_STATE };
  let sessionMessages: ClarifyMessage[] = [];
  let rounds: ClarifyRound[] = [];
  let roundCount = 0;
  let controller: AbortController | null = null;
  // Session generation: start()/close() each increment it once. An in-flight
  // ask() captures the generation at entry, then compares on every await
  // return -- a changed generation means the session was reset/replaced, so
  // late results are discarded. This covers both races: "a late reject after
  // close writes the idle state into error" and "start(new) after close, where
  // the old request's success result pollutes the new session's messages".
  let epoch = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setState = (patch: Partial<ClarifySessionState>) => {
    state = { ...state, ...patch };
    emit();
  };

  /** Commit the awaiting final round as answered; a no-op when there is no awaiting round. */
  const settlePendingRound = (answers: ClarifyAnswer[]): ClarifyRound | null => {
    const pending = rounds.at(-1);
    if (!pending || pending.answers !== null) return null;
    const settled: ClarifyRound = { ...pending, answers };
    rounds = [...rounds.slice(0, -1), settled];
    return settled;
  };

  const ask = async (extraUser?: ClarifyMessage) => {
    // Any new round (start/submitAnswers/generateNow/retry) invalidates the
    // in-flight old round: the generation is incremented first, then the old
    // controller is aborted. The old ask's late delta/completion/failure are all
    // silently discarded by the generation gate below (abort-style errors in
    // particular must not land in the error state).
    epoch += 1;
    controller?.abort();
    controller = null;
    if (extraUser) sessionMessages.push(extraUser);
    const localController = new AbortController();
    controller = localController;
    const currentEpoch = epoch;
    setState({ status: "asking", streamingText: "", error: null, rounds: rounds.slice() });
    // The streaming preview is not stable when concatenated piecewise (markers
    // / JSON prefixes must be judged as a whole), so accumulate the raw text
    // separately and recompute the preview in full each time.
    let streamedRaw = "";
    let raw: string;
    try {
      // context is obtained via a getter: the host does not need to rebuild the core
      // after switching workspaces (design doc "context awareness").
      raw = await runTurn(
        buildClarifyMessages(sessionMessages, getContext?.()),
        localController.signal,
        (delta) => {
          // Accumulate only in the current generation and while still asking: a
          // late delta after the turn ends or the session is reset must not be
          // written into the cleared/committed streamingText.
          if (epoch !== currentEpoch || state.status !== "asking") return;
          streamedRaw += delta;
          const preview = clarifyStreamPreview(streamedRaw);
          if (preview !== state.streamingText) setState({ streamingText: preview });
        },
      );
    } catch (error) {
      // The session has been discarded by close()/start(): the old request's
      // failure (including abort) does not belong to the current session and
      // must not land in the error state -- otherwise it would flip the
      // just-reset idle / new session into error.
      if (epoch !== currentEpoch) return;
      // Only failures within the same generation are real network/model errors; the
      // error state must not retain half a stream of text.
      setState({
        status: "error",
        streamingText: "",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    } finally {
      // Clear the reference only when this is still the current controller: avoid a
      // late old ask clearing the new ask's controller.
      if (controller === localController) controller = null;
    }
    // A successful result must likewise pass the generation gate first, then parse
    // / write messages.
    if (epoch !== currentEpoch) return;
    const parsed = parseClarifyTurn(raw);
    sessionMessages.push({ role: "assistant", content: raw });
    if (parsed.kind === "final") {
      setState({
        status: "done",
        streamingText: "",
        finalText: parsed.text,
        rounds: rounds.slice(),
      });
      // Host callbacks are invoked after the state commits as done and wrapped
      // against exceptions: a host side-effect throwing must not flip the
      // settled done state back to error, nor reject start()'s Promise.
      try {
        callbacks.onFinal(parsed.text);
      } catch {
        // Swallow host callback exceptions: the state machine only recognizes the
        // session's own errors externally.
      }
      return;
    }
    roundCount += 1;
    rounds = [...rounds, { questions: parsed.questions, answers: null }];
    setState({
      status: "awaitingInput",
      streamingText: "",
      roundCount,
      rounds: rounds.slice(),
    });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(draftText) {
      // A new session resets messages and rounds; the generation increment and
      // abort of in-flight requests are handled uniformly by ask().
      sessionMessages = [{ role: "user", content: draftText }];
      rounds = [];
      roundCount = 0;
      setState({ ...EMPTY_CLARIFY_SESSION_STATE, draftText });
      return ask();
    },
    submitAnswers(answers) {
      // Accept a submission only while awaiting answers: after done, rounds
      // must not reopen or onFinal fire twice, and a submission while asking is
      // a UI-unreachable path that is blocked as well.
      if (state.status !== "awaitingInput") return Promise.resolve();
      const settled = settlePendingRound(answers);
      if (!settled) return Promise.resolve();
      const answersMessage: ClarifyMessage = {
        role: "user",
        content: buildClarifyAnswersMessage(settled),
      };
      if (roundCount >= CLARIFY_MAX_ROUNDS) {
        // Hard limit: no more questions are allowed; answers are sent together with
        // the final-draft instruction (design doc "error handling").
        sessionMessages.push(answersMessage);
        return ask({ role: "user", content: CLARIFY_FORCE_FINAL_INSTRUCTION });
      }
      return ask(answersMessage);
    },
    generateNow(answers) {
      // Forcing the final draft after done is a no-op: the draft has settled and
      // rounds are not reopened.
      if (state.status === "done") return Promise.resolve();
      if (state.status === "awaitingInput") {
        const settled = settlePendingRound(answers ?? []);
        // Include the current round's partial selected answers in the record; if all
        // empty, do not add a noise message for the model.
        if (settled && hasAnsweredContent(settled.answers ?? [])) {
          sessionMessages.push({ role: "user", content: buildClarifyAnswersMessage(settled) });
        }
      }
      return ask({ role: "user", content: CLARIFY_FORCE_FINAL_INSTRUCTION });
    },
    retry() {
      // Only the error state can retry: in a failed round the tail of
      // sessionMessages is exactly that round's user input, so resend it as-is
      // (pop then push the same entry is an identity transform, so skip it).
      if (state.status !== "error") return Promise.resolve();
      return ask();
    },
    close() {
      // Increment the generation first: any late result (success or failure)
      // of the in-flight ask is invalidated and must not write into the
      // just-cleared sessionMessages or resurrect a ghost awaitingInput
      // session.
      epoch += 1;
      controller?.abort();
      controller = null;
      sessionMessages = [];
      rounds = [];
      roundCount = 0;
      state = { ...EMPTY_CLARIFY_SESSION_STATE };
      emit();
    },
  };
}

/** React wrapper: useSyncExternalStore mirrors the core state; runTurn/callbacks/context stay fresh via refs. */
export function useClarifySession(
  runTurn: RunClarifyTurn,
  clarifyContext: ClarifyContext | undefined,
  callbacks: { onFinal: (text: string) => void },
): {
  state: ClarifySessionState;
  start: (draftText: string) => void;
  submitAnswers: (answers: ClarifyAnswer[]) => void;
  generateNow: (answers?: ClarifyAnswer[]) => void;
  retry: () => void;
  close: () => void;
} {
  // Refresh refs on every render: the core closure always reads the latest host
  // callbacks and the core itself need not be rebuilt.
  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;
  const contextRef = useRef(clarifyContext);
  contextRef.current = clarifyContext;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // The core is created only once: changing identity would lose subscriptions and
  // break the in-flight session.
  const coreRef = useRef<ClarifySessionCore | null>(null);
  if (!coreRef.current) {
    coreRef.current = createClarifySessionCore(
      (messages, signal, onDelta) => runTurnRef.current(messages, signal, onDelta),
      { onFinal: (text) => callbacksRef.current.onFinal(text) },
      () => contextRef.current,
    );
  }
  const core = coreRef.current;

  // subscribe must be a stable reference, otherwise useSyncExternalStore
  // resubscribes on every render.
  const subscribe = useCallback((listener: () => void) => core.subscribe(listener), [core]);
  const state = useSyncExternalStore(subscribe, core.getState);

  // Actions return void: errors are already put into state.error by the core, so
  // the Promise needs no continuation by the caller.
  const start = useCallback((draftText: string) => void core.start(draftText), [core]);
  const submitAnswers = useCallback(
    (answers: ClarifyAnswer[]) => void core.submitAnswers(answers),
    [core],
  );
  const generateNow = useCallback(
    (answers?: ClarifyAnswer[]) => void core.generateNow(answers),
    [core],
  );
  const retry = useCallback(() => void core.retry(), [core]);
  const close = useCallback(() => core.close(), [core]);

  // Unmount discards: the host (ChatComposerBar) already explicitly closes the
  // session on close()/conversation-switch paths; this covers the pure-unmount
  // path (the component disappearing directly, e.g. on a view switch) -- the
  // AbortController in core.close() reaches in-flight requests (design doc
  // "error handling"). The dep array is empty: coreRef is a stable ref, so
  // cleanup runs only once on unmount.
  useEffect(() => {
    return () => coreRef.current?.close();
  }, []);

  return { state, start, submitAnswers, generateNow, retry, close };
}
