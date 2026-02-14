type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  level: LogLevel
  category: string
  message: string
  data?: unknown
  timestamp: Date
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',  // gray
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
}

const RESET = '\x1b[0m'

class Logger {
  private minLevel: LogLevel = 'info'
  private entries: LogEntry[] = []
  private maxEntries = 1000

  setLevel(level: LogLevel): void {
    this.minLevel = level
  }

  getLevel(): LogLevel {
    return this.minLevel
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error']
    return levels.indexOf(level) >= levels.indexOf(this.minLevel)
  }

  private formatMessage(entry: LogEntry): string {
    const color = LEVEL_COLORS[entry.level]
    const time = entry.timestamp.toISOString().slice(11, 23)
    const levelPad = entry.level.toUpperCase().padEnd(5)

    let msg = `${color}[${time}] ${levelPad}${RESET} [${entry.category}] ${entry.message}`

    if (entry.data !== undefined) {
      const dataStr = typeof entry.data === 'string'
        ? entry.data
        : JSON.stringify(entry.data, null, 2)
      msg += `\n${dataStr}`
    }

    return msg
  }

  private log(level: LogLevel, category: string, message: string, data?: unknown): void {
    const entry: LogEntry = {
      level,
      category,
      message,
      data,
      timestamp: new Date(),
    }

    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) {
      this.entries.shift()
    }

    if (this.shouldLog(level)) {
      console.log(this.formatMessage(entry))
    }
  }

  debug(category: string, message: string, data?: unknown): void {
    this.log('debug', category, message, data)
  }

  info(category: string, message: string, data?: unknown): void {
    this.log('info', category, message, data)
  }

  warn(category: string, message: string, data?: unknown): void {
    this.log('warn', category, message, data)
  }

  error(category: string, message: string, data?: unknown): void {
    this.log('error', category, message, data)
  }

  getEntries(filter?: { level?: LogLevel; category?: string; limit?: number }): LogEntry[] {
    let filtered = this.entries

    if (filter?.level) {
      filtered = filtered.filter(e => e.level === filter.level)
    }

    if (filter?.category) {
      filtered = filtered.filter(e => e.category === filter.category)
    }

    if (filter?.limit) {
      filtered = filtered.slice(-filter.limit)
    }

    return filtered
  }
}

export const log = new Logger()
