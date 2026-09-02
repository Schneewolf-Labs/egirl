import type { AgentEventHandler } from '../agent/events'
import type { ToolCall } from '../providers/types'

/**
 * Tool-call narration for plain-text chat transports (XMPP, Matrix).
 *
 * These surfaces have no embeds or reactions to hang progress off, so the tool calls a turn
 * made are collected while the agent runs and prefixed to the final reply -- one compact line
 * per call ("🔍 Web Search: \"schneewolf labs llc\""), then a blank line, then her reply. The
 * raw arguments and results stay out of the chat; the web UI and traces are where that lives.
 */

export interface PlainEventState {
  entries: Array<{ call: string; result?: string }>
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
}

const FAMILY_META: Array<[string, ToolMeta]> = [
  ['browser_', { icon: '🌐', label: 'Browser' }],
  ['github_', { icon: '🐙', label: 'GitHub' }],
  ['git_', { icon: '🔀', label: 'Git' }],
  ['memory_', { icon: '🧠', label: 'Memory' }],
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

function formatToolCallCompact(call: ToolCall): string {
  const meta = metaFor(call.name)
  const arg = keyArg(call, meta.arg)
  return arg ? `${meta.icon} ${meta.label}: ${arg}` : `${meta.icon} ${meta.label}`
}

export function createPlainEventHandler(): { handler: AgentEventHandler; state: PlainEventState } {
  const state: PlainEventState = { entries: [] }

  const handler: AgentEventHandler = {
    onToolCallStart(calls: ToolCall[]) {
      for (const call of calls) {
        state.entries.push({ call: formatToolCallCompact(call) })
      }
    },
  }

  return { handler, state }
}

export function buildToolCallPrefix(state: PlainEventState): string {
  if (state.entries.length === 0) return ''
  return `${state.entries.map((e) => e.call).join('\n')}\n\n`
}
