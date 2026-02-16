/**
 * Error classification for LLM provider failures.
 * Used by the agent loop to decide retry vs fail-fast behavior.
 */

export type ProviderErrorKind =
  | 'rate_limit' // 429, quota exceeded → retry with backoff
  | 'auth' // 401/403, invalid key → fail fast
  | 'context_overflow' // too many tokens → refit, don't retry blindly
  | 'transient' // 5xx, network errors → retry with backoff
  | 'non_retryable' // billing, format errors → fail fast

const RATE_LIMIT_PATTERNS = [
  /rate[_ ]limit/i,
  /too many requests/i,
  /\b429\b/,
  /exceeded.*quota/i,
  /resource[_ ]exhausted/i,
  /overloaded/i,
]

const AUTH_PATTERNS = [
  /invalid[_ ]?api[_ ]?key/i,
  /incorrect api key/i,
  /authentication/i,
  /unauthorized/i,
  /\b401\b/,
  /\b403\b/,
  /access denied/i,
  /forbidden/i,
]

const CONTEXT_PATTERNS = [
  /context[_ ]?(?:length|window|limit)/i,
  /too many tokens/i,
  /maximum.*tokens/i,
  /token limit/i,
  /context_length_exceeded/i,
]

const TRANSIENT_PATTERNS = [
  /\b50[0-4]\b/,
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /network/i,
  /fetch failed/i,
  /socket/i,
]

const NON_RETRYABLE_PATTERNS = [/billing/i, /payment/i, /insufficient.*funds/i]

export function classifyProviderError(errorMessage: string): ProviderErrorKind {
  for (const p of RATE_LIMIT_PATTERNS) {
    if (p.test(errorMessage)) return 'rate_limit'
  }
  for (const p of AUTH_PATTERNS) {
    if (p.test(errorMessage)) return 'auth'
  }
  for (const p of CONTEXT_PATTERNS) {
    if (p.test(errorMessage)) return 'context_overflow'
  }
  for (const p of NON_RETRYABLE_PATTERNS) {
    if (p.test(errorMessage)) return 'non_retryable'
  }
  for (const p of TRANSIENT_PATTERNS) {
    if (p.test(errorMessage)) return 'transient'
  }
  return 'transient' // Default: assume transient and retry
}

/** Whether this error kind should be retried by the agent loop */
export function isRetryable(kind: ProviderErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'transient'
}

/** Backoff delay in ms for a retryable error */
export function retryDelay(kind: ProviderErrorKind, attempt: number): number {
  if (kind === 'rate_limit') {
    // Longer backoff for rate limits: 2s, 5s, 10s
    return Math.min(10_000, 2000 * (attempt + 1))
  }
  // Transient: 1s, 2s, 4s
  return 1000 * 2 ** attempt
}
