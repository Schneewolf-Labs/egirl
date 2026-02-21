import { spawn } from 'child_process'
import { isAbsolute, resolve } from 'path'
import { log } from '../../util/logger'
import type { Tool, ToolResult } from '../types'

const DEFAULT_TIMEOUT = 30000

/** Grace period after SIGTERM before escalating to SIGKILL */
const SIGKILL_GRACE_MS = 5000

/** Hard deadline after the timeout fires — resolves even if process events never fire */
const HARD_DEADLINE_MS = 10000

/** Build a minimal environment for child processes — strip secrets */
function sanitizedEnv(): Record<string, string | undefined> {
  const SECRET_PATTERNS = [
    /^ANTHROPIC_/i,
    /^OPENAI_/i,
    /^DISCORD_TOKEN$/i,
    /^GITHUB_TOKEN$/i,
    /^XMPP_PASSWORD$/i,
    /^AWS_SECRET/i,
    /^SSH_/i,
    /TOKEN/i,
    /SECRET/i,
    /PASSWORD/i,
    /PRIVATE.?KEY/i,
  ]

  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    const isSecret = SECRET_PATTERNS.some((p) => p.test(key))
    if (!isSecret) {
      env[key] = value
    }
  }
  return env
}

/** Create an execute_command tool with a configurable default timeout */
export function createExecTool(defaultTimeoutMs?: number): Tool {
  const configuredTimeout = defaultTimeoutMs ?? DEFAULT_TIMEOUT

  return {
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
            description: `Timeout in milliseconds (default: ${configuredTimeout})`,
          },
        },
        required: ['command'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const command = params.command as string
      const workingDir = params.working_dir
        ? isAbsolute(params.working_dir as string)
          ? (params.working_dir as string)
          : resolve(cwd, params.working_dir as string)
        : cwd
      const timeout = (params.timeout as number) ?? configuredTimeout

      return new Promise((resolvePromise) => {
        let stdout = ''
        let stderr = ''
        let killed = false
        let resolved = false

        function settle(result: ToolResult): void {
          if (resolved) return
          resolved = true
          resolvePromise(result)
        }

        const proc = spawn(command, {
          shell: true,
          cwd: workingDir,
          env: sanitizedEnv(),
        })

        // Phase 1: SIGTERM after timeout
        const timer = setTimeout(() => {
          killed = true
          log.warn('tools', `Command timed out after ${timeout}ms, sending SIGTERM: ${command}`)
          proc.kill('SIGTERM')

          // Phase 2: SIGKILL if SIGTERM didn't work
          const killTimer = setTimeout(() => {
            log.warn('tools', `Command did not exit after SIGTERM, sending SIGKILL: ${command}`)
            proc.kill('SIGKILL')
          }, SIGKILL_GRACE_MS)

          // Phase 3: Hard deadline — resolve even if process events never fire
          const hardTimer = setTimeout(() => {
            log.error('tools', `Command hard deadline reached, forcing resolution: ${command}`)
            settle({
              success: false,
              output: `Command timed out after ${timeout}ms and failed to terminate\n\nPartial stdout:\n${stdout}\n\nPartial stderr:\n${stderr}`,
            })
          }, HARD_DEADLINE_MS)

          // Don't let these timers prevent process exit
          killTimer.unref()
          hardTimer.unref()
        }, timeout)

        proc.stdout.on('data', (data) => {
          stdout += data.toString()
        })

        proc.stderr.on('data', (data) => {
          stderr += data.toString()
        })

        proc.on('error', (error) => {
          clearTimeout(timer)
          settle({
            success: false,
            output: `Failed to execute command: ${error.message}`,
          })
        })

        proc.on('close', (code) => {
          clearTimeout(timer)

          if (killed) {
            settle({
              success: false,
              output: `Command timed out after ${timeout}ms\n\nPartial stdout:\n${stdout}\n\nPartial stderr:\n${stderr}`,
            })
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
}

/** Default exec tool instance (30s timeout) */
export const execTool: Tool = createExecTool()
