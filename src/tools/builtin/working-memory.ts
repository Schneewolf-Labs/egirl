import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolResult } from '../types'

/**
 * working_memory — curated edits to MEMORY.md under a hard character budget.
 *
 * MEMORY.md is Tier-1 memory: loaded into the system prompt every session, so every byte in
 * it is paid on every request forever. Ported from hermes-agent's memory tool, whose central
 * idea is that the budget IS the curation mechanism: an `add` at capacity is rejected with
 * the current entries echoed back and an instruction to consolidate first — so working
 * memory can never grow monotonically, and the model is forced to merge or retire entries
 * the moment it wants room for a new one.
 *
 * Entries are lines. The file stays plain markdown a human can read and edit; headers and
 * bullets are all just entries to this tool.
 */

/** Hard budget for MEMORY.md. ~1k tokens of always-loaded prompt — deliberately tight. */
export const WORKING_MEMORY_MAX_CHARS = 4000

/** Consecutive failed mutations before the tool tells the model to stop retrying. */
const MAX_CONSECUTIVE_FAILURES = 3

interface Operation {
  op: 'add' | 'replace' | 'remove'
  text?: string
  match?: string
}

function readEntries(path: string): { entries: string[]; missing: boolean } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], missing: true }
    // An existing-but-unreadable file must abort, not read as empty — treating a failed
    // read as [] would turn the next add into a full-file rewrite (hermes issue class).
    throw new Error(`MEMORY.md exists but could not be read: ${err}`)
  }
  // Strip a BOM; it silently breaks entry matching forever.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  return {
    entries: raw.split('\n').filter((line) => line.trim().length > 0),
    missing: false,
  }
}

function writeEntries(path: string, entries: string[]): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${entries.join('\n')}\n`, 'utf8')
  renameSync(tmp, path)
}

function numbered(entries: string[]): string {
  return entries.map((e, i) => `${i + 1}. ${e}`).join('\n')
}

/** Find the entry an op targets: exact line match first, then unique substring, then index. */
function resolveMatch(entries: string[], match: string): number {
  const exact = entries.findIndex((e) => e === match)
  if (exact !== -1) return exact
  const containing = entries.map((e, i) => (e.includes(match) ? i : -1)).filter((i) => i !== -1)
  if (containing.length === 1) return containing[0] as number
  const asIndex = Number.parseInt(match, 10)
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= entries.length) return asIndex - 1
  return -1
}

/** Apply a batch atomically, budget-checked only on the FINAL state. */
export function applyOperations(
  entries: string[],
  operations: Operation[],
): { entries: string[]; error?: string } {
  const out = [...entries]
  for (const op of operations) {
    if (op.op === 'add') {
      const text = op.text?.trim()
      if (!text) return { entries, error: 'add requires text' }
      if (out.some((e) => e.trim() === text)) {
        return { entries, error: `Duplicate entry — already stored verbatim: "${text}"` }
      }
      out.push(text)
    } else if (op.op === 'remove') {
      if (!op.match) return { entries, error: 'remove requires match' }
      const idx = resolveMatch(out, op.match)
      if (idx === -1) return { entries, error: `No unique entry matches "${op.match}"` }
      out.splice(idx, 1)
    } else if (op.op === 'replace') {
      if (!op.match || !op.text?.trim()) {
        return { entries, error: 'replace requires match and text' }
      }
      const idx = resolveMatch(out, op.match)
      if (idx === -1) return { entries, error: `No unique entry matches "${op.match}"` }
      out[idx] = op.text.trim()
    } else {
      return { entries, error: `Unknown op "${(op as Operation).op}"` }
    }
  }
  return { entries: out }
}

export function createWorkingMemoryTool(workspaceDir: string): Tool {
  const path = join(workspaceDir, 'MEMORY.md')
  let consecutiveFailures = 0

  return {
    definition: {
      name: 'working_memory',
      description:
        'Curate MEMORY.md — your always-loaded working memory. Actions: "add" a new entry (one line), ' +
        '"replace" an entry (match by exact text, unique substring, or number from list), "remove" one, "list" all with sizes. ' +
        'Pass "operations" (an array of {op, text?, match?}) to batch remove+replace+add atomically — the budget is checked only on the final state. ' +
        `The file has a hard ${WORKING_MEMORY_MAX_CHARS}-character budget: when full, an add is rejected until you consolidate. ` +
        'Keep entries that must be true every session; deep history belongs in your notes, searchable facts in memory_set.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: '"add", "replace", "remove", or "list"',
          },
          text: { type: 'string', description: 'Entry text for add/replace (one line, concise)' },
          match: {
            type: 'string',
            description:
              'For replace/remove: exact entry text, a unique substring, or its number from list',
          },
          operations: {
            type: 'array',
            items: { type: 'object' },
            description:
              'Batch of {op: "add"|"replace"|"remove", text?, match?} applied atomically',
          },
        },
        required: ['action'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string | undefined

      let entries: string[]
      try {
        entries = readEntries(path).entries
      } catch (err) {
        return { success: false, output: String(err) }
      }
      const size = () => entries.join('\n').length

      if (action === 'list') {
        consecutiveFailures = 0
        if (entries.length === 0) {
          return {
            success: true,
            output: `Working memory is empty (budget ${WORKING_MEMORY_MAX_CHARS} chars).`,
          }
        }
        return {
          success: true,
          output: `${numbered(entries)}\n\n${size()}/${WORKING_MEMORY_MAX_CHARS} chars used.`,
        }
      }

      // Normalize single-action calls into the batch shape.
      let operations: Operation[]
      if (Array.isArray(params.operations) && params.operations.length > 0) {
        operations = params.operations as Operation[]
      } else if (action === 'add' || action === 'replace' || action === 'remove') {
        operations = [
          {
            op: action,
            ...(typeof params.text === 'string' && { text: params.text }),
            ...(typeof params.match === 'string' && { match: params.match }),
          },
        ]
      } else {
        return { success: false, output: 'action must be "add", "replace", "remove", or "list"' }
      }

      const fail = (output: string): ToolResult => {
        consecutiveFailures++
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          return {
            success: false,
            output: `${output}\n\nThis is failed attempt ${consecutiveFailures} in a row — STOP retrying working_memory now and continue your actual task. Try again in a later turn with a fresh look at the entries.`,
          }
        }
        return { success: false, output }
      }

      const applied = applyOperations(entries, operations)
      if (applied.error) return fail(applied.error)

      const newSize = applied.entries.join('\n').length
      if (newSize > WORKING_MEMORY_MAX_CHARS) {
        // The load-bearing rejection: no room means consolidate NOW, in this same turn.
        return fail(
          `Rejected: result would be ${newSize} chars, over the ${WORKING_MEMORY_MAX_CHARS}-char budget. ` +
            'Working memory must stay small — consolidate now: merge overlapping entries with "replace", drop stale ones with "remove" (or batch it all in one "operations" call), then retry this add in the same turn.\n\nCurrent entries:\n' +
            numbered(entries),
        )
      }

      try {
        writeEntries(path, applied.entries)
      } catch (err) {
        return fail(`Failed to write MEMORY.md: ${err}`)
      }
      consecutiveFailures = 0
      entries = applied.entries
      // Deliberately no entry echo: echoing the saved text back was observed (hermes) to
      // trigger the model re-saving the same entry repeatedly.
      return {
        success: true,
        output: `Saved. This update is complete — do not repeat it. ${newSize}/${WORKING_MEMORY_MAX_CHARS} chars used.`,
      }
    },
  }
}
