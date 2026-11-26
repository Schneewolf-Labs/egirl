/**
 * `/theme`: list the colour themes, or switch to one now.
 *
 * The list shows each theme as a swatch of its eight roles, so choosing does not mean trying
 * them one by one. A switch lasts for this session: like every other startup setting the
 * config's `theme = "…"` is what the next start uses, and the reply says how to keep it.
 */

import { colors, DIM, getTheme, listThemes, RESET, setTheme, type Theme } from '../ui/theme'

/** Eight blocks, one per colour role, in the theme's own colours. */
export function swatch(theme: Theme): string {
  const c = theme.colors
  const roles = [c.primary, c.secondary, c.accent, c.muted, c.success, c.error, c.warning, c.info]
  return `${roles.map((code) => `${code}■`).join('')}${RESET}`
}

/** The reply to `/theme [name]`. */
export function themeCommand(arg: string): string {
  const name = arg.trim().toLowerCase()
  if (!name) return themeList()
  const theme = listThemes().find((t) => t.name === name)
  if (!theme) {
    return `${colors().warning}No theme "${name}".${RESET} ${DIM}/theme lists them.${RESET}`
  }
  setTheme(theme.name)
  const c = colors()
  return (
    `${c.secondary}✦${RESET} ${c.primary}theme: ${theme.name}${RESET} ${swatch(theme)} ` +
    `${DIM}${theme.label}${RESET}\n` +
    `${DIM}  for this session · theme = "${theme.name}" in egirl.toml keeps it${RESET}`
  )
}

function themeList(): string {
  const current = getTheme().name
  const themes = listThemes()
  const width = Math.max(...themes.map((t) => t.name.length))
  const rows = themes.map((t) => {
    const mark = t.name === current ? `${colors().primary}›${RESET}` : ' '
    return `${mark} ${t.name.padEnd(width)}  ${swatch(t)}  ${DIM}${t.label}${RESET}`
  })
  return [...rows, `${DIM}  /theme <name> switches now${RESET}`].join('\n')
}
