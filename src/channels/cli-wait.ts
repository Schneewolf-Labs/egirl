/**
 * What to say while a request is out and nothing has come back.
 *
 * A hosted OpenAI-compatible API sends nothing at all until its first token -- not headers, not
 * a keep-alive (measured on uncensuredai.com: headers, first byte and first token all at once) --
 * so there is no progress to report, only how long it has been. This adds the two things that
 * are known: roughly how big the prompt is, and how long the first token usually takes in this
 * session, with a bar against that. A llama-server's real prefill progress takes over from it.
 */

import type { AgentEventHandler } from '../agent/events'
import { colors, DIM, RESET } from '../ui/theme'

/** Recent time-to-first-token samples for this session. */
export interface WaitHistory {
  record(ms: number): void
  /** The median of the recent samples, or undefined before there are any. */
  typical(): number | undefined
}

export function createWaitHistory(keep = 5): WaitHistory {
  const samples: number[] = []
  return {
    record(ms) {
      samples.push(ms)
      if (samples.length > keep) samples.shift()
    },
    typical() {
      if (samples.length === 0) return undefined
      const sorted = [...samples].sort((a, b) => a - b)
      return sorted[Math.floor(sorted.length / 2)]
    },
  }
}

export type WaitEvents = Pick<
  AgentEventHandler,
  'onToken' | 'onThinkingToken' | 'onPromptProgress' | 'onToolCallComplete' | 'onModelTurn'
>

export interface WaitTracker {
  events: WaitEvents
  /** The waiting segment, or '' when a request is not waiting on its first sign of life. */
  render(): string
}

const BAR_CELLS = 8

/**
 * Track one run's requests. A request starts with the run and again when a tool finishes; it
 * stops waiting at its first token, reasoning token or prefill report.
 */
export function createWaitTracker(opts: {
  history: WaitHistory
  /** The last prompt's size before this run measured one of its own. */
  initialPromptTokens: () => number | undefined
  now?: () => number
}): WaitTracker {
  const now = opts.now ?? Date.now
  let waitingSince: number | undefined = now()
  let promptTokens: number | undefined

  const signal = (): void => {
    if (waitingSince === undefined) return
    opts.history.record(now() - waitingSince)
    waitingSince = undefined
  }

  return {
    events: {
      onToken: signal,
      onThinkingToken: signal,
      onPromptProgress: signal,
      onToolCallComplete() {
        waitingSince = now()
      },
      onModelTurn(turn) {
        // A response that arrived whole (no stream) still ended the wait.
        signal()
        const input = turn.response.usage.input_tokens
        if (input > 0) promptTokens = input
      },
    },
    render() {
      if (waitingSince === undefined) return ''
      const c = colors()
      const parts: string[] = []
      const prompt = promptTokens ?? opts.initialPromptTokens()
      if (prompt) parts.push(`~${c.info}${compact(prompt)}${RESET} prompt`)
      const typical = opts.history.typical()
      if (typical !== undefined && typical >= 1000) {
        const elapsed = now() - waitingSince
        const usually = `usually ~${Math.round(typical / 1000)}s`
        if (elapsed > typical * 1.5) {
          parts.push(`${c.warning}slower than usual${RESET} ${DIM}(${usually})${RESET}`)
        } else {
          const filled = Math.min(BAR_CELLS, Math.round((elapsed / typical) * BAR_CELLS))
          const bar = `${c.accent}${'▰'.repeat(filled)}${RESET}${DIM}${'▱'.repeat(BAR_CELLS - filled)}${RESET}`
          parts.push(`${usually} ${bar}`)
        }
      }
      return parts.join(`${DIM} · ${RESET}`)
    },
  }
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}
