/**
 * Diffs for the file tools, for the CLI's tool-call lines.
 *
 * `start` sees each call as it begins: for write_file it reads the file as it is now, the
 * "before" of the diff (a missing file is a new one). `finish` renders the change once the
 * call has succeeded. Files too big to diff usefully are skipped.
 */

import { readFileSync, statSync } from 'node:fs'
import type { ToolCall } from '../providers/types'
import { colors, DIM, RESET } from '../ui/theme'
import { resolveUserPath } from '../util/paths'
import { renderDiff } from './cli-diff'

const MAX_BYTES = 256 * 1024

export interface EditDiffs {
  start(call: ToolCall): void
  /** Lines to print under a finished call, or undefined for none. */
  finish(callId: string, success: boolean, columns: number): string[] | undefined
}

interface Pending {
  path: string
  before: string
  after: string
  isNew: boolean
}

export function createEditDiffs(cwd: string | undefined): EditDiffs {
  const pending = new Map<string, Pending>()
  return {
    start(call) {
      const entry = planned(call, cwd)
      if (entry) pending.set(call.id ?? call.name, entry)
    },
    finish(callId, success, columns) {
      const entry = pending.get(callId)
      pending.delete(callId)
      if (!entry || !success) return undefined
      const view = renderDiff(entry.before, entry.after, { width: Math.max(20, columns - 8) })
      if (!view) return undefined
      const c = colors()
      const counts = `${c.success}+${view.added}${RESET} ${c.error}−${view.removed}${RESET}`
      const label = entry.isNew ? `${DIM}new file${RESET} ` : ''
      return [`${label}${entry.path} ${counts}`, ...view.lines]
    },
  }
}

function planned(call: ToolCall, cwd: string | undefined): Pending | undefined {
  const args = call.arguments ?? {}
  const path = typeof args.path === 'string' ? args.path : undefined
  if (!path) return undefined
  if (call.name === 'edit_file') {
    const before = args.old_text
    const after = args.new_text
    if (typeof before !== 'string' || typeof after !== 'string') return undefined
    return { path, before, after, isNew: false }
  }
  if (call.name === 'write_file' && typeof args.content === 'string' && cwd) {
    if (args.content.length > MAX_BYTES) return undefined
    const now = readCurrent(resolveUserPath(path, cwd))
    if (!now) return undefined
    return { path, before: now.text, after: args.content, isNew: !now.exists }
  }
  return undefined
}

/** The file now (empty when it does not exist yet); undefined when too big or unreadable. */
function readCurrent(full: string): { text: string; exists: boolean } | undefined {
  let size: number
  try {
    size = statSync(full).size
  } catch {
    return { text: '', exists: false }
  }
  if (size > MAX_BYTES) return undefined
  try {
    return { text: readFileSync(full, 'utf8'), exists: true }
  } catch {
    return undefined
  }
}
