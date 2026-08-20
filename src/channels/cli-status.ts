/**
 * A live status line for a running turn.
 *
 * A local operator model can go a long time between visible output: a cold prefill on a large
 * context is minutes before the first token, and a tool call that shells out shows nothing at
 * all. The terminal was simply silent for all of it, which is indistinguishable from a hang --
 * and the usual reaction to a hang is Ctrl-C, which is the one thing you do not want someone
 * doing thirty seconds into a two-minute prefill.
 *
 * So this says which of those is happening, and how long it has been happening for. It is a
 * single rewritten line rather than a scrolling log because the interesting content is the
 * agent's output, and a status that pushes it off screen has made things worse.
 */

import { colors, DIM, RESET } from '../ui/theme'

export type Phase = 'waiting' | 'thinking' | 'writing' | 'tool' | 'idle'

const LABELS: Record<Phase, string> = {
  waiting: 'waiting for model',
  thinking: 'thinking',
  writing: 'writing',
  tool: 'running',
  idle: '',
}

// Braille dots: one cell wide in every terminal that matters, and legible at the speed a spinner
// actually moves. Block characters flicker; ASCII spinners look like a progress bar that is lying.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export interface StatusLine {
  set(phase: Phase, detail?: string): void
  /** Erase the line. Safe to call repeatedly and when never started. */
  clear(): void
  stop(): void
}

/**
 * Start a status line on stderr.
 *
 * stderr rather than stdout so that `egirl cli -m … | jq` still gets clean output: a spinner
 * interleaved into a piped stream is worse than no spinner.
 */
export function createStatusLine(opts: { enabled?: boolean } = {}): StatusLine {
  const stream = process.stderr
  // Nothing to animate when output is redirected, and control codes in a log file are noise.
  const enabled = opts.enabled ?? Boolean(stream.isTTY)

  let phase: Phase = 'idle'
  let detail = ''
  let frame = 0
  let startedAt = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let painted = false

  const erase = (): void => {
    if (!enabled || !painted) return
    stream.write('\r\x1b[2K')
    painted = false
  }

  const paint = (): void => {
    if (!enabled || phase === 'idle') return
    const c = colors()
    const secs = Math.round((Date.now() - startedAt) / 1000)
    // Seconds appear only after a few of them: a counter that starts at 0s on every quick call
    // is visual noise, and the number only means anything once the wait is long enough to notice.
    const elapsed = secs >= 3 ? ` ${DIM}${secs}s${RESET}` : ''
    const tail = detail ? `${DIM} ${detail}${RESET}` : ''
    stream.write(
      `\r\x1b[2K${c.accent}${FRAMES[frame % FRAMES.length]}${RESET} ${DIM}${LABELS[phase]}${RESET}${tail}${elapsed}`,
    )
    painted = true
  }

  const tick = (): void => {
    frame++
    paint()
  }

  return {
    set(next: Phase, nextDetail?: string): void {
      // Restart the clock only on a real phase change: a tool call that reports its name twice
      // should not look like two separate operations.
      if (next !== phase) {
        phase = next
        startedAt = Date.now()
        frame = 0
      }
      detail = nextDetail ?? ''

      if (phase === 'idle') {
        erase()
        if (timer) clearInterval(timer)
        timer = undefined
        return
      }

      if (!timer && enabled) timer = setInterval(tick, 90)
      paint()
    },

    clear: erase,

    stop(): void {
      if (timer) clearInterval(timer)
      timer = undefined
      erase()
      phase = 'idle'
    },
  }
}

/**
 * Render context usage as a compact bar.
 *
 * Shown after every turn rather than only on demand, because the moment it matters -- the turn
 * before a compaction throws away the middle of the conversation -- is precisely the moment
 * nobody thinks to type `/context`.
 */
export function contextBar(utilization: number, used: number, budget: number): string {
  const c = colors()
  const pct = Math.round(utilization * 100)
  const width = 12
  const filled = Math.max(0, Math.min(width, Math.round(utilization * width)))

  // Thresholds match /context so the two never disagree about whether things are fine.
  const tone = pct > 80 ? c.error : pct > 60 ? c.warning : c.success

  return (
    `${DIM}[${RESET}${tone}${'█'.repeat(filled)}${RESET}${DIM}${'░'.repeat(width - filled)}]${RESET} ` +
    `${tone}${pct}%${RESET} ${DIM}${fmt(used)}/${fmt(budget)}${RESET}`
  )
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}
