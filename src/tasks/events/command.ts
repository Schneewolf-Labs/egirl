import { log } from '../../util/logger'
import type { EventPayload, EventSource } from '../types'

export interface CommandEventConfig {
  command: string
  poll_interval_ms?: number
  shell?: string
  diff_mode?: 'full' | 'exit_code' | 'hash'
}

export function createCommandSource(config: CommandEventConfig, cwd: string): EventSource {
  let timer: ReturnType<typeof setInterval> | undefined
  let callback: ((payload: EventPayload) => void) | undefined
  let lastHash: string | undefined
  let lastOutput: string | undefined
  let lastExitCode: number | undefined

  const pollMs = config.poll_interval_ms ?? 30_000
  const diffMode = config.diff_mode ?? 'hash'
  const shell = config.shell ?? 'bash'

  async function poll(): Promise<void> {
    try {
      const proc = Bun.spawn([shell, '-c', config.command], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited

      let shouldTrigger = false
      const data: Record<string, unknown> = {
        command: config.command,
        stdout,
        exitCode,
      }

      if (diffMode === 'exit_code') {
        if (lastExitCode !== undefined && lastExitCode !== exitCode) {
          shouldTrigger = true
          data.previousExitCode = lastExitCode
        }
        lastExitCode = exitCode
      } else if (diffMode === 'full') {
        if (lastOutput !== undefined && lastOutput !== stdout) {
          shouldTrigger = true
          data.previousOutput = lastOutput
        }
        lastOutput = stdout
      } else {
        // hash mode
        const hash = await hashString(stdout)
        if (lastHash !== undefined && lastHash !== hash) {
          shouldTrigger = true
        }
        lastHash = hash
      }

      if (shouldTrigger && callback) {
        callback({
          source: 'command',
          summary: `command output changed: ${config.command.slice(0, 50)}`,
          data,
        })
      }
    } catch (err) {
      log.warn('tasks', `Command poll failed for "${config.command}": ${err}`)
    }
  }

  return {
    start(onTrigger) {
      callback = onTrigger
      // Initial run to set baseline
      poll().catch((err) => log.warn('tasks', `Initial command poll failed: ${err}`))
      timer = setInterval(() => {
        poll().catch((err) => log.warn('tasks', `Command poll failed: ${err}`))
      }, pollMs)
      log.debug('tasks', `Command source started: ${config.command} (${pollMs}ms, ${diffMode})`)
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      callback = undefined
      lastHash = undefined
      lastOutput = undefined
      lastExitCode = undefined
      log.debug('tasks', 'Command source stopped')
    },
  }
}

async function hashString(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
