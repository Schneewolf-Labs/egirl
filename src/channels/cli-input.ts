/**
 * The one owner of the terminal's input line.
 *
 * Two readers used to share stdin during a turn: readline, still live and echoing keystrokes
 * into the middle of streamed output, and a raw parser that queued what it saw. They disagreed
 * -- `helo`, left arrow, `l` showed "hello" and queued "helol" -- and a half-typed line was lost
 * when the turn ended. Now readline does all the editing (history, arrows, Ctrl-U) with its own
 * output muted, and this module draws the input line itself, as the last row of the terminal.
 *
 * Everything else written to the terminal goes through here too, so the live line is erased
 * before the write and repainted after it. While output is mid-line (a reply streaming token by
 * token) the live line stays hidden; typing still edits it and it reappears at the next newline.
 *
 * Without a TTY there is no live line: lines are read and handed on, nothing is drawn.
 */

import * as readline from 'node:readline'
import { Writable } from 'node:stream'
import { format } from 'node:util'
import { fitLine, truncateVisible, visibleWidth } from './cli-line'

export interface CLIInput {
  /** Whether a live line is drawn at all (stdin and stdout are both a terminal). */
  readonly isInteractive: boolean
  /** The prompt at the start of the live line. */
  setPrompt(text: string): void
  /** A status shown before the prompt (the turn's spinner); empty hides it. */
  setStatus(text: string): void
  /**
   * Print a line of our own (queued, interrupting, a command's answer). While a reply is
   * streaming mid-line it waits for the next newline instead of splicing into the reply.
   */
  notice(text: string): void
  /** Show `question` as the prompt and resolve with the next line typed. */
  ask(question: string): Promise<string>
  close(): void
}

export interface CLIInputHooks {
  onLine(line: string): void
  onEscape(): void
  onClose(): void
}

const ERASE = '\r\x1b[2K'

export function createCLIInput(hooks: CLIInputHooks): CLIInput {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  let prompt = ''
  let status = ''
  let asking: { question: string; resolve: (line: string) => void } | undefined
  let closed = false

  if (!interactive) {
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    rl.on('line', (line) => {
      if (asking) {
        const { resolve } = asking
        asking = undefined
        resolve(line)
        return
      }
      hooks.onLine(line)
    })
    rl.on('close', () => {
      closed = true
      hooks.onClose()
    })
    return {
      isInteractive: false,
      setPrompt() {},
      setStatus() {},
      notice: (text) => console.log(text),
      ask(question) {
        process.stdout.write(`${question}\n`)
        return new Promise((resolve) => {
          asking = { question, resolve }
        })
      },
      close() {
        if (closed) return
        closed = true
        rl.close()
      },
    }
  }

  // readline edits into a sink; the live line below is the only thing that draws it.
  const muted = new Writable({ write: (_chunk, _enc, done) => done() }) as Writable & {
    isTTY: boolean
    columns: number
  }
  muted.isTTY = true
  Object.defineProperty(muted, 'columns', { get: () => process.stdout.columns || 80 })
  const rl = readline.createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
    historySize: 1000,
  })
  const editor = rl as unknown as { line: string; cursor: number }

  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  const consoleOriginals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  }
  let painted = false
  // Where the terminal's cursor is: at the start of a fresh row, or mid-way along one that
  // output is still writing. Shared by stdout and stderr because the screen is shared.
  let midLine = false
  const deferred: string[] = []

  const paint = (): void => {
    if (closed || midLine) return
    const columns = process.stdout.columns || 80
    let head = asking ? asking.question : prompt
    if (!asking && status) head = `${status} ${prompt}`
    // A head wider than half the row would leave nowhere to type; trim it rather than wrap,
    // because a wrapped live line can no longer be erased with one row's clear.
    head = truncateVisible(head, Math.floor(columns / 2))
    const room = Math.max(8, columns - visibleWidth(head) - 1)
    const { shown, back } = fitLine(editor.line, editor.cursor, room)
    out(`${ERASE}${head}${shown}${back > 0 ? `\x1b[${back}D` : ''}`)
    painted = true
  }

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
      paint()
      return ok
    }
  process.stdout.write = through(out) as typeof process.stdout.write
  process.stderr.write = through(err) as typeof process.stderr.write
  // Bun's console writes to the file descriptor directly, past process.stdout.write.
  console.log = (...args: unknown[]) => process.stdout.write(`${format(...args)}\n`)
  console.info = console.log
  console.warn = (...args: unknown[]) => process.stderr.write(`${format(...args)}\n`)
  console.error = console.warn

  rl.on('line', (line) => {
    if (asking) {
      const { resolve } = asking
      asking = undefined
      resolve(line)
      return
    }
    hooks.onLine(line)
  })

  // Ctrl-C clears a half-typed line first, as a shell does; on an empty line it is the real
  // SIGINT, so the shutdown handlers run and the process ends.
  rl.on('SIGINT', () => {
    if (editor.line.length > 0) {
      rl.write(null, { ctrl: true, name: 'u' })
      paint()
      return
    }
    process.kill(process.pid, 'SIGINT')
  })

  rl.on('close', () => {
    restore()
    hooks.onClose()
  })

  // Registered after readline's own listener, so the line and cursor are already updated.
  const onKeypress = (_s: string | undefined, key: { name?: string } | undefined): void => {
    if (key?.name === 'escape') hooks.onEscape()
    paint()
  }
  process.stdin.on('keypress', onKeypress)

  const restore = (): void => {
    if (closed) return
    closed = true
    process.stdin.off('keypress', onKeypress)
    if (painted) out(ERASE)
    process.stdout.write = out as typeof process.stdout.write
    process.stderr.write = err as typeof process.stderr.write
    Object.assign(console, consoleOriginals)
  }

  return {
    isInteractive: true,
    setPrompt(text) {
      prompt = text
      paint()
    },
    setStatus(text) {
      status = text
      paint()
    },
    notice(text) {
      if (midLine) deferred.push(text)
      else console.log(text)
    },
    ask(question) {
      return new Promise((resolve) => {
        asking = { question, resolve }
        paint()
      })
    },
    close() {
      restore()
      rl.close()
    },
  }
}
