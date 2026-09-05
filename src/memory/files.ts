import { appendFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'

export class MemoryFiles {
  private dailyLogDir: string

  constructor(workspaceDir: string) {
    this.dailyLogDir = join(workspaceDir, 'logs')
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

  /**
   * List available daily log files, returning dates (YYYY-MM-DD) sorted newest first
   */
  async listDailyLogs(): Promise<string[]> {
    const { readdir } = await import('fs/promises')
    try {
      const files = await readdir(this.dailyLogDir)
      return files
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace('.md', ''))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }
}

export function createMemoryFiles(workspaceDir: string): MemoryFiles {
  return new MemoryFiles(workspaceDir)
}
