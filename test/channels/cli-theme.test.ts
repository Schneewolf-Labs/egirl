import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { themeCommand } from '../../src/channels/cli-theme'
import { colors, getTheme, listThemes, setTheme } from '../../src/ui/theme'

describe('/theme', () => {
  // The theme is process-wide and other tests change it.
  let before = 'egirl'
  beforeEach(() => {
    before = getTheme().name
    setTheme('egirl')
  })
  afterEach(() => setTheme(before))

  test('with no name lists every theme and marks the current one', () => {
    const out = themeCommand('')
    for (const t of listThemes()) expect(out).toContain(t.name)
    expect(out).toMatch(/›\S* egirl/)
  })

  test('a name switches the theme now, for colors() too', () => {
    const egirlPrimary = colors().primary
    const out = themeCommand(' Sakura ')
    expect(getTheme().name).toBe('sakura')
    expect(colors().primary).not.toBe(egirlPrimary)
    expect(out).toContain('theme = "sakura"')
  })

  test('an unknown name leaves the theme alone', () => {
    const out = themeCommand('nope')
    expect(getTheme().name).toBe('egirl')
    expect(out).toContain('No theme "nope"')
  })
})

describe('built-in themes', () => {
  test('have unique names and fill every role with a 256-colour code', () => {
    const themes = listThemes()
    expect(new Set(themes.map((t) => t.name)).size).toBe(themes.length)
    for (const t of themes) {
      for (const code of Object.values(t.colors)) {
        expect(code.startsWith(`${String.fromCharCode(27)}[38;5;`) && code.endsWith('m')).toBe(true)
      }
    }
  })
})
