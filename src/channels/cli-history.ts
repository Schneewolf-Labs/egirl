/**
 * What was typed at the CLI prompt, kept across restarts.
 *
 * readline's ↑ history lived only as long as the process, so restarting an instance lost every
 * command and message typed into it. Each sent line is appended to a file in the instance's
 * workspace (one instance, one history) and read back at the next start. A multi-line paste is
 * not kept: a history entry is one line of the live line, and recalling it whole would not fit.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { log } from '../util/logger'

export const HISTORY_SIZE = 1000

/** The saved lines, newest first (readline's order), at most `limit` of them. */
export function loadHistory(path: string, limit = HISTORY_SIZE): string[] {
  if (!existsSync(path)) return []
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  } catch (err) {
    log.warn('cli', `Could not read input history ${path}:`, err)
    return []
  }
  const kept = lines.filter((l, i) => l !== lines[i - 1]).slice(-limit)
  // The file only grows between starts; cut it back once it is well past the limit.
  if (lines.length > limit * 2) rewrite(path, kept)
  return kept.reverse()
}

/** Save one sent line. Blank and multi-line input is not kept. */
export function appendHistory(path: string, line: string): void {
  const text = line.trim()
  if (!text || text.includes('\n')) return
  try {
    appendFileSync(path, `${text}\n`, { mode: 0o600 })
  } catch (err) {
    log.warn('cli', `Could not save input history ${path}:`, err)
  }
}

function rewrite(path: string, lines: string[]): void {
  try {
    writeFileSync(path, lines.length > 0 ? `${lines.join('\n')}\n` : '', { mode: 0o600 })
  } catch (err) {
    log.warn('cli', `Could not trim input history ${path}:`, err)
  }
}
