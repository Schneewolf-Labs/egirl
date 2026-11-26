/**
 * The active terminal theme. Display code asks `colors()` for a role (primary, error, ...) each
 * time it draws, so switching themes (`/theme`) repaints everything from then on. The themes
 * themselves are in `themes.ts`.
 */

import { egirl, THEMES } from './themes'

export interface ThemeColors {
  /** Brand primary — prompts, headings, emphasis */
  primary: string
  /** Brand secondary — agent name, highlights */
  secondary: string
  /** Tertiary accent — decorative elements, separators */
  accent: string
  /** De-emphasized text — timestamps, tool output, metadata */
  muted: string
  /** Success indicators */
  success: string
  /** Error indicators */
  error: string
  /** Warning indicators */
  warning: string
  /** Informational log levels */
  info: string
}

export interface Theme {
  name: string
  label: string
  colors: ThemeColors
}

/** ANSI text modifiers */
export const RESET = '\x1b[0m'
export const DIM = '\x1b[2m'
export const BOLD = '\x1b[1m'
/** Text styles for rendered markdown. Not colours: they read the same under every theme. */
export const ITALIC = '\x1b[3m'
export const UNDERLINE = '\x1b[4m'
export const STRIKE = '\x1b[9m'

let activeTheme: Theme = egirl

export function setTheme(name: string): void {
  const theme = THEMES.find((t) => t.name === name)
  if (!theme) {
    const valid = THEMES.map((t) => t.name).join(', ')
    throw new Error(`Unknown theme "${name}" — valid themes: ${valid}`)
  }
  activeTheme = theme
}

/** Every built-in theme, in the order `/theme` lists them. */
export function listThemes(): readonly Theme[] {
  return THEMES
}

export function getTheme(): Theme {
  return activeTheme
}

/** Shorthand: get current theme colors */
export function colors(): ThemeColors {
  return activeTheme.colors
}
