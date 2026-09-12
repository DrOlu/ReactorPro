import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { ensureDefaultLlmAdapters } from "../service/defaultAdapters";
import { resolveAdapter } from "../service/registry";
import type { StreamOptionsEx } from "./types";

// Ensure the registry is ready for any call through this module (including the
// case where tests mock it by path and later restore it).
ensureDefaultLlmAdapters();

/**
 * Protocol dispatch pinhole (PR-1 seam skeleton).
 *
 * The original five-protocol switch has moved to ../service/: the four pi-ai
 * protocols are in service/piAiAdapter.ts, and native DeepSeek is in
 * service/deepSeekAdapter.ts; this function is now just one line of registry
 * routing, keeping the original signature, semantics, and the
 * "Unsupported model API: ..." error text.
 *
 * The unified entry point llm.stream() (service/llmService.ts) also egresses
 * through this module -- mocking this module's path in transport golden and
 * failover tests intercepts every outbound stream, and this observability point
 * is the seam's public contract that later PRs must not bypass.
 */
export function streamSimpleByApi(model: Model<Api>, context: Context, options: StreamOptionsEx) {
  ensureDefaultLlmAdapters();
  return resolveAdapter(model.api).stream(model, context, options);
}
