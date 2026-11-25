/**
 * Markdown to terminal text, a line at a time.
 *
 * Models answer in markdown -- tables, **bold**, `code`, headings -- and raw it reads as noise.
 * This renders the common subset with 256-colour styles from the theme. It is a line renderer
 * on purpose: the reply streams, and each finished line is drawn once its markup is known
 * (`cli-md-stream.ts`). Only fenced code needs state across lines, and tables are rendered as a
 * block once their last row is in. Anything not recognised passes through as written.
 */

import { BOLD, colors, DIM, ITALIC, RESET, STRIKE, UNDERLINE } from '../ui/theme'
import { visibleWidth } from './cli-line'

/** State carried from one line to the next: inside a fenced code block or not. */
export interface MarkdownState {
  inFence: boolean
}

export function createMarkdownState(): MarkdownState {
  return { inFence: false }
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/

export function isTableRow(line: string, state: MarkdownState): boolean {
  return !state.inFence && TABLE_ROW.test(line)
}

/** Render one complete line (no newline). Updates `state` for fences. */
export function renderLine(line: string, state: MarkdownState, columns: number): string {
  const c = colors()
  const fence = FENCE.exec(line)
  if (fence) {
    const opening = !state.inFence
    state.inFence = opening
    if (opening) return `${DIM}┌─${fence[2] ? ` ${fence[2]}` : ''}${RESET}`
    return `${DIM}└─${RESET}`
  }
  if (state.inFence) return `${DIM}│${RESET} ${c.accent}${line}${RESET}`

  if (RULE.test(line)) return `${DIM}${'─'.repeat(Math.max(3, Math.min(columns, 48)))}${RESET}`

  const heading = HEADING.exec(line)
  if (heading) {
    const level = heading[1]?.length ?? 1
    const tone = level === 1 ? c.primary : level === 2 ? c.secondary : c.accent
    const base = `${BOLD}${tone}`
    return `${base}${renderInline(heading[2] ?? '', base)}${RESET}`
  }

  const quote = QUOTE.exec(line)
  if (quote) return `${DIM}│${RESET} ${ITALIC}${renderInline(quote[1] ?? '', ITALIC)}${RESET}`

  const bullet = BULLET.exec(line)
  if (bullet) return `${bullet[1] ?? ''}${c.accent}•${RESET} ${renderInline(bullet[2] ?? '')}`

  return renderInline(line)
}

/**
 * Inline spans: `code`, **bold**, *italic*, ~~strike~~, [links](url). `base` is the line's own
 * style, put back after each span's reset so a bold word in a heading leaves it a heading.
 */
export function renderInline(text: string, base = ''): string {
  const c = colors()
  const end = `${RESET}${base}`
  // Code spans first, held aside so nothing inside them is read as markup.
  const codes: string[] = []
  let out = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`${c.accent}${code}${end}`)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, `${UNDERLINE}$1${end} ${DIM}($2)${end}`)
    .replace(
      /\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__/g,
      (_m, a, b) => `${BOLD}${a ?? b}${end}`,
    )
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, `${STRIKE}$1${end}`)
    .replace(
      /(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\*)|(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g,
      (_m, a, b) => `${ITALIC}${a ?? b}${end}`,
    )
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the placeholder is a NUL on purpose
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '')
}

/**
 * A markdown table as a box. Returns undefined when it would not fit in `columns`, so the
 * caller can fall back to rendering the rows as lines.
 */
export function renderTable(rows: string[], columns: number): string[] | undefined {
  const cells = rows.map((r) =>
    r
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim()),
  )
  const isSeparator = (row: string[]) => row.every((cell) => /^:?-{1,}:?$/.test(cell))
  const separatorAt = cells.findIndex(isSeparator)
  const body = cells.filter((_, i) => i !== separatorAt)
  const width = Math.max(...body.map((r) => r.length))
  const rendered = body.map((r, i) =>
    Array.from({ length: width }, (_, col) => {
      const text = r[col] ?? ''
      return i === 0 && separatorAt === 1
        ? `${BOLD}${renderInline(text, BOLD)}${RESET}`
        : renderInline(text)
    }),
  )
  const widths = Array.from({ length: width }, (_, col) =>
    Math.max(1, ...rendered.map((r) => visibleWidth(r[col] ?? ''))),
  )
  const total = widths.reduce((a, w) => a + w + 3, 1)
  if (total > columns) return undefined

  const line = (l: string, m: string, r: string) =>
    `${DIM}${l}${widths.map((w) => '─'.repeat(w + 2)).join(m)}${r}${RESET}`
  const row = (r: string[]) =>
    `${DIM}│${RESET}${r.map((cell, i) => ` ${cell}${' '.repeat((widths[i] ?? 0) - visibleWidth(cell))} `).join(`${DIM}│${RESET}`)}${DIM}│${RESET}`
  const out = [line('┌', '┬', '┐')]
  rendered.forEach((r, i) => {
    out.push(row(r))
    if (i === 0 && separatorAt === 1 && rendered.length > 1) out.push(line('├', '┼', '┤'))
  })
  out.push(line('└', '┴', '┘'))
  return out
}

/** Render a whole reply at once (one that did not stream). */
export function renderMarkdown(text: string, columns: number): string {
  const state = createMarkdownState()
  const out: string[] = []
  let table: string[] = []
  const flushTable = () => {
    if (table.length === 0) return
    out.push(...(renderTable(table, columns) ?? table.map((r) => renderInline(r))))
    table = []
  }
  for (const line of text.split('\n')) {
    if (isTableRow(line, state)) {
      table.push(line)
      continue
    }
    flushTable()
    out.push(renderLine(line, state, columns))
  }
  flushTable()
  return out.join('\n')
}
