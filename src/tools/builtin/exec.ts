import { spawn } from 'child_process'
import { isAbsolute, resolve } from 'path'
import { sanitizedEnv } from '../../util/env'
import { log } from '../../util/logger'
import type { Tool, ToolResult } from '../types'

const DEFAULT_TIMEOUT = 30000
/** How long a command gets to die politely after SIGTERM before it is SIGKILLed */
export const KILL_GRACE_MS = 5000
/**
 * Extra slack after the SIGKILL before we stop waiting for the process to report anything
 * and resolve regardless. A wedged grandchild can hold the stdio pipes open so `close`
 * never fires at all.
 */
export const HARD_DEADLINE_SLACK_MS = 2000

export const execTool: Tool = {
  definition: {
    name: 'execute_command',
    description: 'Execute a shell command and return its output. Use with caution.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        working_dir: {
          type: 'string',
          description: 'The working directory for the command (defaults to cwd)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      required: ['command'],
    },
  },

  /**
   * Three things have to hold for a hanging command not to hang the agent, and only the
   * first of them did:
   *
   *  1. a timeout that signals the command — SIGTERM at `timeout`;
   *  2. escalation, because SIGTERM is only a *request*. A command that traps it survives,
   *     so SIGKILL follows after a grace period;
   *  3. a hard deadline that settles this promise even if the process never reports back.
   *     `close` fires only once the stdio pipes are done, so a wedged grandchild holding
   *     stdout open means it never fires — the tool call would await forever, and with it
   *     whichever agent run is holding the session mutex.
   *
   * Signals go to the process GROUP, not the pid. Under `shell: true` the pid is the shell,
   * and signalling only that leaves `sleep 300 & wait`-shaped children alive still holding
   * the pipes — which is precisely the hang this is meant to end.
   */
  async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const command = params.command as string
    const workingDir = params.working_dir
      ? isAbsolute(params.working_dir as string)
        ? (params.working_dir as string)
        : resolve(cwd, params.working_dir as string)
      : cwd
    const timeout = (params.timeout as number) ?? DEFAULT_TIMEOUT

    return new Promise((resolvePromise) => {
      let stdout = ''
      let stderr = ''
      let killed = false
      let settled = false
      const timers: ReturnType<typeof setTimeout>[] = []

      const groupKill = process.platform !== 'win32'
      const proc = spawn(command, {
        shell: true,
        cwd: workingDir,
        env: sanitizedEnv(),
        // Own process group, so one signal reaches the shell AND everything it started.
        detached: groupKill,
      })

      const clearTimers = () => {
        for (const t of timers) clearTimeout(t)
        timers.length = 0
      }

      const signal = (sig: NodeJS.Signals) => {
        if (proc.pid === undefined) return
        try {
          if (groupKill) process.kill(-proc.pid, sig)
          else proc.kill(sig)
        } catch {
          // already dead, or the group went away between the check and the signal
        }
      }

      const settle = (result: ToolResult) => {
        if (settled) return
        settled = true
        clearTimers()
        resolvePromise(result)
      }

      const timedOut = (note: string): ToolResult => ({
        success: false,
        output:
          `Command timed out after ${timeout}ms${note}\n\n` +
          `Partial stdout:\n${stdout}\n\nPartial stderr:\n${stderr}`,
      })

      timers.push(
        setTimeout(() => {
          killed = true
          signal('SIGTERM')
          timers.push(
            setTimeout(() => {
              if (settled) return
              log.warn('tools', `Command ignored SIGTERM for ${KILL_GRACE_MS}ms; sending SIGKILL`)
              signal('SIGKILL')
            }, KILL_GRACE_MS),
          )
          timers.push(
            setTimeout(() => {
              if (settled) return
              log.warn('tools', 'Command never reported exit after SIGKILL; abandoning it')
              settle(timedOut(' (killed; process never reported exit)'))
            }, KILL_GRACE_MS + HARD_DEADLINE_SLACK_MS),
          )
        }, timeout),
      )

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('error', (error) => {
        settle({
          success: false,
          output: `Failed to execute command: ${error.message}`,
        })
      })

      proc.on('close', (code) => {
        if (killed) {
          settle(timedOut(''))
          return
        }
        const output = stdout + (stderr ? `\n\nstderr:\n${stderr}` : '')
        settle({
          success: code === 0,
          output: output || `Command completed with exit code ${code}`,
        })
      })
    })
  },
}
