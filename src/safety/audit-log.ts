import { appendFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { log } from '../util/logger'

export interface AuditEntry {
  timestamp: string
  tool: string
  args: Record<string, unknown>
  blocked: boolean
  reason?: string
  success?: boolean
}

export interface AuditMemoryEntry {
  timestamp: string
  action: 'memory_get' | 'memory_set' | 'memory_delete' | 'memory_search' | 'memory_recall'
  key?: string
  query?: string
  source?: string
  sessionId?: string
}

async function appendJsonl(entry: unknown, logPath: string, what: string): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf-8')
  } catch (error) {
    log.warn('safety', `Failed to write ${what}: ${error}`)
  }
}

export function appendAuditLog(entry: AuditEntry, logPath: string): Promise<void> {
  return appendJsonl(entry, logPath, 'audit log')
}

export function auditMemoryOperation(entry: AuditMemoryEntry, logPath: string): Promise<void> {
  return appendJsonl(entry, logPath, 'memory audit log')
}
