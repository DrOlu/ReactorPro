// Shared usage query core (state reduction, coordinator and hook, display derivation pure functions). Platform transport differences
// only go into each end's usageQuery.ts adapter layer. Display derivation functions return tokens/structures and do not touch i18n.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Rich result model: isomorphic with the desktop Rust UsageData (serde camelCase). All fields are optional,
// total === -1 means unlimited quota (displayed as ∞).
export type UsageData = {
  planName?: string | null;
  extra?: string | null;
  isValid?: boolean | null;
  invalidMessage?: string | null;
  total?: number | null;
  used?: number | null;
  remaining?: number | null;
  unit?: string | null;
};

export type ProviderUsageResult = {
  data: UsageData[];
  queriedAt?: number | null;
  error?: string | null;
  isStale: boolean;
};

export type ProviderUsageState = Record<string, ProviderUsageResult>;

export type UsageQueryProvider = {
  id: string;
  usageQuery?: {
    enabled?: boolean;
  };
};

type UsageStateAction = {
  providerId: string;
  result?: ProviderUsageResult | null;
  error?: string;
};

type UsageSnapshot = {
  usageByProvider: ProviderUsageState;
  refreshingProviderIds: ReadonlySet<string>;
};

export type UsageQuery = (
  providerId: string,
  refresh: boolean,
) => Promise<ProviderUsageResult | null>;

export function reduceUsageState(
  state: ProviderUsageState,
  action: UsageStateAction,
): ProviderUsageState {
  if (action.result) {
    // A mixed-version desktop may still return the old shape (no data field) — tolerate it as an empty array.
    return {
      ...state,
      [action.providerId]: { ...action.result, data: action.result.data ?? [] },
    };
  }
  if (!action.error) return state;

  const previous = state[action.providerId];
  const hasLastGoodValue = Boolean(previous?.data.length || previous?.queriedAt);
  return {
    ...state,
    [action.providerId]: {
      data: previous?.data ?? [],
      queriedAt: previous?.queriedAt ?? null,
      error: action.error,
      isStale: hasLastGoodValue,
    },
  };
}

/** Objects to force-refresh in bulk when opening the provider settings page: all providers with usage query enabled. */
export function getEnabledUsageProviderIds(providers: readonly UsageQueryProvider[]): string[] {
  return providers
    .filter((provider) => provider.usageQuery?.enabled)
    .map((provider) => provider.id);
}

// ---------------------------------------------------------------------------
// Display derivation (pure functions; the component layer is responsible for translating tokens into i18n text)
// ---------------------------------------------------------------------------

export type UsageRelativeTime =
  | { kind: "justNow" }
  | { kind: "minutesAgo"; value: number }
  | { kind: "hoursAgo"; value: number }
  | { kind: "daysAgo"; value: number };

export function getUsageRelativeTime(queriedAt: number, nowMs: number): UsageRelativeTime {
  const minutes = Math.floor(Math.max(0, nowMs - queriedAt) / 60_000);
  if (minutes < 1) return { kind: "justNow" };
  if (minutes < 60) return { kind: "minutesAgo", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: "hoursAgo", value: hours };
  return { kind: "daysAgo", value: Math.floor(hours / 24) };
}

export function formatUsageAmount(value: number): string {
  if (!Number.isFinite(value)) return "";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// Stable quota-window tokens (Rust-side coding-plan output); an unrecognized planName is displayed as-is.
export type UsagePlanTitle =
  | { kind: "window"; token: "5h" | "weekly" | "monthly" | "quota" }
  | { kind: "text"; text: string }
  | { kind: "none" };

export function resolveUsagePlanTitle(planName: string | null | undefined): UsagePlanTitle {
  switch (planName) {
    case "window:5h":
      return { kind: "window", token: "5h" };
    case "window:weekly":
      return { kind: "window", token: "weekly" };
    case "window:monthly":
      return { kind: "window", token: "monthly" };
    case "window:quota":
      return { kind: "window", token: "quota" };
    default:
      return planName ? { kind: "text", text: planName } : { kind: "none" };
  }
}

export type UsagePlanSeverity = "invalid" | "low" | "normal";

export function getUsagePlanSeverity(plan: UsageData): UsagePlanSeverity {
  if (plan.isValid === false) return "invalid";
  const remaining = usageNumber(plan.remaining);
  const total = usageNumber(plan.total);
  if (remaining !== null && total !== null && total > 0 && remaining < total * 0.1) {
    return "low";
  }
  return "normal";
}

export type UsagePlanDisplay = {
  title: UsagePlanTitle;
  severity: UsagePlanSeverity;
  /** Primary value (prefer remaining; degrade to total-used / used). */
  amount: string | null;
  /** Quota total; total === -1 shows ∞. */
  total: string | null;
  /** remaining/total percentage (rounded 0-100); present only when total>0. */
  percent: number | null;
  unit: string | null;
  extra: string | null;
  invalid: boolean;
  invalidMessage: string | null;
};

function usageNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getUsagePlanDisplay(plan: UsageData): UsagePlanDisplay {
  const remaining = usageNumber(plan.remaining);
  const used = usageNumber(plan.used);
  const total = usageNumber(plan.total);
  const amountValue =
    remaining ?? (total !== null && total >= 0 && used !== null ? total - used : used);
  const invalid = plan.isValid === false;
  return {
    title: resolveUsagePlanTitle(plan.planName),
    severity: getUsagePlanSeverity(plan),
    amount: amountValue !== null ? formatUsageAmount(amountValue) : null,
    total: total !== null ? (total === -1 ? "∞" : formatUsageAmount(total)) : null,
    percent:
      total !== null && total > 0 && remaining !== null
        ? Math.round(Math.min(100, Math.max(0, (remaining / total) * 100)))
        : null,
    unit: typeof plan.unit === "string" && plan.unit ? plan.unit : null,
    extra: typeof plan.extra === "string" && plan.extra ? plan.extra : null,
    invalid,
    invalidMessage:
      invalid && typeof plan.invalidMessage === "string" && plan.invalidMessage
        ? plan.invalidMessage
        : null,
  };
}

export function getProviderUsageCardDisplay(
  provider: UsageQueryProvider,
  usage: ProviderUsageResult | undefined,
  refreshing: boolean,
  nowMs: number,
) {
  const queriedAt = usage?.queriedAt ?? null;
  return {
    show: Boolean(provider.usageQuery?.enabled || usage),
    // Treated as loading until the first result lands (the desktop always responds, writing usage on both success and error
    // shapes), so the card renders an equal-height skeleton placeholder; a manual refresh with an existing result does not return to the skeleton,
    // keeping the old value updated in place (stale-while-revalidate), avoiding repeated height changes.
    loading: !usage,
    plans: (usage?.data ?? []).map(getUsagePlanDisplay),
    isStale: usage?.isStale === true,
    error: usage?.error ?? null,
    updatedAt:
      typeof queriedAt === "number" && Number.isFinite(queriedAt)
        ? getUsageRelativeTime(queriedAt, nowMs)
        : null,
    refreshDisabled: refreshing,
  };
}

// A 30s ticker for relative time: one instance is mounted on the card list, driving "N minutes ago" forward as time passes.
export const USAGE_NOW_TICK_MS = 30_000;

export function useUsageNowTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), USAGE_NOW_TICK_MS);
    return () => window.clearInterval(interval);
  }, [enabled]);
  return now;
}

