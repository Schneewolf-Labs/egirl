/**
 * The built-in terminal themes. Each one fills the same eight colour roles (`ThemeColors`), so
 * display code never names a colour: it asks `colors()` for a role and the active theme answers.
 * 256-colour codes only, so every theme looks the same in any terminal that has them.
 */

import type { Theme } from './theme'

// 256-color ANSI helper: \x1b[38;5;{n}m
export function c256(n: number): string {
  return `\x1b[38;5;${n}m`
}

/**
 * egirl — Default theme. Purple-pink palette from the logo.
 * Deep purple primary, hot pink secondary, orchid accents.
 */
export const egirl: Theme = {
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

/**
 * vapor -- Purple vaporwave. Ultraviolet primary, magenta secondary, cyan accents.
 *
 * The palette is doing work rather than decoration: a long agent turn produces reasoning, tool
 * calls, tool output and final text interleaved, and at a glance those need to separate. Violet
 * carries the agent's own voice, magenta marks structure, and cyan is reserved for tools -- the
 * one thing you scan for when something has gone wrong. Muted is a desaturated indigo rather
 * than grey so that de-emphasised text still reads as part of the same picture.
 */
const vapor: Theme = {
  name: 'vapor',
  label: 'Purple Vaporwave',
  colors: {
    primary: c256(141), // ultraviolet -- agent voice, prompts
    secondary: c256(207), // hot magenta -- name, headings
    accent: c256(87), // cyan -- tool calls, separators
    muted: c256(103), // dusty indigo -- metadata, reasoning
    success: c256(120), // mint
    error: c256(211), // sunset pink
    warning: c256(222), // peach
    info: c256(147), // periwinkle
  },
}

/** dracula -- Dark, after the Dracula editor palette. */
const dracula: Theme = {
  name: 'dracula',
  label: 'Dracula: purple, pink, cyan',
  colors: {
    primary: c256(141), // purple
    secondary: c256(212), // pink
    accent: c256(117), // cyan
    muted: c256(61), // comment blue
    success: c256(84), // green
    error: c256(203), // red
    warning: c256(228), // yellow
    info: c256(215), // orange
  },
}

/** nord -- Cool and low-contrast, after the Nord palette. */
const nord: Theme = {
  name: 'nord',
  label: 'Nord: arctic frost blues',
  colors: {
    primary: c256(110), // frost
    secondary: c256(139), // aurora purple
    accent: c256(109), // frost teal
    muted: c256(60), // polar night
    success: c256(108), // aurora green
    error: c256(131), // aurora red
    warning: c256(222), // aurora yellow
    info: c256(67), // deep frost
  },
}

/** gruvbox -- Warm earth tones, after the gruvbox palette. */
const gruvbox: Theme = {
  name: 'gruvbox',
  label: 'Gruvbox: warm retro',
  colors: {
    primary: c256(214), // yellow
    secondary: c256(175), // purple
    accent: c256(108), // aqua
    muted: c256(245), // gray
    success: c256(142), // green
    error: c256(167), // red
    warning: c256(208), // orange
    info: c256(109), // blue
  },
}

/** catppuccin -- Pastel on dark, after Catppuccin Mocha. */
const catppuccin: Theme = {
  name: 'catppuccin',
  label: 'Catppuccin Mocha: soft pastels',
  colors: {
    primary: c256(183), // mauve
    secondary: c256(218), // pink
    accent: c256(116), // teal
    muted: c256(243), // overlay
    success: c256(151), // green
    error: c256(211), // red
    warning: c256(223), // yellow
    info: c256(111), // blue
  },
}

/** solarized -- Readable on a light or a dark background, after Solarized. */
const solarized: Theme = {
  name: 'solarized',
  label: 'Solarized: works on light or dark',
  colors: {
    primary: c256(32), // blue
    secondary: c256(162), // magenta
    accent: c256(36), // cyan
    muted: c256(242), // base01
    success: c256(100), // green
    error: c256(160), // red
    warning: c256(136), // yellow
    info: c256(61), // violet
  },
}

/** tokyonight -- Night-city blues and violets, after Tokyo Night. */
const tokyonight: Theme = {
  name: 'tokyonight',
  label: 'Tokyo Night: neon city blues',
  colors: {
    primary: c256(111), // blue
    secondary: c256(141), // magenta
    accent: c256(117), // cyan
    muted: c256(60), // comment
    success: c256(149), // green
    error: c256(204), // red
    warning: c256(179), // yellow
    info: c256(38), // teal
  },
}

/** rosepine -- Muted rose and pine, after Rosé Pine. */
const rosepine: Theme = {
  name: 'rosepine',
  label: 'Rosé Pine: muted roses',
  colors: {
    primary: c256(183), // iris
    secondary: c256(217), // rose
    accent: c256(152), // foam
    muted: c256(60), // muted
    success: c256(116), // foam green
    error: c256(204), // love
    warning: c256(222), // gold
    info: c256(31), // pine
  },
}

/** sakura -- Blossom pink with leaf-green accents. */
const sakura: Theme = {
  name: 'sakura',
  label: 'Sakura: cherry blossom pinks',
  colors: {
    primary: c256(218), // blossom
    secondary: c256(211), // deep blossom
    accent: c256(151), // leaf
    muted: c256(244), // bark gray
    success: c256(150), // new leaf
    error: c256(203), // camellia
    warning: c256(223), // pale sun
    info: c256(182), // wisteria
  },
}

/** crescent -- Moonlight: silver and indigo, nothing loud. */
const crescent: Theme = {
  name: 'crescent',
  label: 'Crescent: moonlit silver and indigo',
  colors: {
    primary: c256(189), // moonlight
    secondary: c256(147), // lilac
    accent: c256(110), // night sky
    muted: c256(60), // dusk
    success: c256(115), // sea glass
    error: c256(174), // dusty rose
    warning: c256(187), // pale gold
    info: c256(153), // starlight
  },
}

/** synthwave -- Outrun: hot pink, cyan grid, an orange sun. */
const synthwave: Theme = {
  name: 'synthwave',
  label: 'Synthwave: pink, cyan, sunset orange',
  colors: {
    primary: c256(213), // neon pink
    secondary: c256(51), // grid cyan
    accent: c256(208), // sun orange
    muted: c256(97), // haze purple
    success: c256(49), // laser green
    error: c256(197), // hot red
    warning: c256(220), // chrome yellow
    info: c256(141), // violet
  },
}

/** matcha -- Calm greens and tan, easy on the eyes for long runs. */
const matcha: Theme = {
  name: 'matcha',
  label: 'Matcha: calm greens and tan',
  colors: {
    primary: c256(108), // matcha
    secondary: c256(150), // sprout
    accent: c256(180), // oat
    muted: c256(242), // stone
    success: c256(114), // leaf
    error: c256(167), // clay
    warning: c256(186), // straw
    info: c256(109), // slate
  },
}

/** ember -- Embers: orange and red with a gold accent. */
const ember: Theme = {
  name: 'ember',
  label: 'Ember: fire oranges',
  colors: {
    primary: c256(208), // flame
    secondary: c256(202), // deep flame
    accent: c256(220), // spark
    muted: c256(241), // ash
    success: c256(142), // olive
    error: c256(196), // red
    warning: c256(214), // amber
    info: c256(216), // glow
  },
}

/** ocean -- Deep-water blues with a sea-green accent. */
const ocean: Theme = {
  name: 'ocean',
  label: 'Ocean: deep sea blues',
  colors: {
    primary: c256(39), // ocean blue
    secondary: c256(45), // surf
    accent: c256(79), // sea green
    muted: c256(66), // depths
    success: c256(42), // kelp
    error: c256(203), // coral
    warning: c256(221), // sand
    info: c256(74), // tide
  },
}

/** amber -- A one-colour amber terminal, as on an old CRT; roles differ by brightness. */
const amber: Theme = {
  name: 'amber',
  label: 'Amber: retro amber CRT',
  colors: {
    primary: c256(214), // amber
    secondary: c256(220), // bright amber
    accent: c256(178), // dim amber
    muted: c256(136), // burnt amber
    success: c256(186), // pale amber
    error: c256(202), // red-orange
    warning: c256(226), // yellow
    info: c256(172), // dark amber
  },
}

/** paper -- Dark, saturated colours that stay readable on a white or cream background. */
const paper: Theme = {
  name: 'paper',
  label: 'Paper: for light terminal backgrounds',
  colors: {
    primary: c256(55), // deep purple
    secondary: c256(161), // deep pink
    accent: c256(30), // teal
    muted: c256(245), // gray
    success: c256(28), // green
    error: c256(160), // red
    warning: c256(130), // brown
    info: c256(25), // navy
  },
}

/** In the order `/theme` lists them: egirl's own first, then the rest. */
export const THEMES: readonly Theme[] = [
  egirl,
  vapor,
  midnight,
  neon,
  mono,
  dracula,
  nord,
  gruvbox,
  catppuccin,
  solarized,
  tokyonight,
  rosepine,
  sakura,
  crescent,
  synthwave,
  matcha,
  ember,
  ocean,
  amber,
  paper,
]
