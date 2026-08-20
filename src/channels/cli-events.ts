import type { AgentEventHandler } from '../agent/events'
import type { ToolCall } from '../providers/types'
import type { ToolResult } from '../tools/types'
import { colors, DIM, RESET } from '../ui/theme'
import type { StatusLine } from './cli-status'

export interface CLIEventState {
  streamed: boolean
  showThinking: boolean
  /** Reasoning was already printed live, so the block that arrives at the end is a duplicate. */
  streamedThinking: boolean
}

function truncateResult(output: string, maxLen: number): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  if (trimmed.length <= maxLen) return trimmed
  return `${trimmed.substring(0, maxLen)}...`
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  if (entries.length === 1) {
    const entry = entries[0]
    if (!entry) return ''
    const [key, val] = entry
    const valStr = typeof val === 'string' ? val : JSON.stringify(val)
    if (valStr.length < 60) return `${key}: ${valStr}`
  }
  return JSON.stringify(args, null, 2)
}

/**
 * Build the per-run event handler that prints thinking text, tool calls,
 * streamed tokens, and completion markers to stdout.
 * Returns the handler and a state object the caller checks to see whether
 * streaming actually happened (so it can print the response directly if not).
 */
export function createCLIEventHandler(
  showThinking: boolean,
  status?: StatusLine,
): {
  handler: AgentEventHandler
  state: CLIEventState
} {
  const state: CLIEventState = { streamed: false, showThinking, streamedThinking: false }

  const handler: AgentEventHandler = {
    // Reasoning as it happens. On a reasoning model this is most of the turn, so printing it
    // live is the difference between watching the model work and staring at a blank terminal
    // for a minute. Dimmed and unprefixed per token: it is context, not the answer.
    onThinkingToken(token: string) {
      // Reasoning arriving means prefill is over and the model is genuinely deliberating.
      // With the reasoning hidden, the spinner is the only sign of that; with it shown, the
      // text is its own progress and an animation repainting over it would corrupt the output.
      if (!state.showThinking) {
        status?.set('thinking')
        return
      }
      status?.set('idle')
      if (!state.streamedThinking) {
        const c = colors()
        process.stdout.write(`${DIM}${c.info}[thinking]${RESET}${DIM}\n`)
        state.streamedThinking = true
      }
      process.stdout.write(`${DIM}${token}${RESET}`)
    },

    onThinking(text: string) {
      status?.clear()
      // Already shown token by token; reprinting the assembled block would double it.
      if (state.streamedThinking) return
      if (!state.showThinking || !text.trim()) return
      const c = colors()
      const lines = text.trim().split('\n')
      const maxLines = 20
      const display =
        lines.length > maxLines
          ? [...lines.slice(0, maxLines), `  ... (${lines.length - maxLines} more lines)`].join(
              '\n',
            )
          : text.trim()
      process.stdout.write(`${DIM}${c.info}[thinking]${RESET}${DIM}\n${display}${RESET}\n`)
    },

    onToolCallStart(calls: ToolCall[]) {
      status?.clear()
      const c = colors()
      for (const call of calls) {
        const args = formatArgs(call.arguments)
        if (args.includes('\n')) {
          process.stdout.write(
            `${DIM}  ${c.accent}>${RESET}${DIM} ${call.name}(\n${args}\n  )${RESET}\n`,
          )
        } else {
          process.stdout.write(`${DIM}  ${c.accent}>${RESET}${DIM} ${call.name}(${args})${RESET}\n`)
        }
      }
      // Now the wait is the tool, not the model — say which one is running.
      status?.set('tool', calls.map((call) => call.name).join(', '))
    },

    onToolCallComplete(_callId: string, name: string, result: ToolResult) {
      status?.clear()
      const c = colors()
      // Named `outcome` rather than `status`: the status line is in scope here.
      const outcome = result.success ? `${c.success}ok${RESET}` : `${c.error}err${RESET}`
      const preview = truncateResult(result.output, 200)
      process.stdout.write(`${DIM}  < ${name} ${outcome}${RESET}\n`)
      if (preview) {
        for (const line of preview.split('\n')) {
          process.stdout.write(`${DIM}    ${line}${RESET}\n`)
        }
      }
      // Control returns to the model, which will deliberate again before its next move.
      status?.set('waiting')
    },

    onToken(token: string) {
      if (!state.streamed) {
        // First content token: the answer has started, and the answer streaming in is better
        // feedback than any spinner. Stop it rather than let it repaint over the text.
        status?.set('idle')
        const c = colors()
        // Close the reasoning block so the answer does not run on from the last thought.
        if (state.streamedThinking) process.stdout.write('\n')
        process.stdout.write(`\n${c.secondary}egirl>${RESET} `)
        state.streamed = true
      }
      process.stdout.write(token)
    },

    onResponseComplete() {
      if (state.streamed) {
        process.stdout.write('\n\n')
      }
    },
  }

  return { handler, state }
}
