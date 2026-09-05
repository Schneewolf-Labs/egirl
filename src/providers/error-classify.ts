import {
  AUTH_PATTERNS,
  CONTEXT_OVERFLOW_PATTERNS,
  matchesAny,
  RATE_LIMIT_PATTERNS,
  TRANSIENT_PATTERNS,
} from '../util/error-patterns'

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

const NON_RETRYABLE_PATTERNS = [/billing/i, /payment/i, /insufficient.*funds/i]

export function classifyProviderError(errorMessage: string): ProviderErrorKind {
  if (matchesAny(errorMessage, RATE_LIMIT_PATTERNS)) return 'rate_limit'
  if (matchesAny(errorMessage, AUTH_PATTERNS)) return 'auth'
  if (matchesAny(errorMessage, CONTEXT_OVERFLOW_PATTERNS)) return 'context_overflow'
  if (matchesAny(errorMessage, NON_RETRYABLE_PATTERNS)) return 'non_retryable'
  if (matchesAny(errorMessage, TRANSIENT_PATTERNS)) return 'transient'
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
