import type { AgentEventHandler } from '../agent/events'
import type { ToolCall } from '../providers/types'

/**
 * Tool-call narration for chat channels.
 *
 * Chat surfaces have no live tool panel, so the tool calls a turn made are collected while
 * the agent runs and prefixed to the final reply -- one compact line per call
 * ("🔍 Web Search: \"schneewolf labs llc\""), then a blank line, then her reply. The raw
 * arguments and results stay out of the chat; the web UI and traces are where that lives.
 *
 * Markdown-capable surfaces (Discord) get the lines in a code block so underscores and
 * asterisks in a shell command or a path are not rendered as formatting.
 */

export type NarrationFormat = 'plain' | 'markdown'

export interface NarrationState {
  lines: string[]
}

interface ToolMeta {
  icon: string
  label: string
  /** Argument key to surface after the label, when present. */
  arg?: string
}

// Exact tool names first; then prefix families; then a humanized fallback.
const TOOL_META: Record<string, ToolMeta> = {
  web_search: { icon: '🔍', label: 'Web Search', arg: 'query' },
  web_research: { icon: '🔍', label: 'Web Research', arg: 'query' },
  web_fetch: { icon: '🌐', label: 'Fetch', arg: 'url' },
  execute_command: { icon: '💻', label: 'Shell', arg: 'command' },
  code_agent: { icon: '🤖', label: 'Code Agent', arg: 'prompt' },
  read_file: { icon: '📄', label: 'Read', arg: 'path' },
  write_file: { icon: '✏️', label: 'Write', arg: 'path' },
  edit_file: { icon: '✏️', label: 'Edit', arg: 'path' },
  list_directory: { icon: '📁', label: 'List', arg: 'path' },
  memory_get: { icon: '🧠', label: 'Recall', arg: 'query' },
  memory_search: { icon: '🧠', label: 'Recall', arg: 'query' },
  memory_list: { icon: '🧠', label: 'Memory' },
  memory_set: { icon: '🧠', label: 'Remember', arg: 'name' },
  report: { icon: '📣', label: 'Report', arg: 'mode' },
}

const FAMILY_META: Array<[string, ToolMeta]> = [
  ['browser_', { icon: '🌐', label: 'Browser' }],
  ['github_', { icon: '🐙', label: 'GitHub' }],
  ['git_', { icon: '🔀', label: 'Git' }],
  ['memory_', { icon: '🧠', label: 'Memory' }],
  ['task_', { icon: '🗓️', label: 'Task' }],
]

function humanize(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function metaFor(name: string): ToolMeta {
  const exact = TOOL_META[name]
  if (exact) return exact
  for (const [prefix, meta] of FAMILY_META) {
    if (name.startsWith(prefix)) return meta
  }
  return { icon: '🛠️', label: humanize(name) }
}

/** The one argument worth showing: the mapped key if present, else the first non-empty string. */
function keyArg(call: ToolCall, preferred?: string): string {
  const args = call.arguments
  let val: unknown
  if (preferred && preferred in args) {
    val = args[preferred]
  } else {
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v.trim()) {
        val = v
        break
      }
    }
  }
  if (val === undefined || val === null) return ''
  const isString = typeof val === 'string'
  let s = (typeof val === 'string' ? val : JSON.stringify(val)).replace(/\s+/g, ' ').trim()
  if (!s) return ''
  if (s.length > 50) s = `${s.slice(0, 50)}…`
  return isString ? `"${s}"` : s
}

export function formatToolCallCompact(call: ToolCall): string {
  const meta = metaFor(call.name)
  const arg = keyArg(call, meta.arg)
  return arg ? `${meta.icon} ${meta.label}: ${arg}` : `${meta.icon} ${meta.label}`
}

export function createNarration(): { handler: AgentEventHandler; state: NarrationState } {
  const state: NarrationState = { lines: [] }

  const handler: AgentEventHandler = {
    onToolCallStart(calls: ToolCall[]) {
      for (const call of calls) {
        state.lines.push(formatToolCallCompact(call))
      }
    },
  }

  return { handler, state }
}

/** The narration block to put in front of a reply; empty when the turn used no tools. */
export function buildToolCallPrefix(state: NarrationState, format: NarrationFormat): string {
  if (state.lines.length === 0) return ''
  const body = state.lines.join('\n')
  if (format === 'markdown') return `\`\`\`\n${body}\n\`\`\`\n`
  return `${body}\n\n`
}
