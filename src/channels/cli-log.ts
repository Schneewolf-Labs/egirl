/**
 * `/log [level]`: how much of egirl's own log reaches the terminal, changed without a restart.
 *
 * The level was fixed at startup (`--debug`, `--quiet`). Chasing something live meant
 * quitting the session to restart it with `--debug`, and then the thing being chased was gone.
 * Like `/theme`, it lasts for this session.
 */

import { colors, DIM, RESET } from '../ui/theme'
import { type LogLevel, log } from '../util/logger'

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

const MEANING: Record<LogLevel, string> = {
  debug: 'everything, including per-turn mechanics',
  info: 'what happened (the default)',
  warn: 'warnings and errors only',
  error: 'errors only',
}

/** The reply to `/log [level]`. */
export function logCommand(arg: string): string {
  const c = colors()
  const word = arg.trim().toLowerCase()
  const current = log.getLevel()
  if (!word) {
    const rows = LOG_LEVELS.map((l) => {
      const mark = l === current ? `${c.primary}›${RESET}` : ' '
      return `${mark} ${l.padEnd(5)}  ${DIM}${MEANING[l]}${RESET}`
    })
    return [...rows, `${DIM}  /log <level> changes it for this session${RESET}`].join('\n')
  }
  const level = LOG_LEVELS.find((l) => l === word)
  if (!level) {
    return `${c.warning}No log level "${word}".${RESET} ${DIM}One of: ${LOG_LEVELS.join(', ')}${RESET}`
  }
  log.setLevel(level)
  return `${c.secondary}✦${RESET} ${c.primary}log: ${current} → ${level}${RESET} ${DIM}${MEANING[level]} · for this session${RESET}`
}
