/**
 * Ctrl-R: search back through input history, as in a shell.
 *
 * While searching, the live line is the query: readline still does the editing (typing,
 * backspace), and the newest history entry containing it, ignoring case, is shown after it.
 * Ctrl-R again steps to an older match. Enter sends the match; Tab or → puts it on the line to
 * edit; Esc or Ctrl-G gives the line back as it was. This holds only the state; `cli-input.ts`
 * maps keys onto it.
 */

export interface HistorySearch {
  readonly isActive: boolean
  /** Begin, remembering the line to give back on cancel. */
  start(original: string): void
  /** Ctrl-R while searching: the next older match for the same query. */
  older(): void
  /** The query changed: search again from the newest entry. */
  setQuery(query: string): void
  /** The current match for the query, if any. */
  match(): string | undefined
  /** Stop; returns the line the search began on. */
  stop(): string
}

export function createHistorySearch(history: () => string[]): HistorySearch {
  let active = false
  let original = ''
  let query = ''
  // Index into history (newest first) of the current match, or -1 for none, and its text:
  // readline adds the query to history before Enter reaches us, which shifts every index.
  let at = -1
  let matched: string | undefined
  const moveTo = (i: number): void => {
    at = i
    matched = i >= 0 ? history()[i] : undefined
  }

  const find = (from: number): number => {
    if (!query) return -1
    const q = query.toLowerCase()
    const entries = history()
    for (let i = from; i < entries.length; i++) {
      if (entries[i]?.toLowerCase().includes(q)) return i
    }
    return -1
  }

  return {
    get isActive() {
      return active
    },
    start(line) {
      active = true
      original = line
      query = ''
      moveTo(-1)
    },
    older() {
      let next = find(at + 1)
      // The same line typed twice is one match, not two.
      while (next >= 0 && history()[next] === matched) next = find(next + 1)
      // At the oldest match, stay on it rather than lose it.
      if (next >= 0) moveTo(next)
    },
    setQuery(q) {
      if (q === query) return
      query = q
      moveTo(find(0))
    },
    match() {
      return matched
    },
    stop() {
      active = false
      moveTo(-1)
      return original
    },
  }
}

/** The live line as the search keys need it: its text, a way to replace it, and ↑ history. */
export interface SearchLine {
  text(): string
  set(text: string): void
  /** readline's own history array (newest first); changed in place. */
  history(): string[]
}

type Key = { name?: string; ctrl?: boolean } | undefined

export interface SearchKeys {
  /** A key after readline has applied it. True: it belonged to the search. */
  onKey(key: Key): boolean
  /**
   * Enter, with the line readline saw. Returns the line to send: the match while searching
   * (undefined when nothing matched, and the line is given back), otherwise `typed` itself.
   */
  onEnter(typed: string): string | undefined
  /** Ctrl-C. True: it cancelled a search. */
  onInterrupt(): boolean
  /** The hint drawn after the query, while searching. */
  hint(): string | undefined
}

export function createSearchKeys(search: HistorySearch, line: SearchLine): SearchKeys {
  return {
    onKey(key) {
      if (key?.ctrl && key.name === 'r') {
        if (search.isActive) search.older()
        else {
          search.start(line.text())
          line.set('')
        }
        return true
      }
      if (!search.isActive) return false
      // While searching, the line is the query: editing keys change it, these end the search.
      if (key?.name === 'escape' || (key?.ctrl && key.name === 'g')) {
        line.set(search.stop())
      } else if (key?.name === 'tab' || key?.name === 'right') {
        const found = search.match()
        const original = search.stop()
        line.set(found ?? original)
      } else {
        search.setQuery(line.text())
      }
      return true
    },
    onEnter(typed) {
      if (!search.isActive) return typed
      // Enter sends the match, not the query readline saw: put it in history in the query's
      // place. With no match nothing is sent and the line is given back.
      const found = search.match()
      const original = search.stop()
      const history = line.history()
      if (history[0] === typed) history.shift()
      if (found === undefined) {
        line.set(original)
        return undefined
      }
      if (history[0] !== found) history.unshift(found)
      return found
    },
    onInterrupt() {
      if (!search.isActive) return false
      line.set(search.stop())
      return true
    },
    hint() {
      if (!search.isActive) return undefined
      const match = search.match()
      if (match !== undefined) return `  → ${match}`
      return line.text()
        ? '  (no match)'
        : '  type to search history · enter sends · tab edits · esc cancels'
    },
  }
}
