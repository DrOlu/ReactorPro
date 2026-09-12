import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { ASK_USER_QUESTION_TIMEOUT_MS } = createTsModuleLoader().loadModule(
  "@liveagent/ui/lib/chat/askUserQuestion.ts",
);

const questions = [
  {
    id: "choice",
    header: "Choice",
    prompt: "Choose one option",
    options: [
      { label: "First", description: "The first option" },
      { label: "Second", description: "The second option", recommended: true },
    ],
  },
];

function createHookHarness(initialState = {}) {
  const states = [];
  const setters = [];
  let stateIndex = 0;
  const stateOverrides = new Map([
    [2, initialState.draftSelections ?? {}],
    [3, initialState.customSelected ?? {}],
    [4, initialState.customTexts ?? {}],
    [5, initialState.submitting ?? false],
  ]);
  // useAnswerCountdown's remainingMs (driven by interval ticks after mount);
  // the test uses it to simulate "the adopted deadline subsequently going to zero".
  if (initialState.remainingMs !== undefined) {
    stateOverrides.set(8, initialState.remainingMs);
  }

  const react = {
    useState(initialValue) {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = stateOverrides.has(index)
          ? stateOverrides.get(index)
          : typeof initialValue === "function"
            ? initialValue()
            : initialValue;
      }
      const setState = (next) => {
        setters.push(index);
        states[index] = typeof next === "function" ? next(states[index]) : next;
      };
      return [states[index], setState];
    },
    useMemo(factory) {
      return factory();
    },
    useEffect() {},
    useLayoutEffect() {},
    useRef(initialValue) {
      return { current: initialValue };
    },
  };

  return {
    react,
    setters,
    render(run) {
      stateIndex = 0;
      return run();
    },
  };
}

function createCardHarness(initialState = {}) {
  const hooks = createHookHarness(initialState);
  const loader = createTsModuleLoader({
    mocks: {
      react: hooks.react,
      "@liveagent/ui/i18n/index": {
        useLocale() {
          return { t: (key) => key };
        },
      },
      "@liveagent/ui/components/IconSet": {
        Check: (props) => ({ type: "Check", props }),
        ChevronDown: (props) => ({ type: "ChevronDown", props }),
        ChevronUp: (props) => ({ type: "ChevronUp", props }),
      },
      "@liveagent/ui/components/ui/badge": { Badge: BadgeStub },
      "@liveagent/ui/components/ui/button": { Button: ButtonStub },
      "@liveagent/ui/components/ui/input": { Input: InputStub },
      "@liveagent/ui/lib/shared/utils": {
        cn(...values) {
          return values.filter(Boolean).join(" ");
        },
      },
    },
  });
  const { AskUserQuestionCard } = loader.loadModule(
    "@liveagent/ui/components/chat/AskUserQuestionCard.tsx",
  );
  return {
    hooks,
    render(props) {
      return hooks.render(() =>
        AskUserQuestionCard({
          questions,
          interactive: true,
          ...props,
        }),
      );
    },
  };
}

// After the card switched to shared base components, the real implementation uses React.forwardRef,
// but this file's React stub lacks that API, so it is stubbed as well. Note that the loader's JSX
// transform does not call components; it puts the component reference directly into node.type, so
// queries can only compare by reference, not by name string.
const BadgeStub = (props) => ({ type: "Badge", props });
const ButtonStub = (props) => ({ type: "Button", props });
const InputStub = (props) => ({ type: "Input", props });

function findAll(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, matches);
    return matches;
  }
  if (!node || typeof node !== "object") return matches;
  if (predicate(node)) matches.push(node);
  findAll(node.props?.children, predicate, matches);
  return matches;
}

function findSubmitButton(tree) {
  // The bottom buttons now use the shared Button component; the label is the last item of the children
  // array (icon nodes come before it), so matching on children equality is no longer possible.
  return findAll(tree, (node) => {
    if (node.type !== ButtonStub) return false;
    const children = [node.props?.children].flat(Infinity);
    return children.some((child) =>
      ["chat.askUser.submit", "chat.askUser.submitting", "chat.askUser.continue"].includes(child),
    );
  })[0];
}

