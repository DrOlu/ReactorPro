import type { ProviderRetryPolicy } from "../../settings";
import type { StreamRetryConfig } from "./streamRetry";

/**
 * Parsing of provider-level retry policy -> withStreamRetry options (PR-2 policy-ownership
 * inversion).
 *
 * - default (undefined) -> empty object: no maxAttempts/disabled, so withStreamRetry falls back to
 *   the global DEFAULT_STREAM_RETRY_MAX_ATTEMPTS -- byte-for-byte identical to the pre-inversion
 *   behavior;
 * - off -> { disabled: true }: disables in-stream retries (does not affect cross-provider failover);
 * - custom -> { maxAttempts: maxRetries + 1 }: settings store the "number of retries after the first
 *   failure" (the user-facing measure, excluding the initial request), while withStreamRetry's
 *   maxAttempts is the total number of attempts, so the two differ by exactly 1.
 *
 * The return value is spread-merged by consumers with their own onRetry/onRetryRecovered callbacks;
 * the callback semantics and the buffer-until-commit buffer are unaffected by the policy. In a
 * failover scenario each candidate calls this function with its own runtime's policy -- the policy
 * follows the target provider, the same measure as the transport config.
 */
export function resolveStreamRetryConfig(
  retryPolicy: ProviderRetryPolicy | undefined,
): Pick<StreamRetryConfig, "maxAttempts" | "disabled"> {
  if (!retryPolicy) return {};
  if (retryPolicy.mode === "off") return { disabled: true };
  return { maxAttempts: retryPolicy.maxRetries + 1 };
}
