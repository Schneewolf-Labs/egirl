/**
 * Error classification for task failures.
 * Determines the appropriate recovery strategy based on error type.
 */

export type TaskErrorKind =
  | 'rate_limit' // 429, quota exceeded → backoff and retry
  | 'auth' // 401/403, invalid key → pause, needs user intervention
  | 'timeout' // task timed out → retry once with longer timeout
  | 'context_overflow' // too many tokens → not retryable for this input
  | 'transient' // 5xx, network errors → retry with backoff
  | 'unknown' // unclassified → use default retry policy

interface ErrorPatterns {
  rateLimit: RegExp[]
  auth: RegExp[]
  timeout: RegExp[]
  contextOverflow: RegExp[]
  transient: RegExp[]
}

const PATTERNS: ErrorPatterns = {
  rateLimit: [
    /rate[_ ]limit/i,
    /too many requests/i,
    /\b429\b/,
    /exceeded.*quota/i,
    /resource[_ ]exhausted/i,
    /usage[_ ]limit/i,
    /overloaded/i,
  ],
  auth: [
    /invalid[_ ]?api[_ ]?key/i,
    /incorrect api key/i,
    /authentication/i,
    /unauthorized/i,
    /\b401\b/,
    /\b403\b/,
    /access denied/i,
    /forbidden/i,
    /token.*expired/i,
    /invalid token/i,
  ],
  timeout: [/timed? ?out/i, /deadline exceeded/i, /aborted/i, /ETIMEDOUT/, /ECONNRESET/],
  contextOverflow: [
    /context[_ ]?(?:length|window|limit)/i,
    /too many tokens/i,
    /maximum.*tokens/i,
    /token limit/i,
    /context_length_exceeded/i,
  ],
  transient: [
    /\b50[0-4]\b/,
    /internal server error/i,
    /bad gateway/i,
    /service unavailable/i,
    /gateway timeout/i,
    /ECONNREFUSED/,
    /ENOTFOUND/,
    /network/i,
    /fetch failed/i,
  ],
}

export function classifyError(error: string): TaskErrorKind {
  for (const pattern of PATTERNS.rateLimit) {
    if (pattern.test(error)) return 'rate_limit'
  }
  for (const pattern of PATTERNS.auth) {
    if (pattern.test(error)) return 'auth'
  }
  for (const pattern of PATTERNS.timeout) {
    if (pattern.test(error)) return 'timeout'
  }
  for (const pattern of PATTERNS.contextOverflow) {
    if (pattern.test(error)) return 'context_overflow'
  }
  for (const pattern of PATTERNS.transient) {
    if (pattern.test(error)) return 'transient'
  }
  return 'unknown'
}

export interface RetryPolicy {
  shouldRetry: boolean
  shouldPause: boolean
  backoffMs: number
  reason: string
}

/**
 * Determine the retry policy for a given error classification and failure count.
 * Returns whether to retry, whether to pause, and the backoff delay.
 */
export function getRetryPolicy(kind: TaskErrorKind, consecutiveFailures: number): RetryPolicy {
  switch (kind) {
    case 'rate_limit':
      // Exponential backoff: 1min, 5min, 25min, 60min cap
      return {
        shouldRetry: true,
        shouldPause: false,
        backoffMs: Math.min(60 * 60 * 1000, 60 * 1000 * 5 ** Math.min(consecutiveFailures, 3)),
        reason: 'rate limited — backing off',
      }

    case 'transient':
      // Exponential backoff: 30s, 60s, 5min, 15min, then pause
      if (consecutiveFailures >= 5) {
        return {
          shouldRetry: false,
          shouldPause: true,
          backoffMs: 0,
          reason: 'too many transient failures',
        }
      }
      return {
        shouldRetry: true,
        shouldPause: false,
        backoffMs: Math.min(15 * 60 * 1000, 30 * 1000 * 2 ** consecutiveFailures),
        reason: 'transient error — retrying',
      }

    case 'timeout':
      // Retry once, then pause
      if (consecutiveFailures >= 2) {
        return { shouldRetry: false, shouldPause: true, backoffMs: 0, reason: 'repeated timeouts' }
      }
      return {
        shouldRetry: true,
        shouldPause: false,
        backoffMs: 60 * 1000,
        reason: 'timeout — retrying once',
      }

    case 'auth':
      // Don't retry — needs user intervention
      return {
        shouldRetry: false,
        shouldPause: true,
        backoffMs: 0,
        reason: 'auth error — needs user action',
      }

    case 'context_overflow':
      // Don't retry — input too large for this task
      return {
        shouldRetry: false,
        shouldPause: true,
        backoffMs: 0,
        reason: 'context overflow — task prompt too large',
      }

    case 'unknown':
      // Default: 2 retries with 1min backoff, then pause
      if (consecutiveFailures >= 3) {
        return {
          shouldRetry: false,
          shouldPause: true,
          backoffMs: 0,
          reason: 'too many unknown failures',
        }
      }
      return {
        shouldRetry: true,
        shouldPause: false,
        backoffMs: 60 * 1000 * 2 ** consecutiveFailures,
        reason: 'unknown error — retrying',
      }
  }
}
