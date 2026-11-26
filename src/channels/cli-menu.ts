/**
 * The slash-command menu: typing `/` lists the commands that match, with what each does.
 *
 * Tab completion only says which names fit; someone who does not know the commands yet has to
 * leave for /help to learn what they do. So while the line is a bare `/word`, the matching
 * commands are listed in rows above the input line. ↑ and ↓ pick one, Tab puts it on the line,
 * Enter sends it, Esc closes the menu until the line changes. Without a pick, Tab and Enter do
 * what they always did.
 *
 * readline applies ↑ and ↓ (history) before these keys reach us, so while the menu is open its
 * history is swapped out for an empty one and the arrows do nothing there. A line recalled
 * from history with ↑ does not open the menu, or browsing history would stop at it.
 */

import { colors, DIM, RESET } from '../ui/theme'
import { HISTORY_SIZE } from './cli-history'
import { truncateVisible } from './cli-line'

export interface MenuItem {
  /** Without the slash. */
  name: string
  summary: string
}

/** The live line as the menu needs it. */
export interface MenuLine {
  text(): string
  cursor(): number
  set(text: string): void
  /** readline's own history (newest first). */
  history(): string[]
  setHistory(history: string[]): void
}

type Key = { name?: string; ctrl?: boolean } | undefined

export interface SlashMenu {
  readonly isOpen: boolean
  /** A key after readline has applied it. True: it belonged to the menu. */
  onKey(key: Key): boolean
  /** Open or close for the line as it is now; `allowed` false keeps it shut. */
  sync(allowed: boolean): void
  /** Enter, with the line readline saw: the picked command, or `typed` itself. */
  onEnter(typed: string): string
  /** The rows to draw above the input line. */
  rows(columns: number): string[]
}

const MAX_ROWS = 6

export function createSlashMenu(items: (prefix: string) => MenuItem[], line: MenuLine): SlashMenu {
  let matches: MenuItem[] = []
  // The picked row, or -1 before ↑ or ↓.
  let at = -1
  let seen = ''
  // The line Esc closed the menu on, or one recalled from history: kept shut until it changes.
  let shut: string | undefined
  let isRecall = false
  let stash: string[] | undefined

  const setOpen = (open: boolean): void => {
    if (open && !stash) {
      stash = line.history()
      line.setHistory([])
    } else if (!open && stash) {
      line.setHistory(stash)
      stash = undefined
    }
  }

  return {
    get isOpen() {
      return stash !== undefined
    },
    onKey(key) {
      if (!stash) {
        isRecall = key?.name === 'up' || key?.name === 'down'
        return false
      }
      if (key?.name === 'down') at = (at + 1) % matches.length
      else if (key?.name === 'up') at = at <= 0 ? matches.length - 1 : at - 1
      else if (key?.name === 'escape') shut = line.text()
      else if (key?.name === 'tab' && at >= 0) line.set(`/${matches[at]?.name} `)
      else return false
      return true
    },
    sync(allowed) {
      const text = line.text()
      if (isRecall) shut = text
      isRecall = false
      if (text !== seen) {
        at = -1
        if (text !== shut) shut = undefined
      }
      seen = text
      const isEligible =
        allowed &&
        shut === undefined &&
        text.startsWith('/') &&
        !text.includes(' ') &&
        line.cursor() === text.length
      matches = isEligible ? items(text.slice(1)) : []
      if (at >= matches.length) at = -1
      setOpen(matches.length > 0)
    },
    onEnter(typed) {
      if (!stash) return typed
      const picked = at >= 0 ? matches[at] : undefined
      const sent = picked ? `/${picked.name}` : typed
      // readline added `typed` to the stand-in history; the real one gets what is sent.
      const history = stash
      setOpen(false)
      if (sent.trim() && history[0] !== sent) history.unshift(sent)
      if (history.length > HISTORY_SIZE) history.length = HISTORY_SIZE
      matches = []
      at = -1
      seen = ''
      return sent
    },
    rows(columns) {
      if (!stash) return []
      const c = colors()
      const start = Math.max(0, Math.min(at - MAX_ROWS + 1, matches.length - MAX_ROWS))
      const shown = matches.slice(start, start + MAX_ROWS)
      const pad = Math.max(...shown.map((m) => m.name.length)) + 1
      const rows = shown.map((m, i) => {
        const name = `/${m.name}`.padEnd(pad + 1)
        const row =
          start + i === at
            ? `${c.primary}› ${name}${RESET} ${m.summary}`
            : `  ${c.accent}${name}${RESET} ${DIM}${m.summary}${RESET}`
        return truncateVisible(row, columns - 1)
      })
      const hidden = matches.length - shown.length
      const more = hidden > 0 ? `… ${hidden} more · ` : ''
      rows.push(
        truncateVisible(`${DIM}  ${more}↑↓ picks · tab takes it · esc closes${RESET}`, columns - 1),
      )
      return rows
    },
  }
}