export function createProviderUsageCoordinator(query: UsageQuery) {
  let providers = new Map<string, UsageQueryProvider>();
  const generations = new Map<string, number>();
  let usageByProvider: ProviderUsageState = {};
  let refreshingProviderIds = new Set<string>();
  const listeners = new Set<(snapshot: UsageSnapshot) => void>();

  function snapshot(): UsageSnapshot {
    return { usageByProvider, refreshingProviderIds: new Set(refreshingProviderIds) };
  }

  function emit() {
    const next = snapshot();
    for (const listener of listeners) listener(next);
  }

  function nextGeneration(providerId: string) {
    const next = (generations.get(providerId) ?? 0) + 1;
    generations.set(providerId, next);
    return next;
  }

  function isCurrent(providerId: string, provider: UsageQueryProvider, generation: number) {
    return providers.get(providerId) === provider && generations.get(providerId) === generation;
  }

  function invalidate(providerId: string) {
    nextGeneration(providerId);
    const nextRefreshing = new Set(refreshingProviderIds);
    nextRefreshing.delete(providerId);
    refreshingProviderIds = nextRefreshing;
    if (usageByProvider[providerId]) {
      const nextUsage = { ...usageByProvider };
      delete nextUsage[providerId];
      usageByProvider = nextUsage;
    }
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener: (next: UsageSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncProviders(nextProviders: readonly UsageQueryProvider[]) {
      const nextById = new Map(nextProviders.map((provider) => [provider.id, provider]));
      const ids = new Set([...providers.keys(), ...nextById.keys()]);
      let changed = false;
      for (const providerId of ids) {
        if (providers.get(providerId) === nextById.get(providerId)) continue;
        invalidate(providerId);
        changed = true;
      }
      providers = nextById;
      if (changed) emit();
    },
    async request(providerId: string, refresh: boolean) {
      const provider = providers.get(providerId);
      if (!provider) return;

      const generation = nextGeneration(providerId);
      refreshingProviderIds = new Set(refreshingProviderIds).add(providerId);
      emit();
      try {
        const result = await query(providerId, refresh);
        if (result && isCurrent(providerId, provider, generation)) {
          usageByProvider = reduceUsageState(usageByProvider, { providerId, result });
          emit();
        }
      } catch {
        if (isCurrent(providerId, provider, generation)) {
          usageByProvider = reduceUsageState(usageByProvider, {
            providerId,
            error: "Usage query failed",
          });
          emit();
        }
      } finally {
        if (isCurrent(providerId, provider, generation)) {
          refreshingProviderIds = new Set(refreshingProviderIds);
          refreshingProviderIds.delete(providerId);
          emit();
        }
      }
    },
  };
}

export function useProviderUsageWithQuery(
  query: UsageQuery,
  providers: readonly UsageQueryProvider[],
) {
  const coordinatorRef = useRef<ReturnType<typeof createProviderUsageCoordinator> | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createProviderUsageCoordinator(query);
  }
  const coordinator = coordinatorRef.current;
  const [snapshot, setSnapshot] = useState(() => coordinator.getSnapshot());
  const enabledProviderIds = useMemo(() => getEnabledUsageProviderIds(providers), [providers]);

  useEffect(() => coordinator.subscribe(setSnapshot), [coordinator]);

  useEffect(() => {
    coordinator.syncProviders(providers);
  }, [coordinator, providers]);

  useEffect(() => {
    return () => coordinator.syncProviders([]);
  }, [coordinator]);

  // Opening the provider settings page force-refreshes all providers with query enabled once concurrently; when a provider config
  // changes (providers reference changes), the corresponding card is invalidated by the coordinator and re-queried here as well.
  useEffect(() => {
    for (const providerId of enabledProviderIds) {
      void coordinator.request(providerId, true);
    }
  }, [coordinator, enabledProviderIds]);

  const refreshProvider = useCallback(
    (providerId: string) => coordinator.request(providerId, true),
    [coordinator],
  );

  return { ...snapshot, refreshProvider };
}
