// crates/agent-ui/src/components/chat/clarify/clarifyTypes.ts
/** A message in the clarify mini-conversation. Isomorphic to pi-ai Context messages but independent
 * of the conversation runtime. */
export type ClarifyMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/** Lightweight workspace info: feeds only the path/branch, with no file contents (see the design
 * doc "Context Awareness"). */
export type ClarifyContext = {
  workdir: string;
  gitBranch?: string;
};

/** A single candidate option of a structured question. */
export type ClarifyOption = {
  label: string;
  description?: string;
  /** The model-marked recommended option (at most one per question); the UI adds a recommended
   * badge. */
  recommended?: boolean;
};

/** A structured clarify question. The UI always synthesizes an "Other (type your own)" row at the
 * bottom of the options. */
export type ClarifyQuestion = {
  id: string;
  /** Short 2-6 character topic label (for round summaries); defaults to showing the sequence number. */
  header?: string;
  prompt: string;
  /** May be an empty array: a purely open question whose answer area has only a free-text input. */
  options: ClarifyOption[];
  /** When true, options are multi-select (checkboxes) and the "Other" input may coexist with the
   * options. */
  allowMultiple?: boolean;
};

/** The user's answer to a question. Empty selectedLabels and no customText means "unanswered". */
export type ClarifyAnswer = {
  questionId: string;
  prompt: string;
  /** Selected option labels (0/1 for single-select, any number for multi-select). */
  selectedLabels: string[];
  /** Free-text "Other" input (counts as an answer only when non-empty after trimming). */
  customText?: string;
};

/** One round of Q&A. answers === null means this round's questions are still awaiting the user's
 * response. */
export type ClarifyRound = {
  questions: ClarifyQuestion[];
  answers: ClarifyAnswer[] | null;
};

/**
 * Executes one clarify completion turn. messages includes system; returns the full reply text
 * (already assembled by the host). onTextDelta is used for streaming onto the panel; signal carries
 * cancellation through the state machine.
 */
export type RunClarifyTurn = (
  messages: ClarifyMessage[],
  signal: AbortSignal,
  onTextDelta?: (delta: string) => void,
) => Promise<string>;
