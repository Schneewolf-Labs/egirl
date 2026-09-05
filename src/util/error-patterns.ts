/**
 * Message patterns that classify a failure, shared by the provider classifier (retry vs
 * fail-fast in the agent loop) and the task classifier (backoff, pause, needs-user). Each
 * keeps its own kinds and ordering; the vocabulary of what a rate limit or an auth failure
 * looks like is the same on both sides.
 */
export const RATE_LIMIT_PATTERNS = [
  /rate[_ ]limit/i,
  /too many requests/i,
  /\b429\b/,
  /exceeded.*quota/i,
  /resource[_ ]exhausted/i,
  /usage[_ ]limit/i,
  /overloaded/i,
]

export const AUTH_PATTERNS = [
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
]

export const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]?(?:length|window|limit)/i,
  /too many tokens/i,
  /maximum.*tokens/i,
  /token limit/i,
  /context_length_exceeded/i,
]

export const TRANSIENT_PATTERNS = [
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

export function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(message))
}
