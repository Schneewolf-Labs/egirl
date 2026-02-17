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

export async function appendAuditLog(entry: AuditEntry, logPath: string): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true })
    const line = `${JSON.stringify(entry)}\n`
    await appendFile(logPath, line, 'utf-8')
  } catch (error) {
    log.warn('safety', `Failed to write audit log: ${error}`)
  }
}

export async function auditMemoryOperation(
  entry: AuditMemoryEntry,
  logPath: string,
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true })
    const line = `${JSON.stringify(entry)}\n`
    await appendFile(logPath, line, 'utf-8')
  } catch (error) {
    log.warn('safety', `Failed to write memory audit log: ${error}`)
  }
}
