import { describe, expect, test } from 'bun:test'
import { visibleWidth } from '../../src/channels/cli-line'
import { createSlashMenu, type MenuItem } from '../../src/channels/cli-menu'

const ITEMS: MenuItem[] = [
  { name: 'status', summary: 'busy or idle' },
  { name: 'stats', summary: 'numbers' },
  { name: 'settings', summary: 'config' },
  { name: 'help', summary: 'commands' },
]

/** A line like readline's: typing sets text with the cursor at the end. */
function setup(history: string[] = ['older']) {
  const line = { text: '', cursor: 0, history }
  const menu = createSlashMenu((p) => ITEMS.filter((i) => i.name.startsWith(p)), {
    text: () => line.text,
    cursor: () => line.cursor,
    set(t) {
      line.text = t
      line.cursor = t.length
    },
    history: () => line.history,
    setHistory(h) {
      line.history = h
    },
  })
  const type = (t: string, key?: { name?: string }) => {
    line.text = t
    line.cursor = t.length
    const consumed = menu.onKey(key)
    menu.sync(true)
    return consumed
  }
  const press = (name: string) => {
    const consumed = menu.onKey({ name })
    menu.sync(true)
    return consumed
  }
  return { line, menu, type, press }
}

describe('createSlashMenu', () => {
  test('opens on a slash word and lists the matches with a hint row', () => {
    const { menu, type } = setup()
    type('/s')
    expect(menu.isOpen).toBe(true)
    const rows = menu.rows(80)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('/status')
    expect(rows[3]).toContain('esc closes')
  })

  test('stays shut for prose, after a space, and with no match', () => {
    const { menu, type } = setup()
    for (const t of ['hello', '/status on', '/zzz']) {
      type(t)
      expect(menu.isOpen).toBe(false)
    }
  })

  test('↓ picks a row and Enter sends it, recorded in the real history', () => {
    const { menu, type, press, line } = setup()
    type('/s')
    expect(line.history).toEqual([])
    expect(press('down')).toBe(true)
    expect(press('down')).toBe(true)
    expect(menu.onEnter('/s')).toBe('/stats')
    expect(menu.isOpen).toBe(false)
    expect(line.history).toEqual(['/stats', 'older'])
  })

  test('Enter without a pick sends what was typed', () => {
    const { menu, type, line } = setup()
    type('/st')
    expect(menu.onEnter('/st')).toBe('/st')
    expect(line.history).toEqual(['/st', 'older'])
  })

  test('↑ from no pick wraps to the last row; Tab puts the pick on the line', () => {
    const { type, press, line, menu } = setup()
    type('/s')
    press('up')
    expect(press('tab')).toBe(true)
    expect(line.text).toBe('/settings ')
    expect(menu.isOpen).toBe(false)
  })

  test('Tab without a pick is left to completion', () => {
    const { type, press } = setup()
    type('/s')
    expect(press('tab')).toBe(false)
  })

  test('Esc closes it until the line changes, and is not passed on', () => {
    const { menu, type, press } = setup()
    type('/s')
    expect(press('escape')).toBe(true)
    expect(menu.isOpen).toBe(false)
    expect(menu.onKey({ name: 'escape' })).toBe(false)
    type('/st')
    expect(menu.isOpen).toBe(true)
  })

  test('a line recalled from history does not open it', () => {
    const { menu, type } = setup()
    type('/status', { name: 'up' })
    expect(menu.isOpen).toBe(false)
  })

  test('the history comes back when it closes', () => {
    const { type, line } = setup(['a', 'b'])
    type('/s')
    expect(line.history).toEqual([])
    type('/s ')
    expect(line.history).toEqual(['a', 'b'])
  })

  test('more matches than rows: a window around the pick and a count', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, summary: 's' }))
    const line = { text: '/c', cursor: 2, history: [] as string[] }
    const menu = createSlashMenu(() => many, {
      text: () => line.text,
      cursor: () => line.cursor,
      set() {},
      history: () => line.history,
      setHistory(h) {
        line.history = h
      },
    })
    menu.sync(true)
    expect(menu.rows(80).at(-1)).toContain('4 more')
    for (let i = 0; i < 8; i++) menu.onKey({ name: 'down' })
    const rows = menu.rows(80)
    expect(rows.some((r) => r.includes('› /c7'))).toBe(true)
    expect(rows.some((r) => r.includes('/c0'))).toBe(false)
  })

  test('rows fit the terminal width', () => {
    const { menu, type } = setup()
    type('/s')
    expect(menu.rows(20).every((r) => visibleWidth(r) <= 19)).toBe(true)
  })
})
