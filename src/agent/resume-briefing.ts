import type { ChatMessage } from '../providers/types'
import { getTextContent } from '../providers/types'

/**
 * What the model is told when it picks a saved conversation back up.
 *
 * A restarted instance reloads its transcript, but nothing in it says that time passed, that
 * the last run was cut off mid-action, or that the world may have moved since. An operator
 * agent reported rebuilding its mission state from MEMORY.md and `git status` after every
 * restart. This briefing is built mechanically from the reloaded transcript -- no model call --
 * and goes in once, ahead of the first new message, as an ephemeral note that is not saved.
 */

export const RESUME_PREFIX = '[System: Resuming this conversation.'

/** A clean ending this long ago still gets a briefing: the world may have moved. */
export const RESUME_GAP_MS = 30 * 60_000

const FILE_TOOLS = new Set(['write_file', 'edit_file'])
const MAX_FILES = 8

export interface ResumeOptions {
  /** When the transcript was last written, if known. */
  lastActiveAt?: number
  now: number
}

/** The briefing, or undefined when the conversation ended cleanly and recently. */
export function buildResumeBriefing(
  messages: ChatMessage[],
  opts: ResumeOptions,
): string | undefined {
  const saved = messages.filter((m) => !m.ephemeral)
  if (saved.length === 0) return undefined
  const ending = howItEnded(saved)
  const gap = opts.lastActiveAt !== undefined ? opts.now - opts.lastActiveAt : undefined
  if (!ending && (gap === undefined || gap < RESUME_GAP_MS)) return undefined

  const since = gap !== undefined ? ` Its last activity was ${ago(gap)} ago.` : ''
  const lines = [`${RESUME_PREFIX}${since}]`]
  if (ending) lines.push(ending)

  const askedAt = lastOperatorInput(saved)
  if (askedAt >= 0) {
    const asked = getTextContent(saved[askedAt]?.content ?? '')?.trim() ?? ''
    lines.push(`The operator's last request: ${clip(asked, 300)}`)
    const { calls, files } = actionsSince(saved, askedAt)
    if (calls) lines.push(`Your tool calls since then: ${calls}`)
    if (files) lines.push(`Files you wrote or edited since then: ${files}`)
  }
  lines.push(
    'Things may have changed while you were away: processes from process_start are gone, and ' +
      'files, git state and config may differ. Check the current state (and your notes) before ' +
      'acting on what the transcript says.',
  )
  return lines.join('\n')
}

/** How the last run ended, when it did not end with a reply. */
function howItEnded(messages: ChatMessage[]): string | undefined {
  const last = messages[messages.length - 1]
  if (!last) return undefined
  if (last.role === 'tool') {
    return 'The last run stopped after tool results came back and before you answered them (an interrupt, a crash or a restart).'
  }
  if (last.role === 'assistant' && last.tool_calls?.length) {
    const names = last.tool_calls.map((c) => c.name).join(', ')
    return `The last run stopped while these tool calls were running, and their results were never recorded: ${names}.`
  }
  if (last.role === 'user' && isOperatorInput(last)) {
    return 'The last run stopped before you answered the operator’s last message.'
  }
  return undefined
}

function isOperatorInput(m: ChatMessage): boolean {
  if (m.role !== 'user') return false
  const text = getTextContent(m.content)?.trim()
  return Boolean(text) && !text?.startsWith('[System:') && !text?.startsWith('[Warning:')
}

function lastOperatorInput(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && isOperatorInput(m)) return i
  }
  return -1
}

/** Tool calls after `from`, counted by name in order of first use, and the files written. */
function actionsSince(messages: ChatMessage[], from: number): { calls: string; files: string } {
  const counts = new Map<string, number>()
  const files: string[] = []
  for (const m of messages.slice(from + 1)) {
    for (const call of m.role === 'assistant' ? (m.tool_calls ?? []) : []) {
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
      const path = call.arguments?.path
      if (FILE_TOOLS.has(call.name) && typeof path === 'string' && !files.includes(path)) {
        files.push(path)
      }
    }
  }
  const calls = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
  const shown = files.slice(-MAX_FILES)
  const more = files.length - shown.length
  return { calls, files: `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}` }
}

function ago(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'under a minute'
  if (mins < 90) return `${mins} min`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} days`
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
