import { type Options as ClaudeAgentOptions, query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'fs'
import { join } from 'path'
import { log } from '../../util/logger'
import type { Tool, ToolResult } from '../types'

/** Default timeout: 5 minutes */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export type CodeAgentBackend = 'claude' | 'codex' | 'opencode'

export interface CodeAgentConfig {
  backend?: CodeAgentBackend
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  model?: string
  workingDir: string
  maxTurns?: number
  timeoutMs?: number
}

export function codexApprovalMode(permissionMode: CodeAgentConfig['permissionMode']): string {
  switch (permissionMode) {
    case 'bypassPermissions':
      return 'full-auto'
    case 'acceptEdits':
      return 'auto-edit'
    default:
      return 'suggest'
  }
}

export function opencodePermission(permissionMode: CodeAgentConfig['permissionMode']): string {
  switch (permissionMode) {
    case 'bypassPermissions':
      return '{"*":"allow"}'
    case 'acceptEdits':
      return '{"edit":"allow","write":"allow","bash":"ask","*":"ask"}'
    default:
      return '{"*":"ask"}'
  }
}

export function resolveCodeAgentBackend(config: CodeAgentConfig): CodeAgentBackend {
  return config.backend ?? 'opencode'
}

export function buildCliInvocation(
  backend: Extract<CodeAgentBackend, 'codex' | 'opencode'>,
  task: string,
  config: CodeAgentConfig,
): { args: string[]; env: Record<string, string | undefined> } {
  if (backend === 'codex') {
    return {
      args: [
        'exec',
        '--skip-git-repo-check',
        '--approval-mode',
        codexApprovalMode(config.permissionMode),
        ...(config.model ? ['--model', config.model] : []),
        task,
      ],
      env: {},
    }
  }

  return {
    args: [task],
    env: {
      OPENCODE_PERMISSION: opencodePermission(config.permissionMode),
    },
  }
}

async function runCliCodeAgent(
  backend: Extract<CodeAgentBackend, 'codex' | 'opencode'>,
  task: string,
  config: CodeAgentConfig,
  workingDir: string,
  timeoutMs: number,
): Promise<ToolResult> {
  const command = backend
  const commandPath = Bun.which(command)

  if (!commandPath) {
    return {
      success: false,
      output: `Code agent backend "${backend}" is not installed. Install it and ensure \`${command}\` is on PATH.`,
    }
  }

  const { args, env: extraEnv } = buildCliInvocation(backend, task, config)

  const env = {
    ...process.env,
    ...extraEnv,
  }

  const proc = Bun.spawn({
    cmd: [commandPath, ...args],
    cwd: workingDir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const timer = setTimeout(() => {
    proc.kill()
  }, timeoutMs)

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)

  const output = stdout.trim() || stderr.trim()
  if (exitCode !== 0) {
    return {
      success: false,
      output: `Code agent (${backend}) failed with exit code ${exitCode}.\n${output || 'No output.'}`,
    }
  }

  if (!output) {
    return {
      success: false,
      output: `Code agent (${backend}) completed but returned no output.`,
    }
  }

  return {
    success: true,
    output,
  }
}

/**
 * Create the code_agent tool backed by Claude Code via the agent SDK.
 * The egirl agent can use this tool to delegate complex coding tasks
 * (refactoring, multi-file edits, debugging) to a code-specialized agent.
 */
export function createCodeAgentTool(config: CodeAgentConfig): Tool {
  return {
    definition: {
      name: 'code_agent',
      description: [
        'Delegate a coding task to the code agent (Claude Code, Codex, or OpenCode).',
        'Use this for complex tasks that require multi-file edits, refactoring,',
        'debugging, running tests, or any task that benefits from deep codebase',
        'exploration. The agent has full access to the filesystem and can run commands.',
        "Provide a clear, specific task description. Returns the agent's final result.",
        'When telling the user about this tool, refer to it as "the code agent", not "code_agent".',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A clear description of the coding task to perform',
          },
          working_dir: {
            type: 'string',
            description: 'Working directory for the task (defaults to configured workspace)',
          },
        },
        required: ['task'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const task = params.task as string
      const workingDir = (params.working_dir as string) ?? config.workingDir ?? cwd
      const backend = resolveCodeAgentBackend(config)

      log.info(
        'code-agent',
        `Starting task (${backend}): ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
      )
      log.debug('code-agent', `Working dir: ${workingDir}`)

      if (!existsSync(workingDir)) {
        return {
          success: false,
          output: `Code agent working directory does not exist: ${workingDir}`,
        }
      }

      const startTime = Date.now()
      const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

      if (backend !== 'claude') {
        const cliResult = await runCliCodeAgent(backend, task, config, workingDir, timeoutMs)
        if (!cliResult.success) return cliResult

        const durationSec = ((Date.now() - startTime) / 1000).toFixed(1)
        const metadata = `[code_agent: ${backend} | ${durationSec}s | cwd: ${join(workingDir)}]`
        return {
          success: true,
          output: `${cliResult.output}\n\n${metadata}`,
        }
      }

      let sessionId = ''
      let sdkTurns: number | undefined
      let manualTurns = 0
      let totalCost = 0
      let finalResult = ''

      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

      const isBypass = config.permissionMode === 'bypassPermissions'
      const options: ClaudeAgentOptions = {
        permissionMode: isBypass ? 'bypassPermissions' : 'default',
        ...(isBypass && { allowDangerouslySkipPermissions: true }),
        model: config.model,
        maxTurns: config.maxTurns,
        cwd: workingDir,
        abortController,
      }

      try {
        for await (const message of query({ prompt: task, options })) {
          if (abortController.signal.aborted) break
          if (!('type' in message)) continue

          switch (message.type) {
            case 'system': {
              if ('session_id' in message) {
                sessionId = message.session_id as string
                log.debug('code-agent', `Session: ${sessionId.slice(0, 8)}...`)
              }
              break
            }

            case 'result': {
              const resultMsg = message as {
                result?: string
                num_turns?: number
                total_cost_usd?: number
              }
              finalResult = resultMsg.result ?? ''
              sdkTurns = resultMsg.num_turns
              totalCost = resultMsg.total_cost_usd ?? totalCost
              break
            }
          }

          // Count assistant turns as fallback if SDK doesn't report them
          if ('message' in message && message.message) {
            const msg = message.message as { role?: string }
            if (msg.role === 'assistant') {
              manualTurns++
            }
          }
        }
      } catch (error) {
        clearTimeout(timeoutId)
        const isTimeout = error instanceof DOMException && error.name === 'AbortError'
        const msg = isTimeout
          ? `Code agent timed out after ${(timeoutMs / 1000).toFixed(0)}s`
          : error instanceof Error
            ? error.message
            : String(error)
        log.error('code-agent', `Task failed: ${msg}`)
        return {
          success: false,
          output: `Code agent error: ${msg}`,
        }
      }
      clearTimeout(timeoutId)

      const turns = sdkTurns ?? manualTurns
      const durationMs = Date.now() - startTime
      const durationSec = (durationMs / 1000).toFixed(1)

      log.info(
        'code-agent',
        `Completed in ${durationSec}s | ${turns} turns | $${totalCost.toFixed(4)}`,
      )

      if (!finalResult) {
        return {
          success: false,
          output: `Code agent completed but returned no result (${turns} turns, ${durationSec}s)`,
        }
      }

      const metadata = `[code_agent: claude | ${turns} turns | $${totalCost.toFixed(4)} | ${durationSec}s | session: ${sessionId.slice(0, 8)}]`

      return {
        success: true,
        output: `${finalResult}\n\n${metadata}`,
      }
    },
  }
}
