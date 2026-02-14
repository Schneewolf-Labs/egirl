import { appendFile, copyFile, mkdir, readFile, writeFile } from 'fs/promises'
import { extname, join } from 'path'
import { log } from '../util/logger'

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
  private imagesDir: string

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir
    this.memoryFile = join(workspaceDir, 'MEMORY.md')
    this.dailyLogDir = join(workspaceDir, 'logs')
    this.imagesDir = join(workspaceDir, 'images')
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

  /**
   * Store an image and return the path
   */
  async storeImage(imageData: string | Buffer, key: string, extension = '.png'): Promise<string> {
    await mkdir(this.imagesDir, { recursive: true })

    // Generate filename from key and timestamp
    const safeKey = key.replace(/[^a-zA-Z0-9-_]/g, '_')
    const timestamp = Date.now()
    const filename = `${safeKey}-${timestamp}${extension}`
    const imagePath = join(this.imagesDir, filename)

    if (typeof imageData === 'string') {
      // Handle base64 data URL
      if (imageData.startsWith('data:')) {
        const base64Data = imageData.split(',')[1]
        if (!base64Data) throw new Error('Invalid data URL')
        const buffer = Buffer.from(base64Data, 'base64')
        await writeFile(imagePath, buffer)
      } else {
        // Assume it's a file path, copy it
        await copyFile(imageData, imagePath)
      }
    } else {
      await writeFile(imagePath, imageData)
    }

    log.debug('memory', `Stored image: ${imagePath}`)
    return imagePath
  }

  /**
   * Read an image as base64 data URL
   */
  async readImage(imagePath: string): Promise<string> {
    const buffer = await readFile(imagePath)
    const ext = extname(imagePath).slice(1) || 'png'
    const mimeType = ext === 'jpg' ? 'jpeg' : ext
    return `data:image/${mimeType};base64,${buffer.toString('base64')}`
  }

  /**
   * Get the images directory path
   */
  getImagesDir(): string {
    return this.imagesDir
  }
}

export function createMemoryFiles(workspaceDir: string): MemoryFiles {
  return new MemoryFiles(workspaceDir)
}
