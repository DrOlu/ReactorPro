// Shared pure logic for AskUserQuestion: types, fault-tolerant parsing of
// streaming arguments, and answer validation.
// This shared module must remain zero-dependency pure data logic.

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

export const ASK_USER_QUESTION_MAX_QUESTIONS = 4;
export const ASK_USER_QUESTION_MIN_OPTIONS = 2;
export const ASK_USER_QUESTION_MAX_OPTIONS = 6;
/** Answer window per question round: after the timeout, the recommended option (first by default) is auto-selected and execution continues. */
export const ASK_USER_QUESTION_TIMEOUT_MS = 3 * 60 * 1000;
/** Max length of a UI-synthesized "Other (type your own)" answer; anything longer is truncated. */
export const ASK_USER_QUESTION_CUSTOM_MAX_LENGTH = 2000;
/**
 * Authoritative answer deadline timestamp (ms) the desktop attaches to the tool
 * arguments reported by the gateway.
 * The WebUI card countdown aligns to it to match desktop timing; the key does not
 * exist in model arguments (the `__` prefix avoids collisions).
 */
export const ASK_USER_QUESTION_DEADLINE_ARG = "__askUserQuestionDeadlineAt";

export type AskUserQuestionOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};

export type AskUserQuestionItem = {
  /** Stable question id (absent -> generated in order q1..qN); answers align by it. */
  id: string;
  /** Short label for the top tab; absent -> falls back to "Question N". */
  header?: string;
  prompt: string;
  options: AskUserQuestionOption[];
};

export type AskUserQuestionAnswer = {
  questionId: string;
  prompt: string;
  selectedLabel: string;
  /** Free-form answer for the UI-synthesized "Other" item: selectedLabel is the user's raw text. */
  custom?: boolean;
};

export type AskUserQuestionResultDetails = {
  kind: "ask_user_question";
  questions: AskUserQuestionItem[];
  answers: AskUserQuestionAnswer[];
  cancelled?: boolean;
  /** True when the answer window timed out and the recommended option was auto-selected. */
  timedOut?: boolean;
};

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** Reads the answer deadline timestamp (ms) attached to the tool arguments; returns null if absent or invalid. */
export function readAskUserQuestionDeadlineAt(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[ASK_USER_QUESTION_DEADLINE_ARG];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The recommended option is always shown first; the rest keep the model's order. */
function orderAskUserQuestionOptions(options: AskUserQuestionOption[]) {
  const index = options.findIndex((option) => option.recommended === true);
  if (index <= 0) return options;
  const recommended = options[index];
  return [recommended, ...options.slice(0, index), ...options.slice(index + 1)];
}

/**
 * Fault-tolerant parsing for streaming rendering: while tool_call arguments are
 * still being assembled incrementally, keep only fully formed questions (non-empty
 * prompt with at least one labeled option) so the card can render progressively.
 */
export function sanitizeAskUserQuestionItems(raw: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(raw)) return [];
  const items: AskUserQuestionItem[] = [];
  for (const [index, value] of raw.entries()) {
    if (items.length >= ASK_USER_QUESTION_MAX_QUESTIONS) break;
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const prompt = normalizeText(record.prompt);
    if (!prompt) continue;

    const options: AskUserQuestionOption[] = [];
    if (Array.isArray(record.options)) {
      for (const optionValue of record.options) {
        if (options.length >= ASK_USER_QUESTION_MAX_OPTIONS) break;
        if (!optionValue || typeof optionValue !== "object") continue;
        const optionRecord = optionValue as Record<string, unknown>;
        const label = normalizeText(optionRecord.label);
        if (!label) continue;
        const option: AskUserQuestionOption = { label };
        const description = normalizeText(optionRecord.description);
        if (description) option.description = description;
        if (optionRecord.recommended === true) option.recommended = true;
        options.push(option);
      }
    }
    if (options.length === 0) continue;

    const item: AskUserQuestionItem = {
      id: normalizeText(record.id) || `q${index + 1}`,
      prompt,
      options: orderAskUserQuestionOptions(options),
    };
    const header = normalizeText(record.header);
    if (header) item.header = header;
    items.push(item);
  }
  return items;
}

/**
 * Strict validation on the tool-execution side: runs once arguments are complete
 * and throws directly when invalid (the error text goes back to the model to guide
 * a corrected retry).
 */
