import type { ProviderPayloadMiddleware } from "../runtime/payloadPipeline";

/**
 * Named payload interceptors (PR-3 interceptor registration).
 *
 * name is the unique identity within the registry: the order snapshot test asserts each name one by one, and duplicate registration
 * of the same name throws; dispose removes by name. intercept is the former ProviderPayloadMiddleware —
 * a pure function (options, params) => options; registration does not change the middleware's own contract.
 */
export type PayloadInterceptor = {
  readonly name: string;
  readonly intercept: ProviderPayloadMiddleware;
};

/**
 * Default interceptors (named wrappers for the existing 10 middlewares, installed once at payloadPipeline.ts module
 * initialization; the order is the original finalizePayloadMiddlewares array order). The last one
 * is payload-debug-logging, pinned to the tail of the chain.
 */
let defaultInterceptors: readonly PayloadInterceptor[] = [];

/** Custom interceptors, ordered by registration; they execute after the default interceptors and before the tail. */
const customInterceptors: PayloadInterceptor[] = [];

/**
 * Combined-result cache. finalizeProviderStreamOptions is on a hot path (agentRunner every
 * turn, textOnly every call); invalidated and rebuilt on register/unregister, zero allocation at call time.
 */
let composedChain: ProviderPayloadMiddleware | undefined;

function invalidateComposedChain(): void {
  composedChain = undefined;
}

function hasInterceptorName(name: string): boolean {
  return (
    defaultInterceptors.some((entry) => entry.name === name) ||
    customInterceptors.some((entry) => entry.name === name)
  );
}

/**
 * Install the default interceptor chain. Intended to be called once at payloadPipeline.ts module initialization; duplicate installation
 * throws (preventing a double initialization under a test loader or HMR from silently changing the chain order).
 *
 * Name uniqueness shares the same registry as usePayloadInterceptor: if, due to load order, a custom
 * interceptor precedes this installation (plugin init, HMR, and test loaders all can), and collides with a default name,
 * this likewise throws rather than silently producing a chain containing a duplicate name. All validation precedes any state write,
 * so a failure leaves no partial registration state.
 */
export function installDefaultPayloadInterceptors(
  interceptors: readonly PayloadInterceptor[],
): void {
  if (defaultInterceptors.length > 0) {
    throw new Error("Default payload interceptors were already installed");
  }
  const seen = new Set<string>();
  for (const entry of interceptors) {
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate default payload interceptor name: ${entry.name}`);
    }
    if (customInterceptors.some((custom) => custom.name === entry.name)) {
      throw new Error(
        `Default payload interceptor name is already taken by a custom interceptor: ${entry.name}`,
      );
    }
    seen.add(entry.name);
  }
  defaultInterceptors = [...interceptors];
  invalidateComposedChain();
}

/**
 * Register a custom interceptor, returning dispose (idempotent).
 *
 * Execution-order invariant: default interceptors (except the tail) -> custom (registration order) ->
 * payload-debug-logging tail. Custom changes are therefore still observed by the debug log.
 */
export function usePayloadInterceptor(interceptor: PayloadInterceptor): () => void {
  if (!interceptor.name) {
    throw new Error("PayloadInterceptor requires a non-empty name");
  }
  if (typeof interceptor.intercept !== "function") {
    throw new Error(`PayloadInterceptor "${interceptor.name}" requires an intercept function`);
  }
  if (hasInterceptorName(interceptor.name)) {
    throw new Error(`Payload interceptor is already registered: ${interceptor.name}`);
  }
  customInterceptors.push(interceptor);
  invalidateComposedChain();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = customInterceptors.indexOf(interceptor);
    if (index >= 0) {
      customInterceptors.splice(index, 1);
      invalidateComposedChain();
    }
  };
}

/** The currently effective interceptor name sequence (execution order), for order snapshot tests and diagnostics. */
export function listPayloadInterceptorNames(): readonly string[] {
  return orderedInterceptors().map((entry) => entry.name);
}

function orderedInterceptors(): readonly PayloadInterceptor[] {
  if (defaultInterceptors.length === 0) return [...customInterceptors];
  const head = defaultInterceptors.slice(0, -1);
  const tail = defaultInterceptors[defaultInterceptors.length - 1];
  return [...head, ...customInterceptors, tail];
}

/** The single middleware composed in execution order; the result is cached until the next register/unregister. */
export function composePayloadInterceptorChain(): ProviderPayloadMiddleware {
  if (!composedChain) {
    const chain = orderedInterceptors();
    composedChain = (options, params) =>
      chain.reduce((next, entry) => entry.intercept(next, params), options);
  }
  return composedChain;
}
