import type { LlmAdapter } from "./types";

/**
 * api -> adapter registry.
 *
 * The PR-1 registry is a module-static registration (registerAdapter is only used by this
 * directory's default assembly and tests), and does not offer runtime dynamic unregistration --
 * that falls under PR-3 interceptor registration.
 */
const adaptersByApi = new Map<string, LlmAdapter>();

export function registerAdapter(adapter: LlmAdapter): void {
  for (const api of adapter.apis) {
    const existing = adaptersByApi.get(api);
    if (existing && existing !== adapter) {
      throw new Error(`Duplicate LLM adapter registration for API: ${api}`);
    }
    adaptersByApi.set(api, adapter);
  }
}

/**
 * Resolves the adapter for a wire protocol.
 *
 * The error message for an unregistered protocol stays word-for-word identical to the pre-refactor
 * default branch in streamByApi.ts ("Unsupported model API: ..."), and the error path does not drift either.
 */
export function resolveAdapter(api: string): LlmAdapter {
  const adapter = adaptersByApi.get(api);
  if (!adapter) {
    throw new Error(`Unsupported model API: ${api}`);
  }
  return adapter;
}

/** List of registered protocols (for tests, in registration order). */
export function registeredApis(): string[] {
  return [...adaptersByApi.keys()];
}
