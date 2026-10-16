import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { log } from '../util/logger'

/**
 * Which Claude Code session continues which egirl session.
 *
 * The SDK keeps the transcript; egirl keeps only the id that resumes it, so a restart picks the
 * conversation back up instead of starting a stranger. One small JSON file in the workspace,
 * read once and rewritten on every change: a handful of entries, changed a few times a day.
 */
export interface ClaudeSessionMap {
  get(sessionId: string): string | undefined
  set(sessionId: string, claudeSessionId: string): void
  delete(sessionId: string): void
}

export function openClaudeSessionMap(path: string): ClaudeSessionMap {
  let entries: Record<string, string> = {}
  try {
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') entries[k] = v
        }
      }
    }
  } catch (error) {
    log.warn('operator', `Could not read ${path}; Claude sessions start fresh:`, error)
    entries = {}
  }

  const flush = (): void => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`)
      renameSync(tmp, path)
    } catch (error) {
      log.warn('operator', `Could not write ${path}:`, error)
    }
  }

  return {
    get: (sessionId) => entries[sessionId],
    set(sessionId, claudeSessionId) {
      if (entries[sessionId] === claudeSessionId) return
      entries[sessionId] = claudeSessionId
      flush()
    },
    delete(sessionId) {
      if (!(sessionId in entries)) return
      delete entries[sessionId]
      flush()
    },
  }
}
