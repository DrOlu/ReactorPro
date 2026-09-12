// Platform transport adapter layer: on the GUI side usage queries go directly through Tauri
// invoke, with the desktop side performing an API-only query. The shared state reduction /
// coordinator / hook logic lives in usageQueryCore.ts (a byte-for-byte mirror on both sides);
// this file holds only platform differences.

import {
  type ProviderUsageResult,
  type UsageQueryProvider,
  useProviderUsageWithQuery,
} from "@liveagent/ui/lib/providers/usageQueryCore";
import { invoke } from "@tauri-apps/api/core";
import type { UsageQueryConfig } from "../settings";

export * from "@liveagent/ui/lib/providers/usageQueryCore";

export async function queryProviderUsage(
  providerId: string,
  refresh: boolean,
): Promise<ProviderUsageResult | null> {
  return invoke<ProviderUsageResult>("provider_usage_query", { providerId, refresh });
}

/**
 * "Test query": try a query using the editor's draft config -- ignore the enable switch, do not
 * persist, do not cache. A WebUI draft's secret is a redacted empty string, and the *Configured
 * flag makes the desktop side reuse the already-stored key.
 */
export async function testProviderUsage(
  providerId: string,
  config: UsageQueryConfig,
): Promise<ProviderUsageResult | null> {
  return invoke<ProviderUsageResult>("provider_usage_test", {
    providerId,
    configJson: JSON.stringify(config),
  });
}

export function useProviderUsage(providers: readonly UsageQueryProvider[]) {
  return useProviderUsageWithQuery(queryProviderUsage, providers);
}
