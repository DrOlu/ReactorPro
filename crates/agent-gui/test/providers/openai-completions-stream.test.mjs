import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistant(content, stopReason = "stop", errorMessage) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "compatible-model",
    usage: createUsage(),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 1,
  };
}

function createTerminalSource(assistant, events = [], terminalType = "done") {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...assistant, content: [] } };
      for (const event of events) yield event;
      yield terminalType === "done"
        ? { type: "done", reason: assistant.stopReason, message: assistant }
        : { type: "error", reason: "error", error: assistant };
    },
    async result() {
      return assistant;
    },
  };
}

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function createModel() {
  return {
    id: "compatible-model",
    name: "compatible-model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "http://127.0.0.1:18080/proxy/codex/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
    compat: { supportsFinishReason: false },
  };
}

test("openai-completions: upstream finish-reason compatibility preserves usable text", async () => {
  const assistant = createAssistant([{ type: "text", text: "complete answer" }]);
  const loader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai/api/openai-completions": {
        stream() {
          return createTerminalSource(assistant, [
            {
              type: "text_delta",
              contentIndex: 0,
              delta: "complete answer",
              partial: assistant,
            },
            {
              type: "text_end",
              contentIndex: 0,
              content: "complete answer",
              partial: assistant,
            },
          ]);
        },
      },
    },
  });
  const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");

  const stream = streamSimpleByApi(createModel(), { messages: [] }, {
    streamRetry: { disabled: true },
  });
  const events = await collectEvents(stream);
  const result = await stream.result();

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_delta", "text_end", "done"],
  );
  assert.equal(result.stopReason, "stop");
  assert.equal(result.errorMessage, undefined);
  assert.equal(result.content[0].text, "complete answer");
});

test("openai-completions: empty successful stream is rejected", async () => {
  const loader = createTsModuleLoader();
  const { rejectEmptyOpenAICompletionsResponse } = loader.loadModule(
    "src/lib/providers/runtime/openAICompletionsStream.ts",
  );
  const assistant = createAssistant([]);
  const stream = rejectEmptyOpenAICompletionsResponse(createTerminalSource(assistant));
  const events = await collectEvents(stream);

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "error"],
  );
  assert.equal((await stream.result()).stopReason, "error");
  // The wording must keep matching pi-ai's retryable pattern, otherwise an empty response kills
  // a whole turn instead of being retried.
  assert.match((await stream.result()).errorMessage, /provider returned error/i);
});

test("openai-completions: empty response error stays retryable for withStreamRetry", async () => {
  const { isRetryableAssistantError } = await import("@earendil-works/pi-ai");
  const loader = createTsModuleLoader();
  const { rejectEmptyOpenAICompletionsResponse } = loader.loadModule(
    "src/lib/providers/runtime/openAICompletionsStream.ts",
  );
  const stream = rejectEmptyOpenAICompletionsResponse(
    createTerminalSource(createAssistant([])),
  );
  await collectEvents(stream);

  // An empty response is upstream jitter and must be absorbed by the unified retry chain; if the
  // wording drifts from pi-ai's pattern table, a single empty reply ends the whole conversation.
  assert.equal(isRetryableAssistantError(await stream.result()), true);
});

test("openai-completions: truncated and aborted turns are never rewritten as empty", async () => {
  const loader = createTsModuleLoader();
  const { rejectEmptyOpenAICompletionsResponse } = loader.loadModule(
    "src/lib/providers/runtime/openAICompletionsStream.ts",
  );

  // length = output truncated by the token limit, a real termination semantic (the downstream
  // rejects possibly-truncated tool calls based on it); aborted = the user actively stopped.
  // Neither may be rewritten as "empty response".
  for (const stopReason of ["length", "aborted"]) {
    const stream = rejectEmptyOpenAICompletionsResponse(
      createTerminalSource(createAssistant([], stopReason)),
    );
    const events = await collectEvents(stream);
    assert.equal(events.at(-1).type, "done", stopReason);
    assert.equal((await stream.result()).stopReason, stopReason);
  }
});

test("openai-completions: thinking-only turns are not treated as empty", async () => {
  const loader = createTsModuleLoader();
  const { rejectEmptyOpenAICompletionsResponse } = loader.loadModule(
    "src/lib/providers/runtime/openAICompletionsStream.ts",
  );
  // A reasoning model may burn the whole budget on thinking; retrying would only burn it again,
  // so this is not an empty response.
  const assistant = createAssistant([{ type: "thinking", thinking: "long chain" }]);
  const stream = rejectEmptyOpenAICompletionsResponse(createTerminalSource(assistant));
  const events = await collectEvents(stream);

  assert.equal(events.at(-1).type, "done");
  assert.equal((await stream.result()).stopReason, "stop");
});

test("openai-completions: unrelated errors are never recovered", async () => {
  const loader = createTsModuleLoader();
  const { rejectEmptyOpenAICompletionsResponse } = loader.loadModule(
    "src/lib/providers/runtime/openAICompletionsStream.ts",
  );
  const assistant = createAssistant(
    [{ type: "text", text: "partial" }],
    "error",
    "503 service unavailable",
  );
  const stream = rejectEmptyOpenAICompletionsResponse(
    createTerminalSource(assistant, [], "error"),
  );
  const events = await collectEvents(stream);

  assert.equal(events.at(-1).type, "error");
  assert.equal((await stream.result()).stopReason, "error");
});

test("openai-completions: inferred tool calls retain truncation guard coverage", async () => {
  const loader = createTsModuleLoader();
  const { rejectEmptyOpenAICompletionsResponse } = loader.loadModule(
    "src/lib/providers/runtime/openAICompletionsStream.ts",
  );
  const { wrapStreamWithToolCallArgumentGuard } = loader.loadModule(
    "src/lib/chat/runner/toolCallArgumentGuard.ts",
  );
  const toolCall = {
    type: "toolCall",
    id: "call_1",
    name: "read_file",
    arguments: { path: "/tmp" },
  };
  const assistant = createAssistant([toolCall], "toolUse");
  const source = createTerminalSource(assistant, [
    { type: "toolcall_start", contentIndex: 0, partial: assistant },
    {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"path":"/tmp',
      partial: assistant,
    },
    { type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant },
  ]);
  const incomplete = [];
  const validated = rejectEmptyOpenAICompletionsResponse(source);
  const guarded = wrapStreamWithToolCallArgumentGuard(validated, (call, reason) => {
    incomplete.push({ call, reason });
  });
  const events = await collectEvents(guarded);
  const result = await guarded.result();

  assert.equal(events.at(-1).type, "done");
  assert.equal(result.stopReason, "toolUse");
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].call.id, "call_1");
  assert.match(incomplete[0].reason, /before it was complete/);
});

test("openai-completions: model compat infers finish reasons only for non-official endpoints", () => {
  const loader = createTsModuleLoader();
  const { createModelFromConfig } = loader.loadModule(
    "src/lib/providers/runtime/modelFactory.ts",
  );
  const compatible = createModelFromConfig(
    "codex",
    "compatible-model",
    "https://relay.example.com/v1",
    "openai-completions",
  );
  const official = createModelFromConfig(
    "codex",
    "compatible-model",
    "http://127.0.0.1:18080/proxy/codex/v1",
    "openai-completions",
    undefined,
    "https://api.openai.com/v1",
  );

  assert.equal(compatible.compat.supportsFinishReason, false);
  assert.notEqual(official.compat?.supportsFinishReason, false);
});
