/**
 * Secret scrubbing for trajectory-event error text.
 *
 * Vendor errors may echo the full request URL (Gemini's key goes in a query parameter) or an
 * authorization header (Bearer token). The trajectory ledger is written to disk and delivered
 * across clients, so any text entering the err field must pass through this layer first. It only
 * does pattern-level replacement and does not alter normal error text.
 */

/** Query parameter names whose values look like secrets (URL-encoded variants are covered by the parameter-name match). */
const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:key|api[-_]?key|apikey|token|access[-_]?token|secret)=)[^&\s"']+/gi;

/** Echo of Authorization: Bearer <token>. */
const BEARER_TOKEN_PATTERN = /(bearer\s+)[a-z0-9._~+/-]{8,}=*/gi;

/** Common key prefixes (OpenAI/Anthropic sk-, Google AIza). */
const KNOWN_KEY_SHAPE_PATTERN = /\b(?:sk|AIza)[A-Za-z0-9_-]{16,}\b/g;

export function scrubSecretsFromErrorText(text: string): string {
  return text
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, "$1[redacted]")
    .replace(BEARER_TOKEN_PATTERN, "$1[redacted]")
    .replace(KNOWN_KEY_SHAPE_PATTERN, "[redacted]");
}
