import type { ProviderId } from "../../lib/settings/types";

// UI-level SuperAgent tab. Deliberately NOT a new ProviderId: the closed
// ProviderId union is validated end-to-end (Go gateway selected_model checks,
// Rust provider plumbing). The SuperAgent tab is the converted OpenAI tab —
// it rides codex (OpenAI-compatible) with the base URL preset to
// https://api.superagent.ng. Only the settings UI knows about it; no wire or
// validation changes, and persisted providers of other types still load.

export const SUPERAGENT_UI_TAB_ID = "superagent";
export const SUPERAGENT_PRESET_BASE_URL = "https://api.superagent.ng";
export const SUPERAGENT_PRESET_NAME = "SuperAgent";

export type ProviderUiTab = ProviderId | typeof SUPERAGENT_UI_TAB_ID;

// One tab: SuperAgent — the converted OpenAI (codex) surface with its base
// URL preset to https://api.superagent.ng. The other vendor tabs are gone
// from the UI; persisted providers of other types still load (no data loss).
export const PROVIDER_UI_TABS: { id: ProviderUiTab; providerType: ProviderId }[] = [
  { id: SUPERAGENT_UI_TAB_ID, providerType: "codex" },
];

/** Which closed ProviderId a UI tab drives. SuperAgent rides codex
 * (OpenAI-compatible), matching https://api.superagent.ng. */
export function resolveProviderUiTabProviderType(_tab: ProviderUiTab): ProviderId {
  // Single tab: SuperAgent always rides codex (OpenAI-compatible).
  return "codex";
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
