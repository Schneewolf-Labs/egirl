import type { AgentEventHandler } from '../../agent/events'
import type { ToolCall } from '../../providers/types'
import type { ToolResult } from '../../tools/types'
import { formatToolCallsMarkdown, truncateResult } from './formatting'

export interface ToolCallEntry {
  call: string
  result?: string
}

export interface DiscordEventState {
  entries: ToolCallEntry[]
}

export function createDiscordEventHandler(): {
  handler: AgentEventHandler
  state: DiscordEventState
} {
  const state: DiscordEventState = { entries: [] }

  const handler: AgentEventHandler = {
    onToolCallStart(calls: ToolCall[]) {
      for (const call of calls) {
        state.entries.push({ call: formatToolCallsMarkdown([call]) })
      }
    },

    onToolCallComplete(_callId: string, name: string, result: ToolResult) {
      // Find the matching entry and attach the result
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

export function buildToolCallPrefix(state: DiscordEventState): string {
  if (state.entries.length === 0) return ''
  const lines = state.entries.map((e) => {
    if (e.result) return `${e.call}\n${e.result}`
    return e.call
  })
  return `\`\`\`\n${lines.join('\n')}\n\`\`\`\n`
}
