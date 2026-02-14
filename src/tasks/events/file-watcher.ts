import { type FSWatcher, watch } from 'fs'
import { resolve } from 'path'
import { log } from '../../util/logger'
import type { EventPayload, EventSource } from '../types'

export interface FileWatchConfig {
  paths: string[]
  recursive?: boolean
  ignore?: string[]
  debounce_ms?: number
}

export function createFileWatcher(config: FileWatchConfig, cwd: string): EventSource {
  const watchers: FSWatcher[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let pendingChanges: Set<string> = new Set()
  let callback: ((payload: EventPayload) => void) | undefined

  const debounceMs = config.debounce_ms ?? 1000
  const isRecursive = config.recursive ?? true
  const ignorePatterns = config.ignore ?? []

  function shouldIgnore(filePath: string): boolean {
    for (const pattern of ignorePatterns) {
      // Simple glob matching: **/ matches any directory, * matches within segment
      const regex = pattern
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*')
        .replace(/\./g, '\\.')
      if (new RegExp(regex).test(filePath)) return true
    }
    return false
  }

  function flushChanges(): void {
    if (!callback || pendingChanges.size === 0) return
    const files = Array.from(pendingChanges)
    pendingChanges = new Set()

    callback({
      source: 'file',
      summary: files.length === 1 ? `file changed: ${files[0]}` : `${files.length} files changed`,
      data: { files },
    })
  }

  function handleChange(filename: string | null): void {
    if (!filename) return
    if (shouldIgnore(filename)) return

    pendingChanges.add(filename)

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flushChanges, debounceMs)
  }

  return {
    start(onTrigger) {
      callback = onTrigger

      for (const p of config.paths) {
        const fullPath = resolve(cwd, p)
        try {
          const watcher = watch(fullPath, { recursive: isRecursive }, (_event, filename) => {
            handleChange(filename)
          })
          watchers.push(watcher)
          log.debug('tasks', `File watcher started: ${fullPath}`)
        } catch (err) {
          log.warn('tasks', `Failed to watch ${fullPath}: ${err}`)
        }
      }
    },

    stop() {
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const w of watchers) {
        w.close()
      }
      watchers.length = 0
      pendingChanges.clear()
      callback = undefined
      log.debug('tasks', 'File watcher stopped')
    },
  }
}
