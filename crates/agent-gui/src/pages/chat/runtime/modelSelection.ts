import type { AppSettings, ProviderId, SelectedModel } from "../../../lib/settings";
import {
  type GatewaySelectedModelEvent,
  normalizeGatewayProviderType,
} from "../gateway/gatewayBridgeTypes";

export type EffectiveChatModelSelection = {
  selectedModel: SelectedModel;
  provider: AppSettings["customProviders"][number];
  providerId: ProviderId;
  model: string;
};

export function resolveActiveModelSelection(
  settings: AppSettings,
  conversationSelectedModel: SelectedModel | undefined,
): SelectedModel | undefined {
  return conversationSelectedModel ?? settings.selectedModel;
}

export function resolvePersistedConversationModelSelection(params: {
  runtimeSelectedModel?: SelectedModel;
  turnSelectedModel?: SelectedModel;
}): SelectedModel | undefined {
  return params.runtimeSelectedModel ?? params.turnSelectedModel;
}

export function resolveEffectiveChatModelSelection(params: {
  settings: AppSettings;
  conversationSelectedModel?: SelectedModel;
  gatewaySelectedModel?: GatewaySelectedModelEvent;
}): EffectiveChatModelSelection {
  const { settings, conversationSelectedModel, gatewaySelectedModel } = params;
  const resolveLocalSelection = (): EffectiveChatModelSelection => {
    const activeSelectedModel = resolveActiveModelSelection(settings, conversationSelectedModel);
    if (!activeSelectedModel) {
      throw new Error("Please select a model at the bottom-left of the input box first (or add one in Settings).");
    }

    const { customProviderId, model } = activeSelectedModel;
    const provider = settings.customProviders.find((item) => item.id === customProviderId);
    if (!provider) {
      throw new Error("The selected provider does not exist; please select a model again.");
    }
    if (!provider.activeModels.includes(model)) {
      throw new Error("The selected model is not enabled; please select a model again.");
    }

    return {
      selectedModel: activeSelectedModel,
      provider,
      providerId: provider.type,
      model,
    };
  };

  if (!gatewaySelectedModel) {
    return resolveLocalSelection();
  }

  const customProviderId = gatewaySelectedModel.customProviderId.trim();
  const model = gatewaySelectedModel.model.trim();
  const providerType = normalizeGatewayProviderType(gatewaySelectedModel.providerType);
  if (!customProviderId || !model || !providerType) {
    throw new Error("The model config carried by the remote request is invalid; please select the model again in the WebUI and retry.");
  }

  const provider = settings.customProviders.find((item) => item.id === customProviderId);
  if (!provider) {
    throw new Error(
      "The provider for the model selected by the remote request does not exist; please sync the desktop settings and select the model again in the WebUI.",
    );
  }
  if (provider.type !== providerType) {
    throw new Error(
      "The provider type of the model selected by the remote request does not match the desktop configuration; please sync the desktop settings and select the model again in the WebUI.",
    );
  }
  if (!provider.activeModels.includes(model)) {
    throw new Error("The model selected by the remote request is not enabled on the desktop; please sync the desktop settings and select the model again in the WebUI.");
  }

  return {
    selectedModel: {
      customProviderId: provider.id,
      model,
    },
    provider,
    providerId: provider.type,
    model,
  };
}
