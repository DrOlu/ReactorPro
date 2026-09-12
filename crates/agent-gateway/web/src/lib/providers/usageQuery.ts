// Platform transport adapter layer: WebUI-side usage queries are bridged via Gateway WebSocket to the desktop side for execution (provider.usage.query).
// The shared state reduction/coordinator/hook logic lives in usageQueryCore.ts (mirrored byte-for-byte on both ends); this file only holds platform differences.

import {
  type ProviderUsageResult,
  type UsageQueryProvider,
  useProviderUsageWithQuery,
} from "@liveagent/ui/lib/providers/usageQueryCore";
import { getGatewayWebSocketClient } from "@/lib/gatewaySocket";
import { loadToken } from "@/lib/storage";
import type { UsageQueryConfig } from "../settings";

export * from "@liveagent/ui/lib/providers/usageQueryCore";

export async function queryProviderUsage(
  providerId: string,
  refresh: boolean,
): Promise<ProviderUsageResult | null> {
  return getGatewayWebSocketClient(
    loadToken().trim(),
  ).providerUsageQuery<ProviderUsageResult | null>(providerId, refresh);
}

/**
 * "Test query": trial query using the editor's draft config - ignores the enable switch, does not persist, and does not cache.
 * The WebUI draft's secret is a masked empty string, and the *Configured flag lets the desktop side reuse the stored key.
 */
export async function testProviderUsage(
  providerId: string,
  config: UsageQueryConfig,
): Promise<ProviderUsageResult | null> {
  return getGatewayWebSocketClient(
    loadToken().trim(),
  ).providerUsageTest<ProviderUsageResult | null>(providerId, JSON.stringify(config));
}

export function useProviderUsage(providers: readonly UsageQueryProvider[]) {
  return useProviderUsageWithQuery(queryProviderUsage, providers);
}
