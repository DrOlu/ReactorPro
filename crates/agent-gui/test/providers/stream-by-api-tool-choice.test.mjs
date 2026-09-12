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

function createSourceStream() {
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-5.6",
    usage: createUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const events = [
    { type: "start", partial: { ...assistant, content: [] } },
    { type: "done", reason: "stop", message: assistant },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return assistant;
    },
  };
}

function createOpenAICompletionsModel() {
  return {
    id: "gpt-5.6",
    name: "gpt-5.6",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://relay.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
  };
}

function createLoaderCapturingOptions(capturedOptions) {
  return createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai/api/openai-completions": {
        stream(_model, _context, options) {
          capturedOptions.push(options);
          return createSourceStream();
        },
      },
    },
  });
}

async function streamOnce(context, toolChoice) {
  const capturedOptions = [];
  const loader = createLoaderCapturingOptions(capturedOptions);
  const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");
  const stream = streamSimpleByApi(createOpenAICompletionsModel(), context, {
    apiKey: "test-key",
    toolChoice,
  });
  await stream.result();
  assert.equal(capturedOptions.length, 1);
  return capturedOptions[0];
}

const echoTool = {
  name: "echo",
  description: "Echo tool",
  parameters: { type: "object", properties: {} },
};

test("openai-completions: a request without tools does not send tool_choice (text-only paths such as compaction summaries)", async () => {
  const options = await streamOnce(
    { messages: [{ role: "user", content: "compaction payload", timestamp: 1 }] },
    "none",
  );
  assert.equal(options.toolChoice, undefined);
});

test("openai-completions: a request without tools sends nothing even when toolChoice=auto", async () => {
  const options = await streamOnce(
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    "auto",
  );
  assert.equal(options.toolChoice, undefined);
});

test("openai-completions: a request with tools keeps tool_choice=none", async () => {
  const options = await streamOnce(
    {
      tools: [echoTool],
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    },
    "none",
  );
  assert.equal(options.toolChoice, "none");
});

test("openai-completions: a request with tools maps any to required", async () => {
  const options = await streamOnce(
    {
      tools: [echoTool],
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    },
    "any",
  );
  assert.equal(options.toolChoice, "required");
});
