import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { log } from '../utils/logger'

export interface MemoryEntry {
  id: string
  key: string
  value: string
  timestamp: Date
  source?: string
}

export class MemoryFiles {
  private workspaceDir: string
  private memoryFile: string
  private dailyLogDir: string

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir
    this.memoryFile = join(workspaceDir, 'MEMORY.md')
    this.dailyLogDir = join(workspaceDir, 'logs')
  }

  async readMemoryFile(): Promise<string> {
    try {
      return await readFile(this.memoryFile, 'utf-8')
    } catch {
      return ''
    }
  }

  async appendToMemoryFile(content: string): Promise<void> {
    await appendFile(this.memoryFile, `\n${content}`)
  }

  async getDailyLogPath(): Promise<string> {
    const date = new Date().toISOString().slice(0, 10)
    await mkdir(this.dailyLogDir, { recursive: true })
    return join(this.dailyLogDir, `${date}.md`)
  }

  async appendToDailyLog(content: string): Promise<void> {
    const logPath = await this.getDailyLogPath()
    const timestamp = new Date().toISOString()
    await appendFile(logPath, `\n[${timestamp}] ${content}`)
  }

  async readDailyLog(date?: string): Promise<string> {
    const targetDate = date ?? new Date().toISOString().slice(0, 10)
    const logPath = join(this.dailyLogDir, `${targetDate}.md`)

    try {
      return await readFile(logPath, 'utf-8')
    } catch {
      return ''
    }
  }
}

export function createMemoryFiles(workspaceDir: string): MemoryFiles {
  return new MemoryFiles(workspaceDir)
}
