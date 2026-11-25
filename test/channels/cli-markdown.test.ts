/**
 * Markdown in the terminal: inline spans, line-level blocks, tables, and the streaming redraw.
 */

import { describe, expect, test } from 'bun:test'
import {
  createMarkdownState,
  renderInline,
  renderLine,
  renderMarkdown,
  renderTable,
} from '../../src/channels/cli-markdown'
import { createMarkdownStream } from '../../src/channels/cli-md-stream'
import { BOLD, ITALIC, STRIKE } from '../../src/ui/theme'

const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(ANSI, '')

describe('renderInline', () => {
  test('styles bold, italic, strike, code and links, and drops their markers', () => {
    const out = renderInline('**bold** *it* _also_ ~~gone~~ `x*y*` [docs](https://e.x)')
    expect(strip(out)).toBe('bold it also gone x*y* docs (https://e.x)')
    expect(out).toContain(`${BOLD}bold`)
    expect(out).toContain(`${ITALIC}it`)
    expect(out).toContain(`${STRIKE}gone`)
  })

  test('leaves markup inside code alone, and lone or spaced markers as written', () => {
    expect(strip(renderInline('`**raw**`'))).toBe('**raw**')
    expect(strip(renderInline('2 * 3 * 4 and snake_case_name'))).toBe(
      '2 * 3 * 4 and snake_case_name',
    )
  })
})

describe('renderLine', () => {
  test('headings, bullets, quotes and rules lose their markers', () => {
    const s = createMarkdownState()
    expect(strip(renderLine('## Results', s, 80))).toBe('Results')
    expect(strip(renderLine('  - item', s, 80))).toBe('  • item')
    expect(strip(renderLine('> note', s, 80))).toBe('│ note')
    expect(strip(renderLine('---', s, 20))).toBe('─'.repeat(20))
  })

  test('a fenced block is framed and its contents are not read as markdown', () => {
    const s = createMarkdownState()
    expect(strip(renderLine('```ts', s, 80))).toBe('┌─ ts')
    expect(strip(renderLine('# not a heading **x**', s, 80))).toBe('│ # not a heading **x**')
    expect(strip(renderLine('```', s, 80))).toBe('└─')
    expect(strip(renderLine('# heading', s, 80))).toBe('heading')
  })
})

describe('renderTable', () => {
  const rows = ['| file | n |', '|---|---:|', '| **a.py** | 41 |', '| b.py | 0 |']

  test('draws a box sized to its cells, with the header ruled off', () => {
    expect(renderTable(rows, 80)?.map(strip)).toEqual([
      '┌──────┬────┐',
      '│ file │ n  │',
      '├──────┼────┤',
      '│ a.py │ 41 │',
      '│ b.py │ 0  │',
      '└──────┴────┘',
    ])
  })

  test('gives up when it would not fit, so the rows can be shown as lines', () => {
    expect(renderTable(rows, 10)).toBeUndefined()
  })
})

describe('renderMarkdown', () => {
  test('renders a whole reply, tables included', () => {
    const out = strip(renderMarkdown('# T\n| a |\n|---|\n| 1 |\ndone', 80))
    expect(out).toBe('T\n┌───┐\n│ a │\n├───┤\n│ 1 │\n└───┘\ndone')
  })
})

describe('createMarkdownStream', () => {
  function run(tokens: string[], isTerminal: boolean, columns = 80) {
    let out = ''
    const md = createMarkdownStream({
      write: (t) => {
        out += t
      },
      columns: () => columns,
      startColumn: 8,
      isTerminal,
    })
    for (const t of tokens) md.push(t)
    md.end()
    return out
  }

  test('without a terminal, each line is written once, rendered', () => {
    expect(strip(run(['**hi** th', 'ere\nnext'], false))).toBe('hi there\nnext')
  })

  test('on a terminal, the raw line streams and is then redrawn in place', () => {
    const out = run(['**hi**', '\n'], true)
    // Raw first, then back to the start column of the line and clear, then the rendered text.
    expect(out.startsWith('**hi**')).toBe(true)
    expect(out).toContain(`\r${ESC}[8C${ESC}[0J`)
    expect(strip(out.slice(out.indexOf(`${ESC}[0J`)))).toContain('hi\n')
  })

  test('a wrapped line is redrawn from the row it started on', () => {
    const long = 'x'.repeat(30)
    // 8 + 30 columns on a 16-column terminal: three rows, so two rows up.
    expect(run([long, '\n'], true, 16)).toContain(`\r${ESC}[2A${ESC}[8C${ESC}[0J`)
  })

  test('a table is held raw and redrawn as a box when it ends', () => {
    const out = run(['| a |\n|---|\n| 1 |\nafter'], true)
    expect(out).toContain(`${ESC}[0J`)
    expect(strip(out)).toContain('┌───┐')
    expect(strip(out)).toContain('after')
  })
})
