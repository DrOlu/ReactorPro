import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// LLM seam refactor (one of the golden baselines): whole-snapshot of the final wire payload for five protocols.
//
// Existing provider tests assert individual behaviors field by field (tool_choice, cache breakpoints, thinking
// levels...); this file's job is different -- it locks down "fixed input -> complete request body" per protocol,
// field by field, as the "behavior-equivalent" benchmark for later seam refactors (PR-1 adapter wrapping /
// PR-3 interceptor registration). The snapshots are intentionally written as explicit object literals rather than
// .snapshot files: diffs are directly readable, and accidental re-recording is impossible.
//
// Capture channel: goes through the real pi-ai stream() (along with all finalizeProviderStreamOptions payload
// middleware), intercepts the final wire format in onPayload, then throws to abort -- zero network contact.
// ============================================================================

const realAnthropic = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
    import.meta.url,
  ).href
);
const realCompletions = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js",
    import.meta.url,
  ).href
);
const realResponses = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js",
    import.meta.url,
  ).href
);
const realGoogle = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js",
    import.meta.url,
  ).href
);

const loader = createTsModuleLoader({
  mocks: {
    "@earendil-works/pi-ai/api/anthropic-messages": { stream: realAnthropic.stream },
    "@earendil-works/pi-ai/api/openai-completions": { stream: realCompletions.stream },
    "@earendil-works/pi-ai/api/openai-responses": { stream: realResponses.stream },
    "@earendil-works/pi-ai/api/google-generative-ai": { stream: realGoogle.stream },
  },
});

const { createModelFromConfig } = loader.loadModule("src/lib/providers/runtime/modelFactory.ts");
const { streamSimpleByApi } = loader.loadModule("src/lib/providers/runtime/streamByApi.ts");
const { finalizeProviderStreamOptions } = loader.loadModule(
  "src/lib/providers/runtime/payloadPipeline.ts",
);

// Fixed session id: all session-related fields in the payload (prompt_cache_key/metadata.user_id)
// derive from it, guaranteeing snapshot determinism.
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

const TOOLS = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function buildContext({ withTools = true } = {}) {
  return {
    systemPrompt: "You are a precise assistant.",
    messages: [{ role: "user", content: "hello world", timestamp: 1 }],
    ...(withTools ? { tools: TOOLS } : {}),
  };
}

/**
 * Goes through the real assembly chain (finalizeProviderStreamOptions -> streamSimpleByApi -> real
 * pi-ai stream), intercepts the final wire payload at the end of the onPayload chain, then aborts the request.
 */
async function captureWirePayload(providerId, model, context, baseOptions) {
  let captured;
  const finalized = finalizeProviderStreamOptions({
    providerId,
    baseUrl: model.baseUrl,
    options: baseOptions,
    context,
    model,
  });
  const prevOnPayload = finalized.onPayload;
  const stream = streamSimpleByApi(model, context, {
    ...finalized,
    onPayload: async (payload, m) => {
      captured = prevOnPayload ? ((await prevOnPayload(payload, m)) ?? payload) : payload;
      throw new Error("__capture_stop__");
    },
  });
  try {
    await stream.result();
  } catch {
    // Throwing in onPayload to abort the request is expected.
  }
  assert.ok(captured, `expected wire payload capture for ${model.id}`);
  // JSON round-trip normalization: goldens lock the on-the-wire JSON shape; keys whose value is undefined
  // (e.g. prompt_cache_retention on the responses path) do not exist after serialization and are not snapshotted.
  return JSON.parse(JSON.stringify(captured));
}

const WIRE_TOOL_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};

test("golden/anthropic-messages: full request body for the official endpoint (adaptive thinking + cache breakpoint + metadata)", async () => {
  const baseUrl = "https://api.anthropic.com/v1";
  const model = createModelFromConfig(
    "claude_code",
    "claude-sonnet-4-6",
    baseUrl,
    undefined,
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload("claude_code", model, buildContext(), {
    apiKey: "sk-test",
    reasoning: "high",
    toolChoice: "auto",
    sessionId: SESSION_ID,
    cacheRetention: "short",
    metadata: { user_id: SESSION_ID },
  });

  assert.deepEqual(payload, {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ type: "text", text: "hello world" }] }],
    max_tokens: 128000,
    stream: true,
    system: [{ type: "text", text: "You are a precise assistant." }],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        eager_input_streaming: true,
        input_schema: WIRE_TOOL_SCHEMA,
      },
    ],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    metadata: { user_id: SESSION_ID },
    tool_choice: { type: "auto" },
    cache_control: { type: "ephemeral" },
  });
});

