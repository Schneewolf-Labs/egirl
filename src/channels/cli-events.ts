import type { AgentEventHandler } from '../agent/events'
import type { ToolCall } from '../providers/types'
import type { ToolResult } from '../tools/types'
import { colors, DIM, RESET } from '../ui/theme'

export interface CLIEventState {
  streamed: boolean
  showThinking: boolean
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
export function createCLIEventHandler(showThinking: boolean): {
  handler: AgentEventHandler
  state: CLIEventState
} {
  const state: CLIEventState = { streamed: false, showThinking }

  const handler: AgentEventHandler = {
    onThinking(text: string) {
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
    },

    onToolCallComplete(_callId: string, name: string, result: ToolResult) {
      const c = colors()
      const status = result.success ? `${c.success}ok${RESET}` : `${c.error}err${RESET}`
      const preview = truncateResult(result.output, 200)
      process.stdout.write(`${DIM}  < ${name} ${status}${RESET}\n`)
      if (preview) {
        for (const line of preview.split('\n')) {
          process.stdout.write(`${DIM}    ${line}${RESET}\n`)
        }
      }
    },

    onToken(token: string) {
      if (!state.streamed) {
        const c = colors()
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
