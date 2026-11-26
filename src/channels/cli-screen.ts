/**
 * The terminal's output, shared with the live input line.
 *
 * Everything written to the terminal comes through here -- process.stdout and process.stderr,
 * and console, which in Bun writes to the file descriptor directly -- so the live line can be
 * erased before each write and drawn again after it. While output is mid-line (a reply
 * streaming token by token) the live line stays hidden, and notices wait for the next newline
 * rather than splice into the reply.
 */

import { format } from 'node:util'

export const ERASE = '\r\x1b[2K'

export interface Screen {
  /** Whether output stopped part-way along a row; the live line is not drawn then. */
  readonly isMidLine: boolean
  /** Replace the live line with `text` (which may end with cursor moves). */
  draw(text: string): void
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
  let painted = false
  // Shared by stdout and stderr because the screen is shared.
  let midLine = false
  const deferred: string[] = []

  const through =
    (write: typeof out) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      if (painted) {
        out(ERASE)
        painted = false
      }
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString()
      const ok = (write as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)
      if (text.length > 0) midLine = !text.endsWith('\n')
      if (!midLine && deferred.length > 0) out(`${deferred.splice(0).join('\n')}\n`)
      repaint()
      return ok
    }
  process.stdout.write = through(out) as typeof process.stdout.write
  process.stderr.write = through(err) as typeof process.stderr.write
  console.log = (...args: unknown[]) => process.stdout.write(`${format(...args)}\n`)
  console.info = console.log
  console.warn = (...args: unknown[]) => process.stderr.write(`${format(...args)}\n`)
  console.error = console.warn

  return {
    get isMidLine() {
      return midLine
    },
    draw(text) {
      out(`${ERASE}${text}`)
      painted = true
    },
    notice(text) {
      if (midLine) deferred.push(text)
      else console.log(text)
    },
    raw: (text) => {
      out(text)
    },
    restore() {
      if (painted) out(ERASE)
      painted = false
      process.stdout.write = out as typeof process.stdout.write
      process.stderr.write = err as typeof process.stderr.write
      Object.assign(console, consoleOriginals)
    },
  }
}
