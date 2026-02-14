import { log } from './logger'

/**
 * Apply log level based on CLI args.
 * Mutates the global logger level.
 */
export function applyLogLevel(args: string[]): void {
  if (args.includes('--quiet') || args.includes('-q')) {
    log.setLevel('error')
  } else if (args.includes('--verbose') || args.includes('-v') || args.includes('--debug') || args.includes('-d')) {
    log.setLevel('debug')
  }
}
