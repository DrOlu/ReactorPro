// The neuralOS agent tools: query the on-device instance fleet in natural
// language. The bundled needle engine SELECTS a read probe; each instance's
// own bridge.py EXECUTES it and holds its credentials — the model never sees
// connection details and the fleet never sees model output. Thin TS wrappers
// over the Rust commands in commands/integration/neuralos.rs.

import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SystemToolRuntimeScope } from "@liveagent/ui/lib/tools/systemToolOptions";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function toolResult(toolCall: ToolCall, text: string, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details: {},
    isError,
    timestamp: Date.now(),
  };
}

const NEURALOS_INSTANCES_PARAMETERS = Type.Object({});

const NEURALOS_QUERY_PARAMETERS = Type.Object({
  instance: Type.String({
    minLength: 1,
    description:
      "The instance name exactly as listed by NeuralOsInstances (e.g. chinook, cyberbank, aws, cloudflare).",
  }),
  question: Type.String({
    minLength: 1,
    description:
      "The question in plain language. The on-device engine picks the best read probe; phrase the question like the instance's canonical questions (e.g. 'revenue breakdown by country', 'how many transactions').",
  }),
});

const NEURALOS_SETUP_PARAMETERS = Type.Object({});

const NEURALOS_REFRESH_PARAMETERS = Type.Object({
  instance: Type.String({
    minLength: 1,
    description:
      "The instance name exactly as listed by NeuralOsInstances. Its instance.py is re-exported into a fresh needle_menu.json.",
  }),
});

const NEURALOS_GENERATE_PARAMETERS = Type.Object({
  name: Type.String({
    minLength: 2,
    maxLength: 40,
    description:
      "Folder name for the new instance: 2-40 chars of [a-z0-9_-], e.g. 'shopdb' or 'crm_logs'.",
  }),
  source: Type.String({
    minLength: 1,
    description:
      "The data source: a DSN ('mysql://user:pass@host/db', 'postgres://...'), a file path (csv/json/log/...), or an https URL. Credentials you pass here are baked into the generated instance's bridge on this machine.",
  }),
  max_tables: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 64,
      description: "Cap on tables/files profiled (default 32).",
    }),
  ),
  sample: Type.Optional(
    Type.Integer({
      minimum: 5,
      maximum: 500,
      description: "Rows/values sampled per table for inference (default 50).",
    }),
  ),
  max_models: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 32,
      description: "Cap on generated pydantic models (default 20).",
    }),
  ),
});

