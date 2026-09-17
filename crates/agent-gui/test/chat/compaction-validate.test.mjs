import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const validateModule = loader.loadModule("src/lib/chat/compaction/validate.ts");

const { validateCompactionSummary, parseCompactionSummaryXml, buildVerificationSignals } =
  validateModule;

function payloadWith(messages = [], nextUserMessage) {
  return {
    compaction_reason: { trigger: "t", context_tokens: 1, threshold: 1 },
    system_prompt: "p",
    previous_summary: null,
    active_segment_messages: messages,
    next_user_message: nextUserMessage,
  };
}

const EMPTY_PAYLOAD = payloadWith();

function summaryXml({ task = "Fix the bug", artifacts = "- [file] src/app.ts | modified" } = {}) {
  return `<summary>
<task>${task}</task>
<state>Bug located in parser, fix applied ${"detail ".repeat(60)}</state>
<artifacts>
${artifacts}
</artifacts>
<next_steps>
1. run the tests
</next_steps>
</summary>`;
}

test("a well-formed summary validates and is formatted into markdown sections", () => {
  const { summaryText } = validateCompactionSummary(summaryXml(), 10_000, EMPTY_PAYLOAD);
  assert.ok(summaryText.startsWith("## Task\nFix the bug"));
  assert.ok(summaryText.includes("## Current State"));
  assert.ok(summaryText.includes("## Artifacts"));
  assert.ok(summaryText.includes("## Next Steps"));
});

test("markdown fences are stripped before parsing", () => {
  const fenced = "```xml\n" + summaryXml() + "\n```";
  const parsed = parseCompactionSummaryXml(fenced);
  assert.equal(parsed.task, "Fix the bug");
});

test("missing required tags fail validation", () => {
  assert.throws(
    () => validateCompactionSummary("<summary><task>t</task></summary>", 10_000, EMPTY_PAYLOAD),
    /missing <state>.*missing <next_steps>.*missing <artifacts>/,
  );
});

test("artifact lines must follow the [kind] ref | status format", () => {
  assert.throws(
    () =>
      validateCompactionSummary(
        summaryXml({ artifacts: "- just some prose without the format" }),
        10_000,
        EMPTY_PAYLOAD,
      ),
    /no valid artifact lines/,
  );

  // Allow through when valid lines are mixed in (lenient on intake, strict on instruction).
  validateCompactionSummary(
    summaryXml({ artifacts: "- odd line\n- [file] src/app.ts | modified" }),
    10_000,
    EMPTY_PAYLOAD,
  );
});

test("a large source must not produce a trivially short summary", () => {
  const short = `<summary><task>t</task><state>s</state><artifacts>
- [file] a.ts | read
</artifacts><next_steps>1. x</next_steps></summary>`;
  assert.throws(() => validateCompactionSummary(short, 10_000, EMPTY_PAYLOAD), /summary too short/);
  // Small conversations are not subject to the minimum-length constraint.
  validateCompactionSummary(short, 200, EMPTY_PAYLOAD);
});

test("verification signals are extracted from recent payload messages", () => {
  const payload = payloadWith(
    [
      {
        index: 0,
        role: "toolResult",
        timestamp: null,
        toolName: "Bash",
        toolCallId: "t",
        isError: false,
        content: "compiled crates/agent-gui/src/lib/chat/compaction/policy.ts",
      },
    ],
    "please run cargo build --release next",
  );
  const signals = buildVerificationSignals(payload);
  assert.ok(signals.some((signal) => signal.includes("cargo build --release")));
  assert.ok(
    signals.some((signal) => signal.includes("crates/agent-gui/src/lib/chat/compaction/policy.ts")),
  );
});

test("summaries that drop every recent technical reference fail the verification pass", () => {
  const payload = payloadWith([
    {
      index: 0,
      role: "user",
      timestamp: null,
      content: "please edit src/lib/chat/history/chatHistory.ts",
    },
  ]);

  assert.throws(
    () => validateCompactionSummary(summaryXml(), 10_000, payload),
    /verification pass missing recent technical refs/,
  );

  validateCompactionSummary(
    summaryXml({ artifacts: "- [file] src/lib/chat/history/chatHistory.ts | modified" }),
    10_000,
    payload,
  );
});

// The signal-rich bar: with 4+ extracted signals a single verbatim match is a weak
// hallucination guard, so two matches are required; signal-poor payloads (short technical
// turns, < 4 signals) keep the one-match floor to avoid false failures.
test("verification pass: signal-rich payloads must retain two of their signals", () => {
  const signalsPayload = (pathsText) =>
    payloadWith([
      {
        index: 0,
        role: "toolResult",
        timestamp: null,
        toolName: "Bash",
        toolCallId: "t",
        isError: false,
        content: pathsText,
      },
    ]);
  const oneArtifactMatch = summaryXml({ artifacts: "- [file] a/b.ts | modified" });
  const twoArtifactMatches = summaryXml({
    artifacts: "- [file] a/b.ts | modified\n- [file] c/d.ts | read",
  });

  // 3 signals, 1 match: still enough.
  validateCompactionSummary(
    oneArtifactMatch,
    10_000,
    signalsPayload("touch a/b.ts and c/d.ts plus e/f.ts"),
  );

  // 4 signals, 1 match: no longer enough.
  assert.throws(
    () =>
      validateCompactionSummary(
        oneArtifactMatch,
        10_000,
        signalsPayload("touch a/b.ts and c/d.ts plus e/f.ts and g/h.ts"),
      ),
    /verification pass missing recent technical refs/,
  );

  // 4 signals, 2 matches: passes.
  validateCompactionSummary(
    twoArtifactMatches,
    10_000,
    signalsPayload("touch a/b.ts and c/d.ts plus e/f.ts and g/h.ts"),
  );
});

// The merged file ledger is derived client-side from tool calls and deliberately never sent to
// the summarizer, so it serves as a deterministic witness: when recent touched files are known
// and none appears in the summary, the summary lost its file context wholesale.
test("file ledger cross-check: a summary referencing a ledger path passes", () => {
  validateCompactionSummary(
    summaryXml({ artifacts: "- [file] src/lib/chat/history/chatHistory.ts | modified" }),
    10_000,
    EMPTY_PAYLOAD,
    { readFiles: [], modifiedFiles: ["src/lib/chat/history/chatHistory.ts"] },
  );
});

test("file ledger cross-check: an otherwise-valid summary that drops every ledger path fails", () => {
  assert.throws(
    () =>
      validateCompactionSummary(summaryXml(), 10_000, EMPTY_PAYLOAD, {
        readFiles: [],
        modifiedFiles: ["src/lib/chat/history/chatHistory.ts"],
      }),
    /file ledger cross-check/,
  );

  // An empty ledger cannot witness anything: the check is skipped.
  validateCompactionSummary(summaryXml(), 10_000, EMPTY_PAYLOAD, {
    readFiles: [],
    modifiedFiles: [],
  });
  validateCompactionSummary(summaryXml(), 10_000, EMPTY_PAYLOAD);
});
