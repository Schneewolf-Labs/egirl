/**
 * Markdown for a streaming reply.
 *
 * Tokens are written raw as they arrive, so the reply still visibly streams. When a line ends
 * it is redrawn in place, rendered: the cursor goes back over the rows the raw text took
 * (counted from its width, since a long paragraph wraps), clears to the end of the screen and
 * writes the rendered line. Table rows stay raw until the table ends, then the whole block is
 * redrawn as a box. Without a terminal nothing is written raw and nothing is redrawn: each line
 * is written once, rendered.
 */

import { visibleWidth } from './cli-line'
import {
  createMarkdownState,
  isTableRow,
  renderInline,
  renderLine,
  renderTable,
} from './cli-markdown'

export interface MarkdownStream {
  push(token: string): void
  /** Finish the last line and any table; leaves the cursor at the end of it, no newline. */
  end(): void
}

export function createMarkdownStream(opts: {
  write(text: string): void
  columns(): number
  /** Column the first line starts at (after the `✦ egirl ` header). */
  startColumn: number
  isTerminal: boolean
}): MarkdownStream {
  const state = createMarkdownState()
  let partial = ''
  let col0 = opts.startColumn
  // Table rows shown raw so far, the screen rows they took, and where the first one started.
  let table: string[] = []
  let tableRows = 0
  let tableCol0 = 0

  const rowsOf = (startCol: number, text: string): number =>
    Math.max(1, Math.ceil((startCol + visibleWidth(text)) / Math.max(1, opts.columns())))

  /** Go back to (`startCol`, `rowsUp` rows up) and clear everything after it. */
  const backTo = (rowsUp: number, startCol: number): string =>
    `\r${rowsUp > 0 ? `\x1b[${rowsUp}A` : ''}${startCol > 0 ? `\x1b[${startCol}C` : ''}\x1b[0J`

  const tableText = (): string[] =>
    renderTable(table, opts.columns()) ?? table.map((row) => renderInline(row))

  /** The line just finished; `newline` is false only for the reply's last line. */
  const finish = (newline: boolean): void => {
    const line = partial
    const lineRows = rowsOf(col0, line)
    partial = ''
    if (isTableRow(line, state)) {
      if (table.length === 0) tableCol0 = col0
      table.push(line)
      tableRows += lineRows
      if (opts.isTerminal) opts.write('\n')
      else if (!newline) flushTableOnly()
      col0 = 0
      if (!newline && opts.isTerminal) redrawTableAtEnd()
      return
    }
    const rendered = renderLine(line, state, opts.columns())
    const tail = newline ? '\n' : ''
    if (table.length > 0) {
      const block = tableText().join('\n')
      if (opts.isTerminal) {
        opts.write(`${backTo(tableRows + lineRows - 1, tableCol0)}${block}\n${rendered}${tail}`)
      } else {
        opts.write(`${block}\n${rendered}${tail}`)
      }
      table = []
      tableRows = 0
    } else if (opts.isTerminal) {
      opts.write(`${backTo(lineRows - 1, col0)}${rendered}${tail}`)
    } else {
      opts.write(`${rendered}${tail}`)
    }
    col0 = 0
  }

  /** No terminal: a table is written once, when it ends. */
  const flushTableOnly = (): void => {
    opts.write(tableText().join('\n'))
    table = []
    tableRows = 0
  }

  /** A table that ends the reply: the cursor sits on the empty row after its last raw line. */
  const redrawTableAtEnd = (): void => {
    opts.write(`${backTo(tableRows, tableCol0)}${tableText().join('\n')}`)
    table = []
    tableRows = 0
  }

  return {
    push(token) {
      const pieces = token.split('\n')
      pieces.forEach((piece, i) => {
        if (i > 0) finish(true)
        if (!piece) return
        partial += piece
        if (opts.isTerminal) opts.write(piece)
      })
    },
    end() {
      if (partial) {
        finish(false)
        return
      }
      if (table.length === 0) return
      if (opts.isTerminal) redrawTableAtEnd()
      else flushTableOnly()
    },
  }
}