export function createNeuralosTools(params: {
  enabled?: boolean;
  runtimeScope?: SystemToolRuntimeScope;
}): BuiltinToolBundle {
  // Off outside chat runs: cron prompts should not spawn engine/bridge
  // subprocesses unattended, matching the terminal tools' scoping.
  const enabled = params.enabled !== false && params.runtimeScope === "chat";

  const toolNeuralOsInstances: Tool = {
    name: "NeuralOsInstances",
    description:
      "List the installed neuralOS data instances. Each instance exposes validated read probes over one live data source (MySQL, Cloudflare, AWS, fraud platforms, mailboxes). Call this before NeuralOsQuery when you do not know which instance covers the user's question. Also reports whether the on-device engine and python bridge environment are installed.",
    parameters: NEURALOS_INSTANCES_PARAMETERS,
  };

  const toolNeuralOsQuery: Tool = {
    name: "NeuralOsQuery",
    description:
      "Ask one neuralOS instance a question in plain language and get a small validated JSON digest of live data. The on-device needle model selects the read probe; the instance's own bridge executes it. Strongly prefer this over shell commands or direct database access when the question is about an instance's data — credentials stay inside the bridge and answers arrive pre-validated. If the selection is refused, rephrase closer to the instance's canonical questions and retry once before falling back.",
    parameters: NEURALOS_QUERY_PARAMETERS,
  };

  const toolNeuralOsRefreshMenu: Tool = {
    name: "NeuralOsRefreshMenu",
    description:
      "Regenerate one instance's needle_menu.json from its instance.py. Use after an instance's probes were added or changed and the menu is stale. Requires the managed bridge environment (run NeuralOsSetup first if missing).",
    parameters: NEURALOS_REFRESH_PARAMETERS,
  };

  const toolNeuralOsGenerate: Tool = {
    name: "NeuralOsGenerate",
    description:
      "Create a NEW neuralOS instance from a data source: profiles it, generates a strict pydantic model, a query bridge and a probe menu, and installs it into the fleet. source accepts a DSN, a file path, or an https URL. Confirm the source string with the user before calling — it typically contains credentials.",
    parameters: NEURALOS_GENERATE_PARAMETERS,
  };

  const toolNeuralOsSetup: Tool = {
    name: "NeuralOsSetup",
    description:
      "Install the neuralOS python bridge environment: creates a managed virtualenv and installs the libraries the instance bridges need (pymysql, boto3, requests, pydantic). Run this once if NeuralOsQuery fails with a missing-module error, or when the user asks to set neuralOS up. Idempotent.",
    parameters: NEURALOS_SETUP_PARAMETERS,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    if (signal?.aborted) {
      return toolResult(toolCall, "Cancelled", true);
    }
    try {
      switch (toolCall.name) {
        case "NeuralOsInstances": {
          const instances =
            await invoke<Array<{ name: string; probes: number; hasBridge: boolean; path: string }>>(
              "neuralos_list_instances",
            );
          if (instances.length === 0) {
            return toolResult(
              toolCall,
              "No neuralOS instances installed. Instances are folders containing needle_menu.json + bridge.py; place them under the app's neuralos-instances directory (or the legacy ~/neuralos-instances).",
              false,
            );
          }
          const lines = instances.map(
            (i) =>
              `${i.name}\t${i.probes} probes${i.hasBridge ? "" : "\t(no bridge.py — not runnable)"}`,
          );
          return toolResult(
            toolCall,
            `${instances.length} instance(s):\n${lines.join("\n")}\n\nAsk questions with NeuralOsQuery(instance, question).`,
            false,
          );
        }
        case "NeuralOsQuery": {
          const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
          const instance = typeof args.instance === "string" ? args.instance.trim() : "";
          const question = typeof args.question === "string" ? args.question.trim() : "";
          if (!instance || !question) {
            return toolResult(toolCall, "NeuralOsQuery requires both instance and question.", true);
          }
          const digest = await invoke<{
            probe: string;
            confidence: number;
            result: unknown;
          }>("neuralos_run_probe", { instance, question });
          const rendered = JSON.stringify(digest.result, null, 1);
          const header = `probe=${digest.probe} (selected with confidence ${digest.confidence.toFixed(2)})`;
          return toolResult(toolCall, `${header}\n${rendered}`, false);
        }
        case "NeuralOsRefreshMenu": {
          const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
          const instance = typeof args.instance === "string" ? args.instance.trim() : "";
          if (!instance) {
            return toolResult(toolCall, "NeuralOsRefreshMenu requires instance.", true);
          }
          const result = await invoke<{ instance: string; probes: number }>(
            "neuralos_refresh_menu",
            { instance },
          );
          return toolResult(
            toolCall,
            `Menu regenerated for ${result.instance}: ${result.probes} probes.`,
            false,
          );
        }
        case "NeuralOsGenerate": {
          const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
          const result = await invoke<{ instance: string; path: string; probes: number }>(
            "neuralos_generate_instance",
            {
              name: typeof args.name === "string" ? args.name : "",
              source: typeof args.source === "string" ? args.source : "",
              maxTables: typeof args.max_tables === "number" ? args.max_tables : undefined,
              sample: typeof args.sample === "number" ? args.sample : undefined,
              maxModels: typeof args.max_models === "number" ? args.max_models : undefined,
            },
          );
          return toolResult(
            toolCall,
            `Instance created: ${result.instance} (${result.probes} probes) at ${result.path}. It is live immediately — query it with NeuralOsQuery.`,
            false,
          );
        }
        case "NeuralOsSetup": {
          const result = await invoke<{ python: string; installed: string[] }>(
            "neuralos_setup_environment",
          );
          return toolResult(
            toolCall,
            `Bridge environment ready.\npython=${result.python}\ninstalled: ${result.installed.join(", ")}`,
            false,
          );
        }
        default:
          return toolResult(toolCall, `Unknown tool: ${toolCall.name}`, true);
      }
    } catch (err) {
      const message = asErrorMessage(err);
      const hint = /no python interpreter|No module named|ModuleNotFoundError|missing-module/i.test(
        message,
      )
        ? "\nHint: run NeuralOsSetup to install the bridge python environment."
        : "";
      return toolResult(toolCall, `neuralOS failed: ${message}${hint}`, true);
    }
  }

  return {
    groupId: "system",
    tools: enabled
      ? [
          toolNeuralOsInstances,
          toolNeuralOsQuery,
          toolNeuralOsSetup,
          toolNeuralOsRefreshMenu,
          toolNeuralOsGenerate,
        ]
      : [],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "NeuralOsInstances",
        { groupId: "system", kind: "system", isReadOnly: true, displayCategory: "system" },
      ],
      [
        "NeuralOsQuery",
        { groupId: "system", kind: "system", isReadOnly: true, displayCategory: "system" },
      ],
      [
        "NeuralOsSetup",
        { groupId: "system", kind: "system", isReadOnly: false, displayCategory: "system" },
      ],
      [
        "NeuralOsRefreshMenu",
        { groupId: "system", kind: "system", isReadOnly: false, displayCategory: "system" },
      ],
      [
        "NeuralOsGenerate",
        { groupId: "system", kind: "system", isReadOnly: false, displayCategory: "system" },
      ],
    ]),
  };
}
