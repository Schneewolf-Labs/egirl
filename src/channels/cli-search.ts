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