function treeText(node) {
  if (Array.isArray(node)) return node.map(treeText).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return treeText(node.props?.children);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("card surface avoids an outer shadow that the collapse viewport would clip", () => {
  const card = createCardHarness();
  const tree = card.render({ deadlineAt: Date.now() + 60_000 });
  const surface = findAll(
    tree,
    (node) =>
      node.type === "div" &&
      typeof node.props?.className === "string" &&
      node.props.className.includes("rounded-xl") &&
      node.props.className.includes("border-border/60"),
  )[0];

  assert.ok(surface);
  // The card now uses design tokens (stroke + faint background) and no longer has frosted glass or inset
  // highlights; the key constraint is unchanged: there must be no outer shadow that the collapsed viewport would clip.
  assert.doesNotMatch(surface.props.className, /shadow-\[/);
  assert.doesNotMatch(surface.props.className, /backdrop-blur/);
});

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("expired countdown disables options, custom input, and submit before tool_result arrives", async () => {
  let submitCalls = 0;
  const card = createCardHarness({
    customSelected: { choice: true },
    customTexts: { choice: "My answer" },
    // The adopted deadline (still within the window at mount) goes to zero with the interval ticks.
    remainingMs: 0,
  });
  const tree = card.render({
    deadlineAt: Date.now() + 60_000,
    onSubmit: async () => {
      submitCalls += 1;
      return { ok: true };
    },
  });

  const optionButtons = findAll(
    tree,
    (node) =>
      node.type === "button" && node.props?.role === "radio" && !node.props["aria-label"],
  );
  assert.equal(optionButtons.length, 2);
  assert.equal(optionButtons.every((button) => button.props.disabled === true), true);
  assert.equal(optionButtons.every((button) => button.props.className.includes("opacity-50")), true);

  const customOption = findAll(
    tree,
    (node) =>
      node.type === "button" && node.props?.role === "radio" && node.props["aria-label"],
  )[0];
  // The custom option now shares the same disabled semantics as the options above it.
  assert.equal(customOption.props.disabled, true);

  const customInput = findAll(tree, (node) => node.type === InputStub)[0];
  assert.ok(customInput);
  assert.equal(customInput.props.disabled, true);

  const submitButton = findSubmitButton(tree);
  assert.ok(submitButton);
  assert.equal(submitButton.props.disabled, true);
  const setterCountBeforeBlockedActions = card.hooks.setters.length;
  optionButtons[0].props.onClick();
  customOption.props.onClick();
  submitButton.props.onClick();
  customInput.props.onKeyDown({
    key: "Enter",
    stopPropagation() {},
    preventDefault() {},
  });
  await flushPromises();
  assert.equal(card.hooks.setters.length, setterCountBeforeBlockedActions);
  assert.equal(submitCalls, 0);
});

// The deadline is stamped by the desktop clock while the countdown reads the local clock: when the
// offset is out of bounds it must fall back to the mount approximation, and must not lock a still-pending
// question card the moment it mounts (expired submissions are authoritatively rejected by the desktop pending table).
test("a deadline already past at mount is distrusted and the pending card stays answerable", async () => {
  const submitted = [];
  const card = createCardHarness({ draftSelections: { choice: "Second" } });
  const tree = card.render({
    // The local clock is ahead of the desktop stamp clock: at mount the deadline appears to have long passed.
    deadlineAt: Date.now() - 5 * 60 * 1000,
    onSubmit: async (answers) => {
      submitted.push(answers);
      return { ok: true };
    },
  });

  const optionButtons = findAll(
    tree,
    (node) =>
      node.type === "button" && node.props?.role === "radio" && !node.props["aria-label"],
  );
  assert.equal(optionButtons.length, 2);
  assert.equal(optionButtons.every((button) => button.props.disabled === false), true);
  const customOption = findAll(
    tree,
    (node) =>
      node.type === "button" && node.props?.role === "radio" && node.props["aria-label"],
  )[0];
  assert.equal(customOption.props.disabled, false);

  const submitButton = findSubmitButton(tree);
  assert.equal(submitButton.props.disabled, false);
  submitButton.props.onClick();
  await flushPromises();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0][0].selectedLabel, "Second");
});

test("a deadline beyond the full answer window is distrusted and clamps the countdown", () => {
  const card = createCardHarness();
  const tree = card.render({
    // The local clock is behind the desktop stamp clock: the deadline appears far beyond the full answer window.
    deadlineAt: Date.now() + ASK_USER_QUESTION_TIMEOUT_MS + 5 * 60 * 1000,
    onSubmit: async () => ({ ok: true }),
  });

  const optionButtons = findAll(
    tree,
    (node) =>
      node.type === "button" && node.props?.role === "radio" && !node.props["aria-label"],
  );
  assert.equal(optionButtons.every((button) => button.props.disabled === false), true);
  // The countdown displays the full window using the mount approximation rather than treating the offset as remaining time.
  assert.match(treeText(tree), /(?:3:00|2:59) chat\.askUser\.timeoutHint/);
});

test("a complete answer before the deadline submits the selected non-first option", async () => {
  const submitted = [];
  const card = createCardHarness({ draftSelections: { choice: "Second" } });
  const tree = card.render({
    deadlineAt: Date.now() + 60_000,
    onSubmit: async (answers) => {
      submitted.push(answers);
      return { ok: true };
    },
  });

  const optionButtons = findAll(
    tree,
    (node) =>
      node.type === "button" && node.props?.role === "radio" && !node.props["aria-label"],
  );
  assert.equal(optionButtons.every((button) => button.props.disabled === false), true);
  const submitButton = findSubmitButton(tree);
  assert.equal(submitButton.props.disabled, false);
  submitButton.props.onClick();
  await flushPromises();

  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0], [
    {
      questionId: "choice",
      prompt: "Choose one option",
      selectedLabel: "Second",
    },
  ]);
});

