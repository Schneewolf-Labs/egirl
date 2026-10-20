import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { log } from '../util/logger'

/**
 * Which hosted-harness session continues which egirl session: a Claude Code session id, or a
 * Codex thread id, one file per harness.
 *
 * The harness keeps the transcript; egirl keeps only the id that resumes it, so a restart picks
 * the conversation back up instead of starting a stranger. One small JSON file in the workspace.
 *
 * Every access reads the file, and every change is a read-modify-write: chat runs in one
 * process (`serve`) and tasks in another (`api`), both on this file, and a copy held in memory
 * would write back the other process's entries as they were when it started. A handful of
 * entries, read once per turn, so the cost is nothing.
 */
export interface SessionMap {
  get(sessionId: string): string | undefined
  set(sessionId: string, claudeSessionId: string): void
  delete(sessionId: string): void
}

export function openSessionMap(path: string): SessionMap {
  const read = (): Record<string, string> => {
    const entries: Record<string, string> = {}
    try {
      if (!existsSync(path)) return entries
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') entries[k] = v
        }
      }
    } catch (error) {
      log.warn('operator', `Could not read ${path}; sessions start fresh:`, error)
    }
    return entries
  }

  const write = (entries: Record<string, string>): void => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`)
      renameSync(tmp, path)
    } catch (error) {
      log.warn('operator', `Could not write ${path}:`, error)
    }
  }

  return {
    get: (sessionId) => read()[sessionId],
    set(sessionId, claudeSessionId) {
      const entries = read()
      if (entries[sessionId] === claudeSessionId) return
      entries[sessionId] = claudeSessionId
      write(entries)
    },
    delete(sessionId) {
      const entries = read()
      if (!(sessionId in entries)) return
      delete entries[sessionId]
      write(entries)
    },
  }
}
