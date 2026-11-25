/**
 * Quick-glance numbers for a running turn, shown after the spinner on the live line:
 *
 *   ⠸ thinking 12s · step 3/10 · ↓1.2k 41/s · ctx 63% · 2 queued ♡
 *
 * A local model can sit in prefill or hidden reasoning for minutes; a token counter that moves
 * is the difference between "working" and "hung". Fed by the run's own events, so it costs
 * nothing extra, and toggled per session with /stats.
 */

import type { AgentEventHandler } from '../agent/events'
import type { PromptProgress } from '../providers/types'
import { colors, DIM, RESET } from '../ui/theme'

export interface RunStatsOptions {
  maxTurns: number
  /** The window size, once known (the previous context readout supplies it). */
  contextLength: () => number | undefined
  queued: () => number
  isEnabled: () => boolean
  now?: () => number
}

export interface RunStats {
  /** Events to merge into the run's handler. */
  events: Pick<AgentEventHandler, 'onToken' | 'onThinkingToken' | 'onModelTurn'>
  /** The stats segment, or '' when there is nothing to show or stats are off. */
  render(): string
}

export function createRunStats(opts: RunStatsOptions): RunStats {
  const now = opts.now ?? Date.now
  let completedSteps = 0
  let tokens = 0
  // Rate over the current step's stream: tokens since its first token, over the time since.
  let stepTokens = 0
  let stepFirstTokenAt: number | undefined
  let lastPromptTokens: number | undefined

  const onTokenish = (): void => {
    tokens++
    stepTokens++
    stepFirstTokenAt ??= now()
  }

  return {
    events: {
      onToken: onTokenish,
      onThinkingToken: onTokenish,
      onModelTurn(turn) {
        completedSteps++
        stepTokens = 0
        stepFirstTokenAt = undefined
        const input = turn.response.usage.input_tokens
        if (input > 0) lastPromptTokens = input
      },
    },
    render() {
      if (!opts.isEnabled()) return ''
      const c = colors()
      const value = (s: string): string => `${c.info}${s}${RESET}`
      const step = Math.min(completedSteps + 1, opts.maxTurns)
      const parts = [`step ${value(`${step}/${opts.maxTurns}`)}`]
      if (tokens > 0) {
        const secs = stepFirstTokenAt === undefined ? 0 : (now() - stepFirstTokenAt) / 1000
        const rate =
          secs >= 1 && stepTokens > 0 ? ` ${value(`${Math.round(stepTokens / secs)}/s`)}` : ''
        parts.push(`↓${value(compact(tokens))}${rate}`)
      }
      const length = opts.contextLength()
      if (lastPromptTokens !== undefined && length) {
        parts.push(`ctx ${value(`${Math.round((lastPromptTokens / length) * 100)}%`)}`)
      }
      const queued = opts.queued()
      if (queued > 0) parts.push(`${value(String(queued))} queued`)
      return parts.join(`${DIM} · ${RESET}`)
    },
  }
}

/** The hooks listeners may add; everything else on the handler is the renderer's own. */
type Listener = Pick<
  AgentEventHandler,
  'onToken' | 'onThinkingToken' | 'onPromptProgress' | 'onToolCallComplete' | 'onModelTurn'
>

/** `primary` with each listener's hooks called after its own. */
export function withListeners(
  primary: AgentEventHandler,
  listeners: Listener[],
): AgentEventHandler {
  return {
    ...primary,
    onToken(token) {
      primary.onToken?.(token)
      for (const l of listeners) l.onToken?.(token)
    },
    onThinkingToken(token) {
      primary.onThinkingToken?.(token)
      for (const l of listeners) l.onThinkingToken?.(token)
    },
    onPromptProgress(progress) {
      primary.onPromptProgress?.(progress)
      for (const l of listeners) l.onPromptProgress?.(progress)
    },
    onToolCallComplete(callId, name, result) {
      primary.onToolCallComplete?.(callId, name, result)
      for (const l of listeners) l.onToolCallComplete?.(callId, name, result)
    },
    onModelTurn(turn) {
      primary.onModelTurn?.(turn)
      for (const l of listeners) l.onModelTurn?.(turn)
    },
  }
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

const BAR_CELLS = 8

/**
 * The prefill detail: `▰▰▱▱▱▱▱▱ 2.0k/12.1k · 8.2k/s · ~2s left · 70k cached`. Cached tokens
 * cost nothing, so the bar, the count and the time left cover only the part being computed --
 * a prompt that is mostly cache would otherwise show a nearly full bar from the start.
 */
export function renderPrefill(p: PromptProgress, rate: number | undefined): string {
  const c = colors()
  const cached = Math.min(p.cached ?? 0, p.total)
  const todo = p.total - cached
  const done = Math.max(0, Math.min(todo, p.processed - cached))
  const fraction = todo > 0 ? done / todo : 1
  const filled = Math.round(fraction * BAR_CELLS)
  const bar = `${c.accent}${'▰'.repeat(filled)}${RESET}${DIM}${'▱'.repeat(BAR_CELLS - filled)}${RESET}`
  const parts = [`${bar} ${c.info}${compact(done)}/${compact(todo)}${RESET}`]
  if (rate !== undefined && rate > 0) {
    parts.push(`${c.info}${compact(Math.round(rate))}/s${RESET}`)
    const left = Math.ceil((todo - done) / rate)
    if (left > 0) parts.push(`~${duration(left)} left`)
  }
  if (cached > 0) parts.push(`${compact(cached)} cached`)
  return parts.join(`${DIM} · ${RESET}`)
}

function duration(secs: number): string {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  return m < 60 ? `${m}m${secs % 60 ? ` ${secs % 60}s` : ''}` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * Prefill rate in tokens per second of actual computation (cached tokens are free). Uses the
 * server's own clock when it sends one; otherwise measures between this request's reports.
 * A new request (processed going backwards) starts a new measurement.
 */
export function createPrefillRate(
  now: () => number = Date.now,
): (p: PromptProgress) => number | undefined {
  let first: { processed: number; at: number } | undefined
  return (p) => {
    const computed = p.processed - (p.cached ?? 0)
    if (p.elapsedMs !== undefined && p.elapsedMs > 0) return (computed / p.elapsedMs) * 1000
    if (!first || p.processed < first.processed) first = { processed: p.processed, at: now() }
    const secs = (now() - first.at) / 1000
    return secs >= 0.5 ? (p.processed - first.processed) / secs : undefined
  }
}