test("golden/openai-completions: full request body for a relay endpoint (with tools + reasoning_effort)", async () => {
  const baseUrl = "https://relay.example.com/v1";
  const model = createModelFromConfig(
    "codex",
    "gpt-5.2",
    baseUrl,
    "openai-completions",
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload("codex", model, buildContext(), {
    apiKey: "sk-test",
    reasoning: "high",
    toolChoice: "auto",
    sessionId: SESSION_ID,
  });

  assert.deepEqual(payload, {
    model: "gpt-5.2",
    messages: [
      { role: "system", content: "You are a precise assistant." },
      { role: "user", content: "hello world" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 128000,
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: WIRE_TOOL_SCHEMA,
          strict: false,
        },
      },
    ],
    tool_choice: "auto",
    reasoning_effort: "high",
  });
});

test("golden/openai-completions: a text-only request carries neither tools nor tool_choice (strict gateway 400 regression)", async () => {
  const baseUrl = "https://relay.example.com/v1";
  const model = createModelFromConfig(
    "codex",
    "gpt-5.2",
    baseUrl,
    "openai-completions",
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload(
    "codex",
    model,
    buildContext({ withTools: false }),
    { apiKey: "sk-test", toolChoice: "auto", sessionId: SESSION_ID },
  );

  assert.deepEqual(payload, {
    model: "gpt-5.2",
    messages: [
      { role: "system", content: "You are a precise assistant." },
      { role: "user", content: "hello world" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 128000,
  });
});

test("golden/openai-responses: full request body for the official codex endpoint (store + prompt_cache_key + encrypted reasoning)", async () => {
  const baseUrl = "https://chatgpt.com/backend-api/codex";
  const model = createModelFromConfig(
    "codex",
    "gpt-5.2-codex",
    baseUrl,
    undefined,
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload("codex", model, buildContext(), {
    apiKey: "sk-test",
    reasoning: "high",
    sessionId: SESSION_ID,
    cacheRetention: "short",
  });

  assert.deepEqual(payload, {
    model: "gpt-5.2-codex",
    input: [
      { role: "system", content: "You are a precise assistant." },
      { role: "user", content: [{ type: "input_text", text: "hello world" }] },
    ],
    stream: true,
    prompt_cache_key: SESSION_ID,
    store: true,
    max_output_tokens: 142000,
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: WIRE_TOOL_SCHEMA,
      },
    ],
    reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content"],
  });
});

test("golden/google-generative-ai: full request body for the official endpoint (thinkingLevel + functionCallingConfig)", async () => {
  const baseUrl = "https://generativelanguage.googleapis.com";
  const model = createModelFromConfig(
    "gemini",
    "gemini-3-pro-preview",
    baseUrl,
    undefined,
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload("gemini", model, buildContext(), {
    apiKey: "test-key",
    reasoning: "high",
    toolChoice: "auto",
    sessionId: SESSION_ID,
  });

  assert.deepEqual(payload, {
    model: "gemini-3-pro-preview",
    contents: [{ role: "user", parts: [{ text: "hello world" }] }],
    config: {
      maxOutputTokens: 65536,
      systemInstruction: "You are a precise assistant.",
      tools: [
        {
          functionDeclarations: [
            {
              name: "read_file",
              description: "Read a file",
              parametersJsonSchema: WIRE_TOOL_SCHEMA,
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
    },
  });
});

test("golden/deepseek-responses: full request body for the native adapter (developer role + reasoning effort passthrough)", async () => {
  const baseUrl = "https://api.deepseek.com";
  const model = createModelFromConfig(
    "deepseek",
    "deepseek-v4-flash",
    baseUrl,
    undefined,
    undefined,
    baseUrl,
  );
  const payload = await captureWirePayload("deepseek", model, buildContext(), {
    apiKey: "sk-test",
    reasoning: "high",
    toolChoice: "auto",
    sessionId: SESSION_ID,
  });

  assert.deepEqual(payload, {
    model: "deepseek-v4-flash",
    input: [
      { role: "developer", content: "You are a precise assistant." },
      { role: "user", content: [{ type: "input_text", text: "hello world" }] },
    ],
    stream: true,
    max_output_tokens: 384000,
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: WIRE_TOOL_SCHEMA,
      },
    ],
    tool_choice: "auto",
    reasoning: { effort: "high" },
  });
});
