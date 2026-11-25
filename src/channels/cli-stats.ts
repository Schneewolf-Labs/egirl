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

/**
 * Both handlers' streaming hooks, `primary` first. Only the three hooks stats listen to are
 * merged; everything else is `primary`'s own.
 */
export function withStats(primary: AgentEventHandler, stats: RunStats): AgentEventHandler {
  const { onToken, onThinkingToken, onModelTurn } = stats.events
  return {
    ...primary,
    onToken(token) {
      primary.onToken?.(token)
      onToken?.(token)
    },
    onThinkingToken(token) {
      primary.onThinkingToken?.(token)
      onThinkingToken?.(token)
    },
    onModelTurn(turn) {
      primary.onModelTurn?.(turn)
      onModelTurn?.(turn)
    },
  }
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}
