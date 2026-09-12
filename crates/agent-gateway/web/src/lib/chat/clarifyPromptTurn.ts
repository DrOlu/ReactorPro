// crates/agent-gateway/web/src/lib/chat/clarifyPromptTurn.ts
import type { ClarifyMessage } from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import type { ClarifyTurnResult } from "@/lib/gatewaySocketRpc";
import {
  type AppSettings,
  type ChatRuntimeControls,
  type CustomProvider,
  normalizeChatRuntimeControlsForProvider,
  resolvePromptClarifyModel,
} from "@/lib/settings";

/** Minimal API surface for clarify.prompt_turn (a subset of GatewayWebSocketRpcClient). */
export type ClarifyPromptTurnApi = {
  clarifyPromptTurn(
    input: {
      messages: ClarifyMessage[];
      providerId: string;
      model: string;
      runtimeControls?: ChatRuntimeControls;
    },
    options?: { onDelta?: (delta: string) => void },
  ): Promise<ClarifyTurnResult>;
};

/**
 * Clarify-turn execution logic shared by the two Web hosts (the inline composer in
 * GatewayAppView / the workbench Pane): the "clarify conversation model" in settings takes
 * precedence, and when unset or invalid it falls back to the host's own current session
 * model; when an override takes effect, runtime controls are re-normalized for the
 * overridden provider/model. Relayed through the gateway to the desktop host to run a
 * single text-only completion; onTextDelta pushes streaming deltas back to the panel.
 */
export async function executeClarifyPromptTurn(
  api: ClarifyPromptTurnApi,
  settings: AppSettings,
  fallback: {
    provider: CustomProvider | undefined;
    model: string | undefined;
    runtimeControls: ChatRuntimeControls | undefined;
  },
  messages: ClarifyMessage[],
  onTextDelta?: (delta: string) => void,
): Promise<string> {
  const override = resolvePromptClarifyModel(settings);
  const provider = override?.provider ?? fallback.provider;
  const model = override?.model ?? fallback.model;
  if (!provider || !model) {
    throw new Error("no active model selected");
  }
  const result = await api.clarifyPromptTurn(
    {
      messages,
      providerId: provider.id,
      model,
      runtimeControls: override
        ? normalizeChatRuntimeControlsForProvider(settings.chatRuntimeControls, {
            providerId: provider.type,
            requestFormat: provider.requestFormat,
            modelId: model,
          })
        : fallback.runtimeControls,
    },
    onTextDelta ? { onDelta: onTextDelta } : undefined,
  );
  if (result.error_code) {
    throw new Error(result.error_message || result.error_code);
  }
  return result.final_text;
}
