import { spawn } from 'child_process'
import { isAbsolute, resolve } from 'path'
import type { Tool, ToolResult } from '../types'

const DEFAULT_TIMEOUT = 30000

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

      const proc = spawn(command, {
        shell: true,
        cwd: workingDir,
        env: sanitizedEnv(),
      })

      const timer = setTimeout(() => {
        killed = true
        proc.kill('SIGTERM')
      }, timeout)

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('error', (error) => {
        clearTimeout(timer)
        resolvePromise({
          success: false,
          output: `Failed to execute command: ${error.message}`,
        })
      })

      proc.on('close', (code) => {
        clearTimeout(timer)

        if (killed) {
          resolvePromise({
            success: false,
            output: `Command timed out after ${timeout}ms\n\nPartial stdout:\n${stdout}\n\nPartial stderr:\n${stderr}`,
          })
          return
        }

        const output = stdout + (stderr ? `\n\nstderr:\n${stderr}` : '')

        resolvePromise({
          success: code === 0,
          output: output || `Command completed with exit code ${code}`,
        })
      })
    })
  },
}
