import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimpleByApi } from "../runtime/streamByApi";
import { usePayloadInterceptor } from "./interceptors";
import type { LlmStreamRequest } from "./types";

/**
 * Dev build detection.
 *
 * Under Vite, import.meta.env.DEV is true; production builds statically replace it with
 * false. In the Node test loader (esbuild CJS transpilation) import.meta is an empty
 * shell, so optional chaining safely lands on false — tests that need to cover the
 * frozen path use setLlmServiceDevModeForTest.
 */
function detectDevBuild(): boolean {
  try {
    return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

let devModeOverride: boolean | undefined;

/** Test-only: force the dev freeze switch (undefined restores auto-detection). */
export function setLlmServiceDevModeForTest(value: boolean | undefined): void {
  devModeOverride = value;
}

function isDevBuild(): boolean {
  return devModeOverride ?? detectDevBuild();
}

/** Already-dispatched request envelopes — bookkeeping for the dispatch-once invariant. */
const dispatchedRequests = new WeakSet<LlmStreamRequest>();

/**
 * Unified LLM streaming entry point.
 *
 * Responsibilities are deliberately minimal (PR-1 behavior-equivalence invariant):
 * 1. Dispatch-once — dispatching the same request envelope twice throws, preventing
 *    implicit sharing such as "reusing the previous turn's request envelope" (the
 *    replay semantics of retry/failover live inside the adapter and the caller, not
 *    through this layer);
 * 2. Dev freeze — only dev builds freeze the envelope, so an envelope mutation past
 *    the seam surfaces immediately as a TypeError (ESM strict mode); production builds
 *    cost nothing;
 * 3. Route to the registry adapter through the protocol-dispatch pinhole in
 *    runtime/streamByApi.ts. The pinhole is the seam's public observation point
 *    (transport golden and failover tests mock that module path to intercept all
 *    outbound streams) and must not be bypassed.
 *
 * Transport routing fields (x-liveagent-* in headers, etc.) pass through opaquely:
 * not read, not interpreted, not cached.
 */
export function llmStream(request: LlmStreamRequest): AssistantMessageEventStream {
  if (dispatchedRequests.has(request)) {
    throw new Error("LlmStreamRequest was already dispatched; build a fresh request per stream");
  }
  dispatchedRequests.add(request);
  if (isDevBuild()) {
    Object.freeze(request);
  }
  return streamSimpleByApi(request.model, request.context, request.options);
}

export const llm = {
  stream: llmStream,
  /**
   * Register a custom payload interceptor (PR-3), returning an idempotent dispose.
   * Execution happens after the default interceptors and before the tail of the
   * payload-debug-logging chain.
   */
  use: usePayloadInterceptor,
};
