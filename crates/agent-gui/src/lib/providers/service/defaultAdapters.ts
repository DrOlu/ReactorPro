import { deepSeekAdapter } from "./deepSeekAdapter";
import { piAiAdapter } from "./piAiAdapter";
import { registerAdapter } from "./registry";

let installed = false;

/**
 * Install the default adapters (idempotent).
 *
 * Called at module load by both the distribution pinhole (the compatibility
 * shell in runtime/streamByApi.ts) and llm.stream(): whichever entry point a
 * consumer comes through, the registry is already ready; repeated calls cost
 * nothing.
 */
export function ensureDefaultLlmAdapters(): void {
  if (installed) return;
  installed = true;
  registerAdapter(piAiAdapter);
  registerAdapter(deepSeekAdapter);
}
