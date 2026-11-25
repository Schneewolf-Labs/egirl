import { log } from './logger'

/**
 * Apply log level based on CLI args.
 * Mutates the global logger level.
 */
export function applyLogLevel(args: string[]): void {
  if (args.includes('--quiet') || args.includes('-q')) {
    log.setLevel('error')
  } else if (
    args.includes('--verbose') ||
    args.includes('-v') ||
    args.includes('--debug') ||
    args.includes('-d')
  ) {
    log.setLevel('debug')
  }
}

export interface ParsedArgs {
  command: string
  commandArgs: string[]
  instance?: string
}

/** Split argv into the command, its own args, and the global `--instance`. */
export function parseGlobalArgs(args: string[]): ParsedArgs {
  const remaining: string[] = []
  let instance: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--instance') {
      const value = args[++i]
      if (!value) throw new Error('--instance requires a name')
      instance = value
      continue
    }

    remaining.push(arg)
  }

  const command = remaining[0] ?? 'cli'
  let commandArgs = remaining.slice(1)
  // `egirl cli juno` is `egirl --instance juno cli`: the instance is the thing you pick when you
  // open a terminal session, so it gets the short form. Flags (`-m`, `--json`) still come first
  // or after; only a bare first word is read as a name.
  const named = commandArgs[0]
  if (command === 'cli' && !instance && named && !named.startsWith('-')) {
    instance = named
    commandArgs = commandArgs.slice(1)
  }

  return {
    command,
    commandArgs,
    ...(instance && { instance }),
  }
}