test("multi-question selection stays put until Continue and preserves a mixed custom payload", async () => {
  const multiQuestions = [
    {
      id: "q1",
      header: "One",
      prompt: "Question one",
      options: [{ label: "A1" }, { label: "A2" }],
    },
    {
      id: "q2",
      header: "Two",
      prompt: "Question two",
      options: [{ label: "B1" }, { label: "B2" }],
    },
    {
      id: "q3",
      header: "Three",
      prompt: "Question three",
      options: [{ label: "C1" }, { label: "C2" }],
    },
  ];
  const submitted = [];
  const card = createCardHarness();
  const props = {
    questions: multiQuestions,
    deadlineAt: Date.now() + 60_000,
    onSubmit: async (answers) => {
      submitted.push(answers);
      return { ok: true };
    },
  };

  let tree = card.render(props);
  assert.equal(
    findAll(
      tree,
      (node) =>
        node.type === "button" &&
        ["chat.askUser.previousQuestion", "chat.askUser.nextQuestion"].includes(
          node.props?.["aria-label"],
        ),
    ).length,
    2,
  );
  const optionRadios = (node) =>
    node.type === "button" && node.props?.role === "radio" && !node.props["aria-label"];

  // Selection no longer auto-advances: after choosing, you stay on the current question, and paging is driven only by "Continue".
  findAll(tree, optionRadios)[1].props.onClick();
  tree = card.render(props);
  assert.match(treeText(tree), /Question one/);
  assert.doesNotMatch(treeText(tree), /Question two/);

  findSubmitButton(tree).props.onClick();
  tree = card.render(props);
  assert.match(treeText(tree), /Question two/);

  findAll(tree, optionRadios)[0].props.onClick();
  tree = card.render(props);
  assert.match(treeText(tree), /Question two/);

  findSubmitButton(tree).props.onClick();
  tree = card.render(props);
  assert.match(treeText(tree), /Question three/);

  // The custom-answer input is always present, and typing itself represents selecting that option (no need to click the radio first).
  const customInput = findAll(tree, (node) => node.type === InputStub)[0];
  assert.ok(customInput);
  customInput.props.onChange({ currentTarget: { value: "Typed third answer" } });

  tree = card.render(props);
  const submitButton = findSubmitButton(tree);
  assert.equal(submitButton.props.disabled, false);
  submitButton.props.onClick();
  await flushPromises();

  assert.deepEqual(submitted, [
    [
      { questionId: "q1", prompt: "Question one", selectedLabel: "A2" },
      { questionId: "q2", prompt: "Question two", selectedLabel: "B1" },
      {
        questionId: "q3",
        prompt: "Question three",
        selectedLabel: "Typed third answer",
        custom: true,
      },
    ],
  ]);
});

test("submitting state blocks a second click until the first request settles", async () => {
  const gate = deferred();
  let submitCalls = 0;
  const card = createCardHarness({ draftSelections: { choice: "Second" } });
  const props = {
    deadlineAt: Date.now() + 60_000,
    onSubmit: async () => {
      submitCalls += 1;
      await gate.promise;
      return { ok: true };
    },
  };

  findSubmitButton(card.render(props)).props.onClick();
  await Promise.resolve();
  const submittingButton = findSubmitButton(card.render(props));
  assert.equal(submittingButton.props.disabled, true);
  assert.equal(submittingButton.props.children, "chat.askUser.submitting");
  submittingButton.props.onClick();
  assert.equal(submitCalls, 1);

  gate.resolve();
  await flushPromises();
  assert.equal(findSubmitButton(card.render(props)).props.disabled, false);
});

test("settled and cancelled cards remain read-only", () => {
  const settledCard = createCardHarness();
  const settled = settledCard.render({
    deadlineAt: Date.now() + 60_000,
    answers: [
      {
        questionId: "choice",
        prompt: "Choose one option",
        selectedLabel: "Second",
      },
    ],
  });
  assert.equal(
    findAll(settled, (node) => node.type === "button" && node.props?.role === "radio").every(
      (button) => button.props.disabled === true,
    ),
    true,
  );
  assert.equal(findSubmitButton(settled), undefined);

  const cancelledCard = createCardHarness();
  const cancelled = cancelledCard.render({
    deadlineAt: Date.now() + 60_000,
    cancelled: true,
  });
  assert.equal(
    findAll(cancelled, (node) => node.type === "button" && node.props?.role === "radio").every(
      (button) => button.props.disabled === true,
    ),
    true,
  );
  assert.equal(findSubmitButton(cancelled), undefined);
});
