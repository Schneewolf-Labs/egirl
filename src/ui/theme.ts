/** Terminal color themes derived from the egirl brand palette */

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

// 256-color ANSI helper: \x1b[38;5;{n}m
function c256(n: number): string {
  return `\x1b[38;5;${n}m`
}

/**
 * egirl — Default theme. Purple-pink palette from the logo.
 * Deep purple primary, hot pink secondary, orchid accents.
 */
const egirl: Theme = {
  name: 'egirl',
  label: 'Purple/Pink (default)',
  colors: {
    primary: c256(135), // medium purple — like the "e" in the logo
    secondary: c256(198), // hot pink — like the "girl" in the logo
    accent: c256(171), // orchid — tail, hair mix
    muted: c256(243), // neutral gray
    success: c256(114), // soft green
    error: c256(204), // rose red
    warning: c256(221), // gold
    info: c256(141), // light purple
  },
}

/**
 * midnight — Cool blues and teals. Late-night hacking aesthetic.
 */
const midnight: Theme = {
  name: 'midnight',
  label: 'Blue/Teal',
  colors: {
    primary: c256(75), // steel blue
    secondary: c256(117), // light sky blue
    accent: c256(44), // dark cyan
    muted: c256(240), // dark gray
    success: c256(79), // sea green
    error: c256(167), // indian red
    warning: c256(179), // light goldenrod
    info: c256(110), // light steel blue
  },
}

/**
 * neon — High-contrast greens and cyans. Cyberpunk terminal.
 */
const neon: Theme = {
  name: 'neon',
  label: 'Green/Cyan',
  colors: {
    primary: c256(46), // green
    secondary: c256(51), // cyan
    accent: c256(201), // magenta
    muted: c256(242), // gray
    success: c256(48), // spring green
    error: c256(196), // red
    warning: c256(226), // yellow
    info: c256(87), // aquamarine
  },
}

/**
 * mono — Grayscale. For when you want the output, not the vibes.
 */
const mono: Theme = {
  name: 'mono',
  label: 'Grayscale',
  colors: {
    primary: c256(255), // bright white
    secondary: c256(250), // light gray
    accent: c256(245), // medium gray
    muted: c256(240), // dark gray
    success: c256(250), // light gray
    error: c256(255), // bright white
    warning: c256(248), // silver
    info: c256(246), // gray
  },
}

const THEMES: Record<string, Theme> = { egirl, midnight, neon, mono }

/** ANSI text modifiers */
export const RESET = '\x1b[0m'
export const DIM = '\x1b[2m'
export const BOLD = '\x1b[1m'

let activeTheme: Theme = egirl

export function setTheme(name: string): void {
  const theme = THEMES[name]
  if (!theme) {
    const valid = Object.keys(THEMES).join(', ')
    throw new Error(`Unknown theme "${name}" — valid themes: ${valid}`)
  }
  activeTheme = theme
}

export function getTheme(): Theme {
  return activeTheme
}

export function listThemes(): Theme[] {
  return Object.values(THEMES)
}

/** Shorthand: get current theme colors */
export function colors(): ThemeColors {
  return activeTheme.colors
}
