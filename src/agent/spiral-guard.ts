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
 * to the empty-response guard.
 */

/** A turn's fingerprint: what the model said plus exactly which calls it made. */
export function turnSignature(
  content: string,
  toolCalls?: ReadonlyArray<{ name: string; arguments: unknown }>,
): string {
  const calls = (toolCalls ?? [])
    .map((c) => `${c.name}:${JSON.stringify(c.arguments)}`)
    .sort()
    .join('|')
  // Collapse whitespace and cap length so near-identical prose (a restated plan with trivial
  // wording drift) still collides. The tool signature is exact -- read_file on two different
  // paths is real progress and must not look like a repeat.
  const text = content.trim().replace(/\s+/g, ' ').slice(0, 240)
  return `${text}##${calls}`
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
    if (!signature || signature === '##') return false
    this.recent.push(signature)
    if (this.recent.length > this.window) this.recent.shift()
    const count = this.recent.filter((s) => s === signature).length
    return count >= this.threshold
  }
}
