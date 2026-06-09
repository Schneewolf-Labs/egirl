import { spawn } from 'child_process'
import { sanitizedEnv } from '../../../util/env'
import { log } from '../../../util/logger'
import type { ToolResult } from '../../types'
import { DEFAULT_TIMEOUT_MS, stripAnsi } from './shared'
import type { CodeAgentBackend, CodeAgentConfig } from './types'

// Allow pointing at a non-PATH binary (e.g. a pinned install) without code edits.
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? 'opencode'

/**
 * Build the argv for `opencode run`. opencode's headless mode is fully
 * non-interactive: it prints the assistant transcript to stdout and exits, so
 * there is no mid-run prompt for egirl's supervisor to intercept. Permission
 * posture is therefore decided up front from permissionMode.
 */
export function buildOpencodeArgs(
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
): string[] {
  const args = ['run', '--dir', workingDir, '--format', 'default']

  // bypass/acceptEdits → let opencode act without gating. default/plan keep
  // opencode's own permission config, which in headless mode declines actions
  // it would otherwise prompt for.
  if (config.permissionMode === 'bypassPermissions' || config.permissionMode === 'acceptEdits') {
    args.push('--dangerously-skip-permissions')
  }
  if (config.permissionMode === 'plan') {
    args.push('--agent', 'plan')
  }

  if (config.model) {
    // opencode expects provider/model, e.g. "anthropic/claude-sonnet-4-5".
    args.push('--model', config.model)
  }

  args.push(task)
  return args
}

export const runOpencodeCodeAgent: CodeAgentBackend = (config, task, workingDir) => {
  const startTime = Date.now()
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<ToolResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const duration = (): string => ((Date.now() - startTime) / 1000).toFixed(1)

    const finish = (result: ToolResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const proc = spawn(OPENCODE_BIN, buildOpencodeArgs(config, task, workingDir), {
      cwd: workingDir,
      env: {
        ...sanitizedEnv(),
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
      const output = stripAnsi(stdout).trim()
      finish({
        success: false,
        output: `Code agent timed out after ${(timeoutMs / 1000).toFixed(0)}s${
          output ? `\n\nPartial output:\n${output}` : ''
        }`,
      })
    }, timeoutMs)

    proc.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      const msg =
        code === 'ENOENT'
          ? `opencode CLI not found (looked for "${OPENCODE_BIN}"). Install it or set OPENCODE_BIN.`
          : error.message
      log.error('code-agent', `opencode error: ${msg}`)
      finish({ success: false, output: `Code agent error: ${msg}` })
    })

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (exitCode) => {
      if (timedOut) return

      const output = stripAnsi(stdout).trim()
      const errText = stripAnsi(stderr).trim()

      if (exitCode !== 0) {
        log.error('code-agent', `opencode exited with code ${exitCode}`)
        finish({
          success: false,
          output: [
            `Code agent error: opencode exited with code ${exitCode}`,
            errText || undefined,
            output || undefined,
          ]
            .filter(Boolean)
            .join('\n\n'),
        })
        return
      }

      log.info('code-agent', `opencode completed in ${duration()}s`)
      const metadata = `[code_agent: opencode | ${duration()}s]`
      finish({
        success: true,
        output: output
          ? `${output}\n\n${metadata}`
          : `opencode completed with no output\n\n${metadata}`,
      })
    })
  })
}
