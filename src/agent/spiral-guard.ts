/**
 * Cross-turn death-spiral detector.
 *
 * The stale-stream timer catches a dead stream and the repetition guard catches a single
 * truncated response, but neither catches the classic agent spiral: a model that produces
 * plausible output every turn while making no progress -- reissuing the same tool call,
 * restating the same plan, re-reading the same file -- until it exhausts its turn budget or a
 * wall-clock timeout kills it mid-thought. Each turn looks fine in isolation; only the
 * repetition across turns reveals it.
 *
 * This tracks a short window of turn signatures and reports a spiral when one signature
 * recurs enough times within it. Conservative by design (a genuinely repeated tool with the
 * SAME arguments, not merely the same tool name) and fail-open on empty turns, which belong
 * to the empty-response guard. `isReasoningLooping` covers the other shape -- a loop that
 * never escapes a single inference's thinking to be counted across turns.
 */

import { isRepetitionDominated } from './repetition-guard'

/** Normalize free text to a short, whitespace-collapsed prefix for collision on near-repeats. */
function fingerprint(text: string, cap: number): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, cap)
}

/**
 * A turn's fingerprint: what the model said, what it *thought*, and exactly which calls it made.
 *
 * The reasoning fingerprint is what catches a thinking-only loop -- a reasoning model can
 * restate the same deliberation turn after turn while its content and tool calls drift just
 * enough to look different. A loop tends to re-enter on the same opening thought, so a prefix
 * of the thinking collides even when the full blocks differ. The tool signature stays exact:
 * read_file on two different paths is progress, not a repeat.
 */
export function turnSignature(
  content: string,
  toolCalls?: ReadonlyArray<{ name: string; arguments: unknown }>,
  thinking?: string,
): string {
  const calls = (toolCalls ?? [])
    .map((c) => `${c.name}:${JSON.stringify(c.arguments)}`)
    .sort()
    .join('|')
  return `${fingerprint(content, 240)}##${calls}##${fingerprint(thinking ?? '', 240)}`
}

/**
 * True when a single reasoning block is dominated by verbatim repetition -- a thinking death
 * spiral *within one inference*, where the model loops on the same fragment instead of
 * converging. Distinct from the cross-turn detector below: this catches a loop that never
 * escapes a single turn to be counted across turns. Reuses the repetition guard's thresholds.
 */
export function isReasoningLooping(thinking: string | undefined): boolean {
  return typeof thinking === 'string' && isRepetitionDominated(thinking)
}

export class SpiralDetector {
  private recent: string[] = []
  private readonly window: number
  private readonly threshold: number

  constructor(opts: { window?: number; threshold?: number } = {}) {
    this.window = opts.window ?? 4
    this.threshold = opts.threshold ?? 3
  }

  /**
   * Record a turn's signature; return true when the agent is spiraling.
   *
   * A spiral is the same signature appearing `threshold` times within the trailing `window`
   * turns. Empty signatures (no content, no calls) are ignored -- that failure is the
   * empty-response guard's, and counting it here would double-punish it.
   */
  record(signature: string): boolean {
    // An empty turn is `####` (no content, no calls, no thinking); that failure belongs to
    // the empty-response guard and counting it here would double-punish it.
    if (!signature || /^#+$/.test(signature)) return false
    this.recent.push(signature)
    if (this.recent.length > this.window) this.recent.shift()
    const count = this.recent.filter((s) => s === signature).length
    return count >= this.threshold
  }
}
