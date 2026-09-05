import { colors, DIM, RESET } from '../ui/theme'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  level: LogLevel
  category: string
  message: string
  data?: unknown
  timestamp: Date
}

/**
 * Render an Error the way a person reads one.
 *
 * `JSON.stringify(new Error('boom'))` is `{}` — `message`, `stack` and `name` are all
 * non-enumerable, so the one field anybody wanted is the one field dropped. Every
 * `log.error(category, message, error)` call in this codebase was printing its message and then a
 * literal `{}` underneath it.
 *
 * `cause` is followed because that chain is usually where the real failure is: a config load that
 * failed because a TOML parse failed because a file was unreadable reports only the outermost of
 * the three without it.
 */
function describeError(error: Error): string {
  const lines: string[] = [error.stack ?? `${error.name}: ${error.message}`]

  let cause: unknown = error.cause
  // Bounded: cause chains are short in practice, but a cycle would otherwise spin here forever.
  for (let depth = 0; cause instanceof Error && depth < 8; depth++) {
    lines.push(`caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`)
    cause = cause.cause
  }

  return lines.join('\n')
}

/** An Error nested inside a payload loses its message exactly the way a top-level one does. */
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

function formatData(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Error) return describeError(data)

  try {
    // Errors are not the only thing this expression got wrong: a circular reference makes
    // JSON.stringify throw, and a throw inside the logger takes down the call site that was only
    // trying to report a problem.
    return JSON.stringify(data, errorReplacer, 2) ?? String(data)
  } catch {
    return String(data)
  }
}

function levelColor(level: LogLevel): string {
  const c = colors()
  switch (level) {
    case 'debug':
      return c.muted
    case 'info':
      return c.info
    case 'warn':
      return c.warning
    case 'error':
      return c.error
  }
}

class Logger {
  private minLevel: LogLevel = 'info'

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
    const color = levelColor(entry.level)
    const time = entry.timestamp.toISOString().slice(11, 23)
    const levelPad = entry.level.toUpperCase().padEnd(5)

    let msg = `${color}[${time}] ${levelPad}${RESET} ${DIM}[${entry.category}]${RESET} ${entry.message}`

    if (entry.data !== undefined) {
      msg += `\n${formatData(entry.data)}`
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

    if (this.shouldLog(level)) {
      // Logs go to stderr so stdout carries only the program's actual output. That is what makes
      // `egirl cli -m "..." --json 2>/dev/null | jq` work; with logs on stdout the two are
      // interleaved and nothing downstream can parse the result.
      console.error(this.formatMessage(entry))
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
}

export const log = new Logger()
