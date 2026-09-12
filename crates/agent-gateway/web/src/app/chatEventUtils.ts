import { asRecord, errorMessageWithFallback } from "@liveagent/ui/lib/shared/value";
import type { ChatEvent, GatewaySelectedModel } from "@/lib/gatewayTypes";
import {
  type AppSettings,
  normalizeSelectedModelForProviders,
  parseSelectedModelJson,
  type SelectedModel,
} from "@/lib/settings";
import type { ModelProviderSource, TunnelManagerToolChange } from "./types";

export { errorMessageWithFallback as asErrorMessage };

export function isAbortError(error: unknown) {
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("cancelled") ||
    normalized.includes("canceled") ||
    normalized.includes("abort") ||
    normalized.includes("aborted")
  );
}

export function readChatEventTitle(event: ChatEvent): string {
  if ("title" in event && typeof event.title === "string") {
    return event.title.trim();
  }
  return "";
}

export function isChatEventTitleFinal(event: ChatEvent) {
  return event.type === "done" || ("titleFinal" in event && event.titleFinal === true);
}

export function readTunnelManagerToolChange(event: ChatEvent): TunnelManagerToolChange | null {
  if (event.type !== "tool_result" || event.isError === true) {
    return null;
  }
  const details = asRecord(event.details);
  if (details.kind !== "tunnel_manager") {
    return null;
  }
  const action = typeof details.action === "string" ? details.action.trim() : "";
  if (action !== "create" && action !== "close") {
    return null;
  }
  const tunnel = asRecord(details.tunnel);
  const projectPathKey =
    (typeof tunnel.projectPathKey === "string" ? tunnel.projectPathKey.trim() : "") ||
    (typeof tunnel.project_path_key === "string" ? tunnel.project_path_key.trim() : "") ||
    event.workdir?.trim() ||
    "";
  return { action, projectPathKey };
}

// The single derivation point for a session's effective model: a local unpersisted switch (override) >
// the session's persisted choice brought back by history-sync > the global default (new-session semantics).
// The first two levels are validated against the current providers, falling back level by level when invalid.
export function resolveActiveModelSelection(params: {
  settings: AppSettings;
  override?: SelectedModel;
  persistedSelectedModelJson?: string;
}): SelectedModel | undefined {
  const { settings, override, persistedSelectedModelJson } = params;
  return (
    normalizeSelectedModelForProviders(override, settings.customProviders) ??
    normalizeSelectedModelForProviders(
      parseSelectedModelJson(persistedSelectedModelJson),
      settings.customProviders,
    ) ??
    settings.selectedModel
  );
}

export function buildGatewaySelectedModel(
  selectedModel: SelectedModel | undefined,
  providers: ModelProviderSource[],
): GatewaySelectedModel | undefined {
  if (!selectedModel) {
    return undefined;
  }

  const provider = providers.find((item) => item.id === selectedModel.customProviderId);
  if (!provider) {
    return undefined;
  }

  return {
    customProviderId: provider.id,
    model: selectedModel.model,
    providerType: provider.type,
  };
}

export function buildGatewaySystemSettings(settings: AppSettings, workdirOverride?: string) {
  return {
    executionMode: settings.system.executionMode,
    workdir: workdirOverride ?? settings.system.workdir.trim(),
    commandSafetyMode: settings.system.commandSafetyMode,
  };
}
