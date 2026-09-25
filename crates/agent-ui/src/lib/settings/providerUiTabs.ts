import type { ProviderId } from "../../lib/settings/types";

// UI-level SuperAgent tab. Deliberately NOT a new ProviderId: the closed
// ProviderId union is validated end-to-end (Go gateway selected_model checks,
// Rust provider plumbing), so the SuperAgent tab rides the claude_code /
// Anthropic-compatible surface — exactly how SuperAgent is used today — and
// only the settings UI knows about it. No wire or validation changes.

export const SUPERAGENT_UI_TAB_ID = "superagent";
export const SUPERAGENT_PRESET_BASE_URL = "https://api.superagent.ng";
export const SUPERAGENT_PRESET_NAME = "SuperAgent";

export type ProviderUiTab = ProviderId | typeof SUPERAGENT_UI_TAB_ID;

export const PROVIDER_UI_TABS: { id: ProviderUiTab; providerType: ProviderId }[] = [
  { id: SUPERAGENT_UI_TAB_ID, providerType: "claude_code" },
  { id: "claude_code", providerType: "claude_code" },
  { id: "codex", providerType: "codex" },
  { id: "gemini", providerType: "gemini" },
  { id: "xai", providerType: "xai" },
  { id: "deepseek", providerType: "deepseek" },
];

/** Which closed ProviderId a UI tab drives. SuperAgent rides claude_code. */
export function resolveProviderUiTabProviderType(tab: ProviderUiTab): ProviderId {
  return tab === SUPERAGENT_UI_TAB_ID ? "claude_code" : tab;
}

/** Guard: every UI tab's provider type must stay inside the closed union the
 * Go gateway validates (selected_model.provider_type). Adding a UI tab can
 * never silently widen the wire contract. */
export function assertProviderUiTabsStayInClosedUnion(
  allowed: readonly ProviderId[],
): void {
  for (const tab of PROVIDER_UI_TABS) {
    if (!allowed.includes(tab.providerType)) {
      throw new Error(
        `provider UI tab "${String(tab.id)}" maps to "${tab.providerType}", which is outside the closed ProviderId union`,
      );
    }
  }
}