export function parseAskUserQuestionItems(raw: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("AskUserQuestion requires a non-empty `questions` array.");
  }
  if (raw.length > ASK_USER_QUESTION_MAX_QUESTIONS) {
    throw new Error(
      `AskUserQuestion supports at most ${ASK_USER_QUESTION_MAX_QUESTIONS} questions per call; got ${raw.length}.`,
    );
  }
  const seenIds = new Set<string>();
  return raw.map((value, index) => {
    if (!value || typeof value !== "object") {
      throw new Error(`AskUserQuestion questions[${index}] must be an object.`);
    }
    const record = value as Record<string, unknown>;
    const prompt = normalizeText(record.prompt);
    if (!prompt) {
      throw new Error(`AskUserQuestion questions[${index}].prompt must be a non-empty string.`);
    }
    if (!Array.isArray(record.options)) {
      throw new Error(`AskUserQuestion questions[${index}].options must be an array.`);
    }
    if (
      record.options.length < ASK_USER_QUESTION_MIN_OPTIONS ||
      record.options.length > ASK_USER_QUESTION_MAX_OPTIONS
    ) {
      throw new Error(
        `AskUserQuestion questions[${index}] needs ${ASK_USER_QUESTION_MIN_OPTIONS}-${ASK_USER_QUESTION_MAX_OPTIONS} options; got ${record.options.length}.`,
      );
    }
    const labels = new Set<string>();
    let recommendedCount = 0;
    const options = record.options.map((optionValue, optionIndex) => {
      if (!optionValue || typeof optionValue !== "object") {
        throw new Error(
          `AskUserQuestion questions[${index}].options[${optionIndex}] must be an object.`,
        );
      }
      const optionRecord = optionValue as Record<string, unknown>;
      const label = normalizeText(optionRecord.label);
      if (!label) {
        throw new Error(
          `AskUserQuestion questions[${index}].options[${optionIndex}].label must be a non-empty string.`,
        );
      }
      if (labels.has(label)) {
        throw new Error(
          `AskUserQuestion questions[${index}] has duplicate option label: ${label}.`,
        );
      }
      labels.add(label);
      const option: AskUserQuestionOption = { label };
      const description = normalizeText(optionRecord.description);
      if (description) option.description = description;
      if (optionRecord.recommended === true) {
        recommendedCount += 1;
        option.recommended = true;
      }
      return option;
    });
    if (recommendedCount > 1) {
      throw new Error(
        `AskUserQuestion questions[${index}] may mark at most one option as recommended; got ${recommendedCount}.`,
      );
    }

    const id = normalizeText(record.id) || `q${index + 1}`;
    if (seenIds.has(id)) {
      throw new Error(`AskUserQuestion has duplicate question id: ${id}.`);
    }
    seenIds.add(id);

    const item: AskUserQuestionItem = {
      id,
      prompt,
      options: orderAskUserQuestionOptions(options),
    };
    const header = normalizeText(record.header);
    if (header) item.header = header;
    return item;
  });
}

/** Timeout fallback: take the recommended option per question, or the first option when none is recommended. */
export function buildDefaultAskUserQuestionAnswers(
  questions: AskUserQuestionItem[],
): AskUserQuestionAnswer[] {
  return questions.map((question) => {
    const fallback =
      question.options.find((option) => option.recommended === true) ?? question.options[0];
    return {
      questionId: question.id,
      prompt: question.prompt,
      selectedLabel: fallback?.label ?? "",
    };
  });
}

/** Parse the user's answer (local card submit or remote request_json) and align it to the question definitions. */
export function resolveAskUserQuestionAnswers(
  questions: AskUserQuestionItem[],
  raw: unknown,
): AskUserQuestionAnswer[] | null {
  if (!Array.isArray(raw)) return null;
  const selectedByQuestionId = new Map<string, { selectedLabel: string; custom: boolean }>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const questionId = normalizeText(record.questionId);
    const custom = record.custom === true;
    const selectedLabel = custom
      ? normalizeText(record.selectedLabel).slice(0, ASK_USER_QUESTION_CUSTOM_MAX_LENGTH)
      : normalizeText(record.selectedLabel);
    if (questionId && selectedLabel) {
      selectedByQuestionId.set(questionId, { selectedLabel, custom });
    }
  }

  const answers: AskUserQuestionAnswer[] = [];
  for (const question of questions) {
    const selected = selectedByQuestionId.get(question.id);
    if (!selected) return null;
    if (selected.custom) {
      answers.push({
        questionId: question.id,
        prompt: question.prompt,
        selectedLabel: selected.selectedLabel,
        custom: true,
      });
      continue;
    }
    if (!question.options.some((option) => option.label === selected.selectedLabel)) return null;
    answers.push({
      questionId: question.id,
      prompt: question.prompt,
      selectedLabel: selected.selectedLabel,
    });
  }
  return answers;
}

export function parseAskUserQuestionResultDetails(
  details: unknown,
): AskUserQuestionResultDetails | null {
  if (!details || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  if (record.kind !== "ask_user_question") return null;
  const questions = sanitizeAskUserQuestionItems(record.questions);
  const answers: AskUserQuestionAnswer[] = [];
  if (Array.isArray(record.answers)) {
    for (const value of record.answers) {
      if (!value || typeof value !== "object") continue;
      const answerRecord = value as Record<string, unknown>;
      const questionId = normalizeText(answerRecord.questionId);
      const selectedLabel = normalizeText(answerRecord.selectedLabel);
      if (!questionId || !selectedLabel) continue;
      answers.push({
        questionId,
        prompt: normalizeText(answerRecord.prompt),
        selectedLabel,
        ...(answerRecord.custom === true ? { custom: true } : {}),
      });
    }
  }
  return {
    kind: "ask_user_question",
    questions,
    answers,
    cancelled: record.cancelled === true,
    timedOut: record.timedOut === true,
  };
}

export function buildAskUserQuestionResultText(
  answers: AskUserQuestionAnswer[],
  options?: { timedOut?: boolean },
) {
  const heading = options?.timedOut
    ? "The user did not answer within the time limit; the recommended (or first) option was auto-selected for every question. Proceed accordingly:"
    : "The user answered every question. Their selections are final — proceed accordingly:";
  return [
    heading,
    ...answers.map(
      (answer, index) =>
        `${index + 1}. ${answer.prompt}\n   → ${answer.selectedLabel}${
          answer.custom ? ' (user-typed answer via "Other", not a listed option)' : ""
        }`,
    ),
  ].join("\n");
}
