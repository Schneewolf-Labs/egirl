import { spawn } from 'child_process'
import { resolve, isAbsolute } from 'path'
import type { Tool, ToolContext, ToolResult } from '../types'

interface ExecParams {
  command: string
  cwd?: string
  timeout?: number
}

const DEFAULT_TIMEOUT = 30000 // 30 seconds

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
        cwd: {
          type: 'string',
          description: 'The working directory for the command (defaults to workspace)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      required: ['command'],
    },
  },

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { command, cwd, timeout = DEFAULT_TIMEOUT } = params as ExecParams

    const workingDir = cwd
      ? (isAbsolute(cwd) ? cwd : resolve(context.workspaceDir, cwd))
      : context.workspaceDir

    return new Promise((resolvePromise) => {
      let stdout = ''
      let stderr = ''
      let killed = false

      const proc = spawn(command, {
        shell: true,
        cwd: workingDir,
        env: { ...process.env },
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
