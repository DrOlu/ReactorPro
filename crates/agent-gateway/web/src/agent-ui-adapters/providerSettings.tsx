import type { AppSettings, CustomProvider, ProviderId } from "../lib/settings";
import type { SettingsSectionProps } from "../pages/settings/types";

/** The WebUI masks the API Key, and the copy-config button is only provided on desktop. */
export function ProviderCopyConfigButton(_props: {
  provider: Pick<CustomProvider, "baseUrl" | "apiKey">;
}) {
  return null;
}

export function ProviderSettingsExtension(_props: {
  activeTab: ProviderId;
  settings: AppSettings;
  setSettings: SettingsSectionProps["setSettings"];
  triggerClassName?: string;
}) {
  return null;
}
