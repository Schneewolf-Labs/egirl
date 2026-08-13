import type { ToolResult } from '../../types'

/**
 * Should the next provider be tried?
 *
 * The distinction that matters is between *the provider could not run the task* and *the agent
 * ran and did not solve it*. Failing over on the first is free reliability. Failing over on the
 * second burns every configured provider on one impossible task, triples the cost, and can leave
 * three agents' partial edits layered on the same working tree.
 *
 * Both halves were observed in one afternoon: codex exited 0 in 0.1s with an empty transcript
 * having done nothing, and opencode returned 401 "Model glm-4.7-free is not supported" because the
 * account was signed out. In both cases another backend was installed, configured, and idle.
 *
 * The rule is conservative: retry only on signals that the backend never got to work. Anything
 * that produced a real transcript is treated as the agent's answer, even when it is a failure.
 */

const INFRASTRUCTURE_SIGNALS = [
  /produced no output/i, // our own empty-transcript detection
  /\bENOENT\b/,
  /not found on PATH/i,
  /command not found/i,
  /\b401\b|\b403\b/,
  /unauthor(i[sz])?ed/i,
  /api[_ ]?key/i,
  /not authenticated/i,
  /\bcredit(s)?\b.*\b(exhaust\w*|insufficient|out of)/i, // 'exhausted', not just 'exhaust'
  /\bquota\b/i,
  /rate[- ]limit/i,
  /\b429\b/,
  /failed to (start|spawn)/i,
  /connection refused/i,
  /timed out after/i,
]

/** A transcript long enough that the agent plainly did work worth not repeating. */
const SUBSTANTIVE_OUTPUT_CHARS = 400

export function shouldFailover(result: ToolResult): boolean {
  if (result.success) return false
  const output = result.output ?? ''

  // An agent that wrote a real transcript ran. Whatever it concluded is its answer, and running
  // a second agent over the same tree is more likely to conflict than to help.
  if (output.length > SUBSTANTIVE_OUTPUT_CHARS && !/produced no output/i.test(output)) {
    return false
  }

  return INFRASTRUCTURE_SIGNALS.some((re) => re.test(output))
}

/**
 * The provider order to attempt. `providers` wins when set; `provider` stays supported so existing
 * configs keep working, and a single provider means the old behaviour exactly — one attempt.
 */
export function resolveProviderChain<T extends string>(
  providers: T[] | undefined,
  provider: T | undefined,
  fallback: T,
): T[] {
  const chain = providers?.length ? providers : provider ? [provider] : [fallback]
  return [...new Set(chain)] // a repeated provider would retry an identical failure
}
