/**
 * Content-sanity check for the truncated-response continuation path.
 *
 * A model in a degenerate repetition loop spends its entire output budget echoing one
 * fragment, finishes with finish_reason=length like any honest truncation, and the
 * continuation retry then asks it to keep going -- stitching more of the same echo onto the
 * final response. Hermes's incident behind this guard was a single turn producing 60,698
 * characters delivered as 31 Discord messages; egirl has the identical continuation path and
 * the same Discord channel.
 *
 * Ported from hermes-agent's repetition_guard.py with its thresholds intact. Deliberately
 * conservative and fail-open: only LONG verbatim repeats covering at least half the fragment
 * count, so ordinary truncation -- a sentence cut mid-word, a repeated heading, code with
 * similar-looking lines -- is never blocked.
 */

/** Below this, a fragment is too short to judge; fail open. */
const MIN_FRAGMENT_LENGTH = 600

/** Verbatim repeats of this many chars are far beyond ordinary phrasing reuse. */
const REPEAT_WINDOW = 60

/** A window must recur at least this often to count, even in short fragments. */
const MIN_REPEAT_COUNT = 5

/** Repeats must cover at least this fraction of the fragment. */
const DOMINANCE_RATIO = 0.5

/**
 * True when `text` is dominated by verbatim repeated fragments.
 *
 * Two passes, cheap first: a single normalized line whose repeats cover half the fragment
 * (the common echo shape), then fixed-size exact windows slid one character at a time for
 * loops that do not align to line boundaries.
 */
export function isRepetitionDominated(text: string): boolean {
  if (typeof text !== 'string') return false
  const n = text.length
  if (n < MIN_FRAGMENT_LENGTH) return false

  if (lineRepetitionDominated(text, n)) return true

  const needed = Math.max(MIN_REPEAT_COUNT, Math.ceil((n * DOMINANCE_RATIO) / REPEAT_WINDOW))
  const counts = new Map<string, number>()
  for (let i = 0; i <= n - REPEAT_WINDOW; i++) {
    const key = text.slice(i, i + REPEAT_WINDOW)
    const c = (counts.get(key) ?? 0) + 1
    if (c >= needed) return true
    counts.set(key, c)
  }
  return false
}

function lineRepetitionDominated(text: string, n: number): boolean {
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) {
    const norm = line.trim()
    if (!norm) continue
    counts.set(norm, (counts.get(norm) ?? 0) + 1)
  }
  for (const [line, c] of counts) {
    if (c >= MIN_REPEAT_COUNT && c * line.length >= n * DOMINANCE_RATIO) return true
  }
  return false
}
