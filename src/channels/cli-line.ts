/**
 * Fitting text onto one terminal row.
 *
 * The live input line must stay a single row: that is what lets it be erased with one clear and
 * repainted under output without tracking how many rows it wrapped onto. So a long line scrolls
 * sideways around the cursor instead of wrapping, and an overlong prompt is cut.
 */

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

export function visibleWidth(text: string): number {
  return [...text.replace(ANSI, '')].length
}

/** Cut `text` to `max` visible characters, keeping its escape codes and ending with a reset. */
export function truncateVisible(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text
  let out = ''
  let seen = 0
  let i = 0
  while (i < text.length && seen < max - 1) {
    ANSI.lastIndex = i
    const m = ANSI.exec(text)
    if (m && m.index === i) {
      out += m[0]
      i += m[0].length
      continue
    }
    const ch = String.fromCodePoint(text.codePointAt(i) as number)
    out += ch
    i += ch.length
    seen++
  }
  return `${out}…\x1b[0m`
}

/**
 * The slice of `line` to show in `room` columns, keeping the cursor in view, and how far left
 * of the slice's end the cursor sits.
 */
export function fitLine(
  line: string,
  cursor: number,
  room: number,
): { shown: string; back: number } {
  let start = 0
  if (line.length > room) {
    start = Math.min(Math.max(0, cursor - room + 1), line.length - room)
  }
  const shown = line.slice(start, start + room)
  return { shown, back: start + shown.length - cursor }
}
