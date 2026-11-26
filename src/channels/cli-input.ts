/**
 * The one owner of the terminal's input line.
 *
 * Two readers used to share stdin during a turn: readline, still live and echoing keystrokes
 * into the middle of streamed output, and a raw parser that queued what it saw. They disagreed
 * -- `helo`, left arrow, `l` showed "hello" and queued "helol" -- and a half-typed line was lost
 * when the turn ended. Now readline does all the editing (history, arrows, Ctrl-U) with its own
 * output muted, and this module draws the input line itself, as the last row of the terminal.
 * While a turn runs its status (spinner, phase, stats) is pinned on its own row just above, so
 * the stats get the full width and the prompt keeps its place.
 *
 * Everything else written to the terminal goes through `cli-screen.ts`, which erases the live
 * line before each write and has it drawn again after. A multi-line paste is held as one
 * message until enter (`cli-paste.ts`), and ↑ history can be seeded with lines saved by an
 * earlier run (`cli-history.ts`) and searched with Ctrl-R (`cli-search.ts`).
 *
 * Without a TTY there is no live line (`cli-input-plain.ts`).
 */

import * as readline from 'node:readline'
import { Writable } from 'node:stream'
import { type Completion, ghostFor } from './cli-complete'
import { HISTORY_SIZE } from './cli-history'
import { createPlainInput } from './cli-input-plain'
import { fitLine, truncateVisible, visibleWidth } from './cli-line'
import { createPasteBuffer, PASTE_OFF, PASTE_ON } from './cli-paste'
import { createScreen } from './cli-screen'
import { createHistorySearch, createSearchKeys } from './cli-search'

export interface CLIInput {
  /** Whether a live line is drawn at all (stdin and stdout are both a terminal). */
  readonly isInteractive: boolean
  /** The prompt at the start of the live line. */
  setPrompt(text: string): void
  /** A status pinned on the row above the input line (the turn's spinner); empty hides it. */
  setStatus(text: string): void
  /**
   * Print a line of our own (queued, interrupting, a command's answer). While a reply is
   * streaming mid-line it waits for the next newline instead of splicing into the reply.
   */
  notice(text: string): void
  /**
   * A next input to offer on the empty line (`/continue` after a capped run), drawn dim after
   * the prompt. Tab or → takes it, typing anything else ignores it; it goes at the next enter.
   */
  suggest(text: string | undefined): void
  /** Show `question` as the prompt and resolve with the next line typed. */
  ask(question: string): Promise<string>
  close(): void
}

export interface CLIInputHooks {
  onLine(line: string): void
  onEscape(): void
  onClose(): void
  /** Completes the text before the cursor; drives Tab and the inline suggestion. */
  complete?(line: string): Completion
  /** Earlier input for ↑, newest first (from `loadHistory`). */
  history?: string[]
}

export function createCLIInput(hooks: CLIInputHooks): CLIInput {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return createPlainInput(hooks)

  let prompt = ''
  let status = ''
  let asking: { question: string; resolve: (line: string) => void } | undefined
  let closed = false
  let suggestion: string | undefined
  // What → would accept, as drawn by the last paint: only offered while it is on screen.
  let acceptable: string | undefined

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
    historySize: HISTORY_SIZE,
    history: hooks.history ?? [],
    // Tab. A unique hit gets a trailing space so the next argument can follow; several hits
    // complete their common prefix and are listed by the inline hint, since this output is muted.
    completer: (line: string): [string[], string] => {
      if (search.isActive) return [[], line]
      if (line === '' && suggestion) return [[suggestion], '']
      const c = hooks.complete?.(line)
      if (!c || c.candidates.length === 0) return [[], line]
      if (c.candidates.length === 1) return [[`${c.candidates[0]} `], c.token]
      return [c.candidates, c.token]
    },
  })
  const editor = rl as unknown as { line: string; cursor: number; history: string[] }
  const paste = createPasteBuffer()
  const search = createHistorySearch(() => editor.history)
  const searchKeys = createSearchKeys(search, {
    text: () => editor.line,
    // The whole line, leaving the cursor at its end.
    set(text) {
      rl.write(null, { ctrl: true, name: 'e' })
      rl.write(null, { ctrl: true, name: 'u' })
      if (text) rl.write(text)
    },
    history: () => editor.history,
  })

  const paint = (): void => {
    if (closed || screen.isMidLine) return
    const columns = process.stdout.columns || 80
    let head = asking ? asking.question : prompt
    if (search.isActive) head = '\x1b[2msearch:\x1b[0m '
    const held = paste.held()
    if (held > 0) head += `\x1b[2m‹${held} pasted line${held === 1 ? '' : 's'}›\x1b[0m `
    // A head that fills the row would leave nowhere to type; trim it to leave 24 columns rather
    // than wrap, because a wrapped live line can no longer be erased with one row's clear.
    head = truncateVisible(head, Math.max(16, columns - 24))
    const room = Math.max(8, columns - visibleWidth(head) - 1)
    const { shown, back } = fitLine(editor.line, editor.cursor, room)
    const searching = searchKeys.hint()
    const ghost =
      searching !== undefined
        ? { text: searching }
        : back === 0 && !asking
          ? ghostFor(editor.line, suggestion, hooks.complete)
          : undefined
    acceptable = ghost?.accept
    const spare = room - visibleWidth(shown)
    const hint = ghost && spare > 1 ? truncateVisible(ghost.text, spare - 1) : ''
    const left = back + visibleWidth(hint)
    const tail = hint ? `\x1b[2m${hint}\x1b[0m` : ''
    const above = status ? [truncateVisible(status, columns - 1)] : []
    screen.draw(`${head}${shown}${tail}${left > 0 ? `\x1b[${left}D` : ''}`, above)
  }
  const screen = createScreen(paint)

  rl.on('line', (typed) => {
    const chosen = searchKeys.onEnter(typed)
    if (chosen === undefined) {
      paint()
      return
    }
    const line = paste.take(chosen)
    if (line === undefined) {
      // A line ended inside a paste: held, and kept out of ↑ history.
      if (editor.history[0] === chosen) editor.history.shift()
      return
    }
    suggestion = undefined
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
    if (searchKeys.onInterrupt()) {
      paint()
      return
    }
    if (editor.line.length > 0 || paste.held() > 0) {
      paste.clear()
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
  const onKeypress = (
    _s: string | undefined,
    key: { name?: string; ctrl?: boolean } | undefined,
  ): void => {
    if (!asking && searchKeys.onKey(key)) {
      paint()
      return
    }
    if (key?.name === 'escape') hooks.onEscape()
    if (key?.name === 'paste-start') paste.start()
    if (key?.name === 'paste-end') paste.end()
    // → at the end of the line takes the dim suggestion, as in fish. readline's own → is a
    // no-op there, so nothing is lost; `acceptable` is what the previous paint showed.
    if (key?.name === 'right' && acceptable) rl.write(acceptable)
    paint()
  }
  process.stdin.on('keypress', onKeypress)
  screen.raw(PASTE_ON)

  const restore = (): void => {
    if (closed) return
    closed = true
    process.stdin.off('keypress', onKeypress)
    screen.restore()
    process.stdout.write(PASTE_OFF)
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
    suggest(text) {
      suggestion = text
      paint()
    },
    notice: (text) => screen.notice(text),
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
