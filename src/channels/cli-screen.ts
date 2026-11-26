/**
 * The terminal's output, shared with the live input line.
 *
 * Everything written to the terminal comes through here -- process.stdout and process.stderr,
 * and console, which in Bun writes to the file descriptor directly -- so the live line can be
 * erased before each write and drawn again after it. While output is mid-line (a reply
 * streaming token by token) the live line stays hidden, and notices wait for the next newline
 * rather than splice into the reply.
 *
 * The live area is the input row plus any rows pinned above it (the turn's status). Each row
 * is kept within the terminal's width, so erasing it is one clear per row.
 */

import { format } from 'node:util'

export const ERASE = '\r\x1b[2K'

export interface Screen {
  /** Whether output stopped part-way along a row; the live line is not drawn then. */
  readonly isMidLine: boolean
  /**
   * Replace the live area: `rows` pinned above, then the input row `text` (which may end with
   * cursor moves). Every row must fit in the terminal's width.
   */
  draw(text: string, rows?: string[]): void
  /** Print a line of our own, after the current output line if one is in progress. */
  notice(text: string): void
  /** Write straight to the terminal, past the live line (mode switches). */
  raw(text: string): void
  /** Give the terminal back: erase the live line and undo the interception. */
  restore(): void
}

/** Take over the terminal's output; `repaint` is called after each write to redraw. */
export function createScreen(repaint: () => void): Screen {
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  const consoleOriginals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  }
  // Rows of the live area on screen now; 0 when nothing is drawn.
  let painted = 0
  // Clears every live row, leaving the cursor at the start of the top one.
  const erasing = (): string => {
    const seq = painted > 0 ? `${ERASE}${'\x1b[1A\x1b[2K'.repeat(painted - 1)}` : ''
    painted = 0
    return seq
  }
  const erase = (): void => {
    if (painted > 0) out(erasing())
  }
  // Shared by stdout and stderr because the screen is shared.
  let midLine = false
  // Whether stdout left the row open: a reply streaming. Then stderr (log lines) waits for the
  // line to end, like a notice, rather than splice in -- a row the reply did not write also
  // throws off the markdown redraw, which goes back up over the rows it counted.
  let isReplyOpen = false
  const deferred: string[] = []
  const heldErr: string[] = []
  const flush = (): void => {
    if (deferred.length > 0) out(`${deferred.splice(0).join('\n')}\n`)
    if (heldErr.length > 0) err(heldErr.splice(0).join(''))
  }

  const through =
    (write: typeof out, isOut: boolean) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString()
      if (!isOut && isReplyOpen) {
        heldErr.push(text)
        return true
      }
      erase()
      const ok = (write as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)
      if (text.length > 0) {
        midLine = !text.endsWith('\n')
        if (isOut) isReplyOpen = midLine
      }
      if (!midLine) flush()
      repaint()
      return ok
    }
  process.stdout.write = through(out, true) as typeof process.stdout.write
  process.stderr.write = through(err, false) as typeof process.stderr.write
  console.log = (...args: unknown[]) => process.stdout.write(`${format(...args)}\n`)
  console.info = console.log
  console.warn = (...args: unknown[]) => process.stderr.write(`${format(...args)}\n`)
  console.error = console.warn

  return {
    get isMidLine() {
      return midLine
    },
    draw(text, rows = []) {
      // One write, so a spinner tick does not flash an empty area between the two.
      out(`${erasing()}${ERASE}${rows.map((r) => `${r}\n`).join('')}${text}`)
      painted = rows.length + 1
    },
    notice(text) {
      if (midLine) deferred.push(text)
      else console.log(text)
    },
    raw: (text) => {
      out(text)
    },
    restore() {
      erase()
      // Logs still held behind an unfinished reply line: on a row of their own.
      if (isReplyOpen && (heldErr.length > 0 || deferred.length > 0)) out('\n')
      flush()
      process.stdout.write = out as typeof process.stdout.write
      process.stderr.write = err as typeof process.stderr.write
      Object.assign(console, consoleOriginals)
    },
  }
}
