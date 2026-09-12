import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { detectCompactionSummaryLanguage } = loader.loadModule(
  "src/lib/chat/compaction/summaryLanguage.ts",
);
const { buildCompactionSystemPrompt, COMPACTION_SYSTEM_PROMPT } = loader.loadModule(
  "src/lib/chat/compaction/summaryPrompt.ts",
);

function payloadWith({ userTexts = [], nextUserMessage } = {}) {
  return {
    compaction_reason: { trigger: "test", context_tokens: 0, threshold: 0 },
    system_prompt: "",
    previous_summary: null,
    active_segment_messages: userTexts.map((content, index) => ({
      index,
      role: "user",
      timestamp: index,
      content,
    })),
    next_user_message: nextUserMessage,
  };
}

test("english conversations keep the default english summary", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({ userTexts: ["Please refactor the config loader and add tests."] }),
    ),
    undefined,
  );
});

test("chinese-dominant conversations are detected as Chinese", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({ userTexts: ["\u5E2E\u6211\u91CD\u6784\u8FD9\u4E2A\u914D\u7F6E\u52A0\u8F7D\u5668\uFF0C\u7136\u540E\u8865\u4E0A\u5355\u5143\u6D4B\u8BD5\u3002"] }),
    ),
    "Chinese",
  );
});

test("mixed chinese with english identifiers still detects Chinese", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({
        userTexts: ["\u628A src/lib/config.ts \u91CC\u7684 loadConfig \u6539\u6210\u5F02\u6B65\u5B9E\u73B0\uFF0C\u6CE8\u610F\u4FDD\u7559 retry \u903B\u8F91\u3002"],
      }),
    ),
    "Chinese",
  );
});

test("japanese conversations are detected as Japanese", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({ userTexts: ["\u3053\u306E\u8A2D\u5B9A\u30ED\u30FC\u30C0\u30FC\u3092\u30EA\u30D5\u30A1\u30AF\u30BF\u30EA\u30F3\u30B0\u3057\u3066\u30C6\u30B9\u30C8\u3092\u8FFD\u52A0\u3057\u3066\u304F\u3060\u3055\u3044\u3002"] }),
    ),
    "Japanese",
  );
});

test("korean conversations are detected as Korean", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({ userTexts: ["\uC774 \uC124\uC815 \uB85C\uB354\uB97C \uB9AC\uD329\uD130\uB9C1\uD558\uACE0 \uD14C\uC2A4\uD2B8\uB97C \uCD94\uAC00\uD574 \uC8FC\uC138\uC694."] }),
    ),
    "Korean",
  );
});

test("next_user_message participates in detection", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({ userTexts: [], nextUserMessage: "\u7EE7\u7EED\uFF0C\u628A\u5269\u4E0B\u7684\u6A21\u5757\u4E5F\u8FC1\u79FB\u5B8C\u3002" }),
    ),
    "Chinese",
  );
});

test("tiny samples fall back to the english default", () => {
  assert.equal(detectCompactionSummaryLanguage(payloadWith({ userTexts: ["\u597D"] })), undefined);
  assert.equal(detectCompactionSummaryLanguage(payloadWith({ userTexts: [] })), undefined);
});

test("assistant/tool messages do not affect detection", () => {
  const payload = payloadWith({ userTexts: ["Run the tests again please."] });
  payload.active_segment_messages.push({
    index: 99,
    role: "assistant",
    timestamp: 99,
    stopReason: "stop",
    text: "\u8FD9\u91CC\u662F\u4E00\u5927\u6BB5\u52A9\u624B\u8F93\u51FA\u7684\u4E2D\u6587\u5185\u5BB9\uFF0C\u4E0D\u5E94\u53C2\u4E0E\u8BED\u8A00\u5224\u5B9A\u3002".repeat(10),
  });
  assert.equal(detectCompactionSummaryLanguage(payload), undefined);
});

test("buildCompactionSystemPrompt defaults to the english mandate", () => {
  assert.ok(COMPACTION_SYSTEM_PROMPT.includes("You MUST write the summary in English"));
  assert.equal(buildCompactionSystemPrompt(), COMPACTION_SYSTEM_PROMPT);
});

test("buildCompactionSystemPrompt embeds the detected language directive", () => {
  const prompt = buildCompactionSystemPrompt("Chinese");
  assert.ok(prompt.includes("You MUST write the free-text summary content in Chinese"));
  assert.ok(!prompt.includes("You MUST write the summary in English"));
  assert.ok(prompt.includes("CONTEXT CHECKPOINT"));
  assert.ok(prompt.includes("<summary>"), "XML schema must stay intact");
});

test("summarizeConversation sends the language directive for chinese payloads", async () => {
  const { summarizeConversation } = loader.loadModule("src/lib/chat/compaction/summarizer.ts");
  const validXml = `<summary>
<task>\u91CD\u6784\u538B\u7F29\u5B50\u7CFB\u7EDF</task>
<state>\u5DF2\u4FEE\u6539 src/app.ts\uFF0C${"\u7EC6\u8282\u8BF4\u660E\u3002".repeat(60)}</state>
<artifacts>
- [file] src/app.ts | modified | \u91CD\u5199\u5165\u53E3
</artifacts>
<next_steps>
1. \u63A5\u597D controller
</next_steps>
</summary>`;
  const calls = [];
  const result = await summarizeConversation({
    providerId: "claude_code",
    model: "claude-x",
    runtime: { baseUrl: "https://example", apiKey: "k" },
    payload: {
      compaction_reason: { trigger: "test", context_tokens: 190_000, threshold: 152_000 },
      system_prompt: "base prompt",
      previous_summary: null,
      active_segment_messages: [
        { index: 0, role: "user", timestamp: 1, content: "\u8BF7\u5E2E\u6211\u4FEE\u6539 src/app.ts \u7684\u5165\u53E3\u903B\u8F91\u3002" },
        {
          index: 1,
          role: "assistant",
          timestamp: 2,
          stopReason: "stop",
          text: "\u5DF2\u4FEE\u6539 src/app.ts\u3002",
        },
      ],
    },
    complete: async (params) => {
      calls.push(params);
      return {
        role: "assistant",
        content: [{ type: "text", text: validXml }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-real",
        stopReason: "stop",
        usage: {
          input: 5000,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5300,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 1234,
        responseId: "resp-1",
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].context.systemPrompt.includes(
      "You MUST write the free-text summary content in Chinese",
    ),
  );
  assert.ok(result.summaryText.includes("\u91CD\u6784\u538B\u7F29\u5B50\u7CFB\u7EDF"));
});
