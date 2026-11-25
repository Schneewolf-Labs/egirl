/**
 * What a file edit changed, as a short coloured diff under the tool call.
 *
 * The call line showed `old_text: ‹3 lines›, new_text: ‹4 lines›` -- enough to know an edit
 * happened, not what it did. Watching an agent work means seeing the change itself. An
 * edit_file diff comes from its own arguments; a write_file diff needs the file as it was,
 * read just before the write runs. A plain line diff (longest common subsequence), with a
 * couple of lines of context per change and a cap on how much is printed.
 */

import { colors, DIM, RESET } from '../ui/theme'

export type DiffOp = { kind: 'same' | 'add' | 'del'; text: string }

/** Beyond this many line pairs the table costs more than the picture is worth. */
const MAX_CELLS = 1_000_000

/** Line diff of `a` to `b`. Very large inputs fall back to all-removed, all-added. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  // Common head and tail first: most edits touch a few lines in the middle.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head = a.slice(0, start).map((text) => ({ kind: 'same' as const, text }))
  const tail = a.slice(endA).map((text) => ({ kind: 'same' as const, text }))
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)

  let middle: DiffOp[]
  if (x.length * y.length > MAX_CELLS) {
    middle = [
      ...x.map((text) => ({ kind: 'del' as const, text })),
      ...y.map((text) => ({ kind: 'add' as const, text })),
    ]
  } else {
    // lcs[i][j]: common subsequence length of x[i..] and y[j..].
    const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
    for (let i = x.length - 1; i >= 0; i--) {
      const row = lcs[i] as number[]
      const below = lcs[i + 1] as number[]
      for (let j = y.length - 1; j >= 0; j--) {
        row[j] = x[i] === y[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
      }
    }
    middle = []
    let i = 0
    let j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        middle.push({ kind: 'same', text: x[i] as string })
        i++
        j++
      } else if (
        // On a tie the removal goes first, so a changed line reads - old, + new.
        i < x.length &&
        (j >= y.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
      ) {
        middle.push({ kind: 'del', text: x[i] as string })
        i++
      } else {
        middle.push({ kind: 'add', text: y[j] as string })
        j++
      }
    }
  }
  return [...head, ...middle, ...tail]
}

export interface DiffView {
  lines: string[]
  added: number
  removed: number
}

/**
 * The changed lines with `context` lines around each, in at most `maxLines` rows. Gaps between
 * changes are marked with ⋯. Undefined when nothing changed.
 */
export function renderDiff(
  before: string,
  after: string,
  opts: { context?: number; maxLines?: number; width?: number } = {},
): DiffView | undefined {
  const context = opts.context ?? 2
  const maxLines = opts.maxLines ?? 24
  const width = opts.width ?? 120
  const ops = diffLines(splitLines(before), splitLines(after))
  const added = ops.filter((o) => o.kind === 'add').length
  const removed = ops.filter((o) => o.kind === 'del').length
  if (added === 0 && removed === 0) return undefined

  // Which rows to show: every change and its context.
  const show = new Array<boolean>(ops.length).fill(false)
  ops.forEach((op, i) => {
    if (op.kind === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
      show[k] = true
    }
  })

  const c = colors()
  const cut = (t: string) => (t.length > width ? `${t.slice(0, width - 1)}…` : t)
  const rows: string[] = []
  let gap = false
  ops.forEach((op, i) => {
    if (!show[i]) {
      gap = rows.length > 0
      return
    }
    if (gap) rows.push(`${DIM}⋯${RESET}`)
    gap = false
    if (op.kind === 'add') rows.push(`${c.success}+ ${cut(op.text)}${RESET}`)
    else if (op.kind === 'del') rows.push(`${c.error}- ${cut(op.text)}${RESET}`)
    else rows.push(`${DIM}  ${cut(op.text)}${RESET}`)
  })
  if (rows.length > maxLines) {
    const hidden = rows.length - maxLines
    return {
      lines: [...rows.slice(0, maxLines), `${DIM}… +${hidden} more diff lines${RESET}`],
      added,
      removed,
    }
  }
  return { lines: rows, added, removed }
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  // A trailing newline ends the last line; it does not start an empty one.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
