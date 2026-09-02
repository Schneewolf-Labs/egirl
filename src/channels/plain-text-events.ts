import type { AgentEventHandler } from '../agent/events'
import type { ToolCall } from '../providers/types'
import type { ToolResult } from '../tools/types'

/**
 * Tool-call narration for plain-text chat transports (XMPP, Telegram).
 *
 * No embeds, no code blocks, no reactions -- just a short "what I ran and how it went" preamble
 * stitched on top of the reply so the human sees the work, not only the conclusion.
 */

function formatToolCallPlain(call: ToolCall): string {
  const args = Object.entries(call.arguments)
  if (args.length === 0) return `${call.name}()`
  if (args.length === 1) {
    const entry = args[0]
    if (!entry) return `${call.name}()`
    const [key, val] = entry
    const valStr = typeof val === 'string' ? val : JSON.stringify(val)
    if (valStr.length < 60) return `${call.name}(${key}: ${valStr})`
  }
  return `${call.name}(${JSON.stringify(call.arguments)})`
}

function truncateResult(output: string, maxLen: number): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  if (trimmed.length <= maxLen) return trimmed
  return `${trimmed.substring(0, maxLen)}...`
}

export interface PlainTextEventState {
  entries: Array<{ call: string; result?: string }>
}

export function createPlainTextEventHandler(): {
  handler: AgentEventHandler
  state: PlainTextEventState
} {
  const state: PlainTextEventState = { entries: [] }

  const handler: AgentEventHandler = {
    onToolCallStart(calls: ToolCall[]) {
      for (const call of calls) {
        state.entries.push({ call: formatToolCallPlain(call) })
      }
    },

    onToolCallComplete(_callId: string, name: string, result: ToolResult) {
      const entry = state.entries.find((e) => e.call.startsWith(name) && !e.result)
      if (entry) {
        const status = result.success ? 'ok' : 'err'
        const preview = truncateResult(result.output, 150)
        entry.result = `  -> ${status}${preview ? `: ${preview}` : ''}`
      }
    },
  }

  return { handler, state }
}

/** The narration block to prepend to a reply, or '' when no tools ran. */
export function buildToolCallPrefix(state: PlainTextEventState): string {
  if (state.entries.length === 0) return ''
  const lines = state.entries.map((e) => {
    if (e.result) return `${e.call}\n${e.result}`
    return e.call
  })
  return `${lines.join('\n')}\n\n`
}
